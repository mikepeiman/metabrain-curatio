## 1. Project Vision

**Metabrain Curatio** is a "Session Manager meets Outliner." It combines the persistence of **TabsOutliner** with the fluid, keyboard-centric UX of **Workflowy**.

- **Core Reference:** suyash/flowy (Minimalism, infinite nesting, zoomable nodes).
    
- **Primary Goal:** Users manipulate Data Nodes in a tree; the Chrome Browser automagically reflects these changes (opening/closing tabs).
    
- **Architecture:** Local-First (Chrome Storage), normalized database schema, Svelte 5 Runes, WXT.
    

## 2. Tech Stack & Constraints

- **Framework:** Svelte 5 (Strict Runes: $state, $derived, $props).
    
- **Build:** WXT (Web Extension Tools) + Vite + Bun.
    
- **Styling:** Tailwind CSS v4 (No @apply in Svelte files; use utility classes).
    
- **Libraries:**
    
    - svelte-dnd-action (REQUIRED for Drag & Drop).
        
    - No generic TreeView libraries. Logic must be custom to handle the specific relational schema.
        

## 3. Data Schema (The "Law")

We do NOT use a nested JSON tree. We use a **Relational "PocketBase-style" Schema**.

- **Store:** items: Record<UUID, MetaItem>
    
- **Mapping:** activeChromeMap: Record<ChromeID, UUID>
    
- **Item Types:**
    
    - SESSION: Root container. Contains windows: UUID[].
        
    - BROWSER_WINDOW: Virtual window. Contains tabs: UUID[].
        
    - BROWSER_TAB: The atom. Can contain children: UUID[] (Group logic).
        
- **States:**
    
    - **Active:** isOpen: true + chromeId: number (Exists in Chrome).
        
    - **Ghost:** isOpen: false + chromeId: undefined (Exists only in Database).
        

## 4. Implementation Roadmap & Task List

### Phase 1: The Shell (Detached Window)

The Popup is too transient. We need a permanent workspace.

**Refactor Launch:** Modify background.ts to listen for the extension icon click.

**Window Logic:** Instead of opening a popup, check if a "Curatio" window exists.

- If Yes: Focus it.
    
- If No: chrome.windows.create({ type: 'popup', url: 'popup.html', ... }).
    

**Resize:** Ensure it launches with vertical dimensions (e.g., 450x900).

### Phase 2: The Recursive UI (The Look)

Make it look like Flowy/Workflowy.

**Component:** Node.svelte must be recursive (<svelte:self>).

**Visuals (Tailwind):**

- Font: Sans-serif, size 14px+ (Legible).
    
- Padding: Compact (py-1).
    
- Hierarchy: Left border/guidelines for indentation depth.
    

**State Indicators:**

- Active Tab: High contrast text, Favicon.
    
- Ghost Tab: Dimmed text (opacity-60), Grayscale Favicon.
    

**Input Mode:** Double-clicking text turns it into an editable <input> to rename the node (Data Title vs Chrome Title).

### Phase 3: Keyboard Navigation (The Feel)

Keyboard is King. Mouse is Queen.

**Global Listener:** App.svelte listens for Arrow keys.

**Flat Tree Calculation:** Implement getVisibleFlatTree() in store.

- Recursively walk the session -> windows -> tabs -> children.
    
- Return ordered array of UUIDs.
    

**Navigation Actions:**

- ArrowUp/Down: Move focus visually through the flat tree. Jump from Window A bottom to Window B top.
    
- Ctrl+Right: **Indent.** (Become child of previous sibling).
    
- Ctrl+Left: **Outdent.** (Become sibling of parent).
    
    - Special Case: Outdenting a Tab from a Window -> Creates a NEW Window Item.
        
- Ctrl+Up/Down: **Reorder.** Swap node with sibling.
    

### Phase 4: Drag & Drop (The Mouse)

Use svelte-dnd-action.

**Install:** bun add svelte-dnd-action.

**Implementation:**

- Since svelte-dnd-action works on lists, each "Level" of children is a sortable list.
    
- Handle finalize event to update the parent's children array in the Store.
    
- **Cross-Level Dragging:** This is complex. Start with sorting within the same parent. If time permits, implement "Drag to Hover" to change parents.
    

### Phase 5: The Sync Engine (Data -> Chrome)

The most critical logic. Data drives the Browser.

**Wake Logic (Lazarus):**

- User wakes a Ghost Tab.
    
- Logic: Find Parent Window. Is Parent Window Active?
    
    - No: Wake Parent Window first -> Then Wake Tab.
        
    - Yes: Create Tab in that Window.
        

**Sync Logic (Chrome -> Data):**

- User closes Tab in Chrome -> Mark Item as Ghost (Do not delete).
    
- User moves Tab in Chrome -> Update Item order in Store.
    

---

## 5. Development Guidelines for AI

1. **Do not break the Schema:** Always check types.ts before writing logic.
    
2. **Strict Svelte 5:** No export let. No import { $state }.
    
3. **Atomic Commits:** When asked to implement "Phase 3," do not try to do Phase 4 simultaneously.
    
4. **Error Handling:** When moving nodes, always check if the new parent allows that child type (e.g., A Window cannot go inside a Tab).

# METABRAIN CURATIO: MASTER SPECIFICATIONS
## The "Workflowy for Tabs" Session Manager

---

## 1. EXECUTIVE SUMMARY
**Metabrain Curatio** is a high-performance Chrome Extension that manages browser sessions using a recursive outliner interface.
- **The Core Insight:** A browser tab is just a node in a tree. It can be active (open) or ghost (saved).
- **The Interaction:** Users manipulate the *Tree* (Data); the *Browser* (Chrome) slavishly follows.
- **The Stack:** Svelte 5 (Runes), WXT, Tailwind v4, Local-First (Chrome Storage).

---

## 2. DATA MODEL & SCHEMA

We use a **Normalized, Relational Schema** (PocketBase-style), not a nested JSON tree.

### 2.1 Core Entities (`src/types.ts`)

**MetaItem (The Atom)**
```typescript
interface MetaItem<T> {
  id: UUID;              // Persistent Database ID
  definitionId: string;  // Type of item
  createdAt: number;
  data: T;               // Payload
}
```


**Payload Types**

1. **SESSION (def_session)**: The Root container.
    
    - windows: UUID[] (Ordered list of children)
        
2. **BROWSER_WINDOW (def_browser_window)**: A virtual or real window.
    
    - name: string
        
    - tabs: UUID[]
        
    - chromeId?: number (Undefined = Ghost Window)
        
    - isOpen: boolean
        
    - isExpanded: boolean
        
3. **BROWSER_TAB (def_browser_tab)**: A URL node. Can act as a Group parent.
    
    - url: string
        
    - title: string
        
    - favIconUrl?: string
        
    - children: UUID[] (Nested tabs/groups)
        
    - chromeId?: number (Undefined = Ghost Tab)
        
    - isOpen: boolean
        
    - isExpanded: boolean
        

### 2.2 The "Split Brain" Map

We maintain a persistent map to bridge the gap between Database UUIDs and transient Chrome IDs.

- activeChromeMap: Record<number, UUID>
    
- Rule: When Chrome assigns a new ID (e.g., on restart), we update this map, keeping the UUID constant.
    

---

## 3. FEATURE INVENTORY & USER STORIES

### Feature Category 1: Node Management (The Basics)

**User Story 1.1: The "Ghost" State**

- **Scenario:** User closes a tab in Chrome.
    
- **System Action:** The node remains in the Tree but turns "Ghost" (dimmed).
    
- **Goal:** Persistence. "Closing" is just "Sleeping."
    

**User Story 1.2: The "Lazarus" Wake**

- **Scenario:** User clicks a Ghost Node.
    
- **System Action:**
    
    1. Checks if parent Window is open. If not, wakes Window first.
        
    2. Creates a new Chrome Tab at the exact index relative to its siblings.
        
    3. Updates the Node state to Active.
        

**User Story 1.3: Rename (Aliasing)**

- **Scenario:** User double-clicks the text of a node.
    
- **System Action:** Turns into an input field.
    
- **Logic:** Updates the data.title in storage. Does not change the actual Page Title in Chrome (allows custom labeling).
    

### Feature Category 2: Hierarchy & Structure (The Workflowy Physics)

**User Story 2.1: Indent (Ctrl+Right)**

- **Action:** User presses Ctrl+Right on a node.
    
- **Logic:** Node becomes the last child of its previous sibling.
    
- **Chrome Effect:** None visually, but logically the tab is now "grouped" under the sibling.
    

**User Story 2.2: Outdent (Ctrl+Left)**

- **Action:** User presses Ctrl+Left on a node.
    
- **Logic:** Node becomes a sibling of its parent.
    
- **Special Case:** If outdenting a Tab from a Window -> **Create New Window**.
    
    - The System creates a new Ghost Window item.
        
    - Moves the Tab into it.
        
    - If Tab was active, calls chrome.windows.create({ tabId }) to physically detach it.
        

**User Story 2.3: Reorder (Drag & Drop / Ctrl+Up/Down)**

- **Action:** User moves a node.
    
- **Logic:** Updates the parent's children array order.
    
- **Chrome Effect:** If the node is an active Tab, call chrome.tabs.move() to reflect the new order instantly.
    

### Feature Category 3: Navigation (Keyboard is King)

**User Story 3.1: Visual Focus**

- **Logic:** One node is always "Focused" (highlighted).
    
- **Keys:** ArrowUp / ArrowDown.
    
- **Traversal:** Must traverse the visible tree (skipping collapsed children), jumping across Window boundaries seamlessly.
    

**User Story 3.2: Collapse/Expand**

- **Action:** User presses Left (on expanded node) or Right (on collapsed node).
    
- **Logic:** Toggles isExpanded state.
    
- **Goal:** Manage complexity of thousands of tabs.
    

### Feature Category 4: Window Management

**User Story 4.1: The Detached Shell**

- **Behavior:** The extension does not use a Popup. It launches a dedicated Chrome Window (type: 'popup').
    
- **Goal:** It acts like a standalone desktop app that floats above other windows.
    

**User Story 4.2: Window Grouping**

- **Scenario:** User creates a "Window Node" inside another "Window Node" in the outline.
    
- **Logic:** This acts as a "Saved Session" folder. It creates a hierarchy of sessions.
    

---

## 4. IMPLEMENTATION ROADMAP

### Phase 1: The Engine (Refining useCapture.ts)

Implement getVisibleFlatTree() for keyboard navigation.

Implement moveNode() with strict type checking (can't put Window inside Tab).

Implement navigateFocus() to jump borders.

### Phase 2: The Interface (Refining Node.svelte)

Apply **Tailwind v4** styling (Dark mode, high contrast).

Add svelte-dnd-action for mouse reordering.

Add Collapse/Expand toggles (triangles).

### Phase 3: The Chrome Sync (Hardening)

Implement the chrome.tabs.move listener (Bi-directional sync).

- If user drags tab in Chrome, update Outline order.
    

Fix "Ghost Duplication" on restart (ensure activeChromeMap persists).

### Phase 4: Search & Filter

Add a top search bar.

Real-time filtering: Hide nodes that don't match, but show their parents (breadcrumb context).

---

## 5. TECHNICAL CONSTRAINTS

1. **Strict Svelte 5:** Use $state, $derived, $props. No legacy syntax.
    
2. **Strict WXT:** Import from #imports. Use wxt/storage.
    
3. **No Rich Text:** This is a Tab Manager, not a Note Taker.
    
4. **Local First:** All data lives in chrome.storage.local for the MVP.
5. 
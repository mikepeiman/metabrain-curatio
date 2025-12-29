# METABRAIN CURATIO: SPECIFICATIONS

## 1. Vision
Curatio is a "Workflowy for Tabs." It manages Browser Sessions using an infinite outline structure.
- **Core UX:** Keyboard-centric navigation, recursive nesting, drag-and-drop.
- **Data Model:** Local-first (Chrome Storage), normalized schema.

## 2. The "Item" Model
We do NOT use Rich Text. We use Resource Payloads.
- **Window Node:** Represents a Chrome Window. Contains Tab Nodes.
- **Tab Node:** Represents a URL.
- **Group Node:** (Future) A virtual folder to organize Tabs.

## 3. UX Guidelines (The Workflowy Standard)
- **Visuals:** High contrast, minimal padding, strict indentation.
- **Navigation:**
  - `ArrowUp/Down`: Visual focus traversal (jumping across windows).
  - `Ctrl+Right`: Indent (Tab becomes child of previous Tab -> Group).
  - `Ctrl+Left`: Outdent (Tab leaves Window -> Becomes new Window).
- **State:**
  - **Active:** Bright text. Exists in Chrome.
  - **Ghost:** Dimmed text. Exists only in Database.

## 4. Implementation Priorities
1. **The Engine:** `useCapture.svelte.ts` must handle `move`, `indent`, `outdent` logic while keeping `activeChromeMap` in sync.
2. **The Shell:** Launch as a **Detached Window** (not a popup).
3. **The UI:** Recursive `<Node>` component with Drag & Drop (`svelte-dnd-action`).

## 5. Constraints
- **NO Markdown:** This is not a text editor.
- **NO PocketBase SDK (Yet):** Use `chrome.storage.local` exclusively for Alpha.
- **Strict Svelte 5:** Runes syntax only.
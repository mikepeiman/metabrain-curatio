# METABRAIN DATA ARCHITECTURE (The "Law")

## 1. Core Philosophy
Metabrain is a unified ecosystem where all distinct entities (Tabs, Tasks, Notes) are treated as generic **Items** defined by a schema.
- **No Silos:** A Browser Tab is an Item. A Window is an Item. A Session is an Item.
- **Relational:** We do not store a massive nested JSON tree. We store individual Items that reference other Items via UUIDs in their payloads.

## 2. The Two-Table Structure (Virtual)
Even though we are currently using `chrome.storage.local`, all TypeScript interfaces MUST mirror this future SQL structure.

### Table A: ItemDefinitions (The Types)
We assume these constants exist for the extension:
- `DEF_BROWSER_TAB`: Schema `{ url: text, title: text, favIconUrl: text, isPinned: boolean }`
- `DEF_BROWSER_WINDOW`: Schema `{ name: text, tabs: UUID[] }`
- `DEF_SESSION`: Schema `{ name: text, windows: UUID[] }`

### Table B: Items (The Data)
Every entity in the system must conform to this generic interface:

```typescript
type UUID = string; // e.g., "550e8400-e29b-41d4-a716-446655440000"

interface MetaItem<T> {
  id: UUID;              // Persistent ID (NOT the Chrome Tab ID)
  definitionId: string;  // e.g., "def_browser_tab"
  createdAt: number;
  data: T;               // The payload matching the definition
}
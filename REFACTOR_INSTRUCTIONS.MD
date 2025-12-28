
---

### 2. Create `REFACTOR_INSTRUCTIONS.md`
*Action: Create this file in your project root. It tells Composer exactly how to fix the work it just did.*

```markdown
# REFACTOR INSTRUCTIONS: Porting to Metabrain Schema

The current implementation of `src/utils/storage.ts` and `src/composables/useCapture.ts` uses a legacy "Tree Node" structure. This must be refactored to align with `METABRAIN_SCHEMA.md`.

## 1. Update Types (`src/types.ts`)
- Delete the existing `Node`, `WindowNode`, `TabNode` interfaces.
- Create the generic `MetaItem<T>` interface.
- Define specific Payloads: `BrowserTabPayload`, `BrowserWindowPayload`, `SavedSessionPayload`.

## 2. Refactor `useCapture.ts` (The Store)
- **State Change:** Instead of a single nested object `$state(rootNode)`, the state should be a normalized collection:
  ```typescript
  let items = $state<Record<UUID, MetaItem<any>>>({});
  let activeChromeMap = $state<Record<number, UUID>>({}); // Maps ChromeTabID -> ItemUUID
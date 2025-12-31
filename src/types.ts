export type UUID = string;

export type OutlineRow = {
  id: UUID;
  depth: number;
};

export interface BrowserTabPayload {
  url?: string;
  title?: string;
  favIconUrl?: string;
  isPinned?: boolean;
  chromeId?: number; // Chrome tab ID (undefined when ghost)
  isOpen?: boolean; // true when active in Chrome, false when ghost
  status?: 'active' | 'closed' | 'archived'; // Item state: active (visible), closed (ghost), archived (hidden)
}

export interface BrowserWindowPayload {
  name?: string;
  /**
   * Canonical outliner model: flat order + depth.
   * Order (rows[].id) mirrors Chrome tab order (LTR) for active tabs.
   * Depth encodes nesting; contiguity defines parent/child.
   */
  rows: OutlineRow[];
  // Legacy field retained for migration/back-compat (do not use as source of truth)
  tabs?: UUID[];
  chromeId?: number; // Chrome window ID (undefined when ghost)
  isOpen?: boolean; // true when active in Chrome, false when ghost
  status?: 'active' | 'closed' | 'archived'; // Item state: active (visible), closed (ghost), archived (hidden)
}

export interface SavedSessionPayload {
  name: string;
  windows: UUID[];
}

export type AnyPayload = BrowserTabPayload | BrowserWindowPayload | SavedSessionPayload;

export interface MetaItem<T extends AnyPayload = AnyPayload> {
  id: UUID;
  definitionId: string;
  createdAt: number;
  data: T;
}

export const DEFINITIONS = {
  BROWSER_TAB: 'def_browser_tab',
  BROWSER_WINDOW: 'def_browser_window',
  SESSION: 'def_session',
} as const;

export type UUID = string;

export interface BrowserTabPayload {
  url?: string;
  title?: string;
  favIconUrl?: string;
  isPinned?: boolean;
  chromeId?: number; // Chrome tab ID (undefined when ghost)
  isOpen?: boolean; // true when active in Chrome, false when ghost
  children?: UUID[]; // Child tabs (for grouping/nesting)
  status?: 'active' | 'closed' | 'archived'; // Item state: active (visible), closed (ghost), archived (hidden)
}

export interface BrowserWindowPayload {
  name?: string;
  tabs: UUID[];
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

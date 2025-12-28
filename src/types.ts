export type UUID = string;

export interface BrowserTabPayload {
  url?: string;
  title?: string;
  favIconUrl?: string;
  isPinned?: boolean;
}

export interface BrowserWindowPayload {
  name?: string;
  tabs: UUID[];
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

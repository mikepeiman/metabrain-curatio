import { metabrainStorage, type MetabrainData } from '../utils/storage';
import {
    DEFINITIONS,
    type MetaItem,
    type UUID,
    type BrowserTabPayload,
    type BrowserWindowPayload,
    type SavedSessionPayload,
    type AnyPayload
} from '../types';

class CaptureStore {
    items = $state<Record<UUID, MetaItem<AnyPayload>>>({});
    activeChromeMap = $state<Record<number, UUID>>({});
    rootSessionId = $state<UUID>('');
    private isBackground = false;
    private storageListener: ((changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void) | null = null;

    async init(isBackground: boolean = false) {
        this.isBackground = isBackground;

        // Auto-hydrate: Read from storage immediately
        await this.hydrateFromStorage();

        // Setup storage change listener for live sync (always, for both background and popup)
        this.setupStorageListener();

        // Only background script syncs with Chrome and sets up window/tab listeners
        if (isBackground) {
            await this.syncWithChrome();
            this.setupListeners();
        }
    }

    private async hydrateFromStorage() {
        const saved = await metabrainStorage.load();
        if (saved) {
            this.items = saved.items;
            this.rootSessionId = saved.rootSessionId;
        } else {
            // Only create default session if background script (popup shouldn't create data)
            if (this.isBackground) {
                const sessionId = crypto.randomUUID();
                this.items[sessionId] = {
                    id: sessionId,
                    definitionId: DEFINITIONS.SESSION,
                    createdAt: Date.now(),
                    data: { name: 'Default Session', windows: [] } as SavedSessionPayload
                };
                this.rootSessionId = sessionId;
                await this.save();
            }
        }
    }

    private setupStorageListener() {
        // Remove existing listener if any
        if (this.storageListener) {
            chrome.storage.onChanged.removeListener(this.storageListener);
        }

        // Create new listener for live sync
        this.storageListener = (changes, areaName) => {
            if (areaName === 'local' && changes['local:metabrain_data']) {
                const newValue = changes['local:metabrain_data'].newValue as MetabrainData | undefined;
                if (newValue) {
                    // Update local state to match storage (popup reads updates from background)
                    this.items = newValue.items;
                    this.rootSessionId = newValue.rootSessionId;
                }
            }
        };

        chrome.storage.onChanged.addListener(this.storageListener);
    }

    private async syncWithChrome() {
        const windows = await chrome.windows.getAll({ populate: true });
        const currentWindowIds = new Set(windows.map(win => win.id).filter((id): id is number => id !== undefined));

        // Remove stale entries from activeChromeMap (windows that no longer exist)
        Object.keys(this.activeChromeMap).forEach(chromeId => {
            const id = Number(chromeId);
            if (!currentWindowIds.has(id)) {
                delete this.activeChromeMap[id];
            }
        });

        // Process all current Chrome windows - upsertWindow will handle deduplication
        // and won't create duplicate MetaItems if window already exists
        windows.forEach(win => this.upsertWindow(win));

        await this.save();
    }

    private setupListeners() {
        chrome.windows.onCreated.addListener((win: chrome.windows.Window) => {
            this.upsertWindow(win);
            this.save();
        });

        chrome.windows.onRemoved.addListener((windowId: number) => {
            delete this.activeChromeMap[windowId];
            this.save();
        });

        chrome.tabs.onCreated.addListener((tab: chrome.tabs.Tab) => {
            this.upsertTab(tab);
            this.save();
        });

        chrome.tabs.onUpdated.addListener((_tabId: number, _changeInfo: any, tab: chrome.tabs.Tab) => {
            this.upsertTab(tab);
            this.save();
        });

        chrome.tabs.onRemoved.addListener((tabId: number) => {
            delete this.activeChromeMap[tabId];
            this.save();
        });

        chrome.tabs.onMoved.addListener((tabId: number) => {
            chrome.tabs.get(tabId, (tab: chrome.tabs.Tab) => {
                if (tab) {
                    this.upsertTab(tab);
                    this.save();
                }
            });
        });
    }

    private upsertWindow(win: chrome.windows.Window) {
        if (win.id === undefined) return;

        // Check if window already has a mapped UUID in activeChromeMap
        let windowId = this.activeChromeMap[win.id];

        // If mapped UUID exists, verify the MetaItem exists (robustness check)
        if (windowId && this.items[windowId]) {
            // Window already exists, just update tabs
            this.activeChromeMap[win.id] = windowId;
            win.tabs?.forEach((tab: chrome.tabs.Tab) => this.upsertTab(tab, windowId));
            return;
        }

        // Create new window MetaItem
        windowId = crypto.randomUUID();
        this.items[windowId] = {
            id: windowId,
            definitionId: DEFINITIONS.BROWSER_WINDOW,
            createdAt: Date.now(),
            data: { name: `Window ${win.id}`, tabs: [] } as BrowserWindowPayload
        };

        // Add to session's windows array only if not already present
        const session = this.items[this.rootSessionId]?.data as SavedSessionPayload;
        if (session && !session.windows.includes(windowId)) {
            session.windows.push(windowId);
        }

        this.activeChromeMap[win.id] = windowId;
        win.tabs?.forEach((tab: chrome.tabs.Tab) => this.upsertTab(tab, windowId));
    }

    private upsertTab(tab: chrome.tabs.Tab, parentWindowId?: UUID) {
        if (tab.id === undefined) return;

        const winId = parentWindowId || this.activeChromeMap[tab.windowId];
        if (!winId) return;

        let tabId = this.activeChromeMap[tab.id];
        let tabItem = tabId ? (this.items[tabId] as MetaItem<BrowserTabPayload>) : undefined;

        if (!tabItem) {
            tabId = crypto.randomUUID();
            tabItem = {
                id: tabId,
                definitionId: DEFINITIONS.BROWSER_TAB,
                createdAt: Date.now(),
                data: {
                    url: tab.url,
                    title: tab.title,
                    favIconUrl: tab.favIconUrl,
                    isPinned: tab.pinned
                }
            };
            this.items[tabId] = tabItem;
            const windowPayload = this.items[winId].data as BrowserWindowPayload;
            if (!windowPayload.tabs.includes(tabId)) windowPayload.tabs.push(tabId);
        } else {
            Object.assign(tabItem.data, {
                url: tab.url,
                title: tab.title,
                favIconUrl: tab.favIconUrl,
                isPinned: tab.pinned
            });
            this.ensureTabInWindow(tabId, winId);
        }

        this.activeChromeMap[tab.id] = tabId;
    }

    private ensureTabInWindow(tabId: UUID, windowId: UUID) {
        Object.values(this.items)
            .filter(item => item.definitionId === DEFINITIONS.BROWSER_WINDOW && item.id !== windowId)
            .forEach(item => {
                const payload = item.data as BrowserWindowPayload;
                payload.tabs = payload.tabs.filter(id => id !== tabId);
            });

        const windowPayload = this.items[windowId].data as BrowserWindowPayload;
        if (!windowPayload.tabs.includes(tabId)) windowPayload.tabs.push(tabId);
    }

    private async save() {
        // Guard: Only background script writes to storage
        if (!this.isBackground) {
            console.warn('[CaptureStore] Popup attempted to write to storage. Only background script can write.');
            return;
        }

        await metabrainStorage.save({
            items: $state.snapshot(this.items),
            rootSessionId: this.rootSessionId
        });
    }

    async clearStorage() {
        // Remove storage listener before clearing
        if (this.storageListener) {
            chrome.storage.onChanged.removeListener(this.storageListener);
            this.storageListener = null;
        }

        // Clear chrome.storage.local
        await metabrainStorage.clear();

        // Reset state to empty
        this.items = {};
        this.activeChromeMap = {};
        this.rootSessionId = '';

        // If background script, create fresh session
        if (this.isBackground) {
            const sessionId = crypto.randomUUID();
            this.items[sessionId] = {
                id: sessionId,
                definitionId: DEFINITIONS.SESSION,
                createdAt: Date.now(),
                data: { name: 'Default Session', windows: [] } as SavedSessionPayload
            };
            this.rootSessionId = sessionId;
            await this.save();
            // Re-setup storage listener
            this.setupStorageListener();
        }
    }
}

export const captureStore = new CaptureStore();

import { metabrainStorage } from '../utils/storage';
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

    async init() {
        const saved = await metabrainStorage.load();
        if (saved) {
            this.items = saved.items;
            this.rootSessionId = saved.rootSessionId;
        } else {
            const sessionId = crypto.randomUUID();
            this.items[sessionId] = {
                id: sessionId,
                definitionId: DEFINITIONS.SESSION,
                createdAt: Date.now(),
                data: { name: 'Default Session', windows: [] } as SavedSessionPayload
            };
            this.rootSessionId = sessionId;
        }
        await this.syncWithChrome();
        this.setupListeners();
    }

    private async syncWithChrome() {
        const windows = await chrome.windows.getAll({ populate: true });
        this.activeChromeMap = {};
        windows.forEach(win => this.upsertWindow(win));
        await this.save();
    }

    private setupListeners() {
        chrome.windows.onCreated.addListener(win => {
            this.upsertWindow(win);
            this.save();
        });

        chrome.windows.onRemoved.addListener(windowId => {
            delete this.activeChromeMap[windowId];
            this.save();
        });

        chrome.tabs.onCreated.addListener(tab => {
            this.upsertTab(tab);
            this.save();
        });

        chrome.tabs.onUpdated.addListener((_, __, tab) => {
            this.upsertTab(tab);
            this.save();
        });

        chrome.tabs.onRemoved.addListener(tabId => {
            delete this.activeChromeMap[tabId];
            this.save();
        });

        chrome.tabs.onMoved.addListener(tabId => {
            chrome.tabs.get(tabId, tab => {
                if (tab) {
                    this.upsertTab(tab);
                    this.save();
                }
            });
        });
    }

    private upsertWindow(win: chrome.windows.Window) {
        if (win.id === undefined) return;

        let windowId = this.activeChromeMap[win.id];
        if (!windowId) {
            windowId = crypto.randomUUID();
            this.items[windowId] = {
                id: windowId,
                definitionId: DEFINITIONS.BROWSER_WINDOW,
                createdAt: Date.now(),
                data: { name: `Window ${win.id}`, tabs: [] } as BrowserWindowPayload
            };
            const session = this.items[this.rootSessionId].data as SavedSessionPayload;
            session.windows.push(windowId);
        }

        this.activeChromeMap[win.id] = windowId;
        win.tabs?.forEach(tab => this.upsertTab(tab, windowId));
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
        await metabrainStorage.save({
            items: $state.snapshot(this.items),
            rootSessionId: this.rootSessionId
        });
    }
}

export const captureStore = new CaptureStore();

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
    // IMPORTANT: Ephemeral "Active Projection" maps (do NOT persist).
    // Window IDs and Tab IDs can collide numerically, so keep them separate.
    activeChromeWindowMap = $state<Record<number, UUID>>({});
    activeChromeTabMap = $state<Record<number, UUID>>({});
    rootSessionId = $state<UUID>('');
    focusedNodeId = $state<UUID | null>(null);
    selectedNodeIds = $state<Set<UUID>>(new Set());
    showArchived = $state<boolean>(false);

    private isBackground = false;
    private storageListener: ((changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void) | null = null;
    private reconcilePromise: Promise<void> | null = null;

    async init(isBackground: boolean = false) {
        this.isBackground = isBackground;
        await this.hydrateFromStorage();
        this.setupStorageListener();

        if (isBackground) {
            await this.syncWithChrome();
        }
    }

    private async hydrateFromStorage() {
        const saved = await metabrainStorage.load();
        if (saved) {
            this.items = saved.items;
            this.rootSessionId = saved.rootSessionId;
            // Active projection is rebuilt from Chrome (background) and should never be hydrated from storage
            this.activeChromeWindowMap = {};
            this.activeChromeTabMap = {};
        } else if (this.isBackground) {
            const sessionId = crypto.randomUUID();
            this.items[sessionId] = {
                id: sessionId,
                definitionId: DEFINITIONS.SESSION,
                createdAt: Date.now(),
                data: { name: 'Default Session', windows: [] } as SavedSessionPayload
            };
            this.rootSessionId = sessionId;
            this.activeChromeWindowMap = {};
            this.activeChromeTabMap = {};
            await this.save();
        }
    }

    private setupStorageListener() {
        if (this.storageListener) chrome.storage.onChanged.removeListener(this.storageListener);
        this.storageListener = (changes, areaName) => {
            if (areaName === 'local' && changes['local:metabrain_data']) {
                const newValue = changes['local:metabrain_data'].newValue as MetabrainData | undefined;
                if (newValue) {
                    this.items = newValue.items;
                    this.rootSessionId = newValue.rootSessionId;
                    // Trigger reactivity
                    this.items = { ...this.items };
                }
            }
        };
        chrome.storage.onChanged.addListener(this.storageListener);
    }

    private async syncWithChrome() {
        const windows = await chrome.windows.getAll({ populate: true });
        const currentWindowIds = new Set(windows.map(w => w.id).filter((id): id is number => id !== undefined));

        // Rebuild ephemeral active projection each sync pass (background only)
        this.activeChromeWindowMap = {};
        this.activeChromeTabMap = {};

        // Ghost check
        Object.values(this.items).forEach(item => {
            if (item.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                const payload = item.data as BrowserWindowPayload;
                if (payload.chromeId !== undefined && payload.isOpen && !currentWindowIds.has(payload.chromeId)) {
                    this.markWindowAsGhost(payload.chromeId);
                }
            }
        });

        // Sync windows and tabs in order
        for (const win of windows) {
            await this.upsertWindow(win);
        }
        
        // Sync tab order from Chrome to match reality
        await this.syncTabOrderFromChrome();
        await this.save();
    }

    /**
     * Service-worker friendly: called by background.ts listeners.
     * Runs a full reconcile pass against Chrome and coalesces concurrent calls.
     */
    async reconcileFromChrome() {
        if (!this.isBackground) {
            // If somehow called from UI context, no-op.
            return;
        }
        if (!this.reconcilePromise) {
            this.reconcilePromise = (async () => {
                try {
                    await this.syncWithChrome();
                    // Ensure UI sees updates when store is read in app context
                    this.items = { ...this.items };
                } finally {
                    this.reconcilePromise = null;
                }
            })();
        }
        await this.reconcilePromise;
    }

    /**
     * Sync tab order from Chrome to Curatio data structure.
     * Ensures the order in our arrays matches the actual Chrome tab order.
     */
    private async syncTabOrderFromChrome() {
        const windows = await chrome.windows.getAll({ populate: true });
        
        for (const win of windows) {
            if (win.id === undefined || !win.tabs) continue;
            
            const windowId = this.activeChromeWindowMap[win.id];
            if (!windowId) continue;
            
            const windowItem = this.items[windowId];
            if (!windowItem || windowItem.definitionId !== DEFINITIONS.BROWSER_WINDOW) continue;
            
            const windowPayload = windowItem.data as BrowserWindowPayload;
            
            // Build ordered list of tab UUIDs based on Chrome tab order
            const orderedTabIds: UUID[] = [];
            const seenTabIds = new Set<UUID>();
            
            for (const chromeTab of win.tabs) {
                if (!chromeTab.id || this.isAppTab(chromeTab.url)) continue;
                
                const tabId = this.activeChromeTabMap[chromeTab.id];
                if (tabId && !seenTabIds.has(tabId)) {
                    orderedTabIds.push(tabId);
                    seenTabIds.add(tabId);
                }
            }
            
            // Update window tabs array to match Chrome order
            // Preserve any tabs that aren't in Chrome (ghost tabs) at the end
            const existingTabs = windowPayload.tabs || [];
            const ghostTabs = existingTabs.filter(id => !seenTabIds.has(id));
            windowPayload.tabs = [...orderedTabIds, ...ghostTabs];
        }
    }

    // NOTE: MV3 Service Worker listeners are registered synchronously in `src/entrypoints/background.ts`.

    // --- ACTIONS ---

    async toggleOpen(id: UUID) {
        const item = this.items[id];
        if (!item) return;

        // 1. Handle Tab Toggle
        if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
            const payload = item.data as BrowserTabPayload;

            if (payload.isOpen && payload.chromeId !== undefined) {
                // SLEEP: Close tab, keep node
                const chromeTabId = payload.chromeId;
                try {
                    await chrome.tabs.remove(chromeTabId);
                } catch (e) { /* ignore if already gone */ }
                // Mark as ghost immediately
                payload.isOpen = false;
                payload.chromeId = undefined;
                payload.status = 'closed';
                delete this.activeChromeTabMap[chromeTabId];
                this.items = { ...this.items };
            } else if (payload.url) {
                // Find nearest ancestor window (supports nested/indented tabs)
                const ancestorWindow = this.findAncestorWindow(id);
                if (!ancestorWindow) return;

                const parentItem = this.items[ancestorWindow.windowId];
                if (!parentItem || parentItem.definitionId !== DEFINITIONS.BROWSER_WINDOW) return;

                // Ensure tab is listed under the window
                await this.ensureTabInWindow(id, ancestorWindow.windowId);

                let windowChromeId = (parentItem.data as BrowserWindowPayload).chromeId;

                // If Parent Window is inactive, Wake it first
                if (windowChromeId === undefined || !(parentItem.data as BrowserWindowPayload).isOpen) {
                    await this.toggleOpen(ancestorWindow.windowId);
                    windowChromeId = (this.items[ancestorWindow.windowId].data as BrowserWindowPayload).chromeId;
                }

                if (windowChromeId !== undefined) {
                    // Calculate Index within window tabs (fallback to end)
                    const siblings = (parentItem.data as BrowserWindowPayload).tabs;
                    const index = siblings.indexOf(id);
                    const createIndex = index >= 0 ? index : siblings.length;

                    const created = await chrome.tabs.create({
                        windowId: windowChromeId,
                        url: payload.url,
                        index: createIndex,
                        active: true
                    });
                    if (created?.id !== undefined) {
                        payload.chromeId = created.id;
                        payload.isOpen = true;
                        payload.status = 'active';
                        this.activeChromeTabMap[created.id] = id;
                        // Ensure actual Chrome position matches desired position
                        await chrome.tabs.move(created.id, { windowId: windowChromeId, index: createIndex }).catch(() => { });
                        this.items = { ...this.items };
                    }
                    // Update state immediately for instant UI feedback
                    // Trigger reactivity immediately
                    this.items = { ...this.items };
                }
            }
        }
        // 2. Handle Window Toggle
        else if (item.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            const payload = item.data as BrowserWindowPayload;
            if (payload.isOpen && payload.chromeId !== undefined) {
                try { await chrome.windows.remove(payload.chromeId); } catch (e) { }
            } else {
                // Wake Window
                const urls = payload.tabs
                    .map(tId => (this.items[tId]?.data as BrowserTabPayload)?.url)
                    .filter((u): u is string => !!u);

                if (urls.length > 0) {
                    await chrome.windows.create({ url: urls });
                } else {
                    await chrome.windows.create({});
                }
                // Update state immediately for instant UI feedback
                payload.isOpen = true;
                payload.status = 'active';
                // Trigger reactivity immediately
                this.items = { ...this.items };
            }
        }
        // Trigger reactivity after toggle operations
        this.items = { ...this.items };
    }

    // NOTE: We intentionally do NOT dedupe or lookup tabs by URL.
    // Multiple tabs can share a URL; UUID is the identity, Chrome tabId is the live mapping.

    async outdentNode(id: UUID) {
        const item = this.items[id];
        const parentId = this.findParent(id);
        if (!item || !parentId) return;

        // Special Case: Detach Tab into New Window
        if (item.definitionId === DEFINITIONS.BROWSER_TAB && this.items[parentId]?.definitionId === DEFINITIONS.BROWSER_WINDOW) {

            this.removeFromParent(id, parentId);

            const newWindowId = crypto.randomUUID();
            this.items[newWindowId] = {
                id: newWindowId,
                definitionId: DEFINITIONS.BROWSER_WINDOW,
                createdAt: Date.now(),
                data: {
                    name: 'New Window',
                    tabs: [id],
                    isOpen: true,
                    chromeId: undefined
                } as BrowserWindowPayload
            };

            const session = this.items[this.rootSessionId]?.data as SavedSessionPayload;
            if (!session.windows.includes(newWindowId)) {
                const parentIndex = session.windows.indexOf(parentId);
                if (parentIndex >= 0) session.windows.splice(parentIndex + 1, 0, newWindowId);
                else session.windows.push(newWindowId);
            }

            // Physical Update: Move the Tab in Chrome
            const tabPayload = item.data as BrowserTabPayload;
            if (tabPayload.isOpen && tabPayload.chromeId !== undefined) {
                const newWin = await chrome.windows.create({ tabId: tabPayload.chromeId });
                if (newWin && newWin.id) {
                    (this.items[newWindowId].data as BrowserWindowPayload).chromeId = newWin.id;
                    this.activeChromeWindowMap[newWin.id] = newWindowId;
                }
            } else {
                (this.items[newWindowId].data as BrowserWindowPayload).isOpen = false;
            }

            this.checkAndDeleteEmptyContainers(parentId);
            this.save();
            this.setFocus(id);
            return;
        }

        const grandparentId = this.findParent(parentId);
        if (!grandparentId) return;

        // Get old parent window chromeId for tab moves
        const oldParentWindowId = this.items[parentId]?.definitionId === DEFINITIONS.BROWSER_WINDOW
            ? (this.items[parentId].data as BrowserWindowPayload).chromeId
            : undefined;

        this.removeFromParent(id, parentId);
        const gp = this.items[grandparentId];

        if (gp.definitionId === DEFINITIONS.SESSION) {
            const pl = gp.data as SavedSessionPayload;
            const idx = pl.windows.indexOf(parentId);
            if (idx === -1) return;
            if (!pl.windows.includes(id)) {
                pl.windows.splice(idx + 1, 0, id);
            }
        } else if (gp.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            const pl = gp.data as BrowserWindowPayload;
            const idx = pl.tabs.indexOf(parentId);
            if (idx === -1) return;
            if (!pl.tabs.includes(id)) {
                pl.tabs.splice(idx + 1, 0, id);
            }

            // Move Chrome tab(s) to new position in window (recursively)
            const newWindowChromeId = pl.chromeId;
            if (newWindowChromeId !== undefined) {
                await this.moveChromeTree(id, newWindowChromeId, idx + 1);
            }
        } else if (gp.definitionId === DEFINITIONS.BROWSER_TAB) {
            // Tab outdenting from Tab: become sibling of parent Tab in grandparent Tab's children
            const pl = gp.data as BrowserTabPayload;
            if (!pl.children) {
                pl.children = [];
            }
            if (!pl.children.includes(id)) {
                const idx = pl.children.indexOf(parentId);
                if (idx >= 0) {
                    pl.children.splice(idx + 1, 0, id);
                } else {
                    pl.children.push(id);
                }
            }

            // Move Chrome tab to parent tab's window
            if (item.definitionId === DEFINITIONS.BROWSER_TAB && pl.chromeId !== undefined) {
                const tabPayload = item.data as BrowserTabPayload;
                chrome.tabs.get(pl.chromeId).then(async parentTab => {
                    if (tabPayload.chromeId !== undefined && parentTab?.windowId !== undefined) {
                        await this.moveChromeTree(id, parentTab.windowId, -1);
                    }
                }).catch(console.error);
            }
        }
        this.checkAndDeleteEmptyContainers(parentId);
        this.save();
        this.setFocus(id);
    }

    async indentNode(id: UUID) {
        const item = this.items[id];
        const parentId = this.findParent(id);
        if (!item || !parentId) return;

        const siblings = this.getChildren(parentId);
        const index = siblings.indexOf(id);
        if (index <= 0) return;

        const prevSiblingId = siblings[index - 1];
        const prevSibling = this.items[prevSiblingId];
        if (!prevSibling) return;

        // Constraint: A Tab cannot have a Window as a child
        if (item.definitionId === DEFINITIONS.BROWSER_WINDOW && prevSibling.definitionId === DEFINITIONS.BROWSER_TAB) {
            return;
        }

        const oldParent = this.items[parentId];
        const oldParentWindowId = oldParent?.definitionId === DEFINITIONS.BROWSER_WINDOW
            ? (oldParent.data as BrowserWindowPayload).chromeId
            : undefined;

        // Calculate target position BEFORE removing from parent
        let targetIndex = -1;
        if (prevSibling.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            const newWindowPayload = prevSibling.data as BrowserWindowPayload;
            // Insert after the last tab in the previous sibling window
            targetIndex = newWindowPayload.tabs.length;
        } else if (prevSibling.definitionId === DEFINITIONS.BROWSER_TAB) {
            const tabPayload = prevSibling.data as BrowserTabPayload;
            if (!tabPayload.children) {
                tabPayload.children = [];
            }
            // Insert after the last child of the previous sibling tab
            targetIndex = tabPayload.children.length;
        }

        this.removeFromParent(id, parentId);

        if (prevSibling.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            const newWindowPayload = prevSibling.data as BrowserWindowPayload;
            if (!newWindowPayload.tabs.includes(id)) {
                newWindowPayload.tabs.splice(targetIndex, 0, id);
            }
            // Move Chrome tab(s) to new window if both are active (recursively)
            const newWindowChromeId = newWindowPayload.chromeId;
            if (newWindowChromeId !== undefined) {
                // Calculate Chrome tab index: find position after last tab in target window
                const targetChromeIndex = await this.calculateChromeTabIndex(newWindowChromeId, targetIndex);
                await this.moveChromeTree(id, newWindowChromeId, targetChromeIndex);
            }
        } else if (prevSibling.definitionId === DEFINITIONS.SESSION) {
            const sessionWindows = (prevSibling.data as SavedSessionPayload).windows;
            if (!sessionWindows.includes(id)) {
                sessionWindows.push(id);
            }
        } else if (prevSibling.definitionId === DEFINITIONS.BROWSER_TAB) {
            // Tab-into-Tab nesting: initialize children array if missing
            const tabPayload = prevSibling.data as BrowserTabPayload;
            if (!tabPayload.children) {
                tabPayload.children = [];
            }
            if (!tabPayload.children.includes(id)) {
                tabPayload.children.splice(targetIndex, 0, id);
            }
            // Move Chrome tab to the parent tab's window if both are active
            if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
                const childTabPayload = item.data as BrowserTabPayload;
                if (tabPayload.chromeId !== undefined && childTabPayload.chromeId !== undefined) {
                    const parentTab = await chrome.tabs.get(tabPayload.chromeId);
                    if (parentTab?.windowId !== undefined) {
                        // Calculate Chrome tab index after parent tab
                        const targetChromeIndex = await this.calculateChromeTabIndex(parentTab.windowId, parentTab.index + 1);
                        await this.moveChromeTree(id, parentTab.windowId, targetChromeIndex);
                    }
                }
            }
        }

        this.checkAndDeleteEmptyContainers(parentId);
        await this.save();
        // Maintain focus after operation
        this.setFocus(id);
    }

    // --- CHROME TREE MOVEMENT ---

    /**
     * Recursively moves a node and all its active descendant tabs in Chrome.
     * Preserves preorder so children follow their parent physically.
     * Moves all tabs together as a contiguous block.
     */
    private async moveChromeTree(nodeId: UUID, targetWindowId: number, targetIndex: number): Promise<number> {
        const tabsToMove = this.flattenActiveTabs(nodeId);
        if (tabsToMove.length === 0) return 0;

        // Move all tabs together as a block
        // When moving multiple tabs, we need to move in reverse order (last first) 
        // because each move shifts subsequent tabs to the right
        if (targetIndex < 0) {
            // Move to end - move in forward order (parent first) since we're appending
            for (let i = 0; i < tabsToMove.length; i++) {
                const chromeId = tabsToMove[i];
                try {
                    await chrome.tabs.move(chromeId, { windowId: targetWindowId, index: -1 });
                } catch (e) {
                    console.error(`Failed to move tab ${chromeId}:`, e);
                }
            }
        } else {
            // Move to specific index - move in reverse order (last tab first)
            // This ensures parent ends up at targetIndex and children follow sequentially
            const count = tabsToMove.length;
            for (let i = count - 1; i >= 0; i--) {
                const chromeId = tabsToMove[i];
                try {
                    // Last tab goes to targetIndex + (count - 1), first tab goes to targetIndex
                    await chrome.tabs.move(chromeId, { windowId: targetWindowId, index: targetIndex + i });
                } catch (e) {
                    console.error(`Failed to move tab ${chromeId}:`, e);
                }
            }
        }
        return tabsToMove.length;
    }

    /**
     * Calculate the Chrome tab index for a given logical position in a window.
     * Returns the Chrome tab index where the tab should be inserted.
     */
    private async calculateChromeTabIndex(windowChromeId: number, logicalIndex: number): Promise<number> {
        const chromeWindow = await chrome.windows.get(windowChromeId, { populate: true });
        if (!chromeWindow.tabs) return -1;

        // Count active tabs up to logicalIndex
        let activeCount = 0;
        for (let i = 0; i < chromeWindow.tabs.length && activeCount < logicalIndex; i++) {
            const tab = chromeWindow.tabs[i];
            if (tab.id && this.activeChromeTabMap[tab.id] && !this.isAppTab(tab.url)) {
                activeCount++;
            }
        }

        // Return the Chrome tab index (or -1 for end)
        if (activeCount >= chromeWindow.tabs.length) return -1;
        return activeCount;
    }

    /**
     * Flatten a subtree into an ordered list of active Chrome tab IDs (parent before children).
     */
    private flattenActiveTabs(nodeId: UUID): number[] {
        const item = this.items[nodeId];
        if (!item) return [];

        const result: number[] = [];

        if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
            const payload = item.data as BrowserTabPayload;
            if (payload.isOpen && payload.chromeId !== undefined) {
                result.push(payload.chromeId);
            }
        }

        const children = this.getChildren(nodeId);
        children.forEach(childId => {
            result.push(...this.flattenActiveTabs(childId));
        });

        return result;
    }

    private isAppTab(url?: string | null): boolean {
        if (!url) return false;
        try {
            const appUrl = chrome.runtime.getURL('app.html');
            return url.startsWith(appUrl);
        } catch {
            return false;
        }
    }

    // --- HELPERS (UPSERT logic restored) ---

    private findWindowByChromeId(chromeWinId: number): UUID | null {
        for (const [id, item] of Object.entries(this.items)) {
            if (item.definitionId !== DEFINITIONS.BROWSER_WINDOW) continue;
            const payload = item.data as BrowserWindowPayload;
            if (payload.chromeId === chromeWinId) return id;
        }
        return null;
    }

    private findTabByChromeId(chromeTabId: number): UUID | null {
        for (const [id, item] of Object.entries(this.items)) {
            if (item.definitionId !== DEFINITIONS.BROWSER_TAB) continue;
            const payload = item.data as BrowserTabPayload;
            if (payload.chromeId === chromeTabId) return id;
        }
        return null;
    }

    private async upsertWindow(win: chrome.windows.Window) {
        if (win.id === undefined) return;

        const containsAppTab = win.tabs?.some(t => this.isAppTab(t.url)) ?? false;
        let windowId = this.activeChromeWindowMap[win.id] ?? this.findWindowByChromeId(win.id) ?? undefined;

        if (windowId && this.items[windowId]) {
            // Reactivate existing
            const windowItem = this.items[windowId] as MetaItem<BrowserWindowPayload>;
            windowItem.data.chromeId = win.id;
            windowItem.data.isOpen = true;
            windowItem.data.status = 'active';
            (windowItem.data as any).metaAppWindow = containsAppTab;
            if (containsAppTab) {
                windowItem.data.name = 'Metabrain Curatio';
            }
            this.activeChromeWindowMap[win.id] = windowId;
            
            // Upsert tabs in order
            if (win.tabs) {
                for (const tab of win.tabs) {
                    await this.upsertTab(tab, windowId);
                }
            }
            
            // Trigger reactivity
            this.items = { ...this.items };
            return;
        }

        // Create new
        windowId = crypto.randomUUID();
        this.items[windowId] = {
            id: windowId,
            definitionId: DEFINITIONS.BROWSER_WINDOW,
            createdAt: Date.now(),
            data: {
                name: containsAppTab ? 'Metabrain Curatio' : `Window ${win.id}`,
                tabs: [],
                chromeId: win.id,
                isOpen: true,
                status: 'active'
            } as BrowserWindowPayload
        };
        (this.items[windowId].data as any).metaAppWindow = containsAppTab;

        const session = this.items[this.rootSessionId]?.data as SavedSessionPayload;
        if (session) {
            if (!session.windows.includes(windowId)) {
                session.windows.push(windowId);
            }
        }

        this.activeChromeWindowMap[win.id] = windowId;
        
        // Upsert tabs in order
        if (win.tabs) {
            for (const tab of win.tabs) {
                if (this.isAppTab(tab.url)) continue;
                await this.upsertTab(tab, windowId);
            }
        }
    }

    private async upsertTab(tab: chrome.tabs.Tab, parentWindowId?: UUID) {
        if (!tab.id) return;
        if (this.isAppTab(tab.url)) return;

        const winId = parentWindowId || this.activeChromeWindowMap[tab.windowId];
        if (!winId) return;

        const existingUUID: UUID | undefined =
            this.activeChromeTabMap[tab.id] ?? this.findTabByChromeId(tab.id) ?? undefined;

        let tabId = existingUUID;
        let tabItem = tabId ? (this.items[tabId] as MetaItem<BrowserTabPayload>) : undefined;

        if (!tabItem) {
            // Only create new tab if we truly don't have an existing one
            tabId = crypto.randomUUID();
            tabItem = {
                id: tabId,
                definitionId: DEFINITIONS.BROWSER_TAB,
                createdAt: Date.now(),
                data: {
                    url: tab.url || '',
                    title: tab.title || 'Untitled',
                    favIconUrl: tab.favIconUrl,
                    isPinned: tab.pinned,
                    chromeId: tab.id,
                    isOpen: true,
                    status: 'active'
                }
            };
            this.items[tabId] = tabItem;
            const windowTabs = (this.items[winId].data as BrowserWindowPayload).tabs;
            if (!windowTabs.includes(tabId)) {
                // Insert at correct position based on Chrome tab index
                const chromeWindow = await chrome.windows.get(tab.windowId!, { populate: true });
                if (chromeWindow.tabs) {
                    const chromeTabIndex = chromeWindow.tabs.findIndex(t => t.id === tab.id);
                    if (chromeTabIndex >= 0 && chromeTabIndex < windowTabs.length) {
                        windowTabs.splice(chromeTabIndex, 0, tabId);
                    } else {
                        windowTabs.push(tabId);
                    }
                } else {
                    windowTabs.push(tabId);
                }
            }
        } else {
            // Reactivate existing tab
            Object.assign(tabItem.data, {
                url: tab.url,
                title: tab.title,
                favIconUrl: tab.favIconUrl,
                isPinned: tab.pinned,
                chromeId: tab.id,
                isOpen: true,
                status: 'active'
            });
            await this.ensureTabInWindow(tabId, winId);
        }

        // Always update the Chrome ID mapping
        this.activeChromeTabMap[tab.id] = tabId;

        // Trigger reactivity by updating state
        this.items = { ...this.items };
    }

    private async markTabAsGhost(chromeTabId: number) {
        const tabId = this.activeChromeTabMap[chromeTabId];
        if (!tabId) return;
        const tabItem = this.items[tabId] as MetaItem<BrowserTabPayload>;
        if (tabItem) {
            tabItem.data.chromeId = undefined;
            tabItem.data.isOpen = false;
            tabItem.data.status = 'closed';

            // Remove from parent immediately (archive and remove from UI)
            const parentId = this.findParent(tabId);
            if (parentId) {
                this.removeFromParent(tabId, parentId);
                this.checkAndDeleteEmptyContainers(parentId);
            }
        }
        delete this.activeChromeTabMap[chromeTabId];
        // Trigger reactivity by updating state
        this.items = { ...this.items };
    }

    private markWindowAsGhost(chromeWinId: number) {
        const winId = this.activeChromeWindowMap[chromeWinId];
        if (!winId) return;
        const winItem = this.items[winId] as MetaItem<BrowserWindowPayload>;
        if (winItem) {
            winItem.data.chromeId = undefined;
            winItem.data.isOpen = false;
            if (!winItem.data.status || winItem.data.status === 'active') {
                winItem.data.status = 'closed';
            }
            winItem.data.tabs.forEach(tId => {
                const t = this.items[tId] as MetaItem<BrowserTabPayload>;
                if (t) {
                    if (t.data.chromeId !== undefined) {
                        delete this.activeChromeTabMap[t.data.chromeId];
                    }
                    t.data.chromeId = undefined;
                    t.data.isOpen = false;
                    if (!t.data.status || t.data.status === 'active') {
                        t.data.status = 'closed';
                    }
                }
            });

            // Check if parent session should remove this window
            const parentId = this.findParent(winId);
            if (parentId) {
                this.checkAndDeleteEmptyContainers(parentId);
            }
        }
        delete this.activeChromeWindowMap[chromeWinId];
        // Trigger reactivity by updating state
        this.items = { ...this.items };
    }

    private async ensureTabInWindow(tabId: UUID, windowId: UUID) {
        const tabItem = this.items[tabId];
        if (!tabItem || tabItem.definitionId !== DEFINITIONS.BROWSER_TAB) return;
        
        const tabPayload = tabItem.data as BrowserTabPayload;
        if (!tabPayload.chromeId) return;
        
        // Get Chrome tab to find its position
        const chromeTab = await chrome.tabs.get(tabPayload.chromeId);
        if (!chromeTab.windowId) return;
        
        const chromeWindow = await chrome.windows.get(chromeTab.windowId, { populate: true });
        if (!chromeWindow.tabs) return;
        
        const chromeTabIndex = chromeWindow.tabs.findIndex(t => t.id === tabPayload.chromeId);
        if (chromeTabIndex < 0) return;
        
        // Remove tab from all windows and tab children arrays to prevent duplicates
        Object.values(this.items).forEach(item => {
            if (item.definitionId === DEFINITIONS.BROWSER_WINDOW && item.id !== windowId) {
                const pl = item.data as BrowserWindowPayload;
                pl.tabs = pl.tabs.filter(id => id !== tabId);
            } else if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
                const tabPayload = item.data as BrowserTabPayload;
                if (tabPayload.children) {
                    tabPayload.children = tabPayload.children.filter(id => id !== tabId);
                }
            }
        });
        
        const pl = this.items[windowId].data as BrowserWindowPayload;
        if (!pl.tabs.includes(tabId)) {
            // Insert at correct position based on Chrome tab index
            if (chromeTabIndex < pl.tabs.length) {
                pl.tabs.splice(chromeTabIndex, 0, tabId);
            } else {
                pl.tabs.push(tabId);
            }
        } else {
            // Move to correct position if already in array
            const currentIndex = pl.tabs.indexOf(tabId);
            if (currentIndex !== chromeTabIndex && chromeTabIndex < pl.tabs.length) {
                pl.tabs.splice(currentIndex, 1);
                pl.tabs.splice(chromeTabIndex, 0, tabId);
            }
        }
    }

    private findParent(childId: UUID): UUID | null {
        for (const [id, item] of Object.entries(this.items)) {
            const children = this.getChildren(id);
            if (children.includes(childId)) return id;
        }
        return null;
    }

    /**
     * Walk ancestors until a window is found. Returns window UUID and chromeId (if any).
     */
    private findAncestorWindow(childId: UUID): { windowId: UUID, chromeId?: number } | null {
        let current: UUID | null = childId;
        while (current) {
            const parentId = this.findParent(current);
            if (!parentId) break;
            const parentItem = this.items[parentId];
            if (parentItem?.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                const payload = parentItem.data as BrowserWindowPayload;
                return { windowId: parentId, chromeId: payload.chromeId };
            }
            current = parentId;
        }
        return null;
    }

    private removeFromParent(childId: UUID, parentId: UUID) {
        const parent = this.items[parentId];
        if (parent) {
            if (parent.definitionId === DEFINITIONS.SESSION) {
                const pl = parent.data as SavedSessionPayload;
                pl.windows = pl.windows.filter(id => id !== childId);
            } else if (parent.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                const pl = parent.data as BrowserWindowPayload;
                pl.tabs = pl.tabs.filter(id => id !== childId);
            } else if (parent.definitionId === DEFINITIONS.BROWSER_TAB) {
                const pl = parent.data as BrowserTabPayload;
                if (pl.children) {
                    pl.children = pl.children.filter(id => id !== childId);
                }
            }
        }
    }

    getChildren(id: UUID): UUID[] {
        const item = this.items[id];
        if (!item) return [];

        // Filter out archived items if not showing archived
        const filterArchived = (ids: UUID[]): UUID[] => {
            return ids.filter(childId => {
                const child = this.items[childId];
                if (!child) return false;
                if (!this.showArchived) {
                    if (child.definitionId === DEFINITIONS.BROWSER_TAB) {
                        return (child.data as BrowserTabPayload).status !== 'archived';
                    } else if (child.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                        return (child.data as BrowserWindowPayload).status !== 'archived';
                    }
                }
                return true;
            });
        };

        if (item.definitionId === DEFINITIONS.SESSION) {
            return filterArchived((item.data as SavedSessionPayload).windows || []);
        }
        if (item.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            return filterArchived((item.data as BrowserWindowPayload).tabs || []);
        }
        if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
            return filterArchived((item.data as BrowserTabPayload).children || []);
        }
        return [];
    }

    toggleSelectNode(id: UUID, shiftKey: boolean = false, ctrlKey: boolean = false) {
        if (shiftKey && this.focusedNodeId) {
            // Range selection
            const nodes = this.flatVisibleNodes;
            const startIndex = nodes.indexOf(this.focusedNodeId);
            const endIndex = nodes.indexOf(id);
            if (startIndex >= 0 && endIndex >= 0) {
                const min = Math.min(startIndex, endIndex);
                const max = Math.max(startIndex, endIndex);
                for (let i = min; i <= max; i++) {
                    this.selectedNodeIds.add(nodes[i]);
                }
            }
        } else if (ctrlKey) {
            // Toggle individual selection
            if (this.selectedNodeIds.has(id)) {
                this.selectedNodeIds.delete(id);
            } else {
                this.selectedNodeIds.add(id);
            }
        } else {
            // Single selection
            this.selectedNodeIds.clear();
            this.selectedNodeIds.add(id);
        }
        this.setFocus(id);
    }

    get flatVisibleNodes(): UUID[] {
        const result: UUID[] = [];
        const seen = new Set<UUID>(); // Prevent duplicates

        const traverse = (nodeId: UUID) => {
            if (seen.has(nodeId)) {
                console.warn(`[CaptureStore] Duplicate node detected: ${nodeId}`);
                return; // Skip duplicates
            }
            seen.add(nodeId);
            result.push(nodeId);
            const children = this.getChildren(nodeId);
            children.forEach(childId => traverse(childId));
        };

        if (this.rootSessionId) {
            traverse(this.rootSessionId);
        }

        return result;
    }

    async moveNode(id: UUID, direction: 'up' | 'down') {
        const item = this.items[id];
        const parentId = this.findParent(id);
        if (!item || !parentId) return;

        const parent = this.items[parentId];
        if (!parent) return;

        // Get old parent window chromeId for tab moves
        const oldParentWindowId = parent.definitionId === DEFINITIONS.BROWSER_WINDOW
            ? (parent.data as BrowserWindowPayload).chromeId
            : undefined;

        // Get the actual children array from parent data (not filtered)
        let siblings: UUID[] = [];
        if (parent.definitionId === DEFINITIONS.SESSION) {
            siblings = (parent.data as SavedSessionPayload).windows || [];
        } else if (parent.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            siblings = (parent.data as BrowserWindowPayload).tabs || [];
        } else if (parent.definitionId === DEFINITIONS.BROWSER_TAB) {
            siblings = (parent.data as BrowserTabPayload).children || [];
        }

        const index = siblings.indexOf(id);
        if (index < 0) return;

        const newIndex = direction === 'up' ? index - 1 : index + 1;

        // If at boundary, try to move to adjacent parent
        if (newIndex < 0 || newIndex >= siblings.length) {
            const grandparentId = this.findParent(parentId);
            if (!grandparentId) return; // Can't move beyond root

            const grandparent = this.items[grandparentId];
            if (!grandparent) return;

            let grandparentSiblings: UUID[] = [];
            if (grandparent.definitionId === DEFINITIONS.SESSION) {
                grandparentSiblings = (grandparent.data as SavedSessionPayload).windows || [];
            } else if (grandparent.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                grandparentSiblings = (grandparent.data as BrowserWindowPayload).tabs || [];
            } else if (grandparent.definitionId === DEFINITIONS.BROWSER_TAB) {
                grandparentSiblings = (grandparent.data as BrowserTabPayload).children || [];
            }

            const parentIndex = grandparentSiblings.indexOf(parentId);
            if (parentIndex < 0) return;

            if (direction === 'up' && index === 0 && parentIndex > 0) {
                // Move to end of previous sibling
                const prevParentId = grandparentSiblings[parentIndex - 1];
                this.removeFromParent(id, parentId);
                // Immediately check old parent for cleanup
                this.checkAndDeleteEmptyContainers(parentId);
                const prevParent = this.items[prevParentId];
                if (prevParent) {
                    if (prevParent.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                        const tabsArray = (prevParent.data as BrowserWindowPayload).tabs;
                        if (!tabsArray.includes(id)) tabsArray.push(id);
                        // Move Chrome tab(s) to new window (recursively - always use moveChromeTree to keep parent+children together)
                        const newWindowChromeId = (prevParent.data as BrowserWindowPayload).chromeId;
                        if (newWindowChromeId !== undefined) {
                            // Always use moveChromeTree to move node and all descendants together
                            await this.moveChromeTree(id, newWindowChromeId, -1);
                        }
                    } else if (prevParent.definitionId === DEFINITIONS.BROWSER_TAB) {
                        const tabPayload = prevParent.data as BrowserTabPayload;
                        if (!tabPayload.children) tabPayload.children = [];
                        if (!tabPayload.children.includes(id)) tabPayload.children.push(id);
                        // Move Chrome tab to parent tab's window (always use moveChromeTree to keep parent+children together)
                        if (item.definitionId === DEFINITIONS.BROWSER_TAB && tabPayload.chromeId !== undefined) {
                            const parentTab = await chrome.tabs.get(tabPayload.chromeId);
                            if (parentTab?.windowId !== undefined) {
                                // Always use moveChromeTree to move node and all descendants together
                                await this.moveChromeTree(id, parentTab.windowId, -1);
                            }
                        }
                    } else if (prevParent.definitionId === DEFINITIONS.SESSION) {
                        const windowsArray = (prevParent.data as SavedSessionPayload).windows;
                        if (!windowsArray.includes(id)) windowsArray.push(id);
                    }
                }
                this.items = { ...this.items }; // Trigger reactivity
                this.save();
                this.setFocus(id);
                return;
            } else if (direction === 'down' && index === siblings.length - 1 && parentIndex < grandparentSiblings.length - 1) {
                // Move to start of next sibling
                const nextParentId = grandparentSiblings[parentIndex + 1];
                this.removeFromParent(id, parentId);
                // Immediately check old parent for cleanup
                this.checkAndDeleteEmptyContainers(parentId);
                const nextParent = this.items[nextParentId];
                if (nextParent) {
                    if (nextParent.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                        const tabsArray = (nextParent.data as BrowserWindowPayload).tabs;
                        if (!tabsArray.includes(id)) tabsArray.unshift(id);
                        // Move Chrome tab(s) to new window (recursively - always use moveChromeTree to keep parent+children together)
                        const newWindowChromeId = (nextParent.data as BrowserWindowPayload).chromeId;
                        if (newWindowChromeId !== undefined) {
                            // Always use moveChromeTree to move node and all descendants together
                            await this.moveChromeTree(id, newWindowChromeId, 0);
                        }
                    } else if (nextParent.definitionId === DEFINITIONS.BROWSER_TAB) {
                        const tabPayload = nextParent.data as BrowserTabPayload;
                        if (!tabPayload.children) tabPayload.children = [];
                        if (!tabPayload.children.includes(id)) tabPayload.children.unshift(id);
                        // Move Chrome tab to parent tab's window (always use moveChromeTree to keep parent+children together)
                        if (item.definitionId === DEFINITIONS.BROWSER_TAB && tabPayload.chromeId !== undefined) {
                            const parentTab = await chrome.tabs.get(tabPayload.chromeId);
                            if (parentTab?.windowId !== undefined) {
                                // Always use moveChromeTree to move node and all descendants together
                                await this.moveChromeTree(id, parentTab.windowId, 0);
                            }
                        }
                    } else if (nextParent.definitionId === DEFINITIONS.SESSION) {
                        const windowsArray = (nextParent.data as SavedSessionPayload).windows;
                        if (!windowsArray.includes(id)) windowsArray.unshift(id);
                    }
                }
                this.items = { ...this.items }; // Trigger reactivity
                this.save();
                this.setFocus(id);
                return;
            }
            return; // Can't move beyond boundaries
        }

        // Normal swap within siblings - modify the actual array
        // Remove the item from its current position
        siblings.splice(index, 1);
        // Insert at new position (accounting for removal)
        // Moving up/down by one is equivalent to inserting at the neighbor index.
        // Using `newIndex - 1` breaks "move down" (becomes a no-op).
        const insertIndex = newIndex;
        siblings.splice(insertIndex, 0, id);

        // Sync with Chrome if parent is a window and items are tabs
        if (parent.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            const parentWindowChromeId = (parent.data as BrowserWindowPayload).chromeId;
            if (parentWindowChromeId !== undefined) {
                // Calculate the correct Chrome tab index for the new position
                const targetChromeIndex = await this.calculateChromeTabIndex(parentWindowChromeId, insertIndex);
                // Move full subtree to preserve child ordering (moves parent + all children together)
                await this.moveChromeTree(id, parentWindowChromeId, targetChromeIndex);
            }
        }

        this.items = { ...this.items }; // Trigger reactivity
        this.save();
        // Maintain focus after operation
        this.setFocus(id);
    }

    private checkAndDeleteEmptyContainers(containerId: UUID) {
        const container = this.items[containerId];
        if (!container) return;

        if (container.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            // Aggressive: Window should be deleted/archived if tabs.length === 0
            const windowPayload = container.data as BrowserWindowPayload;
            const tabs = windowPayload.tabs || [];
            const isAppWindow = (windowPayload as any).metaAppWindow === true;
            if (tabs.length === 0 && !isAppWindow) {
                const parentId = this.findParent(containerId);
                if (parentId) {
                    this.removeFromParent(containerId, parentId);
                    // Recursively check parent
                    this.checkAndDeleteEmptyContainers(parentId);
                }
                // Archive the window
                windowPayload.status = 'archived';
                windowPayload.isOpen = false;
                windowPayload.chromeId = undefined;
            }
        } else if (container.definitionId === DEFINITIONS.BROWSER_TAB) {
            // Tab acting as group: Only delete if empty AND closed (ghost)
            const tabPayload = container.data as BrowserTabPayload;
            const children = tabPayload.children || [];

            // Filter out archived children
            const activeChildren = children.filter(childId => {
                const child = this.items[childId];
                if (!child) return false;
                if (child.definitionId === DEFINITIONS.BROWSER_TAB) {
                    return (child.data as BrowserTabPayload).status !== 'archived';
                } else if (child.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                    return (child.data as BrowserWindowPayload).status !== 'archived';
                }
                return true;
            });

            // Only delete if empty AND closed (ghost)
            const isClosed = !tabPayload.isOpen || tabPayload.chromeId === undefined;
            if (activeChildren.length === 0 && isClosed) {
                const parentId = this.findParent(containerId);
                if (parentId) {
                    this.removeFromParent(containerId, parentId);
                    // Recursively check parent
                    this.checkAndDeleteEmptyContainers(parentId);
                }
                // Archive the tab
                tabPayload.status = 'archived';
            }
        }
    }

    navigateFocus(direction: 'up' | 'down') {
        const nodes = this.flatVisibleNodes;
        if (nodes.length === 0) return;

        const currentIndex = this.focusedNodeId !== null
            ? nodes.indexOf(this.focusedNodeId)
            : -1;

        let newIndex: number;
        if (currentIndex < 0) {
            // No focus currently, set to first or last
            newIndex = direction === 'down' ? 0 : nodes.length - 1;
        } else {
            newIndex = direction === 'down' ? currentIndex + 1 : currentIndex - 1;
            newIndex = Math.max(0, Math.min(newIndex, nodes.length - 1));
        }

        if (newIndex >= 0 && newIndex < nodes.length) {
            this.setFocus(nodes[newIndex]);
        }
    }

    setFocus(id: UUID | null) { this.focusedNodeId = id; }

    handleSort(parentId: UUID | 'ROOT', newItems: { id: UUID }[]) {
        // Extract UUIDs from the newItems array
        const newOrder = newItems.map(item => item.id);

        // Handle ROOT case (root session)
        const actualParentId = parentId === 'ROOT' ? this.rootSessionId : parentId;
        const parent = this.items[actualParentId];

        if (!parent) return;

        // Update the children array based on parent type
        if (parent.definitionId === DEFINITIONS.SESSION) {
            (parent.data as SavedSessionPayload).windows = newOrder;
        } else if (parent.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            (parent.data as BrowserWindowPayload).tabs = newOrder;
        } else if (parent.definitionId === DEFINITIONS.BROWSER_TAB) {
            (parent.data as BrowserTabPayload).children = newOrder;
        }

        // Sync Chrome tabs if parent is a window and tabs are active
        if (parent.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            const windowChromeId = (parent.data as BrowserWindowPayload).chromeId;
            if (windowChromeId !== undefined) {
                // Move Chrome tabs to match new order
                // Only move tabs that are actually active in Chrome
                newOrder.forEach((tabId, index) => {
                    const tabItem = this.items[tabId];
                    if (tabItem?.definitionId === DEFINITIONS.BROWSER_TAB) {
                        const tabPayload = tabItem.data as BrowserTabPayload;
                        if (tabPayload.chromeId !== undefined && tabPayload.isOpen) {
                            chrome.tabs.move(tabPayload.chromeId, {
                                windowId: windowChromeId,
                                index: index
                            }).catch(console.error);
                        }
                    }
                });
            }
        }

        // Trigger reactivity
        this.items = { ...this.items };

        // Persist to storage immediately
        this.save();
    }

    async archiveNode(id: UUID) {
        const item = this.items[id];
        if (!item) return;

        // Remove from parent
        const parentId = this.findParent(id);
        if (parentId) {
            this.removeFromParent(id, parentId);
        }

        // Mark as archived
        if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
            (item.data as BrowserTabPayload).status = 'archived';
            (item.data as BrowserTabPayload).isOpen = false;
            (item.data as BrowserTabPayload).chromeId = undefined;
        } else if (item.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            (item.data as BrowserWindowPayload).status = 'archived';
            (item.data as BrowserWindowPayload).isOpen = false;
            (item.data as BrowserWindowPayload).chromeId = undefined;
            // Archive all child tabs
            const windowPayload = item.data as BrowserWindowPayload;
            windowPayload.tabs.forEach(tabId => {
                this.archiveNode(tabId);
            });
        }

        // Remove from active chrome maps if present
        if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
            const chromeId = (item.data as BrowserTabPayload).chromeId;
            if (chromeId !== undefined) {
                delete this.activeChromeTabMap[chromeId];
            }
        } else if (item.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            const chromeId = (item.data as BrowserWindowPayload).chromeId;
            if (chromeId !== undefined) {
                delete this.activeChromeWindowMap[chromeId];
            }
        }

        this.save();
    }

    async focusChromeTab(id: UUID) {
        const item = this.items[id];
        if (!item) return;

        if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
            const payload = item.data as BrowserTabPayload;
            if (payload.chromeId !== undefined && payload.isOpen) {
                try {
                    await chrome.tabs.update(payload.chromeId, { active: true });
                    const tab = await chrome.tabs.get(payload.chromeId);
                    if (tab.windowId !== undefined) {
                        await chrome.windows.update(tab.windowId, { focused: true });
                    }
                } catch (e) {
                    console.error('Failed to focus Chrome tab:', e);
                }
            }
        } else if (item.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            const payload = item.data as BrowserWindowPayload;
            if (payload.chromeId !== undefined && payload.isOpen) {
                try {
                    await chrome.windows.update(payload.chromeId, { focused: true });
                } catch (e) {
                    console.error('Failed to focus Chrome window:', e);
                }
            }
        }
    }

    async clearStorage() {
        if (this.storageListener) chrome.storage.onChanged.removeListener(this.storageListener);
        await metabrainStorage.clear();
        this.items = {};
        this.activeChromeWindowMap = {};
        this.activeChromeTabMap = {};
        this.rootSessionId = '';
        if (this.isBackground) await this.init(true);
    }

    async save() {
        // Only background script can write, but allow popup to trigger save via message
        if (!this.isBackground) {
            // Send message to background to save
            chrome.runtime.sendMessage({
                type: 'SAVE_STATE', data: {
                    items: $state.snapshot(this.items),
                    rootSessionId: this.rootSessionId
                }
            }).catch(() => {
                // Background might not be ready, that's okay
            });
            return;
        }
        await metabrainStorage.save({
            items: $state.snapshot(this.items),
            rootSessionId: this.rootSessionId
        });
    }
}

export const captureStore = new CaptureStore();
import { metabrainStorage, type MetabrainData } from '../utils/storage';
import {
    DEFINITIONS,
    type MetaItem,
    type UUID,
    type OutlineRow,
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
    // Track intentional sleeps so we don't treat them like external closes.
    private intentionalSleepTabIds = new Set<number>();

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
        // One-time migration: legacy `tabs: UUID[]` -> canonical `rows: [{id, depth}]`
        this.migrateLegacyTabsToRows();
    }

    private migrateLegacyTabsToRows() {
        for (const item of Object.values(this.items)) {
            if (item.definitionId !== DEFINITIONS.BROWSER_WINDOW) continue;
            const payload = item.data as BrowserWindowPayload;
            if (!payload.rows) {
                const legacyTabs = payload.tabs ?? [];
                payload.rows = legacyTabs.map((id) => ({ id, depth: 0 } satisfies OutlineRow));
            }
            // Keep legacy tabs for now, but always derive it from rows for consistency.
            payload.tabs = payload.rows.map((r) => r.id);
        }
    }

    private setupStorageListener() {
        if (this.storageListener) chrome.storage.onChanged.removeListener(this.storageListener);
        this.storageListener = (changes, areaName) => {
            // WXT `storage.setItem('local:KEY', ...)` may surface in `chrome.storage.onChanged`
            // either as `KEY` (most common) or `local:KEY` depending on implementation.
            const change =
                (areaName === 'local' ? (changes['metabrain_data'] ?? changes['local:metabrain_data']) : undefined);

            if (change) {
                const newValue = change.newValue as MetabrainData | undefined;
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
     * Called from background tab removal event.
     * - If the tab was intentionally slept from Curatio, mark as closed but keep in UI.
     * - Otherwise (user closed in Chrome), archive it (hidden from UI) but keep in DB/history.
     */
    async handleChromeTabRemoved(chromeTabId: number) {
        const tabUuid = this.activeChromeTabMap[chromeTabId] ?? this.findTabByChromeId(chromeTabId);
        if (!tabUuid) return;

        const item = this.items[tabUuid];
        if (!item || item.definitionId !== DEFINITIONS.BROWSER_TAB) return;
        const payload = item.data as BrowserTabPayload;

        payload.chromeId = undefined;
        payload.isOpen = false;

        // If we already marked this tab closed before removal, treat it as a sleep.
        // This avoids relying on ephemeral in-memory tracking across MV3 service worker lifecycles.
        const wasAlreadyClosed = payload.status === 'closed' || payload.isOpen === false;

        if (wasAlreadyClosed || this.intentionalSleepTabIds.has(chromeTabId)) {
            payload.status = 'closed';
            this.intentionalSleepTabIds.delete(chromeTabId);
        } else {
            // External close => archive (remove from UI, keep in DB)
            payload.status = 'archived';
        }

        delete this.activeChromeTabMap[chromeTabId];

        // If archived, remove from the window outline immediately and normalize descendant depths.
        if (payload.status === 'archived') {
            const loc = this.findTabLocation(tabUuid);
            if (loc) {
                const win = this.items[loc.windowId];
                if (win?.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                    const pl = win.data as BrowserWindowPayload;
                    if (!pl.rows) pl.rows = [];
                    const rows = pl.rows;
                    const start = loc.index;
                    const baseDepth = rows[start]?.depth ?? 0;
                    const end = this.subtreeEnd(rows, start);
                    // Remove the row itself
                    rows.splice(start, 1);
                    // Promote descendants by one level
                    for (let i = start; i < rows.length && i < end - 1; i++) {
                        if (rows[i].depth > baseDepth) {
                            rows[i] = { ...rows[i], depth: Math.max(0, rows[i].depth - 1) };
                        } else {
                            break;
                        }
                    }
                    pl.rows = rows;
                    pl.tabs = rows.map(r => r.id);
                }
            }
        }

        this.items = { ...this.items };
        await this.save();
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
            if (!windowPayload.rows) windowPayload.rows = [];
            
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
            
            // Reorder ONLY active rows to match Chrome, while keeping closed/archived rows in-place.
            // This keeps slept tabs from "jumping" while still guaranteeing active order mirrors Chrome.
            const existingRows = windowPayload.rows;
            const rank = new Map<UUID, number>();
            orderedTabIds.forEach((id, idx) => rank.set(id, idx));

            const activeRows = existingRows.filter(r => rank.has(r.id));
            activeRows.sort((a, b) => (rank.get(a.id)! - rank.get(b.id)!));

            let activeCursor = 0;
            windowPayload.rows = existingRows.map(r => {
                if (!rank.has(r.id)) return r;
                const next = activeRows[activeCursor];
                activeCursor++;
                return next;
            });

            // Keep legacy tabs in sync for any remaining code paths
            windowPayload.tabs = windowPayload.rows.map(r => r.id);
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
                // Mark closed immediately for UI, but keep chromeId until onRemoved so we can classify correctly.
                payload.isOpen = false;
                payload.status = 'closed';
                this.items = { ...this.items };
                this.intentionalSleepTabIds.add(chromeTabId);
                try {
                    await chrome.tabs.remove(chromeTabId);
                } catch (e) { /* ignore if already gone */ }
                // Final cleanup happens in `handleChromeTabRemoved`.
            } else if (payload.url) {
                // Find nearest ancestor window (supports nested/indented tabs)
                const ancestorWindow = this.findAncestorWindow(id);
                if (!ancestorWindow) return;

                const parentItem = this.items[ancestorWindow.windowId];
                if (!parentItem || parentItem.definitionId !== DEFINITIONS.BROWSER_WINDOW) return;

                // Ensure tab has a row in the window outline
                const windowPayload = parentItem.data as BrowserWindowPayload;
                if (!windowPayload.rows) windowPayload.rows = [];
                let rowIndex = windowPayload.rows.findIndex(r => r.id === id);
                if (rowIndex < 0) {
                    windowPayload.rows.push({ id, depth: 0 });
                    windowPayload.tabs = windowPayload.rows.map(r => r.id);
                    rowIndex = windowPayload.rows.length - 1;
                }

                let windowChromeId = (parentItem.data as BrowserWindowPayload).chromeId;

                // If Parent Window is inactive, Wake it first
                if (windowChromeId === undefined || !(parentItem.data as BrowserWindowPayload).isOpen) {
                    await this.toggleOpen(ancestorWindow.windowId);
                    windowChromeId = (this.items[ancestorWindow.windowId].data as BrowserWindowPayload).chromeId;
                }

                if (windowChromeId !== undefined) {
                    // Create at the correct Chrome LTR index among ACTIVE tabs.
                    const activeBefore = windowPayload.rows
                        .slice(0, rowIndex)
                        .filter(r => {
                            const t = this.items[r.id];
                            if (!t || t.definitionId !== DEFINITIONS.BROWSER_TAB) return false;
                            const tp = t.data as BrowserTabPayload;
                            return tp.status === 'active' && tp.isOpen === true && tp.chromeId !== undefined;
                        }).length;
                    const chromeIndex = await this.calculateChromeTabIndex(windowChromeId, activeBefore);

                    const created = await chrome.tabs.create({
                        windowId: windowChromeId,
                        url: payload.url,
                        ...(chromeIndex < 0 ? {} : { index: chromeIndex }),
                        active: true
                    } as chrome.tabs.CreateProperties);
                    if (created?.id !== undefined) {
                        payload.chromeId = created.id;
                        payload.isOpen = true;
                        payload.status = 'active';
                        this.activeChromeTabMap[created.id] = id;
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
                const urls = (payload.rows || [])
                    .map(r => (this.items[r.id]?.data as BrowserTabPayload)?.url)
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
        if (!item || item.definitionId !== DEFINITIONS.BROWSER_TAB) return;

        const loc = this.findTabLocation(id);
        if (!loc) return;
        const win = this.items[loc.windowId];
        if (!win || win.definitionId !== DEFINITIONS.BROWSER_WINDOW) return;

        const pl = win.data as BrowserWindowPayload;
        if (!pl.rows) pl.rows = [];
        const rows = pl.rows;

        const start = loc.index;
        const end = this.subtreeEnd(rows, start);
        const base = rows[start].depth;
        if (base <= 0) return;

        const newBase = base - 1;
        const delta = newBase - base; // negative
        for (let i = start; i < end; i++) {
            rows[i] = { ...rows[i], depth: Math.max(0, rows[i].depth + delta) };
        }
        pl.rows = rows;
        pl.tabs = rows.map(r => r.id);

        this.items = { ...this.items };
        await this.save();
        this.setFocus(id);
    }

    async indentNode(id: UUID) {
        const item = this.items[id];
        if (!item || item.definitionId !== DEFINITIONS.BROWSER_TAB) return;

        const loc = this.findTabLocation(id);
        if (!loc) return;
        const win = this.items[loc.windowId];
        if (!win || win.definitionId !== DEFINITIONS.BROWSER_WINDOW) return;

        const pl = win.data as BrowserWindowPayload;
        if (!pl.rows) pl.rows = [];
        const rows = pl.rows;

        const start = loc.index;
        if (start <= 0) return;
        const end = this.subtreeEnd(rows, start);

        const prevDepth = rows[start - 1].depth;
        const base = rows[start].depth;
        const desiredBase = prevDepth + 1;
        const delta = desiredBase - base;
        if (delta === 0) return;

        for (let i = start; i < end; i++) {
            rows[i] = { ...rows[i], depth: Math.max(0, rows[i].depth + delta) };
        }
        pl.rows = rows;
        pl.tabs = rows.map(r => r.id);

        this.items = { ...this.items };
        await this.save();
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

        // Move as a single block to preserve adjacency (prevents "interstitial tab" glitches).
        // Chrome supports moving an array of tabs while preserving their relative order.
        const index = targetIndex < 0 ? 999999 : targetIndex;
        try {
            await chrome.tabs.move(tabsToMove, { windowId: targetWindowId, index });
        } catch (e) {
            console.error(`Failed to move tab block ${tabsToMove.join(',')}:`, e);
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

        // We define logicalIndex as the position among non-app tabs (Curatio's UI list).
        // Convert that to an actual Chrome `index` while skipping the app tab.
        let seen = 0;
        for (let chromeIndex = 0; chromeIndex < chromeWindow.tabs.length; chromeIndex++) {
            const tab = chromeWindow.tabs[chromeIndex];
            if (this.isAppTab(tab.url)) continue;
            if (seen === logicalIndex) return chromeIndex;
            seen++;
        }

        // If logicalIndex is past the end of the non-app tabs, append.
        return -1;
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
            if (!windowItem.data.rows) {
                const legacyTabs = windowItem.data.tabs ?? [];
                windowItem.data.rows = legacyTabs.map((id) => ({ id, depth: 0 } satisfies OutlineRow));
            }
            windowItem.data.tabs = (windowItem.data.rows || []).map(r => r.id);
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
                rows: [],
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
            // Ensure the tab is in the correct window outline position (rows-based)
            await this.ensureTabInWindow(tabId, winId);
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

        // Ctrl-click parenting via depth rule: if the new tab is inserted immediately after its opener, indent it.
        if (tab.openerTabId !== undefined) {
            const openerUuid = this.activeChromeTabMap[tab.openerTabId] ?? this.findTabByChromeId(tab.openerTabId);
            if (openerUuid) {
                const openerLoc = this.findTabLocation(openerUuid);
                const newLoc = this.findTabLocation(tabId);
                if (openerLoc && newLoc && openerLoc.windowId === newLoc.windowId) {
                    const win = this.items[newLoc.windowId];
                    if (win?.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                        const pl = win.data as BrowserWindowPayload;
                        const rows = pl.rows || [];
                        if (newLoc.index === openerLoc.index + 1) {
                            const desired = (rows[openerLoc.index]?.depth ?? 0) + 1;
                            rows[newLoc.index] = { ...rows[newLoc.index], depth: desired };
                            pl.rows = rows;
                            pl.tabs = rows.map(r => r.id);
                        }
                    }
                }
            }
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
            const rowIds = (winItem.data.rows || []).map(r => r.id);
            rowIds.forEach(tId => {
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

        // Convert Chrome index to "non-app index"
        let nonAppIndex = 0;
        for (let i = 0; i < chromeTabIndex; i++) {
            if (!this.isAppTab(chromeWindow.tabs[i].url)) nonAppIndex++;
        }
        
        // Remove tab from all OTHER windows to prevent duplicates (rows-based).
        Object.values(this.items).forEach(item => {
            if (item.definitionId !== DEFINITIONS.BROWSER_WINDOW || item.id === windowId) return;
            const pl = item.data as BrowserWindowPayload;
            pl.rows = (pl.rows || []).filter(r => r.id !== tabId);
            pl.tabs = (pl.rows || []).map(r => r.id);
        });

        const pl = this.items[windowId].data as BrowserWindowPayload;
        if (!pl.rows) pl.rows = [];

        // Insert/move based on Chrome position among NON-APP tabs, but preserve closed tabs as stable rows.
        // Compute insertion row index by counting ACTIVE rows.
        const activeBefore = nonAppIndex;
        const isActiveRow = (row: OutlineRow) => {
            const t = this.items[row.id];
            if (!t || t.definitionId !== DEFINITIONS.BROWSER_TAB) return false;
            const tp = t.data as BrowserTabPayload;
            return tp.status === 'active' && tp.isOpen === true && tp.chromeId !== undefined;
        };

        const rows = pl.rows;
        const existingIndex = rows.findIndex(r => r.id === tabId);
        const existingDepth = existingIndex >= 0 ? rows[existingIndex].depth : 0;
        if (existingIndex >= 0) {
            rows.splice(existingIndex, 1);
        }

        let insertAt = rows.length;
        let seenActive = 0;
        for (let i = 0; i < rows.length; i++) {
            if (isActiveRow(rows[i])) {
                if (seenActive === activeBefore) {
                    insertAt = i;
                    break;
                }
                seenActive++;
            }
        }

        // Default depth: keep previous depth if we had one, otherwise 0 (normalized to contiguity).
        rows.splice(insertAt, 0, { id: tabId, depth: existingDepth });
        pl.rows = rows;
        pl.tabs = rows.map(r => r.id);
    }

    private findParent(childId: UUID): UUID | null {
        // Window -> Session parent
        const child = this.items[childId];
        if (!child) return null;

        if (child.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            const session = this.items[this.rootSessionId];
            if (session?.definitionId !== DEFINITIONS.SESSION) return null;
            const pl = session.data as SavedSessionPayload;
            return pl.windows.includes(childId) ? this.rootSessionId : null;
        }

        // Tab -> nearest prior row with depth-1, otherwise the containing window
        if (child.definitionId === DEFINITIONS.BROWSER_TAB) {
            const loc = this.findTabLocation(childId);
            if (!loc) return null;
            const { windowId, index, rows } = loc;
            const myDepth = rows[index].depth;
            if (myDepth <= 0) return windowId;
            for (let i = index - 1; i >= 0; i--) {
                if (rows[i].depth === myDepth - 1) return rows[i].id;
            }
            return windowId;
        }

        return null;
    }

    /**
     * Walk ancestors until a window is found. Returns window UUID and chromeId (if any).
     */
    private findAncestorWindow(childId: UUID): { windowId: UUID, chromeId?: number } | null {
        const loc = this.findTabLocation(childId);
        if (loc) {
            const win = this.items[loc.windowId];
            if (win?.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                const payload = win.data as BrowserWindowPayload;
                return { windowId: loc.windowId, chromeId: payload.chromeId };
            }
        }
        // If a window id is passed in, return it.
        const item = this.items[childId];
        if (item?.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            const payload = item.data as BrowserWindowPayload;
            return { windowId: childId, chromeId: payload.chromeId };
        }
        return null;
    }

    private findTabLocation(tabId: UUID): { windowId: UUID; index: number; rows: OutlineRow[] } | null {
        for (const [id, item] of Object.entries(this.items)) {
            if (item.definitionId !== DEFINITIONS.BROWSER_WINDOW) continue;
            const pl = item.data as BrowserWindowPayload;
            const rows = pl.rows || [];
            const index = rows.findIndex(r => r.id === tabId);
            if (index >= 0) return { windowId: id, index, rows };
        }
        return null;
    }

    private subtreeEnd(rows: OutlineRow[], start: number): number {
        const base = rows[start]?.depth ?? 0;
        let i = start + 1;
        while (i < rows.length && rows[i].depth > base) i++;
        return i;
    }

    private removeFromParent(childId: UUID, parentId: UUID) {
        const parent = this.items[parentId];
        if (parent) {
            if (parent.definitionId === DEFINITIONS.SESSION) {
                const pl = parent.data as SavedSessionPayload;
                pl.windows = pl.windows.filter(id => id !== childId);
            } else if (parent.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                const pl = parent.data as BrowserWindowPayload;
                pl.rows = (pl.rows || []).filter(r => r.id !== childId);
                pl.tabs = (pl.rows || []).map(r => r.id);
            } else if (parent.definitionId === DEFINITIONS.BROWSER_TAB) {
                // Depth-based model: removing a tab from its parent means removing its row from the containing window
                const loc = this.findTabLocation(childId);
                if (!loc) return;
                const win = this.items[loc.windowId];
                if (!win || win.definitionId !== DEFINITIONS.BROWSER_WINDOW) return;
                const pl = win.data as BrowserWindowPayload;
                if (!pl.rows) pl.rows = [];
                const rows = pl.rows;
                const start = loc.index;
                const baseDepth = rows[start]?.depth ?? 0;
                const end = this.subtreeEnd(rows, start);
                rows.splice(start, 1);
                for (let i = start; i < rows.length && i < end - 1; i++) {
                    if (rows[i].depth > baseDepth) {
                        rows[i] = { ...rows[i], depth: Math.max(0, rows[i].depth - 1) };
                    } else {
                        break;
                    }
                }
                pl.rows = rows;
                pl.tabs = rows.map(r => r.id);
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
            const pl = item.data as BrowserWindowPayload;
            const rows = pl.rows || [];
            return filterArchived(rows.filter(r => r.depth === 0).map(r => r.id));
        }
        if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
            const loc = this.findTabLocation(id);
            if (!loc) return [];
            const { rows, index } = loc;
            const baseDepth = rows[index].depth;
            const end = this.subtreeEnd(rows, index);

            const result: UUID[] = [];
            let i = index + 1;
            while (i < end) {
                if (rows[i].depth === baseDepth + 1) {
                    result.push(rows[i].id);
                    i = this.subtreeEnd(rows, i);
                } else {
                    i++;
                }
            }
            return filterArchived(result);
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
        if (!item) return;

        // Tabs: depth-based contiguous subtree move within (or across) windows.
        if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
            const loc = this.findTabLocation(id);
            if (!loc) return;
            const winItem = this.items[loc.windowId];
            if (!winItem || winItem.definitionId !== DEFINITIONS.BROWSER_WINDOW) return;

            const winPayload = winItem.data as BrowserWindowPayload;
            if (!winPayload.rows) winPayload.rows = [];
            const rows = winPayload.rows;

            const start = loc.index;
            const end = this.subtreeEnd(rows, start);
            const block = rows.slice(start, end);
            const baseDepth = block[0].depth;

            const isActive = (rowId: UUID) => {
                const t = this.items[rowId];
                if (!t || t.definitionId !== DEFINITIONS.BROWSER_TAB) return false;
                const tp = t.data as BrowserTabPayload;
                return tp.status === 'active' && tp.isOpen === true && tp.chromeId !== undefined;
            };
            const activeLogicalIndex = (rows: OutlineRow[], insertAt: number) => {
                let count = 0;
                for (let i = 0; i < insertAt; i++) if (isActive(rows[i].id)) count++;
                return count;
            };
            const normalizeBlock = (block: OutlineRow[], prevDepth: number) => {
                const newBase = Math.min(baseDepth, prevDepth + 1);
                const delta = newBase - baseDepth;
                if (delta === 0) return block;
                return block.map(r => ({ ...r, depth: Math.max(0, r.depth + delta) }));
            };
            const moveChromeBlock = async (targetChromeWinId: number, insertAtRows: OutlineRow[], insertAtIndex: number) => {
                const chromeIds = block
                    .map(r => this.items[r.id])
                    .filter((it): it is MetaItem<BrowserTabPayload> => !!it && it.definitionId === DEFINITIONS.BROWSER_TAB)
                    .map(it => it.data)
                    .filter(pl => pl.chromeId !== undefined && pl.isOpen === true && pl.status === 'active')
                    .map(pl => pl.chromeId as number);
                if (chromeIds.length === 0) return;
                const logical = activeLogicalIndex(insertAtRows, insertAtIndex);
                const chromeIndex = await this.calculateChromeTabIndex(targetChromeWinId, logical);
                await chrome.tabs.move(chromeIds, { windowId: targetChromeWinId, index: chromeIndex < 0 ? 999999 : chromeIndex }).catch(() => { });
            };

            // Remove block from source rows
            rows.splice(start, end - start);

            const session = this.items[this.rootSessionId]?.data as SavedSessionPayload | undefined;
            const windowOrder = session?.windows || [];
            const windowIndex = windowOrder.indexOf(loc.windowId);

            const insertIntoWindow = async (targetWindowId: UUID, insertAt: number) => {
                const targetWindow = this.items[targetWindowId];
                if (!targetWindow || targetWindow.definitionId !== DEFINITIONS.BROWSER_WINDOW) return false;
                const targetPayload = targetWindow.data as BrowserWindowPayload;
                if (!targetPayload.rows) targetPayload.rows = [];

                const destRows = targetPayload.rows;
                const clamped = Math.max(0, Math.min(insertAt, destRows.length));
                const prevDepth = clamped === 0 ? 0 : destRows[clamped - 1].depth;
                const newBlock = normalizeBlock(block, prevDepth);
                destRows.splice(clamped, 0, ...newBlock);
                targetPayload.rows = destRows;
                targetPayload.tabs = destRows.map(r => r.id);

                // chrome move (active subset only)
                if (targetPayload.chromeId !== undefined) {
                    await moveChromeBlock(targetPayload.chromeId, destRows, clamped);
                }
                return true;
            };

            if (direction === 'up') {
                if (start === 0) {
                    if (windowIndex > 0) {
                        const prevWinId = windowOrder[windowIndex - 1];
                        const prevWin = this.items[prevWinId];
                        const prevRows = prevWin?.definitionId === DEFINITIONS.BROWSER_WINDOW ? ((prevWin.data as BrowserWindowPayload).rows || []) : [];
                        await insertIntoWindow(prevWinId, prevRows.length);
                    } else {
                        // No previous window; reinsert at start
                        rows.splice(0, 0, ...block);
                    }
                } else {
                    // Insert at start-1 in the same window
                    const insertAt = start - 1;
                    const prevDepth = insertAt === 0 ? 0 : rows[insertAt - 1].depth;
                    const newBlock = normalizeBlock(block, prevDepth);
                    rows.splice(insertAt, 0, ...newBlock);
                    if (winPayload.chromeId !== undefined) {
                        await moveChromeBlock(winPayload.chromeId, rows, insertAt);
                    }
                }
            } else {
                // Next "block" starts where our block used to be (after removal)
                const nextStart = start;
                if (nextStart >= rows.length) {
                    if (windowIndex >= 0 && windowIndex < windowOrder.length - 1) {
                        const nextWinId = windowOrder[windowIndex + 1];
                        await insertIntoWindow(nextWinId, 0);
                    } else {
                        // Spawn a new window if we're at the bottom of the last window
                        const firstActive = block
                            .map(r => this.items[r.id])
                            .filter((it): it is MetaItem<BrowserTabPayload> => !!it && it.definitionId === DEFINITIONS.BROWSER_TAB)
                            .map(it => it.data)
                            .find(pl => pl.chromeId !== undefined && pl.isOpen === true && pl.status === 'active');

                        if (firstActive?.chromeId !== undefined) {
                            const newWin = await chrome.windows.create({ tabId: firstActive.chromeId });
                            if (newWin?.id !== undefined) {
                                const newWindowUuid = crypto.randomUUID();
                                this.items[newWindowUuid] = {
                                    id: newWindowUuid,
                                    definitionId: DEFINITIONS.BROWSER_WINDOW,
                                    createdAt: Date.now(),
                                    data: {
                                        name: `Window ${newWin.id}`,
                                        rows: [],
                                        tabs: [],
                                        chromeId: newWin.id,
                                        isOpen: true,
                                        status: 'active'
                                    } as BrowserWindowPayload
                                };
                                if (session && !session.windows.includes(newWindowUuid)) {
                                    session.windows.push(newWindowUuid);
                                }
                                this.activeChromeWindowMap[newWin.id] = newWindowUuid;

                                // Move the remaining active tabs into the new window
                                const chromeIds = block
                                    .map(r => this.items[r.id])
                                    .filter((it): it is MetaItem<BrowserTabPayload> => !!it && it.definitionId === DEFINITIONS.BROWSER_TAB)
                                    .map(it => it.data)
                                    .filter(pl => pl.chromeId !== undefined && pl.isOpen === true && pl.status === 'active')
                                    .map(pl => pl.chromeId as number);
                                const rest = chromeIds.filter(id => id !== firstActive.chromeId);
                                if (rest.length > 0) {
                                    await chrome.tabs.move(rest, { windowId: newWin.id, index: 1 }).catch(() => { });
                                }

                                // Insert block rows into the new window outline at start
                                const targetPayload = this.items[newWindowUuid].data as BrowserWindowPayload;
                                targetPayload.rows = normalizeBlock(block, 0);
                                targetPayload.tabs = targetPayload.rows.map(r => r.id);
                            } else {
                                // If we failed to create a new window, reinsert back where it was
                                rows.splice(start, 0, ...block);
                            }
                        } else {
                            rows.splice(start, 0, ...block);
                        }
                    }
                } else {
                    const nextEnd = this.subtreeEnd(rows, nextStart);
                    const insertAt = nextEnd;
                    const prevDepth = insertAt === 0 ? 0 : rows[insertAt - 1].depth;
                    const newBlock = normalizeBlock(block, prevDepth);
                    rows.splice(insertAt, 0, ...newBlock);
                    if (winPayload.chromeId !== undefined) {
                        await moveChromeBlock(winPayload.chromeId, rows, insertAt);
                    }
                }
            }

            winPayload.rows = rows;
            winPayload.tabs = rows.map(r => r.id);

            this.items = { ...this.items };
            await this.save();
            this.setFocus(id);
            return;
        }

        // Windows: keep existing behavior for now
        const parentId = this.findParent(id);
        if (!parentId) return;
        const parent = this.items[parentId];
        if (!parent) return;

        let siblings: UUID[] = [];
        if (parent.definitionId === DEFINITIONS.SESSION) {
            siblings = (parent.data as SavedSessionPayload).windows || [];
        }
        const index = siblings.indexOf(id);
        if (index < 0) return;

        const newIndex = direction === 'up' ? index - 1 : index + 1;
        if (newIndex < 0 || newIndex >= siblings.length) return;

        siblings.splice(index, 1);
        siblings.splice(newIndex, 0, id);

        this.items = { ...this.items };
        await this.save();
        this.setFocus(id);
    }

    private checkAndDeleteEmptyContainers(containerId: UUID) {
        const container = this.items[containerId];
        if (!container) return;

        if (container.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            // Aggressive: Window should be deleted/archived if tabs.length === 0
            const windowPayload = container.data as BrowserWindowPayload;
            const tabs = (windowPayload.rows || []).map(r => r.id);
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

        // Update ordering based on parent type
        if (parent.definitionId === DEFINITIONS.SESSION) {
            (parent.data as SavedSessionPayload).windows = newOrder;
        } else if (parent.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            const pl = parent.data as BrowserWindowPayload;
            const existing = pl.rows || [];
            const byId = new Map(existing.map(r => [r.id, r]));
            pl.rows = newOrder.map(id => byId.get(id) ?? ({ id, depth: 0 } satisfies OutlineRow));
            pl.tabs = pl.rows.map(r => r.id);
        } else if (parent.definitionId === DEFINITIONS.BROWSER_TAB) {
            // Drag-and-drop within a depth-based outline requires a depth-aware rewriter.
            // For now, ignore to avoid corrupting invariants.
            return;
        }

        // Sync Chrome tabs if parent is a window and tabs are active
        if (parent.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            const windowChromeId = (parent.data as BrowserWindowPayload).chromeId;
            if (windowChromeId !== undefined) {
                // Move only active Chrome tabs to match new active order.
                const chromeIds = newOrder
                    .map(id => this.items[id])
                    .filter((it): it is MetaItem<BrowserTabPayload> => !!it && it.definitionId === DEFINITIONS.BROWSER_TAB)
                    .map(it => it.data)
                    .filter(pl => pl.chromeId !== undefined && pl.isOpen === true && pl.status === 'active')
                    .map(pl => pl.chromeId as number);
                if (chromeIds.length > 0) {
                    chrome.tabs.move(chromeIds, { windowId: windowChromeId, index: 0 }).catch(console.error);
                }
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
            (windowPayload.rows || []).forEach(r => {
                this.archiveNode(r.id);
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
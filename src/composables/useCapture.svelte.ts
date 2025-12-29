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
    focusedNodeId = $state<UUID | null>(null);
    selectedNodeIds = $state<Set<UUID>>(new Set());
    showArchived = $state<boolean>(false);

    // Map<ExpectedURL, UUID> - Used to link new Chrome tabs to existing inactive UUIDs
    private pendingRestores = new Map<string, UUID>();

    private isBackground = false;
    private storageListener: ((changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void) | null = null;

    async init(isBackground: boolean = false) {
        this.isBackground = isBackground;
        await this.hydrateFromStorage();
        this.setupStorageListener();

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
            this.activeChromeMap = saved.activeChromeMap || {};
        } else if (this.isBackground) {
            const sessionId = crypto.randomUUID();
            this.items[sessionId] = {
                id: sessionId,
                definitionId: DEFINITIONS.SESSION,
                createdAt: Date.now(),
                data: { name: 'Default Session', windows: [] } as SavedSessionPayload
            };
            this.rootSessionId = sessionId;
            this.activeChromeMap = {};
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
                    this.activeChromeMap = newValue.activeChromeMap || {};
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

        // Ghost check
        Object.values(this.items).forEach(item => {
            if (item.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                const payload = item.data as BrowserWindowPayload;
                if (payload.chromeId !== undefined && payload.isOpen && !currentWindowIds.has(payload.chromeId)) {
                    this.markWindowAsGhost(payload.chromeId);
                }
            }
        });

        windows.forEach(win => this.upsertWindow(win));
        await this.save();
    }

    private setupListeners() {
        chrome.windows.onCreated.addListener(w => {
            this.upsertWindow(w);
            this.save();
            this.items = { ...this.items }; // Trigger reactivity
        });
        chrome.windows.onRemoved.addListener(id => {
            this.markWindowAsGhost(id);
            this.save();
            this.items = { ...this.items }; // Trigger reactivity
        });

        chrome.tabs.onCreated.addListener(t => {
            this.upsertTab(t);
            this.save();
            this.items = { ...this.items }; // Trigger reactivity
        });
        chrome.tabs.onUpdated.addListener((_, __, t) => {
            this.upsertTab(t);
            this.save();
            this.items = { ...this.items }; // Trigger reactivity
        });
        chrome.tabs.onRemoved.addListener(id => {
            this.markTabAsGhost(id);
            this.save();
            this.items = { ...this.items }; // Trigger reactivity
        });
        chrome.tabs.onMoved.addListener(id => chrome.tabs.get(id, t => {
            if (t) {
                this.upsertTab(t);
                this.save();
                this.items = { ...this.items }; // Trigger reactivity
            }
        }));
    }

    // --- ACTIONS ---

    async toggleOpen(id: UUID) {
        const item = this.items[id];
        if (!item) return;

        // 1. Handle Tab Toggle
        if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
            const payload = item.data as BrowserTabPayload;

            if (payload.isOpen && payload.chromeId !== undefined) {
                // SLEEP: Close tab, keep node
                try { await chrome.tabs.remove(payload.chromeId); } catch (e) { /* ignore if already gone */ }
            } else if (payload.url) {
                // WAKE: Check if tab already exists before creating
                const existingTabId = this.findTabByUrl(payload.url);
                if (existingTabId && existingTabId !== id) {
                    // Tab already exists, focus it instead
                    await this.focusChromeTab(existingTabId);
                    return;
                }

                // Find parent window
                const parentId = this.findParent(id);
                if (!parentId) return;

                const parentItem = this.items[parentId];
                if (!parentItem || parentItem.definitionId !== DEFINITIONS.BROWSER_WINDOW) return;

                let windowChromeId = (parentItem.data as BrowserWindowPayload).chromeId;

                // If Parent Window is inactive, Wake it first
                if (windowChromeId === undefined || !(parentItem.data as BrowserWindowPayload).isOpen) {
                    await this.toggleOpen(parentId);
                    windowChromeId = (this.items[parentId].data as BrowserWindowPayload).chromeId;
                }

                if (windowChromeId !== undefined) {
                    // Calculate Index
                    const siblings = (parentItem.data as BrowserWindowPayload).tabs;
                    const index = siblings.indexOf(id);

                    this.pendingRestores.set(payload.url, id);

                    await chrome.tabs.create({
                        windowId: windowChromeId,
                        url: payload.url,
                        index: index >= 0 ? index : undefined,
                        active: true
                    });
                    // Update state immediately for instant UI feedback
                    payload.isOpen = true;
                    payload.status = 'active';
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

    findTabByUrl(url: string): UUID | null {
        for (const [id, item] of Object.entries(this.items)) {
            if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
                const payload = item.data as BrowserTabPayload;
                if (payload.url === url && payload.isOpen && payload.chromeId !== undefined) {
                    return id;
                }
            }
        }
        return null;
    }

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
            const parentIndex = session.windows.indexOf(parentId);
            if (parentIndex >= 0) session.windows.splice(parentIndex + 1, 0, newWindowId);
            else session.windows.push(newWindowId);

            // Physical Update: Move the Tab in Chrome
            const tabPayload = item.data as BrowserTabPayload;
            if (tabPayload.isOpen && tabPayload.chromeId !== undefined) {
                const newWin = await chrome.windows.create({ tabId: tabPayload.chromeId });
                if (newWin && newWin.id) {
                    (this.items[newWindowId].data as BrowserWindowPayload).chromeId = newWin.id;
                    this.activeChromeMap[newWin.id] = newWindowId;
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
        this.removeFromParent(id, parentId);
        const gp = this.items[grandparentId];

        if (gp.definitionId === DEFINITIONS.SESSION) {
            const pl = gp.data as SavedSessionPayload;
            const idx = pl.windows.indexOf(parentId);
            pl.windows.splice(idx + 1, 0, id);
        } else if (gp.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            const pl = gp.data as BrowserWindowPayload;
            const idx = pl.tabs.indexOf(parentId);
            pl.tabs.splice(idx + 1, 0, id);
        } else if (gp.definitionId === DEFINITIONS.BROWSER_TAB) {
            // Tab outdenting from Tab: become sibling of parent Tab in grandparent Tab's children
            const pl = gp.data as BrowserTabPayload;
            if (!pl.children) {
                pl.children = [];
            }
            const idx = pl.children.indexOf(parentId);
            if (idx >= 0) {
                pl.children.splice(idx + 1, 0, id);
            } else {
                pl.children.push(id);
            }
        }
        this.checkAndDeleteEmptyContainers(parentId);
        this.save();
        this.setFocus(id);
    }

    indentNode(id: UUID) {
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

        this.removeFromParent(id, parentId);

        if (prevSibling.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            (prevSibling.data as BrowserWindowPayload).tabs.push(id);
        } else if (prevSibling.definitionId === DEFINITIONS.SESSION) {
            (prevSibling.data as SavedSessionPayload).windows.push(id);
        } else if (prevSibling.definitionId === DEFINITIONS.BROWSER_TAB) {
            // Tab-into-Tab nesting: initialize children array if missing
            const tabPayload = prevSibling.data as BrowserTabPayload;
            if (!tabPayload.children) {
                tabPayload.children = [];
            }
            tabPayload.children.push(id);
        }

        this.checkAndDeleteEmptyContainers(parentId);
        this.save();
        // Maintain focus after operation
        this.setFocus(id);
    }

    // --- HELPERS (UPSERT logic restored) ---

    private upsertWindow(win: chrome.windows.Window) {
        if (win.id === undefined) return;

        let windowId = this.activeChromeMap[win.id];

        if (windowId && this.items[windowId]) {
            // Reactivate existing
            const windowItem = this.items[windowId] as MetaItem<BrowserWindowPayload>;
            windowItem.data.chromeId = win.id;
            windowItem.data.isOpen = true;
            windowItem.data.status = 'active';
            this.activeChromeMap[win.id] = windowId;
            win.tabs?.forEach((tab: chrome.tabs.Tab) => this.upsertTab(tab, windowId));
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
                name: `Window ${win.id}`,
                tabs: [],
                chromeId: win.id,
                isOpen: true,
                status: 'active'
            } as BrowserWindowPayload
        };

        const session = this.items[this.rootSessionId]?.data as SavedSessionPayload;
        if (session && !session.windows.includes(windowId)) {
            session.windows.push(windowId);
        }

        this.activeChromeMap[win.id] = windowId;
        win.tabs?.forEach((tab: chrome.tabs.Tab) => this.upsertTab(tab, windowId));
    }

    private upsertTab(tab: chrome.tabs.Tab, parentWindowId?: UUID) {
        if (!tab.id) return;

        let existingUUID: UUID | undefined;
        if (tab.url && this.pendingRestores.has(tab.url)) {
            existingUUID = this.pendingRestores.get(tab.url);
            this.pendingRestores.delete(tab.url);
        }

        const winId = parentWindowId || this.activeChromeMap[tab.windowId];
        if (!winId) return;

        let tabId = existingUUID || this.activeChromeMap[tab.id];
        if (!tabId && existingUUID) tabId = existingUUID;

        let tabItem = tabId ? (this.items[tabId] as MetaItem<BrowserTabPayload>) : undefined;

        if (!tabItem) {
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
            (this.items[winId].data as BrowserWindowPayload).tabs.push(tabId);
        } else {
            Object.assign(tabItem.data, {
                url: tab.url,
                title: tab.title,
                favIconUrl: tab.favIconUrl,
                isPinned: tab.pinned,
                chromeId: tab.id,
                isOpen: true,
                status: 'active'
            });
            this.ensureTabInWindow(tabId, winId);
        }
        this.activeChromeMap[tab.id] = tabId;
        // Trigger reactivity by updating state
        this.items = { ...this.items };
    }

    private markTabAsGhost(chromeTabId: number) {
        const tabId = this.activeChromeMap[chromeTabId];
        if (!tabId) return;
        const tabItem = this.items[tabId] as MetaItem<BrowserTabPayload>;
        if (tabItem) {
            tabItem.data.chromeId = undefined;
            tabItem.data.isOpen = false;
            if (!tabItem.data.status || tabItem.data.status === 'active') {
                tabItem.data.status = 'closed';
            }
        }
        delete this.activeChromeMap[chromeTabId];
        // Trigger reactivity by updating state
        this.items = { ...this.items };
    }

    private markWindowAsGhost(chromeWinId: number) {
        const winId = this.activeChromeMap[chromeWinId];
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
                    t.data.chromeId = undefined;
                    t.data.isOpen = false;
                    if (!t.data.status || t.data.status === 'active') {
                        t.data.status = 'closed';
                    }
                }
            });
        }
        delete this.activeChromeMap[chromeWinId];
        // Trigger reactivity by updating state
        this.items = { ...this.items };
    }

    private ensureTabInWindow(tabId: UUID, windowId: UUID) {
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
        if (!pl.tabs.includes(tabId)) pl.tabs.push(tabId);
    }

    private findParent(childId: UUID): UUID | null {
        for (const [id, item] of Object.entries(this.items)) {
            const children = this.getChildren(id);
            if (children.includes(childId)) return id;
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

    moveNode(id: UUID, direction: 'up' | 'down') {
        const item = this.items[id];
        const parentId = this.findParent(id);
        if (!item || !parentId) return;

        const parent = this.items[parentId];
        if (!parent) return;

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
                const prevParent = this.items[prevParentId];
                if (prevParent) {
                    if (prevParent.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                        (prevParent.data as BrowserWindowPayload).tabs.push(id);
                    } else if (prevParent.definitionId === DEFINITIONS.BROWSER_TAB) {
                        const tabPayload = prevParent.data as BrowserTabPayload;
                        if (!tabPayload.children) tabPayload.children = [];
                        tabPayload.children.push(id);
                    } else if (prevParent.definitionId === DEFINITIONS.SESSION) {
                        (prevParent.data as SavedSessionPayload).windows.push(id);
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
                const nextParent = this.items[nextParentId];
                if (nextParent) {
                    if (nextParent.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                        (nextParent.data as BrowserWindowPayload).tabs.unshift(id);
                    } else if (nextParent.definitionId === DEFINITIONS.BROWSER_TAB) {
                        const tabPayload = nextParent.data as BrowserTabPayload;
                        if (!tabPayload.children) tabPayload.children = [];
                        tabPayload.children.unshift(id);
                    } else if (nextParent.definitionId === DEFINITIONS.SESSION) {
                        (nextParent.data as SavedSessionPayload).windows.unshift(id);
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
        [siblings[index], siblings[newIndex]] = [siblings[newIndex], siblings[index]];
        this.items = { ...this.items }; // Trigger reactivity
        this.save();
        // Maintain focus after operation
        this.setFocus(id);
    }

    private checkAndDeleteEmptyContainers(containerId: UUID) {
        const container = this.items[containerId];
        if (!container) return;

        let children: UUID[] = [];
        if (container.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            children = (container.data as BrowserWindowPayload).tabs || [];
        } else if (container.definitionId === DEFINITIONS.BROWSER_TAB) {
            children = (container.data as BrowserTabPayload).children || [];
        }

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

        // If container is empty, delete it
        if (activeChildren.length === 0 && (container.definitionId === DEFINITIONS.BROWSER_WINDOW || container.definitionId === DEFINITIONS.BROWSER_TAB)) {
            const parentId = this.findParent(containerId);
            if (parentId) {
                this.removeFromParent(containerId, parentId);
                // Recursively check parent
                this.checkAndDeleteEmptyContainers(parentId);
            }
            // Archive the container instead of deleting
            if (container.definitionId === DEFINITIONS.BROWSER_WINDOW) {
                (container.data as BrowserWindowPayload).status = 'archived';
            } else if (container.definitionId === DEFINITIONS.BROWSER_TAB) {
                (container.data as BrowserTabPayload).status = 'archived';
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

        // Remove from activeChromeMap if present
        if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
            const chromeId = (item.data as BrowserTabPayload).chromeId;
            if (chromeId !== undefined) {
                delete this.activeChromeMap[chromeId];
            }
        } else if (item.definitionId === DEFINITIONS.BROWSER_WINDOW) {
            const chromeId = (item.data as BrowserWindowPayload).chromeId;
            if (chromeId !== undefined) {
                delete this.activeChromeMap[chromeId];
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
        this.activeChromeMap = {};
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
                    rootSessionId: this.rootSessionId,
                    activeChromeMap: $state.snapshot(this.activeChromeMap)
                }
            }).catch(() => {
                // Background might not be ready, that's okay
            });
            return;
        }
        await metabrainStorage.save({
            items: $state.snapshot(this.items),
            rootSessionId: this.rootSessionId,
            activeChromeMap: $state.snapshot(this.activeChromeMap)
        });
    }
}

export const captureStore = new CaptureStore();
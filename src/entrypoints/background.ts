import { captureStore } from '@/composables/useCapture.svelte';

export default defineBackground(() => {
  captureStore.init(true).catch(console.error);

  // Store the Curatio window ID in session storage
  const CURATIO_WINDOW_KEY = 'curatio_window_id';

  // Handle extension icon click - TabsOutliner Style (Detached Window)
  // CRITICAL: This listener ONLY fires if 'default_popup' is missing from manifest (action: {})
  chrome.action.onClicked.addListener(async () => {
    try {
      // 1. Singleton Check: Focus existing window if open
      const stored = await chrome.storage.session.get(CURATIO_WINDOW_KEY);
      const existingWindowId = stored[CURATIO_WINDOW_KEY] as number | undefined;

      if (existingWindowId !== undefined) {
        // Check if window still exists
        try {
          await chrome.windows.get(existingWindowId);
          // Window exists, focus it
          await chrome.windows.update(existingWindowId, { focused: true });
          return;
        } catch {
          // Window doesn't exist anymore, remove from storage
          await chrome.storage.session.remove(CURATIO_WINDOW_KEY);
        }
      }

      // 2. Prepare URL (pointing to 'app.html' because folder is 'entrypoints/app')
      const appUrl = chrome.runtime.getURL('app.html');

      // 3. Get screen dimensions with robust fallbacks
      let screenWidth = 1920; // Default fallback
      let screenHeight = 1080; // Default fallback
      let left = 0;
      let top = 0;

      try {
        // Try to get screen dimensions from system.display API (requires system.display permission)
        if (chrome.system?.display?.getInfo) {
          const displays = await chrome.system.display.getInfo();
          // Use primary display, or the first one found
          const primaryDisplay = displays.find(d => d.isPrimary) || displays[0];

          if (primaryDisplay?.workArea) {
            screenWidth = primaryDisplay.workArea.width;
            screenHeight = primaryDisplay.workArea.height;
            left = primaryDisplay.workArea.left;
            top = primaryDisplay.workArea.top;
          } else if (primaryDisplay?.bounds) {
            // Fallback to bounds if workArea not available
            screenWidth = primaryDisplay.bounds.width;
            screenHeight = primaryDisplay.bounds.height;
            left = primaryDisplay.bounds.left;
            top = primaryDisplay.bounds.top;
          }
        } else {
          // Fallback: Use current window to estimate screen size
          const currentWindow = await chrome.windows.getCurrent();
          if (currentWindow?.width && currentWindow?.height) {
            // Estimate: assume window is maximized or near-maximized
            screenWidth = Math.max(currentWindow.width + 100, 1200);
            screenHeight = Math.max(currentWindow.height + 100, 800);
          }
        }
      } catch (e) {
        console.warn('Could not get screen dimensions, using defaults:', e);
      }

      // 4. Calculate window dimensions: 1/3 screen width, full height, left-justified
      const windowWidth = Math.floor(screenWidth / 3);
      const windowHeight = screenHeight;

      // 5. Create the Detached Window
      const newWindow = await chrome.windows.create({
        url: appUrl,
        type: 'popup', // 'popup' removes address bar/tabs strip (App Style)
        width: windowWidth,
        height: windowHeight,
        left: left,
        top: top,
        focused: true,
      });

      // 6. Store the window ID
      if (newWindow && newWindow.id !== undefined) {
        const windowId = newWindow.id;
        await chrome.storage.session.set({ [CURATIO_WINDOW_KEY]: windowId });

        // Clean up stored window ID when window is closed
        const cleanupListener = (closedWindowId: number) => {
          if (closedWindowId === windowId) {
            chrome.storage.session.remove(CURATIO_WINDOW_KEY).catch(console.error);
            chrome.windows.onRemoved.removeListener(cleanupListener);
          }
        };
        chrome.windows.onRemoved.addListener(cleanupListener);
      }
    } catch (error) {
      console.error('Failed to open Curatio window:', error);
    }
  });

  // Listen for save requests from popup
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SAVE_STATE') {
      captureStore.items = message.data.items;
      captureStore.rootSessionId = message.data.rootSessionId;
      captureStore.activeChromeMap = message.data.activeChromeMap;
      captureStore.save().then(() => {
        sendResponse({ success: true });
      }).catch((err) => {
        sendResponse({ success: false, error: err });
      });
      return true; // Keep channel open for async response
    }
  });
});
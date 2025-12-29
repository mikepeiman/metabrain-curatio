import { captureStore } from '@/composables/useCapture.svelte';

export default defineBackground(() => {
  captureStore.init(true).catch(console.error);

  // Store the Curatio window ID in session storage
  const CURATIO_WINDOW_KEY = 'curatio_window_id';

  // Handle extension icon click - TabsOutliner Style (Detached Window)
  chrome.action.onClicked.addListener(async () => {
    try {
      // Check if Curatio window already exists
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

      // Create new Curatio window
      // WXT generates popup entrypoint as popup.html
      const popupUrl = chrome.runtime.getURL('popup.html');
      const newWindow = await chrome.windows.create({
        url: popupUrl,
        type: 'popup',
        width: 400,
        height: 800,
        focused: true,
      });

      // Store the window ID
      if (newWindow && newWindow.id !== undefined) {
        const windowId = newWindow.id;
        await chrome.storage.session.set({ [CURATIO_WINDOW_KEY]: windowId });

        // Clean up stored window ID when window is closed
        chrome.windows.onRemoved.addListener((closedWindowId) => {
          if (closedWindowId === windowId) {
            chrome.storage.session.remove(CURATIO_WINDOW_KEY).catch(console.error);
          }
        });
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

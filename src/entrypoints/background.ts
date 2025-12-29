import { captureStore } from '@/composables/useCapture.svelte';

export default defineBackground(() => {
  captureStore.init(true).catch(console.error);

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

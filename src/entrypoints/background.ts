import { captureStore } from '@/composables/useCapture.svelte';

export default defineBackground(() => {
  captureStore.init(true).catch(console.error);
});

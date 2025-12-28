import { captureStore } from '@/composables/useCapture.svelte';

export default defineBackground(() => {
  captureStore.init().catch(console.error);
});

import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    permissions: ['storage', 'tabs', 'activeTab'], // Added 'storage'
    // ... any other existing settings
  },
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
});

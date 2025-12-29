import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    permissions: ['storage', 'tabs', 'windows', 'activeTab'],
    // No default_popup - extension icon triggers background event
  },
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
});

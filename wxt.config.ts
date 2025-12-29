import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    permissions: ['storage', 'tabs', 'windows', 'unlimitedStorage', 'system.display'],
    // CRITICAL: No default_popup - extension icon triggers background event
    // Explicitly set action to empty object to ensure onClicked fires
    action: {},
    name: "Metabrain Curatio",
  },
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
});

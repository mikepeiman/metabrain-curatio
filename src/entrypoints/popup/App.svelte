<script lang="ts">
  import { captureStore } from "../../composables/useCapture.svelte";
  import {
    DEFINITIONS,
    type UUID,
    type BrowserWindowPayload,
    type BrowserTabPayload,
    type SavedSessionPayload,
  } from "../../types";

  // Initialize store on mount (popup is read-only)
  $effect(() => {
    captureStore.init(false).catch(console.error);
  });

  const windows = $derived(
    (
      captureStore.items[captureStore.rootSessionId]
        ?.data as SavedSessionPayload
    )?.windows
      .map((id) => captureStore.items[id])
      .filter((item) => item?.definitionId === DEFINITIONS.BROWSER_WINDOW) ||
      [],
  );

  function getTabs(windowId: UUID) {
    const windowItem = captureStore.items[windowId];
    if (!windowItem) return [];
    return (
      (windowItem.data as BrowserWindowPayload).tabs
        .map((id) => captureStore.items[id])
        .filter((item) => item?.definitionId === DEFINITIONS.BROWSER_TAB) || []
    );
  }
</script>

<main
  class="min-h-screen bg-neutral-900 text-neutral-100 p-3 font-sans selection:bg-indigo-500/30">
  <header
    class="mb-5 border-b border-neutral-800 pb-3 flex justify-between items-end">
    <div>
      <h1 class="text-xl font-bold tracking-tight text-white">
        Metabrain Debug
      </h1>
      <p class="text-[10px] text-neutral-500 font-mono mt-0.5">
        ID: {captureStore.rootSessionId}
      </p>
    </div>
    <div
      class="text-[10px] text-neutral-500 bg-neutral-800 px-2 py-1 rounded border border-neutral-700">
      v0.1.0-alpha
    </div>
  </header>

  <div class="space-y-4">
    {#each windows as windowItem (windowItem.id)}
      <section
        class="bg-neutral-800/40 border border-neutral-700/50 rounded overflow-hidden shadow-lg">
        <div
          class="px-3 py-1.5 bg-neutral-800/80 border-b border-neutral-700/50 flex items-center justify-between">
          <h2
            class="text-[10px] font-bold text-neutral-400 uppercase tracking-widest flex items-center gap-2">
            <span
              class="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"
            ></span>
            {(windowItem.data as BrowserWindowPayload).name}
          </h2>
          <span class="text-[9px] text-neutral-600 font-mono tabular-nums"
            >{windowItem.id}</span>
        </div>

        <ul class="divide-y divide-neutral-700/20">
          {#each getTabs(windowItem.id) as tabItem (tabItem.id)}
            {@const payload = tabItem.data as BrowserTabPayload}
            <li class="px-3 py-2.5 hover:bg-white/5 transition-colors group">
              <div class="flex items-start gap-2.5">
                {#if payload.favIconUrl}
                  <img
                    src={payload.favIconUrl}
                    alt=""
                    class="w-3.5 h-3.5 mt-0.5 flex-shrink-0 grayscale group-hover:grayscale-0 transition-all opacity-70 group-hover:opacity-100" />
                {:else}
                  <div
                    class="w-3.5 h-3.5 mt-0.5 bg-neutral-700 rounded-sm flex-shrink-0 opacity-50">
                  </div>
                {/if}

                <div class="min-w-0 flex-1">
                  <div
                    class="text-xs font-medium truncate text-neutral-300 group-hover:text-white transition-colors leading-normal">
                    {payload.title || "Untitled Tab"}
                  </div>
                  <div
                    class="text-[10px] text-neutral-500 truncate mt-0.5 group-hover:text-indigo-400/80 transition-colors">
                    {payload.url}
                  </div>
                  <div
                    class="text-[8px] text-neutral-700 font-mono mt-1 opacity-0 group-hover:opacity-100 transition-opacity flex justify-between">
                    <span>UUID: {tabItem.id}</span>
                    <span class="text-neutral-800"
                      >Captured: {new Date(
                        tabItem.createdAt,
                      ).toLocaleTimeString()}</span>
                  </div>
                </div>
              </div>
            </li>
          {:else}
            <li
              class="px-3 py-6 text-center text-neutral-600 italic text-[11px]">
              No active tabs in this window
            </li>
          {/each}
        </ul>
      </section>
    {:else}
      <div
        class="flex flex-col items-center justify-center py-16 text-neutral-600">
        <div
          class="w-12 h-12 mb-4 rounded-full border-2 border-dashed border-neutral-800 flex items-center justify-center opacity-50">
          <span class="text-lg">?</span>
        </div>
        <div class="text-sm font-medium">No windows detected</div>
        <p class="text-[11px] mt-1 opacity-60">
          Wait for the background script to sync...
        </p>
      </div>
    {/each}
  </div>

  <footer class="mt-8 pt-4 border-t border-neutral-800 text-center">
    <button
      class="text-[10px] text-neutral-500 hover:text-neutral-300 transition-colors uppercase tracking-widest font-bold"
      onclick={() => chrome.runtime.reload()}>
      Restart Extension
    </button>
  </footer>
</main>

<style>
  :global(body) {
    background-color: #0a0a0a;
  }

  /* Custom scrollbar for a cleaner dark look */
  ::-webkit-scrollbar {
    width: 6px;
  }
  ::-webkit-scrollbar-track {
    background-color: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background-color: #262626;
    border-radius: 9999px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background-color: #404040;
  }
</style>

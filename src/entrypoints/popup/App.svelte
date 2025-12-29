<script lang="ts">
  import { captureStore } from "../../composables/useCapture.svelte";
  import NodeComponent from "./Node.svelte";
  import {
    DEFINITIONS,
    type UUID,
    type SavedSessionPayload,
  } from "../../types";

  // Initialize store on mount (popup is read-only)
  $effect(() => {
    captureStore.init(false).catch(console.error);
  });

  const rootSession = $derived(captureStore.items[captureStore.rootSessionId]);

  const rootChildren = $derived(
    rootSession ? captureStore.getChildren(captureStore.rootSessionId) : [],
  );

  function handleKeydown(e: KeyboardEvent) {
    const focusedId = captureStore.focusedNodeId;

    // Handle Ctrl/Cmd + Arrow keys for structure manipulation
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        if (focusedId) {
          captureStore.moveNode(focusedId, "up");
        }
        return;
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        if (focusedId) {
          captureStore.moveNode(focusedId, "down");
        }
        return;
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        if (focusedId) {
          captureStore.outdentNode(focusedId);
        }
        return;
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        if (focusedId) {
          captureStore.indentNode(focusedId);
        }
        return;
      }
    }

    // Handle plain Arrow keys for focus navigation
    if (e.key === "ArrowDown") {
      e.preventDefault();
      captureStore.navigateFocus("down");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      captureStore.navigateFocus("up");
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="min-h-screen bg-neutral-900 text-neutral-100 p-4 font-sans selection:bg-indigo-500/30"
  onkeydown={handleKeydown}
  tabindex="0"
  role="application">
  <header
    class="mb-4 border-b border-neutral-800 pb-3 flex justify-between items-end">
    <div>
      <h1 class="text-xl font-bold tracking-tight text-white">
        Metabrain Curatio
      </h1>
      <p class="text-[10px] text-neutral-500 font-mono mt-0.5">
        Workflowy-Style Outliner
      </p>
    </div>
  </header>

  <div class="outline-tree">
    {#if rootSession}
      {#each rootChildren as childId (childId)}
        <NodeComponent id={childId} depth={0} />
      {/each}
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
    {/if}
  </div>
</div>

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

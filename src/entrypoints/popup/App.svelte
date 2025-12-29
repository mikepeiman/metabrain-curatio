<script lang="ts">
  import { dndzone } from "svelte-dnd-action";
  import { captureStore } from "../../composables/useCapture.svelte";
  import NodeComponent from "./Node.svelte";
  import {
    DEFINITIONS,
    type UUID,
    type SavedSessionPayload,
  } from "../../types";

  $effect(() => {
    captureStore.init(false).catch(console.error);
  });

  const rootSession = $derived(captureStore.items[captureStore.rootSessionId]);
  const rootChildren = $derived(
    rootSession ? captureStore.getChildren(captureStore.rootSessionId) : [],
  );

  function toggleShowArchived() {
    captureStore.showArchived = !captureStore.showArchived;
  }

  let containerElement: HTMLDivElement | null = $state(null);

  function handleKeydown(e: KeyboardEvent) {
    const focusedId = captureStore.focusedNodeId;

    if (e.ctrlKey || e.metaKey) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        if (focusedId) {
          captureStore.moveNode(focusedId, "up");
          setTimeout(() => containerElement?.focus(), 0);
        }
        return;
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        if (focusedId) {
          captureStore.moveNode(focusedId, "down");
          setTimeout(() => containerElement?.focus(), 0);
        }
        return;
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        if (focusedId) {
          captureStore.outdentNode(focusedId);
          setTimeout(() => containerElement?.focus(), 0);
        }
        return;
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        if (focusedId) {
          captureStore.indentNode(focusedId);
          setTimeout(() => containerElement?.focus(), 0);
        }
        return;
      }
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      captureStore.navigateFocus("down");
      setTimeout(() => containerElement?.focus(), 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      captureStore.navigateFocus("up");
      setTimeout(() => containerElement?.focus(), 0);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (focusedId && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        captureStore.archiveNode(focusedId);
        setTimeout(() => containerElement?.focus(), 0);
      }
    }
  }

  // Transform UUIDs to objects with id property for dndzone
  const rootDndItems = $derived(
    rootChildren.map((childId) => ({ id: childId })),
  );

  function handleRootConsider(e: CustomEvent) {
    // Optional: Visual feedback
  }

  function handleRootFinalize(e: CustomEvent) {
    if (e.detail.items && rootSession) {
      captureStore.handleSort("ROOT", e.detail.items);
    }
  }

  $effect(() => {
    if (containerElement) {
      containerElement.focus();
    }
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={containerElement}
  class="min-h-screen bg-neutral-900 text-neutral-100 p-4 font-sans selection:bg-indigo-500/30"
  onkeydown={handleKeydown}
  tabindex="0"
  role="application">
  <!-- Minimal Header -->
  <div class="mb-3 flex items-center justify-between">
    <h1 class="text-lg font-semibold text-white">Curatio</h1>
    <label
      class="flex items-center gap-1.5 text-xs text-neutral-400 cursor-pointer">
      <input
        type="checkbox"
        checked={captureStore.showArchived}
        onchange={toggleShowArchived}
        class="w-3 h-3 rounded border-neutral-700 bg-neutral-800 text-indigo-500 focus:ring-indigo-500" />
      <span>Archived</span>
    </label>
  </div>

  <!-- Root List with DnD -->
  <div
    class="min-h-5"
    use:dndzone={{ items: rootDndItems, type: "default" }}
    onconsider={handleRootConsider}
    onfinalize={handleRootFinalize}>
    {#if rootSession}
      {#each rootDndItems as dndItem (dndItem.id)}
        <NodeComponent
          id={dndItem.id}
          depth={0}
          items={captureStore.getChildren(dndItem.id)} />
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

<script lang="ts">
  import { dndzone } from "svelte-dnd-action";
  import { captureStore } from "../../composables/useCapture.svelte";
  import Node from "./Node.svelte";
  import {
    DEFINITIONS,
    type UUID,
    type BrowserTabPayload,
    type BrowserWindowPayload,
  } from "../../types";

  interface Props {
    id: UUID;
    depth?: number;
    items: UUID[]; // Children array for DnD
  }

  let { id, depth = 0, items }: Props = $props();

  const item = $derived(captureStore.items[id]);
  const children = $derived(item ? captureStore.getChildren(id) : []);
  const isFocused = $derived(captureStore.focusedNodeId === id);
  const isSelected = $derived(captureStore.selectedNodeIds.has(id));

  const isActive = $derived.by(() => {
    if (!item) return false;
    if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
      const payload = item.data as BrowserTabPayload;
      return payload.isOpen === true && payload.chromeId !== undefined;
    } else if (item.definitionId === DEFINITIONS.BROWSER_WINDOW) {
      const payload = item.data as BrowserWindowPayload;
      return payload.isOpen === true && payload.chromeId !== undefined;
    }
    return true;
  });

  const displayName = $derived.by(() => {
    if (!item) return "";
    if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
      const payload = item.data as BrowserTabPayload;
      return payload.title || payload.url || "Untitled Tab";
    } else if (item.definitionId === DEFINITIONS.BROWSER_WINDOW) {
      const payload = item.data as BrowserWindowPayload;
      return payload.name || "Window";
    } else {
      return (item.data as any).name || "Session";
    }
  });

  const favIconUrl = $derived.by(() => {
    if (item?.definitionId === DEFINITIONS.BROWSER_TAB) {
      return (item.data as BrowserTabPayload).favIconUrl;
    }
    return undefined;
  });

  let isCollapsed = $state(false);
  let isEditingTitle = $state(false);
  let editValue = $state("");

  function handleBulletClick(e: MouseEvent) {
    e.stopPropagation();
    if (children.length > 0) {
      isCollapsed = !isCollapsed;
    } else {
      captureStore.setFocus(id);
    }
  }

  function handleContentClick(e: MouseEvent) {
    e.stopPropagation();
    captureStore.toggleSelectNode(id, e.shiftKey, e.ctrlKey || e.metaKey);
  }

  function handleDoubleClick(e: MouseEvent) {
    e.stopPropagation();

    if (item?.definitionId === DEFINITIONS.BROWSER_TAB) {
      const payload = item.data as BrowserTabPayload;
      if (payload.isOpen && payload.chromeId !== undefined) {
        // Already open, just focus it
        captureStore.focusChromeTab(id);
      } else {
        // Inactive tab - reactivate it
        captureStore.toggleOpen(id);
      }
    } else if (item?.definitionId === DEFINITIONS.BROWSER_WINDOW) {
      const payload = item.data as BrowserWindowPayload;
      if (payload.isOpen && payload.chromeId !== undefined) {
        // Already open, focus it
        captureStore.focusChromeTab(id);
      } else {
        // Inactive window - make title editable or reactivate
        editValue = payload.name || "";
        isEditingTitle = true;
      }
    } else {
      captureStore.toggleOpen(id);
    }
  }

  function handleSleepClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    captureStore.toggleOpen(id);
  }

  function handleTitleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      saveTitle();
    } else if (e.key === "Escape") {
      e.preventDefault();
      isEditingTitle = false;
    }
  }

  function saveTitle() {
    if (item?.definitionId === DEFINITIONS.BROWSER_WINDOW) {
      (item.data as BrowserWindowPayload).name = editValue;
      captureStore.save();
    }
    isEditingTitle = false;
  }

  // Transform UUIDs to objects with id property for dndzone
  const dndItems = $derived(children.map((childId) => ({ id: childId })));

  // DnD handlers
  function handleConsider(e: CustomEvent) {
    // Optional: Visual feedback during drag
  }

  function handleFinalize(e: CustomEvent) {
    if (e.detail.items) {
      captureStore.handleSort(id, e.detail.items);
    }
  }

  $effect(() => {
    if (isEditingTitle && item) {
      setTimeout(() => {
        const input = document.querySelector(
          `input[data-node-id="${id}"]`,
        ) as HTMLInputElement;
        if (input) {
          input.select();
          input.focus();
        }
      }, 0);
    }
  });
</script>

{#if item}
  <div class="flex group relative">
    <!-- Bullet Handle -->
    <button
      onclick={handleBulletClick}
      class="w-5 h-5 flex items-center justify-center shrink-0 mt-0.5 rounded-full hover:bg-neutral-800/50 transition-colors cursor-pointer focus:outline-none focus:ring-1 focus:ring-indigo-500"
      title={children.length > 0
        ? isCollapsed
          ? "Expand"
          : "Collapse"
        : "Focus"}>
      <div
        class="w-1.5 h-1.5 rounded-full bg-neutral-500 group-hover:bg-neutral-400 transition-colors">
      </div>
    </button>

    <!-- Content Row -->
    <div
      class={`flex-1 flex items-center py-0.5 text-[15px] transition-colors select-none cursor-pointer min-h-7
        ${isActive ? "text-white" : "text-neutral-300"}
        ${isFocused ? "bg-indigo-500/20" : "hover:bg-neutral-800/30"}
        ${isSelected ? "bg-blue-500/10" : ""}`}
      onclick={handleContentClick}
      ondblclick={handleDoubleClick}
      role="treeitem"
      aria-selected={isFocused}>
      <!-- Favicon/Icon -->
      <div class="w-4 h-4 shrink-0 mr-2 flex items-center justify-center">
        {#if favIconUrl}
          <img
            src={favIconUrl}
            alt=""
            class={`w-4 h-4 ${!isActive ? "grayscale opacity-50" : ""}`} />
        {:else if item.definitionId === DEFINITIONS.BROWSER_TAB}
          <div
            class={`w-3 h-3 bg-neutral-600 rounded-sm ${!isActive ? "opacity-30" : ""}`}>
          </div>
        {:else if item.definitionId === DEFINITIONS.BROWSER_WINDOW}
          <span class={`text-xs ${!isActive ? "opacity-50" : ""}`}>⊞</span>
        {/if}
      </div>

      <!-- Text or Input -->
      {#if isEditingTitle && item.definitionId === DEFINITIONS.BROWSER_WINDOW}
        <input
          data-node-id={id}
          type="text"
          bind:value={editValue}
          onkeydown={handleTitleKeydown}
          onblur={saveTitle}
          class="bg-neutral-800 text-white px-1 py-0 rounded border border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 flex-1 min-w-0"
          autofocus />
      {:else}
        <span class="truncate">{displayName}</span>
      {/if}

      <!-- Sleep Button -->
      {#if isActive && (item.definitionId === DEFINITIONS.BROWSER_TAB || item.definitionId === DEFINITIONS.BROWSER_WINDOW)}
        <button
          onclick={handleSleepClick}
          class="ml-auto mr-2 w-4 h-4 flex items-center justify-center text-neutral-400 hover:text-neutral-200 transition-colors opacity-0 group-hover:opacity-100"
          title="Sleep (deactivate)">
          <svg
            class="w-3 h-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
        </button>
      {/if}
    </div>
  </div>

  <!-- Children Container with Guide Line and DnD -->
  {#if children.length > 0 && !isCollapsed}
    <div
      class="ml-5 border-l border-neutral-800 min-h-5"
      use:dndzone={{ items: dndItems, type: "default" }}
      onconsider={handleConsider}
      onfinalize={handleFinalize}>
      {#each dndItems as dndItem (dndItem.id)}
        <Node
          id={dndItem.id}
          depth={depth + 1}
          items={captureStore.getChildren(dndItem.id)} />
      {/each}
    </div>
  {/if}
{/if}

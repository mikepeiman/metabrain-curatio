<script lang="ts">
  import { captureStore } from "../../composables/useCapture.svelte";
  import {
    DEFINITIONS,
    type UUID,
    type BrowserTabPayload,
    type BrowserWindowPayload,
  } from "../../types";

  interface Props {
    id: UUID;
    depth?: number;
  }

  let { id, depth = 0 }: Props = $props();

  const item = $derived(captureStore.items[id]);
  const children = $derived(item ? captureStore.getChildren(id) : []);
  const isFocused = $derived(captureStore.focusedNodeId === id);

  const isActive = $derived.by(() => {
    if (!item) return false;
    if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
      return (item.data as BrowserTabPayload).isOpen === true;
    } else if (item.definitionId === DEFINITIONS.BROWSER_WINDOW) {
      return (item.data as BrowserWindowPayload).isOpen === true;
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

  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    captureStore.setFocus(id);
  }

  function handleDoubleClick(e: MouseEvent) {
    e.stopPropagation();
    captureStore.toggleOpen(id);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!isFocused) return;

    // Stop propagation so parents don't handle this too
    e.stopPropagation();

    if (e.ctrlKey || e.metaKey) {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        captureStore.indentNode(id);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        captureStore.outdentNode(id);
      }
    }
  }

  // Template literal for safe class construction
  const nodeClasses = $derived(
    `flex items-center py-0.5 text-base transition-colors outline-none select-none cursor-pointer
       ${isActive ? "text-neutral-100" : "text-neutral-500"} 
       ${isFocused ? "bg-indigo-500/20 border-l-2 border-indigo-500 pl-[calc(1.5rem-2px)]" : "border-l-2 border-transparent hover:bg-neutral-800/50"}`,
  );
</script>

{#if item}
  <div
    class={nodeClasses}
    style={!isFocused
      ? `padding-left: ${depth * 1.5}rem;`
      : `padding-left: ${depth * 1.5}rem;`}
    onclick={handleClick}
    ondblclick={handleDoubleClick}
    onkeydown={handleKeydown}
    tabindex="0"
    role="treeitem"
    aria-selected={isFocused}>
    <div class="flex items-center gap-2 min-w-0 flex-1">
      <!-- Icon Container -->
      <div class="w-4 h-4 shrink-0 flex items-center justify-center">
        {#if favIconUrl}
          <img
            src={favIconUrl}
            alt=""
            class={`w-4 h-4 ${!isActive ? "grayscale opacity-50" : ""}`} />
        {:else if item.definitionId === DEFINITIONS.BROWSER_TAB}
          <div
            class={`w-3 h-3 bg-neutral-700 rounded-sm ${!isActive ? "opacity-30" : ""}`}>
          </div>
        {:else if item.definitionId === DEFINITIONS.BROWSER_WINDOW}
          <span class={`text-xs ${!isActive ? "opacity-50" : ""}`}>⊞</span>
        {/if}
      </div>

      <!-- Text -->
      <span class="truncate">{displayName}</span>

      <!-- Ghost Label -->
      {#if !isActive}
        <span
          class="text-[9px] text-neutral-600 ml-auto shrink-0 uppercase tracking-wider font-bold pr-2"
          >Ghost</span>
      {/if}
    </div>
  </div>

  <!-- Recursive Children -->
  {#if children.length > 0}
    <div>
      {#each children as childId (childId)}
        <svelte:self id={childId} depth={depth + 1} />
      {/each}
    </div>
  {/if}
{/if}

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

  let isEditingTitle = $state(false);
  let editValue = $state("");

  function handleDoubleClick(e: MouseEvent) {
    e.stopPropagation();

    if (item?.definitionId === DEFINITIONS.BROWSER_TAB) {
      const payload = item.data as BrowserTabPayload;
      // If tab is open, focus it in Chrome
      if (payload.isOpen && payload.chromeId !== undefined) {
        captureStore.focusChromeTab(id);
      } else {
        // Otherwise toggle open/closed
        captureStore.toggleOpen(id);
      }
    } else if (item?.definitionId === DEFINITIONS.BROWSER_WINDOW) {
      const payload = item.data as BrowserWindowPayload;
      // If window is open, focus it; otherwise make title editable
      if (payload.isOpen && payload.chromeId !== undefined) {
        captureStore.focusChromeTab(id);
      } else {
        // Make window title editable
        editValue = payload.name || "";
        isEditingTitle = true;
      }
    } else {
      captureStore.toggleOpen(id);
    }
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

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // TODO: Show context menu
    showContextMenu(e.clientX, e.clientY);
  }

  let contextMenuVisible = $state(false);
  let contextMenuX = $state(0);
  let contextMenuY = $state(0);

  function showContextMenu(x: number, y: number) {
    contextMenuX = x;
    contextMenuY = y;
    contextMenuVisible = true;
  }

  function hideContextMenu() {
    contextMenuVisible = false;
  }

  function handleDelete() {
    captureStore.archiveNode(id);
    hideContextMenu();
  }

  function handleKeydown(e: KeyboardEvent) {
    // Only handle keyboard events when this node is focused
    if (!isFocused) return;

    // Handle Ctrl/Cmd + Arrow keys for indent/outdent
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        captureStore.indentNode(id);
        return;
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        captureStore.outdentNode(id);
        return;
      }
    }

    // For other keys, let the parent handle them (for focus navigation)
    // Don't stop propagation for plain arrow keys
  }

  // Check if this is the currently active Chrome window/tab
  const isChromeFocused = $derived.by(() => {
    if (!item) return false;
    if (item.definitionId === DEFINITIONS.BROWSER_TAB) {
      const payload = item.data as BrowserTabPayload;
      // TODO: Check if this is the active Chrome tab
      return payload.isOpen === true;
    } else if (item.definitionId === DEFINITIONS.BROWSER_WINDOW) {
      const payload = item.data as BrowserWindowPayload;
      // TODO: Check if this is the active Chrome window
      return payload.isOpen === true;
    }
    return false;
  });

  // Template literal for safe class construction
  const nodeClasses = $derived(
    `flex items-center py-0.5 text-base transition-colors outline-none select-none cursor-pointer relative
       ${isActive ? "text-neutral-100" : "text-neutral-500"} 
       ${isFocused ? "bg-indigo-500/20 border-l-2 border-indigo-500" : "border-l-2 border-transparent hover:bg-neutral-800/50"}
       ${isChromeFocused ? "ring-1 ring-blue-400/50" : ""}`,
  );

  // Generate indentation guide lines
  const indentGuides = $derived.by(() => {
    const guides: number[] = [];
    for (let i = 0; i < depth; i++) {
      guides.push(i);
    }
    return guides;
  });

  $effect(() => {
    if (isEditingTitle && item) {
      // Select all text when editing starts
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

  // Close context menu when clicking outside
  $effect(() => {
    if (contextMenuVisible) {
      function handleClickOutside(e: MouseEvent) {
        const target = e.target as HTMLElement;
        if (!target.closest("[data-context-menu]")) {
          hideContextMenu();
        }
      }
      document.addEventListener("click", handleClickOutside);
      return () => document.removeEventListener("click", handleClickOutside);
    }
  });
</script>

{#if item}
  <div
    class={nodeClasses}
    style={`padding-left: ${depth * 1.5}rem;`}
    onclick={handleClick}
    ondblclick={handleDoubleClick}
    onkeydown={handleKeydown}
    oncontextmenu={handleContextMenu}
    tabindex="0"
    role="treeitem"
    aria-selected={isFocused}>
    <!-- Indentation Guide Lines -->
    {#each indentGuides as guideDepth}
      <div
        class="absolute left-0 top-0 bottom-0 w-px bg-neutral-800/30"
        style={`left: ${guideDepth * 1.5}rem;`}>
      </div>
    {/each}

    <div class="flex items-center gap-2 min-w-0 flex-1 relative z-10">
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

      <!-- Text or Editable Input -->
      {#if isEditingTitle && item.definitionId === DEFINITIONS.BROWSER_WINDOW}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          data-node-id={id}
          type="text"
          bind:value={editValue}
          onkeydown={handleTitleKeydown}
          onblur={saveTitle}
          class="bg-neutral-800 text-neutral-100 px-1 py-0 rounded border border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 flex-1 min-w-0"
          autofocus />
      {:else}
        <span class="truncate">{displayName}</span>
      {/if}

      <!-- Ghost Label -->
      {#if !isActive}
        <span
          class="text-[9px] text-neutral-600 ml-auto shrink-0 uppercase tracking-wider font-bold pr-2"
          >Ghost</span>
      {/if}
    </div>
  </div>

  <!-- Context Menu -->
  {#if contextMenuVisible}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      data-context-menu
      class="fixed bg-neutral-800 border border-neutral-700 rounded shadow-lg py-1 z-50 min-w-37.5"
      style={`left: ${contextMenuX}px; top: ${contextMenuY}px;`}
      role="menu"
      tabindex="0"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => {
        if (e.key === "Escape") hideContextMenu();
      }}>
      <button
        class="w-full text-left px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 transition-colors"
        onclick={handleDelete}>
        Archive
      </button>
      <button
        class="w-full text-left px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 transition-colors"
        onclick={() => {
          captureStore.indentNode(id);
          hideContextMenu();
        }}>
        Indent (Ctrl+→)
      </button>
      <button
        class="w-full text-left px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 transition-colors"
        onclick={() => {
          captureStore.outdentNode(id);
          hideContextMenu();
        }}>
        Outdent (Ctrl+←)
      </button>
      <button
        class="w-full text-left px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 transition-colors"
        onclick={() => {
          captureStore.moveNode(id, "up");
          hideContextMenu();
        }}>
        Move Up (Ctrl+↑)
      </button>
      <button
        class="w-full text-left px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 transition-colors"
        onclick={() => {
          captureStore.moveNode(id, "down");
          hideContextMenu();
        }}>
        Move Down (Ctrl+↓)
      </button>
    </div>
  {/if}

  <!-- Recursive Children -->
  {#if children.length > 0}
    <div>
      {#each children as childId (childId)}
        <svelte:self id={childId} depth={depth + 1} />
      {/each}
    </div>
  {/if}
{/if}

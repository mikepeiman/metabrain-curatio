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
  const isSelected = $derived(captureStore.selectedNodeIds.has(id));

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
    captureStore.toggleSelectNode(id, e.shiftKey, e.ctrlKey || e.metaKey);
  }

  let isEditingTitle = $state(false);
  let editValue = $state("");

  function handleDoubleClick(e: MouseEvent) {
    e.stopPropagation();

    if (item?.definitionId === DEFINITIONS.BROWSER_TAB) {
      const payload = item.data as BrowserTabPayload;
      // If tab is open and active, focus it in Chrome
      if (payload.isOpen && payload.chromeId !== undefined) {
        captureStore.focusChromeTab(id);
      } else if (payload.url) {
        // Check if tab already exists before creating
        const existingTabId = captureStore.findTabByUrl(payload.url);
        if (existingTabId && existingTabId !== id) {
          captureStore.focusChromeTab(existingTabId);
        } else {
          captureStore.toggleOpen(id);
        }
      }
    } else if (item?.definitionId === DEFINITIONS.BROWSER_WINDOW) {
      const payload = item.data as BrowserWindowPayload;
      // Always make window title editable on double-click
      editValue = payload.name || "";
      isEditingTitle = true;
    } else {
      captureStore.toggleOpen(id);
    }
  }

  function handleSleepClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    // Use toggleOpen to sleep the item (will close Chrome tab/window)
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
       ${isSelected ? "bg-blue-500/10" : ""}
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

  let nodeElement: HTMLDivElement | null = $state(null);

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
    bind:this={nodeElement}
    class={nodeClasses}
    style={`padding-left: ${depth * 1.5}rem;`}
    onclick={handleClick}
    ondblclick={handleDoubleClick}
    oncontextmenu={handleContextMenu}
    role="treeitem"
    aria-selected={isFocused}>
    <!-- Indentation Guide Lines -->
    {#each indentGuides as guideDepth}
      <div
        class="absolute left-0 top-0 bottom-0 w-px bg-neutral-800/30"
        style={`left: ${guideDepth * 1.5}rem;`}>
      </div>
    {/each}

    <div class="flex items-center gap-2 min-w-0 flex-1 relative z-10 group">
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

      <!-- Inactive Label and Sleep Button -->
      <div class="ml-auto shrink-0 flex items-center gap-2 pr-2">
        {#if !isActive}
          <span
            class="text-[9px] text-neutral-600 uppercase tracking-wider font-bold"
            >Inactive</span>
        {/if}
        {#if isActive && (item.definitionId === DEFINITIONS.BROWSER_TAB || item.definitionId === DEFINITIONS.BROWSER_WINDOW)}
          <button
            onclick={handleSleepClick}
            class="w-4 h-4 flex items-center justify-center text-neutral-400 hover:text-neutral-200 transition-colors opacity-0 group-hover:opacity-100"
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

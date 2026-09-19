<script lang="ts">
  // Minimal fixed-position context menu (T3-style row actions, no library).
  import { onMount } from "svelte";
  import { extDialog } from "../lib/stores";

  export interface MenuItem {
    label: string;
    danger?: boolean;
    disabled?: boolean;
    action: () => void;
  }

  let {
    x,
    y,
    items,
    onclose,
  }: {
    x: number;
    y: number;
    items: MenuItem[];
    onclose: () => void;
  } = $props();

  let el: HTMLDivElement | null = $state(null);
  let adjusted = $state<{ x: number; y: number } | null>(null);
  // Props read inside $derived (initial position) with an onMount adjustment.
  let pos = $derived(adjusted ?? { x, y });

  onMount(() => {
    // Keep the menu inside the window.
    const w = el?.offsetWidth ?? 200;
    const h = el?.offsetHeight ?? 120;
    adjusted = {
      x: Math.min(x, window.innerWidth - w - 8),
      y: Math.min(y, window.innerHeight - h - 8),
    };
    const onDown = (e: MouseEvent) => {
      if (el && !el.contains(e.target as Node)) onclose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // An extension dialog arriving while the menu is open is topmost (z-200)
      // and registered later — its Esc wins; the menu stands down.
      if ($extDialog) return;
      if (e.key !== "Escape") return;
      e.preventDefault();
      onclose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  });

  function run(item: MenuItem) {
    if (item.disabled) return;
    onclose();
    item.action();
  }
</script>

<div class="menu" bind:this={el} style="left: {pos.x}px; top: {pos.y}px" role="menu">
  {#each items as item (item.label)}
    <button
      class="item"
      class:danger={item.danger}
      disabled={item.disabled}
      role="menuitem"
      onclick={() => run(item)}
    >
      {item.label}
    </button>
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 100;
    min-width: 168px;
    padding: 4px;
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
  }
  .item {
    text-align: left;
    font-size: 12.5px;
    padding: 6px 10px;
    border: none;
    background: transparent;
    color: var(--text-2);
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
  }
  .item:hover {
    background: var(--bg-surface-2);
    color: var(--text);
  }
  .item.danger {
    color: var(--danger);
  }
  .item:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .item:disabled:hover {
    background: transparent;
  }
</style>

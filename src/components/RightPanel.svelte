<script lang="ts">
  // Right panel: a resizable column beside the chat hosting tool cards
  // (Status, Artifacts — terminal later). Mirrors the left sidebar's
  // drag-to-resize handle with the drag direction flipped.
  import { Images, ListTodo, X } from "@lucide/svelte";
  import { rightPanelOpen, rightPanelTab, rightPanelWidth } from "../lib/stores";
  import StatusCard from "./StatusCard.svelte";
  import Artifacts from "./Artifacts.svelte";

  let startX = 0;
  let startWidth = 0;

  function startResize(e: MouseEvent) {
    startX = e.clientX;
    startWidth = $rightPanelWidth;
    const onMove = (ev: MouseEvent) => {
      // Panel sits on the right: dragging the handle left widens it.
      const max = Math.max(320, window.innerWidth - 640);
      rightPanelWidth.set(Math.min(max, Math.max(320, startWidth - (ev.clientX - startX))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
</script>

<aside style="width: {$rightPanelWidth}px">
  <button type="button" class="resize-handle" onmousedown={startResize} aria-label="Resize right panel"></button>
  <div class="panel-head">
    <button class="ptab" class:active={$rightPanelTab === "status"} onclick={() => rightPanelTab.set("status")}>
      <ListTodo size={13} strokeWidth={2} /> Status
    </button>
    <button class="ptab" class:active={$rightPanelTab === "artifacts"} onclick={() => rightPanelTab.set("artifacts")}>
      <Images size={13} strokeWidth={2} /> Artifacts
    </button>
    <span class="spacer"></span>
    <button class="ghost icon" title="Close panel" onclick={() => rightPanelOpen.set(false)}>
      <X size={14} strokeWidth={2} />
    </button>
  </div>
  <div class="panel-body">
    {#if $rightPanelTab === "status"}
      <StatusCard />
    {:else}
      <Artifacts />
    {/if}
  </div>
</aside>

<style>
  aside {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--bg-surface);
    min-width: 320px;
  }
  .resize-handle {
    position: absolute;
    left: -3px;
    top: 0;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    border: none;
    background: transparent;
    padding: 0;
    z-index: 5;
  }
  .resize-handle:hover { background: color-mix(in srgb, var(--accent) 35%, transparent); }
  .panel-head {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 10px 0;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .ptab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 12px;
    color: var(--text-2);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
  }
  .ptab:hover { color: var(--text); }
  .ptab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
  .spacer { flex: 1; }
  .ghost.icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 5px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    cursor: pointer;
  }
  .ghost.icon:hover { background: var(--bg-surface-2); }
  .panel-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
</style>

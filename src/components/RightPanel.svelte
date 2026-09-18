<script lang="ts">
  // Right panel: a resizable, floating card beside the chat hosting tool
  // cards (Status, Artifacts — plus placeholder docks: Diff, Browser,
  // Terminal, Files). Tab switching lives in the title bar; the card just
  // shows the active view, its own scrollbar, and a close button. Mirrors
  // the left sidebar's drag-to-resize handle with the direction flipped.
  import { X } from "@lucide/svelte";
  import { rightPanelOpen, rightPanelTab, rightPanelWidth, type RightPanelTab } from "../lib/stores";
  import StatusCard from "./StatusCard.svelte";
  import Artifacts from "./Artifacts.svelte";
  import DiffPanel from "./DiffPanel.svelte";
  import FilesPanel from "./FilesPanel.svelte";

  const TAB_LABELS: Record<RightPanelTab, string> = {
    status: "Status",
    subagents: "Subagents",
    artifacts: "Artifacts",
    diff: "Diff",
    browser: "Browser",
    terminal: "Terminal",
    files: "Files",
  };

  function startResize(e: PointerEvent) {
    // setPointerCapture keeps move/up events flowing to the handle even when
    // the cursor leaves the window, and pointercancel covers alt-tab / touch
    // interruption. The listeners live on the handle itself and die with it,
    // so a mid-drag unmount can no longer leak a live handler that kept
    // resizing on hover (the old window mousemove/mouseup pair did).
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = $rightPanelWidth;
    const onMove = (ev: PointerEvent) => {
      // Panel sits on the right: dragging the handle left widens it.
      const max = Math.max(320, window.innerWidth - 640);
      rightPanelWidth.set(Math.min(max, Math.max(320, startWidth - (ev.clientX - startX))));
    };
    const stop = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }
</script>

<aside style="width: {$rightPanelWidth}px">
  <button type="button" class="resize-handle" onpointerdown={startResize} aria-label="Resize right panel"></button>
  <div class="panel-head">
    <span class="panel-title">{TAB_LABELS[$rightPanelTab]}</span>
    <span class="spacer"></span>
    <button class="ghost icon" title="Close panel" onclick={() => rightPanelOpen.set(false)}>
      <X size={14} strokeWidth={2} />
    </button>
  </div>
  <div class="panel-body">
    {#if $rightPanelTab === "status"}
      <StatusCard />
    {:else if $rightPanelTab === "artifacts"}
      <Artifacts />
    {:else if $rightPanelTab === "diff"}
      <DiffPanel />
    {:else if $rightPanelTab === "files"}
      <FilesPanel />
    {:else}
      <div class="placeholder">
        <span class="ph-title">{TAB_LABELS[$rightPanelTab]} view</span>
        <span class="ph-hint">Coming soon — this dock will grow into a live view.</span>
      </div>
    {/if}
  </div>
</aside>

<style>
  aside {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-width: 320px;
    margin: 10px 10px 10px 4px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-surface);
    box-shadow: var(--shadow);
    overflow: hidden;
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
    padding: 7px 10px 7px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .panel-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
    letter-spacing: 0.2px;
  }
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
  .panel-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .placeholder {
    margin: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 24px;
    text-align: center;
    color: var(--text-3);
  }
  .ph-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
  }
  .ph-hint { font-size: 12px; }
</style>

<script lang="ts">
  // Floating code-viewer card. Opened from the Files tree or the Diff list;
  // one instance, raised with new content per file. Draggable by the header
  // and resizable from the corner; the rect persists in gui state so the
  // card reopens where the user left it (clamped back into the viewport on
  // open in case the window shrank while it was hidden).
  import { X } from "@lucide/svelte";
  import {
    fileCardOpen, fileCardFile, fileCardRect, settingsOpen, extDialog, aboutOpen,
    projectSettingsDir, newProjectOpen, type FileCardRect,
  } from "../lib/stores";
  import { readTextFile, type TextFileContent } from "../lib/api";

  const MIN_W = 360;
  const MIN_H = 260;

  /** Local rect while dragging/resizing; the store only sees committed ends. */
  let dragRect = $state<FileCardRect | null>(null);
  const rect = $derived(dragRect ?? $fileCardRect);

  let loading = $state(false);
  let loadError = $state("");
  let file = $state<TextFileContent | null>(null);
  let loadRevision = 0;

  function clampRect(r: FileCardRect): FileCardRect {
    const w = Math.min(Math.max(r.w, MIN_W), Math.max(MIN_W, window.innerWidth - 24));
    const h = Math.min(Math.max(r.h, MIN_H), Math.max(MIN_H, window.innerHeight - 24));
    return {
      w, h,
      x: Math.min(Math.max(r.x, 8), Math.max(8, window.innerWidth - w - 8)),
      y: Math.min(Math.max(r.y, 8), Math.max(8, window.innerHeight - h - 8)),
    };
  }

  // Re-clamp whenever the card opens (window may have resized while hidden).
  $effect(() => {
    if (!$fileCardOpen) return;
    const fixed = clampRect($fileCardRect);
    if (fixed.x !== $fileCardRect.x || fixed.y !== $fileCardRect.y || fixed.w !== $fileCardRect.w || fixed.h !== $fileCardRect.h) {
      fileCardRect.set(fixed);
    }
  });

  // Load on open / file change; a stale response can never land.
  $effect(() => {
    const target = $fileCardFile;
    if (!$fileCardOpen || !target) return;
    const revision = ++loadRevision;
    loading = true;
    loadError = "";
    file = null;
    readTextFile(target.projectDir, target.path)
      .then((content) => { if (revision === loadRevision) file = content; })
      .catch((e) => { if (revision === loadRevision) loadError = e instanceof Error ? e.message : String(e); })
      .finally(() => { if (revision === loadRevision) loading = false; });
  });

  function close() {
    fileCardOpen.set(false);
  }

  function onKeydown(e: KeyboardEvent) {
    // Esc closes the card only when it is the topmost overlay: stand down for
    // the modals above it (Settings z-100+, About z-150, ExtDialog z-200) so
    // one keypress dismisses exactly one layer.
    if (e.key === "Escape" && $fileCardOpen && !$settingsOpen && !$extDialog && !$aboutOpen && !$projectSettingsDir && !$newProjectOpen) {
      e.preventDefault();
      close();
    }
  }

  /** Shared pointer-capture drag/resize: mutate the local rect live, commit
   * once on release (gui-state writes are per-commit, not per-move). A
   * pointerdown on a header button (the close X) is a click, not a grab —
   * and capturing it would swallow the click — but the resize corner is
   * itself a button, so only the move path bails. */
  function startDrag(e: PointerEvent, mode: "move" | "resize") {
    if (mode === "move" && (e.target as Element | null)?.closest("button")) return;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    const base = { ...rect };
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      dragRect = mode === "move"
        ? clampRect({ ...base, x: base.x + dx, y: base.y + dy })
        : clampRect({ ...base, w: base.w + dx, h: base.h + dy });
    };
    const stop = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      if (dragRect) fileCardRect.set(dragRect);
      dragRect = null;
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  const name = $derived($fileCardFile ? $fileCardFile.path.slice($fileCardFile.path.lastIndexOf("/") + 1) : "");
  const dir = $derived($fileCardFile ? $fileCardFile.path.slice(0, Math.max(0, $fileCardFile.path.lastIndexOf("/"))) : "");
  const gutter = $derived(file ? Array.from({ length: file.content.split("\n").length }, (_, i) => i + 1).join("\n") : "");
</script>

<svelte:window onkeydown={onKeydown} />

{#if $fileCardOpen && $fileCardFile}
  <div
    class="file-card"
    style="left: {rect.x}px; top: {rect.y}px; width: {rect.w}px; height: {rect.h}px"
    role="dialog"
    aria-label={"Code viewer: " + $fileCardFile.path}
  >
    <header class="card-head" role="toolbar" aria-label="Viewer controls" tabindex="-1" onpointerdown={(e) => startDrag(e, "move")}>
      <span class="fname">{name}</span>
      {#if dir}<span class="fdir">{dir}/</span>{/if}
      <span class="spacer"></span>
      {#if file}<span class="fmeta">{file.loc} loc · {file.size} B</span>{/if}
      <button class="ghost icon" title="Close viewer (Esc)" onclick={close}><X size={14} strokeWidth={2} /></button>
    </header>
    <div class="card-body">
      {#if loading}
        <div class="state">Loading…</div>
      {:else if loadError}
        <div class="state error">{loadError}</div>
      {:else if file}
        {#if file.truncated}<div class="truncated">Large file — showing the first 512 KB.</div>{/if}
        <div class="code-scroll">
          <div class="code-row">
            <pre class="gutter">{gutter}</pre>
            <pre class="code">{file.content}</pre>
          </div>
        </div>
      {/if}
    </div>
    <button type="button" class="resize-corner" onpointerdown={(e) => startDrag(e, "resize")} aria-label="Resize viewer"></button>
  </div>
{/if}

<style>
  .file-card {
    position: fixed;
    z-index: 90;
    display: flex;
    flex-direction: column;
    min-width: 360px;
    min-height: 260px;
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    background: var(--bg-surface);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .card-head {
    display: flex; align-items: center; gap: 6px;
    padding: 7px 10px 7px 12px;
    border-bottom: 1px solid var(--border);
    cursor: move;
    user-select: none;
    flex-shrink: 0;
  }
  .fname { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text); }
  .fdir {
    font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  }
  .spacer { flex: 1; }
  .fmeta { font-size: 10.5px; color: var(--text-3); font-family: var(--font-mono); flex-shrink: 0; }
  .ghost.icon {
    display: inline-flex; align-items: center; justify-content: center; padding: 4px;
    background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
    color: var(--text-2); cursor: pointer; flex-shrink: 0;
  }
  .ghost.icon:hover { background: var(--bg-surface-2); }
  .card-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .state { margin: auto; color: var(--text-3); font-size: 12.5px; }
  .state.error { color: var(--danger); padding: 16px; }
  .truncated {
    padding: 4px 12px; font-size: 11px; color: var(--text-3);
    border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .code-scroll { flex: 1; min-height: 0; overflow: auto; background: var(--code-bg); }
  .code-row { display: flex; min-width: max-content; }
  .gutter, .code {
    margin: 0; padding: 8px 0; font-family: var(--font-mono); font-size: 11.5px;
    line-height: 1.5; white-space: pre;
  }
  .gutter {
    position: sticky; left: 0; z-index: 1;
    text-align: right; padding-right: 10px; padding-left: 12px;
    color: var(--text-3); background: var(--code-bg);
    border-right: 1px solid var(--border); user-select: none;
  }
  .code { padding-left: 12px; padding-right: 16px; color: var(--text); }
  .resize-corner {
    position: absolute; right: 0; bottom: 0;
    width: 14px; height: 14px; cursor: nwse-resize;
    border: none; border-left: 1px solid var(--border);
    border-top: 1px solid var(--border);
    background: transparent; padding: 0;
  }
</style>

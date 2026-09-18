<script lang="ts">
  // Working-tree diff vs HEAD, per-file line counts (hover the sidebar's
  // branch chip for the one-line total; this is the full list). Clicking a
  // file opens it in the code-viewer card. Owner-scoped reset like
  // Artifacts: a slow/failed load never shows another project's diff.
  import { projectDir, rightPanelOpen, rightPanelTab, openFileCard, streaming } from "../lib/stores";
  import { gitDiffSummary, type GitDiffFile } from "../lib/api";
  import { RefreshCw } from "@lucide/svelte";

  let loading = $state(false);
  let loadError = $state("");
  let files = $state<GitDiffFile[]>([]);
  let truncated = $state(false);
  let isRepo = $state(false);
  let refreshRevision = 0;
  let lastSeenDir = "";

  async function refresh(dir: string = $projectDir) {
    const revision = ++refreshRevision;
    if (!dir) { files = []; isRepo = false; loadError = ""; loading = false; return; }
    loading = true;
    loadError = "";
    try {
      const summary = await gitDiffSummary(dir);
      if (revision !== refreshRevision || dir !== $projectDir) return;
      files = summary.files;
      truncated = summary.truncated;
      isRepo = summary.repo;
    } catch (e) {
      if (revision !== refreshRevision || dir !== $projectDir) return;
      files = [];
      isRepo = false;
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      if (revision === refreshRevision) loading = false;
    }
  }

  const totalAdded = $derived(files.reduce((n, f) => n + f.added, 0));
  const totalDeleted = $derived(files.reduce((n, f) => n + f.deleted, 0));

  // Refresh when the panel becomes visible, the project changes, and when a
  // running turn settles (streaming flips false) — agent edits change the
  // diff. Only stores are tracked reads; the plain flags below never
  // retrigger, so a clean-tree refresh can't loop.
  let wasStreaming = false;
  let wasOpen = false;
  $effect(() => {
    const dir = $projectDir;
    const open = $rightPanelOpen && $rightPanelTab === "diff";
    const streamingEnded = wasStreaming && !$streaming;
    wasStreaming = $streaming;
    const becameVisible = open && !wasOpen;
    wasOpen = open;
    if (!open) return;
    if (lastSeenDir !== dir) {
      files = [];
      isRepo = false;
      loadError = "";
      truncated = false;
      lastSeenDir = dir;
      void refresh(dir);
      return;
    }
    if (becameVisible || streamingEnded) void refresh(dir);
  });
</script>

<div class="diff-panel">
  {#if !$projectDir}
    <div class="empty">Open a project to see its working-tree diff.</div>
  {:else if loadError}
    <div class="empty error">{loadError}</div>
  {:else if !isRepo && !loading}
    <div class="empty">Not a git repository.</div>
  {:else}
    <div class="diff-head">
      <span class="totals">
        {#if loading && files.length === 0}Loading…{:else}
          <span class="added">+{totalAdded}</span> <span class="deleted">−{totalDeleted}</span>
          <span class="count">across {files.length}{truncated ? "+" : ""} file{files.length === 1 ? "" : "s"}</span>
        {/if}
      </span>
      <span class="spacer"></span>
      <button class="ghost icon" title="Refresh diff" onclick={() => void refresh()}>
        <RefreshCw size={13} strokeWidth={2} />
      </button>
    </div>
    {#if truncated}<div class="truncated">Diff is large — showing the first 200 files.</div>{/if}
    <div class="file-list">
      {#each files as f (f.path)}
        <button class="file-row" title={f.path + " — open in viewer"} onclick={() => openFileCard($projectDir, f.path)}>
          <span class="fpath">{f.path}</span>
          <span class="fnums">
            <span class="added">+{f.added}</span>
            <span class="deleted">−{f.deleted}</span>
          </span>
        </button>
      {:else}
        {#if !loading}<div class="empty">Working tree clean — no changes vs HEAD.</div>{/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .diff-panel { display: flex; flex-direction: column; min-height: 100%; }
  .diff-head {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 12px; border-bottom: 1px solid var(--border);
    position: sticky; top: 0; background: var(--bg-surface); z-index: 1;
  }
  .totals { font-size: 12px; color: var(--text-2); display: flex; gap: 6px; align-items: baseline; }
  .added { color: var(--ok); font-family: var(--font-mono); font-size: 11.5px; }
  .deleted { color: var(--danger); font-family: var(--font-mono); font-size: 11.5px; }
  .count { color: var(--text-3); font-size: 11px; }
  .spacer { flex: 1; }
  .ghost.icon {
    display: inline-flex; align-items: center; justify-content: center; padding: 4px;
    background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
    color: var(--text-2); cursor: pointer;
  }
  .ghost.icon:hover { background: var(--bg-surface-2); }
  .truncated { padding: 5px 12px; font-size: 11px; color: var(--text-3); border-bottom: 1px solid var(--border); }
  .file-list { display: flex; flex-direction: column; padding: 4px 0; }
  .file-row {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 5px 12px; background: transparent; border: none;
    color: var(--text-2); font-size: 12px; text-align: left; cursor: pointer;
  }
  .file-row:hover { background: var(--bg-surface-2); color: var(--text); }
  .fpath {
    font-family: var(--font-mono); font-size: 11.5px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl;
    min-width: 0; flex: 1;
  }
  .fnums { display: flex; gap: 6px; flex-shrink: 0; font-size: 11px; font-family: var(--font-mono); }
  .empty { padding: 24px 16px; text-align: center; color: var(--text-3); font-size: 12.5px; }
  .empty.error { color: var(--danger); }
</style>

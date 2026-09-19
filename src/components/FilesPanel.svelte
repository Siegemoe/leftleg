<script lang="ts">
  // Repo file tree (tracked files only, binaries filtered native-side).
  // Directories expand lazily: expanding one batch-loads LOC/size for its
  // direct children so big repos stay cheap. Clicking a code file opens it
  // in the moveable viewer card. Owner-scoped reset like Artifacts.
  import { projectDir, rightPanelOpen, rightPanelTab, openFileCard } from "../lib/stores";
  import { repoFiles, fileStats, type FileStat } from "../lib/api";
  import { buildFileTree, flattenTree, formatBytes, type FileTreeNode } from "../lib/files-model";
  import { ChevronDown, ChevronRight, RefreshCw } from "@lucide/svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";

  let loading = $state(false);
  let loadError = $state("");
  let isRepo = $state(false);
  let truncated = $state(false);
  let tree = $state<FileTreeNode>(buildFileTree([]));
  let refreshRevision = 0;
  let lastSeenDir = "";

  // Expanded dirs + per-file stats cache (repo-relative path → stat).
  const expanded = new SvelteSet<string>();
  const stats = new SvelteMap<string, FileStat>();
  // Path -> tree revision. Keeping the revision prevents an older refresh's
  // finally block from clearing ownership of a newer request for the same path.
  // Deliberately non-reactive bookkeeping: nothing renders from it.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  let statsInFlight = new Map<string, number>();

  async function refresh(dir: string = $projectDir) {
    const revision = ++refreshRevision;
    if (!dir) { tree = buildFileTree([]); isRepo = false; loadError = ""; loading = false; return; }
    loading = true;
    loadError = "";
    try {
      const list = await repoFiles(dir);
      if (revision !== refreshRevision || dir !== $projectDir) return;
      tree = buildFileTree(list.files);
      isRepo = list.repo;
      truncated = list.truncated;
      // Fresh repo listing invalidates cached stats.
      stats.clear();
      statsInFlight.clear();
      // Open the top directory (descending single-dir chains) so the panel
      // never greets with a lone folder row, and load its stats.
      expanded.clear();
      const top = topLevelDirs(tree);
      const topNode = top ? findNode(tree, top) : null;
      if (topNode) {
        expanded.add(top);
        void loadStatsFor(topNode.children);
      } else {
        void loadStatsFor(tree.children);
      }
    } catch (e) {
      if (revision !== refreshRevision || dir !== $projectDir) return;
      tree = buildFileTree([]);
      isRepo = false;
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      if (revision === refreshRevision) loading = false;
    }
  }

  /** First directory path in the tree, descending single-dir chains
   * (e.g. everything under src/ finds src/ itself). */
  function topLevelDirs(node: FileTreeNode): string {
    let n = node;
    while (n.children.length === 1 && n.children[0].dir) n = n.children[0];
    return n.children.find((c) => c.dir)?.path ?? "";
  }

  function findNode(node: FileTreeNode, path: string): FileTreeNode | null {
    if (node.path === path) return node;
    for (const child of node.children) {
      if (child.dir) {
        const hit = findNode(child, path);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** Directory nesting level for row indentation (0 = repo root). */
  function depthOf(path: string): number {
    return path.split("/").length - 1;
  }

  async function loadStatsFor(nodes: FileTreeNode[], revision: number = refreshRevision) {
    const dir = $projectDir;
    const wanted = nodes.filter((n) => !n.dir && !stats.has(n.path) && statsInFlight.get(n.path) !== revision);
    if (!dir || wanted.length === 0) return;
    for (const n of wanted) statsInFlight.set(n.path, revision);
    try {
      // The backend caps a batch at 200 paths and drops the tail, so big
      // directories chunk here to still get their numbers.
      const chunks: string[][] = [];
      for (let i = 0; i < wanted.length; i += 200) chunks.push(wanted.slice(i, i + 200).map((n) => n.path));
      const groups = await Promise.all(chunks.map((paths) => fileStats(dir, paths)));
      if (dir !== $projectDir || revision !== refreshRevision) return;
      // $state proxies Map — direct mutation is reactive; no copy needed.
      for (const group of groups) for (const s of group) stats.set(s.path, s);
    } catch {
      // Stats are decorative; failures just leave rows without numbers.
    } finally {
      for (const n of wanted) {
        if (statsInFlight.get(n.path) === revision) statsInFlight.delete(n.path);
      }
    }
  }

  function toggleDir(node: FileTreeNode) {
    // $state proxies Set — direct mutation is reactive; no copy needed.
    if (expanded.has(node.path)) expanded.delete(node.path);
    else {
      expanded.add(node.path);
      void loadStatsFor(node.children);
    }
  }

  const visible = $derived(flattenTree(tree, expanded));

  $effect(() => {
    const dir = $projectDir;
    if (!$rightPanelOpen || $rightPanelTab !== "files") return;
    if (lastSeenDir !== dir) {
      tree = buildFileTree([]);
      isRepo = false;
      loadError = "";
      truncated = false;
      stats.clear();
      expanded.clear();
      lastSeenDir = dir;
      void refresh(dir);
    }
  });
</script>

<div class="files-panel">
  {#if !$projectDir}
    <div class="empty">Open a project to browse its files.</div>
  {:else if loadError}
    <div class="empty error">{loadError}</div>
  {:else if !isRepo && !loading}
    <div class="empty">Not a git repository.</div>
  {:else}
    <div class="files-head">
      <span class="count">{truncated ? "first 5000 tracked files" : `${tree.children.length} top-level entr${tree.children.length === 1 ? "y" : "ies"}`}</span>
      <span class="spacer"></span>
      <button class="ghost icon" title="Refresh file tree" onclick={() => void refresh()}>
        <RefreshCw size={13} strokeWidth={2} />
      </button>
    </div>
    <div class="tree">
      {#each visible as node (node.path)}
        {#if node.dir}
          <button class="row dir" style="padding-left: {8 + depthOf(node.path) * 14}px" aria-expanded={expanded.has(node.path)} onclick={() => toggleDir(node)}>
            {#if expanded.has(node.path)}<ChevronDown size={13} strokeWidth={2} />{:else}<ChevronRight size={13} strokeWidth={2} />{/if}
            <span class="name">{node.name}</span>
          </button>
        {:else}
          <button
            class="row file"
            style="padding-left: {8 + depthOf(node.path) * 14 + 17}px"
            title={node.path + " — open in viewer"}
            onclick={() => openFileCard($projectDir, node.path)}
          >
            <span class="name">{node.name}</span>
            <span class="meta">
              {#if stats.has(node.path)}
                {@const s = stats.get(node.path)!}
                {#if s.loc !== null}<span class="loc">{s.loc} loc</span>{/if}
                <span class="size">{formatBytes(s.size)}</span>
              {:else}
                <span class="size">{formatBytes(node.size ?? 0)}</span>
              {/if}
            </span>
          </button>
        {/if}
      {/each}
      {#if loading && tree.children.length === 0}<div class="empty">Loading…</div>{/if}
    </div>
  {/if}
</div>

<style>
  .files-panel { display: flex; flex-direction: column; min-height: 100%; }
  .files-head {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 12px; border-bottom: 1px solid var(--border);
    position: sticky; top: 0; background: var(--bg-surface); z-index: 1;
  }
  .count { font-size: 11px; color: var(--text-3); }
  .spacer { flex: 1; }
  .ghost.icon {
    display: inline-flex; align-items: center; justify-content: center; padding: 4px;
    background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
    color: var(--text-2); cursor: pointer;
  }
  .ghost.icon:hover { background: var(--bg-surface-2); }
  .tree { display: flex; flex-direction: column; padding: 4px 0; }
  .row {
    display: flex; align-items: center; gap: 4px; width: 100%;
    padding: 3px 10px 3px 8px; background: transparent; border: none;
    color: var(--text-2); font-size: 12px; text-align: left; cursor: pointer;
    border-radius: 0;
  }
  .row:hover { background: var(--bg-surface-2); color: var(--text); }
  .row :global(svg) { flex-shrink: 0; color: var(--text-3); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dir .name { font-weight: 600; }
  .file .name { font-family: var(--font-mono); font-size: 11.5px; min-width: 0; flex-shrink: 1; }
  .meta {
    margin-left: auto; display: flex; gap: 8px; flex-shrink: 0;
    font-size: 10.5px; color: var(--text-3); font-family: var(--font-mono);
  }
  .empty { padding: 24px 16px; text-align: center; color: var(--text-3); font-size: 12.5px; }
  .empty.error { color: var(--danger); }
</style>

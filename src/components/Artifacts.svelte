<script lang="ts">
  // Project artifacts browser: images generated via the image_generate tool
  // (project-scoped .pi/images/) and the canonical project docs. Thumbnails
  // stream from disk via the asset protocol (its scope is extended to the
  // project's images dir by list_artifacts) — no base64 inflation, no size
  // caps; failed loads degrade to click-to-open chips. Rendered as a card
  // inside the right panel (panel open + artifacts tab).
  import { projectDir, rightPanelOpen, rightPanelTab, transientNote, items } from "../lib/stores";
  import { listArtifacts, deleteArtifact, openPathLocal, type ArtifactFile } from "../lib/api";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { ExternalLink, Copy, Check, Trash2, RefreshCw } from "@lucide/svelte";

  let tab = $state<"images" | "docs">("images");
  let loading = $state(false);
  let loadError = $state("");
  let images = $state<ArtifactFile[]>([]);
  let docs = $state<ArtifactFile[]>([]);
  let loadedProject = $state("");
  let refreshRevision = 0;
  // Last directory the visibility effect scheduled a load for — plain (not
  // $state) so reading it inside the effect doesn't create a dependency; it
  // exists only to detect owner changes, like the revision counter.
  let lastSeenDir = "";
  // Files whose asset-protocol load failed (moved/deleted/scope gap) degrade
  // to click-to-open chips instead of broken <img> elements.
  let thumbFailed = $state<Record<string, string>>({});

  async function refresh(dir: string = $projectDir) {
    const revision = ++refreshRevision;
    if (!dir) {
      images = [];
      docs = [];
      thumbFailed = {};
      loadedProject = "";
      loading = false;
      loadError = "";
      return;
    }
    loading = true;
    loadError = "";
    try {
      const report = await listArtifacts(dir);
      if (revision !== refreshRevision || dir !== $projectDir) return;
      images = report.images;
      docs = report.docs;
      loadedProject = dir;
      // Refresh also retries transient asset failures after scope or file repair.
      thumbFailed = {};
    } catch (e) {
      if (revision !== refreshRevision || dir !== $projectDir) return;
      // A failed load must never leave another project's artifacts under this
      // project's header — show the error over an empty list.
      images = [];
      docs = [];
      thumbFailed = {};
      loadedProject = "";
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      if (revision === refreshRevision) loading = false;
    }
  }

  // Reload when the card becomes visible (panel opens on this tab) or the
  // focused project changes.
  const completedGenerations = $derived($items
    .filter((item) => item.kind === "tool" && item.name === "image_generate" && item.status !== "running")
    .map((item) => item.kind === "tool" ? item.toolCallId : "").join("\0"));
  $effect(() => {
    const dir = $projectDir; // tracked: project switch while open refreshes the list
    completedGenerations; // tracked: new outputs appear while the gallery stays open
    if (!$rightPanelOpen || $rightPanelTab !== "artifacts") return;
    // Owner-scoped reset (StatusCard pattern): when the owning project
    // changes, drop the previous project's artifacts BEFORE the new load —
    // a slow or failed refresh then shows an empty list, never another
    // project's files under this project's header.
    if (lastSeenDir !== dir) {
      images = [];
      docs = [];
      thumbFailed = {};
      loadedProject = "";
      lastSeenDir = dir;
    }
    void refresh(dir);
  });

  async function openFile(path: string) {
    try { await openPathLocal(path); }
    catch (e) { transientNote(`Couldn't open: ${e}`); }
  }

  // Inline "Copied" feedback on the tile (status-bar notes are out of the
  // sight line here); failures still surface as a note.
  let copiedPath = $state<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      copiedPath = path;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copiedPath = null), 2000);
    } catch (e) {
      transientNote(`Couldn't copy: ${e}`);
    }
  }

  async function removeImage(file: ArtifactFile) {
    if (!confirm(`Delete ${file.name}? This cannot be undone.`)) return;
    const owner = loadedProject;
    if (!owner) return;
    try {
      await deleteArtifact(owner, file.path);
      if ($projectDir === owner) await refresh(owner);
    } catch (e) {
      transientNote(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function fmtTime(ms: number): string {
    if (!ms) return "";
    const d = new Date(ms);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
</script>

<div class="artifacts">
  <header>
    <h2>Artifacts</h2>
    <span class="sub mono" title={$projectDir}>{$projectDir || "no project"}</span>
    <span class="spacer"></span>
    <button class="ghost icon" title="Refresh" onclick={() => void refresh()} disabled={loading}>
      <span class="iconspin" class:on={loading}><RefreshCw size={14} /></span>
    </button>
  </header>

  <nav class="tabs">
    <button class="tab" class:active={tab === "images"} onclick={() => (tab = "images")}>
      Images <span class="count">{images.length}</span>
    </button>
    <button class="tab" class:active={tab === "docs"} onclick={() => (tab = "docs")}>
      Docs <span class="count">{docs.filter((d) => d.exists).length}/{docs.length}</span>
    </button>
  </nav>

  <div class="content">
    {#if loadError}
      <p class="state err">⚠ {loadError}</p>
    {:else if loading && images.length === 0 && docs.length === 0}
      <p class="state">Loading…</p>
    {:else if tab === "images"}
      {#if images.length === 0}
        <p class="state">No generated images yet — ask the agent to create one (saved to <span class="mono">.pi/images/</span>).</p>
      {:else}
        <div class="grid">
          {#each images as file (file.path)}
            <div class="tile">
              <div class="thumb">
                {#if thumbFailed[file.path]}
                  <button class="thumbfall mono" title={thumbFailed[file.path]} onclick={() => void openFile(file.path)}>⚠ preview unavailable — click to open</button>
                {:else}
                  <button class="thumbbtn" title="Open — {file.name}" onclick={() => void openFile(file.path)}>
                    <img
                      src={convertFileSrc(file.path)}
                      alt={file.name}
                      loading="lazy"
                      onerror={() => (thumbFailed = { ...thumbFailed, [file.path]: `preview failed: ${file.name}` })}
                    />
                  </button>
                {/if}
              </div>
              <div class="tilemeta">
                <span class="name" title={file.path}>{file.name}</span>
                <span class="meta">{fmtSize(file.size)} · {fmtTime(file.modifiedMs)}</span>
              </div>
              <div class="tileactions">
                <button class="ghost icon" title="Open externally" onclick={() => void openFile(file.path)}><ExternalLink size={13} /></button>
                {#if copiedPath === file.path}
                  <span class="copied-chip"><Check size={11} strokeWidth={2.4} /> Copied</span>
                {:else}
                  <button class="ghost icon" title="Copy path" onclick={() => void copyPath(file.path)}><Copy size={13} /></button>
                {/if}
                <button class="ghost icon danger" title="Delete" onclick={() => void removeImage(file)}><Trash2 size={13} /></button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="docs">
        {#each docs as file (file.name)}
          <div class="docrow" class:missing={!file.exists}>
            <div class="docinfo">
              <span class="name mono">{file.name}</span>
              <span class="meta" title={file.path}>{file.exists ? `${fmtSize(file.size)} · ${fmtTime(file.modifiedMs)}` : "not present"}</span>
            </div>
            <div class="tileactions">
              {#if file.exists}
                <button class="ghost icon" title="Open externally — {file.path}" onclick={() => void openFile(file.path)}><ExternalLink size={13} /></button>
                {#if copiedPath === file.path}
                  <span class="copied-chip"><Check size={11} strokeWidth={2.4} /> Copied</span>
                {:else}
                  <button class="ghost icon" title="Copy path" onclick={() => void copyPath(file.path)}><Copy size={13} /></button>
                {/if}
              {/if}
            </div>
          </div>
        {/each}
        <p class="hint">Docs are the project's canonical context files pi reads on startup.</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .artifacts {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  h2 { margin: 0; font-size: 14.5px; }
  .sub {
    flex: 1;
    font-size: 11px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .ghost.danger { color: var(--danger); }
  .ghost.danger:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); }
  .iconspin { display: inline-flex; }
  .iconspin.on { animation: rot 0.9s linear infinite; }
  @keyframes rot { to { transform: rotate(360deg); } }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 8px 14px 0;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .tab {
    padding: 6px 14px;
    font-size: 12.5px;
    color: var(--text-2);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
  }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
  .count {
    font-size: 10.5px;
    color: var(--text-3);
    background: var(--bg-surface-2);
    border-radius: 99px;
    padding: 1px 6px;
    margin-left: 4px;
  }
  .tab.active .count { color: var(--accent); }
  .content { flex: 1; overflow-y: auto; padding: 14px; }
  .state { color: var(--text-3); font-size: 12.5px; padding: 24px 4px; }
  .state.err { color: var(--danger); }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 12px;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-inset);
    padding: 8px;
  }
  .thumb {
    aspect-ratio: 1 / 1;
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg-surface-2);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .thumbbtn { padding: 0; border: none; background: transparent; cursor: zoom-in; line-height: 0; width: 100%; height: 100%; }
  .thumbbtn img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumbfall { font-size: 10.5px; color: var(--text-3); padding: 6px; text-align: center; }
  .tilemeta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .name {
    font-size: 11.5px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta { font-size: 10.5px; color: var(--text-3); }
  .tileactions { display: flex; gap: 4px; align-items: center; }
  .copied-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    color: var(--ok);
    padding: 0 4px;
    user-select: none;
  }
  .docs { display: flex; flex-direction: column; gap: 8px; }
  .docrow {
    display: flex;
    align-items: center;
    gap: 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-inset);
    padding: 10px 12px;
  }
  .docrow.missing { opacity: 0.5; }
  .docinfo { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .hint { color: var(--text-3); font-size: 11px; }
</style>

<script lang="ts">
  // Project artifacts browser: images generated via the image_generate tool
  // (project-scoped .pi/images/) and the canonical project docs. Thumbnails
  // stream from disk via the asset protocol (its scope is extended to the
  // project's images dir by list_artifacts) — no base64 inflation, no size
  // caps; failed loads degrade to click-to-open chips.
  import { artifactsOpen, projectDir, statusNote } from "../lib/stores";
  import { get } from "svelte/store";
  import { listArtifacts, deleteArtifact, type ArtifactFile } from "../lib/api";
  import { openPath as openInDefaultApp } from "@tauri-apps/plugin-opener";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { ExternalLink, Copy, Trash2, RefreshCw } from "@lucide/svelte";

  let close = () => artifactsOpen.set(false);

  let tab = $state<"images" | "docs">("images");
  let loading = $state(false);
  let loadError = $state("");
  let images = $state<ArtifactFile[]>([]);
  let docs = $state<ArtifactFile[]>([]);
  let loadedProject = $state("");
  let refreshRevision = 0;
  // Files whose asset-protocol load failed (moved/deleted/scope gap) degrade
  // to click-to-open chips instead of broken <img> elements.
  let thumbFailed = $state<Record<string, string>>({});

  async function refresh(dir: string = $projectDir) {
    const revision = ++refreshRevision;
    if (!dir) {
      images = [];
      docs = [];
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
      // Drop thumb state for files that vanished between refreshes (thumbs and
      // failures alike); in-flight loads self-clean via thumbPending.
      const live = new Set(images.map((i) => i.path));
      thumbFailed = Object.fromEntries(Object.entries(thumbFailed).filter(([p]) => live.has(p)));
    } catch (e) {
      if (revision !== refreshRevision || dir !== $projectDir) return;
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      if (revision === refreshRevision) loading = false;
    }
  }

  // Reload whenever the browser opens or the focused project changes.
  $effect(() => {
    const dir = $projectDir; // tracked: project switch while open refreshes the list
    if (!$artifactsOpen) return;
    void refresh(dir);
  });

  async function openFile(path: string) {
    try { await openInDefaultApp(path); }
    catch (e) { statusNote.set(`Couldn't open: ${e}`); }
  }

  async function copyPath(path: string) {
    const note = "Path copied";
    try {
      await navigator.clipboard.writeText(path);
      statusNote.set(note);
      setTimeout(() => { if (get(statusNote) === note) statusNote.set(""); }, 3000);
    } catch (e) {
      statusNote.set(`Couldn't copy: ${e}`);
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
      statusNote.set(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`);
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

<div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) close(); }} role="presentation">
  <div class="panel" role="dialog" aria-modal="true">
    <header>
      <h2>Artifacts</h2>
      <span class="sub mono" title={$projectDir}>{$projectDir || "no project"}</span>
      <span class="spacer"></span>
      <button class="ghost icon" title="Refresh" onclick={() => void refresh()} disabled={loading}>
        <span class="iconspin" class:on={loading}><RefreshCw size={14} /></span>
      </button>
      <button class="ghost x" onclick={close}>✕</button>
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
                  <button class="ghost icon" title="Copy path" onclick={() => void copyPath(file.path)}><Copy size={13} /></button>
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
                  <button class="ghost icon" title="Copy path" onclick={() => void copyPath(file.path)}><Copy size={13} /></button>
                {/if}
              </div>
            </div>
          {/each}
          <p class="hint">Docs are the project's canonical context files pi reads on startup.</p>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(10, 10, 16, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .panel {
    width: min(860px, 94vw);
    height: min(680px, 90vh);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  h2 { margin: 0; font-size: 16px; }
  .sub {
    flex: 1;
    font-size: 11px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ghost.icon, .ghost.x {
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
  .ghost.icon:hover, .ghost.x:hover { background: var(--bg-surface-2); }
  .ghost.danger { color: var(--danger); }
  .ghost.danger:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); }
  .iconspin { display: inline-flex; }
  .iconspin.on { animation: rot 0.9s linear infinite; }
  @keyframes rot { to { transform: rotate(360deg); } }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 8px 20px 0;
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
  .content { flex: 1; overflow-y: auto; padding: 16px 20px 20px; }
  .state { color: var(--text-3); font-size: 12.5px; padding: 24px 4px; }
  .state.err { color: var(--danger); }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
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
  .tileactions { display: flex; gap: 4px; }
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

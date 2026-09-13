<script lang="ts">
  import { settingsOpen, settingsProject, rpcState, models, theme, applyTheme, projectDir, projectMeta, sessions, commands, autoRetry, compact, renameSession, setModel, setThinkingLevel, setSteeringMode, setFollowUpMode, setAutoCompaction, setAutoRetry, abortRetry, exportSessionHtml, cloneSession, chooseProject, updateProjectMeta, forgetProject, restoreProject } from "../lib/stores";
  import { projectDisplayName } from "../lib/sidebar-model";
  import { getAgentDir } from "../lib/api";
  import { piRequest } from "../lib/api";
  import type { ModelInfo, ThinkingLevel } from "../lib/types";
  import { onMount } from "svelte";

  let close = () => settingsOpen.set(false);

  let tab = $state<"general" | "projects" | "extensions">($settingsProject ? "projects" : "general");

  const PROJECT_ICONS = ["📁", "⚡", "🧠", "🚀", "🎨", "🛠", "📊", "🧪", "🏠", "⭐"];

  let selectedProject = $state<string | null>($settingsProject);
  let projName = $state("");
  let projIcon = $state<string | undefined>(undefined);
  let projModelKey = $state("");

  // Known projects: every cwd seen in the session list plus remembered meta.
  let knownProjects = $derived.by(() => {
    const dirs = new Set<string>(Object.keys($projectMeta));
    for (const s of $sessions) dirs.add(s.cwd);
    const sorted = [...dirs].sort((a, b) => {
      const af = $projectMeta[a]?.forgotten ? 1 : 0;
      const bf = $projectMeta[b]?.forgotten ? 1 : 0;
      if (af !== bf) return af - bf;
      return a.localeCompare(b);
    });
    return sorted;
  });

  // Re-sync the editor fields when the selected project changes.
  $effect(() => {
    const dir = selectedProject;
    if (!dir) return;
    const meta = $projectMeta[dir];
    projName = meta?.name ?? "";
    projIcon = meta?.icon;
    const m = meta?.defaultModel;
    projModelKey = m ? `${m.provider}|${m.id}` : "";
  });

  function selectProject(dir: string) {
    selectedProject = dir;
  }

  function saveName() {
    if (!selectedProject) return;
    updateProjectMeta(selectedProject, { name: projName.trim() || undefined });
  }

  function saveIcon(icon: string | undefined) {
    if (!selectedProject) return;
    projIcon = icon;
    updateProjectMeta(selectedProject, { icon });
  }

  function saveModel(key: string) {
    if (!selectedProject) return;
    projModelKey = key;
    const [provider, id] = key.split("|");
    updateProjectMeta(selectedProject, { defaultModel: provider && id ? { provider, id } : undefined });
  }

  let modelFilter = $state("");
  let sessionName = $state($rpcState?.sessionName ?? "");
  let agentDir = $state("");
  let availableLevels: ThinkingLevel[] = $state(["off", "minimal", "low", "medium", "high"]);
  let switching = $state(false);

  onMount(async () => {
    sessionName = $rpcState?.sessionName ?? "";
    try { agentDir = await getAgentDir(); } catch { /* ignore */ }
    try {
      const res = await piRequest<{ success: boolean; data?: { levels: ThinkingLevel[] } }>({ type: "get_available_thinking_levels" }, 30);
      if (res.success && res.data?.levels) availableLevels = res.data.levels;
    } catch { /* defaults */ }
  });

  let filteredModels = $derived.by(() => {
    const q = modelFilter.trim().toLowerCase();
    const list = $models;
    const filtered = q
      ? list.filter((m) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q))
      : list;
    // Current model first, then provider-grouped
    const sorted = [...filtered].sort((a, b) => {
      const ac = $rpcState?.model?.id === a.id && $rpcState?.model?.provider === a.provider ? 0 : 1;
      const bc = $rpcState?.model?.id === b.id && $rpcState?.model?.provider === b.provider ? 0 : 1;
      if (ac !== bc) return ac - bc;
      return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
    });
    return sorted.slice(0, 80);
  });

  function groupKey(m: ModelInfo): string { return m.provider; }

  async function pickModel(m: ModelInfo) {
    switching = true;
    try {
      await setModel(m.provider, m.id);
    } finally {
      switching = false;
    }
  }

  let renameTimeout: ReturnType<typeof setTimeout> | null = null;
  function onNameInput() {
    if (renameTimeout) clearTimeout(renameTimeout);
    renameTimeout = setTimeout(() => renameSession(sessionName), 700);
  }
</script>

<div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) close(); }} role="presentation">
  <div class="card" role="dialog" aria-modal="true">
    <header>
      <h2>Settings</h2>
      <nav class="tabs">
        <button class:active={tab === "general"} onclick={() => (tab = "general")}>General</button>
        <button class:active={tab === "projects"} onclick={() => (tab = "projects")}>Projects</button>
        <button class:active={tab === "extensions"} onclick={() => (tab = "extensions")}>Extensions</button>
      </nav>
      <button class="ghost x" onclick={close}>✕</button>
    </header>

    {#if tab === "general"}
    <div class="grid">
      <!-- Appearance -->
      <section>
        <h3>Appearance</h3>
        <div class="row">
          <span class="row-label">Theme</span>
          <div class="seg">
            {#each [["light", "Light"], ["dark", "Dark"], ["system", "System"]] as [v, l]}
              <button class:active={$theme === v} onclick={() => applyTheme(v as never)}>{l}</button>
            {/each}
          </div>
        </div>
      </section>

      <!-- Project -->
      <section>
        <h3>Project</h3>
        <div class="row">
          <span class="row-label">Working directory</span>
          <div class="dir-row">
            <span class="mono dir" title={$projectDir}>{$projectDir || "—"}</span>
            <button onclick={chooseProject}>Change…</button>
          </div>
          <p class="hint">Changing this restarts the pi process for the new project.</p>
        </div>
      </section>

      <!-- Model -->
      <section class="wide">
        <h3>Model</h3>
        {#if $rpcState?.model}
          <p class="current mono">
            current: {$rpcState.model.provider} / {$rpcState.model.id}
            {#if switching} <span class="tag">switching…</span>{/if}
          </p>
        {/if}
        <input
          type="text"
          placeholder="Filter {$models.length} available models (provider or id)…"
          bind:value={modelFilter}
        />
        <div class="model-list">
          {#each filteredModels as m, i (m.provider + "/" + m.id)}
            {#if i === 0 || filteredModels[i - 1].provider !== m.provider}
              <div class="group mono">{m.provider}</div>
            {/if}
            <button
              class="model"
              class:active={$rpcState?.model?.provider === m.provider && $rpcState?.model?.id === m.id}
              onclick={() => pickModel(m)}
            >
              <span class="m-id mono">{m.id}</span>
              <span class="m-meta">
                {#if m.reasoning}<span class="tag">reasoning</span>{/if}
                {#if m.input?.includes("image")}<span class="tag">vision</span>{/if}
                <span class="ctx">{Math.round(m.contextWindow / 1000)}k</span>
              </span>
            </button>
          {:else}
            <div class="hint none">No models match</div>
          {/each}
        </div>
      </section>

      <!-- Thinking -->
      <section>
        <h3>Thinking</h3>
        <div class="row">
          <span class="row-label">Level</span>
          <div class="seg wrap">
            {#each availableLevels as l}
              <button class:active={$rpcState?.thinkingLevel === l} onclick={() => setThinkingLevel(l)}>{l}</button>
            {/each}
          </div>
        </div>
      </section>

      <!-- Queue behavior -->
      <section>
        <h3>Queued messages</h3>
        <div class="row">
          <label for="steering-mode">Steering delivery</label>
          <select id="steering-mode" value={$rpcState?.steeringMode ?? "one-at-a-time"} onchange={(e) => setSteeringMode(e.currentTarget.value as never)}>
            <option value="all">all — after each turn</option>
            <option value="one-at-a-time">one-at-a-time</option>
          </select>
        </div>
        <div class="row">
          <label for="followup-mode">Follow-up delivery</label>
          <select id="followup-mode" value={$rpcState?.followUpMode ?? "one-at-a-time"} onchange={(e) => setFollowUpMode(e.currentTarget.value as never)}>
            <option value="all">all — when agent finishes</option>
            <option value="one-at-a-time">one-at-a-time</option>
          </select>
        </div>
      </section>

      <!-- Context management -->
      <section>
        <h3>Context &amp; retries</h3>
        <div class="row">
          <label class="check">
            <input type="checkbox" checked={$rpcState?.autoCompactionEnabled ?? true} onchange={(e) => setAutoCompaction(e.currentTarget.checked)} />
            Auto-compaction when context is nearly full
          </label>
        </div>
        <div class="row">
          <button onclick={() => compact()}>Compact now</button>
        </div>
      </section>

      <!-- Reliability -->
      <section>
        <h3>Reliability</h3>
        <div class="row">
          <label class="check">
            <input type="checkbox" checked={$autoRetry} onchange={(e) => { const v = e.currentTarget.checked; autoRetry.set(v); void setAutoRetry(v); }} />
            Auto-retry on transient errors
          </label>
          <p class="hint">Retries overloaded / rate-limited / 5xx turns automatically. Leftleg remembers the last value you set.</p>
        </div>
        <div class="row">
          <button onclick={() => void abortRetry()}>Abort running retry</button>
        </div>
      </section>

      <!-- Session -->
      <section>
        <h3>Session</h3>
        <div class="row">
          <label for="session-name">Name</label>
          <input id="session-name" type="text" placeholder="Unnamed session" bind:value={sessionName} oninput={onNameInput} />
        </div>
        <div class="row btn-row">
          <button onclick={() => void exportSessionHtml()}>Export as HTML…</button>
          <button onclick={() => void cloneSession()}>Clone session</button>
        </div>
        <p class="hint">Export renders the transcript to a file. Clone duplicates this session at the current position into a new one.</p>
      </section>

      <!-- About -->
      <section class="wide about">
        <h3>About</h3>
        <p class="hint">
          Leftleg v0.1 — a native control surface for the <a href="https://github.com/earendil-works/pi-mono" target="_blank" rel="noreferrer">Pi</a> coding agent,
          driven over its RPC protocol. Agent state (sessions, credentials, settings) lives in
          <span class="mono">{agentDir || "~/.pi/agent"}</span>; Leftleg stores only GUI preferences.
        </p>
      </section>
    </div>
    {:else if tab === "projects"}
    <div class="projects">
      <div class="proj-list">
        {#each knownProjects as dir (dir)}
          {@const forgotten = !!$projectMeta[dir]?.forgotten}
          <button
            class="proj-row"
            class:selected={selectedProject === dir}
            class:forgotten
            onclick={() => selectProject(dir)}
          >
            <span class="scope-icon">{$projectMeta[dir]?.icon ?? "📁"}</span>
            <span class="proj-row-name" title={dir}>{projectDisplayName(dir, $projectMeta[dir]?.name)}</span>
            {#if forgotten}<span class="tag">forgotten</span>{/if}
            {#if dir === $projectDir}<span class="tag active-tag">active</span>{/if}
          </button>
        {:else}
          <div class="hint none">No projects yet.</div>
        {/each}
      </div>
      <div class="proj-editor">
        {#if selectedProject}
          <h3 class="proj-title">
            {$projectMeta[selectedProject]?.icon ?? "📁"}
            {projectDisplayName(selectedProject, $projectMeta[selectedProject]?.name)}
          </h3>
          <p class="hint mono dir-full">{selectedProject}</p>

          <div class="row">
            <label for="proj-name">Display name</label>
            <input id="proj-name" type="text" placeholder={projectDisplayName(selectedProject, undefined)} bind:value={projName} onchange={saveName} />
          </div>

          <div class="row">
            <span class="row-label">Icon</span>
            <div class="icon-row">
              {#each PROJECT_ICONS as icon (icon)}
                <button class="icon-btn-pick" class:active={projIcon === icon} onclick={() => saveIcon(icon)}>{icon}</button>
              {/each}
            </div>
          </div>

          <div class="row">
            <label for="proj-model">Default model for new sessions</label>
            <select id="proj-model" value={projModelKey} onchange={(e) => saveModel(e.currentTarget.value)}>
              <option value="">Leftleg default (openrouter / z-ai/glm-5.3-flash)</option>
              {#each $models as m (m.provider + "/" + m.id)}
                <option value={m.provider + "|" + m.id}>{m.provider} / {m.id}</option>
              {/each}
            </select>
            <p class="hint">Applies when a new session starts in this project. Existing sessions keep their own model.</p>
          </div>

          <div class="row danger-row">
            {#if $projectMeta[selectedProject]?.forgotten}
              <button onclick={() => restoreProject(selectedProject!)}>Restore project</button>
            {:else}
              <button class="danger" onclick={() => forgetProject(selectedProject!)}>Forget project</button>
              <p class="hint">Hides this project's sessions from the sidebar. The sessions stay on disk; restoring brings them back.</p>
            {/if}
          </div>
        {:else}
          <p class="hint">Select a project to manage its name, icon, default model, and visibility.</p>
        {/if}
      </div>
    </div>
    {:else if tab === "extensions"}
    <div class="extensions">
      <section class="wide">
        <h3>Commands</h3>
        <p class="hint">Extension commands, prompt templates, and skills registered by pi. Type <span class="mono">/</span> in the composer to run one.</p>
        {#if $commands.length > 0}
          <div class="cmd-list">
            {#each $commands as c (c.name)}
              <div class="cmd-row">
                <span class="cmd-name mono">/{c.name}</span>
                {#if c.source}<span class="tag">{c.source}</span>{/if}
                <span class="cmd-desc" title={c.description}>{c.description ?? ""}</span>
              </div>
            {/each}
          </div>
        {:else}
          <div class="hint none">No commands registered — install pi extensions to populate this list.</div>
        {/if}
      </section>
    </div>
    {/if}
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
  .card {
    width: min(760px, 92vw);
    height: min(640px, 88vh);
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
    justify-content: space-between;
    padding: 14px 20px 10px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  h2 { margin: 0; font-size: 16px; }
  .x { padding: 4px 9px; }
  .tabs { display: flex; gap: 4px; }
  .tabs button {
    font-size: 12.5px;
    padding: 4px 12px;
    border-radius: 99px;
    background: transparent;
    color: var(--text-3);
  }
  .tabs button.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .projects {
    flex: 1;
    display: grid;
    grid-template-columns: 240px 1fr;
    min-height: 0;
  }
  .proj-list {
    border-right: 1px solid var(--border);
    overflow-y: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .proj-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
    border: none;
    background: transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 12.5px;
    color: var(--text-2);
    text-align: left;
    width: 100%;
    min-width: 0;
  }
  .proj-row:hover { background: var(--bg-surface-2); }
  .proj-row.selected { background: var(--accent-soft); color: var(--text); }
  .proj-row.forgotten { opacity: 0.55; }
  .proj-row-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .active-tag { color: var(--accent); border-color: var(--accent); }
  .proj-editor {
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .proj-title { margin: 0; font-size: 14px; text-transform: none; letter-spacing: 0; color: var(--text); }
  .dir-full { word-break: break-all; }
  .icon-row { display: flex; flex-wrap: wrap; gap: 4px; }
  .icon-btn-pick {
    font-size: 15px;
    padding: 4px 7px;
    border-radius: 8px;
    background: transparent;
  }
  .icon-btn-pick.active { background: var(--accent-soft); }
  .danger-row button.danger { border-color: var(--danger); color: var(--danger); background: transparent; }
  .danger-row button.danger:hover { background: var(--danger); color: #fff; }
  .btn-row { flex-direction: row; gap: 8px; }
  .extensions {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .cmd-list {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
  }
  .cmd-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 12.5px;
  }
  .cmd-row:last-child { border-bottom: none; }
  .cmd-name { color: var(--accent); flex-shrink: 0; }
  .cmd-desc {
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grid {
    flex: 1;
    overflow-y: auto;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px 20px;
    padding: 16px 20px 20px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  section.wide { grid-column: 1 / -1; }
  h3 {
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    color: var(--text-3);
  }
  .row { display: flex; flex-direction: column; gap: 5px; }
  label, .row-label { font-size: 12.5px; color: var(--text-2); }
  label.check {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 13px;
    color: var(--text);
  }
  .seg { display: flex; gap: 4px; }
  .seg.wrap { flex-wrap: wrap; }
  .seg button {
    padding: 4px 12px;
    border-radius: 99px;
    font-size: 12px;
    background: transparent;
  }
  .seg button.active { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .dir-row { display: flex; gap: 6px; align-items: center; min-width: 0; }
  .dir {
    flex: 1;
    font-size: 11.5px;
    color: var(--text-2);
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 9px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .hint { font-size: 11.5px; color: var(--text-3); margin: 0; }
  .hint a { color: var(--accent); }
  .current { font-size: 12px; color: var(--text-2); margin: 0; }
  input[type="text"] { width: 100%; }
  .model-list {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-height: 240px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .group {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--text-3);
    background: var(--bg-inset);
    padding: 4px 12px;
    position: sticky;
    top: 0;
  }
  .model {
    display: flex;
    align-items: center;
    gap: 10px;
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 7px 12px;
    text-align: left;
    font-size: 12.5px;
  }
  .model:hover { background: var(--bg-hover); border: none; }
  .model.active { background: var(--accent-soft); }
  .m-id { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .m-meta { display: flex; gap: 4px; align-items: center; margin-left: auto; flex-shrink: 0; }
  .ctx { font-size: 11px; color: var(--text-3); }
  .none { padding: 10px 12px; }
  .about { color: var(--text-2); }
</style>

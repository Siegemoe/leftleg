<script lang="ts">
  import { settingsOpen, rpcState, models, theme, applyTheme, projectDir, compact, renameSession, setModel, setThinkingLevel, setSteeringMode, setFollowUpMode, setAutoCompaction, setAutoRetry, chooseProject } from "../lib/stores";
  import { getAgentDir } from "../lib/api";
  import { piRequest } from "../lib/api";
  import type { ModelInfo, ThinkingLevel } from "../lib/types";
  import { onMount } from "svelte";

  let close = () => settingsOpen.set(false);

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
      <button class="ghost x" onclick={close}>✕</button>
    </header>

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

      <!-- Session -->
      <section>
        <h3>Session</h3>
        <div class="row">
          <label for="session-name">Name</label>
          <input id="session-name" type="text" placeholder="Unnamed session" bind:value={sessionName} oninput={onNameInput} />
        </div>
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

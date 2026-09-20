<script lang="ts">
  import {
    rpcState,
    models,
    setModel,
    pinnedModels,
    setThinkingLevel,
    newProjectOpen,
    projectSettingsDir,
    fileCardOpen,
    extDialog,
    projectDir,
    transientNote,
  } from "../lib/stores";
  import { ChevronDown, GitBranch } from "@lucide/svelte";
  import { gitRepoInfo, gitDiffSummary } from "../lib/api";
  import type { ThinkingLevel, ModelInfo } from "../lib/types";

  // Git checkout state for the branch chip: current branch + uncommitted
  // count, refreshed on project switch and every 30s while mounted.
  interface GitInfo {
    repo: boolean;
    branch: string;
    dirty: number;
    toplevel: string;
  }
  let gitInfo = $state<GitInfo | null>(null);
  let gitRevision = 0;
  async function refreshGit(dir?: string) {
    const target = dir ?? $projectDir;
    const revision = ++gitRevision;
    if (!target) {
      gitInfo = null;
      return;
    }
    try {
      const result = await gitRepoInfo(target);
      if (revision === gitRevision && target === $projectDir) gitInfo = result;
    } catch {
      if (revision === gitRevision && target === $projectDir) gitInfo = null;
    }
  }
  // Branch-chip hover/focus: one-line working-tree diff total (+N −M vs
  // HEAD). Debounced on open and cached 5 s so pointer travel doesn't re-run
  // git; the popover is pointer-events:none, so leave/blur is the only
  // dismiss path. Focus mirrors hover so keyboard users see the totals too.
  interface DiffHover {
    added: number;
    deleted: number;
    files: number;
  }
  let diffHover = $state<DiffHover | null>(null);
  let diffHoverTimer: ReturnType<typeof setTimeout> | null = null;
  let diffHoverSeq = 0;
  let diffCache: { at: number; dir: string; data: DiffHover } | null = null;
  function onChipEnter() {
    if (diffHoverTimer) return;
    diffHoverTimer = setTimeout(async () => {
      diffHoverTimer = null;
      const seq = ++diffHoverSeq;
      const dir = $projectDir;
      if (!dir) return;
      const now = Date.now();
      if (diffCache && diffCache.dir === dir && now - diffCache.at < 5000) {
        if (seq === diffHoverSeq) diffHover = diffCache.data;
        return;
      }
      try {
        const summary = await gitDiffSummary(dir);
        // A leave after hover-open bumped the seq: the popover must not
        // resurrect when the in-flight summary lands.
        if (seq !== diffHoverSeq || dir !== $projectDir) return;
        const data: DiffHover = {
          added: summary.files.reduce((n, f) => n + f.added, 0),
          deleted: summary.files.reduce((n, f) => n + f.deleted, 0),
          files: summary.files.length,
        };
        diffCache = { at: Date.now(), dir, data };
        diffHover = data;
      } catch {
        /* hover stats are best-effort */
      }
    }, 250);
  }
  function onChipLeave() {
    if (diffHoverTimer) {
      clearTimeout(diffHoverTimer);
      diffHoverTimer = null;
    }
    diffHoverSeq++;
    diffHover = null;
  }

  $effect(() => {
    const dir = $projectDir;
    // A project switch clears the previous repo's chip/diff state up front —
    // no stale branch lingers while the new repo's info is in flight.
    gitInfo = null;
    diffHover = null;
    diffCache = null;
    diffHoverSeq++;
    if (diffHoverTimer) {
      clearTimeout(diffHoverTimer);
      diffHoverTimer = null;
    }
    void refreshGit(dir);
    const iv = setInterval(() => void refreshGit(), 30000);
    return () => clearInterval(iv);
  });

  // ---------- model dropdown ----------
  let modelOpen = $state(false);
  let modelHl = $state(0);
  // True once arrow keys have engaged the highlight since the menu opened.
  // Distinguishes a keyboard user's Enter (pick the highlighted model) from
  // an Enter on the pill after a mouse-open, which must keep native
  // activation (toggle) instead of silently switching to the first model.
  let modelKbd = false;
  let modelMenuEl: HTMLDivElement | null = $state(null);
  async function pickModel(m: ModelInfo) {
    modelOpen = false;
    try {
      await setModel(m.provider, m.id);
    } catch (e) {
      transientNote(`Couldn't switch model: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const modelKey = (m: ModelInfo) => `${m.provider}/${m.id}`;
  let modelQuery = $state("");
  function togglePinModel(m: ModelInfo) {
    const key = modelKey(m);
    pinnedModels.update((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  }
  let filteredModels = $derived.by(() => {
    const q = modelQuery.trim().toLowerCase();
    const all = $models;
    if (!q) return all;
    return all.filter((m) => `${m.name} ${m.provider}/${m.id}`.toLowerCase().includes(q));
  });
  let pinnedSet = $derived(new Set($pinnedModels));
  let groupedModels = $derived.by(() => {
    const pinned = filteredModels.filter((m) => pinnedSet.has(modelKey(m)));
    const rest = filteredModels.filter((m) => !pinnedSet.has(modelKey(m)));
    return { pinned, rest };
  });
  let flatModels = $derived([...groupedModels.pinned, ...groupedModels.rest]);

  // Keep the keyboard-highlighted model in view — ArrowUp/ArrowDown must be
  // able to peruse the full list without a mouse (as in the composer's
  // slash-command palette).
  $effect(() => {
    const idx = modelHl;
    if (!modelOpen || !modelMenuEl || flatModels.length === 0) return;
    const rows = modelMenuEl.querySelectorAll<HTMLElement>(".modelitem");
    rows[Math.min(idx, flatModels.length - 1)]?.scrollIntoView({ block: "nearest" });
  });

  function onBarKeydown(e: KeyboardEvent) {
    if (!modelOpen || e.defaultPrevented) return;
    // The extension dialog is the topmost layer and registers later — its Esc
    // wins. The z-150 cards and the file viewer paint above this picker and
    // can be accelerator-opened while it's up — their Esc wins too.
    if ($extDialog || $newProjectOpen || $projectSettingsDir || $fileCardOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      modelOpen = false;
      modelHl = 0;
      modelKbd = false;
      return;
    }
    if (flatModels.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      modelHl = (modelHl + 1) % flatModels.length;
      modelKbd = true;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      modelHl = (modelHl - 1 + flatModels.length) % flatModels.length;
      modelKbd = true;
      return;
    }
    if (e.key === "Enter") {
      if (!modelKbd) return;
      e.preventDefault();
      modelKbd = false;
      void pickModel(flatModels[Math.min(modelHl, flatModels.length - 1)]);
    }
  }

  function onBarPointerDown(e: PointerEvent) {
    if (modelOpen && !(e.target as Element | null)?.closest(".modelwrap")) modelOpen = false;
  }

  const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  function cycleThinking(e: MouseEvent) {
    const cur = $rpcState?.thinkingLevel;
    if (!cur) return;
    const next =
      levels[(levels.indexOf(cur) + (e.shiftKey ? -1 + levels.length : 1)) % levels.length];
    setThinkingLevel(next);
  }
</script>

<svelte:window onpointerdown={onBarPointerDown} onkeydown={onBarKeydown} />

{#if gitInfo?.repo}
  <div class="git-wrap">
    <button
      class="pill as-btn git-chip"
      title={"branch " +
        gitInfo.branch +
        (gitInfo.dirty ? ` · ${gitInfo.dirty} uncommitted` : " · clean") +
        (gitInfo.toplevel ? "\n" + gitInfo.toplevel : "")}
      onmouseenter={onChipEnter}
      onmouseleave={onChipLeave}
      onfocus={onChipEnter}
      onblur={onChipLeave}
      onclick={() => void refreshGit()}
    >
      <GitBranch size={12} strokeWidth={2} />
      <span class="git-branch mono">{gitInfo.branch || "detached"}</span>
      {#if gitInfo.dirty}<span class="git-dirty">{gitInfo.dirty}</span>{/if}
    </button>
    {#if diffHover}
      <div class="diff-pop" role="status">
        <span class="pop-added">+{diffHover.added}</span>
        <span class="pop-deleted">−{diffHover.deleted}</span>
        <span class="pop-hint"
          >working tree vs HEAD · {diffHover.files} file{diffHover.files === 1 ? "" : "s"}</span
        >
      </div>
    {/if}
  </div>
{/if}

{#if $rpcState?.model}
  <div class="modelwrap">
    <button
      class="pill as-btn"
      title="Switch model — {$rpcState.model.provider} / {$rpcState.model.id}"
      onclick={() => {
        modelOpen = !modelOpen;
        if (modelOpen) {
          modelQuery = "";
          modelHl = 0;
          modelKbd = false;
        }
      }}
    >
      {$rpcState.model.name}
      <ChevronDown size={11} />
    </button>
    {#if modelOpen}
      <div class="modelmenu" bind:this={modelMenuEl}>
        <div class="msearch">
          <input
            placeholder="Search models…"
            bind:value={modelQuery}
            spellcheck="false"
            oninput={() => (modelHl = 0)}
          />
        </div>
        {#if groupedModels.pinned.length > 0}
          <div class="msection">Pinned</div>
          {#each groupedModels.pinned as m, i (m.provider + "/" + m.id)}
            <div
              class="modelitem"
              class:active={$rpcState.model?.provider === m.provider &&
                $rpcState.model?.id === m.id}
              class:hl={modelHl === i}
              role="button"
              tabindex="0"
              onclick={() => void pickModel(m)}
              onkeydown={(e) => {
                if (e.key === "Enter") void pickModel(m);
              }}
            >
              <button
                class="star"
                class:on={pinnedSet.has(modelKey(m))}
                title={pinnedSet.has(modelKey(m)) ? "Unpin" : "Pin to top"}
                onclick={(e) => {
                  e.stopPropagation();
                  togglePinModel(m);
                }}>{pinnedSet.has(modelKey(m)) ? "★" : "☆"}</button
              >
              <span class="mn">{m.name}</span>
              <span class="mi mono">{m.provider}/{m.id}</span>
            </div>
          {/each}
        {/if}
        {#if groupedModels.rest.length > 0}
          {#if groupedModels.pinned.length > 0}<div class="msection">All models</div>{/if}
          {#each groupedModels.rest as m, i (m.provider + "/" + m.id)}
            <div
              class="modelitem"
              class:active={$rpcState.model?.provider === m.provider &&
                $rpcState.model?.id === m.id}
              class:hl={modelHl === groupedModels.pinned.length + i}
              role="button"
              tabindex="0"
              onclick={() => void pickModel(m)}
              onkeydown={(e) => {
                if (e.key === "Enter") void pickModel(m);
              }}
            >
              <button
                class="star"
                class:on={pinnedSet.has(modelKey(m))}
                title={pinnedSet.has(modelKey(m)) ? "Unpin" : "Pin to top"}
                onclick={(e) => {
                  e.stopPropagation();
                  togglePinModel(m);
                }}>{pinnedSet.has(modelKey(m)) ? "★" : "☆"}</button
              >
              <span class="mn">{m.name}</span>
              <span class="mi mono">{m.provider}/{m.id}</span>
            </div>
          {/each}
        {/if}
        {#if filteredModels.length === 0}
          <span class="modelitem dim">No models match "{modelQuery}".</span>
        {/if}
      </div>
    {/if}
  </div>
  <button
    class="pill as-btn think"
    onclick={cycleThinking}
    title="Click to cycle thinking level (Shift+click reverse)"
  >
    think: {$rpcState.thinkingLevel}
  </button>
{/if}

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-surface-2);
    border: 1px solid var(--border);
    border-radius: 99px;
    padding: 1px 9px;
    white-space: nowrap;
    color: var(--text-2);
  }
  .as-btn {
    cursor: pointer;
  }
  .as-btn:hover {
    border-color: var(--border-strong);
  }
  .git-wrap {
    position: relative;
  }
  .git-chip {
    gap: 4px;
    padding: 1px 8px;
    font-size: 10.5px;
    color: var(--text-3);
  }
  .git-chip:hover {
    color: var(--accent);
  }
  .git-branch {
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .git-dirty {
    background: color-mix(in srgb, var(--danger) 75%, transparent);
    color: #fff;
    border-radius: 99px;
    padding: 0 5px;
    font-size: 9px;
    line-height: 14px;
    font-weight: 700;
  }
  .diff-pop {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    z-index: 60;
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 6px 10px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    box-shadow: var(--shadow);
    white-space: nowrap;
    pointer-events: none;
    font-size: 11px;
    color: var(--text-2);
  }
  .pop-added {
    color: var(--ok);
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .pop-deleted {
    color: var(--danger);
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .pop-hint {
    color: var(--text-3);
  }
  .msearch {
    padding: 2px 4px 6px;
  }
  .msearch input {
    width: 100%;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 5px 8px;
    font-size: 11.5px;
    color: var(--text);
  }
  .msearch input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .msection {
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--text-3);
    padding: 4px 6px 2px;
  }
  .modelitem .star {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    font-size: 12.5px;
    padding: 0 1px;
    flex-shrink: 0;
  }
  .modelitem .star:hover {
    color: var(--accent);
  }
  .modelitem .star.on {
    color: #f5c451;
  }
  .modelwrap {
    position: relative;
  }
  .modelmenu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 90;
    min-width: 320px;
    max-height: 340px;
    overflow-y: auto;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: var(--shadow);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .modelitem {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px 9px;
    font-size: 12px;
    color: var(--text-2);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
  }
  .modelitem:hover,
  .modelitem.hl {
    background: var(--bg-surface-2);
    color: var(--text);
  }
  .modelitem.active {
    color: var(--accent);
  }
  .modelitem.dim {
    color: var(--text-3);
    cursor: default;
  }
  .mn {
    font-weight: 600;
  }
  .mi {
    font-size: 10.5px;
    color: var(--text-3);
  }
  .modelitem.active .mi {
    color: color-mix(in srgb, var(--accent) 70%, var(--text-3));
  }
</style>

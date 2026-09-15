<script lang="ts">
  import { rpcState, stats, streaming, queue, statusNote, extStatuses, models, setModel, pinnedModels } from "../lib/stores";
  import { setThinkingLevel } from "../lib/stores";
  import { ChevronDown } from "@lucide/svelte";
  import { updateCheck, checkForUpdates, applyUpdate, updateAvailable, updateStatus } from "../lib/updater";
  import type { ThinkingLevel, ModelInfo } from "../lib/types";

  function fmtCost(c: number | undefined): string {
    if (c === undefined || c === null) return "";
    if (c < 0.01) return `$${c.toFixed(4)}`;
    return `$${c.toFixed(2)}`;
  }

  function fmtTokens(n: number | undefined): string {
    if (!n) return "";
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return `${n}`;
  }

  let ctxPercent = $derived($stats?.contextUsage?.percent ?? null);
  let ctxColor = $derived(
    ctxPercent === null ? "var(--text-3)"
    : ctxPercent > 85 ? "var(--danger)"
    : ctxPercent > 60 ? "orange"
    : "var(--ok)"
  );

  const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  let levelIdx = $derived($rpcState ? levels.indexOf($rpcState.thinkingLevel) : 0);

  // Update-check visibility: version text tooltip always reports the last
  // check; a failed check or a ready update gets a clickable chip so the
  // updater can never be silently invisible again.
  let checkTime = $derived($updateCheck.at === null ? "" : new Date($updateCheck.at).toLocaleTimeString());
  let versionTitle = $derived.by(() => {
    const c = $updateCheck;
    if (c.status === "checking") return "Checking for updates…";
    if (c.status === "failed") return c.message;
    if (c.status === "current") return `Up to date — checked ${checkTime}`;
    if (c.status === "available") return c.message;
    return "Leftleg build";
  });
  let updateChip = $derived.by(() => {
    const c = $updateCheck;
    if ($updateStatus === "downloading") {
      return { cls: "ready", label: "⟳ update downloading…", title: "The update is downloading — it will install and relaunch when ready.", act: "none" as const };
    }
    if ($updateStatus === "ready") {
      return { cls: "ready", label: "⟳ update downloaded — install", title: "The update is downloaded — click to finish installing and restart.", act: "install" as const };
    }
    if (c.status === "available") {
      return { cls: "ready", label: "⟳ update ready — install", title: `${c.message} — click to install & restart`, act: "install" as const };
    }
    if (c.status === "checking") {
      return { cls: "", label: "checking for updates…", title: "Checking for updates…", act: "none" as const };
    }
    if (c.status === "failed") {
      return { cls: "warn", label: "⚠ update check failed", title: `${c.message} — click to retry`, act: "check" as const };
    }
    if (c.status === "current") {
      return { cls: "", label: "✓ up to date", title: `Up to date — checked ${checkTime}. Click to re-check.`, act: "check" as const };
    }
    return { cls: "", label: "⟳ check for updates", title: "Check for updates now", act: "check" as const };
  });
  function onUpdateClick() {
    if (updateChip.act === "install" && $updateAvailable && !["downloading", "preparing", "installing"].includes($updateStatus)) {
      void applyUpdate();
    } else if (updateChip.act === "check") {
      void checkForUpdates();
    }
  }

  // ---------- model dropdown ----------
  let modelOpen = $state(false);
  async function pickModel(m: ModelInfo) {
    modelOpen = false;
    try {
      await setModel(m.provider, m.id);
    } catch (e) {
      statusNote.set(`Couldn't switch model: ${e instanceof Error ? e.message : String(e)}`);
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

  // ---------- extension status chips ----------
  // setStatus payloads may be plain strings or JSON objects (e.g. the quality
  // extension posts {prettier:"pending",lsp:"ok",...} as one string) — parse
  // object payloads into one chip per extension with a state tone.
  const extChips = $derived.by(() => {
    const chips: { key: string; name: string; state: string; tone: "ok" | "err" | "neutral" }[] = [];
    for (const [key, raw] of Object.entries($extStatuses)) {
      const text = String(raw).trim();
      let parsed: Record<string, unknown> | null = null;
      if (text.startsWith("{")) {
        try {
          const j = JSON.parse(text);
          if (j && typeof j === "object" && !Array.isArray(j)) parsed = j as Record<string, unknown>;
        } catch { /* plain text */ }
      }
      if (parsed) {
        for (const [name, state] of Object.entries(parsed)) {
          const s = String(state).toLowerCase();
          chips.push({
            key: `${key}.${name}`,
            name,
            state: String(state),
            tone: s === "ok" || s === "ready" || s === "done" ? "ok" : s === "error" || s === "failed" ? "err" : "neutral",
          });
        }
      } else {
        chips.push({ key, name: key, state: text, tone: "neutral" });
      }
    }
    return chips;
  });
  function onStatusbarPointerDown(e: PointerEvent) {
    if (modelOpen && !(e.target as Element | null)?.closest(".modelwrap")) modelOpen = false;
  }

  function cycleThinking(e: MouseEvent) {
    const cur = $rpcState?.thinkingLevel;
    if (!cur) return;
    const next = levels[(levels.indexOf(cur) + (e.shiftKey ? -1 + levels.length : 1)) % levels.length];
    setThinkingLevel(next);
  }
</script>

<svelte:window onpointerdown={onStatusbarPointerDown} />

<footer>
  {#if $statusNote}
    <span class="note">{$statusNote}</span>
  {/if}

  <span class="pill streaming" class:active={$streaming}>
    <span class="dot"></span>
    {$streaming ? "working" : "idle"}
  </span>

  {#if $rpcState?.model}
    <div class="modelwrap">
      <button class="pill as-btn" title="Switch model — {$rpcState.model.provider} / {$rpcState.model.id}" onclick={() => { modelOpen = !modelOpen; if (modelOpen) modelQuery = ""; }}>
        {$rpcState.model.name}
        <ChevronDown size={11} />
      </button>
      {#if modelOpen}
        <div class="modelmenu">
          <div class="msearch">
            <input placeholder="Search models…" bind:value={modelQuery} spellcheck="false" />
          </div>
          {#if groupedModels.pinned.length > 0}
            <div class="msection">Pinned</div>
            {#each groupedModels.pinned as m (m.provider + "/" + m.id)}
              <div class="modelitem" class:active={$rpcState.model?.provider === m.provider && $rpcState.model?.id === m.id} role="button" tabindex="0" onclick={() => void pickModel(m)} onkeydown={(e) => { if (e.key === "Enter") void pickModel(m); }}>
                <button class="star" class:on={pinnedSet.has(modelKey(m))} title={pinnedSet.has(modelKey(m)) ? "Unpin" : "Pin to top"} onclick={(e) => { e.stopPropagation(); togglePinModel(m); }}>{pinnedSet.has(modelKey(m)) ? "★" : "☆"}</button>
                <span class="mn">{m.name}</span>
                <span class="mi mono">{m.provider}/{m.id}</span>
              </div>
            {/each}
          {/if}
          {#if groupedModels.rest.length > 0}
            {#if groupedModels.pinned.length > 0}<div class="msection">All models</div>{/if}
            {#each groupedModels.rest as m (m.provider + "/" + m.id)}
              <div class="modelitem" class:active={$rpcState.model?.provider === m.provider && $rpcState.model?.id === m.id} role="button" tabindex="0" onclick={() => void pickModel(m)} onkeydown={(e) => { if (e.key === "Enter") void pickModel(m); }}>
                <button class="star" class:on={pinnedSet.has(modelKey(m))} title={pinnedSet.has(modelKey(m)) ? "Unpin" : "Pin to top"} onclick={(e) => { e.stopPropagation(); togglePinModel(m); }}>{pinnedSet.has(modelKey(m)) ? "★" : "☆"}</button>
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
    <button class="pill as-btn" onclick={cycleThinking} title="Click to cycle thinking level (Shift+click reverse)">
      think: {$rpcState.thinkingLevel}
    </button>
  {/if}

  {#if ctxPercent !== null}
    <span class="pill ctx" title="Context window usage">
      <span class="ctxbar"><span class="fill" style="width: {Math.min(ctxPercent, 100)}%; background: {ctxColor}"></span></span>
      Context: {ctxPercent.toFixed(2)}%
    </span>
  {/if}

  {#if $stats?.tokens}
    <span class="pill" title="Session token usage">
      {fmtTokens($stats.tokens.total)} tok{#if $stats.cost} · {fmtCost($stats.cost)}{/if}
    </span>
  {/if}

  {#each extChips as c (c.key)}
    <span class="pill ext-status {c.tone}" title="Extension {c.name}: {c.state}">
      {c.name}
      <span class="ext-state">{c.state}</span>
    </span>
  {/each}

  {#if $queue.steering.length + $queue.followUp.length > 0}
    <span class="pill queued">
      queued: {$queue.steering.length + $queue.followUp.length}
    </span>
  {/if}

  {#if $rpcState && !$rpcState.autoCompactionEnabled}
    <span class="pill warn" title="Auto-compaction disabled">no auto-compact</span>
  {/if}

  <span class="spacer"></span>
  <button class="pill as-btn upd {updateChip.cls}" title={updateChip.title} onclick={onUpdateClick} disabled={updateChip.act === "none"}>
    {updateChip.label}
  </button>
  <span class="version" title={versionTitle}>v{__APP_VERSION__}</span>
</footer>

<style>
  footer {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 14px;
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
    font-size: 11.5px;
    color: var(--text-2);
    overflow: hidden;
  }
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
  .as-btn { cursor: pointer; }
  .as-btn:hover { border-color: var(--border-strong); }
  .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--text-3);
  }
  .streaming.active .dot { background: var(--accent); animation: pulse 1.1s infinite; }
  @keyframes pulse { 50% { opacity: 0.3; } }
  .streaming.active { color: var(--accent); border-color: var(--accent); }
  .ctxbar {
    width: 44px; height: 4px; border-radius: 3px;
    background: var(--bg-inset);
    overflow: hidden;
    display: inline-block;
  }
  .fill { height: 100%; display: block; border-radius: 3px; }
  .queued { color: var(--accent); border-color: var(--accent); }
  .ext-status { color: var(--text-2); border-color: var(--border-strong); }
  .warn { color: orange; border-color: orange; }
  .upd { cursor: pointer; font: inherit; }
  .upd:hover { border-color: var(--border-strong); }
  .upd.ready { color: var(--accent); border-color: var(--accent); }
  .upd.ready:hover { background: color-mix(in srgb, var(--accent) 14%, var(--bg-surface-2)); }
  .upd.warn { color: orange; border-color: orange; }
  .upd:disabled { opacity: 0.8; cursor: default; }
  .msearch { padding: 2px 4px 6px; }
  .msearch input {
    width: 100%;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 5px 8px;
    font-size: 11.5px;
    color: var(--text);
  }
  .msearch input:focus { outline: none; border-color: var(--accent); }
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
  .modelitem .star:hover { color: var(--accent); }
  .modelitem .star.on { color: #f5c451; }
  .ext-status.ok { color: var(--ok); }
  .ext-status.err { color: var(--danger); }
  .ext-state { color: var(--text-3); font-size: 10.5px; }
  .modelwrap { position: relative; }
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
  .modelitem:hover { background: var(--bg-surface-2); color: var(--text); }
  .modelitem.active { color: var(--accent); }
  .modelitem.dim { color: var(--text-3); cursor: default; }
  .mn { font-weight: 600; }
  .mi { font-size: 10.5px; color: var(--text-3); }
  .modelitem.active .mi { color: color-mix(in srgb, var(--accent) 70%, var(--text-3)); }
  .note { color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .version { color: var(--text-3); letter-spacing: 0.3px; user-select: none; }
</style>

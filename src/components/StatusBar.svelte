<script lang="ts">
  import { rpcState, stats, streaming, queue, statusNote } from "../lib/stores";
  import { setThinkingLevel } from "../lib/stores";
  import type { ThinkingLevel } from "../lib/types";

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

  function cycleThinking(e: MouseEvent) {
    const cur = $rpcState?.thinkingLevel;
    if (!cur) return;
    const next = levels[(levels.indexOf(cur) + (e.shiftKey ? -1 + levels.length : 1)) % levels.length];
    setThinkingLevel(next);
  }
</script>

<footer>
  {#if $statusNote}
    <span class="note">{$statusNote}</span>
  {/if}

  <span class="pill streaming" class:active={$streaming}>
    <span class="dot"></span>
    {$streaming ? "working" : "idle"}
  </span>

  {#if $rpcState?.model}
    <span class="pill" title="{$rpcState.model.provider} / {$rpcState.model.id}">
      {$rpcState.model.name}
    </span>
    <button class="pill as-btn" onclick={cycleThinking} title="Click to cycle thinking level (Shift+click reverse)">
      think: {$rpcState.thinkingLevel}
    </button>
  {/if}

  {#if ctxPercent !== null}
    <span class="pill ctx" title="Context window usage">
      <span class="ctxbar"><span class="fill" style="width: {Math.min(ctxPercent, 100)}%; background: {ctxColor}"></span></span>
      ctx {ctxPercent}%
    </span>
  {/if}

  {#if $stats?.tokens}
    <span class="pill" title="Session token usage">
      {fmtTokens($stats.tokens.total)} tok{#if $stats.cost} · {fmtCost($stats.cost)}{/if}
    </span>
  {/if}

  {#if $queue.steering.length + $queue.followUp.length > 0}
    <span class="pill queued">
      queued: {$queue.steering.length + $queue.followUp.length}
    </span>
  {/if}

  {#if $rpcState && !$rpcState.autoCompactionEnabled}
    <span class="pill warn" title="Auto-compaction disabled">no auto-compact</span>
  {/if}

  <span class="spacer"></span>
  <span class="version" title="Leftleg build">v{__APP_VERSION__}</span>
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
  .warn { color: orange; border-color: orange; }
  .note { color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .version { color: var(--text-3); letter-spacing: 0.3px; user-select: none; }
</style>

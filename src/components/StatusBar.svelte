<script lang="ts">
  import { rpcState, stats, queue, statusNote, extStatuses } from "../lib/stores";

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
    ctxPercent === null
      ? "var(--text-3)"
      : ctxPercent > 85
        ? "var(--danger)"
        : ctxPercent > 60
          ? "orange"
          : "var(--ok)",
  );

  // ---------- extension status chips ----------
  // setStatus payloads may be plain strings or JSON objects (e.g. the quality
  // extension posts {prettier:"pending",lsp:"ok",...} as one string) — parse
  // object payloads into one chip per extension with a state tone.
  const extChips = $derived.by(() => {
    const chips: { key: string; name: string; state: string; tone: "ok" | "err" | "neutral" }[] =
      [];
    for (const [key, raw] of Object.entries($extStatuses)) {
      const text = String(raw).trim();
      let parsed: Record<string, unknown> | null = null;
      if (text.startsWith("{")) {
        try {
          const j = JSON.parse(text);
          if (j && typeof j === "object" && !Array.isArray(j))
            parsed = j as Record<string, unknown>;
        } catch {
          /* plain text */
        }
      }
      if (parsed) {
        for (const [name, state] of Object.entries(parsed)) {
          const s = String(state).toLowerCase();
          chips.push({
            key: `${key}.${name}`,
            name,
            state: String(state),
            tone:
              s === "ok" || s === "ready" || s === "done"
                ? "ok"
                : s === "error" || s === "failed"
                  ? "err"
                  : "neutral",
          });
        }
      } else {
        chips.push({ key, name: key, state: text, tone: "neutral" });
      }
    }
    return chips;
  });
</script>

<!-- The branch chip, model selector, and thinking level live in ComposerBar
     (directly under the chat bar); the updater chip + version live in the
     sidebar footer. This footer carries run telemetry only. -->
<footer>
  {#if $statusNote}
    <span class="note">{$statusNote}</span>
  {/if}

  {#if ctxPercent !== null}
    <span class="pill ctx" title="Context window usage">
      <span class="ctxbar"
        ><span class="fill" style="width: {Math.min(ctxPercent, 100)}%; background: {ctxColor}"
        ></span></span
      >
      Context: {ctxPercent.toFixed(2)}%
    </span>
  {/if}

  {#if $stats?.tokens}
    <span class="pill" title="Session token usage">
      {fmtTokens($stats.tokens.total)} tok{#if $stats.cost}
        · {fmtCost($stats.cost)}{/if}
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
  .ctxbar {
    width: 44px;
    height: 4px;
    border-radius: 3px;
    background: var(--bg-inset);
    overflow: hidden;
    display: inline-block;
  }
  .fill {
    height: 100%;
    display: block;
    border-radius: 3px;
  }
  .queued {
    color: var(--accent);
    border-color: var(--accent);
  }
  .ext-status {
    color: var(--text-2);
    border-color: var(--border-strong);
  }
  .warn {
    color: orange;
    border-color: orange;
  }
  .ext-status.ok {
    color: var(--ok);
  }
  .ext-status.err {
    color: var(--danger);
  }
  .ext-state {
    color: var(--text-3);
    font-size: 10.5px;
  }
  .note {
    color: var(--accent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>

<script lang="ts">
  // Subagent runs, derived entirely from the transcript: the subagent
  // extension (third-party; the details shape is extension-owned) rides its
  // per-task snapshot on the tool call's `details` — heartbeats while
  // running, the final result at the end — and stores.ts keeps the latest
  // snapshot on the ToolItem. No second store: a reloaded session rebuilds
  // the same items from pi history, so this view survives project switches
  // for free. Parsing is defensive throughout — a malformed payload
  // degrades to a plainer row, never a broken panel.
  import { items } from "../lib/stores";
  import type { ToolItem } from "../lib/types";
  import { SvelteSet } from "svelte/reactivity";
  import { ChevronDown, ChevronRight } from "@lucide/svelte";

  type Tone = "run" | "ok" | "warn" | "err" | "neutral";
  type Obj = Record<string, unknown>;

  interface TaskView {
    agent: string;
    task: string;
    status: string;
    tone: Tone;
    model: string;
    tokens: number;
    cost: number;
    error: string;
  }

  interface RunView {
    id: string;
    who: string;
    excerpt: string;
    background: boolean;
    running: boolean;
    isError: boolean;
    tone: Tone;
    ts: number;
    startedAt: number;
    durationMs?: number;
    tasks: TaskView[];
    outputHead: string;
  }

  function asObj(v: unknown): Obj {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
  }
  function str(v: unknown): string {
    return typeof v === "string" ? v : "";
  }
  function num(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  }

  function toneOf(status: string, running: boolean): Tone {
    if (running) return "run";
    switch (status) {
      case "success":
      case "completed":
        return "ok";
      case "error":
      case "failed":
        return "err";
      case "partial":
      case "aborted":
      case "timeout":
      case "interrupted":
        return "warn";
      default:
        return "neutral";
    }
  }

  function fmtTokens(n: number): string {
    if (!n) return "";
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
  }
  function fmtCost(c: number): string {
    if (!c) return "";
    return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
  }
  function fmtDuration(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
  }

  function parseRun(item: ToolItem): RunView {
    let args: Obj = {};
    try {
      const parsed: unknown = JSON.parse(item.args || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Obj;
    } catch {
      /* malformed args — the row still renders from details below */
    }
    const running = item.status === "running";
    const details = asObj(item.details);
    const raw = Array.isArray(details.results) ? details.results : [];
    const tasks: TaskView[] = raw.map((r) => {
      const o = asObj(r);
      const usage = asObj(o.usage);
      const status = str(o.status) || (running ? "running" : "unknown");
      return {
        agent: str(o.agent) || "agent",
        task: str(o.task),
        status,
        tone: toneOf(status, running),
        model: str(o.model),
        tokens: num(usage.input) + num(usage.output),
        cost: num(usage.cost),
        error: str(o.errorMessage),
      };
    });
    // No heartbeat has landed yet — seed the row from the call's arguments
    // so it names what was asked for instead of a bare "agent".
    if (tasks.length === 0) {
      const seed: unknown[] = Array.isArray(args.tasks)
        ? args.tasks
        : Array.isArray(args.chain)
          ? args.chain
          : [args];
      for (const s of seed) {
        const o = asObj(s);
        tasks.push({
          agent: str(o.agent) || str(args.agent) || "agent",
          task: str(o.task),
          status: running ? "running" : "unknown",
          tone: running ? "run" : "neutral",
          model: "",
          tokens: 0,
          cost: 0,
          error: "",
        });
      }
    }
    const tone: Tone = running
      ? "run"
      : item.isError
        ? "err"
        : tasks.some((t) => t.tone === "err")
          ? "err"
          : tasks.some((t) => t.tone === "warn")
            ? "warn"
            : tasks.some((t) => t.tone === "ok")
              ? "ok"
              : "neutral";
    return {
      id: item.toolCallId,
      who: tasks.length > 1 ? `${tasks.length} agents` : (tasks[0]?.agent ?? "agent"),
      excerpt: tasks[0]?.task ?? "",
      background: Boolean(details.backgroundTaskId) || args.background === true,
      running,
      isError: !!item.isError,
      tone,
      ts: item.timestamp ?? item.startedAt ?? 0,
      startedAt: item.startedAt ?? Date.now(),
      durationMs: item.durationMs,
      tasks,
      outputHead: item.isError ? item.output.slice(0, 400) : "",
    };
  }

  const runs = $derived.by(() => {
    const list: RunView[] = [];
    for (const x of $items) {
      if (x.kind === "tool" && x.name === "subagent") list.push(parseRun(x));
    }
    // Live runs on top, then newest first.
    return list.sort((a, b) => (a.running === b.running ? b.ts - a.ts : a.running ? -1 : 1));
  });
  const runningCount = $derived(runs.filter((r) => r.running).length);

  // Elapsed time for live runs needs a clock; the interval runs only while
  // something is still in flight.
  let now = $state(Date.now());
  $effect(() => {
    if (!runs.some((r) => r.running)) return;
    const iv = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(iv);
  });

  const open = new SvelteSet<string>();
  function toggle(id: string) {
    if (open.has(id)) open.delete(id);
    else open.add(id);
  }

  function meta(r: RunView): string {
    const tokens = fmtTokens(r.tasks.reduce((n, t) => n + t.tokens, 0));
    const cost = fmtCost(r.tasks.reduce((n, t) => n + t.cost, 0));
    const parts = [
      tokens ? `${tokens} tok` : "",
      cost,
      fmtDuration(r.running ? Math.max(0, now - r.startedAt) : (r.durationMs ?? 0)),
    ].filter(Boolean);
    return parts.join(" · ");
  }
</script>

<div class="subagents">
  {#if runs.length === 0}
    <div class="empty">
      <span class="empty-title">No subagent runs in this session</span>
      <span class="empty-hint"
        >When pi delegates work through the subagent tool, each run and its per-agent progress
        appear here.</span
      >
    </div>
  {:else}
    <div class="runs-head">
      <span class="count"
        >{runs.length} run{runs.length === 1 ? "" : "s"}{runningCount > 0
          ? ` · ${runningCount} running`
          : ""}</span
      >
    </div>
    <div class="runs">
      {#each runs as r (r.id)}
        <button
          class="run"
          class:running={r.running}
          aria-expanded={open.has(r.id)}
          onclick={() => toggle(r.id)}
        >
          <span class="row1">
            <span class="chev">
              {#if open.has(r.id)}<ChevronDown size={13} strokeWidth={2} />{:else}<ChevronRight
                  size={13}
                  strokeWidth={2}
                />{/if}
            </span>
            <span class="dot {r.tone}"></span>
            <span class="who">{r.who}</span>
            {#if r.background}<span class="chip">background</span>{/if}
            <span class="spacer"></span>
            <span class="meta">{meta(r)}</span>
          </span>
          {#if r.excerpt}<span class="excerpt">{r.excerpt}</span>{/if}
        </button>
        {#if open.has(r.id)}
          <div class="detail">
            {#each r.tasks as t, i (i)}
              <div class="task">
                <div class="t-head">
                  <span class="dot {t.tone}"></span>
                  <span class="t-agent">{t.agent}</span>
                  <span class="t-status">{t.status}</span>
                  <span class="spacer"></span>
                  <span class="t-meta">
                    {#if t.model}<span>{t.model}</span>{/if}
                    {#if t.tokens}<span>{fmtTokens(t.tokens)} tok</span>{/if}
                    {#if t.cost}<span>{fmtCost(t.cost)}</span>{/if}
                  </span>
                </div>
                {#if t.task}<div class="t-task">{t.task}</div>{/if}
                {#if t.error}<div class="t-error">{t.error}</div>{/if}
              </div>
            {/each}
            {#if r.tasks.length === 0}
              <div class="t-none">No per-task details were reported.</div>
            {/if}
            {#if r.outputHead}
              <pre class="t-out">{r.outputHead}</pre>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .subagents {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }
  .empty {
    margin: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 24px;
    max-width: 280px;
    text-align: center;
    color: var(--text-3);
    font-size: 12px;
  }
  .empty-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
  }
  .runs-head {
    display: flex;
    align-items: center;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--bg-surface);
    z-index: 1;
  }
  .count {
    font-size: 11px;
    color: var(--text-3);
  }
  .runs {
    padding: 4px 0 12px;
  }
  .run {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    padding: 6px 12px;
    cursor: pointer;
    color: var(--text-2);
    font-size: 12px;
    border-radius: 0;
  }
  .run:hover {
    background: var(--bg-surface-2);
    color: var(--text);
  }
  .row1 {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .chev {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--text-3);
  }
  .run :global(svg) {
    flex-shrink: 0;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-3);
  }
  .dot.run {
    background: var(--accent);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .dot.ok {
    background: var(--ok);
  }
  .dot.err {
    background: var(--danger);
  }
  .dot.warn {
    background: orange;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  .who {
    font-weight: 600;
    font-size: 11.5px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip {
    font-size: 10px;
    color: var(--text-2);
    border: 1px solid var(--border-strong);
    border-radius: 99px;
    padding: 0 6px;
    flex-shrink: 0;
  }
  .spacer {
    flex: 1;
  }
  .meta {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-3);
    flex-shrink: 0;
    white-space: nowrap;
  }
  .excerpt {
    padding-left: 41px;
    font-size: 11px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    margin: 0 12px 6px 34px;
    border-left: 2px solid var(--border);
    padding: 2px 0 2px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .task {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .t-head {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11.5px;
  }
  .t-agent {
    font-weight: 600;
    color: var(--text);
  }
  .t-status {
    font-size: 10.5px;
    color: var(--text-3);
  }
  .t-meta {
    margin-left: auto;
    display: flex;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-3);
    white-space: nowrap;
  }
  .t-task {
    font-size: 11px;
    color: var(--text-2);
  }
  .t-error {
    font-size: 11px;
    color: var(--danger);
  }
  .t-none {
    font-size: 11px;
    color: var(--text-3);
    font-style: italic;
  }
  .t-out {
    margin: 0;
    padding: 6px 8px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-2);
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
  }
</style>

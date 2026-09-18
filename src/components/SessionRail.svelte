<script lang="ts">
  // T3-style collapsed-sidebar rail: when the full sidebar is hidden, this
  // thin strip keeps the chat manager reachable — one tick per session of
  // the scoped project (newest first), hover previews via title, click
  // switches sessions, + starts a new one. Same data pipeline as the
  // sidebar (toSidebarSessions / resolveThreadPill), so ticks and rows
  // never disagree.
  import { Plus } from "@lucide/svelte";
  import {
    activeSessionPath, newSession, openSession, pins, projectDir,
    projectScope, sessionStates, sessions, settled, visitedAt,
  } from "../lib/stores";
  import {
    formatRelativeTime, resolveThreadPill, toSidebarSessions,
  } from "../lib/sidebar-model";

  const MAX_RAIL_TICKS = 30;

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  /** Ticks for the scoped project (or the active one when no scope is set),
   * newest first. */
  const railSessions = $derived.by(() => {
    const scope = $projectScope ?? $projectDir;
    if (!scope) return [];
    const all = toSidebarSessions({
      infos: $sessions,
      statusOf: (p) => $sessionStates[p]?.status ?? "idle",
      pinnedSet: new Set($pins),
      settledSet: new Set($settled),
      seenOf: (p, ts) => ($visitedAt[p] ?? 0) >= ts,
    }).filter((s) => s.projectDir === scope);
    return [...all].sort((a, b) => b.timestampMs - a.timestampMs).slice(0, MAX_RAIL_TICKS);
  });
</script>

<aside class="rail" aria-label="Session rail">
  <button class="rail-btn" title="New session" onclick={() => newSession()}>
    <Plus size={13} strokeWidth={2.4} />
  </button>
  <div class="ticks">
    {#each railSessions as s (s.path)}
      {@const pill = resolveThreadPill(s)}
      {@const when = formatRelativeTime(s.timestampMs, now)}
      <button
        class="tick {pill?.kind ?? "idle"}"
        class:active={s.path === $activeSessionPath}
        class:dim={s.settled}
        title={pill ? `${s.title}\n${when} · ${pill.label}` : `${s.title}\n${when}`}
        aria-label={"Switch to session: " + s.title}
        onclick={() => void openSession(s.path)}
      ></button>
    {:else}
      <div class="none" title="No sessions yet"></div>
    {/each}
  </div>
</aside>

<style>
  .rail {
    flex-shrink: 0;
    width: 30px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 8px 0;
    background: var(--bg-surface);
    border-right: 1px solid var(--border);
    overflow: hidden;
  }
  .rail-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    cursor: pointer;
    flex-shrink: 0;
  }
  .rail-btn:hover { border-color: var(--accent); color: var(--accent); }
  .ticks {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 7px;
    min-height: 0;
    overflow: hidden;
    padding-top: 2px;
  }
  .tick {
    width: 14px;
    height: 3px;
    padding: 0;
    border: none;
    border-radius: 2px;
    background: color-mix(in srgb, var(--text-3) 55%, transparent);
    cursor: pointer;
    flex-shrink: 0;
    transition: width 120ms ease, background 120ms ease;
  }
  .tick:hover { background: var(--text-2); }
  .tick.active {
    width: 18px;
    background: var(--accent);
  }
  .tick.working { background: var(--accent); opacity: 1; }
  .tick.working.active { animation: rail-pulse 1.2s infinite; }
  .tick.needs-attention { background: orange; }
  .tick.failed { background: var(--danger); }
  .tick.completed { background: var(--ok); }
  .tick.dim { opacity: 0.4; }
  .tick.dim.active { opacity: 0.75; }
  .none {
    width: 14px;
    height: 3px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--text-3) 25%, transparent);
  }
  @keyframes rail-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }
</style>

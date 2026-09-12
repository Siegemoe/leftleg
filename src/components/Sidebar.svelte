<script lang="ts">
  import { newSession, openSession, sessions, projectDir, activeSessionPath, rpcState, theme, applyTheme, connected, chooseProject, refreshSessions } from "../lib/stores";

  function fmtTime(ts: string | number): string {
    const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const days = (now.getTime() - d.getTime()) / 86400000;
    if (days < 6) return d.toLocaleDateString([], { weekday: "short" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function title(s: { name: string | null; firstMessage: string | null; timestamp: string }): string {
    return s.name ?? s.firstMessage ?? "Empty session";
  }

  const themeOptions: Array<{ value: "light" | "dark" | "system"; label: string }> = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "System" },
  ];
</script>

<aside>
  <div class="brand">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round">
      <path d="M7 3v11a3 3 0 0 0 3 3h0" />
      <path d="M7 14v7" />
      <circle cx="10" cy="17" r="1.6" fill="var(--accent)" stroke="none" />
    </svg>
    <span>Leftleg</span>
  </div>

  <button class="primary new-session" onclick={() => newSession()}>+ New Session</button>

  <div class="section-label">
    Sessions
    <span class="spacer" />
    <button class="ghost refresh" title="Refresh" onclick={() => refreshSessions()}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M21 12a9 9 0 1 1-2.6-6.4" /><polyline points="21 3 21 9 15 9" />
      </svg>
    </button>
  </div>

  <div class="list">
    {#each $sessions.slice(0, 60) as s (s.path)}
      <button
        class="session"
        class:active={$activeSessionPath === s.path}
        onclick={() => openSession(s.path)}
        title="{s.cwd}
{new Date(s.timestamp).toLocaleString()}"
      >
        <span class="s-title">{title(s)}</span>
        <span class="s-meta">
          {#if s.cwd === $projectDir}
            <span class="tag">current</span>
          {/if}
          <span class="s-time">{fmtTime(s.fileModified || s.timestamp)}</span>
        </span>
      </button>
    {:else}
      <div class="empty">No sessions yet</div>
    {/each}
  </div>

  <div class="footer">
    <button class="project-btn" onclick={chooseProject} title="Change project folder">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
      <span class="proj-name">{$projectDir ? $projectDir.split(/[\\/]/).pop() : "Open folder…"}</span>
    </button>
    <div class="theme-row">
      {#each themeOptions as opt}
        <button
          class="ghost theme-btn"
          class:active={$theme === opt.value}
          onclick={() => applyTheme(opt.value)}
          title={opt.label}
        >
          {#if opt.value === "light"}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          {:else if opt.value === "dark"}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
          {:else}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M12 5v14"/><path d="M2 12h20" opacity="0"/></svg>
          {/if}
        </button>
      {/each}
    </div>
    <div class="conn" class:on={$connected}>
      {$connected ? "pi connected" : "pi offline"}
    </div>
  </div>
</aside>

<style>
  aside {
    width: var(--sidebar-w);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border);
    padding: 12px 10px;
    gap: 10px;
    min-height: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    font-size: 15px;
    letter-spacing: 0.2px;
    padding: 4px 6px 2px;
  }
  .new-session { width: 100%; padding: 8px; }
  .section-label {
    display: flex;
    align-items: center;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--text-3);
    padding: 6px 6px 2px;
  }
  .refresh { padding: 2px 4px; display: inline-flex; color: var(--text-3); }
  .list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    margin: 0 -4px;
    padding: 0 4px;
  }
  .session {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    text-align: left;
    background: transparent;
    border-color: transparent;
    border-radius: var(--radius-sm);
    padding: 7px 9px;
  }
  .session:hover { background: var(--bg-hover); }
  .session.active {
    background: var(--accent-soft);
    border-color: transparent;
  }
  .s-title {
    font-size: 12.8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .s-meta {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .s-time { font-size: 11px; color: var(--text-3); }
  .empty { color: var(--text-3); font-size: 12.5px; padding: 10px; }
  .footer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .project-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    overflow: hidden;
  }
  .proj-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .theme-row {
    display: flex;
    gap: 4px;
  }
  .theme-btn {
    flex: 1;
    display: inline-flex;
    justify-content: center;
    padding: 5px;
    color: var(--text-3);
  }
  .theme-btn.active { color: var(--accent); background: var(--accent-soft); }
  .conn {
    font-size: 11px;
    color: var(--text-3);
    text-align: center;
    padding-bottom: 2px;
  }
  .conn.on { color: var(--ok); }
</style>

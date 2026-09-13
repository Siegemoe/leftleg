<script lang="ts">
  // T3-style sessions sidebar (adapted from T3 Code's left panel, MIT — see
  // THIRD_PARTY_NOTICES.md): search + project scope in a fixed header,
  // Pinned/Active/Settled sections per project, status pills, drag-to-pin
  // with pinned reorder, row context menu, resizable width.
  import {
    activeSessionPath, applyTheme, chooseProject, connected, newSession, openSession, pins,
    projectDir, projectMeta, projectScope, renameSession, reorderPin, rpcState, sessionQuery,
    sessionStates, sessions, settingsOpen, settingsProject, sidebarWidth, theme, togglePin,
    visitedAt,
  } from "../lib/stores";
  import {
    filterSessionsByQuery, formatRelativeTime, groupSessionsByProject, projectDisplayName,
    resolveThreadPill, splitSections, toSidebarSessions, type SidebarSection, type SidebarSession,
  } from "../lib/sidebar-model";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";
  import SessionRow from "./SessionRow.svelte";

  const SETTLED_PREVIEW_COUNT = 50;

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let renamingPath = $state<string | null>(null);
  let renameValue = $state("");
  let dragPath = $state<string | null>(null);
  let dropSection = $state<SidebarSection | null>(null);
  let settledExpanded = $state<Record<string, boolean>>({});
  let showAllSettled = $state<Record<string, boolean>>({});
  let scopeOpen = $state(false);
  let scopeQuery = $state("");
  let listEl: HTMLDivElement | null = $state(null);

  const sidebarSessions = $derived.by(() =>
    toSidebarSessions({
      infos: $sessions,
      statusOf: (p) => $sessionStates[p]?.status ?? "idle",
      pinnedSet: new Set($pins),
      seenOf: (p, ts) => ($visitedAt[p] ?? 0) >= ts,
    }),
  );

  const groups = $derived.by(() =>
    groupSessionsByProject({
      sessions: sidebarSessions,
      displayName: (d) => projectDisplayName(d, $projectMeta[d]?.name),
      icon: (d) => $projectMeta[d]?.icon,
      isForgotten: (d) => !!$projectMeta[d]?.forgotten && d !== $projectDir,
      scope: $projectScope,
    }),
  );

  // The scope picker always lists every non-forgotten project, even when a
  // scope is active (otherwise you could never switch back without clearing).
  const scopeChoices = $derived.by(() => {
    const map = new Map<string, { latest: number }>();
    for (const s of sidebarSessions) {
      if ($projectMeta[s.projectDir]?.forgotten && s.projectDir !== $projectDir) continue;
      const cur = map.get(s.projectDir);
      if (!cur || s.timestampMs > cur.latest) map.set(s.projectDir, { latest: s.timestampMs });
    }
    return [...map.entries()].sort((a, b) => b[1].latest - a[1].latest);
  });

  const filteredScopeChoices = $derived.by(() => {
    const q = scopeQuery.trim().toLowerCase();
    if (!q) return scopeChoices;
    return scopeChoices.filter(([dir]) => projectDisplayName(dir, $projectMeta[dir]?.name).toLowerCase().includes(q));
  });

  const searching = $derived($sessionQuery.trim().length > 0);

  const searchResults = $derived.by(() => {
    if (!searching) return null;
    const ordered = groups.flatMap((g) => {
      const sec = splitSections({ sessions: g.sessions, pinOrder: $pins });
      return [...sec.pinned, ...sec.active, ...sec.settled];
    });
    return filterSessionsByQuery(ordered, $sessionQuery);
  });

  function displayName(dir: string): string {
    return projectDisplayName(dir, $projectMeta[dir]?.name);
  }

  function pillOf(s: SidebarSession) {
    return resolveThreadPill(s);
  }

  function timeOf(s: SidebarSession): string {
    return formatRelativeTime(s.timestampMs, now);
  }

  function openMenu(e: MouseEvent, s: SidebarSession) {
    const pinned = s.pinned;
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Open", action: () => void openSession(s.path) },
        { label: pinned ? "Unpin" : "Pin", action: () => togglePin(s.path) },
        { label: "Rename…", action: () => beginRename(s) },
        { label: "Copy path", action: () => void navigator.clipboard.writeText(s.path) },
        { label: "Copy session ID", action: () => void navigator.clipboard.writeText(s.path.split(/[\\/]/).pop() ?? s.path) },
        { label: "Project settings…", action: () => { settingsProject.set(s.projectDir); settingsOpen.set(true); } },
      ],
    };
  }

  function beginRename(s: SidebarSession) {
    renamingPath = s.path;
    renameValue = s.title === "Empty session" ? "" : s.title;
  }

  function commitRename() {
    const path = renamingPath;
    renamingPath = null;
    if (!path) return;
    const name = renameValue.trim();
    renameValue = "";
    if (!name) return;
    void renameSession(name);
  }

  function cancelRename() {
    renamingPath = null;
    renameValue = "";
  }

  // ---- drag & drop (pin / unpin / reorder pinned) ----

  function resetDrag() {
    dragPath = null;
    dropSection = null;
  }

  function onDragStart(e: DragEvent, s: SidebarSession) {
    dragPath = s.path;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", s.path);
    }
  }

  function dropOnSection(section: SidebarSection) {
    if (!dragPath) return resetDrag();
    const dragging = sidebarSessions.find((s) => s.path === dragPath);
    if (dragging) {
      if (section === "pinned" && !dragging.pinned) togglePin(dragPath);
      if (section !== "pinned" && dragging.pinned) togglePin(dragPath);
    }
    resetDrag();
  }

  function dropOnRow(target: SidebarSession) {
    if (!dragPath || dragPath === target.path) return resetDrag();
    const dragging = sidebarSessions.find((s) => s.path === dragPath);
    if (dragging && target.pinned) {
      if (!dragging.pinned) togglePin(dragPath);
      const targetIndex = $pins.indexOf(target.path);
      // Re-attempt after the pin toggle settles (pins updated synchronously).
      reorderPin(dragPath, targetIndex < 0 ? 0 : targetIndex);
    } else if (dragging && !target.pinned) {
      if (dragging.pinned) togglePin(dragPath);
    }
    resetDrag();
  }

  // ---- width resize (T3 threadSidebarWidth semantics: 208px min, capped by viewport) ----

  function startResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = $sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      const max = Math.max(208, window.innerWidth - 640);
      sidebarWidth.set(Math.min(max, Math.max(208, startWidth + ev.clientX - startX)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
  }

  /** Focus action (replaces autofocus; avoids the a11y warning). */
  function focusNow(node: HTMLElement) {
    node.focus();
  }

  const themeCycle = ["light", "dark", "system"] as const;
  function cycleTheme() {
    const next = themeCycle[(themeCycle.indexOf($theme) + 1) % themeCycle.length];
    applyTheme(next);
  }
</script>

<aside style="width: {$sidebarWidth}px">
  <div class="brand">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round">
      <path d="M7 3v11a3 3 0 0 0 3 3h0" />
      <path d="M7 14v7" />
      <circle cx="10" cy="17" r="1.6" fill="var(--accent)" stroke="none" />
    </svg>
    <span>Leftleg</span>
  </div>

  <div class="header">
    <button class="primary new-session" onclick={() => newSession()}>+ New Session</button>
    <div class="search-row">
      <div class="search">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" />
        </svg>
        <input
          placeholder="Search sessions…"
          bind:value={$sessionQuery}
          spellcheck="false"
        />
      </div>
      <div class="scope">
        <button
          class="scope-btn"
          class:on={$projectScope !== null}
          title={$projectScope ? "Filtering: " + displayName($projectScope) : "Filter threads by project"}
          onclick={() => { scopeOpen = !scopeOpen; scopeQuery = ""; }}
        >
          {#if $projectScope}
            <span class="scope-icon">{$projectMeta[$projectScope]?.icon ?? "📁"}</span>
          {:else}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
          {/if}
        </button>
        {#if scopeOpen}
          <div class="scope-pop">
            <input
              class="scope-search"
              placeholder="Search projects…"
              bind:value={scopeQuery}
              use:focusNow
              onkeydown={(e) => { if (e.key === "Escape") { scopeOpen = false; } }}
            />
            <button
              class="scope-item"
              class:selected={$projectScope === null}
              onclick={() => { projectScope.set(null); scopeOpen = false; }}
            >
              <span class="scope-icon">✳</span>
              <span class="scope-name">All projects</span>
            </button>
            {#each filteredScopeChoices as [dir] (dir)}
              <button
                class="scope-item"
                class:selected={$projectScope === dir}
                onclick={() => { projectScope.set(dir); scopeOpen = false; }}
                oncontextmenu={(e) => {
                  e.preventDefault();
                  projectScope.set(dir);
                  scopeOpen = false;
                  settingsProject.set(dir);
                  settingsOpen.set(true);
                }}
                title="Right-click for project settings"
              >
                <span class="scope-icon">{$projectMeta[dir]?.icon ?? "📁"}</span>
                <span class="scope-name">{displayName(dir)}</span>
                {#if dir === $projectDir}<span class="scope-tag">active</span>{/if}
              </button>
            {:else}
              <div class="scope-empty">No matching projects.</div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <div class="list" bind:this={listEl}>
    {#if searching}
      <div class="section-label">Results</div>
      {#each searchResults ?? [] as s (s.path)}
        <SessionRow
          session={s}
          pill={pillOf(s)}
          isActive={$activeSessionPath === s.path}
          showProject={true}
          projectLabel={displayName(s.projectDir)}
          timeLabel={timeOf(s)}
          renaming={renamingPath === s.path}
          renameValue={renameValue}
          dragging={dragPath === s.path}
          dropTarget={dropSection !== null}
          onopen={() => void openSession(s.path)}
          onpintoggle={() => togglePin(s.path)}
          onmenu={(e) => openMenu(e, s)}
          onrenamecommit={commitRename}
          onrenamecancel={cancelRename}
          onrenameinput={(v) => (renameValue = v)}
          ondragstart={(e) => onDragStart(e, s)}
          ondragend={resetDrag}
          ondroprow={() => dropOnRow(s)}
        />
      {:else}
        <div class="empty">No matches</div>
      {/each}
    {:else}
      {#each groups as g (g.dir)}
        {#if $projectScope === null && groups.length > 1}
          <div class="group-header">
            <span class="scope-icon">{g.icon ?? "📁"}</span>
            <span class="group-name" title={g.dir}>{g.displayName}</span>
            {#if g.pill}
              <span class="group-pill {g.pill.kind}">{g.pill.label}</span>
              <span class="pill-dot inline {g.pill.kind}" class:pulse={g.pill.pulse}></span>
            {/if}
            {#if g.dir === $projectDir}
              <span class="scope-tag">active</span>
            {/if}
          </div>
        {/if}
        {@const sec = splitSections({ sessions: g.sessions, pinOrder: $pins })}
        {#if sec.pinned.length > 0 || dragPath !== null}
          <button
            type="button"
            class="section-label pinned-label"
            class:drop-active={dropSection === "pinned"}
            ondragover={(e) => { e.preventDefault(); dropSection = "pinned"; }}
            ondrop={(e) => { e.preventDefault(); dropOnSection("pinned"); }}
          >
            Pinned
          </button>
        {/if}
        {#each sec.pinned as s (s.path)}
          <SessionRow
            session={s}
            pill={pillOf(s)}
            isActive={$activeSessionPath === s.path}
            showProject={false}
            timeLabel={timeOf(s)}
            renaming={renamingPath === s.path}
            renameValue={renameValue}
            dragging={dragPath === s.path}
            dropTarget={dropSection === null && dragPath !== null && dragPath !== s.path}
            onopen={() => void openSession(s.path)}
            onpintoggle={() => togglePin(s.path)}
            onmenu={(e) => openMenu(e, s)}
            onrenamecommit={commitRename}
            onrenamecancel={cancelRename}
            onrenameinput={(v) => (renameValue = v)}
            ondragstart={(e) => onDragStart(e, s)}
            ondragend={resetDrag}
            ondroprow={() => dropOnRow(s)}
          />
        {/each}
        {#if sec.active.length > 0}
          <div class="section-label">Active</div>
        {/if}
        {#each sec.active as s (s.path)}
          <SessionRow
            session={s}
            pill={pillOf(s)}
            isActive={$activeSessionPath === s.path}
            showProject={false}
            timeLabel={timeOf(s)}
            renaming={renamingPath === s.path}
            renameValue={renameValue}
            dragging={dragPath === s.path}
            dropTarget={dropSection !== null && dropSection !== "pinned"}
            onopen={() => void openSession(s.path)}
            onpintoggle={() => togglePin(s.path)}
            onmenu={(e) => openMenu(e, s)}
            onrenamecommit={commitRename}
            onrenamecancel={cancelRename}
            onrenameinput={(v) => (renameValue = v)}
            ondragstart={(e) => onDragStart(e, s)}
            ondragend={resetDrag}
            ondroprow={() => dropOnRow(s)}
          />
        {/each}
        {#if sec.settled.length > 0 || dragPath !== null}
          {@const expanded = settledExpanded[g.dir] ?? true}
          {@const visible = showAllSettled[g.dir] ? sec.settled : sec.settled.slice(0, SETTLED_PREVIEW_COUNT)}
          <button
            class="section-label as-btn settled-label"
            class:drop-active={dropSection === "settled"}
            onclick={() => (settledExpanded = { ...settledExpanded, [g.dir]: !expanded })}
            ondragover={(e) => { e.preventDefault(); dropSection = "settled"; }}
            ondrop={(e) => { e.preventDefault(); dropOnSection("settled"); }}
          >
            {expanded ? "Settled" : `Settled (${sec.settled.length})`}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" style="transform: rotate({expanded ? 90 : 0}deg)">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          {#if expanded}
            {#each visible as s (s.path)}
              <SessionRow
                session={s}
                pill={pillOf(s)}
                isActive={$activeSessionPath === s.path}
                showProject={false}
                timeLabel={timeOf(s)}
                renaming={renamingPath === s.path}
                renameValue={renameValue}
                dragging={dragPath === s.path}
                dropTarget={dropSection !== null && dropSection !== "pinned"}
                onopen={() => void openSession(s.path)}
                onpintoggle={() => togglePin(s.path)}
                onmenu={(e) => openMenu(e, s)}
                onrenamecommit={commitRename}
                onrenamecancel={cancelRename}
                onrenameinput={(v) => (renameValue = v)}
                ondragstart={(e) => onDragStart(e, s)}
                ondragend={resetDrag}
                ondroprow={() => dropOnRow(s)}
              />
            {/each}
            {#if sec.settled.length > visible.length}
              <button class="ghost show-all" onclick={() => (showAllSettled = { ...showAllSettled, [g.dir]: true })}>
                Show all {sec.settled.length}
              </button>
            {/if}
          {/if}
        {/if}
      {:else}
        <div class="empty">No sessions yet</div>
      {/each}
    {/if}
  </div>

  <button type="button" class="resize-handle" onmousedown={startResize} aria-label="Resize sidebar"></button>

  <div class="footer">
    <div class="footer-row">
      <button class="ghost icon-btn" title="Settings" onclick={() => { settingsProject.set(null); settingsOpen.set(true); }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      <button class="project-btn" onclick={chooseProject} title="Change project folder">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <span class="proj-name">{displayName($projectDir) || "Open folder…"}</span>
      </button>
      <button class="ghost icon-btn" title="Theme: {$theme} — click to cycle light / dark / system" onclick={cycleTheme}>
        {#if $theme === "light"}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        {:else if $theme === "dark"}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        {:else}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        {/if}
      </button>
    </div>
    <div class="conn" class:on={$connected}>
      {$connected ? "pi connected" : "pi offline"}
    </div>
  </div>
</aside>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
{/if}

<style>
  aside {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--bg-surface);
    min-width: 208px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px 8px;
    font-weight: 700;
    letter-spacing: 0.2px;
  }
  .header {
    padding: 0 10px 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .new-session { padding: 7px 10px; font-size: 13px; }
  .search-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .search {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-3);
    min-width: 0;
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 12px;
    outline: none;
  }
  .scope { position: relative; }
  .scope-btn {
    padding: 5px 7px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-inset);
    color: var(--text-2);
    display: inline-flex;
    align-items: center;
  }
  .scope-btn.on { border-color: var(--accent); color: var(--accent); }
  .scope-pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 50;
    width: 240px;
    max-height: 300px;
    overflow-y: auto;
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .scope-search {
    margin-bottom: 4px;
    padding: 5px 8px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 12px;
    outline: none;
  }
  .scope-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: none;
    background: transparent;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12.5px;
    color: var(--text-2);
    text-align: left;
    width: 100%;
  }
  .scope-item:hover, .scope-item.selected { background: var(--bg-surface-2); color: var(--text); }
  .scope-icon { flex-shrink: 0; }
  .scope-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scope-tag {
    flex-shrink: 0;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 99px;
    padding: 0 5px;
  }
  .scope-empty { padding: 8px; font-size: 12px; color: var(--text-3); }
  .list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 8px 12px;
    min-height: 0;
  }
  .section-label {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.7px;
    text-transform: uppercase;
    color: var(--text-3);
    padding: 10px 4px 4px;
    user-select: none;
  }
  .as-btn {
    width: 100%;
    border: 1px dashed transparent;
    background: transparent;
    cursor: pointer;
    text-align: left;
  }
  .pinned-label, .settled-label { border-radius: 6px; }
  .drop-active {
    color: var(--accent);
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .group-header {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 10px 4px 2px;
    font-size: 12px;
    font-weight: 700;
    color: var(--text-2);
  }
  .group-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group-pill { font-size: 10px; font-weight: 500; letter-spacing: 0.2px; }
  .group-pill.needs-attention { color: orange; }
  .group-pill.failed { color: var(--danger); }
  .group-pill.working { color: var(--accent); }
  .group-pill.completed { color: var(--ok); }
  .pill-dot.inline { width: 6px; height: 6px; }
  .show-all {
    width: 100%;
    text-align: center;
    font-size: 11px;
    color: var(--text-3);
    padding: 5px;
    margin-top: 2px;
  }
  .show-all:hover { color: var(--text); }
  .empty { padding: 24px 8px; font-size: 12.5px; color: var(--text-3); text-align: center; }
  .resize-handle {
    position: absolute;
    top: 0;
    right: -3px;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    z-index: 5;
    border: none;
    padding: 0;
    background: transparent;
  }
  .resize-handle:hover { background: color-mix(in srgb, var(--accent) 35%, transparent); }
  .footer { flex-shrink: 0; border-top: 1px solid var(--border); padding: 8px 10px; }
  .footer-row { display: flex; align-items: center; gap: 6px; }
  .project-btn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 9px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-inset);
    color: var(--text-2);
    font-size: 12.5px;
    min-width: 0;
  }
  .proj-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  .conn { margin-top: 6px; font-size: 10.5px; color: var(--text-3); }
  .conn.on { color: var(--ok); }
</style>

<script lang="ts">
  // T3-style sessions sidebar (adapted from T3 Code's left panel, MIT — see
  // THIRD_PARTY_NOTICES.md): search + project scope in a fixed header,
  // Pinned/Active/Settled sections per project, status pills, drag-to-pin
  // with pinned reorder, row context menu, resizable width.
  import {
    activeSessionPath, applyTheme, connected, newSession, nowTick, openSession, openNewProject,
    openProjectSettingsCard, pins,
    projectDir, projectMeta, projectScope, renameSession, reorderPin, rpcState, settled,
    sessionQuery, sessionStates, sessions, settledView, settleSession, settingsOpen,
    settingsProject, sidebarWidth, theme, togglePin, unsettleSession, visitedAt,
  } from "../lib/stores";
  import {
    filterSessionsByQuery, formatRelativeTime, groupSessionsByProject, projectDisplayName,
    resolveThreadPill, splitSections, toSidebarSessions, type SidebarSection, type SidebarSession,
  } from "../lib/sidebar-model";
  import { projectIconStyle } from "../lib/project-icons";
  import ProjectIcon from "./ProjectIcon.svelte";
  import { ChevronRight, Folder, GitBranch, Layers, List, Monitor, Moon, Plus, Search, Settings, Sun } from "@lucide/svelte";
  import { gitRepoInfo, gitDiffSummary } from "../lib/api";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";
  import SessionRow from "./SessionRow.svelte";

  const SETTLED_PREVIEW_COUNT = 50;

  const now = $derived($nowTick);

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let renamingPath = $state<string | null>(null);
  let renameValue = $state("");
  let dragPath = $state<string | null>(null);
  let dropSection = $state<SidebarSection | null>(null);
  let settledExpanded = $state<Record<string, boolean>>({});
  let showAllSettled = $state<Record<string, boolean>>({});
  let showAllActive = $state<Record<string, boolean>>({});
  let scopeOpen = $state(false);
  let scopeQuery = $state("");
  let listEl: HTMLDivElement | null = $state(null);

  const sidebarSessions = $derived.by(() =>
    toSidebarSessions({
      infos: $sessions,
      statusOf: (p) => $sessionStates[p]?.status ?? "idle",
      pinnedSet: new Set($pins),
      settledSet: new Set($settled),
      seenOf: (p, ts) => ($visitedAt[p] ?? 0) >= ts,
    }),
  );

  const groups = $derived.by(() =>
    groupSessionsByProject({
      sessions: sidebarSessions,
      displayName: (d) => projectDisplayName(d, $projectMeta[d]?.name),
      icon: (d) => $projectMeta[d]?.icon,
      color: (d) => $projectMeta[d]?.color,
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
    for (const dir of Object.keys($projectMeta)) {
      if ($projectMeta[dir]?.forgotten && dir !== $projectDir) continue;
      if (!map.has(dir)) map.set(dir, { latest: 0 });
    }
    if ($projectDir && !map.has($projectDir)) map.set($projectDir, { latest: 0 });
    return [...map.entries()].sort((a, b) => b[1].latest - a[1].latest);
  });

  const filteredScopeChoices = $derived.by(() => {
    const q = scopeQuery.trim().toLowerCase();
    if (!q) return scopeChoices;
    return scopeChoices.filter(([dir]) => projectDisplayName(dir, $projectMeta[dir]?.name).toLowerCase().includes(q));
  });

  // Close the project-scope popover on outside clicks or Escape, wherever
  // focus sits (same window-level pattern as the status bar's model picker).
  function onScopePointerDown(e: PointerEvent) {
    if (scopeOpen && !(e.target as Element | null)?.closest(".scope")) scopeOpen = false;
  }
  function onScopeWindowKeydown(e: KeyboardEvent) {
    if (scopeOpen && e.key === "Escape" && !e.defaultPrevented) scopeOpen = false;
  }

  const searching = $derived($sessionQuery.trim().length > 0);

  /** Unified history: every project's settled sessions in one list. */
  const unifiedSettled = $derived.by(() => {
    if ($settledView !== "unified") return [];
    const all = groups.flatMap((g) => splitSections({ sessions: g.sessions, pinOrder: $pins }).settled);
    return all.sort((a, b) => b.timestampMs - a.timestampMs);
  });
  const unifiedVisible = $derived(
    showAllSettled["__all__"] ? unifiedSettled : unifiedSettled.slice(0, SETTLED_PREVIEW_COUNT),
  );

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
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Open", action: () => void openSession(s.path) },
        { label: s.pinned ? "Unpin" : "Pin", action: () => togglePin(s.path) },
        { label: s.settled ? "Unsettle" : "Settle", action: () => (s.settled ? unsettleSession(s.path) : settleSession(s.path)) },
        { label: "Rename…", action: () => beginRename(s) },
        { label: "Copy path", action: () => void navigator.clipboard.writeText(s.path) },
        { label: "Copy session ID", action: () => void navigator.clipboard.writeText(($sessions.find((info) => info.path === s.path)?.sessionId ?? "")) },
        { label: "Project settings…", action: () => openProjectSettingsCard(s.projectDir) },
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
    void renameSession(name, path);
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
      if (section === "pinned") {
        if (!dragging.pinned) togglePin(dragPath);
      } else if (section === "settled") {
        // Dropping onto Settled archives the session (and unpins it).
        settleSession(dragPath);
      } else {
        // Dropping onto Active pulls it out of the archive and unpins it.
        unsettleSession(dragPath);
        if (dragging.pinned) togglePin(dragPath);
      }
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

  function startResize(e: PointerEvent) {
    // setPointerCapture keeps move/up events flowing to the handle even when
    // the cursor leaves the window, and pointercancel covers alt-tab / touch
    // interruption. The listeners live on the handle itself and die with it,
    // so a mid-drag unmount can no longer leak a live handler that kept
    // resizing on hover (the old window mousemove/mouseup pair did).
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = $sidebarWidth;
    const onMove = (ev: PointerEvent) => {
      // Sidebar sits on the left: dragging the handle right widens it.
      const max = Math.max(208, window.innerWidth - 640);
      sidebarWidth.set(Math.min(max, Math.max(208, startWidth + ev.clientX - startX)));
    };
    const stop = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  /** Focus action (replaces autofocus; avoids the a11y warning). */
  function focusNow(node: HTMLElement) {
    node.focus();
  }

  // Git checkout state for the footer chip: current branch + uncommitted
  // count, refreshed on project switch and every 30s while mounted.
  interface GitInfo { repo: boolean; branch: string; dirty: number; toplevel: string }
  let gitInfo = $state<GitInfo | null>(null);
  let gitRevision = 0;
  async function refreshGit(dir?: string) {
    const target = dir ?? $projectDir;
    const revision = ++gitRevision;
    if (!target) { gitInfo = null; return; }
    try {
      const result = await gitRepoInfo(target);
      if (revision === gitRevision && target === $projectDir) gitInfo = result;
    } catch {
      if (revision === gitRevision && target === $projectDir) gitInfo = null;
    }
  }
  // Branch-chip hover: one-line working-tree diff total (+N −M vs HEAD).
  // Debounced on hover-open and cached 5 s so pointer travel doesn't re-run
  // git; the popover is pointer-events:none, so leaving the chip is the only
  // dismiss path (no focus-handlers needed on a passive tooltip).
  interface DiffHover { added: number; deleted: number; files: number }
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
      } catch { /* hover stats are best-effort */ }
    }, 250);
  }
  function onChipLeave() {
    if (diffHoverTimer) { clearTimeout(diffHoverTimer); diffHoverTimer = null; }
    diffHoverSeq++;
    diffHover = null;
  }

  $effect(() => {
    const dir = $projectDir;
    void refreshGit(dir);
    const iv = setInterval(() => void refreshGit(), 30000);
    return () => clearInterval(iv);
  });

  const themeCycle = ["light", "dark", "system"] as const;
  function cycleTheme() {
    const next = themeCycle[(themeCycle.indexOf($theme) + 1) % themeCycle.length];
    applyTheme(next);
  }

</script>

<svelte:window onpointerdown={onScopePointerDown} onkeydown={onScopeWindowKeydown} />

<aside style="width: {$sidebarWidth}px">
  <div class="header">
    <div class="search-row">
      <div class="search">
        <Search size={13} strokeWidth={2} />
        <input
          placeholder="Search sessions…"
          bind:value={$sessionQuery}
          spellcheck="false"
        />
      </div>
      <button class="new-session-btn" title="New session" onclick={() => newSession()}>
        <Plus size={14} strokeWidth={2.4} />
      </button>
    </div>

    <div class="filter-row">
      <div class="scope">
        <button
          class="scope-btn wide"
          class:on={$projectScope !== null}
          title={$projectScope ? "Filtering: " + displayName($projectScope) : "Filter threads by project"}
          onclick={() => { scopeOpen = !scopeOpen; scopeQuery = ""; }}
        >
          {#if $projectScope}
            <span class="scope-icon" style={projectIconStyle($projectMeta[$projectScope]?.color)}><ProjectIcon icon={$projectMeta[$projectScope]?.icon} size={13} /></span>
            <span class="scope-name">{displayName($projectScope)}</span>
          {:else}
            <Folder size={13} strokeWidth={2} />
            <span class="scope-name">All projects</span>
          {/if}
        </button>
        {#if scopeOpen}
          <div class="scope-pop">
            <input
              class="scope-search"
              placeholder="Search projects…"
              bind:value={scopeQuery}
              use:focusNow
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
              <div class="scope-row">
                <button
                  class="scope-item"
                  class:selected={$projectScope === dir}
                  onclick={() => { projectScope.set(dir); scopeOpen = false; }}
                  oncontextmenu={(e) => {
                    e.preventDefault();
                    scopeOpen = false;
                    openProjectSettingsCard(dir);
                  }}
                  title="Right-click for project settings"
                >
                  <span class="scope-icon" style={projectIconStyle($projectMeta[dir]?.color)}><ProjectIcon icon={$projectMeta[dir]?.icon} size={13} /></span>
                  <span class="scope-name">{displayName(dir)}</span>
                  {#if dir === $projectDir}<span class="scope-tag">active</span>{/if}
                </button>
                <button
                  class="scope-gear"
                  title="Project settings"
                  onclick={() => { scopeOpen = false; openProjectSettingsCard(dir); }}
                >
                  <Settings size={12} strokeWidth={2} />
                </button>
              </div>
            {:else}
              <div class="scope-empty">No matching projects.</div>
            {/each}
            <div class="scope-sep"></div>
            <button class="scope-item new-project" title="Create a new project folder" onclick={() => { scopeOpen = false; openNewProject(); }}>
              <span class="scope-icon"><Plus size={13} strokeWidth={2} /></span>
              <span class="scope-name">New project…</span>
            </button>
          </div>
        {/if}
      </div>
      <button
        class="view-toggle"
        title="Switch history layout — per project ↔ one list"
        onclick={() => settledView.update((v) => (v === "per-project" ? "unified" : "per-project"))}
      >
        {#if $settledView === "per-project"}
          <Layers size={12} strokeWidth={2} />
          <span>per project</span>
        {:else}
          <List size={12} strokeWidth={2} />
          <span>one list</span>
        {/if}
      </button>
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
            <span class="scope-icon" style={projectIconStyle($projectMeta[g.dir]?.color)}><ProjectIcon icon={g.icon} size={13} /></span>
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
        {@const activeVisible = showAllActive[g.dir] ? sec.active : sec.active.slice(0, SETTLED_PREVIEW_COUNT)}
        {#each activeVisible as s (s.path)}
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
        {#if sec.active.length > activeVisible.length}
          <button class="ghost show-all" onclick={() => (showAllActive = { ...showAllActive, [g.dir]: true })}>
            Show all {sec.active.length}
          </button>
        {/if}
        {#if $settledView === "per-project" && (sec.settled.length > 0 || dragPath !== null)}
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
            <ChevronRight size={10} strokeWidth={2.4} style="transform: rotate({expanded ? 90 : 0}deg)" />
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
      {#if $settledView === "unified" && unifiedSettled.length > 0}
        {@const expanded = settledExpanded["__all__"] ?? true}
        <button
          class="section-label as-btn settled-label unified"
          class:drop-active={dropSection === "settled"}
          onclick={() => (settledExpanded = { ...settledExpanded, __all__: !expanded })}
          ondragover={(e) => { e.preventDefault(); dropSection = "settled"; }}
          ondrop={(e) => { e.preventDefault(); dropOnSection("settled"); }}
        >
          Settled ({unifiedSettled.length})
          <ChevronRight size={10} strokeWidth={2.4} style="transform: rotate({expanded ? 90 : 0}deg)" />
        </button>
        {#if expanded}
          {#each unifiedVisible as s (s.path)}
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
          {#if unifiedSettled.length > unifiedVisible.length}
            <button class="ghost show-all" onclick={() => (showAllSettled = { ...showAllSettled, __all__: true })}>
              Show all {unifiedSettled.length}
            </button>
          {/if}
        {/if}
      {/if}
    {/if}
  </div>

  <button type="button" class="resize-handle" onpointerdown={startResize} aria-label="Resize sidebar"></button>

  <div class="footer">
    <div class="footer-row">
      <button class="ghost icon-btn" title="Theme: {$theme} — click to cycle light / dark / system" onclick={cycleTheme}>
        {#if $theme === "light"}
          <Sun size={14} strokeWidth={2} />
        {:else if $theme === "dark"}
          <Moon size={14} strokeWidth={2} />
        {:else}
          <Monitor size={14} strokeWidth={2} />
        {/if}
      </button>
      <button class="ghost icon-btn" title="Settings" onclick={() => { settingsProject.set(null); settingsOpen.set(true); }}>
        <Settings size={15} strokeWidth={2} />
      </button>
    </div>
    <div class="footer-row">
      <div class="conn" class:on={$connected}>
        {$connected ? "pi connected" : "pi offline"}
      </div>
      {#if gitInfo?.repo}
        <div class="git-wrap">
          <button
            class="ghost git-chip"
            title={"branch " + gitInfo.branch + (gitInfo.dirty ? ` · ${gitInfo.dirty} uncommitted` : " · clean") + (gitInfo.toplevel ? "\n" + gitInfo.toplevel : "")}
            onmouseenter={onChipEnter}
            onmouseleave={onChipLeave}
            onclick={() => void refreshGit()}
          >
            <GitBranch size={13} strokeWidth={2} />
            <span class="git-branch mono">{gitInfo.branch || "detached"}</span>
            {#if gitInfo.dirty}<span class="git-dirty">{gitInfo.dirty}</span>{/if}
          </button>
          {#if diffHover}
            <div class="diff-pop" role="status">
              <span class="pop-added">+{diffHover.added}</span>
              <span class="pop-deleted">−{diffHover.deleted}</span>
              <span class="pop-hint">working tree vs HEAD · {diffHover.files} file{diffHover.files === 1 ? "" : "s"}</span>
            </div>
          {/if}
        </div>
      {/if}
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
  .header {
    padding: 10px 10px 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .new-session-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px 8px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    cursor: pointer;
    flex-shrink: 0;
  }
  .new-session-btn:hover { border-color: var(--accent); color: var(--accent); }
  .search-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .filter-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 2px;
  }
  .filter-row .scope { flex: 1; min-width: 0; }
  .scope-btn.wide { width: 100%; justify-content: flex-start; gap: 6px; }
  .scope-btn.wide .scope-name {
    display: inline;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .view-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    font-size: 10.5px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .view-toggle:hover { border-color: var(--accent); color: var(--accent); }
  .settled-label.unified { margin-top: 4px; }
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
    /* Left-anchored to the picker, not right: right-alignment pushed the pop
     * past the window's left edge whenever the sidebar sat near its 208px
     * minimum. The pop may now overlap the chat slightly instead of leaving
     * the screen. */
    left: 0;
    z-index: 50;
    width: 240px;
    max-width: calc(100vw - 24px);
    max-height: min(300px, calc(100vh - 140px));
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
  /* Project rows carry a hover-revealed settings gear (same idiom as
   * SessionRow's pin/menu buttons): it opens the per-project settings card
   * without switching the active project. */
  .scope-row {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 6px;
  }
  .scope-row .scope-item { flex: 1; min-width: 0; padding-right: 4px; }
  .scope-row:hover .scope-item { background: var(--bg-surface-2); color: var(--text); }
  .scope-gear {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border: none;
    background: transparent;
    border-radius: 6px;
    color: var(--text-3);
    cursor: pointer;
    opacity: 0;
  }
  .scope-row:hover .scope-gear, .scope-gear:focus-visible { opacity: 1; }
  .scope-gear:hover { color: var(--text); }
  .scope-icon { flex-shrink: 0; }
  .scope-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scope-sep { height: 1px; background: var(--border); margin: 4px 2px; flex-shrink: 0; }
  .scope-item.new-project:hover { color: var(--accent); }
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
  .footer-row + .footer-row { margin-top: 6px; }
  .project-btn {
    flex-shrink: 0;
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
  .git-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 7px;
    font-size: 10.5px;
    color: var(--text-3);
    flex-shrink: 0;
  }
  .git-chip:hover { color: var(--accent); }
  .git-branch { max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .git-dirty {
    background: color-mix(in srgb, var(--danger) 75%, transparent);
    color: #fff;
    border-radius: 99px;
    padding: 0 5px;
    font-size: 9px;
    line-height: 14px;
    font-weight: 700;
  }
  .git-wrap { position: relative; }
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
  .pop-added { color: var(--ok); font-family: var(--font-mono); font-size: 11.5px; }
  .pop-deleted { color: var(--danger); font-family: var(--font-mono); font-size: 11.5px; }
  .pop-hint { color: var(--text-3); }
  .conn { font-size: 10.5px; color: var(--text-3); }
  .conn.on { color: var(--ok); }
</style>

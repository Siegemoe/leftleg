<script lang="ts">
  // T3-style sessions sidebar (adapted from T3 Code's left panel, MIT — see
  // THIRD_PARTY_NOTICES.md): search + project scope in a fixed header,
  // Pinned/Active/Settled sections per project, status pills, drag-to-pin
  // with pinned reorder, row context menu, resizable width.
  import {
    activeSessionPath,
    applyTheme,
    connected,
    extDialog,
    newSession,
    newProjectOpen,
    nowTick,
    openSession,
    openNewProject,
    openProjectSettingsCard,
    pins,
    projectSettingsDir,
    projectDir,
    projectMeta,
    projectScope,
    renameSession,
    reorderPin,
    settled,
    fileCardOpen,
    sessionQuery,
    searchFocusTick,
    sessionStates,
    sessions,
    settledView,
    settleSession,
    settingsOpen,
    settingsProject,
    sidebarWidth,
    theme,
    togglePin,
    unsettleSession,
    visitedAt,
  } from "../lib/stores";
  import {
    filterSessionsByQuery,
    formatRelativeTime,
    groupSessionsByProject,
    projectDisplayName,
    resolveThreadPill,
    splitSections,
    toSidebarSessions,
    type SidebarSection,
    type SidebarSession,
  } from "../lib/sidebar-model";
  import { projectIconStyle } from "../lib/project-icons";
  import ProjectIcon from "./ProjectIcon.svelte";
  import {
    ChevronRight,
    Folder,
    Layers,
    List,
    Monitor,
    Moon,
    Plus,
    Search,
    Settings,
    Sun,
  } from "@lucide/svelte";
  import {
    updateCheck,
    checkForUpdates,
    applyUpdate,
    updateAvailable,
    updateStatus,
  } from "../lib/updater";
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
    // Local scratch map rebuilt on each derivation — intentionally not state
    // (a SvelteMap here would be a state write inside $derived, which throws).
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
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
    return scopeChoices.filter(([dir]) =>
      projectDisplayName(dir, $projectMeta[dir]?.name).toLowerCase().includes(q),
    );
  });

  // Close the project-scope popover on outside clicks or Escape, wherever
  // focus sits (same window-level pattern as the status bar's model picker).
  function onScopePointerDown(e: PointerEvent) {
    if (scopeOpen && !(e.target as Element | null)?.closest(".scope")) scopeOpen = false;
  }
  function onScopeWindowKeydown(e: KeyboardEvent) {
    // ExtDialog is the one layer that both outranks the popover and registers
    // later — stand down for it; so for the cards, which the accelerator can
    // open while the popover is up (z-150 above this z-50 popover). Also
    // stand down on FileCard (z-90, paints above). preventDefault so
    // later-registered lower layers stand down in turn (topmost-only Esc).
    if (!scopeOpen || e.key !== "Escape" || e.defaultPrevented) return;
    if ($extDialog || $newProjectOpen || $projectSettingsDir || $fileCardOpen) return;
    e.preventDefault();
    scopeOpen = false;
  }

  const searching = $derived($sessionQuery.trim().length > 0);

  // focusSearch keybinding (TitleBar dispatch): reveal + focus the search
  // field. Ticked so pressing the chord again re-selects what's there; the
  // initial 0 is the "nothing asked yet" state.
  let searchInput: HTMLInputElement | null = $state(null);
  $effect(() => {
    if ($searchFocusTick > 0) {
      searchInput?.focus();
      searchInput?.select();
    }
  });

  /** Unified history: every project's settled sessions in one list. */
  const unifiedSettled = $derived.by(() => {
    if ($settledView !== "unified") return [];
    const all = groups.flatMap(
      (g) => splitSections({ sessions: g.sessions, pinOrder: $pins }).settled,
    );
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
        {
          label: s.settled ? "Unsettle" : "Settle",
          action: () => (s.settled ? unsettleSession(s.path) : settleSession(s.path)),
        },
        { label: "Rename…", action: () => beginRename(s) },
        { label: "Copy path", action: () => void navigator.clipboard.writeText(s.path) },
        {
          label: "Copy session ID",
          action: () =>
            void navigator.clipboard.writeText(
              $sessions.find((info) => info.path === s.path)?.sessionId ?? "",
            ),
        },
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

  // Update-check visibility: version text tooltip always reports the last
  // check; a failed check or a ready update gets a clickable chip so the
  // updater can never be silently invisible again.
  let checkTime = $derived(
    $updateCheck.at === null ? "" : new Date($updateCheck.at).toLocaleTimeString(),
  );
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
      return {
        cls: "ready",
        label: "⟳ update downloading…",
        title: "The update is downloading — it will install and relaunch when ready.",
        act: "none" as const,
      };
    }
    if ($updateStatus === "ready") {
      return {
        cls: "ready",
        label: "⟳ update downloaded — install",
        title: "The update is downloaded — click to finish installing and restart.",
        act: "install" as const,
      };
    }
    // Preparing/installing still reports check status "available", so without
    // this branch the chip would render as a clickable "install" while
    // onUpdateClick is refusing clicks — handle the active states first.
    if ($updateStatus === "preparing" || $updateStatus === "installing") {
      return {
        cls: "ready",
        label: `⟳ update ${$updateStatus}…`,
        title: `The update is ${$updateStatus}.`,
        act: "none" as const,
      };
    }
    if (c.status === "available") {
      return {
        cls: "ready",
        label: "⟳ update ready — install",
        title: `${c.message} — click to install & restart`,
        act: "install" as const,
      };
    }
    if (c.status === "checking") {
      return {
        cls: "",
        label: "checking for updates…",
        title: "Checking for updates…",
        act: "none" as const,
      };
    }
    if (c.status === "failed") {
      return {
        cls: "warn",
        label: "⚠ update check failed",
        title: `${c.message} — click to retry`,
        act: "check" as const,
      };
    }
    if (c.status === "current") {
      return {
        cls: "",
        label: "✓ up to date",
        title: `Up to date — checked ${checkTime}. Click to re-check.`,
        act: "check" as const,
      };
    }
    return {
      cls: "",
      label: "⟳ check for updates",
      title: "Check for updates now",
      act: "check" as const,
    };
  });
  function onUpdateClick() {
    if (
      updateChip.act === "install" &&
      $updateAvailable &&
      !["downloading", "preparing", "installing"].includes($updateStatus)
    ) {
      void applyUpdate();
    } else if (updateChip.act === "check") {
      void checkForUpdates();
    }
  }

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
          bind:this={searchInput}
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
          title={$projectScope
            ? "Filtering: " + displayName($projectScope)
            : "Filter threads by project"}
          onclick={() => {
            scopeOpen = !scopeOpen;
            scopeQuery = "";
          }}
        >
          {#if $projectScope}
            <span class="scope-icon" style={projectIconStyle($projectMeta[$projectScope]?.color)}
              ><ProjectIcon icon={$projectMeta[$projectScope]?.icon} size={13} /></span
            >
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
              onclick={() => {
                projectScope.set(null);
                scopeOpen = false;
              }}
            >
              <span class="scope-icon">✳</span>
              <span class="scope-name">All projects</span>
            </button>
            {#each filteredScopeChoices as [dir] (dir)}
              <div class="scope-row">
                <button
                  class="scope-item"
                  class:selected={$projectScope === dir}
                  onclick={() => {
                    projectScope.set(dir);
                    scopeOpen = false;
                  }}
                  oncontextmenu={(e) => {
                    e.preventDefault();
                    scopeOpen = false;
                    openProjectSettingsCard(dir);
                  }}
                  title="Right-click for project settings"
                >
                  <span class="scope-icon" style={projectIconStyle($projectMeta[dir]?.color)}
                    ><ProjectIcon icon={$projectMeta[dir]?.icon} size={13} /></span
                  >
                  <span class="scope-name">{displayName(dir)}</span>
                  {#if dir === $projectDir}<span class="scope-tag">active</span>{/if}
                </button>
                <button
                  class="scope-gear"
                  title="Project settings"
                  onclick={() => {
                    scopeOpen = false;
                    openProjectSettingsCard(dir);
                  }}
                >
                  <Settings size={12} strokeWidth={2} />
                </button>
              </div>
            {:else}
              <div class="scope-empty">No matching projects.</div>
            {/each}
            <div class="scope-sep"></div>
            <button
              class="scope-item new-project"
              title="Create a new project folder"
              onclick={() => {
                scopeOpen = false;
                openNewProject();
              }}
            >
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
          {renameValue}
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
            <span class="scope-icon" style={projectIconStyle($projectMeta[g.dir]?.color)}
              ><ProjectIcon icon={g.icon} size={13} /></span
            >
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
            ondragover={(e) => {
              e.preventDefault();
              dropSection = "pinned";
            }}
            ondrop={(e) => {
              e.preventDefault();
              dropOnSection("pinned");
            }}
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
            {renameValue}
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
        {@const activeVisible = showAllActive[g.dir]
          ? sec.active
          : sec.active.slice(0, SETTLED_PREVIEW_COUNT)}
        {#each activeVisible as s (s.path)}
          <SessionRow
            session={s}
            pill={pillOf(s)}
            isActive={$activeSessionPath === s.path}
            showProject={false}
            timeLabel={timeOf(s)}
            renaming={renamingPath === s.path}
            {renameValue}
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
          <button
            class="ghost show-all"
            onclick={() => (showAllActive = { ...showAllActive, [g.dir]: true })}
          >
            Show all {sec.active.length}
          </button>
        {/if}
        {#if $settledView === "per-project" && (sec.settled.length > 0 || dragPath !== null)}
          {@const expanded = settledExpanded[g.dir] ?? true}
          {@const visible = showAllSettled[g.dir]
            ? sec.settled
            : sec.settled.slice(0, SETTLED_PREVIEW_COUNT)}
          <button
            class="section-label as-btn settled-label"
            class:drop-active={dropSection === "settled"}
            onclick={() => (settledExpanded = { ...settledExpanded, [g.dir]: !expanded })}
            ondragover={(e) => {
              e.preventDefault();
              dropSection = "settled";
            }}
            ondrop={(e) => {
              e.preventDefault();
              dropOnSection("settled");
            }}
          >
            {expanded ? "Settled" : `Settled (${sec.settled.length})`}
            <ChevronRight
              size={10}
              strokeWidth={2.4}
              style="transform: rotate({expanded ? 90 : 0}deg)"
            />
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
                {renameValue}
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
              <button
                class="ghost show-all"
                onclick={() => (showAllSettled = { ...showAllSettled, [g.dir]: true })}
              >
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
          ondragover={(e) => {
            e.preventDefault();
            dropSection = "settled";
          }}
          ondrop={(e) => {
            e.preventDefault();
            dropOnSection("settled");
          }}
        >
          Settled ({unifiedSettled.length})
          <ChevronRight
            size={10}
            strokeWidth={2.4}
            style="transform: rotate({expanded ? 90 : 0}deg)"
          />
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
              {renameValue}
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
            <button
              class="ghost show-all"
              onclick={() => (showAllSettled = { ...showAllSettled, __all__: true })}
            >
              Show all {unifiedSettled.length}
            </button>
          {/if}
        {/if}
      {/if}
    {/if}
  </div>

  <button
    type="button"
    class="resize-handle"
    onpointerdown={startResize}
    aria-label="Resize sidebar"
  ></button>

  <div class="footer">
    <div class="footer-row">
      <button
        class="ghost icon-btn"
        title="Theme: {$theme} — click to cycle light / dark / system"
        onclick={cycleTheme}
      >
        {#if $theme === "light"}
          <Sun size={14} strokeWidth={2} />
        {:else if $theme === "dark"}
          <Moon size={14} strokeWidth={2} />
        {:else}
          <Monitor size={14} strokeWidth={2} />
        {/if}
      </button>
      <button
        class="ghost icon-btn"
        title="Settings"
        onclick={() => {
          settingsProject.set(null);
          settingsOpen.set(true);
        }}
      >
        <Settings size={15} strokeWidth={2} />
      </button>
    </div>
    <div class="footer-row">
      <div class="conn" class:on={$connected}>
        {$connected ? "pi connected" : "pi offline"}
      </div>
      <span class="spacer"></span>
      <button
        class="upd {updateChip.cls}"
        title={updateChip.title}
        onclick={onUpdateClick}
        disabled={updateChip.act === "none"}
      >
        <span class="upd-label">{updateChip.label}</span>
      </button>
      <span class="version" title={versionTitle}>v{__APP_VERSION__}</span>
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
  .new-session-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
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
  .filter-row .scope {
    flex: 1;
    min-width: 0;
  }
  .scope-btn.wide {
    width: 100%;
    justify-content: flex-start;
    gap: 6px;
  }
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
  .view-toggle:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .settled-label.unified {
    margin-top: 4px;
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
  .scope {
    position: relative;
  }
  .scope-btn {
    padding: 5px 7px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-inset);
    color: var(--text-2);
    display: inline-flex;
    align-items: center;
  }
  .scope-btn.on {
    border-color: var(--accent);
    color: var(--accent);
  }
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
  .scope-item:hover,
  .scope-item.selected {
    background: var(--bg-surface-2);
    color: var(--text);
  }
  /* Project rows carry a hover-revealed settings gear (same idiom as
   * SessionRow's pin/menu buttons): it opens the per-project settings card
   * without switching the active project. */
  .scope-row {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 6px;
  }
  .scope-row .scope-item {
    flex: 1;
    min-width: 0;
    padding-right: 4px;
  }
  .scope-row:hover .scope-item {
    background: var(--bg-surface-2);
    color: var(--text);
  }
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
  .scope-row:hover .scope-gear,
  .scope-gear:focus-visible {
    opacity: 1;
  }
  .scope-gear:hover {
    color: var(--text);
  }
  .scope-icon {
    flex-shrink: 0;
  }
  .scope-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scope-sep {
    height: 1px;
    background: var(--border);
    margin: 4px 2px;
    flex-shrink: 0;
  }
  .scope-item.new-project:hover {
    color: var(--accent);
  }
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
  .scope-empty {
    padding: 8px;
    font-size: 12px;
    color: var(--text-3);
  }
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
  .pinned-label,
  .settled-label {
    border-radius: 6px;
  }
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
  .group-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-pill {
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.2px;
  }
  .group-pill.needs-attention {
    color: orange;
  }
  .group-pill.failed {
    color: var(--danger);
  }
  .group-pill.working {
    color: var(--accent);
  }
  .group-pill.completed {
    color: var(--ok);
  }
  .pill-dot.inline {
    width: 6px;
    height: 6px;
  }
  .show-all {
    width: 100%;
    text-align: center;
    font-size: 11px;
    color: var(--text-3);
    padding: 5px;
    margin-top: 2px;
  }
  .show-all:hover {
    color: var(--text);
  }
  .empty {
    padding: 24px 8px;
    font-size: 12.5px;
    color: var(--text-3);
    text-align: center;
  }
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
  .resize-handle:hover {
    background: color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .footer {
    flex-shrink: 0;
    border-top: 1px solid var(--border);
    padding: 8px 10px;
  }
  .footer-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .footer-row + .footer-row {
    margin-top: 6px;
  }
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
  .spacer {
    flex: 1;
  }
  .upd {
    display: inline-flex;
    align-items: center;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 3px 6px;
    font-size: 10.5px;
    color: var(--text-3);
    cursor: pointer;
    max-width: 120px;
    min-width: 0;
  }
  .upd-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .upd:hover {
    color: var(--text-2);
    background: var(--bg-surface-2);
  }
  .upd.ready {
    color: var(--accent);
  }
  .upd.ready:hover {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .upd.warn {
    color: orange;
  }
  .upd:disabled {
    cursor: default;
    opacity: 0.8;
  }
  .version {
    color: var(--text-3);
    font-size: 10.5px;
    letter-spacing: 0.3px;
    user-select: none;
    flex-shrink: 0;
  }
  .conn {
    font-size: 10.5px;
    color: var(--text-3);
  }
  .conn.on {
    color: var(--ok);
  }
</style>

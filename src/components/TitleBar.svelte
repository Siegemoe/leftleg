<script lang="ts">
  // Custom window title bar (window decorations are off): left-panel toggle,
  // app title, menu bar (File / Edit / View / Help), Artifacts, and window
  // controls. The bar itself is the drag region; interactive children are
  // regular elements, so clicks on them never start a window drag.
  import { PanelLeft, Images, ListTodo, Minus, Square, X } from "@lucide/svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { appDataDir } from "@tauri-apps/api/path";
  import { openPath, openUrl } from "@tauri-apps/plugin-opener";
  import { get } from "svelte/store";
  import { piRequest, piModuleInfo } from "../lib/api";
  import type { AgentMessage } from "../lib/types";
  import { checkForUpdates, applyUpdate, updateAvailable, updateStatus, updateCheck } from "../lib/updater";
  import {
    sidebarOpen, settingsOpen, settingsProject, artifactsOpen, statusNote, theme,
    projectDir, activeSessionPath, lastProcByProject,
    chooseProject, newSession, applyTheme,
  } from "../lib/stores";

  const win = getCurrentWindow();

  type MenuId = "file" | "edit" | "view" | "help";
  let openMenu: MenuId | null = $state(null);
  let aboutOpen = $state(false);

  // ---------- Status card: todos + updates + pi module ----------
  interface TodoTask { key: string; status: string; subject: string }
  let statusOpen = $state(false);
  let todos = $state<TodoTask[] | null>(null);
  let todosLoaded = $state(false);
  let piInfo = $state<{ name: string; version: string } | null>(null);
  let statusRevision = 0;

  function closeStatus() {
    statusOpen = false;
    statusRevision++;
  }

  async function openStatus() {
    if (statusOpen) return closeStatus();
    statusOpen = true;
    const revision = ++statusRevision;
    const ownerProject = get(projectDir);
    const ownerSession = get(activeSessionPath);
    const ownerProc = get(lastProcByProject)[ownerProject];
    const stillCurrent = () => revision === statusRevision
      && statusOpen
      && ownerProject === get(projectDir)
      && ownerSession === get(activeSessionPath)
      && ownerProc === get(lastProcByProject)[ownerProject];
    todos = null;
    todosLoaded = false;
    void (async () => {
      try {
        // The task list is the latest `todo` tool call in the session —
        // scan the transcript backwards for its arguments.
        const res = await piRequest<{ success: boolean; data?: { messages: AgentMessage[] } }>(
          { type: "get_messages" }, 60, ownerProject || null, ownerProc,
        );
        const msgs = res.success && Array.isArray(res.data?.messages) ? (res.data!.messages as AgentMessage[]) : [];
        let found: TodoTask[] | null = null;
        for (let i = msgs.length - 1; i >= 0 && !found; i--) {
          const content = msgs[i].content;
          const blocks = Array.isArray(content) ? content : [];
          for (const b of blocks) {
            const blk = b as { type?: string; name?: string; arguments?: { tasks?: unknown } };
            if (blk.type === "toolCall" && blk.name === "todo" && blk.arguments && Array.isArray(blk.arguments.tasks)) {
              found = (blk.arguments.tasks as TodoTask[]).map((t) => ({
                key: String(t.key ?? ""),
                status: String(t.status ?? "pending"),
                subject: String(t.subject ?? t.key ?? ""),
              }));
              break;
            }
          }
        }
        if (stillCurrent()) todos = found ?? [];
      } catch {
        if (stillCurrent()) todos = [];
      }
      if (stillCurrent()) todosLoaded = true;
    })();
    void (async () => {
      try {
        piInfo = await piModuleInfo();
      } catch {
        piInfo = null;
      }
    })();
  }

  function toggleMenu(id: MenuId) {
    openMenu = openMenu === id ? null : id;
  }
  function run(action: () => unknown | Promise<unknown>) {
    openMenu = null;
    void action();
  }
  function onGlobalPointerDown(e: PointerEvent) {
    if (openMenu && !(e.target as Element | null)?.closest(".menu")) openMenu = null;
    if (statusOpen && !(e.target as Element | null)?.closest(".statuswrap")) closeStatus();
  }
  function onGlobalKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      openMenu = null;
      if (statusOpen) closeStatus();
      aboutOpen = false;
    }
  }

  // ---------- Edit (best-effort webview editing) ----------
  function copySelection() {
    const ok = document.execCommand("copy");
    if (!ok) statusNote.set("Nothing selected to copy");
  }
  function selectAll() {
    document.execCommand("selectAll");
  }
  async function pasteIntoFocused() {
    try {
      const text = await navigator.clipboard.readText();
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (el && typeof el.value === "string" && typeof el.selectionStart === "number") {
        const start = el.selectionStart;
        const end = el.selectionEnd ?? start;
        el.value = el.value.slice(0, start) + text + el.value.slice(end);
        el.selectionStart = el.selectionEnd = start + text.length;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        statusNote.set("Click an input first, then Edit → Paste");
      }
    } catch {
      statusNote.set("Clipboard read blocked here — use Ctrl+V");
    }
  }

  // ---------- Help ----------
  async function openLogsFolder() {
    try {
      await openPath(await appDataDir() + "/logs");
    } catch (e) {
      statusNote.set(`Couldn't open logs folder: ${e}`);
    }
  }

  const repoUrl = "https://github.com/Siegemoe/leftleg";
</script>

<svelte:window onpointerdown={onGlobalPointerDown} onkeydown={onGlobalKeydown} />

<header class="titlebar" data-tauri-drag-region>
  <button
    class="tb-btn"
    title={$sidebarOpen ? "Hide sidebar" : "Show sidebar"}
    onclick={() => sidebarOpen.update((v) => !v)}
  >
    <PanelLeft size={15} strokeWidth={2} />
  </button>
  <span class="app-title" data-tauri-drag-region>Leftleg</span>

  <nav class="menubar">
    <div class="menu">
      <button class="menu-label" class:open={openMenu === "file"} onclick={() => toggleMenu("file")}>File</button>
      {#if openMenu === "file"}
        <div class="dropdown">
          <button onclick={() => run(() => newSession())}>New Session<span class="hint-key">Ctrl+N</span></button>
          <button onclick={() => run(() => chooseProject())}>Choose Project Folder…</button>
          <div class="sep"></div>
          <button onclick={() => run(() => { settingsProject.set(null); settingsOpen.set(true); })}>Settings…</button>
          <div class="sep"></div>
          <button onclick={() => run(() => win.close())}>Exit</button>
        </div>
      {/if}
    </div>
    <div class="menu">
      <button class="menu-label" class:open={openMenu === "edit"} onclick={() => toggleMenu("edit")}>Edit</button>
      {#if openMenu === "edit"}
        <div class="dropdown">
          <button onclick={() => run(copySelection)}>Copy</button>
          <button onclick={() => run(pasteIntoFocused)}>Paste</button>
          <div class="sep"></div>
          <button onclick={() => run(selectAll)}>Select All</button>
        </div>
      {/if}
    </div>
    <div class="menu">
      <button class="menu-label" class:open={openMenu === "view"} onclick={() => toggleMenu("view")}>View</button>
      {#if openMenu === "view"}
        <div class="dropdown">
          <button onclick={() => run(() => sidebarOpen.update((v) => !v))}>{"Toggle Sidebar"}<span class="hint-key">Ctrl+B</span></button>
          <button onclick={() => run(() => artifactsOpen.set(true))}>Artifacts…</button>
          <div class="sep"></div>
          <button onclick={() => run(() => applyTheme("light"))}>{$theme === "light" ? "✓ " : ""}Light Theme</button>
          <button onclick={() => run(() => applyTheme("dark"))}>{$theme === "dark" ? "✓ " : ""}Dark Theme</button>
          <button onclick={() => run(() => applyTheme("system"))}>{$theme === "system" ? "✓ " : ""}System Theme</button>
        </div>
      {/if}
    </div>
    <div class="menu">
      <button class="menu-label" class:open={openMenu === "help"} onclick={() => toggleMenu("help")}>Help</button>
      {#if openMenu === "help"}
        <div class="dropdown">
          <button onclick={() => run(() => void checkForUpdates())}>Check for Updates…</button>
          <button onclick={() => run(openLogsFolder)}>Open Logs Folder</button>
          <div class="sep"></div>
          <button onclick={() => run(() => openUrl(repoUrl))}>GitHub Repository</button>
          <div class="sep"></div>
          <button onclick={() => run(() => { aboutOpen = true; })}>About Leftleg</button>
        </div>
      {/if}
    </div>
  </nav>

  <span class="flex-spacer" data-tauri-drag-region></span>

  <button class="tb-btn artifacts" title="Browse project artifacts — images and docs" onclick={() => artifactsOpen.set(true)}>
    <Images size={14} strokeWidth={2} />
    <span>Artifacts</span>
  </button>

  <div class="statuswrap">
    <button class="tb-btn" class:open={statusOpen} title="Todos, updates, and pi module" onclick={() => void openStatus()}>
      <ListTodo size={14} strokeWidth={2} />
      <span>Status</span>
    </button>
    {#if statusOpen}
      <div class="statuscard">
        <section>
          <h4>Todos</h4>
          {#if !todosLoaded}
            <p class="dim">Loading…</p>
          {:else if !todos || todos.length === 0}
            <p class="dim">No task list in this session yet.</p>
          {:else}
            <div class="tsum">{todos.filter((t) => t.status === "completed").length}/{todos.length} done</div>
            {#each todos as t (t.key)}
              <div class="task">
                <span class="st {t.status}">{t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○"}</span>
                <span class="subj" class:done={t.status === "completed"}>{t.subject}</span>
              </div>
            {/each}
          {/if}
        </section>
        <section>
          <h4>Updates</h4>
          {#if $updateAvailable}
            <p class="okline">v{$updateAvailable.version} available</p>
            <button class="mini" disabled={["downloading", "preparing", "installing"].includes($updateStatus)} onclick={() => void applyUpdate()}>Install & restart</button>
          {:else if $updateCheck.status === "failed"}
            <p class="dim">{$updateCheck.message}</p>
            <button class="mini" onclick={() => void checkForUpdates()}>Retry check</button>
          {:else}
            <p class="dim">Up to date — checked {$updateCheck.at ? new Date($updateCheck.at).toLocaleTimeString() : "never"}</p>
            <button class="mini" onclick={() => void checkForUpdates()}>Check now</button>
          {/if}
        </section>
        <section>
          <h4>Pi module</h4>
          {#if piInfo}
            <p class="dim mono">{piInfo.name} v{piInfo.version}</p>
          {:else}
            <p class="dim">Resolving the pi install…</p>
          {/if}
        </section>
      </div>
    {/if}
  </div>

  <div class="win-controls">
    <button class="win-btn" title="Minimize" onclick={() => void win.minimize()}><Minus size={14} /></button>
    <button class="win-btn" title="Maximize / restore" onclick={() => void win.toggleMaximize()}><Square size={11} /></button>
    <button class="win-btn close" title="Close" onclick={() => void win.close()}><X size={15} /></button>
  </div>
</header>

{#if aboutOpen}
  <div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) aboutOpen = false; }} role="presentation">
    <div class="about" role="dialog" aria-modal="true">
      <h3>Leftleg</h3>
      <p class="ver">v{__APP_VERSION__}</p>
      <p class="desc">A control surface for the <a href="https://github.com/earendil-works/pi-mono" target="_blank" rel="noreferrer">Pi coding agent</a>.</p>
      <p class="desc"><a href={repoUrl} target="_blank" rel="noreferrer">GitHub repository</a></p>
      <button class="closebtn" onclick={() => (aboutOpen = false)}>Close</button>
    </div>
  </div>
{/if}

<style>
  .titlebar {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--topbar-h);
    flex-shrink: 0;
    padding: 0 6px 0 10px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    user-select: none;
  }
  .app-title {
    font-weight: 700;
    font-size: 13.5px;
    letter-spacing: 0.3px;
    padding: 0 6px;
    cursor: default;
  }
  .tb-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    cursor: pointer;
    font-size: 12px;
  }
  .tb-btn:hover { background: var(--bg-surface-2); color: var(--text); }
  .menubar { display: flex; align-items: center; gap: 2px; margin-left: 4px; }
  .menu { position: relative; }
  .menu-label {
    padding: 4px 10px;
    font-size: 12.5px;
    color: var(--text-2);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .menu-label:hover, .menu-label.open { background: var(--bg-surface-2); color: var(--text); }
  .dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 60;
    min-width: 220px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: var(--shadow);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .dropdown button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 7px 10px;
    font-size: 12.5px;
    color: var(--text-2);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
  }
  .dropdown button:hover { background: var(--bg-surface-2); color: var(--text); }
  .hint-key { font-size: 10.5px; color: var(--text-3); }
  .sep { height: 1px; background: var(--border); margin: 4px 6px; }
  .flex-spacer { flex: 1; align-self: stretch; }
  .tb-btn.artifacts { border: 1px solid var(--border); }
  .win-controls { display: flex; align-items: center; margin-left: 4px; }
  .statuswrap { position: relative; }
  .tb-btn.open { background: var(--bg-surface-2); color: var(--text); }
  .statuscard {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 70;
    width: 340px;
    max-height: 70vh;
    overflow-y: auto;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow);
    padding: 4px 12px 10px;
    display: flex;
    flex-direction: column;
  }
  .statuscard section { padding: 8px 0; border-bottom: 1px solid var(--border); }
  .statuscard section:last-child { border-bottom: none; }
  .statuscard h4 { margin: 0 0 6px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-3); }
  .dim { color: var(--text-3); font-size: 12px; margin: 2px 0; }
  .okline { color: var(--accent); font-size: 12.5px; font-weight: 600; margin: 2px 0 6px; }
  .mini { padding: 4px 12px; font-size: 11.5px; border-radius: 99px; border: 1px solid var(--border); background: transparent; color: var(--text-2); cursor: pointer; }
  .mini:hover { border-color: var(--accent); color: var(--accent); }
  .tsum { font-size: 11px; color: var(--text-3); margin-bottom: 4px; }
  .task { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; font-size: 12.5px; }
  .st { width: 14px; text-align: center; flex-shrink: 0; }
  .st.completed { color: var(--ok); }
  .st.in_progress { color: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
  .st.pending { color: var(--text-3); }
  .subj { color: var(--text-2); }
  .subj.done { color: var(--text-3); text-decoration: line-through; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .win-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: var(--topbar-h);
    background: transparent;
    border: none;
    color: var(--text-2);
    cursor: pointer;
  }
  .win-btn:hover { background: var(--bg-surface-2); color: var(--text); }
  .win-btn.close:hover { background: var(--danger); color: #fff; }
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(10, 10, 16, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 150;
  }
  .about {
    width: min(380px, 90vw);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow);
    padding: 20px 22px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .about h3 { margin: 0; font-size: 18px; }
  .ver { margin: 0; color: var(--accent); font-size: 12.5px; font-weight: 600; }
  .desc { margin: 0; font-size: 12.5px; color: var(--text-2); }
  .desc a { color: var(--accent); text-decoration: none; }
  .desc a:hover { text-decoration: underline; }
  .closebtn {
    margin-top: 10px;
    align-self: flex-end;
    padding: 5px 14px;
    border-radius: 99px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    font-size: 12px;
  }
  .closebtn:hover { border-color: var(--border-strong); color: var(--text); }
</style>

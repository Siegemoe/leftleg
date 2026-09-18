<script lang="ts">
  // Custom window title bar (window decorations are off): left-panel toggle,
  // app title, menu bar (File / Edit / View / Help), Artifacts, and window
  // controls. The bar itself is the drag region; interactive children are
  // regular elements, so clicks on them never start a window drag.
  import { PanelLeft, Images, ListTodo, Minus, Square, X, GitCompare, Globe, Terminal, FolderOpen, Workflow } from "@lucide/svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { appDataDir } from "@tauri-apps/api/path";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import {
    aboutOpen, sidebarOpen, settingsOpen, settingsProject, theme, extDialog,
    chooseProject, newSession, applyTheme, transientNote, goHome,
    openRightPanel, rightPanelOpen, rightPanelTab, homePanelCollapsed,
    openNewProject, newProjectOpen, projectSettingsDir,
    keybindings,
  } from "../lib/stores";
  import { matchKeybinding, effectiveBindings } from "../lib/keybindings";
  import { checkForUpdates } from "../lib/updater";
  import { openPathLocal, quitApp } from "../lib/api";
  import mark from "../assets/leftleg-mark.png";

  const win = getCurrentWindow();

  type MenuId = "file" | "edit" | "view" | "help";
  let openMenu: MenuId | null = $state(null);
  // The About card's open state lives in a store (aboutOpen) so the Esc
  // ladder's lower layers — FileCard's gate — can stand down for it.

  // Effective bindings (defaults + user overrides from Settings → Key
  // bindings) drive both the global keydown dispatch and the hint spans in
  // the File/View menus.
  const bindings = $derived(effectiveBindings($keybindings));

  // Dock buttons claim "open" only when the panel is actually visible: at
  // the start view homePanelCollapsed hides it even though rightPanelOpen
  // still holds the user's last choice.
  const panelShown = $derived($rightPanelOpen && !$homePanelCollapsed);

  // Status/Artifacts (and the Diff/Files docks) open as cards in the right
  // panel (openRightPanel toggles the active tab); menu items force the
  // panel open, clearing the start-view collapse too.
  function openPanelTab(tab: "status" | "artifacts" | "diff" | "files") {
    homePanelCollapsed.set(false);
    rightPanelTab.set(tab);
    rightPanelOpen.set(true);
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
  }
  function onGlobalKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      // ExtDialog (z-200) sits above everything this handler can close: with
      // one pending, Esc belongs to that layer — the dialog's own listener
      // (registered last, on demand) closes it and marks the event.
      if ($extDialog) return;
      let closed = false;
      if (openMenu) {
        openMenu = null;
        closed = true;
      }
      // The About card (z-150) is above FileCard (z-90) and the Settings
      // modal (z-100), so Esc closes About there and those layers stand down
      // on e.defaultPrevented below. The same-z cards (NewProjectCard /
      // ProjectSettingsCard, also z-150) mount after TitleBar: they paint
      // above About and register their Esc listeners later, so stand down
      // and let the card's own closer take the key.
      if ($aboutOpen && !$newProjectOpen && !$projectSettingsDir) {
        aboutOpen.set(false);
        closed = true;
      }
      // Mark the event handled so lower layers' window listeners (FileCard,
      // Settings modal, …) don't close a second layer on the same keypress.
      if (closed) e.preventDefault();
      return;
    }
    // Registry-driven accelerators (defaults + user overrides from Settings →
    // Key bindings). These keys are free in this webview, so they work while
    // typing too; step aside when a modal owns the keyboard.
    if (e.defaultPrevented || $settingsOpen || $extDialog || $projectSettingsDir || $newProjectOpen) return;
    const action = matchKeybinding(e, bindings);
    if (!action) return;
    e.preventDefault();
    openMenu = null;
    if (action === "newSession") void newSession();
    else if (action === "newProject") openNewProject();
    else if (action === "toggleSidebar") sidebarOpen.update((v) => !v);
    else if (action === "openArtifacts") openRightPanel("artifacts");
    else if (action === "openStatus") openRightPanel("status");
    else if (action === "openDiff") openRightPanel("diff");
    else if (action === "openFiles") openRightPanel("files");
  }

  // ---------- Edit (best-effort webview editing) ----------
  function copySelection() {
    const ok = document.execCommand("copy");
    if (!ok) transientNote("Nothing selected to copy");
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
        transientNote("Click an input first, then Edit → Paste");
      }
    } catch {
      transientNote("Clipboard read blocked here — use Ctrl+V");
    }
  }

  // ---------- Help ----------
  async function openLogsFolder() {
    try {
      await openPathLocal(await appDataDir() + "/logs");
    } catch (e) {
      transientNote(`Couldn't open logs folder: ${e}`);
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
  <!-- The logo returns to the start view. Interactive children never start a
       window drag, so this button opts out of the bar's drag region. -->
  <button class="app-home" title="Back to start view" onclick={() => void goHome()}>
    <span class="app-title">Leftleg</span>
    <img class="app-mark" src={mark} alt="" draggable="false" />
  </button>

  <nav class="menubar">
    <div class="menu">
      <button class="menu-label" class:open={openMenu === "file"} onclick={() => toggleMenu("file")}>File</button>
      {#if openMenu === "file"}
        <div class="dropdown">
          <button onclick={() => run(() => newSession())}>New Session{#if bindings.newSession}<span class="hint-key">{bindings.newSession}</span>{/if}</button>
          <button onclick={() => run(() => openNewProject())}>New Project…{#if bindings.newProject}<span class="hint-key">{bindings.newProject}</span>{/if}</button>
          <button onclick={() => run(() => chooseProject())}>Choose Project Folder…</button>
          <div class="sep"></div>
          <button onclick={() => run(() => { settingsProject.set(null); settingsOpen.set(true); })}>Settings…</button>
          <div class="sep"></div>
          <button onclick={() => run(() => quitApp())}>Exit</button>
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
          <button onclick={() => run(() => sidebarOpen.update((v) => !v))}>{"Toggle Sidebar"}{#if bindings.toggleSidebar}<span class="hint-key">{bindings.toggleSidebar}</span>{/if}</button>
          <button onclick={() => run(() => openPanelTab("artifacts"))}>Artifacts…{#if bindings.openArtifacts}<span class="hint-key">{bindings.openArtifacts}</span>{/if}</button>
          <button onclick={() => run(() => openPanelTab("status"))}>Status…{#if bindings.openStatus}<span class="hint-key">{bindings.openStatus}</span>{/if}</button>
          <button onclick={() => run(() => openPanelTab("diff"))}>Diff…{#if bindings.openDiff}<span class="hint-key">{bindings.openDiff}</span>{/if}</button>
          <button onclick={() => run(() => openPanelTab("files"))}>Files…{#if bindings.openFiles}<span class="hint-key">{bindings.openFiles}</span>{/if}</button>
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
          <button onclick={() => run(() => { aboutOpen.set(true); })}>About Leftleg</button>
        </div>
      {/if}
    </div>
  </nav>

  <span class="flex-spacer" data-tauri-drag-region></span>

  <button
    class="tb-btn artifacts"
    class:open={panelShown && $rightPanelTab === "artifacts"}
    title="Project artifacts — images and docs (right panel)"
    onclick={() => openRightPanel("artifacts")}
  >
    <Images size={14} strokeWidth={2} />
    <span>Artifacts</span>
  </button>

  <button
    class="tb-btn"
    class:open={panelShown && $rightPanelTab === "status"}
    title="Todos and pi module (right panel)"
    onclick={() => openRightPanel("status")}
  >
    <ListTodo size={14} strokeWidth={2} />
    <span>Status</span>
  </button>

  <!-- Placeholder docks: views arrive over time; buttons keep them visible. -->
  <button
    class="tb-btn soon"
    class:open={panelShown && $rightPanelTab === "subagents"}
    title="Subagent thread inspector — coming soon"
    onclick={() => openRightPanel("subagents")}
  >
    <Workflow size={14} strokeWidth={2} />
    <span>Subagents</span>
  </button>
  <button
    class="tb-btn"
    class:open={panelShown && $rightPanelTab === "diff"}
    title="Working-tree diff vs HEAD (right panel)"
    onclick={() => openRightPanel("diff")}
  >
    <GitCompare size={14} strokeWidth={2} />
    <span>Diff</span>
  </button>
  <button
    class="tb-btn soon"
    class:open={panelShown && $rightPanelTab === "browser"}
    title="Browser view — coming soon"
    onclick={() => openRightPanel("browser")}
  >
    <Globe size={14} strokeWidth={2} />
    <span>Browser</span>
  </button>
  <button
    class="tb-btn soon"
    class:open={panelShown && $rightPanelTab === "terminal"}
    title="Terminal view — coming soon"
    onclick={() => openRightPanel("terminal")}
  >
    <Terminal size={14} strokeWidth={2} />
    <span>Terminal</span>
  </button>
  <button
    class="tb-btn"
    class:open={panelShown && $rightPanelTab === "files"}
    title="Repo file tree — opens code files in the viewer (right panel)"
    onclick={() => openRightPanel("files")}
  >
    <FolderOpen size={14} strokeWidth={2} />
    <span>Files</span>
  </button>

  <div class="win-controls">
    <button class="win-btn" title="Minimize" onclick={() => void win.minimize()}><Minus size={14} /></button>
    <button class="win-btn" title="Maximize / restore" onclick={() => void win.toggleMaximize()}><Square size={11} /></button>
    <button class="win-btn close" title="Close" onclick={() => void win.close()}><X size={15} /></button>
  </div>
</header>

{#if $aboutOpen}
  <div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) aboutOpen.set(false); }} role="presentation">
    <div class="about" role="dialog" aria-modal="true">
      <img class="about-mark" src={mark} alt="" draggable="false" />
      <h3>Leftleg</h3>
      <p class="ver">v{__APP_VERSION__}</p>
      <p class="desc">A control surface for the <a href="https://github.com/earendil-works/pi-mono" target="_blank" rel="noreferrer">Pi coding agent</a>.</p>
      <p class="desc"><a href={repoUrl} target="_blank" rel="noreferrer">GitHub repository</a></p>
      <button class="closebtn" onclick={() => aboutOpen.set(false)}>Close</button>
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
  .app-home {
    display: inline-flex;
    align-items: center;
    background: transparent;
    border: none;
    padding: 3px 6px;
    margin-left: -6px;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .app-home:hover { background: var(--bg-surface-2); }
  .app-title {
    font-weight: 700;
    font-size: 13.5px;
    letter-spacing: 0.3px;
    padding: 0 6px;
    cursor: pointer;
  }
  .app-mark {
    height: 20px;
    width: auto;
    flex-shrink: 0;
    display: block;
    margin-left: -2px;
    pointer-events: none;
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
  .tb-btn.soon { color: var(--text-3); }
  .tb-btn.soon:hover { color: var(--text-2); }
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
  .tb-btn.open { background: var(--bg-surface-2); color: var(--text); }
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
  .about-mark { display: block; height: 52px; width: auto; margin: 0 0 4px; }
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

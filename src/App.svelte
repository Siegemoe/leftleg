<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { listen } from "@tauri-apps/api/event";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import Sidebar from "./components/Sidebar.svelte";
  import Chat from "./components/Chat.svelte";
  import StartScreen from "./components/StartScreen.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import TitleBar from "./components/TitleBar.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import ExtDialog from "./components/ExtDialog.svelte";
  import Notifications from "./components/Notifications.svelte";
  import RightPanel from "./components/RightPanel.svelte";
  import FileCard from "./components/FileCard.svelte";
  import NewProjectCard from "./components/NewProjectCard.svelte";
  import SessionRail from "./components/SessionRail.svelte";
  import { handleEvent, handlePiExit, restartPi, projectDir, sidebarOpen, settingsOpen, rightPanelOpen, statusNote, extDialog, connected, disconnected } from "./lib/stores";
  import type { PiEventEnvelope, PiExitEnvelope } from "./lib/types";
  import { boot } from "./lib/stores";
  import { reportError } from "./lib/errors";
  import { runStartupPiUpdate } from "./lib/pi-update";
  import { startupUpdateCheck, updateAvailable, updateStatus, updateError, applyUpdate, dismissUpdate } from "./lib/updater";

  let cleanup: (() => void) | null = null;

  /** Anchor clicks from rendered markdown must never navigate this webview
   * away (Tauri's default on_navigation lets it) — route them to the OS
   * browser instead. Document-level so it covers every render site, and
   * covering every button/modifier: the webview has no tabs or new windows
   * to fall into, so ctrl/cmd/middle-click fall-through would just navigate
   * the app UI away. */
  function onDocumentClick(e: MouseEvent) {
    if (e.defaultPrevented) return;
    const anchor = (e.target as HTMLElement | null)?.closest("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) { e.preventDefault(); return; }
    e.preventDefault();
    openUrl(href).catch((err) => reportError("open-link", String(err)));
  }

  onMount(() => {
    let disposed = false;
    const subscriptions: (() => void)[] = [];
    cleanup = () => { for (const off of subscriptions.splice(0)) off(); };
    void (async () => {
      // Every pi line arrives wrapped in {project, proc, event} so events from
      // background projects can be routed and stale ones dropped.
      const unlisten = await listen<PiEventEnvelope>("pi-event", (e) => {
        const p = e.payload;
        handleEvent(p.event, { project: p.project, proc: p.proc }).catch((e) => reportError("event", String(e)));
      });
      if (disposed) { unlisten(); return; }
      subscriptions.push(unlisten);
      const unlistenExit = await listen<PiExitEnvelope>("pi-exit", (e) => {
        handlePiExit(e.payload.project, e.payload.proc, e.payload.expected, e.payload.error);
      });
      if (disposed) { unlistenExit(); return; }
      subscriptions.push(unlistenExit);
      await boot();
      // Must fire post-boot: pre-boot, `navigating` is still false, so the
      // pass fast-paths the navigation wait, then skips at its re-check when
      // boot raises `navigating` mid-flight — same race every launch, no
      // debounce stamp, updater starved forever.
      runStartupPiUpdate();
    })().catch((e) => { cleanup?.(); reportError("boot", String(e)); });
    // Non-blocking startup update check — banner renders only when available.
    startupUpdateCheck();
    document.addEventListener("click", onDocumentClick, true);
    // Middle-click navigations ride auxclick, not click — same guard covers both.
    document.addEventListener("auxclick", onDocumentClick, true);
    return () => { disposed = true; cleanup?.(); document.removeEventListener("click", onDocumentClick, true); document.removeEventListener("auxclick", onDocumentClick, true); };
  });
</script>

<TitleBar />
<div class="shell">
  <div class="content">
  {#if $sidebarOpen}
    <Sidebar />
  {/if}
  {#if $projectDir}
    <SessionRail />
  {/if}
  <main>
    {#if $updateAvailable}
      <div class="update-banner">
        <span class="update-text">⟳ Update available: v{$updateAvailable.version}</span>
        {#if $updateStatus === "downloading"}
          <span class="update-progress">Downloading…</span>
        {:else if $updateStatus === "preparing"}
          <span class="update-progress">Stopping Pi safely…</span>
        {:else if $updateStatus === "installing"}
          <span class="update-progress">Starting installer…</span>
        {:else if $updateStatus === "ready"}
          <button class="update-btn" onclick={() => void applyUpdate()}>Install downloaded update</button>
        {:else}
          <button class="update-btn" onclick={() => void applyUpdate()}>Install &amp; restart</button>
        {/if}
        <button class="ghost update-dismiss" title="Dismiss" disabled={["downloading", "preparing", "installing"].includes($updateStatus)} onclick={() => void dismissUpdate()}>×</button>
        {#if $updateError}<span class="update-err">{$updateError}</span>{/if}
      </div>
    {/if}
    {#if $disconnected}
      <div class="exit-banner">
        <span>⚠ pi exited unexpectedly — your session can be restored.</span>
        <button class="resume" onclick={() => void restartPi()}>Restart &amp; resume</button>
      </div>
    {/if}
    {#if $projectDir === ""}
      <div class="startwrap" out:fade={{ duration: 140 }}>
        <StartScreen />
      </div>
    {:else}
      <div class="chatwrap" in:fade={{ duration: 140 }}>
        <Chat />
      </div>
    {/if}
  </main>
  {#if $rightPanelOpen}
    <RightPanel />
  {/if}
  </div>
  {#if $projectDir !== ""}
    <StatusBar />
  {/if}
</div>

{#if $settingsOpen}
  <SettingsModal />
{/if}

<Notifications />
<FileCard />
<NewProjectCard />

{#if $extDialog}
  <ExtDialog />
{/if}


<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: calc(100vh - var(--topbar-h));
    background: var(--bg);
  }
  .content {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .startwrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .chatwrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .exit-banner {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    background: color-mix(in srgb, var(--danger) 10%, var(--bg-surface));
    border-bottom: 1px solid var(--danger);
    color: var(--text-2);
    font-size: 12.5px;
  }
  .exit-banner .resume {
    font-size: 12px;
    padding: 3px 12px;
    border: 1px solid var(--danger);
    border-radius: 99px;
    color: var(--danger);
    background: transparent;
    cursor: pointer;
  }
  .exit-banner .resume:hover { background: var(--danger); color: #fff; }
  .update-banner {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 16px;
    background: color-mix(in srgb, var(--accent) 12%, var(--bg-surface));
    border-bottom: 1px solid var(--accent);
    color: var(--text-2);
    font-size: 12px;
  }
  .update-text { font-weight: 600; color: var(--accent); }
  .update-progress { color: var(--text-3); font-style: italic; }
  .update-btn { font-size: 11.5px; padding: 3px 14px; border-radius: 99px; border: 1px solid var(--accent); color: var(--accent); background: transparent; cursor: pointer; }
  .update-btn:hover { background: var(--accent); color: #fff; }
  .update-dismiss { font-size: 14px; padding: 0 5px; color: var(--text-3); }
  .update-err { color: var(--danger); font-size: 11px; }
</style>

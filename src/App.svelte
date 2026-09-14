<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { PanelLeft } from "@lucide/svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Chat from "./components/Chat.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import ExtDialog from "./components/ExtDialog.svelte";
  import Notifications from "./components/Notifications.svelte";
  import { handleEvent, handlePiExit, restartPi, projectDir, sidebarOpen, settingsOpen, statusNote, extDialog, connected, disconnected } from "./lib/stores";
  import type { PiEventEnvelope, PiExitEnvelope } from "./lib/types";
  import { boot } from "./lib/stores";
  import { reportError } from "./lib/errors";
  import { startupUpdateCheck, updateAvailable, updateStatus, updateError, applyUpdate } from "./lib/updater";

  let cleanup: (() => void) | null = null;

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
    })().catch((e) => { cleanup?.(); reportError("boot", String(e)); });
    // Non-blocking startup update check — banner renders only when available.
    startupUpdateCheck();
    return () => { disposed = true; cleanup?.(); };
  });
</script>

<div class="shell">
  {#if $sidebarOpen}
    <Sidebar />
  {/if}
  <main>
    <header class="topbar">
      <button
        class="ghost icon"
        title={$sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        onclick={() => sidebarOpen.update((v) => !v)}
      >
        <PanelLeft size={17} strokeWidth={2} />
      </button>
      <span class="project mono" title={$projectDir}>{$projectDir || "no project"}</span>
      <span class="spacer"></span>
    </header>
    {#if $updateAvailable}
      <div class="update-banner">
        <span class="update-text">⟳ Update available: v{$updateAvailable.version}</span>
        {#if $updateStatus === "downloading"}
          <span class="update-progress">Downloading…</span>
        {:else if $updateStatus === "ready"}
          <span class="update-progress">Relaunching…</span>
        {:else}
          <button class="update-btn" onclick={() => void applyUpdate()}>Install &amp; restart</button>
        {/if}
        <button class="ghost update-dismiss" title="Dismiss" onclick={() => updateAvailable.set(null)}>×</button>
        {#if $updateError}<span class="update-err">{$updateError}</span>{/if}
      </div>
    {/if}
    {#if $disconnected}
      <div class="exit-banner">
        <span>⚠ pi exited unexpectedly — your session can be restored.</span>
        <button class="resume" onclick={() => void restartPi()}>Restart &amp; resume</button>
      </div>
    {/if}
    <Chat />
    <StatusBar />
  </main>
</div>

{#if $settingsOpen}
  <SettingsModal />
{/if}

<Notifications />

{#if $extDialog}
  <ExtDialog />
{/if}

<style>
  .shell {
    display: flex;
    height: 100vh;
    background: var(--bg);
  }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .topbar {
    height: var(--topbar-h);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px;
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
  .project {
    color: var(--text-3);
    font-size: 12px;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
</style>

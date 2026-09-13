<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import Sidebar from "./components/Sidebar.svelte";
  import Chat from "./components/Chat.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import ExtDialog from "./components/ExtDialog.svelte";
  import Notifications from "./components/Notifications.svelte";
  import { handleEvent, handlePiExit, restartPi, projectDir, sidebarOpen, settingsOpen, statusNote, extDialog, connected, disconnected } from "./lib/stores";
  import type { PiEvent, PiExitEvent } from "./lib/types";

  let cleanup: (() => void) | null = null;

  onMount(() => {
    void (async () => {
      const unlisten = await listen<PiEvent>("pi-event", (e) => {
        handleEvent(e.payload).catch(console.error);
      });
      const unlistenExit = await listen<PiExitEvent>("pi-exit", (e) => {
        handlePiExit(e.payload?.expected ?? false);
      });
      cleanup = () => { unlisten(); unlistenExit(); };
    })();
    return () => cleanup?.();
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
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="9" y1="4" x2="9" y2="20" />
        </svg>
      </button>
      <span class="project mono" title={$projectDir}>{$projectDir || "no project"}</span>
      <span class="spacer"></span>
    </header>
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

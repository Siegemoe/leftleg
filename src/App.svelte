<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import Sidebar from "./components/Sidebar.svelte";
  import Chat from "./components/Chat.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import ExtDialog from "./components/ExtDialog.svelte";
  import { handleEvent, projectDir, sidebarOpen, settingsOpen, statusNote, extDialog, connected } from "./lib/stores";
  import type { PiEvent } from "./lib/types";

  let cleanup: (() => void) | null = null;

  onMount(async () => {
    const unlisten = await listen<PiEvent>("pi-event", (e) => {
      handleEvent(e.payload).catch(console.error);
    });
    const unlistenExit = await listen("pi-exit", () => {
      connected.set(false);
      statusNote.set("pi process exited unexpectedly — reopen the project from the sidebar");
      setTimeout(() => statusNote.set(""), 10000);
    });
    cleanup = () => { unlisten(); unlistenExit(); };
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
      <span class="spacer" />
      <button class="ghost" onclick={() => settingsOpen.set(true)}>Settings</button>
    </header>
    <Chat />
    <StatusBar />
  </main>
</div>

{#if $settingsOpen}
  <SettingsModal />
{/if}

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

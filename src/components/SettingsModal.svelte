<script lang="ts">
  // Thin shell hosting the full settings workspace. All prior settings
  // functionality (runtime controls, theme, project presentation, extension
  // commands, session actions) moved into SettingsWorkspace categories.
  import { settingsOpen, projectDir, lastProcByProject, navigating } from "../lib/stores";
  import SettingsWorkspace from "./settings/SettingsWorkspace.svelte";

  let close = () => settingsOpen.set(false);
</script>

<div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) close(); }} role="presentation">
  <div class="panel" role="dialog" aria-modal="true">
    <header>
      <h2>Settings</h2>
      <span class="sub">Pi 0.85.1 configuration via the settings-mgmt companion + native RPC</span>
      <button class="ghost x" onclick={close}>✕</button>
    </header>
    {#if $navigating}
      <p>Opening session…</p>
    {:else}
      {#key `${$projectDir}:${$lastProcByProject[$projectDir]}`}
        <SettingsWorkspace />
      {/key}
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(10, 10, 16, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .panel {
    width: min(1120px, 95vw);
    height: min(820px, 92vh);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  h2 { margin: 0; font-size: 16px; }
  .sub { flex: 1; font-size: 11px; color: var(--text-3); }
  .x { padding: 4px 9px; }
</style>

<script lang="ts">
  // Thin shell hosting the full settings workspace. All prior settings
  // functionality (runtime controls, theme, project presentation, extension
  // commands, session actions) moved into SettingsWorkspace categories.
  import { settingsOpen, settingsProject, projectDir, lastProcByProject, navigating, extDialog } from "../lib/stores";
  import SettingsWorkspace from "./settings/SettingsWorkspace.svelte";

  // Mirrors the workspace's draft state (pushed via onDirtyChange): closing
  // must confirm before discarding unsaved edits, like switchScope does.
  let dirty = $state(false);

  let close = () => {
    if (dirty && !confirm("Discard unsaved edits for the current scope?")) return;
    settingsProject.set(null);
    settingsOpen.set(false);
  };

  // Escape closes the modal — Esc is documented as reserved for closing
  // menus and dialogs (Key bindings section). ExtDialog (z-200) outranks it:
  // stand down while a question is pending. The z-150 cards cannot co-open
  // with Settings, so they need no stand-down. While a key-binding capture is
  // armed, the workspace's capture-phase window listener stops propagation
  // before this handler sees the key — Esc cancels the capture instead.
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || $extDialog) return;
    e.preventDefault();
    close();
  }

  // Remount key. Beyond the foreground project and its process generation,
  // the scoped project (per-project card → Advanced settings…) and ITS
  // generation are included: a card-hop must remount the workspace bound to
  // the right companion, and a target process replacement must rebind with
  // fresh data instead of saving through a stale one.
  const workspaceKey = $derived.by(() => {
    const scoped = $settingsProject;
    return [
      scoped ?? "",
      scoped ? $lastProcByProject[scoped] ?? "none" : "",
      $projectDir,
      $lastProcByProject[$projectDir] ?? "none",
    ].join("|");
  });
</script>

<svelte:window onkeydown={onKeydown} />

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
      {#key workspaceKey}
        <SettingsWorkspace onDirtyChange={(d) => (dirty = d)} />
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

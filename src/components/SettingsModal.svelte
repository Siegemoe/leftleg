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
  // menus and dialogs (Key bindings section). This modal mounts on demand,
  // so its listener registers after every always-mounted one (TitleBar,
  // FileCard, the z-150 cards) but before or after ExtDialog's depending on
  // which opened first — two stand-downs cover both orders:
  // - $extDialog store gate: when the dialog arrived while this modal was
  //   already up, the dialog's listener registers LATER, so its
  //   preventDefault would never be seen here — the store read (z-200
  //   outranks z-100) is the only signal in that order.
  // - e.defaultPrevented: when a closer registered EARLIER (TitleBar
  //   menus/About, the z-150 cards over this modal) handled this Esc, it
  //   already marked the event — stand down so one key closes one layer.
  // While a key-binding capture is armed, the workspace's capture-phase
  // window listener stops propagation before this handler sees the key —
  // Esc cancels the capture instead.
  function onKeydown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key !== "Escape" || $extDialog) return;
    e.preventDefault();
    close();
  }

  // Remount key. The workspace binds to exactly one project — the scoped one
  // (per-project card → Advanced settings…) when set, the foreground one
  // otherwise — so the key names that binding and ITS process generation
  // only: a card-hop re-keys onto the right companion, a target process
  // replacement rebinds with fresh data instead of saving through a stale
  // one, and an unrelated foreground process death/restart can no longer
  // re-key (and silently discard, with no confirm) a scoped draft.
  const workspaceKey = $derived.by(() => {
    const scoped = $settingsProject;
    if (scoped) return `scoped|${scoped}|${$lastProcByProject[scoped] ?? "none"}`;
    return `foreground|${$projectDir}|${$lastProcByProject[$projectDir] ?? "none"}`;
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

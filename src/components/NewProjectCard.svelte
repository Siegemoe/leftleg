<script lang="ts">
  // "Create a new project" card: one plain folder created under a parent
  // picked in the native folder dialog — which the Rust command itself opens
  // when Create is pressed, so the webview never supplies a path — then pi
  // starts in it immediately. Reachable from the sidebar scope picker, the
  // settings project manager, and the File menu.
  import { X } from "@lucide/svelte";
  import { newProjectOpen, createProject, extDialog, projectSettingsDir } from "../lib/stores";

  let name = $state("");
  let error = $state("");
  let busy = $state(false);

  // The component stays mounted; without this a failed attempt would still
  // be showing its error the next time the card opens.
  $effect(() => {
    if ($newProjectOpen) {
      name = "";
      error = "";
    }
  });

  /** Focus action (replaces autofocus; avoids the a11y warning). */
  function focusNow(node: HTMLElement) {
    node.focus();
  }

  function close() {
    if (busy) return;
    newProjectOpen.set(false);
  }

  function onKeydown(e: KeyboardEvent) {
    // An earlier-registered closer (TitleBar: menus/About; FileCard) that
    // handled this Esc marks it with preventDefault — stand down so exactly
    // one layer closes per keypress. The store gates below cover the reverse
    // order: this listener mounts unconditionally, BEFORE the on-demand
    // modals (Settings z-100, ExtDialog z-200), so their closers run after
    // this one and their preventDefault would never be seen here.
    if (e.defaultPrevented) return;
    if (!$newProjectOpen) return;
    // The card sits ABOVE the settings modal (z-150 vs z-100), so Esc closes
    // the card even when settings is open — only ExtDialog (z-200) and the
    // per-project settings card (same z, mounted after) outrank it.
    if (e.key === "Escape" && !$extDialog && !$projectSettingsDir) {
      e.preventDefault();
      close();
    }
  }

  // Client-side mirror of the native name gate so an obviously bad name
  // disables Create instead of waiting for the error round-trip. JS strings
  // are UTF-16, so `.length` matches the Rust 200-unit rule exactly.
  const nameValid = $derived(
    name.trim().length > 0 &&
      name.trim().length <= 200 &&
      name.trim() !== "." &&
      name.trim() !== ".." &&
      !/[\\/:*?"<>|]/.test(name) &&
      !/[.\s]$/.test(name.trim()) &&
      ![...name.trim()].some((c) => c.charCodeAt(0) < 0x20) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name.trim()),
  );
  const canCreate = $derived(nameValid && !busy);

  async function submit() {
    if (!canCreate) return;
    busy = true;
    error = "";
    try {
      const created = await createProject(name);
      if (created === null) return; // folder dialog cancelled — card stays open
      // Closed + noted by createProject on success.
      name = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if $newProjectOpen}
  <div
    class="overlay"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
    role="presentation"
  >
    <div class="card" role="dialog" aria-modal="true" aria-label="New project">
      <header class="card-head">
        <h3>New project</h3>
        <button class="ghost icon" title="Close (Esc)" onclick={close} disabled={busy}
          ><X size={14} strokeWidth={2} /></button
        >
      </header>
      <div class="card-body">
        <label class="field">
          <span class="label">Folder name</span>
          <input
            bind:value={name}
            placeholder="my-project"
            spellcheck="false"
            use:focusNow
            disabled={busy}
            onkeydown={(e) => {
              if (e.key === "Enter" && canCreate) void submit();
            }}
          />
        </label>
        {#if error}<p class="error">{error}</p>{/if}
        <p class="hint">
          Leftleg asks for the parent folder when you create, makes the folder there, then starts pi
          in it. The folder shows up in the sidebar like any other project.
        </p>
      </div>
      <footer class="card-foot">
        <button class="ghost" onclick={close} disabled={busy}>Cancel</button>
        <button class="primary" disabled={!canCreate} onclick={() => void submit()}
          >{busy ? "Creating…" : "Create project"}</button
        >
      </footer>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(10, 10, 16, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 150;
  }
  .card {
    width: min(440px, 92vw);
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    border-radius: 14px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--border);
  }
  .card-head h3 {
    margin: 0;
    font-size: 14px;
  }
  .card-body {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .label {
    font-size: 11px;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .field input {
    padding: 7px 10px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 12.5px;
    outline: none;
  }
  .field input:focus {
    border-color: var(--accent);
  }
  .error {
    margin: 0;
    font-size: 12px;
    color: var(--danger);
  }
  .hint {
    margin: 0;
    font-size: 11.5px;
    color: var(--text-3);
  }
  .card-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 14px 12px;
    border-top: 1px solid var(--border);
  }
  .ghost {
    padding: 6px 14px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 99px;
    color: var(--text-2);
    cursor: pointer;
    font-size: 12px;
  }
  .ghost:hover {
    border-color: var(--border-strong);
    color: var(--text);
  }
  .ghost:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .ghost.icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-2);
  }
  .ghost.icon:hover {
    background: var(--bg-surface-2);
  }
  .primary {
    padding: 6px 16px;
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 99px;
    color: var(--on-accent);
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
  }
  .primary:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>

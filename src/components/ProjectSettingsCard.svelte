<script lang="ts">
  // Per-project settings card: the presentation controls the Settings modal's
  // projects section offers (rename, icon, color, hide/restore), reachable
  // from the sidebar scope picker without switching the active project.
  // Reachable via openProjectSettingsCard(dir); null = closed.
  import { X, FolderOpen, EyeOff, RotateCcw } from "@lucide/svelte";
  import { untrack } from "svelte";
  import ProjectIcon from "./ProjectIcon.svelte";
  import {
    PROJECT_COLOR_CHOICES, PROJECT_ICON_CHOICES, projectIconLabel, projectIconStyle,
  } from "../lib/project-icons";
  import { projectDisplayName } from "../lib/sidebar-model";
  import { openPathLocal } from "../lib/api";
  import {
    extDialog, forgetProject, lastProcByProject, projectDir, projectMeta, projectSettingsDir,
    restoreProject, settingsOpen, settingsProject, transientNote, updateProjectMeta,
  } from "../lib/stores";

  let name = $state("");

  const dir = $derived($projectSettingsDir);
  const meta = $derived.by(() => (dir ? $projectMeta[dir] ?? {} : {}));
  const displayName = $derived(dir ? projectDisplayName(dir, $projectMeta[dir]?.name) : "");
  const folderName = $derived(dir ? dir.split(/[\\/]/).filter(Boolean).pop() ?? dir : "");

  // Fresh controls per target: reopening on another project (or reopening at
  // all) must not keep the previous project's half-typed name. untrack keeps
  // projectMeta out of the deps — meta writes from icon/color clicks must not
  // clobber an in-progress rename.
  $effect(() => {
    const target = $projectSettingsDir;
    untrack(() => {
      name = target ? ($projectMeta[target]?.name ?? "") : "";
    });
  });

  /** Focus action (replaces autofocus; avoids the a11y warning). */
  function focusNow(node: HTMLElement) {
    node.focus();
  }

  function close() {
    projectSettingsDir.set(null);
  }

  function onKeydown(e: KeyboardEvent) {
    if (!$projectSettingsDir) return;
    // The card sits ABOVE the settings modal (z-150 vs z-100), so Esc closes
    // the card even when settings is open — only ExtDialog (z-200) outranks it.
    if (e.key === "Escape" && !$extDialog) {
      e.preventDefault();
      close();
    }
  }

  // Same binding semantics as the Settings projects section: empty = fall
  // back to the folder name.
  function applyName() {
    if (!dir) return;
    updateProjectMeta(dir, { name: name.trim() || undefined });
  }

  async function openFolder() {
    if (!dir) return;
    try {
      await openPathLocal(dir);
    } catch (e) {
      transientNote(`Couldn't open folder: ${e}`);
    }
  }

  function openAdvanced() {
    const target = dir;
    if (!target) return;
    close();
    settingsProject.set(target);
    settingsOpen.set(true);
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if dir}
  <div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) close(); }} role="presentation">
    <div class="card" role="dialog" aria-modal="true" aria-label="Project settings">
      <header class="card-head">
        <div class="head-id">
          <span class="head-icon" style={projectIconStyle(meta.color)}><ProjectIcon icon={meta.icon} size={16} /></span>
          <div class="head-text">
            <h3>{displayName}</h3>
            <span class="head-dir mono" title={dir}>{dir}</span>
          </div>
        </div>
        <button class="ghost icon" title="Close (Esc)" onclick={close}><X size={14} strokeWidth={2} /></button>
      </header>
      <div class="card-body">
        <label class="field">
          <span class="label">Display name</span>
          <input
            bind:value={name}
            placeholder={folderName}
            spellcheck="false"
            use:focusNow
            onchange={applyName}
          />
        </label>
        <div class="field">
          <span class="label">Icon</span>
          <div class="icon-grid">
            {#each PROJECT_ICON_CHOICES as icon (icon)}
              <button
                class="ghost icon-pick"
                class:active={meta.icon === icon}
                title={projectIconLabel(icon)}
                aria-label={projectIconLabel(icon)}
                onclick={() => updateProjectMeta(dir, { icon: icon === meta.icon ? undefined : icon })}
              ><ProjectIcon icon={icon} size={15} /></button>
            {/each}
          </div>
        </div>
        <div class="field">
          <span class="label">Color</span>
          <div class="color-grid">
            {#each PROJECT_COLOR_CHOICES as c (c)}
              {#if c}
                <button
                  class="color-pick"
                  class:active={meta.color === c}
                  style={`background:${c}`}
                  title={c}
                  aria-label={`icon color ${c}`}
                  onclick={() => updateProjectMeta(dir, { color: meta.color === c ? undefined : c })}
                ></button>
              {:else}
                <button
                  class="color-pick none"
                  class:active={!meta.color}
                  title="theme default"
                  aria-label="theme default icon color"
                  onclick={() => updateProjectMeta(dir, { color: undefined })}
                ></button>
              {/if}
            {/each}
          </div>
        </div>
        <div class="rows">
          <button class="rowbtn" onclick={() => void openFolder()}>
            <FolderOpen size={13} strokeWidth={2} />
            <span>Open folder</span>
          </button>
          {#if meta.forgotten}
            <button
              class="rowbtn"
              disabled={dir === $projectDir}
              title={dir === $projectDir ? "The active project can't be restored here" : undefined}
              onclick={() => restoreProject(dir)}
            >
              <RotateCcw size={13} strokeWidth={2} />
              <span>Restore project</span>
            </button>
          {:else}
            <button
              class="rowbtn"
              disabled={dir === $projectDir || !!$lastProcByProject[dir]}
              title={dir === $projectDir ? "The active project can't be hidden" : $lastProcByProject[dir] ? "Stop the project's pi process before hiding it" : undefined}
              onclick={() => forgetProject(dir)}
            >
              <EyeOff size={13} strokeWidth={2} />
              <span>Hide project</span>
            </button>
          {/if}
          <p class="hint">Hidden projects leave the sidebar lists but stay in Settings — restore from the projects section, or here.</p>
        </div>
      </div>
      <footer class="card-foot">
        <button class="ghost" onclick={openAdvanced}>Advanced settings…</button>
        <button class="primary" onclick={close}>Done</button>
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
    max-height: min(640px, 88vh);
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
    gap: 8px;
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--border);
  }
  .head-id {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .head-icon {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border-radius: var(--radius-sm);
    background: var(--bg-surface-2);
    color: var(--text-2);
  }
  .head-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .card-head h3 { margin: 0; font-size: 14px; }
  .head-dir {
    font-size: 10.5px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-body {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
  }
  .field { display: flex; flex-direction: column; gap: 5px; }
  .label { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.4px; }
  .field input {
    padding: 7px 10px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 12.5px;
    outline: none;
  }
  .field input:focus { border-color: var(--accent); }
  .icon-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
  }
  /* The ghost prefix out-ranks the card's own .ghost pill styling so the
     picks match the identical Settings → Project presentation picker:
     transparent, borderless, active-only highlight. */
  .ghost.icon-pick,
  .ghost.icon-pick:hover {
    font-size: 14px;
    padding: 3px 6px;
    color: var(--text);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
  }
  .ghost.icon-pick:hover { background: var(--bg-hover); }
  .icon-pick.active,
  .icon-pick.active:hover { background: var(--accent-soft); color: var(--accent); }
  .color-grid {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  .color-pick {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid transparent;
    padding: 0;
    cursor: pointer;
    flex-shrink: 0;
  }
  .color-pick:hover { transform: scale(1.12); }
  .color-pick.active { border-color: var(--bg-surface); box-shadow: 0 0 0 1.5px var(--text-2); }
  .color-pick.none { background: transparent; border: 1.5px dashed var(--text-3); }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .rowbtn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    text-align: left;
    font-size: 12.5px;
    color: var(--text-2);
  }
  .rowbtn:hover { color: var(--text); }
  .hint { margin: 0; font-size: 11.5px; color: var(--text-3); }
  .card-foot {
    display: flex;
    justify-content: space-between;
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
  .ghost:hover { border-color: var(--border-strong); color: var(--text); }
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
  .ghost.icon:hover { background: var(--bg-surface-2); }
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
  .primary:disabled { opacity: 0.45; cursor: default; }
</style>

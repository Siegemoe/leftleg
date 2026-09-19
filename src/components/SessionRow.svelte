<script lang="ts">
  // One session row in the T3-style sidebar: status pill, title, relative
  // time, hover actions, and drag affordances. Purely presentational.
  import { Ellipsis, Pin } from "@lucide/svelte";
  import type { SidebarPill, SidebarSession } from "../lib/sidebar-model";

  let {
    session,
    pill,
    isActive,
    showProject,
    projectLabel = "",
    timeLabel = "",
    renaming = false,
    renameValue = "",
    dragging = false,
    dropTarget = false,
    onopen,
    onpintoggle,
    onmenu,
    onrenamecommit,
    onrenamecancel,
    onrenameinput,
    ondragstart,
    ondragend,
    ondroprow,
  }: {
    session: SidebarSession;
    pill: SidebarPill | null;
    isActive: boolean;
    showProject?: boolean;
    projectLabel?: string;
    timeLabel?: string;
    renaming?: boolean;
    renameValue?: string;
    dragging?: boolean;
    dropTarget?: boolean;
    onopen: () => void;
    onpintoggle: () => void;
    onmenu: (e: MouseEvent) => void;
    onrenamecommit: () => void;
    onrenamecancel: () => void;
    onrenameinput: (v: string) => void;
    ondragstart: (e: DragEvent) => void;
    ondragend: () => void;
    ondroprow: () => void;
  } = $props();

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      onrenamecommit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onrenamecancel();
    }
  }

  /** Focus action (replaces the autofocus attribute; avoids the a11y warning). */
  function focusNow(node: HTMLElement) {
    node.focus();
  }
</script>

<div
  class="row"
  class:active={isActive}
  class:dragging
  class:drop-target={dropTarget}
  draggable={!renaming}
  {ondragstart}
  {ondragend}
  ondragover={(e) => e.preventDefault()}
  ondrop={(e) => {
    e.preventDefault();
    ondroprow();
  }}
  role="button"
  tabindex="0"
  onclick={() => onopen()}
  onkeydown={(e) => {
    if (e.key === "Enter" && !renaming) onopen();
  }}
  oncontextmenu={(e) => {
    e.preventDefault();
    onmenu(e);
  }}
>
  <span class="row-top">
    {#if pill}
      <span class="pill-dot {pill.kind}" class:pulse={pill.pulse} title={pill.label}></span>
    {:else}
      <span class="pill-dot none" title="idle"></span>
    {/if}
    {#if renaming}
      <input
        class="rename mono"
        value={renameValue}
        oninput={(e) => onrenameinput((e.target as HTMLInputElement).value)}
        onkeydown={onKeydown}
        onblur={() => onrenamecommit()}
        use:focusNow
      />
    {:else}
      <span class="s-title" title={session.title}>{session.title}</span>
    {/if}
  </span>
  <span class="s-meta">
    {#if showProject && projectLabel}
      <span class="proj" title={session.projectDir}>{projectLabel}</span>
    {/if}
    {#if pill && pill.kind !== "working"}
      <span class="pill-label {pill.kind}">{pill.label}</span>
    {/if}
    <span class="s-time">{timeLabel}</span>
    {#if pill?.kind === "working"}
      <span class="working-chip">Working</span>
    {/if}
    <span class="spacer"></span>
    <button
      class="ghost act pin"
      class:pinned={session.pinned}
      title={session.pinned ? "Unpin" : "Pin"}
      onclick={(e) => {
        e.stopPropagation();
        onpintoggle();
      }}
    >
      <Pin size={12} strokeWidth={2} />
    </button>
    <button
      class="ghost act"
      title="More actions"
      onclick={(e) => {
        e.stopPropagation();
        onmenu(e);
      }}
    >
      <Ellipsis size={12} strokeWidth={2} />
    </button>
  </span>
</div>

<style>
  .row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 7px 9px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    border: 1px solid transparent;
    user-select: none;
  }
  .row:hover {
    background: var(--bg-surface-2);
  }
  .row:hover .act {
    opacity: 1;
  }
  .row.active {
    background: var(--bg-surface-2);
    border-color: var(--border);
  }
  .row.dragging {
    opacity: 0.45;
  }
  .row.drop-target {
    border-color: var(--accent);
  }
  .row-top {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .pill-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-3);
    opacity: 0.5;
  }
  .pill-dot.working {
    background: var(--accent);
    opacity: 1;
  }
  .pill-dot.working.pulse {
    animation: pulse 1.2s infinite;
  }
  .pill-dot.needs-attention {
    background: orange;
    opacity: 1;
  }
  .pill-dot.failed {
    background: var(--danger);
    opacity: 1;
  }
  .pill-dot.completed {
    background: var(--ok);
    opacity: 1;
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
  .s-title {
    flex: 1;
    font-size: 12.5px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row.active .s-title {
    color: var(--text);
  }
  .rename {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    padding: 2px 6px;
    background: var(--bg-inset);
    border: 1px solid var(--accent);
    border-radius: 6px;
    color: var(--text);
  }
  .s-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-left: 14px;
    font-size: 10.5px;
    color: var(--text-3);
    min-height: 14px;
  }
  .proj {
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid var(--border);
    border-radius: 99px;
    padding: 0 6px;
  }
  .pill-label {
    letter-spacing: 0.2px;
  }
  .pill-label.needs-attention {
    color: orange;
  }
  .pill-label.failed {
    color: var(--danger);
  }
  .pill-label.completed {
    color: var(--ok);
  }
  /* Per-row "working" cue (moved from the status bar): muted label only —
     the row-top pill-dot already pulses, so the chip stays text. */
  .working-chip {
    display: inline-flex;
    align-items: center;
    color: var(--text-3);
    letter-spacing: 0.2px;
  }
  .spacer {
    flex: 1;
  }
  .act {
    opacity: 0;
    padding: 2px;
    color: var(--text-3);
    display: inline-flex;
  }
  .act:hover {
    color: var(--text);
  }
  .act.pin.pinned {
    opacity: 1;
    color: var(--accent);
  }
  .act.pin.pinned :global(svg) {
    fill: currentColor;
  }
</style>

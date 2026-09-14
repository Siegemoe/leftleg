<script lang="ts">
  // Startup scene: shown while no project is active. The composer sits
  // centered; above it, known projects render as cards. Picking a card
  // activates that project (forcing project association) and, if the user
  // already typed a message, sends it as the first prompt.
  import { fade } from "svelte/transition";
  import { Folder, ArrowRight } from "@lucide/svelte";
  import { projectMeta, projectDir, sessions, statusNote, switchToProject, sendPrompt, lastSessionFor } from "../lib/stores";
  import { projectDisplayName } from "../lib/sidebar-model";
  import { chooseProject } from "../lib/stores";

  let draft = $state("");
  let busy = $state(false);

  // Every non-forgotten project we know about: union of session history and
  // saved project metadata, newest activity first (same shape as the sidebar
  // scope picker).
  const projects = $derived.by(() => {
    const map = new Map<string, { latest: number }>();
    for (const s of $sessions) {
      if ($projectMeta[s.cwd]?.forgotten) continue;
      const cur = map.get(s.cwd);
      if (!cur || s.fileModified > cur.latest) map.set(s.cwd, { latest: s.fileModified });
    }
    for (const dir of Object.keys($projectMeta)) {
      if ($projectMeta[dir]?.forgotten) continue;
      if (!map.has(dir)) map.set(dir, { latest: 0 });
    }
    return [...map.entries()].sort((a, b) => b[1].latest - a[1].latest);
  });

  async function open(dir: string) {
    if (busy) return;
    busy = true;
    try {
      // Resume the project's remembered/most-recent session when it has one.
      await switchToProject(dir, lastSessionFor(dir));
      const text = draft.trim();
      if (text) {
        draft = "";
        await sendPrompt(text, []);
      }
    } catch (e) {
      statusNote.set(`Couldn't open project: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  }

  function openFolder() {
    void chooseProject();
  }
</script>

<div class="start" in:fade={{ duration: 140 }}>
  <div class="start-inner">
    <h1>Pick a project to begin</h1>
    <p class="sub">Your message is sent to the project you choose — pi always runs inside a project folder.</p>

    <div class="cards">
      {#each projects as [dir] (dir)}
        <button class="card" onclick={() => void open(dir)} disabled={busy} title={dir}>
          <span class="icon">{$projectMeta[dir]?.icon ?? "📁"}</span>
          <span class="name">{projectDisplayName(dir, $projectMeta[dir]?.name)}</span>
          <span class="go"><ArrowRight size={14} /></span>
        </button>
      {:else}
        <p class="empty">No known projects yet — choose a folder to add your first one.</p>
      {/each}
      <button class="card ghostcard" onclick={openFolder} disabled={busy}>
        <span class="icon"><Folder size={18} /></span>
        <span class="name">Choose a folder…</span>
      </button>
    </div>

    <div class="composerbox">
      <textarea
        placeholder="Type your message, then pick a project above to send it…"
        bind:value={draft}
        rows={3}
        spellcheck="false"
        onkeydown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            statusNote.set("Pick a project card above to send this message.");
          }
        }}
      ></textarea>
      <div class="hint">Enter won't send here — project association happens first.</div>
    </div>
  </div>
</div>

<style>
  .start {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .start-inner {
    width: min(680px, 92%);
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 32px 8px;
  }
  h1 {
    margin: 0;
    font-size: 22px;
    color: var(--text);
    text-align: center;
  }
  .sub {
    margin: 0 0 6px;
    text-align: center;
    color: var(--text-3);
    font-size: 13px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 10px;
  }
  .card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 13px 14px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    cursor: pointer;
    text-align: left;
    transition: border-color 120ms ease, transform 120ms ease;
  }
  .card:hover { border-color: var(--accent); transform: translateY(-1px); }
  .card:disabled { opacity: 0.6; cursor: default; }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: var(--bg-inset);
    font-size: 16px;
    flex-shrink: 0;
  }
  .name {
    flex: 1;
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .go { color: var(--text-3); }
  .card:hover .go { color: var(--accent); }
  .ghostcard { border-style: dashed; }
  .ghostcard .name { color: var(--text-3); }
  .empty {
    grid-column: 1 / -1;
    color: var(--text-3);
    font-size: 12.5px;
    text-align: center;
    padding: 8px;
  }
  .composerbox {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  textarea {
    resize: none;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--text);
    padding: 12px 14px;
    font: inherit;
    font-size: 13.5px;
    line-height: 1.5;
    min-height: 84px;
  }
  textarea:focus { outline: none; border-color: var(--accent); }
  .hint {
    font-size: 11px;
    color: var(--text-3);
    text-align: center;
  }
</style>

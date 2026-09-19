<script lang="ts">
  // Startup scene: shown while no project is active. The composer sits
  // centered; above it, known projects render as cards. Picking a card
  // activates that project (forcing project association) and, if the user
  // already typed a message, sends it as the first prompt. The send button
  // runs the same flow through the folder picker for brand-new projects.
  import { fade } from "svelte/transition";
  import { ArrowRight, FileText, Folder, Paperclip, Send } from "@lucide/svelte";
  import { projectMeta, projectDir, activeSessionPath, sessions, statusNote, transientNote, switchToProject, sendPrompt, lastSessionFor, updateInstallLock } from "../lib/stores";
  import { projectDisplayName } from "../lib/sidebar-model";
  import { projectIconStyle } from "../lib/project-icons";
  import ProjectIcon from "./ProjectIcon.svelte";
  import { chooseProject } from "../lib/stores";
  import { composerDraftFor } from "../lib/composer-drafts";
  import { pickAttachments, type PickedAttachment } from "../lib/api";
  import { buildPromptMessage, type ComposerAttachment } from "../lib/prompt-message";
  import { untrack } from "svelte";

  const startupDraft = untrack(() => composerDraftFor("startup project"));
  // Attachments share the startup text's draft store: same in-memory-only
  // lifetime (drafts are never persisted), so a goHome round-trip keeps
  // staged chips and the updater's blocker audit sees them. A rejected first
  // prompt hands them to the destination composer draft together with the
  // text, same as the text recovery in sendFirstPrompt below.
  let busy = $state(false);

  const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

  function ext(name: string): string {
    return (name.split(".").pop() ?? "").toLowerCase();
  }

  function mimeFor(name: string): string {
    const e = ext(name);
    if (e === "png") return "image/png";
    if (e === "jpg" || e === "jpeg") return "image/jpeg";
    if (e === "gif") return "image/gif";
    if (e === "webp") return "image/webp";
    if (e === "bmp") return "image/bmp";
    return "text/plain";
  }

  async function addFiles() {
    if (busy) return; // a pick staged during the open window would miss `sent`
    // Same stand-down as the active composer: under the update install lock
    // the dialog would stage attachments into a dead-end interaction.
    if ($updateInstallLock) return;
    // The dialog can stay open across a project-card click: track the pick so
    // open()/openFolder() hold the `sent` snapshot until it lands. The
    // removal runs on rejection too, so a failed dialog can't wedge the
    // drain.
    const pick = pickAttachments();
    pendingStaging.add(pick);
    void pick.then(
      () => pendingStaging.delete(pick),
      () => pendingStaging.delete(pick),
    );
    let picked: PickedAttachment[];
    try {
      picked = await pick;
    } catch (e) {
      transientNote(`Couldn't open the attach dialog: ${e}`);
      return;
    }
    // The lock can engage while the picker was open: staging after it would
    // put chips into a dead-end draft (same reason as the guard above).
    if ($updateInstallLock) {
      transientNote("Update is installing — attachments can't be staged right now");
      return;
    }
    for (const f of picked) {
      // Rust reports per-file failures via `error`; a present-but-empty data
      // string is a legitimate (empty) file and attaches as one. Guard the
      // message so an unnamed/unresolvable pick can't render "undefined".
      if (f.error || f.data === undefined) {
        transientNote(`Couldn't attach ${f.name || f.path || "file"}: ${f.error ?? "no content"}`);
        continue;
      }
      const isImage = IMAGE_TYPES.has(ext(f.name));
      const data = f.data; // narrowed to string above; property narrowing doesn't reach the update callback
      startupDraft.update((draft) => ({ ...draft, attachments: [...draft.attachments, { name: f.name, mimeType: isImage ? mimeFor(f.name) : "text/plain", data, isImage }] }));
    }
  }

  function removeAttachment(i: number) {
    // Mid-flight removal would leave the chip inside `sent` — delivered (or
    // recovered) anyway while the UI showed it gone. A disabled button never
    // reaches this in a real browser; the guard also covers synthetic events.
    if (busy) return;
    startupDraft.update((draft) => ({ ...draft, attachments: draft.attachments.filter((_, idx) => idx !== i) }));
  }

  function dataUrlOf(a: ComposerAttachment): string {
    return `data:${a.mimeType};base64,${a.data}`;
  }

  // Staging work currently in flight: paste reads and attach-dialog picks.
  // open()/openFolder() drain this before snapshotting `sent`: work that
  // settles mid-open would otherwise land after the snapshot — undelivered,
  // and resurrected at the next goHome by the strip in sendFirstPrompt.
  // Entries join the set the moment the async work starts and are removed on
  // both settle paths, so a failed read or a failed/cancelled dialog can't
  // wedge the drain. Paste reads join sequentially, so later files join as
  // earlier ones settle and "wait until empty" covers multi-file pastes; the
  // drain's allSettled always resumes after the work's own continuation, so
  // everything settled has already landed in the draft. Deliberately
  // non-reactive: nothing renders from it.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const pendingStaging = new Set<Promise<unknown>>();

  async function drainStaging() {
    while (pendingStaging.size > 0) {
      await Promise.allSettled([...pendingStaging]);
    }
  }

  // Paste images directly from the clipboard (screenshots, copied files).
  async function onPaste(e: ClipboardEvent) {
    if (busy) return; // a paste during the open window would miss `sent` entirely
    // Same stand-down as addFiles: under the update install lock a staged
    // chip belongs to a dead-end interaction.
    if ($updateInstallLock) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) {
      if (f.size > 20 * 1024 * 1024) { transientNote("Pasted image exceeds 20 MiB limit"); continue; }
      const read = new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(r.error ?? new Error("Could not read pasted image"));
        r.onabort = () => reject(new Error("Image paste cancelled"));
        r.readAsDataURL(f);
      });
      pendingStaging.add(read);
      void read.then(
        () => pendingStaging.delete(read),
        () => pendingStaging.delete(read),
      );
      let dataUrl: string;
      try {
        dataUrl = await read;
      } catch (err) {
        // A failed read must not kill the paste: name the file, keep going.
        transientNote(`Couldn't read pasted image ${f.name || "(unnamed)"}: ${err}`);
        continue;
      }
      // The lock can engage while the read is in flight — same dead-end rule.
      if ($updateInstallLock) {
        transientNote("Update is installing — pasted image skipped");
        continue;
      }
      const b64 = dataUrl.split(",")[1] ?? "";
      startupDraft.update((draft) => ({ ...draft, attachments: [...draft.attachments, {
        name: f.name || `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
        mimeType: f.type || "image/png",
        data: b64,
        isImage: true,
      }] }));
    }
  }

  async function sendFirstPrompt(text: string, sent: ComposerAttachment[]) {
    if (!text.trim() && sent.length === 0) return;
    // The startup component may unmount and the active project may change
    // before Pi replies. Recovery belongs to the composer that sent this text.
    const destination = composerDraftFor(`${$projectDir}:${$activeSessionPath ?? ""}`);
    // Images travel in the images param; text files are inlined as fenced
    // blocks so pi can see their content.
    const { msg, images } = buildPromptMessage(text.trim(), sent);
    const result = await sendPrompt(msg, images);
    if (!result.ok) {
      destination.update((draft) => ({
        ...draft,
        text: draft.text ? `${text}\n${draft.text}` : text,
        attachments: sent.length > 0 ? [...draft.attachments, ...sent] : draft.attachments,
      }));
    }
    // Consume only the submitted revision; later typing must survive.
    startupDraft.update((draft) => ({
      ...draft, text: draft.text.startsWith(text) ? draft.text.slice(text.length) : draft.text,
    }));
    // The submitted attachments leave this composer either way: delivered on
    // accept, recovered into the destination composer on rejection. A store
    // update (not $startupDraft) stays correct even when the open flow
    // resolves after the start view has unmounted.
    startupDraft.update((draft) => ({ ...draft, attachments: draft.attachments.filter((a) => !sent.includes(a)) }));
  }

  // Every non-forgotten project we know about: union of session history and
  // saved project metadata, newest activity first (same shape as the sidebar
  // scope picker).
  const projects = $derived.by(() => {
    // Local scratch map rebuilt on each derivation — intentionally not state
    // (a SvelteMap here would be a state write inside $derived, which throws).
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
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
      // Anything staged just before this click — a paste still reading, an
      // attach dialog still pending — must land before the snapshot so it is
      // in `sent`; staging from here on hits the busy gate instead.
      if (pendingStaging.size > 0) await drainStaging();
      const text = $startupDraft.text;
      const sent = $startupDraft.attachments;
      // Resume the project's remembered/most-recent session when it has one.
      const opened = await switchToProject(dir, lastSessionFor(dir));
      if (!opened || $projectDir !== dir) return;
      await sendFirstPrompt(text, sent);
    } catch (e) {
      transientNote(`Couldn't open project: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  }

  async function openFolder() {
    if (busy) return;
    busy = true;
    try {
      // Same drain as open(): in-flight paste reads and attach picks must
      // land before the snapshot so they are delivered, not stranded.
      if (pendingStaging.size > 0) await drainStaging();
      const text = $startupDraft.text;
      const sent = $startupDraft.attachments;
      const opened = await chooseProject();
      if (!opened || $projectDir !== opened) return;
      await sendFirstPrompt(text, sent);
    } catch (e) {
      transientNote(`Couldn't open project: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  }
</script>

<div class="start" in:fade={{ duration: 140 }}>
  <div class="start-inner">
    <h1>Pick a project to begin</h1>
    <p class="sub">Your message is sent to the project you choose — pi always runs inside a project folder.</p>
    {#if $statusNote}<p role="status">{$statusNote}</p>{/if}

    <div class="cards">
      {#each projects as [dir] (dir)}
        <button class="card" onclick={() => void open(dir)} disabled={busy} title={dir}>
          <span class="icon" style={projectIconStyle($projectMeta[dir]?.color)}><ProjectIcon icon={$projectMeta[dir]?.icon} size={15} /></span>
          <span class="name">{projectDisplayName(dir, $projectMeta[dir]?.name)}</span>
          <span class="go"><ArrowRight size={14} /></span>
        </button>
      {:else}
        <p class="empty">No known projects yet — choose a folder to add your first one.</p>
      {/each}
      <button class="card ghostcard" onclick={() => void openFolder()} disabled={busy}>
        <span class="icon"><Folder size={18} /></span>
        <span class="name">Choose a folder…</span>
      </button>
    </div>

    <div class="composerbox">
      {#if $startupDraft.attachments.length > 0}
        <div class="attachments">
          {#each $startupDraft.attachments as a, i (a)}
            <div class="chip">
              {#if a.isImage}
                <img src={dataUrlOf(a)} alt={a.name} />
              {:else}
                <FileText size={14} strokeWidth={2} />
              {/if}
              <span class="chipname" title={a.name}>{a.name}</span>
              <button class="ghost rm" disabled={busy} onclick={() => removeAttachment(i)} title="Remove">×</button>
            </div>
          {/each}
        </div>
      {/if}
      <textarea
        placeholder="Type your message, then pick a project above to send it…"
        bind:value={$startupDraft.text}
        rows={3}
        spellcheck="false"
        disabled={busy || $updateInstallLock}
        onkeydown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            transientNote("Enter won't send here — pick a project card above, or use the send button.");
          }
        }}
        onpaste={onPaste}
      ></textarea>
      <div class="actions">
        <button class="ghost add" disabled={busy || $updateInstallLock} onclick={addFiles} title="Attach images or files">
          <Paperclip size={18} strokeWidth={2} />
        </button>
        <button
          class="primary send"
          disabled={busy || (!$startupDraft.text.trim() && $startupDraft.attachments.length === 0)}
          onclick={() => void openFolder()}
          title="Send to a new folder"
        >
          <Send size={15} strokeWidth={2.2} />
        </button>
      </div>
      <div class="hint">Pick a project card above, or send to a new folder with the send button.</div>
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
  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 3px 4px 3px 6px;
    font-size: 11.5px;
    max-width: 220px;
  }
  .chip img {
    width: 22px;
    height: 22px;
    object-fit: cover;
    border-radius: 4px;
  }
  .chip :global(svg) { flex-shrink: 0; color: var(--text-3); }
  .chipname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
  .rm { padding: 0 4px; font-size: 13px; line-height: 1; border: none; color: var(--text-3); }
  .rm:hover { color: var(--danger); }
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
  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .add {
    padding: 7px;
    display: inline-flex;
    color: var(--text-3);
    border-radius: 10px;
    flex-shrink: 0;
  }
  .add:hover { color: var(--accent); }
  .send {
    display: inline-flex;
    align-items: center;
    padding: 8px 12px;
    border-radius: 10px;
    flex-shrink: 0;
  }
  .hint {
    font-size: 11px;
    color: var(--text-3);
    text-align: center;
  }
</style>

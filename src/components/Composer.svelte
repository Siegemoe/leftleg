<script lang="ts">
  import { sendPrompt, abort, streaming, statusNote, queue, extWidgets, composerDraft, commands } from "../lib/stores";
  import { buildPromptMessage, type ComposerAttachment } from "../lib/prompt-message";
  import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
  import { readFileBase64, piRequest } from "../lib/api";

  interface Attachment {
    name: string;
    mimeType: string;
    data: string; // base64
    isImage: boolean;
  }

  let text = $state("");
  let attachments: Attachment[] = $state([]);
  let sending = $state(false);
  let textareaEl: HTMLTextAreaElement | null = $state(null);

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

  function autoGrow() {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 220) + "px";
  }

  async function addFiles() {
    const picked = await openFileDialog({
      multiple: true,
      title: "Attach files",
      filters: [
        { name: "Images & text", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "txt", "md", "json", "ts", "js", "py", "rs", "toml", "yaml", "yml", "csv", "log"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    for (const p of paths) {
      try {
        const b64 = await readFileBase64(p);
        const name = p.split(/[\\/]/).pop() ?? p;
        const isImage = IMAGE_TYPES.has(ext(name));
        attachments = [...attachments, { name, mimeType: isImage ? mimeFor(name) : "text/plain", data: b64, isImage }];
      } catch (e) {
        console.error("read failed", p, e);
      }
    }
  }

  function removeAttachment(i: number) {
    attachments = attachments.filter((_, idx) => idx !== i);
  }

  function dataUrlOf(a: Attachment): string {
    return `data:${a.mimeType};base64,${a.data}`;
  }

  async function doSend() {
    if (sending || $streaming && !text.trim() && attachments.length === 0) return;
    if (!text.trim() && attachments.length === 0) return;
    sending = true;
    try {
      // Capture exactly what is being submitted. The composer stays editable
      // while pi decides, so acceptance must clear only this revision — later
      // typing or an extension-provided draft must survive.
      const submittedText = text;
      const submittedAttachments = attachments;
      // Build the message: images go through the images param;
      // text files get inlined as fenced blocks so pi can see their content.
      const { msg, images } = buildPromptMessage(submittedText, submittedAttachments);
      const res = await sendPrompt(msg, images);
      // A rejected submission keeps text + attachments so the user can fix or retry.
      if (res.ok) {
        if (text === submittedText && attachments === submittedAttachments) {
          // Untouched while in flight — clear everything.
          text = "";
          attachments = [];
        } else {
          // Edited meanwhile: strip only the submitted part, keep the rest
          // (new typing, or a draft an extension pushed via set_editor_text).
          if (submittedText && text.startsWith(submittedText)) {
            text = text.slice(submittedText.length);
          }
          if (submittedAttachments.length > 0) {
            attachments = attachments.filter((a) => !submittedAttachments.includes(a));
          }
        }
        autoGrow();
      }
    } finally {
      sending = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); slashIdx = (slashIdx + 1) % slashMatches.length; return; }
      if (e.key === "ArrowUp") { e.preventDefault(); slashIdx = (slashIdx - 1 + slashMatches.length) % slashMatches.length; return; }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        applySlash(slashMatches[Math.min(slashIdx, slashMatches.length - 1)]);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); slashSuppressed = true; return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
  }

  function onInput() {
    autoGrow();
    if (!text.startsWith("/")) slashSuppressed = false;
  }

  // ---- extension surfaces ----

  // Adopt set_editor_text requests (only the latest nonce wins).
  let lastDraftNonce = 0;
  $effect(() => {
    const draft = $composerDraft;
    if (!draft || draft.nonce === lastDraftNonce) return;
    lastDraftNonce = draft.nonce;
    text = draft.text;
    autoGrow();
    textareaEl?.focus();
  });

  const aboveWidgets = $derived(Object.entries($extWidgets).filter(([, w]) => w.placement === "aboveEditor"));
  const belowWidgets = $derived(Object.entries($extWidgets).filter(([, w]) => w.placement === "belowEditor"));

  // ---- slash-command palette (commands come from pi via get_commands) ----
  let slashSuppressed = $state(false);
  let slashIdx = $state(0);
  const slashOpen = $derived(text.startsWith("/") && !text.includes(" ") && !text.includes("\n") && !slashSuppressed);
  const slashToken = $derived(slashOpen ? text.slice(1).toLowerCase() : "");
  const slashMatches = $derived(
    slashOpen
      ? slashToken === ""
        ? $commands
        : $commands.filter((c) => c.name.toLowerCase().startsWith(slashToken) || c.name.toLowerCase().includes(slashToken))
      : []
  );

  function applySlash(c: { name: string }) {
    text = `/${c.name} `;
    slashSuppressed = false;
    slashIdx = 0;
    autoGrow();
    textareaEl?.focus();
  }

  // Paste images directly from the clipboard (screenshots, copied files).
  async function onPaste(e: ClipboardEvent) {
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
      const dataUrl = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(f);
      });
      const b64 = dataUrl.split(",")[1] ?? "";
      attachments = [...attachments, {
        name: f.name || `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
        mimeType: f.type || "image/png",
        data: b64,
        isImage: true,
      }];
    }
  }

  async function clearQueue() {
    try {
      await piRequest({ type: "clear_queue" }, 30);
    } catch { /* ignore */ }
  }
</script>

{#if $statusNote}
  <div class="note mono">{$statusNote}</div>
{/if}

{#if $queue.steering.length + $queue.followUp.length > 0}
  <div class="pending">
    {#each $queue.steering as s}
      <div class="pending-chip"><span class="tag">steer</span><span class="ptext">{s}</span></div>
    {/each}
    {#each $queue.followUp as s}
      <div class="pending-chip"><span class="tag">follow-up</span><span class="ptext">{s}</span></div>
    {/each}
    <button class="ghost clear-btn" onclick={clearQueue} title="Remove queued messages (they are not sent)">Clear queue</button>
  </div>
{/if}

<div class="composer">
  {#each aboveWidgets as [key, w] (key)}
    <div class="ext-widget" title="Extension widget: {key}">
      <span class="wkey mono">{key}</span>
      <pre>{(w.lines ?? []).join("\n")}</pre>
    </div>
  {/each}

  {#if slashOpen && slashMatches.length > 0}
    <div class="slash-palette" role="listbox" aria-label="Slash commands">
      {#each slashMatches as c, i (c.name)}
        <button
          type="button"
          class="slash-item"
          class:selected={i === Math.min(slashIdx, slashMatches.length - 1)}
          role="option"
          aria-selected={i === Math.min(slashIdx, slashMatches.length - 1)}
          onmouseenter={() => (slashIdx = i)}
          onclick={() => applySlash(c)}
        >
          <span class="s-name mono">/{c.name}</span>
          {#if c.source}<span class="s-src">{c.source}</span>{/if}
          {#if c.description}<span class="s-desc">{c.description}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if attachments.length > 0}
    <div class="attachments">
      {#each attachments as a, i}
        <div class="chip">
          {#if a.isImage}
            <img src={dataUrlOf(a)} alt={a.name} />
          {:else}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          {/if}
          <span class="name" title={a.name}>{a.name}</span>
          <button class="ghost rm" onclick={() => removeAttachment(i)} title="Remove">×</button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="input-row">
    <button class="ghost add" onclick={addFiles} title="Attach images or files">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="9" />
        <line x1="12" y1="8" x2="12" y2="16" />
        <line x1="8" y1="12" x2="16" y2="12" />
      </svg>
    </button>
    <textarea
      bind:this={textareaEl}
      bind:value={text}
      oninput={onInput}
      onkeydown={onKeydown}
      onpaste={onPaste}
      spellcheck="true"
      placeholder={$streaming ? "Streaming… press Enter to steer, or wait" : "Message Leftleg…  (Enter to send, Shift+Enter for newline)"}
      rows="1"
    ></textarea>
    {#if $streaming}
      <button class="danger stop" onclick={abort} title="Abort current run">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        Stop
      </button>
    {:else}
      <button
        class="primary send"
        disabled={(!text.trim() && attachments.length === 0) || sending}
        onclick={doSend}
        title="Send"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" />
        </svg>
      </button>
    {/if}
  </div>
  <div class="hint">
    {$streaming
      ? `Agent running — sent messages steer the current run. ${$statusNote ? "" : ""}`
      : "Enter to send · Shift+Enter newline · + to attach · / for commands"}
  </div>

  {#each belowWidgets as [key, w] (key)}
    <div class="ext-widget" title="Extension widget: {key}">
      <span class="wkey mono">{key}</span>
      <pre>{(w.lines ?? []).join("\n")}</pre>
    </div>
  {/each}
</div>

<style>
  .note {
    margin: 0 24px 4px;
    font-size: 11.5px;
    color: var(--text-3);
    padding: 3px 10px;
    background: var(--bg-surface-2);
    border-radius: var(--radius-sm);
    align-self: flex-start;
  }
  .pending {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0 24px 6px;
    padding: 8px 10px;
    background: var(--bg-surface-2);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-sm);
  }
  .pending-chip {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12.5px;
    color: var(--text-2);
  }
  .ptext {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .clear-btn {
    align-self: flex-end;
    font-size: 11px;
    padding: 2px 8px;
    color: var(--text-3);
  }
  .composer {
    position: relative;
    flex-shrink: 0;
    padding: 0 24px 14px;
    max-width: 908px;
    width: 100%;
    margin: 0 auto;
  }
  .ext-widget {
    margin: 0 44px 8px;
    padding: 6px 10px;
    background: var(--bg-surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    position: relative;
  }
  .ext-widget pre {
    margin: 0;
    padding: 0;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--text-2);
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .ext-widget .wkey {
    display: block;
    font-size: 9.5px;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--text-3);
    margin-bottom: 2px;
  }
  .slash-palette {
    position: absolute;
    bottom: calc(100% - 8px);
    left: 44px;
    right: 44px;
    max-height: 240px;
    overflow-y: auto;
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    z-index: 30;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .slash-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 6px 8px;
    border: none;
    background: transparent;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12.5px;
  }
  .slash-item.selected { background: var(--bg-surface-2); }
  .s-name { color: var(--accent); flex-shrink: 0; }
  .s-src {
    font-size: 10px;
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: 99px;
    padding: 0 6px;
    flex-shrink: 0;
  }
  .s-desc {
    color: var(--text-3);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 44px 6px 44px;
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
  .chip svg { flex-shrink: 0; color: var(--text-3); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
  .rm { padding: 0 4px; font-size: 13px; line-height: 1; border: none; color: var(--text-3); }
  .rm:hover { color: var(--danger); }
  .input-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 8px;
    transition: border-color 0.15s;
  }
  .input-row:focus-within { border-color: var(--accent); }
  .add {
    padding: 7px;
    display: inline-flex;
    color: var(--text-3);
    border-radius: 10px;
    flex-shrink: 0;
  }
  .add:hover { color: var(--accent); }
  textarea {
    flex: 1;
    background: transparent;
    border: none;
    resize: none;
    padding: 7px 2px;
    font-size: 14px;
    line-height: 1.5;
    max-height: 220px;
  }
  textarea:focus { border: none; }
  .send, .stop {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    flex-shrink: 0;
    border-radius: 10px;
  }
  .hint {
    font-size: 11px;
    color: var(--text-3);
    padding: 5px 6px 0 44px;
  }
</style>

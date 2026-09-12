<script lang="ts">
  import { sendPrompt, abort, streaming, statusNote, queue } from "../lib/stores";
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
      // Build the message: images go through the images param;
      // text files get inlined as fenced blocks so pi can see their content.
      const images = attachments
        .filter((a) => a.isImage)
        .map((a) => ({ data: a.data, mimeType: a.mimeType, name: a.name }));
      let msg = text.trim();
      const textFiles = attachments.filter((a) => !a.isImage);
      if (textFiles.length > 0) {
        const parts: string[] = msg ? [msg] : [];
        for (const f of textFiles) {
          let content = "";
          try {
            const bin = atob(f.data);
            content = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
          } catch {
            content = "(unreadable)";
          }
          if (content.length > 40000) content = content.slice(0, 40000) + "\n… (truncated)";
          const lang = ext(f.name) || "";
          parts.push(`Attached file: ${f.name}\n\`\`\`${lang}\n${content}\n\`\`\``);
        }
        msg = parts.join("\n\n");
      }
      text = "";
      attachments = [];
      autoGrow();
      await sendPrompt(msg, images);
    } finally {
      sending = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
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
      oninput={autoGrow}
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
      : "Enter to send · Shift+Enter newline · + to attach"}
  </div>
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
    flex-shrink: 0;
    padding: 0 24px 14px;
    max-width: 908px;
    width: 100%;
    margin: 0 auto;
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

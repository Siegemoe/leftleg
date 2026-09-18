<script lang="ts">
  import type { UiItem } from "../lib/types";
  import ToolCard from "./ToolCard.svelte";
  import { renderMarkdown, renderStreamingMarkdown } from "../lib/markdown";
  import { sanitizeThinking } from "../lib/thinking";
  import { dayHeaderLabel, formatDuration } from "../lib/time-format";
  import { retryFailedUser, dismissFailedUser, transientNote } from "../lib/stores";
  import { Lightbulb, TriangleAlert, Copy } from "@lucide/svelte";

  let { item }: { item: UiItem } = $props();

  async function onRetry(id: string | undefined) {
    if (id) await retryFailedUser(id);
  }

  function onDismiss(id: string | undefined) {
    if (id) dismissFailedUser(id);
  }

  function responseText(): string {
    if (item.kind !== "assistant") return "";
    return item.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
  }

  async function copyResponse() {
    try {
      await navigator.clipboard.writeText(responseText());
      transientNote("Response copied", 3000);
    } catch (e) {
      transientNote(`Couldn't copy: ${e}`);
    }
  }
</script>

{#if item.kind === "user"}
  <div class="row user">
    <div class="bubble user-bubble" class:failed={item.status === "failed"}>
      {#if item.images.length > 0}
        <div class="thumbs">
          {#each item.images as img}
            {#if img.dataUrl}
              <img src={img.dataUrl} alt={img.name} title={img.name} />
            {:else}
              <span class="img-chip mono">🖼 {img.name}</span>
            {/if}
          {/each}
        </div>
      {/if}
      {#if item.text}
        <div class="md">{@html renderMarkdown(item.text)}</div>
      {/if}
      {#if item.status === "failed"}
        <div class="delivery-note">
          <span class="delivery-text"><TriangleAlert size={12} strokeWidth={2} class="ic-inline" /> Not delivered{item.error ? ` — ${item.error}` : ""}</span>
          <button class="retry" onclick={() => onRetry(item.id)} title="Send this message again">Retry</button>
          <button class="dismiss" onclick={() => onDismiss(item.id)} title="Discard this message" aria-label="Discard failed message">×</button>
        </div>
      {/if}
    </div>
  </div>
{:else if item.kind === "assistant"}
  <div class="row assistant">
    <div class="stack">
      {#if item.timestamp}
        <div class="msg-time">{dayHeaderLabel(item.timestamp)}</div>
      {/if}
      {#each item.blocks as block}
        {#if block.type === "thinking"}
          <details class="thinking" open={!block.done}>
            <summary>
              <Lightbulb size={12} strokeWidth={2} class="ic-inline" />
              {block.done ? "Thought process" : "Thinking…"}
              {#if block.durationMs}<span class="think-dur">· {formatDuration(block.durationMs)}</span>{/if}
            </summary>
            <div class="think-body">{sanitizeThinking(block.text)}</div>
          </details>
        {:else if block.type === "text"}
          {#if block.text.trim()}
            <div class="md body">{@html item.streaming ? renderStreamingMarkdown(block.text) : renderMarkdown(block.text)}</div>
          {/if}
        {/if}
      {/each}
      {#if item.errorMessage}
        <div class="error-note"><TriangleAlert size={12} strokeWidth={2} class="ic-inline" /> {item.errorMessage}</div>
      {/if}
      {#if item.streaming}
        <span class="cursor"></span>
      {:else}
        {#if responseText()}
          <button class="copy-btn" title="Copy response text" onclick={() => void copyResponse()}>
            <Copy size={11} strokeWidth={2} /> Copy
          </button>
        {/if}
        {#if item.turnDurationMs}
          <div class="turn-meta">turn · {formatDuration(item.turnDurationMs)}</div>
        {/if}
      {/if}
    </div>
  </div>
{:else if item.kind === "tool"}
  <ToolCard {item} />
{:else if item.kind === "bash"}
  <ToolCard item={{
    kind: "tool",
    id: item.id,
    toolCallId: "bash",
    name: "bash",
    args: JSON.stringify({ command: item.command }, null, 2),
    status: item.isError ? "error" : "done",
    output: item.output,
    outputTruncated: false,
    isError: item.isError,
  }} />
{/if}

<style>
  .row {
    display: flex;
    padding: 6px 24px;
  }
  .row.user { justify-content: flex-end; }
  .bubble {
    max-width: 78%;
    border-radius: 14px;
    padding: 9px 13px;
  }
  .user-bubble {
    background: var(--accent);
    color: var(--on-accent);
    border-bottom-right-radius: 5px;
  }
  .user-bubble.failed {
    background: var(--bg-surface-2);
    color: var(--text-2);
    border: 1px solid var(--danger);
    border-bottom-right-radius: 14px;
  }
  .user-bubble.failed :global(.md) { opacity: 0.8; }
  .delivery-note {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 6px;
    padding-top: 5px;
    border-top: 1px solid var(--danger);
    font-size: 12px;
    color: var(--danger);
  }
  .delivery-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .retry {
    flex-shrink: 0;
    font-size: 11.5px;
    padding: 2px 10px;
    border: 1px solid var(--danger);
    border-radius: 99px;
    color: var(--danger);
    background: transparent;
    cursor: pointer;
  }
  .retry:hover { background: var(--danger); color: #fff; }
  :global(.ic-inline) { vertical-align: -2px; flex-shrink: 0; }
  .dismiss {
    flex-shrink: 0;
    font-size: 13px;
    line-height: 1;
    padding: 1px 5px;
    border: none;
    background: transparent;
    color: var(--danger);
    cursor: pointer;
    opacity: 0.8;
  }
  .dismiss:hover { opacity: 1; }
  .user-bubble :global(.md p) { margin: 0.15em 0; }
  .user-bubble :global(a) { color: #e6e0ff; }
  .user-bubble :global(code) { background: rgba(255,255,255,0.18); }
  .user-bubble :global(pre) { background: rgba(0,0,0,0.25); border-color: rgba(255,255,255,0.15); }
  .thumbs {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }
  .thumbs img {
    max-width: 160px;
    max-height: 110px;
    border-radius: 8px;
    display: block;
  }
  .img-chip {
    display: inline-block;
    font-size: 11px;
    background: rgba(255, 255, 255, 0.14);
    border-radius: 6px;
    padding: 4px 8px;
  }
  .row.assistant { flex-direction: column; }
  .stack { display: flex; flex-direction: column; gap: 2px; }
  .body { padding: 2px 0; }
  .thinking {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface-2);
    color: var(--text-2);
    font-size: 12.5px;
    margin: 3px 0;
    overflow: hidden;
  }
  .thinking summary {
    cursor: pointer;
    user-select: none;
    padding: 5px 10px;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-3);
    font-weight: 600;
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .thinking summary::marker { content: ""; }
  .think-body {
    padding: 4px 12px 8px;
    white-space: pre-wrap;
    max-height: 240px;
    overflow-y: auto;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
  }
  .msg-time {
    font-size: 10.5px;
    color: var(--text-3);
    padding: 2px 0;
    letter-spacing: 0.3px;
    user-select: none;
  }
  .think-dur {
    color: var(--text-3);
    font-weight: 400;
    margin-left: 4px;
    text-transform: none;
    letter-spacing: 0;
  }
  .copy-btn {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-top: 2px;
    padding: 2px 9px;
    font-size: 10.5px;
    color: var(--text-3);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 99px;
    cursor: pointer;
    opacity: 0.75;
  }
  .copy-btn:hover { color: var(--text); border-color: var(--border-strong); opacity: 1; }
  .turn-meta { font-size: 10.5px; color: var(--text-3); padding: 1px 0; user-select: none; }
  .error-note {
    color: var(--danger);
    font-size: 12.5px;
    padding: 3px 0;
  }
  .cursor {
    display: inline-block;
    width: 8px;
    height: 15px;
    background: var(--accent);
    border-radius: 2px;
    animation: blink 1s steps(2) infinite;
    margin: 4px 0 0 2px;
  }
  @keyframes blink { 50% { opacity: 0; } }
</style>

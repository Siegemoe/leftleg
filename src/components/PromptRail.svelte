<script lang="ts">
  // Chat minimap rail: one tick per user prompt in the transcript in view,
  // oldest first (top-to-bottom, matching the conversation). Click a tick
  // to jump the chat to that prompt; the active tick follows the scroll
  // position (Chat publishes it via activePromptId). Visuals are
  // chat-space, not a third panel; the + new-chat button shows only while
  // the sidebar is collapsed — the sidebar owns session switching.
  import { Plus } from "@lucide/svelte";
  import { activePromptId, items, newSession, nowTick, sidebarOpen } from "../lib/stores";
  import { formatRelativeTime } from "../lib/sidebar-model";

  const now = $derived($nowTick);

  const ticks = $derived.by(() => {
    const out: { id: string; label: string; at: number; failed: boolean; sending: boolean }[] = [];
    for (const it of $items) {
      if (it.kind !== "user") continue;
      const text = it.text.trim();
      const label =
        text ||
        (it.images.length > 0
          ? `[${it.images.length} image${it.images.length === 1 ? "" : "s"}]`
          : "(empty prompt)");
      out.push({
        id: it.id,
        label: label.length > 200 ? label.slice(0, 200) + "…" : label,
        at: it.timestamp ?? Date.now(),
        failed: it.status === "failed",
        sending: it.status === "sending",
      });
    }
    return out;
  });

  function jump(id: string) {
    document.getElementById("prompt-" + id)?.scrollIntoView({ block: "start" });
  }
</script>

<aside class="rail" aria-label="Prompt rail">
  {#if !$sidebarOpen}
    <button class="rail-btn" title="New chat" onclick={() => void newSession()}>
      <Plus size={13} strokeWidth={2.4} />
    </button>
  {/if}
  <div class="ticks">
    {#each ticks as t (t.id)}
      <button
        class="tick"
        class:active={$activePromptId === t.id}
        class:failed={t.failed}
        class:sending={t.sending}
        title={`${t.label}\n${formatRelativeTime(t.at, now)}`}
        aria-label={"Jump to prompt: " + t.label}
        onclick={() => jump(t.id)}
      ></button>
    {:else}
      <div class="none" title="No prompts yet"></div>
    {/each}
  </div>
</aside>

<style>
  .rail {
    flex-shrink: 0;
    width: 30px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 8px 0;
    /* Reads as part of the chat space, not a third panel: transparent on
     * the shell background, no border. */
    background: transparent;
    overflow: hidden;
  }
  .rail-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    cursor: pointer;
    flex-shrink: 0;
  }
  .rail-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .ticks {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: safe center;
    gap: 7px;
    min-height: 0;
    /* Scrollable when the window is short; no visible scrollbar — ticks stay
     * reachable where overflow-hidden would silently clip them. */
    overflow-y: auto;
    scrollbar-width: none;
    padding-top: 2px;
  }
  .ticks::-webkit-scrollbar {
    display: none;
  }
  .tick {
    width: 14px;
    height: 3px;
    padding: 0;
    border: none;
    border-radius: 2px;
    background: color-mix(in srgb, var(--text-3) 55%, transparent);
    cursor: pointer;
    flex-shrink: 0;
    transition:
      width 120ms ease,
      background 120ms ease;
  }
  .tick:hover {
    background: var(--text-2);
  }
  .tick.active {
    width: 18px;
    background: var(--accent);
  }
  .tick.sending {
    background: var(--accent);
    animation: rail-pulse 1.2s infinite;
  }
  .tick.failed {
    background: var(--danger);
  }
  .tick.sending.active {
    animation: rail-pulse 1.2s infinite;
  }
  .none {
    width: 14px;
    height: 3px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--text-3) 25%, transparent);
  }
  @keyframes rail-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }
</style>

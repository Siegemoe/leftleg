<script lang="ts">
  import { items, streaming, rpcState, projectDir, activeSessionPath, chooseProject, disconnected } from "../lib/stores";
  import MessageView from "./MessageView.svelte";
  import Composer from "./Composer.svelte";

  let scroller: HTMLDivElement | null = $state(null);
  let stick = $state(true);

  function onScroll() {
    if (!scroller) return;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    stick = nearBottom;
  }

  $effect(() => {
    // scroll on new items or streaming growth
    $items; $streaming;
    if (stick && scroller) {
      const frame = requestAnimationFrame(() => {
        scroller?.scrollTo({ top: scroller.scrollHeight });
      });
      return () => cancelAnimationFrame(frame);
    }
  });
</script>

<div class="chat" onscroll={onScroll} bind:this={scroller}>
  {#if $items.length === 0}
    <div class="hero">
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round">
        <path d="M7 3v11a3 3 0 0 0 3 3h0" />
        <path d="M7 14v7" />
        <circle cx="10" cy="17" r="1.6" fill="var(--accent)" stroke="none" />
      </svg>
      <h1>Leftleg</h1>
      <p>A control surface for Pi.</p>
      {#if !$projectDir}
        <p class="lead">Leftleg drives a <span class="mono">pi --mode rpc</span> process rooted in a project folder.<br />Pick one to start.</p>
        <button class="primary cta" onclick={chooseProject}>Choose project folder…</button>
      {:else if $disconnected}
        <p class="lead">Pi is offline. Use Restart &amp; resume to reconnect.</p>
      {:else if $rpcState}
        <p class="mono model-line">{$rpcState.model ? `${$rpcState.model.provider} / ${$rpcState.model.id}` : "no model selected"}</p>
        <p class="lead">Ask something, or attach a file with <span class="mono">+</span>.</p>
      {:else}
        <p class="lead">Starting pi…</p>
      {/if}
    </div>
  {:else}
    {#each $items as item, i (i)}
      <MessageView {item} />
    {/each}
  {/if}
</div>

{#key `${$projectDir}:${$activeSessionPath ?? ""}`}
  <Composer draftKey={`${$projectDir}:${$activeSessionPath ?? ""}`} />
{/key}

<style>
  .chat {
    flex: 1;
    overflow-y: auto;
    padding: 20px 0 12px;
    min-height: 0;
  }
  .hero {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--text-2);
    text-align: center;
  }
  .hero h1 { margin: 8px 0 0; font-size: 22px; color: var(--text); }
  .hero p { margin: 0; font-size: 13.5px; }
  .lead { color: var(--text-3); max-width: 420px; }
  .cta { margin-top: 12px; padding: 9px 18px; font-size: 14px; }
  .model-line { color: var(--text-3); font-size: 12px; margin-top: 10px !important; }
</style>

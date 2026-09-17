<script lang="ts">
  import { items, streaming, rpcState, projectDir, activeSessionPath, chooseProject, disconnected } from "../lib/stores";
  import MessageView from "./MessageView.svelte";
  import Composer from "./Composer.svelte";
  import mark from "../assets/leftleg-mark.png";

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
      <img class="hero-mark" src={mark} alt="" draggable="false" />
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
    {#each $items as item (item.id)}
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
  .hero-mark { display: block; height: 64px; width: auto; margin-bottom: 4px; }
  .hero h1 { margin: 8px 0 0; font-size: 22px; color: var(--text); }
  .hero p { margin: 0; font-size: 13.5px; }
  .lead { color: var(--text-3); max-width: 420px; }
  .cta { margin-top: 12px; padding: 9px 18px; font-size: 14px; }
  .model-line { color: var(--text-3); font-size: 12px; margin-top: 10px !important; }
</style>

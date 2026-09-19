<script lang="ts">
  import type { Action } from "svelte/action";
  import { extDialog, respondToExtDialog } from "../lib/stores";

  let d = $derived($extDialog!);
  let inputValue = $state("");

  $effect(() => {
    // Reset input whenever a new dialog arrives
    if ($extDialog) inputValue = $extDialog.prefill ?? "";
  });

  function submitValue() {
    respondToExtDialog({ value: inputValue });
  }
  function confirm(v: boolean) {
    respondToExtDialog({ confirmed: v });
  }
  function cancel() {
    respondToExtDialog({ cancelled: true });
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    // A focused button handles its own Enter (native activation); the dialog
    // shortcut only applies when focus sits on a text field or the page.
    if ((e.target as HTMLElement | null)?.closest("button")) return;
    if (d.method === "editor") return; // Enter stays a newline in the editor
    e.preventDefault();
    // Enter answers with each method's primary action.
    if (d.method === "confirm") confirm(true);
    else if (d.method === "select") {
      if (d.options?.length) respondToExtDialog({ value: d.options[0] });
    } else if (d.method === "input") {
      submitValue();
    }
  }

  /** Focus the first control when the dialog opens; hand focus back on close. */
  const focusFirst: Action<HTMLElement> = (node) => {
    const prior = document.activeElement as HTMLElement | null;
    node.querySelector<HTMLElement>("input, textarea, button")?.focus();
    return { destroy() { prior?.focus(); } };
  };
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay">
  {#key d.id}
  <div class="card" use:focusFirst>
    <h3>{d.title || "Extension request"}</h3>
    {#if d.message}
      <p class="msg">{d.message}</p>
    {/if}

    {#if d.method === "select"}
      <div class="options">
        {#each d.options ?? [] as opt, i (opt + ":" + i)}
          <button onclick={() => respondToExtDialog({ value: opt })}>{opt}</button>
        {/each}
      </div>
    {:else if d.method === "confirm"}
      <div class="options">
        <button class="primary" onclick={() => confirm(true)}>Yes</button>
        <button onclick={() => confirm(false)}>No</button>
      </div>
    {:else if d.method === "input"}
      <input
        type="text"
        bind:value={inputValue}
        placeholder={d.placeholder ?? ""}
      />
      <div class="options">
        <button class="primary" onclick={submitValue}>OK</button>
        <button onclick={cancel}>Cancel</button>
      </div>
    {:else if d.method === "editor"}
      <textarea bind:value={inputValue} rows="8"></textarea>
      <div class="options">
        <button class="primary" onclick={submitValue}>Save</button>
        <button onclick={cancel}>Cancel</button>
      </div>
    {/if}
  </div>
  {/key}
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(10, 10, 16, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }
  .card {
    width: min(440px, 90vw);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow);
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h3 { margin: 0; font-size: 14.5px; }
  .msg { margin: 0; font-size: 13px; color: var(--text-2); }
  .options { display: flex; gap: 8px; flex-wrap: wrap; }
  textarea { resize: vertical; }
</style>

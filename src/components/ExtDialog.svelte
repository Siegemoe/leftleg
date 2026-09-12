<script lang="ts">
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
    if (e.key === "Enter") { e.preventDefault(); submitValue(); }
    else if (e.key === "Escape") { cancel(); }
  }
</script>

<div class="overlay">
  <div class="card">
    <h3>{d.title || "Extension request"}</h3>
    {#if d.method === "confirm" && d.message}
      <p class="msg">{d.message}</p>
    {/if}

    {#if d.method === "select"}
      <div class="options">
        {#each d.options ?? [] as opt}
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
        onkeydown={onKeydown}
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

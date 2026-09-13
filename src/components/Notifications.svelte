<script lang="ts">
  // Toast stack for pi extension notifications (extension_ui_request method "notify").
  // info/warning auto-dismiss (timers live in the store); errors stay until dismissed.
  import { notifications, dismissNotification } from "../lib/stores";
  import { CircleX, Info, TriangleAlert } from "@lucide/svelte";
</script>

{#if $notifications.length > 0}
  <div class="stack" role="status" aria-live="polite">
    {#each $notifications as n (n.id)}
      <div class="toast {n.notifyType}">
        <span class="icon">
          {#if n.notifyType === "warning"}
            <TriangleAlert size={13} strokeWidth={2} />
          {:else if n.notifyType === "error"}
            <CircleX size={13} strokeWidth={2} />
          {:else}
            <Info size={13} strokeWidth={2} />
          {/if}
        </span>
        <span class="msg">{n.message}</span>
        <button class="ghost dismiss" onclick={() => dismissNotification(n.id)} title="Dismiss" aria-label="Dismiss notification">×</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .stack {
    position: fixed;
    top: calc(var(--topbar-h) + 10px);
    right: 16px;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 380px;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
    font-size: 12.5px;
  }
  .toast.info { border-left: 3px solid var(--accent); }
  .toast.warning { border-left: 3px solid orange; }
  .toast.error { border-left: 3px solid var(--danger); }
  .toast.warning .icon { color: orange; }
  .toast.error .icon { color: var(--danger); }
  .toast.info .icon { color: var(--accent); }
  .msg { flex: 1; min-width: 0; word-break: break-word; color: var(--text-2); }
  .icon { flex-shrink: 0; font-size: 12px; }
  .dismiss {
    flex-shrink: 0;
    font-size: 13px;
    line-height: 1;
    padding: 1px 4px;
    color: var(--text-3);
  }
  .dismiss:hover { color: var(--text); }
</style>

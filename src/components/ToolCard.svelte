<script lang="ts">
  import type { ToolItem } from "../lib/types";
  import { openPath as openInDefaultApp } from "@tauri-apps/plugin-opener";

  let { item }: { item: ToolItem } = $props();

  let expanded = $state(false);

  const toolLabel: Record<string, string> = {
    read: "Read",
    write: "Wrote",
    edit: "Modified",
    bash: "Ran command",
    powershell: "Ran command",
    grep: "Searched",
    find: "Searched",
    ls: "Listed",
  };

  let label = $derived(toolLabel[item.name] ?? item.name);
  let target = $derived.by(() => {
    try {
      const a = JSON.parse(item.args);
      return (a.path ?? a.file_path ?? a.command ?? a.pattern ?? "") as string;
    } catch { return ""; }
  });
  let shortTarget = $derived.by(() => {
    if (!target) return "";
    const p = target.split(/[\\/]/);
    return p.length > 1 ? p.slice(-2).join("/") : target;
  });
  let isFile = $derived(["read", "write", "edit"].includes(item.name));
  let lines = $derived.by(() => {
    try {
      const a = JSON.parse(item.args);
      if (a.command) return null;
      if (a.content) return a.content.split("\n").length;
      return null;
    } catch { return null; }
  });
  let diffStats = $derived.by(() => {
    if (!item.diff) return null;
    let plus = 0, minus = 0;
    for (const l of item.diff.split("\n")) {
      if (l.startsWith("+") && !l.startsWith("+++")) plus++;
      else if (l.startsWith("-") && !l.startsWith("---")) minus++;
    }
    return { plus, minus };
  });
  let filePath = $derived.by(() => {
    try {
      const a = JSON.parse(item.args);
      return (a.path ?? a.file_path ?? "") as string;
    } catch { return ""; }
  });
</script>

<div class="card" class:running={item.status === "running"} class:error={item.status === "error"}>
  <button class="head" onclick={() => (expanded = !expanded)}>
    <span class="status-dot" />
    <span class="lbl">{item.status === "running" ? `${label === item.name ? item.name : label}…` : label}</span>
    {#if shortTarget}
      <span class="target mono" title={target}>{shortTarget}</span>
    {/if}
    {#if lines !== null}
      <span class="meta">{lines} lines</span>
    {/if}
    <span class="spacer" />
    {#if diffStats}
      <span class="diffstat"><span class="plus">+{diffStats.plus}</span> <span class="minus">−{diffStats.minus}</span></span>
    {/if}
    <span class="chev">{expanded ? "▾" : "▸"}</span>
  </button>

  {#if expanded}
    <div class="body">
      {#if item.args && item.args !== "{}"}
        <div class="kv"><span class="k">args</span><pre class="mono args">{item.args}</pre></div>
      {/if}
      {#if item.diff}
        <pre class="mono diff">{item.diff}</pre>
        {#if isFile && filePath}
          <div class="actions">
            <button onclick={() => openInDefaultApp(filePath)}>Open file</button>
          </div>
        {/if}
      {/if}
      {#if item.output}
        <pre class="mono out" class:err={item.isError}>{item.output}{item.outputTruncated ? "\n… (truncated)" : ""}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .card {
    max-width: 860px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    margin: 4px 0 4px 24px;
    overflow: hidden;
  }
  .card.running { border-color: var(--accent); }
  .card.error { border-color: var(--danger); }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 7px 11px;
    text-align: left;
    font-size: 12.8px;
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ok);
    flex-shrink: 0;
  }
  .running .status-dot { background: var(--accent); animation: pulse 1.1s ease-in-out infinite; }
  .error .status-dot { background: var(--danger); }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .lbl { font-weight: 600; white-space: nowrap; }
  .target {
    color: var(--text-3);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta { color: var(--text-3); font-size: 11.5px; white-space: nowrap; }
  .diffstat { font-family: var(--font-mono); font-size: 12px; white-space: nowrap; }
  .plus { color: var(--ok); }
  .minus { color: var(--danger); }
  .chev { color: var(--text-3); font-size: 10px; }
  .body {
    border-top: 1px solid var(--border);
    background: var(--bg-inset);
    padding: 8px 11px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  pre {
    margin: 0;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .args { color: var(--text-2); font-size: 11.5px; }
  .diff { font-size: 12px; line-height: 1.45; }
  .out { font-size: 12px; max-height: 320px; overflow-y: auto; }
  .out.err { color: var(--danger); }
  .actions { display: flex; gap: 6px; }
  .kv { display: flex; flex-direction: column; gap: 3px; }
  .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-3); font-weight: 600; }
</style>

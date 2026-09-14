<script lang="ts">
  import type { ToolItem } from "../lib/types";
  import { openPath as openInDefaultApp } from "@tauri-apps/plugin-opener";
  import { resolve as resolvePath } from "@tauri-apps/api/path";
  import { projectDir, statusNote } from "../lib/stores";
  import { readFileBase64 } from "../lib/api";

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
    image_generate: "Generated image",
  };

  // Base64 data URLs above this size render as file chips instead of <img>
  // (same bound as chat-embedded images — multi-MB previews crash the webview).
  const MAX_INLINE_IMAGE_BASE64 = 1_500_000;

  let label = $derived(toolLabel[item.name] ?? item.name);
  let target = $derived.by(() => {
    try {
      const a = JSON.parse(item.args);
      const value = a.path ?? a.file_path ?? a.command ?? a.pattern;
      return typeof value === "string" ? value : "";
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
      const value = a.path ?? a.file_path;
      return typeof value === "string" ? value : "";
    } catch { return ""; }
  });
  async function openFile() {
    try { await openInDefaultApp(await resolvePath($projectDir, filePath)); }
    catch (e) { statusNote.set(`Couldn't open file: ${e}`); }
  }

  // ---------- image_generate presentation ----------
  // The generation flow: running → animated "developing" placeholder; done →
  // the image renders in place. Paths come from the tool's structured details
  // first; older sessions that persisted only the text fall back to parsing
  // the deterministic result lines.

  const isImageGen = $derived(item.name === "image_generate");
  let imageArgs = $derived.by(() => {
    if (!isImageGen) return null;
    try { return JSON.parse(item.args) as { aspect_ratio?: string }; } catch { return null; }
  });
  let placeholderAr = $derived.by(() => {
    const ar = imageArgs?.aspect_ratio ?? "";
    return /^\d{1,3}:\d{1,3}$/.test(ar) ? ar.replace(":", " / ") : "4 / 3";
  });
  let progressText = $derived(item.status === "running" ? item.output.trim() : "");

  function parsePathsFromOutput(output: string): string[] {
    const paths: string[] = [];
    for (const line of output.split(/\r?\n/)) {
      const t = line.trim();
      // Windows absolute (C:\…) and Unix absolute (/…) paths with image extensions.
      if (/^(?:[a-za-z]:[\\/]|\/).+\.(png|jpe?g|webp|svg|gif)$/i.test(t)) paths.push(t);
    }
    return paths;
  }
  let imagePaths = $derived.by(() => {
    if (!isImageGen || item.status !== "done") return [];
    const fromDetails = item.details?.paths;
    if (Array.isArray(fromDetails) && fromDetails.every((p) => typeof p === "string")) {
      return fromDetails as string[];
    }
    return parsePathsFromOutput(item.output);
  });
  let imageMeta = $derived.by(() => {
    if (!isImageGen) return null;
    const details = item.details ?? {};
    const usage = details.usage as { cost?: number } | null | undefined;
    let cost = typeof usage?.cost === "number" ? usage.cost : undefined;
    const model = typeof details.model === "string" ? details.model : undefined;
    const references = typeof details.references === "number" ? details.references : 0;
    if (cost === undefined) {
      const m = item.output.match(/Reported cost: \$([0-9.]+)/);
      if (m) cost = Number(m[1]);
    }
    return { model, cost, references };
  });

  interface ImageThumb { path: string; dataUrl: string | null; tooBig: boolean; error: string | null }
  // Cache data URLs across re-renders and transcript reloads — generating the
  // same base64 twice costs a file read + GC churn for zero visual change.
  // Keyed by absolute path (project-safe); bounded so long sessions with many
  // images can't accumulate unbounded base64 in memory.
  const thumbCache = new Map<string, ImageThumb>();
  const THUMB_CACHE_LIMIT = 24;
  let thumbEpoch = 0;
  let thumbs = $state<ImageThumb[]>([]);

  function mimeFor(path: string): string {
    const ext = (path.split(".").pop() ?? "").toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "webp") return "image/webp";
    if (ext === "svg") return "image/svg+xml";
    if (ext === "gif") return "image/gif";
    return "image/png";
  }

  $effect(() => {
    if (!isImageGen || item.status !== "done" || imagePaths.length === 0) {
      // Invalidate in-flight loads from a superseded render.
      thumbEpoch++;
      if (thumbs.length > 0) thumbs = [];
      return;
    }
    // Snapshot the dependency list; the effect re-runs when it changes.
    const paths = imagePaths;
    const myEpoch = ++thumbEpoch;
    const next: ImageThumb[] = paths.map((p) => thumbCache.get(p) ?? { path: p, dataUrl: null, tooBig: false, error: null });
    thumbs = next;
    for (let i = 0; i < next.length; i++) {
      const t = next[i];
      if (t.dataUrl !== null || t.tooBig || t.error !== null) continue;
      void (async () => {
        let updated: ImageThumb;
        try {
          const b64 = await readFileBase64(t.path);
          updated = b64.length > MAX_INLINE_IMAGE_BASE64
            ? { ...t, tooBig: true }
            : { ...t, dataUrl: `data:${mimeFor(t.path)};base64,${b64}` };
        } catch (e) {
          updated = { ...t, error: e instanceof Error ? e.message : String(e) };
        }
        // Cache is path-keyed and always valid; the VIEW only takes the update
        // if this render is still current and the entry is still blank.
        if (thumbCache.size > THUMB_CACHE_LIMIT) thumbCache.clear();
        thumbCache.set(t.path, updated);
        if (myEpoch !== thumbEpoch) return;
        thumbs = thumbs.map((x) => (x.path === t.path && x.dataUrl === null && !x.tooBig && x.error === null ? updated : x));
      })();
    }
  });

  async function openImage(path: string) {
    try { await openInDefaultApp(path); }
    catch (e) { statusNote.set(`Couldn't open image: ${e}`); }
  }
</script>

<div class="card" class:running={item.status === "running"} class:error={item.status === "error"} class:imggen={isImageGen}>
  <button class="head" onclick={() => (expanded = !expanded)}>
    <span class="status-dot"></span>
    <span class="lbl">{item.status === "running" ? `${label === item.name ? item.name : label}…` : label}</span>
    {#if isImageGen && imageMeta?.model}
      <span class="target mono" title={imageMeta.model}>{imageMeta.model}</span>
    {:else if shortTarget}
      <span class="target mono" title={target}>{shortTarget}</span>
    {/if}
    {#if lines !== null}
      <span class="meta">{lines} lines</span>
    {/if}
    <span class="spacer"></span>
    {#if isImageGen && imageMeta?.cost !== undefined}
      <span class="meta" title="Reported by OpenRouter">${imageMeta.cost.toFixed(4)}</span>
    {/if}
    {#if isImageGen && imageMeta?.references}
      <span class="meta" title="reference images">{imageMeta.references} ref</span>
    {/if}
    {#if diffStats}
      <span class="diffstat"><span class="plus">+{diffStats.plus}</span> <span class="minus">−{diffStats.minus}</span></span>
    {/if}
    <span class="chev">{expanded ? "▾" : "▸"}</span>
  </button>

  {#if isImageGen && item.status === "running"}
    <div class="imgstage">
      <div class="imgph" style:--ph-ar={placeholderAr} role="img" aria-label="image generating">
        <div class="sweep"></div>
        <div class="scan"></div>
        <div class="ph-mark">
          <span class="ph-dot"></span><span class="ph-dot"></span><span class="ph-dot"></span>
        </div>
      </div>
      {#if progressText}
        <div class="ph-progress mono">{progressText}</div>
      {/if}
    </div>
  {:else if isImageGen && item.status === "done" && thumbs.length > 0}
    <div class="imgstage">
      <div class="imgs" class:multi={thumbs.length > 1}>
        {#each thumbs as t (t.path)}
          {#if t.dataUrl}
            <button class="imgbtn" title="Open full size — {t.path}" onclick={() => void openImage(t.path)}>
              <img src={t.dataUrl} alt={t.path.split(/[\\/]/).pop() ?? "generated image"} />
            </button>
          {:else if t.tooBig}
            <button class="imgchip mono" title={t.path} onclick={() => void openImage(t.path)}>
              ⬒ {t.path.split(/[\\/]/).pop()} — too large to preview, click to open
            </button>
          {:else if t.error}
            <span class="imgchip mono err" title={t.error}>⚠ couldn't load preview</span>
          {:else}
            <div class="imgph small" style:--ph-ar="16 / 10"><div class="sweep"></div></div>
          {/if}
        {/each}
      </div>
    </div>
  {/if}

  {#if expanded}
    <div class="body">
      {#if item.args && item.args !== "{}"}
        <div class="kv"><span class="k">args</span><pre class="mono args">{item.args}</pre></div>
      {/if}
      {#if item.diff}
        <pre class="mono diff">{item.diff}</pre>
        {#if isFile && filePath}
          <div class="actions">
            <button onclick={openFile}>Open file</button>
          </div>
        {/if}
      {/if}
      {#if item.output && !(isImageGen && item.status === "running")}
        <pre class="mono out" class:err={item.isError}>{item.output}{item.outputTruncated ? "\n… (truncated)" : ""}</pre>
      {/if}
      {#if isImageGen && imagePaths.length > 0}
        <div class="actions">
          {#each imagePaths as p (p)}
            <button class="mono" onclick={() => void openImage(p)}>Open {p.split(/[\\/]/).pop()}</button>
          {/each}
        </div>
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
  .card.imggen { max-width: 560px; }
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
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .kv { display: flex; flex-direction: column; gap: 3px; }
  .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-3); font-weight: 600; }

  /* ---------- image_generate stage ---------- */
  .imgstage {
    padding: 8px 11px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .imgph {
    position: relative;
    overflow: hidden;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
    background:
      radial-gradient(120% 90% at 30% 20%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 60%),
      var(--bg-inset);
    max-width: 420px;
    aspect-ratio: var(--ph-ar, 4 / 3);
  }
  .imgph.small {
    max-width: 280px;
    width: 100%;
    border-color: var(--border);
  }
  .imgph .sweep {
    position: absolute;
    inset: -20%;
    background: linear-gradient(105deg, transparent 30%, color-mix(in srgb, var(--accent) 16%, transparent) 50%, transparent 70%);
    transform: translateX(-70%);
    animation: sweep 2.2s ease-in-out infinite;
  }
  @keyframes sweep { 55%, 100% { transform: translateX(70%); } }
  .imgph .scan {
    position: absolute;
    left: 6%;
    right: 6%;
    height: 1px;
    background: color-mix(in srgb, var(--accent) 60%, transparent);
    box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 40%, transparent);
    animation: scan 2.6s ease-in-out infinite;
  }
  @keyframes scan {
    0% { top: 10%; opacity: 0; }
    15% { opacity: 1; }
    85% { opacity: 1; }
    100% { top: 90%; opacity: 0; }
  }
  .ph-mark {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
  }
  .ph-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--accent) 70%, transparent);
    animation: dotwave 1.2s ease-in-out infinite;
  }
  .ph-dot:nth-child(2) { animation-delay: 0.15s; }
  .ph-dot:nth-child(3) { animation-delay: 0.3s; }
  @keyframes dotwave { 0%, 100% { opacity: 0.25; transform: translateY(0); } 45% { opacity: 1; transform: translateY(-4px); } }
  .ph-progress {
    color: var(--text-3);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .imgs { display: flex; gap: 8px; flex-wrap: wrap; }
  .imgs.multi { max-height: 420px; overflow-y: auto; }
  .imgbtn {
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    background: var(--bg-inset);
    cursor: zoom-in;
    line-height: 0;
    max-width: 420px;
  }
  .imgbtn:hover { border-color: var(--accent); }
  .imgbtn img {
    display: block;
    max-width: 420px;
    max-height: 400px;
    width: auto;
    height: auto;
  }
  .imgchip {
    display: inline-flex;
    align-items: center;
    padding: 7px 11px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-inset);
    color: var(--text-2);
    font-size: 11.5px;
    cursor: pointer;
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .imgchip:hover { border-color: var(--border-strong); }
  .imgchip.err { color: var(--danger); cursor: default; }
</style>

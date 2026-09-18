<script lang="ts">
  // Leftleg Settings workspace — a roomy, searchable panel over Pi's real
  // configuration surfaces. File-backed sections read/write through the
  // settings-mgmt companion (allowlisted targets, revision-checked, atomic).
  // Current-runtime controls use native RPC setters only.
  import {
    settingsOpen, settingsProject, connected, rpcState, models, commands, projectDir,
    theme, applyTheme, compact, renameSession, setModel, setThinkingLevel,
    setSteeringMode, setFollowUpMode, setAutoCompaction, setAutoRetry, abortRetry,
    exportSessionHtml, cloneSession, projectMeta, sessions, updateProjectMeta,
    forgetProject, restoreProject, chooseProject, autoRetry, refreshCommands,
    statusNote, transientNote, navigating, updateInstallLock, openNewProject,
  } from "../../lib/stores";
  import { companionAvailable, bindManagement, agentDirStore, isCompanionCommand } from "../../lib/settings/mgmt";
  import { PROJECT_COLOR_CHOICES, PROJECT_ICON_CHOICES, projectIconStyle, projectIconLabel } from "../../lib/project-icons";
  import ProjectIcon from "../ProjectIcon.svelte";
  import { checkForUpdates, applyUpdate, updateAvailable, updateCheck, updateStatus } from "../../lib/updater";
  import { onDestroy, untrack } from "svelte";
  const mgmtRequest = bindManagement();
  // Template mirror of mgmt.companionAvailable() — the function reads the
  // stores through get(), which is untracked, so calling it from markup
  // rendered stale availability. The chip shares mgmt's exact predicate
  // (name + anchored provenance) and tracks the agent-dir store, so it
  // re-evaluates the moment the lookup resolves and cannot disagree with
  // the send gate in either direction. Keep the function for imperative callers.
  const companionReady = $derived(
    !$navigating && !$updateInstallLock && $commands.some((c) => isCompanionCommand(c, $agentDirStore ?? undefined)),
  );
  import {
    getPath, setPath, cloneJson, sourceOf, effectiveValue, defaultValue,
    isUnsafeConfigKey, preparePatch,
    BUILTIN_TOOLS, THINKING_LEVELS, type Scope,
  } from "../../lib/settings/state";
  import { writeAgentExtension, getAgentDir } from "../../lib/api";
  import { Search, X, RotateCcw, FolderOpen, RefreshCw, Plus } from "@lucide/svelte";
  import PackageForms from "./PackageForms.svelte";
  import companionSource from "../../../companion/leftleg-settings/index.ts?raw";
  import mediaSource from "../../../companion/leftleg-media/index.ts?raw";

  type SectionId =
    | "runtime" | "behavior" | "models" | "tools" | "trust"
    | "packages" | "appearance" | "projects" | "advanced";

  const SECTIONS: { id: SectionId; label: string; hint: string }[] = [
    { id: "runtime", label: "Current runtime", hint: "Live session choices (native RPC)" },
    { id: "behavior", label: "Agent behavior", hint: "settings.json — defaults & policies" },
    { id: "models", label: "Models & cycling", hint: "Startup defaults, cycling, registry" },
    { id: "tools", label: "Tools & shell", hint: "Built-in tools, shell, npm argv" },
    { id: "trust", label: "Trust & privacy", hint: "Project trust, telemetry" },
    { id: "packages", label: "Extensions & packages", hint: "Installed packages, extension configs" },
    { id: "appearance", label: "Appearance (Leftleg)", hint: "Leftleg theme — not Pi's TUI" },
    { id: "projects", label: "Project presentation", hint: "Leftleg-only names, icons, defaults" },
    { id: "advanced", label: "Advanced & diagnostics", hint: "Companion, resources, build identity" },
  ];

  let section = $state<SectionId>("behavior");
  // Media agent defaults load once when the Models section is first opened.
  let mediaConfigTried = false;
  $effect(() => {
    if (section === "models" && !mediaConfigTried) {
      mediaConfigTried = true;
      void loadExt("media-config").catch(() => {});
    }
  });
  let search = $state("");
  let scope = $state<Scope>(untrack(() => $settingsProject ? "project" : "global"));
  let close = () => settingsOpen.set(false);

  // ---- file-backed settings state ----
  interface FileState { data: Record<string, unknown> | null; revision: string | null; exists: boolean }
  let globalState = $state<FileState>({ data: null, revision: null, exists: false });
  let projectState = $state<FileState>({ data: null, revision: null, exists: false });
  let loaded = $state(false);
  let loading = $state(false);
  let loadError = $state("");
  let saveState = $state<"idle" | "saving" | "saved" | "error">("idle");
  let saveError = $state("");
  let draft = $state<Record<string, unknown>>({});
  let inheritKeys = $state<string[]>([]);
  let agentDir = $state("");

  const scopeData = $derived(scope === "global" ? globalState : projectState);
  const dirty = $derived(JSON.stringify(stripUndefined(draft)) !== JSON.stringify(stripUndefined(scopeData.data ?? {})));

  function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      out[k] = v !== null && typeof v === "object" && !Array.isArray(v) ? stripUndefined(v as Record<string, unknown>) : v;
    }
    return out;
  }

  async function loadAll(force = false) {
    if (loaded && !force) return;
    loading = true;
    loadError = "";
    try {
      const g = await mgmtRequest<{ exists: boolean; data: Record<string, unknown> | null; revision: string | null }>("read", { target: "settings-global" });
      globalState = { data: g.data ?? null, revision: g.revision ?? null, exists: g.exists };
      const p = await mgmtRequest<{ exists: boolean; data: Record<string, unknown> | null; revision: string | null }>("read", { target: "settings-project" });
      projectState = { data: p.data ?? null, revision: p.revision ?? null, exists: p.exists };
      resetDraft();
      loaded = true;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function resetDraft() {
    draft = cloneJson(scopeData.data ?? {});
    inheritKeys = [];
    saveState = "idle";
    saveError = "";
  }

  function switchScope(s: Scope) {
    if (s === scope || saveState === "saving" || loading) return;
    if (dirty && !confirm("Discard unsaved edits for the current scope?")) return;
    scope = s;
    resetDraft();
  }

  async function applySettings() {
    saveState = "saving";
    saveError = "";
    try {
      const target = scope === "global" ? "settings-global" : "settings-project";
      const revision = scopeData.revision;
      // Remove inherit-marked paths from the draft before merging.
      const patch = stripUndefined(cloneJson(draft));
      const wrote = await mgmtRequest<{ revision?: string | null }>("write", { target, mode: "merge", patch, revision, unsetKeys: [...inheritKeys] });
      const st = scope === "global" ? globalState : projectState;
      try {
        // Read back through the authoritative file (resolver proof).
        const back = await mgmtRequest<{ exists: boolean; data: Record<string, unknown> | null; revision: string | null }>("read", { target });
        st.data = back.data ?? null;
        st.revision = back.revision ?? wrote.revision ?? null;
        st.exists = back.exists;
      } catch (readErr) {
        // The write landed; adopting its post-write revision keeps the next
        // Apply conflict-free even when read-back verification fails.
        st.revision = wrote.revision ?? st.revision;
        saveState = "error";
        saveError = `Saved, but read-back verification failed: ${readErr instanceof Error ? readErr.message : String(readErr)}`;
        return;
      }
      resetDraft();
      saveState = "saved";
    } catch (e) {
      saveState = "error";
      saveError = e instanceof Error ? e.message : String(e);
    }
  }

  function markInherit(path: string) {
    // Never traverse reserved object keys while clearing a draft path.
    if (path.split(".").some(isUnsafeConfigKey)) return;
    if (!inheritKeys.includes(path)) inheritKeys = [...inheritKeys, path];
    // remove from draft so the form shows the inherited/effective value
    const parts = path.split(".");
    let cur: Record<string, unknown> = draft;
    for (let i = 0; i < parts.length - 1; i++) {
      const nxt = cur[parts[i]];
      if (!nxt || typeof nxt !== "object") { cur = {}; break; }
      cur = nxt as Record<string, unknown>;
    }
    delete cur[parts[parts.length - 1]];
    draft = { ...draft };
  }

  function sourceChip(path: string): string {
    if (inheritKeys.includes(path)) return "reset → inherited";
    return sourceOf(projectState.data, globalState.data, path);
  }

  // ---- field helpers ----
  function fieldStr(path: string): string {
    if (inheritKeys.includes(path)) return "";
    const v = getPath(draft, path);
    return v === undefined ? "" : String(v);
  }
  function setFieldStr(path: string, v: string) {
    if (v === "") { markInherit(path); return; }
    inheritKeys = inheritKeys.filter((k) => k !== path);
    setPath(draft, path, v === "" ? undefined : v);
    draft = { ...draft };
  }
  function fieldNum(path: string): string {
    const v = getPath(draft, path);
    return v === undefined || v === null ? "" : String(v);
  }
  function rejectBadNumber(path: string, input: HTMLInputElement): boolean {
    const v = input.value.trim();
    // Incomplete numeric typing has value="" too; validity distinguishes it
    // from a deliberate clear before that clear can remove the setting.
    if (!input.validity.badInput && (v === "" || Number.isFinite(Number(v)))) return false;
    transientNote(`Invalid number for ${path} — value kept`, 6000);
    return true;
  }
  function setFieldNum(path: string, input: HTMLInputElement) {
    if (rejectBadNumber(path, input)) return;
    const v = input.value;
    if (v.trim() === "") { markInherit(path); return; }
    inheritKeys = inheritKeys.filter((k) => k !== path);
    const n = Number(v);
    setPath(draft, path, n);
    draft = { ...draft };
  }
  function fieldBool(path: string): boolean {
    const v = inheritKeys.includes(path) ? undefined : getPath(draft, path);
    const eff = v === undefined && scope === "project" ? getPath(globalState.data, path) : v;
    return eff === undefined ? (defaultValue(path) === true) : eff === true;
  }
  function setFieldBool(path: string, v: boolean) {
    inheritKeys = inheritKeys.filter((k) => k !== path);
    setPath(draft, path, v);
    draft = { ...draft };
  }
  function fieldInherited(path: string): boolean {
    return inheritKeys.includes(path) || getPath(draft, path) === undefined;
  }
  function matchesSearch(...texts: (string | undefined)[]): boolean {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return texts.some((t) => t && t.toLowerCase().includes(q));
  }

  // ---- multi-line list textareas ----
  // The draft holds these as filtered string arrays, so binding the join()
  // directly rewrites the textarea the moment you press Enter (the trailing
  // empty line is filtered out of the draft) — the newline is deleted, the
  // cursor resets, and the next word glues onto the previous line. Mirror the
  // raw text locally, parse into the draft on change (blur), and resync from
  // the draft only when the mirror no longer parses to the same list, so
  // loads / scope switches / project switches (resetDraft reassigns `draft`)
  // stay fresh while uncommitted typing is never clobbered — change always
  // commits on blur before any other field can touch the draft.
  let enabledModelsText = $state("");
  let npmCommandText = $state("");
  function parseLines(text: string): string[] {
    return text.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  function linesToDraft(path: "enabledModels" | "npmCommand", text: string) {
    setPath(draft, path, parseLines(text));
    draft = { ...draft };
  }
  $effect(() => {
    const canonical = ((getPath(draft, "enabledModels") ?? []) as string[]).join("\n");
    if (untrack(() => parseLines(enabledModelsText).join("\n")) !== canonical) enabledModelsText = canonical;
  });
  $effect(() => {
    const canonical = ((getPath(draft, "npmCommand") ?? []) as string[]).join("\n");
    if (untrack(() => parseLines(npmCommandText).join("\n")) !== canonical) npmCommandText = canonical;
  });

  // ---- companion / resources ----
  let resInfo = $state<{ packages?: unknown[]; extensionDirs?: string[]; skillDirs?: string[]; agentDir?: string; filesPresent?: Record<string, boolean>; packageVersions?: { name: string; version: string }[] } | null>(null);
  let installing = $state(false);
  let installMsg = $state("");

  async function loadResources() {
    try {
      resInfo = await mgmtRequest<NonNullable<typeof resInfo>>("list-resources", {});
    } catch { resInfo = null; }
  }

  async function installCompanion() {
    installing = true;
    installMsg = "";
    try {
      await writeAgentExtension("leftleg-settings/index.ts", companionSource);
      await writeAgentExtension("leftleg-media/index.ts", mediaSource);
      await refreshCommands();
      installMsg = companionAvailable()
        ? "Companions installed — settings bridge ready; image_generate becomes available on the next pi restart or new session."
        : "Installed, but not visible yet — restart pi (defer; nothing was interrupted).";
      await loadResources();
    } catch (e) {
      installMsg = e instanceof Error ? e.message : String(e);
    } finally {
      installing = false;
    }
  }

  // ---- packages toggle ----
  function packageEntries(): string[] {
    const raw = (scopeData.data?.packages ?? globalState.data?.packages ?? []) as unknown[];
    return raw.filter((x): x is string => typeof x === "string");
  }
  async function togglePackage(name: string, disabled: boolean) {
    try {
      const current = (scopeData.data?.packages ?? globalState.data?.packages ?? []) as unknown[];
      const next = disabled ? current.filter((n) => n !== name) : [...current, name];
      const target = scope === "global" ? "settings-global" : "settings-project";
      await mgmtRequest("write", { target, mode: "merge", patch: { packages: next }, revision: scopeData.revision });
      const back = await mgmtRequest<{ data: Record<string, unknown> | null; revision: string | null }>("read", { target });
      const st = scope === "global" ? globalState : projectState;
      st.data = back.data ?? null;
      st.revision = back.revision ?? null;
      resetDraft();
    } catch (e) {
      saveError = e instanceof Error ? e.message : String(e);
      saveState = "error";
    }
  }

  // ---- extension config editors (file-backed) ----
  interface ExtFile { data: Record<string, unknown> | null; raw: string | null; revision: string | null; exists: boolean }
  let extFiles = $state<Record<string, ExtFile>>({});
  async function loadExt(target: string) {
    try {
      const r = await mgmtRequest<{ exists: boolean; data: Record<string, unknown> | null; raw: string | null; revision: string | null }>("read", { target });
      extFiles = { ...extFiles, [target]: { data: r.data ?? null, raw: r.raw, revision: r.revision ?? null, exists: r.exists } };
    } catch (e) { statusNote.set(`Couldn't load configuration: ${e}`); throw e; }
  }
  function extDraft(target: string): Record<string, unknown> {
    return (extFiles[target]?.data ?? {}) as Record<string, unknown>;
  }
  function flashSaved() {
    statusNote.set("Saved — read back from the file.");
    setTimeout(() => statusNote.set(""), 4000);
  }
  async function saveExt(target: string, patch: Record<string, unknown>) {
    try {
      const cur = extFiles[target];
      const changes = preparePatch(patch);
      await mgmtRequest("write", { target, mode: "merge", ...changes, revision: cur?.revision ?? null });
      await loadExt(target);
      flashSaved();
    } catch (e) {
      statusNote.set(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => statusNote.set(""), 6000);
    }
  }
  async function saveExtNamespace(target: string, namespace: string, value: Record<string, unknown>) {
    try {
      const cur = extFiles[target];
      await mgmtRequest("write", { target, mode: "namespace", patch: { [namespace]: value }, revision: cur?.revision ?? null });
      await loadExt(target);
      flashSaved();
    } catch (e) {
      statusNote.set(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => statusNote.set(""), 6000);
    }
  }

  // ---- model catalog ----
  let modelFilter = $state("");
  const catalogModels = $derived.by(() => {
    const q = modelFilter.trim().toLowerCase();
    const list = $models;
    return q ? list.filter((m) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q)) : list;
  });

  let refreshing = $state(false);
  let refreshMsg = $state("");
  async function refreshRegistry() {
    refreshing = true;
    refreshMsg = "";
    try {
      await mgmtRequest("refresh-models", {});
      refreshMsg = "Model registry refresh requested via companion — verify availability with the runtime model list.";
    } catch (e) {
      refreshMsg = e instanceof Error ? e.message : String(e);
    } finally {
      refreshing = false;
    }
  }

  // ---- raw advanced editor ----
  let advTarget = $state("");
  let advJson = $state("");
  $effect(() => {
    const t = advTarget;
    const f = extFiles[t];
    if (t && f) advJson = f.exists ? f.raw ?? JSON.stringify(f.data ?? {}, null, 2) : "{}";
  });
  async function applyAdvJson() {
    try {
      JSON.parse(advJson);
      const cur = extFiles[advTarget];
      if (!cur) throw new Error("Load the file before saving");
      await mgmtRequest("write", { target: advTarget, mode: "replace", content: advJson, revision: cur.revision });
      await loadExt(advTarget);
      void loadAll(true);
      statusNote.set("Saved — read back from the file.");
      setTimeout(() => statusNote.set(""), 4000);
    } catch (e) {
      statusNote.set(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => statusNote.set(""), 8000);
    }
  }

  function discardSettings() {
    resetDraft();
    inheritKeys = [];
  }

  // ---- lifecycle ----
  let sessionName = $state($rpcState?.sessionName ?? "");
  let renameTimer: ReturnType<typeof setTimeout> | null = null;
  function onSessionNameInput(e: Event) {
    sessionName = (e.currentTarget as HTMLInputElement).value;
    if (renameTimer) clearTimeout(renameTimer);
    const name = sessionName;
    const path = $rpcState?.sessionFile;
    renameTimer = setTimeout(() => {
      renameTimer = null;
      void renameSession(name, path);
    }, 700);
  }
  onDestroy(() => { if (renameTimer) clearTimeout(renameTimer); });
  $effect(() => {
    // refreshRpcState re-fires this store after every RPC (sendPrompt,
    // setModel, rename ack, session switch). While a rename debounce is
    // pending the user is mid-typing — adopting pi's canonical name here
    // would wipe it, so hold off. The timer clears itself when it fires, so
    // the next store change (the rename ack itself, or a session switch)
    // resyncs the field normally.
    const canonicalName = $rpcState?.sessionName ?? "";
    if (renameTimer) return;
    sessionName = canonicalName;
  });

  $effect(() => {
    // load once when the workspace becomes visible
    if ($settingsOpen) untrack(() => {
      void getAgentDir().then((d) => (agentDir = d)).catch(() => {});
      void loadAll();
      if (companionAvailable()) void loadResources();
    });
  });
</script>

{#snippet applyBar()}
  <div class="apply-bar">
    <span class="hint">
      {dirty ? "Unsaved edits" : "No unsaved edits"}{inheritKeys.length > 0 ? ` · ${inheritKeys.length} field(s) reset to inherited` : ""}
      {#if saveState === "saved"} · <span class="chip ok">Saved — verified by read-back</span>{/if}
      {#if saveState === "error"} · <span class="hint err">{saveError}</span>{/if}
    </span>
    <span class="spacer"></span>
    <button class="ghost" onclick={discardSettings} disabled={!loaded || loading || !dirty || saveState === "saving"}>Discard</button>
    <button class="primary" onclick={() => void applySettings()} disabled={!loaded || loading || !dirty || saveState === "saving"}>{saveState === "saving" ? "Saving…" : "Apply &amp; verify".replace("&amp;", "&")}</button>
  </div>
{/snippet}

<div class="workspace">
  <aside class="rail">
    <div class="rail-search">
      <Search size={13} strokeWidth={2} />
      <input placeholder="Search settings…" bind:value={search} spellcheck="false" />
    </div>
    <nav>
      {#each SECTIONS as s (s.id)}
        {#if matchesSearch(s.label, s.hint)}
          <button class="rail-item" class:active={section === s.id} onclick={() => (section = s.id)}>
            <span class="rail-label">{s.label}</span>
            <span class="rail-hint">{s.hint}</span>
          </button>
        {/if}
      {/each}
    </nav>
    <div class="rail-foot mono">
      <span class:ok={companionReady} class:bad={!companionReady}>companion {companionReady ? "ready" : "not installed"}</span>
    </div>
  </aside>

  <div class="content">
    {#if loading}
      <p class="hint">Loading configuration through the companion…</p>
    {:else if loadError}
      <p class="hint err">{loadError}</p>
    {/if}

    {#if section === "runtime"}
      <h3>Current runtime <span class="chip">changes the active session</span></h3>
      <p class="hint">Native RPC controls. Startup defaults (what a fresh session gets) live under <button class="linklike" onclick={() => (section = "behavior")}>Agent behavior</button> and <button class="linklike" onclick={() => (section = "models")}>Models</button>.</p>
      <div class="rows">
        <div class="row">
          <label for="rt-model">Model ({$models.length} available)</label>
          <select id="rt-model" value={$rpcState?.model ? `${$rpcState.model.provider}|${$rpcState.model.id}` : ""} onchange={(e) => { const [provider, id] = e.currentTarget.value.split("|"); void setModel(provider, id); }}>
            {#each $models as m (m.provider + "/" + m.id)}
              <option value={m.provider + "|" + m.id}>{m.provider} / {m.id}</option>
            {/each}
          </select>
        </div>
        <div class="row">
          <label for="rt-think">Thinking level</label>
          <select id="rt-think" value={$rpcState?.thinkingLevel ?? "medium"} onchange={(e) => void setThinkingLevel(e.currentTarget.value as never)}>
            {#each THINKING_LEVELS as l}<option value={l}>{l}</option>{/each}
          </select>
        </div>
        <div class="row">
          <label for="rt-steer">Steering delivery <span class="chip">persists via SettingsManager</span></label>
          <select id="rt-steer" value={$rpcState?.steeringMode ?? "one-at-a-time"} onchange={(e) => void setSteeringMode(e.currentTarget.value as never)}>
            <option value="all">all — after each turn</option>
            <option value="one-at-a-time">one-at-a-time</option>
          </select>
        </div>
        <div class="row">
          <label for="rt-fu">Follow-up delivery <span class="chip">persists via SettingsManager</span></label>
          <select id="rt-fu" value={$rpcState?.followUpMode ?? "one-at-a-time"} onchange={(e) => void setFollowUpMode(e.currentTarget.value as never)}>
            <option value="all">all — when agent finishes</option>
            <option value="one-at-a-time">one-at-a-time</option>
          </select>
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" checked={$rpcState?.autoCompactionEnabled ?? true} onchange={(e) => setAutoCompaction(e.currentTarget.checked)} /> Auto-compaction (persists)</label>
          <button onclick={() => compact()}>Compact now</button>
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" checked={$autoRetry} onchange={(e) => { const v = e.currentTarget.checked; void setAutoRetry(v); }} /> Auto-retry (persists; Leftleg mirrors the last value set)</label>
          <button onclick={() => void abortRetry()}>Abort running retry</button>
        </div>
        <div class="row">
          <span class="row-label">Session actions (operational — not configuration)</span>
          <div class="inline">
            <input class="grow" value={sessionName} placeholder="session name" oninput={onSessionNameInput} />
            <button onclick={() => void exportSessionHtml()}>Export as HTML…</button>
            <button onclick={() => void cloneSession()}>Clone</button>
          </div>
        </div>
        <div class="row">
          <span class="row-label">Working directory</span>
          <div class="inline">
            <span class="chip" title={$projectDir}>{$projectDir || "no project"}</span>
            <button onclick={chooseProject}>Change…</button>
          </div>
        </div>
      </div>
    {:else if section === "behavior"}
      <h3>Agent behavior</h3>
      <div class="scope-row">
        <span class="scope-name">Scope: {scope === "global" ? "Global" : "Project"} — {scope === "global" ? (agentDir || "~/.pi/agent") + "/settings.json" : ($projectDir || "(no project)") + "/.pi/settings.json"}</span>
        <div class="seg">
          <button class:active={scope === "global"} onclick={() => switchScope("global")}>Global</button>
          <button class:active={scope === "project"} onclick={() => switchScope("project")}>Project</button>
        </div>
      </div>
      <div class="rows">
        <div class="row" class:filtered={!matchesSearch("startup provider", "defaultProvider")}>
          <label for="ab-prov" class="with-chip">Startup provider <span class="chip src">{sourceChip("defaultProvider")}</span></label>
          <div class="inline">
            <input id="ab-prov" value={fieldStr("defaultProvider")} oninput={(e) => setFieldStr("defaultProvider", e.currentTarget.value)} placeholder="inherited — e.g. openrouter" />
            <button class="ghost" title="Reset to inherited" onclick={() => markInherit("defaultProvider")}><RotateCcw size={12} strokeWidth={2} /></button>
          </div>
        </div>
        <div class="row" class:filtered={!matchesSearch("startup model", "defaultModel")}>
          <label for="ab-model" class="with-chip">Startup model <span class="chip src">{sourceChip("defaultModel")}</span></label>
          <div class="inline">
            <input id="ab-model" class="mono" value={fieldStr("defaultModel")} oninput={(e) => setFieldStr("defaultModel", e.currentTarget.value)} placeholder="inherited — model id with / : or :free preserved" />
            <button class="ghost" title="Reset to inherited" onclick={() => markInherit("defaultModel")}><RotateCcw size={12} strokeWidth={2} /></button>
          </div>
        </div>
        <div class="row" class:filtered={!matchesSearch("startup thinking", "defaultThinkingLevel")}>
          <label for="ab-think" class="with-chip">Startup thinking level <span class="chip src">{sourceChip("defaultThinkingLevel")}</span></label>
          <div class="inline">
            <select id="ab-think" value={fieldStr("defaultThinkingLevel")} onchange={(e) => setFieldStr("defaultThinkingLevel", e.currentTarget.value)}>
              <option value="">(inherited)</option>
              {#each THINKING_LEVELS as l}<option value={l}>{l}</option>{/each}
            </select>
            <button class="ghost" title="Reset to inherited" onclick={() => markInherit("defaultThinkingLevel")}><RotateCcw size={12} strokeWidth={2} /></button>
          </div>
        </div>
        <div class="row" class:filtered={!matchesSearch("compaction", "compaction.enabled reserveTokens keepRecentTokens")}>
          <span class="with-chip">Compaction <span class="chip src">{sourceChip("compaction.enabled")}</span> <span class="chip">defaults: on · 16384 · 20000</span></span>
          <div class="inline">
            <label class="check"><input type="checkbox" checked={fieldBool("compaction.enabled")} onchange={(e) => setFieldBool("compaction.enabled", e.currentTarget.checked)} /> enabled</label>
            <input class="num" type="number" value={fieldNum("compaction.reserveTokens")} oninput={(e) => setFieldNum("compaction.reserveTokens", e.currentTarget)} title="reserveTokens" />
            <input class="num" type="number" value={fieldNum("compaction.keepRecentTokens")} oninput={(e) => setFieldNum("compaction.keepRecentTokens", e.currentTarget)} title="keepRecentTokens" />
          </div>
        </div>
        <div class="row" class:filtered={!matchesSearch("branch summary", "branchSummary")}>
          <span class="with-chip">Branch summary <span class="chip">defaults: 16384 · no skip</span></span>
          <div class="inline">
            <input class="num" type="number" value={fieldNum("branchSummary.reserveTokens")} oninput={(e) => setFieldNum("branchSummary.reserveTokens", e.currentTarget)} title="reserveTokens" />
            <label class="check"><input type="checkbox" checked={fieldBool("branchSummary.skipPrompt")} onchange={(e) => setFieldBool("branchSummary.skipPrompt", e.currentTarget.checked)} /> skipPrompt</label>
          </div>
        </div>
        <div class="row" class:filtered={!matchesSearch("retry agent", "retry.enabled maxRetries baseDelayMs")}>
          <span class="with-chip">Agent retry <span class="chip">defaults: on · 3 · 2000ms (2s→4s→8s)</span> <span class="chip src">{sourceChip("retry.maxRetries")}</span></span>
          <div class="inline">
            <label class="check"><input type="checkbox" checked={fieldBool("retry.enabled")} onchange={(e) => setFieldBool("retry.enabled", e.currentTarget.checked)} /> enabled</label>
            <input class="num" type="number" value={fieldNum("retry.maxRetries")} oninput={(e) => setFieldNum("retry.maxRetries", e.currentTarget)} title="maxRetries" />
            <input class="num" type="number" value={fieldNum("retry.baseDelayMs")} oninput={(e) => setFieldNum("retry.baseDelayMs", e.currentTarget)} title="baseDelayMs" />
          </div>
        </div>
        <div class="row" class:filtered={!matchesSearch("provider retry timeout", "retry.provider")}>
          <span class="with-chip">Provider retries <span class="chip">timeoutMs / maxRetries / maxRetryDelayMs — keep maxRetries 0 unless needed</span></span>
          <div class="inline">
            <input class="num" type="number" value={fieldNum("retry.provider.timeoutMs")} oninput={(e) => setFieldNum("retry.provider.timeoutMs", e.currentTarget)} title="timeoutMs" />
            <input class="num" type="number" value={fieldNum("retry.provider.maxRetries")} oninput={(e) => setFieldNum("retry.provider.maxRetries", e.currentTarget)} title="maxRetries" />
            <input class="num" type="number" value={fieldNum("retry.provider.maxRetryDelayMs")} oninput={(e) => setFieldNum("retry.provider.maxRetryDelayMs", e.currentTarget)} title="maxRetryDelayMs" />
          </div>
        </div>
        <div class="row" class:filtered={!matchesSearch("transport timeout", "transport httpIdleTimeoutMs websocketConnectTimeoutMs")}>
          <span class="row-label">Transport &amp; timeouts</span>
          <div class="inline">
            <select value={fieldStr("transport")} onchange={(e) => setFieldStr("transport", e.currentTarget.value)}>
              <option value="">(inherited)</option>
              <option value="auto">auto</option><option value="sse">sse</option><option value="websocket">websocket</option><option value="websocket-cached">websocket-cached</option>
            </select>
            <input class="num" type="number" value={fieldNum("httpIdleTimeoutMs")} oninput={(e) => setFieldNum("httpIdleTimeoutMs", e.currentTarget)} title="httpIdleTimeoutMs (0 disables)" />
            <input class="num" type="number" value={fieldNum("websocketConnectTimeoutMs")} oninput={(e) => setFieldNum("websocketConnectTimeoutMs", e.currentTarget)} title="websocketConnectTimeoutMs" />
          </div>
        </div>
        <div class="row" class:filtered={!matchesSearch("images resize block", "images")}>
          <span class="with-chip">Images <span class="chip">resize on · block off</span></span>
          <div class="inline">
            <label class="check"><input type="checkbox" checked={fieldBool("images.autoResize")} onchange={(e) => setFieldBool("images.autoResize", e.currentTarget.checked)} /> autoResize (2000×2000)</label>
            <label class="check"><input type="checkbox" checked={fieldBool("images.blockImages")} onchange={(e) => setFieldBool("images.blockImages", e.currentTarget.checked)} /> blockImages</label>
          </div>
        </div>
        <div class="row" class:filtered={!matchesSearch("warnings anthropic extra usage", "warnings")}>
          <span class="with-chip">Warnings</span>
          <div class="inline">
            <label class="check"><input type="checkbox" checked={fieldBool("warnings.anthropicExtraUsage")} onchange={(e) => setFieldBool("warnings.anthropicExtraUsage", e.currentTarget.checked)} /> warn on Anthropic paid extra usage</label>
          </div>
        </div>
        <div class="row" class:filtered={!matchesSearch("thinking block cache notices", "hideThinkingBlock showCacheMissNotices")}>
          <span class="with-chip">Display extras</span>
          <div class="inline">
            <label class="check"><input type="checkbox" checked={fieldBool("hideThinkingBlock")} onchange={(e) => setFieldBool("hideThinkingBlock", e.currentTarget.checked)} /> hideThinkingBlock</label>
            <label class="check"><input type="checkbox" checked={fieldBool("showCacheMissNotices")} onchange={(e) => setFieldBool("showCacheMissNotices", e.currentTarget.checked)} /> showCacheMissNotices</label>
          </div>
        </div>
      </div>
      {@render applyBar()}
    {:else if section === "models"}
      <h3>Models &amp; cycling</h3>
      <div class="scope-row">
        <span class="scope-name">Scope: {scope === "global" ? "Global settings.json" : "Project .pi/settings.json"}</span>
        <div class="seg">
          <button class:active={scope === "global"} onclick={() => switchScope("global")}>Global</button>
          <button class:active={scope === "project"} onclick={() => switchScope("project")}>Project</button>
        </div>
      </div>
      <div class="rows">
        <div class="row" class:filtered={!matchesSearch("enabled models cycling patterns", "enabledModels")}>
          <label for="m-cyc" class="with-chip">enabledModels (Ctrl+P cycling; one pattern per line) <span class="chip src">{sourceChip("enabledModels")}</span></label>
          <textarea id="m-cyc" class="mono" rows={3} value={enabledModelsText} oninput={(e) => (enabledModelsText = e.currentTarget.value)} onchange={() => linesToDraft("enabledModels", enabledModelsText)}></textarea>
        </div>
        <div class="row">
          <label for="m-filter">Model registry ({$models.length} configured — full list, searchable)</label>
          <input id="m-filter" placeholder="Filter by provider, id, name…" bind:value={modelFilter} />
          <div class="model-list">
            {#each catalogModels as m (m.provider + "/" + m.id)}
              <div class="model-row">
                <span class="mono">{m.provider} / {m.id}</span>
                <span class="chip">{Math.round(m.contextWindow / 1000)}k</span>
                {#if m.reasoning}<span class="chip">reasoning</span>{/if}
              </div>
            {:else}
              <div class="hint none">No models match</div>
            {/each}
          </div>
          <div class="inline">
            <button onclick={() => void refreshRegistry()} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh registry (companion)"}</button>
            {#if refreshMsg}<span class="hint">{refreshMsg}</span>{/if}
          </div>
          <p class="hint">Custom providers/models live in <span class="mono">models.json</span> (user-authored); <span class="mono">models-store.json</span> is a generated cache and is never edited here. Full provider editor: pending — see coverage matrix.</p>
        </div>
        <div class="row" class:filtered={!matchesSearch("media agents", "media")}>
          <label for="media-model" class="with-chip">Media agents — image_generate defaults <span class="chip src">media-config</span></label>
          {#if extFiles["media-config"]}
            <div class="inline wrap">
              <span class="chip">model</span>
              <input id="media-model" class="grow mono" value={String(getPath(extDraft("media-config"), "model") ?? "")} onchange={(e) => void saveExt("media-config", { model: e.currentTarget.value.trim() || undefined })} placeholder="google/gemini-3.1-flash-image" />
              <span class="chip">resolution</span>
              <select class="sel" value={String(getPath(extDraft("media-config"), "resolution") ?? "")} onchange={(e) => void saveExt("media-config", { resolution: e.currentTarget.value || undefined })}>
                <option value="">(built-in default)</option>
                <option value="512">512</option>
                <option value="1K">1K</option>
                <option value="2K">2K</option>
                <option value="4K">4K</option>
              </select>
              <span class="chip">quality</span>
              <select class="sel" value={String(getPath(extDraft("media-config"), "quality") ?? "")} onchange={(e) => void saveExt("media-config", { quality: e.currentTarget.value || undefined })}>
                <option value="">(built-in default)</option>
                <option value="auto">auto</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
              <span class="chip">output format</span>
              <select class="sel" value={String(getPath(extDraft("media-config"), "output_format") ?? "")} onchange={(e) => void saveExt("media-config", { output_format: e.currentTarget.value || undefined })}>
                <option value="">(built-in default)</option>
                <option value="png">png</option>
                <option value="jpeg">jpeg</option>
                <option value="webp">webp</option>
                <option value="svg">svg</option>
              </select>
              <span class="chip">background</span>
              <select class="sel" value={String(getPath(extDraft("media-config"), "background") ?? "")} onchange={(e) => void saveExt("media-config", { background: e.currentTarget.value || undefined })}>
                <option value="">(built-in default)</option>
                <option value="auto">auto</option>
                <option value="transparent">transparent</option>
                <option value="opaque">opaque</option>
              </select>
            </div>
            <p class="hint">Defaults for the image_generate media agent — empty fields use the built-in default; tool arguments always win. Stored in <span class="mono">{agentDir}/extensions/leftleg-media/config.json</span> via the settings companion.</p>
          {:else}
            <div class="inline">
              <button onclick={() => void loadExt("media-config").catch(() => {})}>Load media-config</button>
            </div>
          {/if}
        </div>
      </div>
      {@render applyBar()}
    {:else if section === "tools"}
      <h3>Tools &amp; shell</h3>
      <div class="scope-row">
        <span class="scope-name">Scope: {scope === "global" ? "Global settings.json" : "Project .pi/settings.json"}</span>
        <div class="seg">
          <button class:active={scope === "global"} onclick={() => switchScope("global")}>Global</button>
          <button class:active={scope === "project"} onclick={() => switchScope("project")}>Project</button>
        </div>
      </div>
      <div class="rows">
        <div class="row" class:filtered={!matchesSearch("default tools built-in", "defaultTools")}>
          <span class="with-chip">defaultTools — startup BUILT-INS only <span class="chip src">{sourceChip("defaultTools")}</span></span>
          <div class="inline wrap">
            {#each BUILTIN_TOOLS as t (t)}
              <label class="check"><input type="checkbox" checked={((getPath(draft, "defaultTools") ?? []) as string[]).includes(t)} onchange={(e) => { const cur = new Set((getPath(draft, "defaultTools") ?? []) as string[]); if (e.currentTarget.checked) cur.add(t); else cur.delete(t); setPath(draft, "defaultTools", [...cur]); draft = { ...draft }; }} /> {t}</label>
            {/each}
            <button class="ghost" title="Reset to inherited (standard defaults)" onclick={() => markInherit("defaultTools")}><RotateCcw size={12} strokeWidth={2} /></button>
          </div>
          <p class="hint">Omitted = Pi's standard defaults. Extension/SDK tools are NOT affected by this list; `--tools`/`--exclude-tools` launch flags have different (strict allowlist / filter) semantics and are launcher-level.</p>
        </div>
        <div class="row" class:filtered={!matchesSearch("shell path prefix npm", "shellPath shellCommandPrefix npmCommand")}>
          <span class="row-label">Shell &amp; npm <span class="chip">effective shell is owned by the pwsh adapter on this install</span></span>
          <div class="inline">
            <input class="grow mono" value={fieldStr("shellPath")} oninput={(e) => setFieldStr("shellPath", e.currentTarget.value)} placeholder="shellPath (e.g. C:/Program Files/Git/bin/bash.exe)" />
          </div>
          <div class="inline">
            <input class="grow" value={fieldStr("shellCommandPrefix")} oninput={(e) => setFieldStr("shellCommandPrefix", e.currentTarget.value)} placeholder="shellCommandPrefix (prefix for every bash command)" />
          </div>
          <textarea class="mono" rows={2} value={npmCommandText} oninput={(e) => (npmCommandText = e.currentTarget.value)} onchange={() => linesToDraft("npmCommand", npmCommandText)} placeholder="npmCommand argv — one token per line (e.g. mise / exec / node@20 / -- / npm)"></textarea>
        </div>
        <div class="row" class:filtered={!matchesSearch("session dir", "sessionDir")}>
          <span class="with-chip">sessionDir <span class="chip">configuration only — sessions themselves are not managed here</span></span>
          <input class="grow mono" value={fieldStr("sessionDir")} oninput={(e) => setFieldStr("sessionDir", e.currentTarget.value)} placeholder="inherited — relative to project, ~ allowed" />
        </div>
        <div class="row" class:filtered={!matchesSearch("proxy", "httpProxy")}>
          <span class="with-chip">httpProxy <span class="chip">global only</span></span>
          <input class="grow mono" value={fieldStr("httpProxy")} oninput={(e) => setFieldStr("httpProxy", e.currentTarget.value)} placeholder={scope === "project" ? "global-only setting — switch scope to edit" : "inherited — http://127.0.0.1:7890"} disabled={scope === "project"} />
        </div>
      </div>
      {@render applyBar()}
    {:else if section === "trust"}
      <h3>Trust &amp; privacy</h3>
      <div class="rows">
        <div class="row">
          <span class="with-chip">defaultProjectTrust (global fallback for RPC starts) <span class="chip">default ask — applies when no saved decision exists</span></span>
          <select value={fieldStr("defaultProjectTrust")} onchange={(e) => setFieldStr("defaultProjectTrust", e.currentTarget.value)}>
            <option value="">(inherited — ask)</option>
            <option value="ask">ask — ignore project resources without prompting</option>
            <option value="always">always — trust project resources</option>
            <option value="never">never — ignore project resources</option>
          </select>
          <p class="hint">Saved decisions live in <span class="mono">trust.json</span> (Pi-owned). Viewing it here; the explicit trust action and per-project flow: pending — no automatic trust escalation happens from Settings.</p>
        </div>
        <div class="row">
          <span class="row-label">Telemetry &amp; updates</span>
          <div class="inline">
            <label class="check"><input type="checkbox" checked={fieldBool("enableInstallTelemetry")} onchange={(e) => setFieldBool("enableInstallTelemetry", e.currentTarget.checked)} /> install/update telemetry ping + provider attribution headers</label>
          </div>
          <div class="inline">
            <label class="check"><input type="checkbox" checked={fieldBool("enableAnalytics")} onchange={(e) => setFieldBool("enableAnalytics", e.currentTarget.checked)} /> analytics sharing (opt-in)</label>
          </div>
          <p class="hint">Update checks are controlled by env (<span class="mono">PI_SKIP_VERSION_CHECK</span>, <span class="mono">PI_OFFLINE</span>) and are shown read-only in Advanced.</p>
        </div>
        <div class="row">
          <span class="row-label">Saved trust decisions (trust.json, read-only)</span>
          <textarea class="mono" rows={4} readonly value={JSON.stringify(extFiles["trust"]?.data ?? null, null, 2)}></textarea>
          <p class="hint">Stored Pi decisions for trusted folders. Editing is Pi-owned; this view refreshes on open.</p>
        </div>
      </div>
      {@render applyBar()}
    {:else if section === "packages"}
      <h3>Extensions &amp; packages</h3>
      <div class="rows">
        <div class="row">
          <span class="row-label">Installed packages (from {scope === "global" ? "global" : "project"} settings.json — enable/disable is reversible; sources stay installed)</span>
          {#each packageEntries() as name (name)}
            <div class="pkg-row">
              <span class="pkg-name">{name}</span>
              <button class="danger" onclick={() => void togglePackage(name, true)}>Disable</button>
            </div>
          {:else}
            <div class="hint none">No packages in this scope.</div>
          {/each}
        </div>
        <div class="row">
          <span class="row-label">Resource inventory (agent dir)</span>
          <div class="inline wrap">
            <span class="chip">skills: {(resInfo?.skillDirs ?? []).length}</span>
            <span class="chip">extension dirs: {(resInfo?.extensionDirs ?? []).join(", ") || "—"}</span>
            {#each Object.entries(resInfo?.filesPresent ?? {}) as [f, present] (f)}
              <span class="chip" class:ok={present}>{f}{present ? "" : " (absent)"}</span>
            {/each}
          </div>
        </div>
        <div class="row">
          <span class="row-label">Package &amp; extension configuration</span>
          <PackageForms />
        </div>
        <div class="row">
          <label for="pk-cmds">Commands registered by pi (get_commands)</label>
          <div class="cmd-list">
            {#each $commands as c (c.name)}
              <div class="cmd-row"><span class="cmd-name mono">/{c.name}</span>{#if c.source}<span class="tag">{c.source}</span>{/if}<span class="cmd-desc">{c.description ?? ""}</span></div>
            {:else}
              <div class="hint none">No commands.</div>
            {/each}
          </div>
        </div>
        <div class="row">
          <span class="row-label">i18n locale (pi-extensions-i18n config.json)</span>
          <select value={String(getPath(extDraft("i18n-config"), "locale") ?? "")} onchange={(e) => void saveExt("i18n-config", { locale: e.currentTarget.value || undefined })}>
            <option value="">(unset — extension default)</option>
            <option value="en-US">en-US</option>
            <option value="zh-CN">zh-CN</option>
          </select>
          <p class="hint">Affects Distill prompt language — agent behavior, not just decoration. Reload timing: next turn.</p>
        </div>
        <div class="row">
          <span class="row-label">Distill config (extensions/pi-distill/config.json)</span>
          <div class="inline wrap">
            <label class="check"><input type="checkbox" checked={getPath(extDraft("distill-config"), "enabled") === true} onchange={(e) => void saveExt("distill-config", { enabled: e.currentTarget.checked })} /> enabled</label>
            <input class="num" type="number" value={String(getPath(extDraft("distill-config"), "minChars") ?? "")} onchange={(e) => void saveExt("distill-config", { minChars: e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value) })} title="minChars" />
            <input class="num" type="number" value={String(getPath(extDraft("distill-config"), "maxChars") ?? "")} onchange={(e) => void saveExt("distill-config", { maxChars: e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value) })} title="maxChars" />
            <input class="mono" value={String(getPath(extDraft("distill-config"), "model") ?? "")} onchange={(e) => void saveExt("distill-config", { model: e.currentTarget.value || undefined })} placeholder="model (blank = current-model fallback)" />
          </div>
          <p class="hint">Full field set incl. per-tool enablement and render options: pending — advanced JSON editor covers it meanwhile.</p>
        </div>
        <div class="row">
          <span class="row-label">Todo &amp; background tasks (99extensions.json — namespace-safe)</span>
          <div class="inline wrap">
            <span class="chip">todo.collapsedTaskLimit</span><input class="num" type="number" min={1} max={10} value={String(getPath(extDraft("99extensions"), "todo.collapsedTaskLimit") ?? "")} onchange={(e) => void saveExtNamespace("99extensions", "todo", { ...((extDraft("99extensions").todo ?? {}) as Record<string, unknown>), collapsedTaskLimit: e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value) })} />
            <span class="chip">todo.reminderInterval</span><input class="num" type="number" min={0} max={20} value={String(getPath(extDraft("99extensions"), "todo.reminderInterval") ?? "")} onchange={(e) => void saveExtNamespace("99extensions", "todo", { ...((extDraft("99extensions").todo ?? {}) as Record<string, unknown>), reminderInterval: e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value) })} />
          </div>
          <p class="hint">Namespace writes replace ONLY the todo / background-tasks namespaces; every other namespace in 99extensions.json is preserved. reminderInterval changes model context; collapsedTaskLimit is presentation.</p>
        </div>
      </div>
    {:else if section === "appearance"}
      <h3>Appearance (Leftleg)</h3>
      <div class="rows">
        <div class="row">
          <span class="row-label">Leftleg theme</span>
          <div class="seg">
            {#each [["light", "Light"], ["dark", "Dark"], ["system", "System"]] as [v, l]}
              <button class:active={$theme === v} onclick={() => applyTheme(v as never)}>{l}</button>
            {/each}
          </div>
          <p class="hint">Fonts (Plus Jakarta Sans) and icon set (Lucide) are bundled app choices. These do NOT style terminal Pi — Pi's own TUI theme (<span class="mono">theme</span> in settings.json) is under Agent behavior's file scope and labeled TUI-only.</p>
        </div>
      </div>
    {:else if section === "projects"}
      <h3>Project presentation (Leftleg-owned)</h3>
      <div class="rows">
        {#each [...new Set([...Object.keys($projectMeta), ...$sessions.map((s) => s.cwd)])] as dir (dir)}
          {@const meta = $projectMeta[dir] ?? {}}
          <div class="row">
            <div class="inline">
              <input class="mono grow" value={dir} disabled title="Project directory" />
              <input value={meta.name ?? ""} placeholder="display name" onchange={(e) => updateProjectMeta(dir, { name: e.currentTarget.value.trim() || undefined })} />
              <select value={meta.defaultModel ? `${meta.defaultModel.provider}|${meta.defaultModel.id}` : ""} onchange={(e) => { const v = e.currentTarget.value; if (!v) updateProjectMeta(dir, { defaultModel: undefined }); else { const [provider, id] = v.split("|"); updateProjectMeta(dir, { defaultModel: { provider, id } }); } }}>
                <option value="">default model: Leftleg default</option>
                {#each $models as m (m.provider + "/" + m.id)}
                  <option value={m.provider + "|" + m.id}>{m.provider} / {m.id}</option>
                {/each}
              </select>
            </div>
            <div class="inline">
              {#each PROJECT_ICON_CHOICES as icon (icon)}
                <button class="ghost icon-pick" class:active={meta.icon === icon} title={projectIconLabel(icon)} onclick={() => updateProjectMeta(dir, { icon: icon === meta.icon ? undefined : icon })}><ProjectIcon icon={icon} size={15} /></button>
              {/each}
            </div>
            <div class="inline">
              <span class="pick-label">color</span>
              {#each PROJECT_COLOR_CHOICES as c (c)}
                {#if c}
                  <button class="color-pick" class:active={meta.color === c} style={`background:${c}`} title={c} aria-label={`icon color ${c}`} onclick={() => updateProjectMeta(dir, { color: meta.color === c ? undefined : c })}></button>
                {:else}
                  <button class="color-pick none" class:active={!meta.color} title="theme default" aria-label="theme default icon color" onclick={() => updateProjectMeta(dir, { color: undefined })}></button>
                {/if}
              {/each}
            </div>
            <div class="inline">
              <label class="check"><input type="checkbox" checked={!!meta.forgotten && dir !== $projectDir} disabled={dir === $projectDir} onchange={(e) => (e.currentTarget.checked ? forgetProject(dir) : restoreProject(dir))} /> hidden from sidebar</label>
            </div>
          </div>
        {:else}
          <div class="hint none">No projects known yet.</div>
        {/each}
        <div class="row">
          <button onclick={chooseProject}><FolderOpen size={13} strokeWidth={2} /> Open another folder…</button>
          <button onclick={() => openNewProject()}><Plus size={13} strokeWidth={2} /> New project…</button>
        </div>
      </div>
    {:else}
      <h3>Advanced &amp; diagnostics</h3>
      <div class="rows">
        <div class="row">
          <span class="row-label">Settings companion (management channel)</span>
          <div class="inline">
            <span class="chip" class:ok={companionReady} class:bad={!companionReady}>{companionReady ? "installed & loaded" : "not installed"}</span>
            <button class="primary" disabled={installing} onclick={() => void installCompanion()}>{installing ? "Installing…" : companionReady ? "Reinstall" : "Install companion"}</button>
          </div>
          {#if installMsg}<p class="hint">{installMsg}</p>{/if}
          <p class="hint">Reserved command <span class="mono">/settings-mgmt</span>; versioned JSON requests; structured replies; availability-gated so a request can never fall through to an LLM prompt. Installing also ships the <span class="mono">leftleg-media</span> companion (the <span class="mono">image_generate</span> tool — OpenRouter Image API, auth resolved inside pi). Agent dir: <span class="mono">{agentDir || "~/.pi/agent"}</span></p>
        </div>
        <div class="row">
          <span class="row-label">Updates</span>
          <div class="inline">
            <span class="chip">v{__APP_VERSION__}</span>
            {#if $updateCheck.status === "checking"}
              <span class="chip">checking…</span>
            {:else if $updateCheck.status === "current"}
              <span class="chip ok">up to date</span>
            {:else if $updateCheck.status === "available"}
              <span class="chip ok">⟳ {$updateCheck.message}</span>
            {:else if $updateCheck.status === "failed"}
              <span class="chip bad" title={$updateCheck.message}>check failed</span>
            {/if}
            <button class="primary" disabled={$updateCheck.status === "checking" || ["downloading", "preparing", "installing"].includes($updateStatus)} onclick={() => void checkForUpdates()}>Check now</button>
            {#if $updateAvailable}<button class="primary" disabled={["downloading", "preparing", "installing"].includes($updateStatus)} onclick={() => void applyUpdate()}>{$updateStatus === "ready" ? "Install downloaded update" : "Install & restart"}</button>{/if}
          </div>
          {#if $updateCheck.status === "failed"}<p class="hint">{$updateCheck.message}</p>{/if}
        </div>
        <div class="row">
          <span class="row-label">Build identity</span>
          <div class="inline wrap">
            <span class="chip">Leftleg v{__APP_VERSION__}</span>
            <span class="chip">Pi agent dir: {agentDir || "~/.pi/agent"}</span>
            <span class="chip">Pi 0.85.1 (npm global; exe resolved via PATH)</span>
          </div>
          <p class="hint">If the GUI behaves like an older build after installing, check that the shortcut targets <span class="mono">%LOCALAPPDATA%\Leftleg\leftleg.exe</span> — this panel surfaces the running configuration identity.</p>
        </div>
        <div class="row">
          <span class="row-label">Raw config editors (validated; unknown fields preserved)</span>
          <select id="adv-target" onchange={(e) => { const t = e.currentTarget.value; if (t) void loadExt(t).catch(() => {}); }}>
            <option value="">choose a registered resource…</option>
            <option value="media-config">media-config</option>
            <option value="settings-global">settings-global</option>
            <option value="settings-project">settings-project</option>
            <option value="99extensions">99extensions</option>
            <option value="distill-config">distill-config</option>
            <option value="i18n-config">i18n-config</option>
            <option value="tool-display-config">tool-display-config</option>
            <option value="trust">trust (read)</option>
            <option value="models">models</option>
          </select>
          {#if advTarget && extFiles[advTarget]}
            <textarea class="mono adv-json" rows={10} bind:value={advJson}></textarea>
            <div class="inline">
              <button onclick={() => void applyAdvJson()}>Apply JSON (merge)</button>
              <button onclick={() => void loadExt(advTarget).catch(() => {})}>Discard</button>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .workspace {
    display: grid;
    grid-template-columns: 240px 1fr;
    flex: 1;
    min-height: 0;
  }
  .rail {
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 10px 8px;
    gap: 4px;
    min-height: 0;
  }
  .rail-search {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-3);
    margin-bottom: 6px;
  }
  .rail-search input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 12px;
    outline: none;
  }
  nav { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
  .rail-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 7px 10px;
    border: none;
    background: transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    width: 100%;
  }
  .rail-item:hover { background: var(--bg-surface-2); }
  .rail-item.active { background: var(--accent-soft); }
  .rail-item.active .rail-label { color: var(--accent); }
  .rail-label { font-size: 12.5px; font-weight: 600; color: var(--text-2); }
  .rail-hint { font-size: 10px; color: var(--text-3); }
  .rail-foot { margin-top: auto; padding: 6px 4px; font-size: 10px; color: var(--text-3); }
  .rail-foot .ok { color: var(--ok); }
  .rail-foot .bad { color: orange; }
  .content {
    overflow-y: auto;
    padding: 16px 22px 22px;
    min-height: 0;
  }
  h3 { margin: 0 0 10px; font-size: 15px; color: var(--text); display: flex; align-items: center; gap: 8px; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: 99px;
    padding: 0 7px;
    white-space: nowrap;
  }
  .chip.src { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
  .chip.ok { color: var(--ok); border-color: var(--ok); }
  .chip.bad { color: orange; border-color: orange; }
  .scope-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
    padding: 7px 10px;
    background: var(--bg-surface-2);
    border-radius: var(--radius-sm);
  }
  .scope-name { font-size: 11.5px; color: var(--text-2); }
  .seg { display: flex; gap: 4px; }
  .seg button { padding: 3px 12px; border-radius: 99px; font-size: 11.5px; background: transparent; }
  .seg button.active { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
  .rows { display: flex; flex-direction: column; gap: 12px; }
  .row { display: flex; flex-direction: column; gap: 5px; }
  .row.filtered { display: none; }
  .with-chip { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: var(--text-2); }
  label { font-size: 12.5px; color: var(--text-2); }
  input, select, textarea {
    padding: 6px 9px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 12.5px;
  }
  textarea { width: 100%; box-sizing: border-box; }
  .inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .inline .num { width: 110px; }
  .inline .grow { flex: 1; min-width: 200px; }
  .inline.wrap { flex-wrap: wrap; }
  .check { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text); cursor: pointer; }
  .ghost, .danger { font-size: 11.5px; padding: 4px 10px; }
  .ghost:disabled { opacity: 0.4; cursor: default; }
  .primary { font-size: 12px; padding: 5px 14px; }
  .primary:disabled { opacity: 0.45; cursor: default; }
  .linklike { border: none; background: transparent; color: var(--accent); font-size: inherit; padding: 0; cursor: pointer; text-decoration: underline; }
  .apply-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
    padding: 9px 12px;
    background: var(--bg-surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    position: sticky;
    bottom: 0;
  }
  .apply-bar .spacer { flex: 1; }
  .hint { font-size: 11.5px; color: var(--text-3); margin: 0; }
  .hint.err { color: var(--danger); }
  .hint.none { padding: 8px 0; }
  .pkg-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 9px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .pkg-name { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model-list {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-height: 260px;
    overflow-y: auto;
  }
  .model-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  .sel {
    padding: 4px 8px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-size: 12px;
  }
  .sel:focus { outline: none; border-color: var(--accent); }
  .model-row:last-child { border-bottom: none; }
  .cmd-list {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-height: 200px;
    overflow-y: auto;
  }
  .cmd-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  .cmd-row:last-child { border-bottom: none; }
  .cmd-name { color: var(--accent); flex-shrink: 0; }
  .cmd-desc { color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .adv-json { font-size: 11.5px; }
  .icon-pick { font-size: 14px; padding: 3px 6px; }
  .icon-pick.active { background: var(--accent-soft); color: var(--accent); }
  .pick-label { font-size: 11px; color: var(--text-3); align-self: center; user-select: none; }
  .color-pick {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid transparent;
    padding: 0;
    cursor: pointer;
    flex-shrink: 0;
  }
  .color-pick:hover { transform: scale(1.12); }
  .color-pick.active { border-color: var(--bg-surface); box-shadow: 0 0 0 1.5px var(--text-2); }
  .color-pick.none { background: transparent; border: 1.5px dashed var(--text-3); }
</style>

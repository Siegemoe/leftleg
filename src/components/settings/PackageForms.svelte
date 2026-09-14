<script lang="ts">
  // Per-package configuration forms, each backed by its real documented shape
  // (see PI_SETTINGS_INVENTORY.md rows). All writes go through the settings-mgmt
  // companion: namespace-merge for settings.json namespaces, targeted file ops
  // for extension config files, raw ops for Serena YAML (comment-preserving
  // responsibility sits with the user; format guards refuse tab-indentation).
  import { bindManagement } from "../../lib/settings/mgmt";
  import { statusNote } from "../../lib/stores";
  import { preparePatch } from "../../lib/settings/state";

  const mgmtRequest = bindManagement();

  interface FileState { data: Record<string, unknown> | null; raw: string | null; revision: string | null; exists: boolean }
  let files = $state<Record<string, FileState>>({});

  async function load(target: string, raw = false) {
    try {
      if (raw) {
        const r = await mgmtRequest<{ exists: boolean; raw: string | null; revision: string | null }>("read-raw", { target });
        files = { ...files, [target]: { data: null, raw: r.raw ?? null, revision: r.revision ?? null, exists: r.exists } };
      } else {
        const r = await mgmtRequest<{ exists: boolean; data: Record<string, unknown> | null; revision: string | null }>("read", { target });
        files = { ...files, [target]: { data: r.data ?? null, raw: null, revision: r.revision ?? null, exists: r.exists } };
      }
    } catch (e) {
      statusNote.set(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => statusNote.set(""), 6000);
      throw e;
    }
  }

  function revisionFor(target: string): string | null {
    if (!files[target]) throw new Error("Load the configuration before saving");
    return files[target].revision;
  }

  function flashSaved() {
    statusNote.set("Saved — verified by companion read-back where applicable.");
    setTimeout(() => statusNote.set(""), 4000);
  }

  function noteSaveError(e: unknown) {
    statusNote.set(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    setTimeout(() => statusNote.set(""), 6000);
  }

  // ---- generic namespace editor (settings.json namespaces) ----
  type FieldType = "string" | "number" | "boolean" | "lines";
  interface FieldDef { path: string; label: string; type: FieldType; hint?: string }

  function nsLoad(target: string, namespace: string): void {
    void load(target).catch(() => {}); // load() already surfaced the error
  }
  function nsValue(target: string, namespace: string, path: string): unknown {
    const ns = files[target]?.data?.[namespace] as Record<string, unknown> | undefined;
    if (!ns) return undefined;
    let cur: unknown = ns;
    for (const part of path.split(".")) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }
  async function nsSave(target: string, namespace: string, patch: Record<string, unknown>): Promise<void> {
    try {
      const rev = revisionFor(target);
      const changes = preparePatch({ [namespace]: patch });
      await mgmtRequest("write", { target, mode: "namespace-merge", ...changes, revision: rev });
      await load(target);
      flashSaved();
    } catch (e) {
      noteSaveError(e);
    }
  }

  // ---- plan ----
  const planFields: FieldDef[] = [
    { path: "planModel", label: "planModel", type: "string", hint: "model used for plan drafting" },
    { path: "planThinking", label: "planThinking", type: "string", hint: "thinking level for plan drafting" },
    { path: "goalModel", label: "goalModel", type: "string", hint: "goal evaluator model" },
    { path: "btw.model", label: "btw.model", type: "string" },
    { path: "goal.model", label: "goal.model", type: "string" },
    { path: "goal.maxTurns", label: "goal.maxTurns", type: "number" },
    { path: "plansDir", label: "plansDir", type: "string", hint: "supports {yyyymm}" },
  ];
  async function savePlanField(path: string, value: unknown) {
    const patch: Record<string, unknown> = {};
    const parts = path.split(".");
    let cur = patch;
    for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = {}; cur = cur[parts[i]] as Record<string, unknown>; }
    cur[parts[parts.length - 1]] = value === "" ? undefined : value;
    await nsSave("settings-global", "pi-plan", patch);
  }

  // ---- subagent ----
  let newRoleName = $state("");
  function roleNames(target: string): string[] {
    const roles = (files[target]?.data?.subagent as { roles?: Record<string, unknown> } | undefined)?.roles;
    return roles ? Object.keys(roles) : [];
  }
  function roleModels(target: string, role: string): string[] {
    const roles = (files[target]?.data?.subagent as { roles?: Record<string, unknown> } | undefined)?.roles;
    const r = roles?.[role] as { models?: unknown } | undefined;
    return Array.isArray(r?.models) ? (r.models as string[]) : [];
  }
  async function saveRole(target: string, role: string, models: string[]) {
    await nsSave(target, "subagent", { roles: { [role]: { models } } });
  }
  async function addRole(target: string) {
    const name = newRoleName.trim();
    if (!name) return;
    if (roleNames(target).includes(name)) { statusNote.set("That role already exists"); return; }
    await nsSave(target, "subagent", { roles: { [name]: { models: [] } } });
    newRoleName = "";
  }
  async function deleteRole(target: string, role: string) {
    try {
      const roles = (files[target]?.data?.subagent as { roles?: Record<string, unknown> } | undefined)?.roles;
      if (!roles) return;
      const next = { ...roles };
      delete next[role];
      const subagent = files[target]?.data?.subagent as Record<string, unknown>;
      await mgmtRequest("write", { target, mode: "namespace", patch: { subagent: { ...subagent, roles: next } }, revision: revisionFor(target) });
      await load(target);
      flashSaved();
    } catch (e) {
      noteSaveError(e);
    }
  }

  // ---- permissions ----
  type Decision = "allow" | "ask" | "deny";
  function permToolKeys(target: string): string[] {
    const perm = files[target]?.data?.permission as Record<string, unknown> | undefined;
    return perm ? Object.keys(perm) : [];
  }
  function permPatterns(target: string, tool: string): Array<{ pattern: string; decision: Decision }> {
    const perm = files[target]?.data?.permission as Record<string, unknown> | undefined;
    const t = perm?.[tool];
    if (t === "allow" || t === "ask" || t === "deny") return [{ pattern: "*", decision: t }];
    if (t && typeof t === "object") {
      return Object.entries(t as Record<string, unknown>).map(([pattern, d]) => ({ pattern, decision: (["allow", "ask", "deny"].includes(String(d)) ? d : "ask") as Decision }));
    }
    return [];
  }
  async function savePermissionTool(target: string, tool: string, patterns: Array<{ pattern: string; decision: Decision }>) {
    // Object key order = rule order (JSON insertion order preserved by the companion).
    let value: unknown;
    if (patterns.length === 1 && patterns[0].pattern === "*") value = patterns[0].decision;
    else {
      const map: Record<string, string> = {};
      for (const p of patterns) map[p.pattern.trim()] = p.decision;
      value = map;
    }
    const permission = files[target]?.data?.permission as Record<string, unknown> | undefined;
    try {
      await mgmtRequest("write", { target, mode: "namespace", patch: { permission: { ...permission, [tool]: value } }, revision: revisionFor(target) });
      await load(target);
      flashSaved();
    } catch (e) {
      noteSaveError(e);
    }
  }
  async function removePermissionTool(target: string, tool: string) {
    try {
      const perm = files[target]?.data?.permission as Record<string, unknown> | undefined;
      if (!perm) return;
      const next = { ...perm };
      delete next[tool];
      const rev = revisionFor(target);
      // Removing a whole tool key requires unset (merge cannot delete).
      await mgmtRequest("write", { target, mode: "namespace", patch: { permission: next }, revision: rev });
      await load(target);
      flashSaved();
    } catch (e) {
      noteSaveError(e);
    }
  }

  // ---- lens ----
  const lensBooleans = ["prettier", "lsp", "tsc", "bashDetection", "alwaysReport"] as const;
  const lensNumbers = ["lspDelayMs", "maxConcurrency", "prettierTimeoutMs", "linterTimeoutMs", "tscTimeoutMs"] as const;
  const lensPatterns = ["includePatterns", "excludePatterns"] as const;
  async function saveLensField(path: string, value: unknown) {
    try {
      const rev = revisionFor("lens-project");
      const parts = path.split(".");
      const patch: Record<string, unknown> = { [parts[0]]: value };
      await mgmtRequest("write", { target: "lens-project", mode: "merge", ...preparePatch(patch), revision: rev });
      await load("lens-project");
      flashSaved();
    } catch (e) {
      noteSaveError(e);
    }
  }
  function lensLines(name: string): string {
    const v = files["lens-project"]?.data?.[name];
    return Array.isArray(v) ? (v as string[]).join("\n") : "";
  }

  // ---- tool-display ----
  async function saveToolDisplayField(path: string, value: unknown) {
    try {
      const rev = revisionFor("tool-display-config");
      await mgmtRequest("write", { target: "tool-display-config", mode: "merge", patch: { [path]: value }, revision: rev });
      await load("tool-display-config");
      flashSaved();
    } catch (e) {
      noteSaveError(e);
    }
  }

  // ---- media (image_generate defaults) ----
  async function saveMediaField(path: string, value: unknown) {
    try {
      const rev = revisionFor("media-config");
      await mgmtRequest("write", { target: "media-config", mode: "merge", ...preparePatch({ [path]: value }), revision: rev });
      await load("media-config");
      flashSaved();
    } catch (e) {
      noteSaveError(e);
    }
  }

  // ---- distill full field set ----
  const distillNumbers = ["minChars", "maxChars", "maxOutputChars", "timeoutSeconds", "timeoutRetryCount", "errorRetryCount", "missedCompressionRatio"] as const;
  async function saveDistillField(path: string, value: unknown) {
    try {
      const rev = revisionFor("distill-config");
      await mgmtRequest("write", { target: "distill-config", mode: "merge", ...preparePatch({ [path]: value }), revision: rev });
      await load("distill-config");
      flashSaved();
    } catch (e) {
      noteSaveError(e);
    }
  }
  function distillToolNames(): string[] {
    const tools = files["distill-config"]?.data?.tools as Record<string, unknown> | undefined;
    return tools ? Object.keys(tools) : [];
  }
  function distillToolEnabled(name: string): boolean {
    const tools = files["distill-config"]?.data?.tools as Record<string, { enabled?: boolean }> | undefined;
    return tools?.[name]?.enabled === true;
  }

  // ---- instruction files (raw markdown) ----
  const INSTRUCTION_TARGETS = [
    { target: "system-md", label: "~/.pi/agent/SYSTEM.md (global base system prompt)" },
    { target: "append-system-md", label: "~/.pi/agent/APPEND_SYSTEM.md (global append)" },
    { target: "system-md-project", label: ".pi/SYSTEM.md (project)" },
    { target: "append-system-md-project", label: ".pi/APPEND_SYSTEM.md (project)" },
    { target: "agents-md-project", label: "AGENTS.md (project context)" },
  ] as const;
  async function saveRaw(target: string, content: string) {
    try {
      await mgmtRequest("write-raw", { target, content, revision: revisionFor(target) });
      await load(target, true);
      flashSaved();
    } catch (e) {
      noteSaveError(e);
    }
  }

  // ---- ref-tools ----
  const refFields: FieldDef[] = [
    { path: "url", label: "url", type: "string", hint: "default https://api.ref.tools/mcp" },
    { path: "timeoutMs", label: "timeoutMs", type: "number", hint: "default 30000" },
    { path: "protocolVersion", label: "protocolVersion", type: "string", hint: "default 2025-06-18" },
    { path: "maxBytes", label: "maxBytes", type: "number", hint: "default 51200" },
    { path: "maxLines", label: "maxLines", type: "number", hint: "default 2000" },
  ];

  // ---- env presence ----
  interface EnvVar { name: string; set: boolean; source: string | null }
  let envVars = $state<EnvVar[] | null>(null);
  async function loadEnv() {
    try {
      const r = await mgmtRequest<{ vars: Record<string, { set: boolean; source: string | null }> }>("env-check", {});
      envVars = Object.entries(r.vars).map(([name, v]) => ({ name, set: v.set, source: v.source }));
    } catch { envVars = null; }
  }
</script>

<div class="pkg-forms">
  <!-- Plan -->
  <details class="pkg-block" ontoggle={() => nsLoad("settings-global", "pi-plan")}>
    <summary>Plan (pi-plan namespace) — namespace-merge saves</summary>
    <p class="hint">Saving here merges INSIDE the pi-plan namespace: editing planModel cannot erase btw/goal/plansDir (proven by unit test). Global scope.</p>
    {#each planFields as f (f.path)}
      <div class="frow">
        <span class="flabel">{f.label}</span>
        {#if f.type === "number"}
          <input class="num" type="number" value={String(nsValue("settings-global", "pi-plan", f.path) ?? "")} onchange={(e) => void savePlanField(f.path, e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value))} />
        {:else}
          <input class="grow mono" value={String(nsValue("settings-global", "pi-plan", f.path) ?? "")} onchange={(e) => void savePlanField(f.path, e.currentTarget.value)} placeholder="(absent)" />
        {/if}
        {#if f.hint}<span class="fhint">{f.hint}</span>{/if}
      </div>
    {/each}
  </details>

  <!-- Subagent -->
  <details class="pkg-block" ontoggle={() => nsLoad("settings-global", "subagent")}>
    <summary>Subagent roles (subagent namespace) — fallback chains, verbatim identifiers</summary>
    <p class="hint">Models are plain strings — OpenRouter identifiers with / and :free are preserved exactly as typed. Changes apply on the next subagent spawn; no agents are launched by editing.</p>
    {#each roleNames("settings-global") as role (role)}
      <div class="frow">
        <span class="flabel">{role}</span>
        <textarea class="mono" rows={Math.max(2, roleModels("settings-global", role).length)}
          value={roleModels("settings-global", role).join("\n")}
          onchange={(e) => void saveRole("settings-global", role, e.currentTarget.value.split("\n").map((s) => s.trim()).filter(Boolean))}></textarea>
        <button class="danger" onclick={() => void deleteRole("settings-global", role)}>Delete role</button>
      </div>
    {:else}
      <div class="hint none">No roles configured.</div>
    {/each}
    <div class="frow">
      <input value={newRoleName} placeholder="new role name…" oninput={(e) => (newRoleName = e.currentTarget.value)} />
      <button onclick={() => void addRole("settings-global")}>Add role</button>
    </div>
    <div class="frow">
      <span class="flabel">agentModels (per-agent overrides — advanced JSON)</span>
      <textarea class="mono" rows={3} value={JSON.stringify((files["settings-global"]?.data?.subagent as Record<string, unknown> | undefined)?.agentModels ?? {}, null, 2)} onchange={(e) => { try { const v = JSON.parse(e.currentTarget.value); void nsSave("settings-global", "subagent", { agentModels: v }); } catch { statusNote.set("⚠ agentModels must be valid JSON"); setTimeout(() => statusNote.set(""), 6000); } }}></textarea>
    </div>
    <p class="hint">Security options are pending: the installed security resolver reads an undocumented ctx property — file-backed toggles would be ineffective; disclosed, not faked.</p>
  </details>

  <!-- Permissions -->
  <details class="pkg-block" ontoggle={() => nsLoad("settings-global", "permission")}>
    <summary>Permissions (permission namespace) — last matching rule wins</summary>
    <p class="hint">Per-tool pattern → allow/ask/deny maps. Rule order = insertion order shown; later matching rules override earlier ones. yolo (a launch flag) bypasses ask but never deny.</p>
    {#each permToolKeys("settings-global") as tool (tool)}
      <div class="perm-tool">
        <span class="flabel">{tool === "*" ? "* (global default)" : tool}</span>
        {#each permPatterns("settings-global", tool) as row, i (i)}
          <div class="frow">
            <input class="mono grow" value={row.pattern} onchange={(e) => { const p = permPatterns("settings-global", tool); p[i] = { pattern: e.currentTarget.value, decision: p[i]?.decision ?? "ask" }; void savePermissionTool("settings-global", tool, p); }} />
            <select value={row.decision} onchange={(e) => { const p = permPatterns("settings-global", tool); p[i] = { pattern: row.pattern, decision: e.currentTarget.value as Decision }; void savePermissionTool("settings-global", tool, p); }}>
              <option value="allow">allow</option><option value="ask">ask</option><option value="deny">deny</option>
            </select>
          </div>
        {/each}
        <div class="frow">
          <button class="ghost" onclick={() => { const p = permPatterns("settings-global", tool); p.push({ pattern: "", decision: "ask" }); void savePermissionTool("settings-global", tool, p); }}>Add rule</button>
          <button class="danger" onclick={() => void removePermissionTool("settings-global", tool)}>Remove tool</button>
        </div>
      </div>
    {:else}
      <div class="hint none">No permission rules configured.</div>
    {/each}
  </details>

  <!-- Lens -->
  <details class="pkg-block" ontoggle={() => void load("lens-project").catch(() => {})}>
    <summary>Lens (project .pi-lens.json)</summary>
    <div class="frow wrap">
      {#each lensBooleans as b (b)}
        <label class="check"><input type="checkbox" checked={(files["lens-project"]?.data?.[b] as boolean) ?? false} onchange={(e) => void saveLensField(b, e.currentTarget.checked)} /> {b}</label>
      {/each}
    </div>
    <div class="frow wrap">
      {#each lensNumbers as n (n)}
        <span class="flabel">{n}</span>
        <input class="num" type="number" value={String(files["lens-project"]?.data?.[n] ?? "")} onchange={(e) => void saveLensField(n, e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value))} />
      {/each}
    </div>
    <p class="hint">includePatterns/excludePatterns and the separate piLensRenderer TUI switch: pending (coverage matrix). The renderer switch affects terminal Lens, not Leftleg.</p>
  </details>

  <!-- tool-display -->
  <details class="pkg-block" ontoggle={() => void load("tool-display-config").catch(() => {})}>
    <summary>Tool display (extensions/pi-tool-display/config.json)</summary>
    <div class="frow">
      <label class="check"><input type="checkbox" checked={(files["tool-display-config"]?.data?.enabled as boolean) ?? false} onchange={(e) => void saveToolDisplayField("enabled", e.currentTarget.checked)} /> enabled</label>
      <label class="check"><input type="checkbox" checked={(files["tool-display-config"]?.data?.enableNativeUserMessageBox as boolean) ?? false} onchange={(e) => void saveToolDisplayField("enableNativeUserMessageBox", e.currentTarget.checked)} /> enableNativeUserMessageBox (TUI-only rendering)</label>
    </div>
    <p class="hint">registerToolOverrides / customToolOverrides and output-mode fields: pending (advanced). These are TUI rendering options — they do not change which tools the agent can call.</p>
  </details>

  <!-- Distill full set -->
  <details class="pkg-block" ontoggle={() => void load("distill-config").catch(() => {})}>
    <summary>Distill — full configuration (extensions/pi-distill/config.json)</summary>
    <div class="frow">
      <label class="check"><input type="checkbox" checked={(files["distill-config"]?.data?.enabled as boolean) ?? false} onchange={(e) => void saveDistillField("enabled", e.currentTarget.checked)} /> enabled</label>
      <input class="mono" value={String(files["distill-config"]?.data?.model ?? "")} onchange={(e) => void saveDistillField("model", e.currentTarget.value || undefined)} placeholder="model (blank = current-model fallback)" />
    </div>
    <div class="frow wrap">
      {#each distillNumbers as n (n)}
        <span class="flabel">{n}</span>
        <input class="num" type="number" value={String(files["distill-config"]?.data?.[n] ?? "")} onchange={(e) => void saveDistillField(n, e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value))} />
      {/each}
      <label class="check"><input type="checkbox" checked={(files["distill-config"]?.data?.summarizeErrors as boolean) ?? false} onchange={(e) => void saveDistillField("summarizeErrors", e.currentTarget.checked)} /> summarizeErrors</label>
    </div>
    <span class="flabel">render (presentation)</span>
    <div class="frow wrap">
      <label class="check"><input type="checkbox" checked={((files["distill-config"]?.data?.render as Record<string, unknown> | undefined)?.enabled as boolean) ?? false} onchange={(e) => void saveDistillField("render.enabled", e.currentTarget.checked)} /> render.enabled</label>
      <label class="check"><input type="checkbox" checked={((files["distill-config"]?.data?.render as Record<string, unknown> | undefined)?.showPrompt as boolean) ?? false} onchange={(e) => void saveDistillField("render.showPrompt", e.currentTarget.checked)} /> showPrompt</label>
      <label class="check"><input type="checkbox" checked={((files["distill-config"]?.data?.render as Record<string, unknown> | undefined)?.showResult as boolean) ?? false} onchange={(e) => void saveDistillField("render.showResult", e.currentTarget.checked)} /> showResult</label>
    </div>
    <span class="flabel">Per-tool enablement</span>
    {#each distillToolNames() as t (t)}
      <label class="check"><input type="checkbox" checked={distillToolEnabled(t)} onchange={(e) => void saveDistillField(`tools.${t}.enabled`, e.currentTarget.checked)} /> {t}</label>
    {:else}
      <div class="hint none">No per-tool overrides configured.</div>
    {/each}
  </details>

  <!-- Instruction files -->
  <details class="pkg-block">
    <summary>Instruction sources (SYSTEM.md / APPEND_SYSTEM.md / AGENTS.md — raw markdown)</summary>
    <p class="hint">Pi loads these as instruction sources (replace vs append semantics are pi's own). Edits apply on pi's reload rules — not injected into the running conversation. Raw edits preserve frontmatter.</p>
    {#each INSTRUCTION_TARGETS as t (t.target)}
      <div class="frow">
        <span class="flabel">{t.label}</span>
        <button class="ghost" onclick={() => void load(t.target, true).catch(() => {})}>{files[t.target] ? "Reload" : "Load"}</button>
      </div>
      {#if files[t.target]}
        <textarea class="mono yaml" rows={8} value={files[t.target]?.raw ?? ""} oninput={(e) => { files = { ...files, [t.target]: { data: null, raw: e.currentTarget.value, revision: files[t.target]?.revision ?? null, exists: true } }; }}></textarea>
        <div class="frow">
          <button onclick={() => void saveRaw(t.target, files[t.target]?.raw ?? "")}>Save</button>
        </div>
      {/if}
    {/each}
  </details>

  <!-- Serena -->
  <details class="pkg-block" ontoggle={() => { void load("serena-global-yml", true).catch(() => {}); void load("serena-project-yml", true).catch(() => {}); }}>
    <summary>Serena (YAML — raw editors; comments and formatting are yours to preserve)</summary>
    <p class="hint">Language servers, ignored paths, read-only mode, tool inclusion/exclusion, modes, timeouts, symbol budgets live in these YAML files. Tab-indentation is refused. Serena worker restart applies changes.</p>
    <span class="flabel">~/.serena/serena_config.yml</span>
    <textarea class="mono yaml" rows={8} value={files["serena-global-yml"]?.raw ?? ""} onchange={(e) => { files = { ...files, ["serena-global-yml"]: { data: null, raw: e.currentTarget.value, revision: files["serena-global-yml"]?.revision ?? null, exists: true } }; }}></textarea>
    <div class="frow">
      <button onclick={() => void mgmtRequest("write-raw", { target: "serena-global-yml", content: files["serena-global-yml"]?.raw ?? "", revision: revisionFor("serena-global-yml") }).then(() => load("serena-global-yml", true)).then(flashSaved).catch(noteSaveError)}>Save global YAML</button>
    </div>
    <span class="flabel">.serena/project.yml (this project)</span>
    <textarea class="mono yaml" rows={8} value={files["serena-project-yml"]?.raw ?? ""} onchange={(e) => { files = { ...files, ["serena-project-yml"]: { data: null, raw: e.currentTarget.value, revision: files["serena-project-yml"]?.revision ?? null, exists: true } }; }}></textarea>
    <div class="frow">
      <button onclick={() => void mgmtRequest("write-raw", { target: "serena-project-yml", content: files["serena-project-yml"]?.raw ?? "", revision: revisionFor("serena-project-yml") }).then(() => load("serena-project-yml", true)).then(flashSaved).catch(noteSaveError)}>Save project YAML</button>
    </div>
  </details>

  <!-- Web / Ref -->
  <details class="pkg-block" ontoggle={() => void loadEnv()}>
    <summary>Web &amp; Ref providers (credential presence — values never displayed)</summary>
    {#if envVars}
      <div class="frow wrap">
        {#each envVars as v (v.name)}
          <span class="chip" class:ok={v.set} class:dim={!v.set}>{v.name}: {v.set ? `set (${v.source})` : "not set"}</span>
        {/each}
      </div>
      <p class="hint">Lookup order: process env → cwd .env.local → cwd .env → agent .env.local → agent .env. Editing env files and OAuth/key replacement flows: pending (deliberate actions only; secrets are never read back into forms, logs, or the transcript).</p>
    {:else}
      <div class="hint">Companion unavailable for env diagnostics.</div>
    {/if}
  </details>

  <!-- Media (image_generate defaults) -->
  <details class="pkg-block" ontoggle={() => void load("media-config").catch(() => {})}>
    <summary>Media (image_generate defaults)</summary>
    <p class="hint">Defaults for the image_generate tool — model, resolution, quality, format, background. Tool arguments always win; empty fields use the built-in default.</p>
    {#if files["media-config"]}
      <div class="frow">
        <span class="flabel">model</span>
        <input class="grow mono" value={String(files["media-config"]?.data?.model ?? "")} onchange={(e) => void saveMediaField("model", e.currentTarget.value.trim() || undefined)} placeholder="google/gemini-3.1-flash-image" />
      </div>
      <div class="frow">
        <span class="flabel">resolution</span>
        <select class="sel" value={String(files["media-config"]?.data?.resolution ?? "")} onchange={(e) => void saveMediaField("resolution", e.currentTarget.value || undefined)}>
          <option value="">(built-in default)</option>
          <option value="512">512</option>
          <option value="1K">1K</option>
          <option value="2K">2K</option>
          <option value="4K">4K</option>
        </select>
      </div>
      <div class="frow">
        <span class="flabel">quality</span>
        <select class="sel" value={String(files["media-config"]?.data?.quality ?? "")} onchange={(e) => void saveMediaField("quality", e.currentTarget.value || undefined)}>
          <option value="">(built-in default)</option>
          <option value="auto">auto</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </div>
      <div class="frow">
        <span class="flabel">output format</span>
        <select class="sel" value={String(files["media-config"]?.data?.output_format ?? "")} onchange={(e) => void saveMediaField("output_format", e.currentTarget.value || undefined)}>
          <option value="">(built-in default)</option>
          <option value="png">png</option>
          <option value="jpeg">jpeg</option>
          <option value="webp">webp</option>
          <option value="svg">svg</option>
        </select>
      </div>
      <div class="frow">
        <span class="flabel">background</span>
        <select class="sel" value={String(files["media-config"]?.data?.background ?? "")} onchange={(e) => void saveMediaField("background", e.currentTarget.value || undefined)}>
          <option value="">(built-in default)</option>
          <option value="auto">auto</option>
          <option value="transparent">transparent</option>
          <option value="opaque">opaque</option>
        </select>
      </div>
    {:else}
      <p class="hint">Open this section to load media-config.</p>
    {/if}
  </details>

  <!-- ref-tools -->
  <details class="pkg-block" ontoggle={() => nsLoad("settings-global", "pi-ref-tools")}>
    <summary>Ref tools (pi-ref-tools namespace)</summary>
    {#each refFields as f (f.path)}
      <div class="frow">
        <span class="flabel">{f.label}</span>
        {#if f.type === "number"}
          <input class="num" type="number" value={String(nsValue("settings-global", "pi-ref-tools", f.path) ?? "")} onchange={(e) => void nsSave("settings-global", "pi-ref-tools", { [f.path]: e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value) })} />
        {:else}
          <input class="grow mono" value={String(nsValue("settings-global", "pi-ref-tools", f.path) ?? "")} onchange={(e) => void nsSave("settings-global", "pi-ref-tools", { [f.path]: e.currentTarget.value || undefined })} placeholder={f.hint} />
        {/if}
      </div>
    {/each}
    <p class="hint">REF_API_KEY presence is shown under Web &amp; Ref; the private config file and CLI/env overrides take precedence over these values (shown as source info, pending).</p>
  </details>
</div>

<style>
  .pkg-forms { display: flex; flex-direction: column; gap: 8px; }
  .pkg-block {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
  }
  .pkg-block summary {
    cursor: pointer;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-2);
    user-select: none;
  }
  .frow { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
  .sel {
    padding: 4px 8px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-size: 12px;
  }
  .sel:focus { outline: none; border-color: var(--accent); }
  .frow.wrap { flex-wrap: wrap; }
  .flabel { font-size: 12px; color: var(--text-2); min-width: 140px; }
  .fhint { font-size: 10.5px; color: var(--text-3); }
  .frow input, .frow select, .frow textarea {
    padding: 5px 8px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 12px;
  }
  .frow .num { width: 100px; }
  .frow .grow { flex: 1; min-width: 160px; }
  .yaml { width: 100%; box-sizing: border-box; line-height: 1.45; }
  .perm-tool { border-left: 2px solid var(--border); padding-left: 10px; margin: 6px 0; }
  .chip { font-size: 10px; border: 1px solid var(--border); border-radius: 99px; padding: 0 7px; color: var(--text-3); }
  .chip.ok { color: var(--ok); border-color: var(--ok); }
  .chip.dim { opacity: 0.6; }
  .ghost, .danger { font-size: 11px; padding: 3px 9px; }
  .check { font-size: 12px; display: inline-flex; align-items: center; gap: 5px; color: var(--text); cursor: pointer; }
  .hint { font-size: 11px; color: var(--text-3); margin: 3px 0; }
  .hint.none { padding: 4px 0; }
</style>

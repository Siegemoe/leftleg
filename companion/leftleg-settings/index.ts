/**
 * Leftleg settings companion — management bridge for the Leftleg GUI.
 *
 * Loaded as a global extension (~/.pi/agent/extensions/leftleg-settings/index.ts),
 * independent of project trust. Registers ONE reserved command (`settings-mgmt`)
 * whose argument is a JSON request. Replies are structured JSON carried back to
 * Leftleg via ctx.ui.notify with the `LeftlegMgmt:` marker — fire-and-forget UI
 * events, never model messages and never billable turns.
 *
 * Contract (versioned): request { v, id, op, ...params }, reply { v, id, ok, data?, error? }.
 * File targets are an allowlist; arbitrary paths are rejected. Writes are
 * revision-checked and atomic (tmp + rename). Merge mode preserves unknown
 * fields; namespace mode replaces only the given top-level keys.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const COMPANION_VERSION = 1;
export const MGMT_COMMAND = "settings-mgmt";
export const MGMT_MARKER = "LeftlegMgmt:";

/** Resolve the Pi agent directory (respects PI_CODING_AGENT_DIR). */
export function resolveAgentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env && env.trim()) return resolve(env);
  return join(homedir(), ".pi", "agent");
}

/** Registered configuration resources. Paths outside these are rejected. */
export function resolveTarget(target: string, agentDir: string, projectDir: string | null): string | null {
  switch (target) {
    case "serena-global-yml": return join(homedir(), ".serena", "serena_config.yml");
    case "serena-project-yml": return projectDir ? join(projectDir, ".serena", "project.yml") : null;
    case "system-md": return join(agentDir, "SYSTEM.md");
    case "append-system-md": return join(agentDir, "APPEND_SYSTEM.md");
    case "system-md-project": return projectDir ? join(projectDir, ".pi", "SYSTEM.md") : null;
    case "append-system-md-project": return projectDir ? join(projectDir, ".pi", "APPEND_SYSTEM.md") : null;
    case "agents-md-project": return projectDir ? join(projectDir, "AGENTS.md") : null;
    case "settings-global": return join(agentDir, "settings.json");
    case "settings-project": return projectDir ? join(projectDir, ".pi", "settings.json") : null;
    case "trust": return join(agentDir, "trust.json");
    case "models": return join(agentDir, "models.json");
    case "models-store": return join(agentDir, "models-store.json"); // cache: read-only
    case "99extensions": return join(agentDir, "99extensions.json");
    case "distill-config": return join(agentDir, "extensions", "pi-distill", "config.json");
    case "i18n-config": return join(agentDir, "extensions", "pi-extensions-i18n", "config.json");
    case "tool-display-config": return join(agentDir, "extensions", "pi-tool-display", "config.json");
    case "lens-project": return projectDir ? join(projectDir, ".pi-lens.json") : null;
    default: return null;
  }
}

const READ_ONLY_TARGETS = new Set(["models-store"]);

/** Stable-enough revision: size + mtimeMs, detects external edits between read and write. */
export function computeRevision(file: string): string | null {
  try {
    const st = statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Deep-merge `patch` into `base`. Plain objects merge recursively; everything
 * else (arrays, scalars, null) replaces. Unknown base fields are preserved. */
export function applyMerge(base: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  if (base === null || typeof base !== "object" || Array.isArray(base)) return { ...patch };
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = applyMerge(out[k], v);
  }
  return out;
}

/** Replace ONLY the top-level keys present in `patch` (namespace-safe save). */
export function applyNamespaces(base: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = (base && typeof base === "object" && !Array.isArray(base))
    ? { ...(base as Record<string, unknown>) }
    : {};
  for (const [k, v] of Object.entries(patch)) out[k] = v;
  return out;
}

/** Namespace-merge: for each top-level key in `patch`, deep-merge INSIDE that
 * namespace — other sibling keys within it (e.g. pi-plan's btw/goal/plansDir
 * when editing planModel) survive untouched. Other namespaces also untouched. */
export function applyNamespaceMerge(base: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = (base && typeof base === "object" && !Array.isArray(base))
    ? { ...(base as Record<string, unknown>) }
    : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = applyMerge(out[k], v);
  }
  return out;
}

function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(tmpdir(), `.leftleg-mgmt-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, file);
}

interface Request { v?: number; id?: string; op?: string; [k: string]: unknown }

function reply(ctx: { ui: { notify(message: string, level?: string): void } }, id: string | null, ok: boolean, payload: Record<string, unknown>): void {
  const body = { v: COMPANION_VERSION, id, ok, ...(ok ? { data: payload } : { error: payload.error ?? "unknown error" }) };
  try {
    ctx.ui.notify(MGMT_MARKER + JSON.stringify(body), ok ? "info" : "error");
  } catch {
    // UI unavailable (headless): nothing else we can do — Leftleg's timeout handles it.
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand(MGMT_COMMAND, {
    description: "Leftleg settings management channel (reserved; args are JSON requests)",
    handler: async (args: string | undefined, ctx: {
      cwd?: string;
      ui: { notify(message: string, level?: string): void };
      [k: string]: unknown;
    }) => {
      let req: Request | null = null;
      try {
        req = JSON.parse((args ?? "").trim()) as Request;
      } catch {
        reply(ctx, null, false, { error: "unparseable request" });
        return;
      }
      const id = typeof req.id === "string" ? req.id : null;
      try {
        if (req.v !== COMPANION_VERSION) {
          reply(ctx, id, false, { error: `version mismatch: companion ${COMPANION_VERSION}, request ${req.v}` });
          return;
        }
        const agentDir = resolveAgentDir();
        const projectDir = typeof ctx.cwd === "string" ? ctx.cwd : null;

        switch (req.op) {
          case "ping":
            reply(ctx, id, true, {
              companionVersion: COMPANION_VERSION,
              agentDir,
              projectDir,
            });
            return;

          case "read": {
            const file = resolveTarget(String(req.target ?? ""), agentDir, projectDir);
            if (!file) { reply(ctx, id, false, { error: `unknown target: ${String(req.target)}` }); return; }
            if (!existsSync(file)) { reply(ctx, id, true, { exists: false, data: null, raw: null, revision: null }); return; }
            const raw = readFileSync(file, "utf-8");
            let data: unknown = null;
            try { data = JSON.parse(raw); } catch { data = null; }
            reply(ctx, id, true, { exists: true, data, raw, revision: computeRevision(file) });
            return;
          }

          case "write": {
            const file = resolveTarget(String(req.target ?? ""), agentDir, projectDir);
            if (!file) { reply(ctx, id, false, { error: `unknown target: ${String(req.target)}` }); return; }
            if (READ_ONLY_TARGETS.has(String(req.target))) {
              reply(ctx, id, false, { error: `${req.target} is read-only (generated cache)` });
              return;
            }
            // Revision check: detect external edits (e.g. the Pi TUI) between read and write.
            if (req.revision !== undefined) {
              const current = computeRevision(file);
              if (current !== req.revision) {
                reply(ctx, id, false, { error: "conflict: file changed since read", currentRevision: current });
                return;
              }
            }
            const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
            let base: unknown = null;
            let baseIsJson = false;
            if (existing.trim()) {
              try { base = JSON.parse(existing); baseIsJson = true; } catch { base = null; baseIsJson = false; }
            }
            let next: unknown;
            const mode = String(req.mode ?? "merge");
            if (mode === "merge" || mode === "namespace" || mode === "namespace-merge") {
              const patch = req.patch;
              if (patch === undefined || patch === null || typeof patch !== "object") {
                reply(ctx, id, false, { error: "patch must be an object" });
                return;
              }
              if (existing.trim() && !baseIsJson) {
                reply(ctx, id, false, { error: "existing file is not valid JSON — repair it manually before writing" });
                return;
              }
              if (mode === "merge") next = baseIsJson ? applyMerge(base, patch) : patch;
              else if (mode === "namespace") next = applyNamespaces(base, patch as Record<string, unknown>);
              else next = applyNamespaceMerge(base, patch as Record<string, unknown>);
            } else if (mode === "replace") {
              if (typeof req.content !== "string") { reply(ctx, id, false, { error: "replace requires content string" }); return; }
              JSON.parse(req.content); // must be valid JSON
              next = JSON.parse(req.content);
            } else {
              reply(ctx, id, false, { error: `unknown write mode: ${mode}` });
              return;
            }
            atomicWrite(file, JSON.stringify(next, null, 2) + "\n");
            reply(ctx, id, true, { target: req.target, file, revision: computeRevision(file) });
            return;
          }

          case "unset": {
            const file = resolveTarget(String(req.target ?? ""), agentDir, projectDir);
            if (!file) { reply(ctx, id, false, { error: `unknown target: ${String(req.target)}` }); return; }
            if (READ_ONLY_TARGETS.has(String(req.target))) {
              reply(ctx, id, false, { error: `${req.target} is read-only (generated cache)` });
              return;
            }
            const keys = Array.isArray(req.keys) ? (req.keys as string[]) : [];
            if (keys.length === 0) { reply(ctx, id, false, { error: "unset requires keys" }); return; }
            if (!existsSync(file)) { reply(ctx, id, true, { removed: keys.length, file }); return; }
            const raw = readFileSync(file, "utf-8");
            let doc: Record<string, unknown>;
            try { doc = JSON.parse(raw) as Record<string, unknown>; } catch {
              reply(ctx, id, false, { error: "existing file is not valid JSON — repair it manually before writing" });
              return;
            }
            // Reset-to-inherit: REMOVE dotted paths so the value inherits from
            // the parent scope; never write the inherited value down into this scope.
            let removed = 0;
            for (const key of keys) {
              const parts = key.split(".");
              let obj: Record<string, unknown> | undefined = doc;
              for (let i = 0; i < parts.length - 1 && obj; i++) {
                const nxt: unknown = obj[parts[i]];
                obj = nxt && typeof nxt === "object" && !Array.isArray(nxt) ? (nxt as Record<string, unknown>) : undefined;
              }
              if (obj && typeof obj === "object") {
                const leaf = parts[parts.length - 1];
                if (leaf in obj) { delete obj[leaf]; removed++; }
              }
            }
            if (req.revision !== undefined && computeRevision(file) !== req.revision) {
              reply(ctx, id, false, { error: "conflict: file changed since read" });
              return;
            }
            atomicWrite(file, JSON.stringify(doc, null, 2) + "\n");
            reply(ctx, id, true, { removed, file, revision: computeRevision(file) });
            return;
          }

          case "read-raw": {
            const file = resolveTarget(String(req.target ?? ""), agentDir, projectDir);
            if (!file) { reply(ctx, id, false, { error: `unknown target: ${String(req.target)}` }); return; }
            if (!existsSync(file)) { reply(ctx, id, true, { exists: false, raw: null, revision: null }); return; }
            reply(ctx, id, true, { exists: true, raw: readFileSync(file, "utf-8"), revision: computeRevision(file) });
            return;
          }

          case "write-raw": {
            const file = resolveTarget(String(req.target ?? ""), agentDir, projectDir);
            if (!file || !/\.(ya?ml|md|txt|json)$/i.test(file)) {
              reply(ctx, id, false, { error: "raw writes are limited to registered YAML/MD/TXT/JSON resources" });
              return;
            }
            if (typeof req.content !== "string") { reply(ctx, id, false, { error: "write-raw requires content string" }); return; }
            if (req.revision !== undefined) {
              const current = computeRevision(file);
              if (current !== req.revision) {
                reply(ctx, id, false, { error: "conflict: file changed since read", currentRevision: current });
                return;
              }
            }
            // YAML targets: refuse to clobber files that are not parseable YAML-ish text
            // (tab-indentation is invalid YAML; guard against accidental binary).
            if (/\.(ya?ml)$/i.test(file) && /\t/.test(req.content)) {
              reply(ctx, id, false, { error: "YAML must not contain tab indentation" });
              return;
            }
            atomicWrite(file, req.content.endsWith("\n") ? req.content : req.content + "\n");
            reply(ctx, id, true, { target: req.target, file, revision: computeRevision(file) });
            return;
          }

          case "env-check": {
            // Presence/source only — values are NEVER returned (secrets stay put).
            const wanted = [
              "SEARXNG_BASE_URL", "BRAVE_API_KEY", "FIRECRAWL_API_URL", "FIRECRAWL_API_KEY",
              "CRAWL4AI_API_URL", "CRAWL4AI_API_TOKEN", "REF_API_KEY", "PI_EXTENSIONS_LOCALE", "PI_WORKTREE_HOME",
            ];
            const scan = (file: string): Record<string, boolean> => {
              const out: Record<string, boolean> = {};
              try {
                const lines = readFileSync(file, "utf-8").split(/\r?\n/);
                for (const name of wanted) {
                  if (lines.some((l) => l.startsWith(`${name}=`) || l.startsWith(`${name} =`))) out[name] = true;
                }
              } catch { /* missing file */ }
              return out;
            };
            const sources: Record<string, string> = {};
            for (const name of wanted) {
              if (process.env[name] !== undefined) sources[name] = "process env";
            }
            for (const f of [join(projectDir ?? "\\0", ".env.local"), join(projectDir ?? "\\0", ".env"), join(agentDir, ".env.local"), join(agentDir, ".env")]) {
              const present = scan(f);
              for (const name of Object.keys(present)) {
                if (!sources[name]) sources[name] = f;
              }
            }
            reply(ctx, id, true, {
              vars: Object.fromEntries(wanted.map((name) => [name, { set: sources[name] !== undefined, source: sources[name] ?? null }])),
            });
            return;
          }

          case "list-resources": {
            const settingsFile = join(agentDir, "settings.json");
            let packages: unknown[] = [];
            try {
              const s = JSON.parse(readFileSync(settingsFile, "utf-8"));
              if (Array.isArray(s.packages)) packages = s.packages;
            } catch { /* no settings yet */ }
            const listDir = (p: string): string[] => {
              try { return readdirSync(p).filter((n) => !n.startsWith(".")); } catch { return []; }
            };
            const extRoot = join(agentDir, "extensions");
            reply(ctx, id, true, {
              agentDir,
              packages,
              extensionDirs: listDir(extRoot),
              skillDirs: listDir(join(agentDir, "skills")),
              filesPresent: Object.fromEntries(
                ["settings.json", "trust.json", "models.json", "models-store.json", "99extensions.json"]
                  .map((f) => [f, existsSync(join(agentDir, f))]),
              ),
            });
            return;
          }

          case "refresh-models": {
            const registry = (ctx as unknown as { modelRegistry?: { refresh?: () => Promise<unknown> } }).modelRegistry;
            if (registry && typeof registry.refresh === "function") {
              await registry.refresh();
              reply(ctx, id, true, { refreshed: true });
            } else {
              reply(ctx, id, false, { error: "modelRegistry.refresh unavailable in this context" });
            }
            return;
          }

          case "get-runtime": {
            const anyCtx = ctx as unknown as Record<string, unknown>;
            const caps: Record<string, boolean> = {
              getActiveTools: typeof anyCtx.getActiveTools === "function",
              setActiveTools: typeof anyCtx.setActiveTools === "function",
              modelRegistry: typeof anyCtx.modelRegistry === "object" && anyCtx.modelRegistry !== null,
              sessionManager: typeof anyCtx.sessionManager === "object" && anyCtx.sessionManager !== null,
            };
            let activeTools: unknown = null;
            if (caps.getActiveTools) {
              try { activeTools = await (anyCtx.getActiveTools as () => Promise<unknown>)(); } catch { activeTools = null; }
            }
            let sessionFile: unknown = null;
            if (caps.sessionManager) {
              try { sessionFile = (anyCtx.sessionManager as { getSessionFile?: () => unknown }).getSessionFile?.() ?? null; } catch { sessionFile = null; }
            }
            reply(ctx, id, true, { cwd: projectDir, agentDir, capabilities: caps, activeTools, sessionFile });
            return;
          }

          case "set-active-tools": {
            const fn = (ctx as unknown as { setActiveTools?: (t: unknown) => Promise<unknown> }).setActiveTools;
            if (typeof fn !== "function") { reply(ctx, id, false, { error: "setActiveTools unavailable in this context" }); return; }
            await fn(req.tools);
            reply(ctx, id, true, { applied: true });
            return;
          }

          default:
            reply(ctx, id, false, { error: `unknown op: ${String(req.op)}` });
        }
      } catch (err) {
        reply(ctx, id, false, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  });
}

// Imports kept last-marked for tree-shaking clarity; `isAbsolute` retained for target validation.
void isAbsolute;

// Settings workspace state helpers: path access, provenance, defaults.
// Defaults below are informational (from pi 0.85.1 docs/settings.md) — they are
// display hints only; absence of a key means "inherited/absent", never these values.

import type { SidebarSession } from "../sidebar-model";

export type Scope = "global" | "project";

export const INHERIT = Symbol("inherit");

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  // Config paths must never traverse reserved object keys — a crafted key
  // like `__proto__` would otherwise pollute Object.prototype.
  for (const part of parts) {
    if (isUnsafeConfigKey(part)) throw new Error(`unsafe configuration key: ${part}`);
  }
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const nxt = cur[parts[i]];
    if (!nxt || typeof nxt !== "object" || Array.isArray(nxt)) cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** Reserved keys that must never be traversed or assigned by config paths. */
export function isUnsafeConfigKey(part: string): boolean {
  return part === "__proto__" || part === "constructor" || part === "prototype";
}

/** Deep-clone via JSON (settings data is JSON-safe by definition). */
export function cloneJson<T>(v: T): T {
  return v === undefined ? (undefined as unknown as T) : (JSON.parse(JSON.stringify(v)) as T);
}

/** Undefined form fields mean remove the override, not an empty merge. */
export function preparePatch(
  patch: Record<string, unknown>,
  prefix = "",
): { patch: Record<string, unknown>; unsetKeys: string[] } {
  const clean: Record<string, unknown> = {};
  const unsetKeys: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === undefined) unsetKeys.push(path);
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = preparePatch(value as Record<string, unknown>, path);
      clean[key] = nested.patch;
      unsetKeys.push(...nested.unsetKeys);
    } else clean[key] = value;
  }
  return { patch: clean, unsetKeys };
}

export type Source = "project" | "global" | "inherited";

/** Which scope supplies the effective value for a path. */
export function sourceOf(
  projectData: Record<string, unknown> | null,
  globalData: Record<string, unknown> | null,
  path: string,
): Source {
  const p = getPath(projectData, path);
  if (p !== undefined) return "project";
  const g = getPath(globalData, path);
  if (g !== undefined) return "global";
  return "inherited";
}

export function effectiveValue(
  projectData: Record<string, unknown> | null,
  globalData: Record<string, unknown> | null,
  path: string,
): unknown {
  const s = sourceOf(projectData, globalData, path);
  if (s === "project") return getPath(projectData, path);
  if (s === "global") return getPath(globalData, path);
  return undefined;
}

/** Documented defaults (display hints; not written anywhere). */
export const DOCUMENTED_DEFAULTS: Record<string, unknown> = {
  "compaction.enabled": true,
  "compaction.reserveTokens": 16384,
  "compaction.keepRecentTokens": 20000,
  "branchSummary.reserveTokens": 16384,
  "branchSummary.skipPrompt": false,
  "retry.enabled": true,
  "retry.maxRetries": 3,
  "retry.baseDelayMs": 2000,
  "retry.provider.maxRetries": 0,
  "retry.provider.maxRetryDelayMs": 60000,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  transport: "auto",
  httpIdleTimeoutMs: 300000,
  websocketConnectTimeoutMs: 15000,
  "images.autoResize": true,
  "images.blockImages": false,
  theme: "dark",
  defaultProjectTrust: "ask",
  enableInstallTelemetry: true,
  enableAnalytics: false,
  hideThinkingBlock: false,
  showCacheMissNotices: false,
  enableSkillCommands: true,
  "warnings.anthropicExtraUsage": true,
};

export function defaultValue(path: string): unknown {
  return DOCUMENTED_DEFAULTS[path];
}

export const BUILTIN_TOOLS = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Session type re-export used by the workspace lists. */
export type { SidebarSession };

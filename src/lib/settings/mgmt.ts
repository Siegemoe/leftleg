// Leftleg → companion management transport.
//
// Requests ride a reserved Pi extension command (`/settings-mgmt <json>`) —
// extension commands execute immediately in RPC mode without becoming model
// messages, conversation entries, or billable turns. Replies come back as
// `extension_ui_request` notify events carrying the `LeftlegMgmt:` marker;
// stores.handleEvent hands them here BEFORE any toast is shown.
//
// Safety rules enforced here:
// - Availability gate: pi's `get_commands` entry must be an extension command
//   whose source path lives in the agent's extensions dir (pi returns prompt
//   templates under the same list; a repo could otherwise ship a template
//   named `settings-mgmt` and have management JSON expanded as a model
//   prompt). pi's docs: use sourceInfo as canonical provenance, never names.
// - Generation binding: if the pi process is replaced between send and reply
//   (restart), pending requests are rejected rather than resolved with stale data.
// - Reply identity: request ids are random UUIDs and replies from a different
//   project/process are ignored, so notify noise from other extensions cannot
//   resolve or kill a pending request (they cannot guess the id).
// - Timeouts: every request is bounded; nothing waits forever on a dead companion.

import { get } from "svelte/store";
import { commands, lastProcByProject, projectDir, navigating, updateInstallLock } from "../stores";
import { getAgentDir, piRequest } from "../api";
import type { ExtCommand } from "../types";

export const MGMT_COMMAND = "settings-mgmt";
export const MGMT_MARKER = "LeftlegMgmt:";
const MGMT_TIMEOUT_MS = 15_000;

interface Pending {
  project: string;
  proc: number;
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<string, Pending>();

let agentDirCache: string | undefined;
let agentDirFetched = false;
function ensureAgentDir(): void {
  if (agentDirFetched) return;
  agentDirFetched = true;
  void getAgentDir()
    .then((d) => (agentDirCache = d))
    .catch(() => (agentDirCache = ""));
}

/** Provenance check: an extension command installed in the agent's extensions dir. */
function isCompanionCommand(c: ExtCommand): boolean {
  if (c.source !== "extension") return false;
  // Until get_agent_dir resolves (or if it fails), the source check alone
  // stands — prompt templates carry source "prompt", so the fallthrough they
  // enable is already blocked.
  if (!agentDirCache) return true;
  const path = (c.sourceInfo?.path ?? "").replace(/\\/g, "/").toLowerCase();
  return path.includes("/extensions/leftleg-settings/");
}

/** Synchronous lifecycle signal used immediately before installing an update. */
export function pendingManagementCount(): number {
  return pending.size;
}

export function companionAvailable(): boolean {
  ensureAgentDir();
  return !get(navigating) && !get(updateInstallLock) && get(commands).some(isCompanionCommand);
}

function currentGeneration(): number | undefined {
  return get(lastProcByProject)[get(projectDir)];
}

/** Consume a notify message if it is a management reply. Returns true when consumed. */
export function handleMgmtNotify(message: string, origin?: { project: string; proc: number }): boolean {
  if (!message.startsWith(MGMT_MARKER)) return false;
  try {
    const reply = JSON.parse(message.slice(MGMT_MARKER.length)) as { id?: string; ok?: boolean; error?: unknown };
    const p = reply.id ? pending.get(reply.id) : undefined;
    if (p && origin && (p.project !== origin.project || p.proc !== origin.proc)) {
      // Wrong-origin noise (another extension in the same pi process spoofing
      // the marker): ignore it — the real request stays pending for its true
      // reply or its timeout.
      return true;
    }
    if (p && reply.id) {
      clearTimeout(p.timer);
      pending.delete(reply.id);
      if (reply.ok) p.resolve(reply);
      else p.reject(new Error(stringifyError(reply.error)));
    }
  } catch {
    // Malformed marker payload: drop silently — it is never user-facing text.
  }
  return true;
}

function stringifyError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "error" in err) {
    const inner = (err as { error: unknown }).error;
    return typeof inner === "string" ? inner : JSON.stringify(inner);
  }
  return JSON.stringify(err);
}

/** Reject everything pending (used when the pi process exits). */
export function abortPendingMgmt(reason: string, project?: string, proc?: number): void {
  for (const [id, p] of pending) {
    if (project !== undefined && p.project !== project || proc !== undefined && p.proc !== proc) continue;
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

/** Bind every step of a settings form to the process that supplied its data. */
export function bindManagement() {
  const project = get(projectDir);
  const proc = currentGeneration();
  return <T = Record<string, unknown>>(op: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> => {
    if (project !== get(projectDir) || proc !== currentGeneration()) return Promise.reject(new Error("Project or process changed — reopen settings before saving"));
    return mgmtRequest<T>(op, params, timeoutMs);
  };
}

/**
 * Send one management request to the companion. Resolves with the reply's
 * `data` payload. Throws on: companion unavailable, generation change, timeout,
 * or a companion-reported error.
 */
export async function mgmtRequest<T = Record<string, unknown>>(
  op: string,
  params: Record<string, unknown> = {},
  timeoutMs = MGMT_TIMEOUT_MS,
): Promise<T> {
  if (!companionAvailable()) {
    throw new Error("Settings companion unavailable — install it in Settings → Advanced. Management requests are never sent as chat prompts.");
  }
  const gen = currentGeneration();
  const project = get(projectDir);
  if (gen === undefined) throw new Error("no active pi process");

  // Unguessable: a spoofed reply must not be able to name a pending id.
  const id = crypto.randomUUID();
  // Envelope keys last so caller params can never shadow id/op/v.
  const payload = JSON.stringify({ ...params, v: 1, id, op });

  const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`management request '${op}' timed out`));
    }, timeoutMs);
    pending.set(id, { project, proc: gen, resolve, reject, timer });
  });

  // Re-check availability + generation immediately before sending.
  if (!companionAvailable() || currentGeneration() !== gen) {
    const p = pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(id);
    }
    throw new Error("settings companion became unavailable (process changed)");
  }

  // Observe both promises immediately: notify can reject before the prompt
  // acknowledgement, and a hanging acknowledgement must not defeat timeout.
  try {
    const accepted = piRequest<{ success: boolean; error?: string }>(
      { type: "prompt", message: `/${MGMT_COMMAND} ${payload}` },
      Math.ceil(timeoutMs / 1000) + 5,
      project,
      gen,
    ).then((res) => {
      if (!res.success) throw new Error(`management request rejected: ${res.error ?? "pi refused the command"}`);
    });
    const [, reply] = await Promise.all([accepted, promise]);
    return ((reply as { data?: T }).data ?? reply) as T;
  } finally {
    const p = pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(id);
    }
  }
}

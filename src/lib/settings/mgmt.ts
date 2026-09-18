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
// - Per-target availability: a request is gated against the command list of the
//   exact pi process that will carry it — the tracked foreground list for the
//   foreground project, a direct get_commands read from that process for a
//   scoped background target. The foreground list must never stand in for a
//   background process: one started before the companion install would get
//   `/settings-mgmt <json>` expanded as a model prompt.

import { get, writable } from "svelte/store";
import { commands, lastProcByProject, projectDir, navigating, updateInstallLock } from "../stores";
import { getAgentDir, piRequest } from "../api";
import type { ExtCommand } from "../types";

export const MGMT_COMMAND = "settings-mgmt";
export const MGMT_MARKER = "LeftlegMgmt:";
const MGMT_TIMEOUT_MS = 15_000;
const MGMT_UNAVAILABLE =
  "Settings companion unavailable — install it in Settings → Advanced. Management requests are never sent as chat prompts.";

/** Explicit routing for one request: which project's companion carries it,
 * bound to which process generation. Omitted fields fall back to the
 * foreground project — the pre-scoping behavior. */
export interface MgmtTarget {
  project?: string;
  proc?: number;
}

interface Pending {
  project: string;
  proc: number;
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<string, Pending>();

/** Resolved agent dir: null while the lookup is in flight, "" on failure. A
 * store (not a plain cache) so the availability chip re-evaluates the moment
 * the lookup resolves. */
export const agentDirStore = writable<string | null>(null);

let agentDirPromise: Promise<string> | null = null;
/** Kick off (once) and await the agent-dir lookup that anchors provenance. A
 * transient lookup failure clears the cached promise so the next request
 * retries instead of bricking management until reload. */
function ensureAgentDir(): Promise<string> {
  if (!agentDirPromise) {
    agentDirPromise = getAgentDir()
      .then((d) => {
        agentDirStore.set(d);
        return d;
      })
      .catch(() => {
        agentDirPromise = null;
        agentDirStore.set("");
        return "";
      });
  }
  return agentDirPromise;
}

/** Kick off the agent-dir lookup without waiting for it (idempotent). Boot
 * calls this so the availability chip's provenance anchor is resolved long
 * before settings can render; import time is too eager — api mocks in tests
 * and the transport wiring may not exist yet. */
export function primeAgentDir(): void {
  void ensureAgentDir();
}

/** Agent dir for gate evaluation: undefined while the first lookup is still
 * in flight (provisional pass), "" on failure (deny). */
function companionAgentDir(): string | undefined {
  void ensureAgentDir();
  return get(agentDirStore) ?? undefined;
}

/**
 * Identity + provenance gate for the management command: the pi command entry
 * must be an extension command named `settings-mgmt` whose source path lives
 * under <agentDir>/extensions/leftleg-settings/. Names alone never suffice (a
 * repo can ship a prompt template with any name), and the path check is
 * anchored to the agent dir — an unanchored substring would admit a
 * project-local extension of the same name in a trusted repo. While the
 * agent-dir lookup is in flight, name + source stand in (prompt templates
 * carry source "prompt"); a lookup failure ("") denies everything.
 */
export function isCompanionCommand(c: ExtCommand, agentDir: string | undefined): boolean {
  if (c.name !== MGMT_COMMAND || c.source !== "extension") return false;
  if (agentDir === undefined) return true;
  const dir = agentDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (dir === "") return false;
  const path = (c.sourceInfo?.path ?? "").replace(/\\/g, "/").toLowerCase();
  return path.startsWith(`${dir}/extensions/leftleg-settings/`);
}

/** Synchronous lifecycle signal used immediately before installing an update. */
export function pendingManagementCount(): number {
  return pending.size;
}

/** GUI-level gates shared by every send path (navigation in flight, updater
 * holding the process pool). */
function guiGateOpen(): boolean {
  return !get(navigating) && !get(updateInstallLock);
}

export function companionAvailable(): boolean {
  return guiGateOpen() && get(commands).some((c) => isCompanionCommand(c, companionAgentDir()));
}

function currentGeneration(): number | undefined {
  return get(lastProcByProject)[get(projectDir)];
}

/** Command list of the process that will carry a request. The foreground
 * project's tracked list (stores.refreshCommands) is authoritative there; a
 * background target has no tracked list in the GUI, so ask that exact process
 * directly — the same get_commands read, routed explicitly. Substituting the
 * foreground list would be unsound in both directions: a background pi started
 * before the companion install would get `/settings-mgmt <json>` expanded as a
 * model prompt, and one started after would be refused on stale data. Probe
 * failure denies (empty list) — the gate is conservative by design. */
async function targetCommands(project: string, proc: number): Promise<ExtCommand[]> {
  if (project === get(projectDir)) return get(commands);
  const res = await piRequest<{ success?: boolean; data?: { commands?: ExtCommand[] } }>(
    { type: "get_commands" },
    30,
    project,
    proc,
  ).catch(() => null);
  return res?.success && res.data ? (res.data.commands ?? []) : [];
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

/** Scope for bare bindManagement() forms (PackageForms) while a scoped
 * settings session is open. The workspace sets it synchronously on mount —
 * before its children instantiate and bind — and clears it on destroy. */
let scopeTarget: MgmtTarget | undefined;

/** Bare bindManagement() calls resolve through this while it is set. Keep the
 * exact object handed in: it is the handle for clearManagementScope. */
export function setManagementScope(target: MgmtTarget | undefined): void {
  scopeTarget = target;
}

/** Clear the scope, but only if it still points at `handle`. A keyed remount
 * sets a fresh scope object; the stale destroy of the old workspace may fire
 * after that set, and must not drop it — hence identity, not field equality. */
export function clearManagementScope(handle: MgmtTarget | undefined): void {
  if (scopeTarget === handle) scopeTarget = undefined;
}

/** Bind every step of a settings form to the process that supplied its data.
 * With a target the form is pinned to that exact project + generation (the
 * scoped workspace opened for a per-project card, including background
 * projects); without one it binds the foreground project as before — unless a
 * scope is set (setManagementScope), which bare binds capture instead. A
 * scoped bind with no live process yet stays bound — requests fail closed with
 * "no active pi process" until that project's pi starts, and a process
 * replacement rejects the form instead of saving through the wrong one. */
export function bindManagement(explicit?: MgmtTarget) {
  // Captured at bind time: a later scope change never retargets a mounted
  // form — the keyed remount is the retarget mechanism.
  const target = explicit ?? scopeTarget;
  const project = target?.project ?? get(projectDir);
  const proc = target ? target.proc : currentGeneration();
  const stillBound = target
    ? () => get(lastProcByProject)[project] === proc
    : () => project === get(projectDir) && proc === currentGeneration();
  return async <T = Record<string, unknown>>(op: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> => {
    if (!stillBound()) return Promise.reject(new Error("Project or process changed — reopen settings before saving"));
    return mgmtRequest<T>(op, params, timeoutMs, target);
  };
}

/**
 * Send one management request to the companion. Resolves with the reply's
 * `data` payload. Throws on: companion unavailable, generation change, timeout,
 * or a companion-reported error. With `target` the request rides that
 * project's companion bound to that process generation (a scoped workspace can
 * edit a background project while another one is foreground); without it the
 * foreground project is used.
 */
export async function mgmtRequest<T = Record<string, unknown>>(
  op: string,
  params: Record<string, unknown> = {},
  timeoutMs = MGMT_TIMEOUT_MS,
  target?: MgmtTarget,
): Promise<T> {
  const project = target?.project ?? get(projectDir);
  const foreground = project === get(projectDir);
  const gen = target?.proc ?? get(lastProcByProject)[project];
  if (!guiGateOpen()) throw new Error(MGMT_UNAVAILABLE);
  // Fast-fail on the tracked foreground list; a scoped background target is
  // gated against its own process below.
  if (foreground && !companionAvailable()) throw new Error(MGMT_UNAVAILABLE);
  if (gen === undefined) throw new Error("no active pi process");

  // The check above ran on name + source alone while the agent-dir lookup was
  // in flight; provenance must be anchored before the first wire send. For a
  // background target the command list comes from that exact process (the
  // tracked store is the foreground's — see targetCommands).
  const agentDir = await ensureAgentDir();
  const cmds = foreground ? get(commands) : await targetCommands(project, gen);
  if (!cmds.some((c) => isCompanionCommand(c, agentDir))) {
    throw new Error(MGMT_UNAVAILABLE);
  }

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

  // Re-check generation with the request registered, so a process replacement
  // in the window above cannot strand it. Generation is keyed to the
  // request's own project — the request rides that project's pi process, so a
  // switch of the foreground project does not invalidate it (replies are
  // project-routed below). The foreground also re-checks its tracked
  // companion list (it can move while the agent-dir lookup awaited); a
  // background target's own probe is current by construction — no await has
  // run since it resolved — so only the generation can have moved.
  const requestProc = get(lastProcByProject)[project];
  if (requestProc !== gen || (foreground && !companionAvailable())) {
    const p = pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(id);
    }
    throw new Error(requestProc !== gen
      ? "settings companion became unavailable (process changed)"
      : MGMT_UNAVAILABLE);
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

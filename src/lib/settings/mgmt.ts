// Leftleg → companion management transport.
//
// Requests ride a reserved Pi extension command (`/settings-mgmt <json>`) —
// extension commands execute immediately in RPC mode without becoming model
// messages, conversation entries, or billable turns. Replies come back as
// `extension_ui_request` notify events carrying the `LeftlegMgmt:` marker;
// stores.handleEvent hands them here BEFORE any toast is shown.
//
// Safety rules enforced here:
// - Availability gate: the command must be present in pi's `get_commands` for
//   the CURRENT process generation, re-checked immediately before send. An
//   absent companion therefore can never fall through to an ordinary model prompt.
// - Generation binding: if the pi process is replaced between send and reply
//   (restart), pending requests are rejected rather than resolved with stale data.
// - Timeouts: every request is bounded; nothing waits forever on a dead companion.

import { get } from "svelte/store";
import { commands, lastProcByProject, projectDir } from "../stores";
import { piRequest } from "../api";

export const MGMT_COMMAND = "settings-mgmt";
export const MGMT_MARKER = "LeftlegMgmt:";
const MGMT_TIMEOUT_MS = 15_000;

let seq = 0;
interface Pending {
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<string, Pending>();

export function companionAvailable(): boolean {
  return get(commands).some((c) => c.name === MGMT_COMMAND);
}

function currentGeneration(): number | undefined {
  return get(lastProcByProject)[get(projectDir)];
}

/** Consume a notify message if it is a management reply. Returns true when consumed. */
export function handleMgmtNotify(message: string): boolean {
  if (!message.startsWith(MGMT_MARKER)) return false;
  try {
    const reply = JSON.parse(message.slice(MGMT_MARKER.length)) as { id?: string; ok?: boolean; error?: unknown };
    const p = reply.id ? pending.get(reply.id) : undefined;
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
export function abortPendingMgmt(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
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
  if (gen === undefined) throw new Error("no active pi process");

  const id = `mgmt-${Date.now()}-${++seq}`;
  const payload = JSON.stringify({ v: 1, id, op, ...params });

  const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`management request '${op}' timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
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

  try {
    const res = await piRequest<{ success: boolean; error?: string }>(
      { type: "prompt", message: `/${MGMT_COMMAND} ${payload}` },
      Math.ceil(timeoutMs / 1000) + 5,
    );
    if (!res.success) {
      const p = pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(id);
      }
      throw new Error(`management request rejected: ${res.error ?? "pi refused the command"}`);
    }
  } catch (e) {
    const p = pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(id);
    }
    if (e instanceof Error && e.message.startsWith("management request")) throw e;
    throw new Error(`management request failed: ${String(e)}`);
  }

  const reply = (await promise) as { data?: T };
  return (reply.data ?? reply) as T;
}

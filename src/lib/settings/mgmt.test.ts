import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { get } from "svelte/store";
vi.mock("../api", () => ({ piRequest: vi.fn(), piSend: vi.fn(), listSessions: vi.fn().mockResolvedValue([]), getAgentDir: vi.fn().mockResolvedValue("C:\\agent") }));
import * as api from "../api";
import { commands, projectDir, lastProcByProject, handleEvent, handlePiExit, notifications, recordProcess } from "../stores";
import { mgmtRequest, abortPendingMgmt, bindManagement } from "./mgmt";
const COMPANION_CMD = { name: "settings-mgmt", source: "extension", sourceInfo: { path: "C:\\agent\\extensions\\leftleg-settings\\index.ts" } };
beforeEach(() => {
  vi.useFakeTimers();
  projectDir.set("/a"); lastProcByProject.set({ "/a": 1, "/b": 2 });
  commands.set([{ ...COMPANION_CMD }]); notifications.set([]);
  vi.mocked(api.piRequest).mockReset().mockResolvedValue({ success: true });
});
afterEach(() => { abortPendingMgmt("test cleanup"); vi.useRealTimers(); });
/** The send path awaits the agent-dir lookup before its first wire send, so
 * callers that read the wire after mgmtRequest() must wait until the request
 * is actually registered and sent — a fixed microtask count would break on
 * every added await in mgmtRequest. Bounded so a gate-failed send can't hang. */
async function untilSent(): Promise<void> {
  for (let i = 0; i < 100 && vi.mocked(api.piRequest).mock.calls.length === 0; i++) {
    await Promise.resolve();
  }
}
function reply(ok = true, project = "/a", proc = 1) {
  const command = vi.mocked(api.piRequest).mock.calls[0][0];
  const payload = JSON.parse(String(command.message).slice("/settings-mgmt ".length));
  return handleEvent({ type: "extension_ui_request", method: "notify", message: "LeftlegMgmt:" + JSON.stringify({ id: payload.id, ok, data: { answer: 42 }, error: "nope" }) }, { project, proc });
}
it("routes replies after the requesting project goes into the background", async () => {
  const pending = mgmtRequest("ping");
  projectDir.set("/b");
  await untilSent();
  await reply();
  await expect(pending).resolves.toEqual({ answer: 42 });
  expect(get(notifications)).toEqual([]);
  expect(vi.mocked(api.piRequest).mock.calls[0][2]).toBe("/a");
});
it("does not abort one project's request when another process exits", async () => {
  const pending = mgmtRequest("ping");
  await untilSent();
  handlePiExit("/b", 2, false);
  await reply();
  await expect(pending).resolves.toEqual({ answer: 42 });
});
it("times out even when the prompt acknowledgement never arrives", async () => {
  vi.mocked(api.piRequest).mockReturnValue(new Promise(() => {}));
  const result = expect(mgmtRequest("ping", {}, 50)).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(51);
  await result;
});
it("handles a failed notify before the prompt acknowledgement without an unhandled rejection", async () => {
  vi.mocked(api.piRequest).mockReturnValue(new Promise(() => {}));
  const result = expect(mgmtRequest("ping")).rejects.toThrow("nope");
  await untilSent();
  await reply(false);
  await result;
});
it("rejects pending requests on process replacement", async () => {
  const result = expect(mgmtRequest("ping")).rejects.toThrow("replaced");
  await untilSent();
  recordProcess("/a", 3);
  await result;
});
it("bound forms cannot save to a different project", async () => {
  const request = bindManagement();
  projectDir.set("/b");
  await expect(request("write")).rejects.toThrow("Project or process changed");
  expect(api.piRequest).not.toHaveBeenCalled();
});
it("a prompt template named settings-mgmt does not satisfy the availability gate", async () => {
  commands.set([{ name: "settings-mgmt", source: "prompt", sourceInfo: { path: "C:\\proj\\.pi\\prompts\\settings-mgmt.md" } }]);
  await expect(mgmtRequest("ping")).rejects.toThrow("Settings companion unavailable");
  expect(api.piRequest).not.toHaveBeenCalled();
});
it("an extension command outside the agent's extensions dir fails the gate once agentDir resolves", async () => {
  await api.getAgentDir();
  commands.set([{ name: "settings-mgmt", source: "extension", sourceInfo: { path: "C:\\proj\\.pi\\extensions\\evil\\index.ts" } }]);
  await expect(mgmtRequest("ping")).rejects.toThrow("Settings companion unavailable");
  expect(api.piRequest).not.toHaveBeenCalled();
});
it("a same-named project-local extension passes the substring but fails the anchored gate", async () => {
  // A trusted repo shipping its own extensions/leftleg-settings must not be
  // mistaken for the companion: the path check is anchored to the agent dir.
  commands.set([{ name: "settings-mgmt", source: "extension", sourceInfo: { path: "C:\\proj\\.pi\\extensions\\leftleg-settings\\index.ts" } }]);
  await expect(mgmtRequest("ping")).rejects.toThrow("Settings companion unavailable");
  expect(api.piRequest).not.toHaveBeenCalled();
});
it("an extension command with a different name fails the gate even from the companion dir", async () => {
  commands.set([{ name: "other-command", source: "extension", sourceInfo: { path: "C:\\agent\\extensions\\leftleg-settings\\index.ts" } }]);
  await expect(mgmtRequest("ping")).rejects.toThrow("Settings companion unavailable");
  expect(api.piRequest).not.toHaveBeenCalled();
});
it("a failed agent-dir lookup is retried on the next request instead of caching the failure", async () => {
  // One transient IPC failure must not brick management until reload: the
  // cached lookup promise resets on failure so the next request retries.
  vi.resetModules();
  try {
    const { getAgentDir, piRequest } = await import("../api");
    vi.mocked(getAgentDir).mockRejectedValue(new Error("ipc down"));
    const stores = await import("../stores");
    stores.commands.set([{ ...COMPANION_CMD }]);
    stores.projectDir.set("/a");
    stores.lastProcByProject.set({ "/a": 1 });
    const { mgmtRequest } = await import("./mgmt");
    await expect(mgmtRequest("ping")).rejects.toThrow("Settings companion unavailable");
    const callsAfterFirst = vi.mocked(getAgentDir).mock.calls.length;
    await expect(mgmtRequest("ping")).rejects.toThrow("Settings companion unavailable");
    expect(vi.mocked(getAgentDir).mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(piRequest).not.toHaveBeenCalled();
  } finally {
    vi.resetModules();
  }
});
it("a spoofed notify with a guessed id cannot resolve a pending request", async () => {
  const result = expect(mgmtRequest("ping", {}, 60_000)).rejects.toThrow("timed out");
  await untilSent();
  const sent = vi.mocked(api.piRequest).mock.calls[0][0] as { message: string };
  const realId = JSON.parse(String(sent.message).slice("/settings-mgmt ".length)).id as string;
  handleEvent(
    { type: "extension_ui_request", method: "notify", message: "LeftlegMgmt:" + JSON.stringify({ id: realId, ok: true, data: { spoofed: true } }) },
    { project: "/b", proc: 2 },
  );
  await vi.advanceTimersByTimeAsync(60_100);
  await result;
});
it("wrong-origin replies are ignored, not rejected — the request survives for its true reply", async () => {
  const pending = mgmtRequest("ping");
  await untilSent();
  handleEvent(
    { type: "extension_ui_request", method: "notify", message: "LeftlegMgmt:" + JSON.stringify({ id: "whatever", ok: false, error: "spoof" }) },
    { project: "/b", proc: 2 },
  );
  await reply();
  await expect(pending).resolves.toEqual({ answer: 42 });
});
it("envelope keys win over caller params (no shadowing)", async () => {
  void mgmtRequest("write", { id: "caller-id", op: "evil-op" }).catch(() => {});
  await untilSent();
  const sent = vi.mocked(api.piRequest).mock.calls[0][0] as { message: string };
  const payload = JSON.parse(String(sent.message).slice("/settings-mgmt ".length));
  expect(payload.op).toBe("write");
  expect(payload.id).not.toBe("caller-id");
});

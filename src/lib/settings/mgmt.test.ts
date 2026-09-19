import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { get } from "svelte/store";
vi.mock("../api", () => ({ piRequest: vi.fn(), piSend: vi.fn(), listSessions: vi.fn().mockResolvedValue([]), getAgentDir: vi.fn().mockResolvedValue("C:\\agent") }));
import * as api from "../api";
import { commands, projectDir, lastProcByProject, handleEvent, handlePiExit, notifications, recordProcess } from "../stores";
import { mgmtRequest, abortPendingMgmt, bindManagement, setManagementScope, clearManagementScope } from "./mgmt";
const COMPANION_CMD = { name: "settings-mgmt", source: "extension", sourceInfo: { path: "C:\\agent\\extensions\\leftleg-settings\\index.ts" } };
beforeEach(() => {
  vi.useFakeTimers();
  projectDir.set("/a"); lastProcByProject.set({ "/a": 1, "/b": 2 });
  commands.set([{ ...COMPANION_CMD }]); notifications.set([]);
  vi.mocked(api.piRequest).mockReset().mockResolvedValue({ success: true });
});
afterEach(() => { abortPendingMgmt("test cleanup"); setManagementScope(undefined); vi.useRealTimers(); });
/** The send path awaits the agent-dir lookup before its first wire send, so
 * callers that read the wire after mgmtRequest() must wait until the request
 * is actually registered and sent — a fixed microtask count would break on
 * every added await in mgmtRequest. Bounded so a gate-failed send can't hang. */
async function untilSent(): Promise<void> {
  for (let i = 0; i < 100 && vi.mocked(api.piRequest).mock.calls.length === 0; i++) {
    await Promise.resolve();
  }
}

/** Explicit targets add a get_commands probe of the target's own process
 * before the prompt send — wait for the actual send, not just the first call. */
async function untilCalls(n: number): Promise<void> {
  for (let i = 0; i < 200 && vi.mocked(api.piRequest).mock.calls.length < n; i++) {
    await Promise.resolve();
  }
}

function replyPayload(callIndex: number): { id: string } {
  const sent = vi.mocked(api.piRequest).mock.calls[callIndex][0] as { message: string };
  return JSON.parse(String(sent.message).slice("/settings-mgmt ".length));
}
function reply(ok = true, project = "/a", proc = 1) {
  const command = vi.mocked(api.piRequest).mock.calls[0][0];
  const payload = JSON.parse(String(command.message).slice("/settings-mgmt ".length));
  return handleEvent({ type: "extension_ui_request", method: "notify", message: "LeftlegMgmt:" + JSON.stringify({ id: payload.id, ok, data: { answer: 42 }, error: "nope" }) }, { project, proc });
}
it("routes replies after the requesting project goes into the background", async () => {
  // The switch lands during the agent-dir await, so the captured project /a
  // is no longer foreground at gate time: its own surface is probed directly
  // (call 0) before the prompt send (call 1). An earlier version validated
  // against the NEW foreground's tracked list, which this mock happened to
  // keep identical — masking the cross-surface validation bug.
  vi.mocked(api.piRequest)
    .mockResolvedValueOnce({ success: true, data: { commands: [{ ...COMPANION_CMD }] } })
    .mockResolvedValueOnce({ success: true });
  const pending = mgmtRequest("ping");
  projectDir.set("/b");
  await untilCalls(2);
  handleEvent(
    { type: "extension_ui_request", method: "notify", message: "LeftlegMgmt:" + JSON.stringify({ id: replyPayload(1).id, ok: true, data: { answer: 42 }, error: "nope" }) },
    { project: "/a", proc: 1 },
  );
  await expect(pending).resolves.toEqual({ answer: 42 });
  expect(get(notifications)).toEqual([]);
  expect(vi.mocked(api.piRequest).mock.calls[1][2]).toBe("/a");
});
it("a project that went to the background mid-gate is validated against its own command surface", async () => {
  // `foreground` is captured before the agent-dir await; a project switch in
  // that window used to leave the request validating against the NEW
  // foreground's tracked command list. The captured project must be probed
  // directly once it is no longer foreground.
  vi.mocked(api.piRequest)
    .mockResolvedValueOnce({ success: true, data: { commands: [{ ...COMPANION_CMD }] } })
    .mockResolvedValueOnce({ success: true });
  const pending = mgmtRequest("ping");
  projectDir.set("/b"); // the switch lands while the agent-dir lookup is in flight
  commands.set([]); // the NEW foreground's surface: must not vouch for /a
  await untilCalls(2);
  const [probe, send] = vi.mocked(api.piRequest).mock.calls;
  expect(probe[0]).toEqual({ type: "get_commands" });
  expect(probe[2]).toBe("/a");
  expect(probe[3]).toBe(1);
  expect((send[0] as { type: string }).type).toBe("prompt");
  expect(send[2]).toBe("/a");
  handleEvent(
    { type: "extension_ui_request", method: "notify", message: "LeftlegMgmt:" + JSON.stringify({ id: replyPayload(1).id, ok: true, data: { answer: 11 } }) },
    { project: "/a", proc: 1 },
  );
  await expect(pending).resolves.toEqual({ answer: 11 });
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

it("an explicit target at the start view rides that project's own process", async () => {
  // B1 regression: at home (no foreground project at all) a scoped request
  // used to die on the foreground's "no active pi process" even when the
  // target had a live background process. The target /c is NOT the foreground,
  // so availability must be probed against /c's own pi process. Fresh project
  // id: an earlier test's pi-exit marks /b's generation dead in handleEvent's
  // stale-event guard, which would silently drop the reply.
  projectDir.set("");
  lastProcByProject.set({ "/a": 1, "/c": 3 });
  vi.mocked(api.piRequest)
    .mockResolvedValueOnce({ success: true, data: { commands: [{ ...COMPANION_CMD }] } })
    .mockResolvedValueOnce({ success: true });
  const pending = mgmtRequest("ping", {}, undefined, { project: "/c", proc: 3 });
  await untilCalls(2);
  const [probe, send] = vi.mocked(api.piRequest).mock.calls;
  expect(probe[0]).toEqual({ type: "get_commands" });
  expect(probe[2]).toBe("/c");
  expect(probe[3]).toBe(3);
  expect((send[0] as { type: string }).type).toBe("prompt");
  expect(send[2]).toBe("/c");
  expect(send[3]).toBe(3);
  handleEvent(
    { type: "extension_ui_request", method: "notify", message: "LeftlegMgmt:" + JSON.stringify({ id: replyPayload(1).id, ok: true, data: { answer: 7 } }) },
    { project: "/c", proc: 3 },
  );
  await expect(pending).resolves.toEqual({ answer: 7 });
});

it("a background target without the companion command is gated by its own process, not the foreground's", async () => {
  // The foreground list (beforeEach) carries a valid companion; it must not
  // vouch for /c. The probe asks /c, gets nothing, and no prompt is sent.
  lastProcByProject.set({ "/a": 1, "/c": 3 });
  vi.mocked(api.piRequest).mockResolvedValue({ success: true, data: { commands: [] } });
  await expect(mgmtRequest("ping", {}, undefined, { project: "/c", proc: 3 })).rejects.toThrow("Settings companion unavailable");
  expect(api.piRequest).toHaveBeenCalledTimes(1);
});

it("a background target serving settings-mgmt as a prompt template is refused", async () => {
  // The prompt-template spoof against the target's own surface: the JSON must
  // never be expanded as a model prompt there either.
  lastProcByProject.set({ "/a": 1, "/c": 3 });
  vi.mocked(api.piRequest).mockResolvedValue({
    success: true,
    data: { commands: [{ name: "settings-mgmt", source: "prompt", sourceInfo: { path: "C:\\proj\\.pi\\prompts\\settings-mgmt.md" } }] },
  });
  await expect(mgmtRequest("ping", {}, undefined, { project: "/c", proc: 3 })).rejects.toThrow("Settings companion unavailable");
  expect(api.piRequest).toHaveBeenCalledTimes(1);
});

it("a form bound to an explicit target stays on that target across foreground switches", async () => {
  lastProcByProject.set({ "/a": 1, "/c": 3, "/d": 9 });
  vi.mocked(api.piRequest)
    .mockResolvedValueOnce({ success: true, data: { commands: [{ ...COMPANION_CMD }] } })
    .mockResolvedValueOnce({ success: true });
  const request = bindManagement({ project: "/c", proc: 3 });
  projectDir.set("/d"); // a foreground switch must not redirect a bound form
  const pending = request("ping");
  await untilCalls(2);
  expect(vi.mocked(api.piRequest).mock.calls[1][2]).toBe("/c");
  handleEvent(
    { type: "extension_ui_request", method: "notify", message: "LeftlegMgmt:" + JSON.stringify({ id: replyPayload(1).id, ok: true, data: { answer: 9 } }) },
    { project: "/c", proc: 3 },
  );
  await expect(pending).resolves.toEqual({ answer: 9 });
});

it("a form bound to an explicit target rejects after that target's process is replaced", async () => {
  const request = bindManagement({ project: "/b", proc: 2 });
  recordProcess("/b", 5);
  await expect(request("write")).rejects.toThrow("Project or process changed");
  expect(api.piRequest).not.toHaveBeenCalled();
});

it("an explicit target with no live pi process is refused instead of misrouted", async () => {
  lastProcByProject.set({ "/a": 1 }); // "/gone" has no process
  await expect(mgmtRequest("ping", {}, undefined, { project: "/gone" })).rejects.toThrow("no active pi process");
  expect(api.piRequest).not.toHaveBeenCalled();
});

// setManagementScope: the workspace hands its target to bare bindManagement()
// forms (PackageForms), which must obey the same contract as explicit binds.
it("a bare-bound form rides the workspace scope when one is set", async () => {
  lastProcByProject.set({ "/a": 1, "/c": 3, "/d": 9 });
  setManagementScope({ project: "/c", proc: 3 });
  const request = bindManagement(); // PackageForms' bare bind
  projectDir.set("/d"); // a foreground switch must not retarget a scoped bare form
  vi.mocked(api.piRequest)
    .mockResolvedValueOnce({ success: true, data: { commands: [{ ...COMPANION_CMD }] } })
    .mockResolvedValueOnce({ success: true });
  const pending = request("ping");
  await untilCalls(2);
  expect(vi.mocked(api.piRequest).mock.calls[1][2]).toBe("/c");
  expect(vi.mocked(api.piRequest).mock.calls[1][3]).toBe(3);
  handleEvent(
    { type: "extension_ui_request", method: "notify", message: "LeftlegMgmt:" + JSON.stringify({ id: replyPayload(1).id, ok: true, data: { answer: 9 } }) },
    { project: "/c", proc: 3 },
  );
  await expect(pending).resolves.toEqual({ answer: 9 });
});

it("with no scope set, a bare bind is exactly today's foreground bind", async () => {
  const pending = bindManagement()("ping");
  await untilSent();
  expect(vi.mocked(api.piRequest).mock.calls[0][2]).toBe("/a");
  await reply();
  await expect(pending).resolves.toEqual({ answer: 42 });
});

it("a scope set after a bare bind does not retarget the mounted form", async () => {
  // Capture-at-bind: the keyed remount is the retarget mechanism, never a
  // scope write under a live form.
  const request = bindManagement(); // binds the foreground: /a
  setManagementScope({ project: "/c", proc: 3 });
  const pending = request("ping");
  await untilSent();
  expect(vi.mocked(api.piRequest).mock.calls[0][2]).toBe("/a");
  await reply();
  await expect(pending).resolves.toEqual({ answer: 42 });
});

it("clearing with the set handle restores the foreground bind", async () => {
  const scope = { project: "/c", proc: 3 };
  setManagementScope(scope);
  clearManagementScope(scope);
  const pending = bindManagement()("ping");
  await untilSent();
  expect(vi.mocked(api.piRequest).mock.calls[0][2]).toBe("/a");
  await reply();
  await expect(pending).resolves.toEqual({ answer: 42 });
});

it("a stale destroy cannot drop a remounted workspace's fresh scope", async () => {
  // The old workspace's onDestroy may fire after the fresh workspace's set;
  // the clear only drops the exact object it was handed (identity, not
  // fields). stale and fresh are DISTINCT objects with IDENTICAL fields —
  // clearing the stale identity must not clear the live scope, so a
  // structurally-comparing implementation would fail this test.
  const stale = { project: "/c", proc: 3 };
  const fresh = { project: "/c", proc: 3 };
  setManagementScope(stale);
  setManagementScope(fresh);
  clearManagementScope(stale); // stale identity, same fields as the live scope
  lastProcByProject.set({ "/a": 1, "/c": 3, "/d": 9 });
  const request = bindManagement();
  projectDir.set("/d");
  vi.mocked(api.piRequest)
    .mockResolvedValueOnce({ success: true, data: { commands: [{ ...COMPANION_CMD }] } })
    .mockResolvedValueOnce({ success: true });
  const pending = request("ping");
  await untilCalls(2);
  // had the stale clear won, this bind would have captured /d and ridden it
  expect(vi.mocked(api.piRequest).mock.calls[1][2]).toBe("/c");
  handleEvent(
    { type: "extension_ui_request", method: "notify", message: "LeftlegMgmt:" + JSON.stringify({ id: replyPayload(1).id, ok: true, data: { answer: 9 } }) },
    { project: "/c", proc: 3 },
  );
  await expect(pending).resolves.toEqual({ answer: 9 });
});

it("a bare-bound form rejects after its scoped target's process is replaced", async () => {
  setManagementScope({ project: "/b", proc: 2 });
  const request = bindManagement();
  recordProcess("/b", 5);
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

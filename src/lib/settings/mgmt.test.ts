import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { get } from "svelte/store";
vi.mock("../api", () => ({ piRequest: vi.fn(), piSend: vi.fn(), listSessions: vi.fn().mockResolvedValue([]) }));
import * as api from "../api";
import { commands, projectDir, lastProcByProject, handleEvent, handlePiExit, notifications, recordProcess } from "../stores";
import { mgmtRequest, abortPendingMgmt, bindManagement } from "./mgmt";
beforeEach(() => {
  vi.useFakeTimers();
  projectDir.set("/a"); lastProcByProject.set({ "/a": 1, "/b": 2 });
  commands.set([{ name: "settings-mgmt" }]); notifications.set([]);
  vi.mocked(api.piRequest).mockReset().mockResolvedValue({ success: true });
});
afterEach(() => { abortPendingMgmt("test cleanup"); vi.useRealTimers(); });
function reply(ok = true, project = "/a", proc = 1) {
  const command = vi.mocked(api.piRequest).mock.calls[0][0];
  const payload = JSON.parse(String(command.message).slice("/settings-mgmt ".length));
  return handleEvent({ type: "extension_ui_request", method: "notify", message: "LeftlegMgmt:" + JSON.stringify({ id: payload.id, ok, data: { answer: 42 }, error: "nope" }) }, { project, proc });
}
it("routes replies after the requesting project goes into the background", async () => {
  const pending = mgmtRequest("ping");
  projectDir.set("/b");
  await reply();
  await expect(pending).resolves.toEqual({ answer: 42 });
  expect(get(notifications)).toEqual([]);
  expect(vi.mocked(api.piRequest).mock.calls[0][2]).toBe("/a");
});
it("does not abort one project's request when another process exits", async () => {
  const pending = mgmtRequest("ping");
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
  await reply(false);
  await result;
});
it("rejects pending requests on process replacement", async () => {
  const result = expect(mgmtRequest("ping")).rejects.toThrow("replaced");
  recordProcess("/a", 3);
  await result;
});
it("bound forms cannot save to a different project", async () => {
  const request = bindManagement();
  projectDir.set("/b");
  await expect(request("write")).rejects.toThrow("Project or process changed");
  expect(api.piRequest).not.toHaveBeenCalled();
});

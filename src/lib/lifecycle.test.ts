import { beforeEach, expect, it, vi } from "vitest";
import { get } from "svelte/store";
vi.mock("./api", () => ({
  piRequest: vi.fn(),
  piSend: vi.fn().mockResolvedValue(undefined),
  listSessions: vi.fn().mockResolvedValue([]),
}));
import * as api from "./api";
import {
  projectDir,
  recordProcess,
  rpcState,
  refreshRpcState,
  handleEvent,
  handlePiExit,
  extDialog,
  respondToExtDialog,
  statusNote,
  setModel,
  items,
  streaming,
  retryFailedUser,
  connected,
  reloadMessages,
} from "./stores";
beforeEach(() => {
  vi.mocked(api.piRequest).mockReset().mockResolvedValue({ success: true, data: {} });
  vi.mocked(api.piSend).mockClear();
  projectDir.set("/a");
  recordProcess("/a", 1);
  rpcState.set(null);
  extDialog.set(null);
  items.set([]);
  streaming.set(false);
  statusNote.set("");
  connected.set(true);
});
it("a delayed get_state cannot overwrite another project's identity", async () => {
  let resolve!: (data: unknown) => void;
  vi.mocked(api.piRequest).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const result = expect(refreshRpcState()).rejects.toThrow("View changed");
  projectDir.set("/b");
  recordProcess("/b", 2);
  resolve({ success: true, data: { sessionFile: "/a/session.jsonl" } });
  await result;
  expect(get(rpcState)).toBeNull();
});
it("a stale state snapshot cannot reverse a newer agent_start", async () => {
  let resolve!: (data: unknown) => void;
  vi.mocked(api.piRequest).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = refreshRpcState();
  await handleEvent({ type: "agent_start" });
  resolve({ success: true, data: { isStreaming: false } });
  await pending;
  expect(get(streaming)).toBe(true);
});
it("queues extension dialogs and targets responses to their originating process", async () => {
  for (const id of ["first", "second"])
    await handleEvent(
      { type: "extension_ui_request", method: "confirm", id },
      { project: "/a", proc: 1 },
    );
  expect(get(extDialog)?.id).toBe("first");
  await respondToExtDialog({ confirmed: true });
  expect(api.piSend).toHaveBeenCalledWith(
    { type: "extension_ui_response", id: "first", confirmed: true },
    "/a",
    1,
  );
  expect(get(extDialog)?.id).toBe("second");
});
it("drops late events after process death", async () => {
  handlePiExit("/a", 1, false);
  await handleEvent({ type: "agent_start" }, { project: "/a", proc: 1 });
  expect(get(streaming)).toBe(false);
});
it("reports rejected model changes", async () => {
  vi.mocked(api.piRequest).mockResolvedValueOnce({ success: false, error: "Model unavailable" });
  await setModel("provider", "missing");
  expect(get(statusNote)).toContain("Model unavailable");
});
it("retains a failed message when retrying while disconnected", async () => {
  connected.set(false);
  items.set([{ kind: "user", id: "retry", text: "keep", images: [], status: "failed" }]);
  expect((await retryFailedUser("retry")).ok).toBe(false);
  expect(get(items)).toHaveLength(1);
});
it("does not overwrite new streaming events with an older history snapshot", async () => {
  let resolve!: (data: unknown) => void;
  vi.mocked(api.piRequest).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = reloadMessages();
  await handleEvent({ type: "agent_start" });
  await handleEvent({ type: "message_start", message: { role: "assistant" } });
  resolve({ success: true, data: { messages: [] } });
  await pending;
  expect(get(items)).toHaveLength(1);
});
it("surfaces the native startup diagnostic when Pi exits", () => {
  handlePiExit("/a", 1, false, "pi exited before responding: Error: EISDIR");
  expect(get(statusNote)).toContain("Error: EISDIR");
  expect(get(connected)).toBe(false);
});
it("stays working between an errored turn and its automatic retry", async () => {
  await handleEvent({ type: "agent_start" });
  await handleEvent({ type: "agent_end", willRetry: true });
  expect(get(streaming)).toBe(true);
  await handleEvent({ type: "agent_settled" });
  expect(get(streaming)).toBe(false);
});

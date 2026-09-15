import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

const mocks = vi.hoisted(() => ({
  piRequest: vi.fn(),
  piModuleInfo: vi.fn().mockResolvedValue({ name: "pi", version: "1", path: "/pi" }),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, piRequest: mocks.piRequest, piModuleInfo: mocks.piModuleInfo };
});

import StatusCard from "./StatusCard.svelte";
import { activeSessionPath, lastProcByProject, projectDir } from "../lib/stores";

let instance: ReturnType<typeof mount> | null = null;

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

function todoMessage(subject: string) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", name: "todo", arguments: { tasks: [{ key: subject, status: "pending", subject }] } }],
  };
}

beforeEach(() => {
  mocks.piRequest.mockReset();
  projectDir.set("/a");
  activeSessionPath.set("/a/session.jsonl");
  lastProcByProject.set({ "/a": 7 });
});

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = null;
  document.body.replaceChildren();
});

describe("status card state ownership", () => {
  it("discards the loaded task list and rescans when the active session changes", async () => {
    mocks.piRequest
      .mockResolvedValueOnce({ success: true, data: { messages: [todoMessage("session A task")] } })
      .mockResolvedValueOnce({ success: true, data: { messages: [todoMessage("session B task")] } });
    instance = mount(StatusCard, { target: document.body });
    await vi.waitFor(() => expect(mocks.piRequest).toHaveBeenCalledTimes(1));
    await settle();
    expect(document.body.textContent).toContain("session A task");

    activeSessionPath.set("/a/another-session.jsonl");
    await vi.waitFor(() => expect(mocks.piRequest).toHaveBeenCalledTimes(2));
    await settle();
    expect(document.body.textContent).toContain("session B task");
    expect(document.body.textContent).not.toContain("session A task");
  });

  it("shows the last task update when an assistant message contains multiple todo calls", async () => {
    mocks.piRequest.mockResolvedValue({ success: true, data: { messages: [{
      role: "assistant", content: [...todoMessage("outdated task").content, ...todoMessage("current task").content],
    }] } });
    instance = mount(StatusCard, { target: document.body });
    await settle();
    expect(document.body.textContent).toContain("current task");
    expect(document.body.textContent).not.toContain("outdated task");
  });

  it("drops an older todo response that resolves after an owner change", async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    mocks.piRequest
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    instance = mount(StatusCard, { target: document.body });
    await vi.waitFor(() => expect(mocks.piRequest).toHaveBeenCalledWith(
      { type: "get_messages" }, 60, "/a", 7,
    ));

    activeSessionPath.set("/a/another-session.jsonl");
    await vi.waitFor(() => expect(mocks.piRequest).toHaveBeenCalledTimes(2));
    resolveNew({ success: true, data: { messages: [todoMessage("new task")] } });
    await settle();
    resolveOld({ success: true, data: { messages: [todoMessage("old task")] } });
    await settle();

    expect(document.body.textContent).toContain("new task");
    expect(document.body.textContent).not.toContain("old task");
  });
});

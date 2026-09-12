import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import type { AgentMessage, AssistantItem, PiEvent, ToolItem } from "./types";

vi.mock("./api", () => ({
  piRequest: vi.fn().mockResolvedValue({ success: true, data: {} }),
  piSend: vi.fn().mockResolvedValue(undefined),
  piStart: vi.fn().mockResolvedValue(undefined),
  piStop: vi.fn().mockResolvedValue(undefined),
  piStatus: vi.fn().mockResolvedValue(false),
  listSessions: vi.fn().mockResolvedValue([]),
  readGuiState: vi.fn().mockResolvedValue({}),
  writeGuiState: vi.fn().mockResolvedValue(undefined),
  readFileBase64: vi.fn().mockResolvedValue(""),
  getAgentDir: vi.fn().mockResolvedValue(""),
}));

import * as api from "./api";
import {
  activeSessionPath, connected, extDialog, handleEvent, items, newSession, projectDir,
  queue, rebuildFromMessages, rpcState, sessionStates, sendPrompt, stats, statusNote, streaming,
} from "./stores";

function resetStores() {
  items.set([]);
  streaming.set(false);
  queue.set({ steering: [], followUp: [] });
  sessionStates.set({});
  stats.set(null);
  rpcState.set(null);
  activeSessionPath.set(null);
  statusNote.set("");
  extDialog.set(null);
  connected.set(false);
  projectDir.set("");
}

beforeEach(async () => {
  resetStores();
  vi.mocked(api.piRequest).mockClear();
  // clear any module-private streaming assistant left over from a previous test
  await handleEvent({ type: "agent_settled" });
});

describe("handleEvent: streaming lifecycle", () => {
  it("agent_start/end toggles streaming and the session status", async () => {
    activeSessionPath.set("/s1");
    await handleEvent({ type: "agent_start" });
    expect(get(streaming)).toBe(true);
    expect(get(sessionStates)["/s1"]).toEqual({ status: "active", note: "working" });

    await handleEvent({ type: "agent_end" });
    expect(get(streaming)).toBe(false);
    expect(get(sessionStates)["/s1"]).toEqual({ status: "idle", note: "" });
  });

  it("ignores status changes when no session is active", async () => {
    await handleEvent({ type: "agent_start" });
    expect(get(sessionStates)).toEqual({});
  });

  it("accumulates text deltas into the streaming assistant item", async () => {
    await handleEvent({ type: "message_start", message: { role: "assistant" } });
    await handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    await handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } });
    await handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } });

    const item = get(items)[0] as AssistantItem;
    expect(item.kind).toBe("assistant");
    expect(item.streaming).toBe(true);
    expect(item.blocks[0]).toEqual({ type: "text", text: "Hello", done: false });
  });

  it("finalizes the item from the authoritative message on message_end", async () => {
    await handleEvent({ type: "message_start", message: { role: "assistant" } });
    await handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    await handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "part" } });

    await handleEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "the final answer" }] },
    });

    const item = get(items)[0] as AssistantItem;
    expect(item.blocks).toEqual([{ type: "text", text: "the final answer", done: true }]);
    expect(item.streaming).toBe(false);
  });

  it("marks the session 'attention' when a message ends with an error stopReason", async () => {
    activeSessionPath.set("/s1");
    await handleEvent({ type: "message_start", message: { role: "assistant" } });
    await handleEvent({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
    });

    const item = get(items)[0] as AssistantItem;
    expect(item.stopReason).toBe("error");
    expect(item.errorMessage).toBe("boom");
    expect(get(sessionStates)["/s1"]).toEqual({ status: "attention", note: "error in response" });
  });

  it("regression: agent_settled finalizes dangling streaming blocks (toolcall blocks must not crash)", async () => {
    await handleEvent({ type: "message_start", message: { role: "assistant" } });
    await handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    await handleEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", id: "tc1", toolName: "bash" } });

    await handleEvent({ type: "agent_settled" });

    const assistant = get(items).find((x) => x.kind === "assistant") as AssistantItem;
    const text = assistant.blocks.find((b) => b.type === "text");
    expect(text && text.type === "text" && text.done).toBe(true);
    expect(assistant.streaming).toBe(false);
  });

  it("triggers a stats refresh when the final message carries usage", async () => {
    await handleEvent({ type: "message_start", message: { role: "assistant" } });
    await handleEvent({
      type: "message_end",
      message: { role: "assistant", content: [], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 } },
    });
    await vi.waitFor(() => {
      expect(vi.mocked(api.piRequest)).toHaveBeenCalledWith({ type: "get_session_stats" }, 30);
    });
  });
});

describe("handleEvent: tool lifecycle", () => {
  async function startToolCall(id: string, name: string) {
    await handleEvent({ type: "message_start", message: { role: "assistant" } });
    await handleEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", id, toolName: name } });
  }

  it("creates a running tool item on toolcall_start and fills args on toolcall_end", async () => {
    await startToolCall("tc1", "tool");
    await handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_end", toolCall: { id: "tc1", name: "read", arguments: { path: "a.txt" } } },
    });

    const tool = get(items).find((x) => x.kind === "tool") as ToolItem;
    expect(tool.name).toBe("read");
    expect(tool.status).toBe("running");
    expect(JSON.parse(tool.args)).toEqual({ path: "a.txt" });
  });

  it("tracks execution start → output → end", async () => {
    await startToolCall("tc1", "bash");
    await handleEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { cmd: "ls" } });
    await handleEvent({ type: "tool_execution_end", toolCallId: "tc1", isError: false, result: { content: [{ type: "text", text: "out.txt" }] } });

    const tool = get(items).find((x) => x.kind === "tool") as ToolItem;
    expect(tool.status).toBe("done");
    expect(tool.isError).toBe(false);
    expect(tool.output).toBe("out.txt");
  });

  it("marks errored tool results", async () => {
    await startToolCall("tc1", "bash");
    await handleEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: {} });
    await handleEvent({ type: "tool_execution_end", toolCallId: "tc1", isError: true, result: { content: [{ type: "text", text: "nope" }] } });

    const tool = get(items).find((x) => x.kind === "tool") as ToolItem;
    expect(tool.status).toBe("error");
    expect(tool.isError).toBe(true);
  });

  it("updates partial output while running", async () => {
    await startToolCall("tc1", "bash");
    await handleEvent({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: {} });
    await handleEvent({ type: "tool_execution_update", toolCallId: "tc1", partialResult: { content: [{ type: "text", text: "partial" }] } });

    const tool = get(items).find((x) => x.kind === "tool") as ToolItem;
    expect(tool.output).toBe("partial");
    expect(tool.status).toBe("running");
  });

  it("ignores updates for unknown tool ids", async () => {
    await handleEvent({ type: "tool_execution_update", toolCallId: "ghost", partialResult: { content: [] } });
    expect(get(items)).toEqual([]);
  });
});

describe("handleEvent: misc events", () => {
  it("queue_update mirrors steering/follow-up queues", async () => {
    await handleEvent({ type: "queue_update", steering: ["s1"], followUp: ["f1", "f2"] } as never);
    expect(get(queue)).toEqual({ steering: ["s1"], followUp: ["f1", "f2"] });
  });

  it("compaction events set and auto-clear the status note", async () => {
    vi.useFakeTimers();
    try {
      await handleEvent({ type: "compaction_start" });
      expect(get(statusNote)).toContain("Compacting");

      await handleEvent({ type: "compaction_end", result: { tokensBefore: 100, estimatedTokensAfter: 40 } });
      expect(get(statusNote)).toBe("Compacted: 100 → 40 tokens");

      vi.advanceTimersByTime(6000);
      expect(get(statusNote)).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("extension_ui_request opens the dialog for interactive methods only", async () => {
    await handleEvent({
      type: "extension_ui_request",
      id: "e1", method: "select", title: "Pick", options: ["a", "b"], message: "choose one",
    } as never);
    const d = get(extDialog);
    expect(d).toMatchObject({ id: "e1", method: "select", title: "Pick", options: ["a", "b"], message: "choose one" });

    await handleEvent({ type: "extension_ui_request", id: "e2", method: "setTitle", title: "x" } as never);
    expect(get(extDialog)).toMatchObject({ id: "e1" }); // unchanged — setTitle is fire-and-forget
  });

  it("extension_error flags the session", async () => {
    activeSessionPath.set("/s1");
    await handleEvent({ type: "extension_error" });
    expect(get(sessionStates)["/s1"]).toEqual({ status: "attention", note: "extension error" });
  });
});

describe("sendPrompt", () => {
  it("is blocked with a status note when disconnected", async () => {
    await sendPrompt("hi", []);
    expect(get(statusNote)).toContain("Pick a project folder");
    expect(vi.mocked(api.piRequest)).not.toHaveBeenCalled();
  });

  it("sends a steer command while streaming and pushes an optimistic bubble", async () => {
    connected.set(true);
    projectDir.set("/proj");
    streaming.set(true);

    await sendPrompt("do it", []);

    const [cmd] = vi.mocked(api.piRequest).mock.calls[0];
    expect(cmd).toMatchObject({ type: "prompt", message: "do it", streamingBehavior: "steer" });
    expect(get(items)[0]).toMatchObject({ kind: "user", text: "do it" });
  });

  it("attaches images as base64 payloads", async () => {
    connected.set(true);
    projectDir.set("/proj");

    await sendPrompt("look", [{ data: "QUJD", mimeType: "image/png", name: "x.png" }]);

    const [cmd] = vi.mocked(api.piRequest).mock.calls[0];
    expect(cmd).toMatchObject({
      type: "prompt",
      message: "look",
      images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
    });
  });
});

describe("rebuildFromMessages", () => {
  it("rebuilds the item list and pairs tool results with their calls", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "please run ls" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running it" },
          { type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } },
        ],
        stopReason: "toolUse",
      },
      { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "file.txt" }], isError: false },
    ];

    rebuildFromMessages(msgs);

    const list = get(items);
    expect(list.map((x) => x.kind)).toEqual(["user", "assistant", "tool"]);
    const tool = list[2] as ToolItem;
    expect(tool.status).toBe("done");
    expect(tool.output).toContain("file.txt");
    const assistant = list[1] as AssistantItem;
    expect(assistant.blocks.map((b) => b.type)).toEqual(["text", "toolcall"]);
  });

  it("inlines normal images as data urls", () => {
    rebuildFromMessages([
      { role: "user", content: "pic", attachments: [{ type: "image", content: "QUJD", fileName: "x.png", mimeType: "image/png" }] },
    ]);
    const [u] = get(items) as Array<{ images: Array<{ dataUrl: string; name: string }> }>;
    expect(u.images[0].dataUrl).toBe("data:image/png;base64,QUJD");
    expect(u.images[0].name).toBe("x.png");
  });

  it("strips oversized images into a chip", () => {
    rebuildFromMessages([
      { role: "user", content: "pic", attachments: [{ type: "image", content: "A".repeat(1_500_001), fileName: "big.png", mimeType: "image/png" }] },
    ]);
    const [u] = get(items) as Array<{ images: Array<{ dataUrl: string; name: string }> }>;
    expect(u.images[0].dataUrl).toBe("");
    expect(u.images[0].name).toContain("too large to preview");
  });

  it("renders bash executions with error state from exit code", () => {
    rebuildFromMessages([{ role: "bashExecution", command: "ls", output: "boom", exitCode: 1 } as never]);
    const [b] = get(items) as Array<{ kind: string; command: string; output: string; isError: boolean }>;
    expect(b).toMatchObject({ kind: "bash", command: "ls", output: "boom", isError: true });
  });
});

describe("newSession", () => {
  // keep this describe last: it overrides the shared piRequest mock resolution
  it("pins the default GLM model on fresh sessions", async () => {
    vi.mocked(api.piRequest).mockResolvedValue({ success: true, data: {} } as never);

    await newSession();

    const calls = vi.mocked(api.piRequest).mock.calls;
    const setModelCall = calls.find(([c]) => (c as { type: string }).type === "set_model");
    expect(setModelCall?.[0]).toMatchObject({ provider: "openrouter", modelId: "z-ai/glm-5.3-flash" });
  });

  it("skips the model switch when already on the default model", async () => {
    vi.mocked(api.piRequest).mockResolvedValue({
      success: true,
      data: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } },
    } as never);

    await newSession();

    const types = vi.mocked(api.piRequest).mock.calls.map(([c]) => (c as { type: string }).type);
    expect(types).not.toContain("set_model");
  });
});

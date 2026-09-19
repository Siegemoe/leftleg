import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import type { AgentMessage, AssistantItem, ToolItem } from "./types";

vi.mock("./api", () => ({
  piRequest: vi.fn().mockResolvedValue({ success: true, data: {} }),
  piSend: vi.fn().mockResolvedValue(undefined),
  piStart: vi.fn().mockResolvedValue(undefined),
  piStop: vi.fn().mockResolvedValue(undefined),
  piStatus: vi.fn().mockResolvedValue(false),
  listSessions: vi.fn().mockResolvedValue([]),
  readGuiState: vi.fn().mockResolvedValue({}),
  writeGuiState: vi.fn().mockResolvedValue(undefined),
  pickAttachments: vi.fn().mockResolvedValue([]),
  pickAndCreateProject: vi.fn().mockResolvedValue(null),
  openPathLocal: vi.fn().mockResolvedValue(undefined),
  getAgentDir: vi.fn().mockResolvedValue(""),
  pendingGuiWriteCount: vi.fn().mockReturnValue(0),
}));

// stores.ts pulls the native save dialog directly from the plugin; pin it so
// exportSessionHtml's dialog usage is assertable without a Tauri runtime.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));

import * as api from "./api";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  activeSessionByProject,
  activeSessionPath,
  compact,
  connected,
  createProject,
  exportSessionHtml,
  extDialog,
  forgetProject,
  goHome,
  handleEvent,
  homePanelCollapsed,
  items,
  newProjectOpen,
  newSession,
  openRightPanel,
  projectDir,
  projectMeta,
  projectScope,
  queue,
  rebuildFromMessages,
  refreshStats,
  restartPi,
  rightPanelOpen,
  rightPanelTab,
  rpcState,
  sessionStates,
  sendPrompt,
  sessions,
  stats,
  statusNote,
  streaming,
  switchToProject,
  collectUpdateInstallBlockers,
  handlePiExit,
  recordProcess,
  updateInstallLock,
} from "./stores";
import { composerDraftFor } from "./composer-drafts";

function resetStores() {
  items.set([]);
  streaming.set(false);
  queue.set({ steering: [], followUp: [] });
  sessionStates.set({});
  stats.set(null);
  rpcState.set(null);
  activeSessionPath.set(null);
  activeSessionByProject.set({});
  sessions.set([]);
  statusNote.set("");
  extDialog.set(null);
  connected.set(false);
  projectDir.set("");
  projectScope.set(null);
  projectMeta.set({});
  updateInstallLock.set(false);
}

beforeEach(async () => {
  resetStores();
  vi.mocked(api.piRequest).mockClear();
  // clear any module-private streaming assistant left over from a previous test
  await handleEvent({ type: "agent_settled" });
});

describe("update install safety", () => {
  it("reports background work and unsent drafts, not only the visible stream", async () => {
    projectDir.set("C:\\work\\front");
    recordProcess("C:\\work\\front", 1);
    recordProcess("C:\\work\\background", 2);
    await handleEvent({ type: "agent_start" }, { project: "C:\\work\\background", proc: 2 });
    const draft = composerDraftFor("C:\\work\\front:session.jsonl");
    draft.set({ text: "do not lose this", sending: false, lastExtensionNonce: 0, attachments: [] });

    const blockers = collectUpdateInstallBlockers();

    expect(
      blockers.some((message) => message.includes("background has an active agent turn")),
    ).toBe(true);
    expect(blockers.some((message) => message.includes("unsent text"))).toBe(true);
    draft.set({ text: "", sending: false, lastExtensionNonce: 0, attachments: [] });
    handlePiExit("C:\\work\\background", 2, true);
  });

  it("rejects a prompt after the final update lock is taken", async () => {
    connected.set(true);
    projectDir.set("C:\\work\\front");
    updateInstallLock.set(true);

    expect(await sendPrompt("too late", [])).toEqual({
      ok: false,
      error: "Update installation is preparing",
    });
    expect(vi.mocked(api.piRequest)).not.toHaveBeenCalled();
  });
});

describe("createProject", () => {
  it("creates the folder, closes the card, and lands in the new project", async () => {
    newProjectOpen.set(true);
    vi.mocked(api.pickAndCreateProject).mockResolvedValue("/work/created");
    vi.mocked(api.piStart).mockResolvedValueOnce(11);
    vi.mocked(api.piRequest).mockResolvedValue({ success: true, data: {} } as never);

    const created = await createProject("created");

    expect(created).toBe("/work/created");
    expect(get(newProjectOpen)).toBe(false);
    expect(get(projectDir)).toBe("/work/created");
  });

  it("resolves null on a cancelled folder dialog and leaves the card open", async () => {
    newProjectOpen.set(true);
    vi.mocked(api.pickAndCreateProject).mockResolvedValue(null);

    expect(await createProject("created")).toBe(null);
    expect(get(newProjectOpen)).toBe(true);
    expect(get(projectDir)).toBe("");
  });
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
    await handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    await handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
    });
    await handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
    });

    const item = get(items)[0] as AssistantItem;
    expect(item.kind).toBe("assistant");
    expect(item.streaming).toBe(true);
    expect(item.blocks[0]).toEqual({ type: "text", text: "Hello", done: false });
  });

  it("finalizes the item from the authoritative message on message_end", async () => {
    await handleEvent({ type: "message_start", message: { role: "assistant" } });
    await handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    await handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "part" },
    });

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
    await handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    await handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", id: "tc1", toolName: "bash" },
    });

    await handleEvent({ type: "agent_settled" });

    const assistant = get(items).find((x) => x.kind === "assistant") as AssistantItem;
    const text = assistant.blocks.find((b) => b.type === "text");
    expect(text && text.type === "text" && text.done).toBe(true);
    expect(assistant.streaming).toBe(false);
  });

  it("triggers a stats refresh when the final message carries usage", async () => {
    // A foreground event belongs to the open project — requestForView refuses
    // to fire without one, so the refresh must target a real project dir.
    projectDir.set("/proj");
    await handleEvent({ type: "message_start", message: { role: "assistant" } });
    await handleEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
      },
    });
    await vi.waitFor(() => {
      expect(vi.mocked(api.piRequest)).toHaveBeenCalledWith(
        { type: "get_session_stats" },
        30,
        "/proj",
        undefined,
      );
    });
  });

  it("keeps content indexes dense when text follows a tool call", async () => {
    await handleEvent({ type: "message_start", message: { role: "assistant" } });
    await handleEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        id: "tc1",
        toolName: "read",
      },
    });
    await handleEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { id: "tc1", name: "read", arguments: { path: "a.txt" } },
      },
    });
    await handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
    });
    await handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Checking the file." },
    });
    const assistant = get(items)[0] as AssistantItem;
    const blocks = assistant.blocks;
    // Capture the interrupted-stream path too: it used to dereference a hole.
    const settled = handleEvent({ type: "agent_settled" });
    // Clean up even when the assertion fails, so this reproduction is isolated.
    await handleEvent({ type: "message_end", message: { role: "assistant", content: [] } });
    await expect(settled).resolves.toBeUndefined();
    expect(Array.from(blocks)).toEqual([
      {
        type: "toolcall",
        toolCallId: "tc1",
        name: "read",
        args: JSON.stringify({ path: "a.txt" }, null, 2),
      },
      { type: "text", text: "Checking the file.", done: true },
    ]);
  });
});

describe("handleEvent: tool lifecycle", () => {
  async function startToolCall(id: string, name: string) {
    await handleEvent({ type: "message_start", message: { role: "assistant" } });
    await handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", id, toolName: name },
    });
  }

  it("creates a running tool item on toolcall_start and fills args on toolcall_end", async () => {
    await startToolCall("tc1", "tool");
    await handleEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCall: { id: "tc1", name: "read", arguments: { path: "a.txt" } },
      },
    });

    const tool = get(items).find((x) => x.kind === "tool") as ToolItem;
    expect(tool.name).toBe("read");
    expect(tool.status).toBe("running");
    expect(JSON.parse(tool.args)).toEqual({ path: "a.txt" });
  });

  it("tracks execution start → output → end", async () => {
    await startToolCall("tc1", "bash");
    await handleEvent({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "bash",
      args: { cmd: "ls" },
    });
    await handleEvent({
      type: "tool_execution_end",
      toolCallId: "tc1",
      isError: false,
      result: { content: [{ type: "text", text: "out.txt" }] },
    });

    const tool = get(items).find((x) => x.kind === "tool") as ToolItem;
    expect(tool.status).toBe("done");
    expect(tool.isError).toBe(false);
    expect(tool.output).toBe("out.txt");
  });

  it("marks errored tool results", async () => {
    await startToolCall("tc1", "bash");
    await handleEvent({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "bash",
      args: {},
    });
    await handleEvent({
      type: "tool_execution_end",
      toolCallId: "tc1",
      isError: true,
      result: { content: [{ type: "text", text: "nope" }] },
    });

    const tool = get(items).find((x) => x.kind === "tool") as ToolItem;
    expect(tool.status).toBe("error");
    expect(tool.isError).toBe(true);
  });

  it("updates partial output while running", async () => {
    await startToolCall("tc1", "bash");
    await handleEvent({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "bash",
      args: {},
    });
    await handleEvent({
      type: "tool_execution_update",
      toolCallId: "tc1",
      partialResult: { content: [{ type: "text", text: "partial" }] },
    });

    const tool = get(items).find((x) => x.kind === "tool") as ToolItem;
    expect(tool.output).toBe("partial");
    expect(tool.status).toBe("running");
  });

  it("ignores updates for unknown tool ids", async () => {
    await handleEvent({
      type: "tool_execution_update",
      toolCallId: "ghost",
      partialResult: { content: [] },
    });
    expect(get(items)).toEqual([]);
  });
});

describe("rebuildFromMessages: timing derivation", () => {
  it.each([false, true])(
    "measures a live turn through completion (turn_start=%s)",
    async (hasTurnStart) => {
      vi.useFakeTimers();
      let displayedDuration: number | undefined;
      const unsubscribe = items.subscribe((value) => {
        displayedDuration = (
          value.find((item) => item.kind === "assistant") as AssistantItem | undefined
        )?.turnDurationMs;
      });
      try {
        vi.setSystemTime(1000);
        await handleEvent({ type: "agent_start" });
        if (hasTurnStart) await handleEvent({ type: "turn_start", timestamp: 1000 } as never);
        vi.setSystemTime(2000);
        await handleEvent({ type: "message_start", message: { role: "assistant" } });
        await handleEvent({
          type: "message_end",
          message: { role: "assistant", timestamp: 2000, content: [] },
        });
        vi.setSystemTime(16000);
        await handleEvent({ type: "agent_end" });
        const assistant = get(items).find((item) => item.kind === "assistant") as AssistantItem;
        expect(assistant.turnDurationMs).toBe(15000);
        expect(displayedDuration).toBe(15000);
      } finally {
        unsubscribe();
        vi.useRealTimers();
      }
    },
  );

  it("derives tool execution duration from call → result message timestamps", () => {
    rebuildFromMessages([
      {
        role: "assistant",
        timestamp: 1_000,
        content: [
          { type: "toolCall", id: "tc1", name: "image_generate", arguments: { prompt: "x" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tc1",
        timestamp: 16_500,
        content: [{ type: "text", text: "Saved 1 image (m):\\nC:\\i\\a.png" }],
      },
    ] as unknown as AgentMessage[]);
    const tool = get(items).find((x) => x.kind === "tool") as ToolItem;
    expect(tool.startedAt).toBe(1_000);
    expect(tool.endedAt).toBe(16_500);
    expect(tool.durationMs).toBe(15_500);
    expect(tool.status).toBe("done");
  });

  it("leaves duration unset when the call timestamp is missing", () => {
    rebuildFromMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc2", name: "bash", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "tc2",
        timestamp: 500,
        content: [{ type: "text", text: "ok" }],
      },
    ] as unknown as AgentMessage[]);
    const tool = get(items).find((x) => x.kind === "tool") as ToolItem;
    expect(tool.status).toBe("done");
    expect(tool.durationMs).toBeUndefined();
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

      await handleEvent({
        type: "compaction_end",
        result: { tokensBefore: 100, estimatedTokensAfter: 40 },
      });
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
      id: "e1",
      method: "select",
      title: "Pick",
      options: ["a", "b"],
      message: "choose one",
    } as never);
    const d = get(extDialog);
    expect(d).toMatchObject({
      id: "e1",
      method: "select",
      title: "Pick",
      options: ["a", "b"],
      message: "choose one",
    });

    await handleEvent({
      type: "extension_ui_request",
      id: "e2",
      method: "setTitle",
      title: "x",
    } as never);
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
      {
        role: "toolResult",
        toolCallId: "t1",
        content: [{ type: "text", text: "file.txt" }],
        isError: false,
      },
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
      {
        role: "user",
        content: "pic",
        attachments: [{ type: "image", content: "QUJD", fileName: "x.png", mimeType: "image/png" }],
      },
    ]);
    const [u] = get(items) as Array<{ images: Array<{ dataUrl: string; name: string }> }>;
    expect(u.images[0].dataUrl).toBe("data:image/png;base64,QUJD");
    expect(u.images[0].name).toBe("x.png");
  });

  it("restores images from Pi user content blocks", () => {
    rebuildFromMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this" },
          { type: "image", data: "QUJD", mimeType: "image/jpeg" },
        ],
      },
    ]);
    expect(get(items)[0]).toMatchObject({
      kind: "user",
      text: "Inspect this",
      images: [{ name: "image", dataUrl: "data:image/jpeg;base64,QUJD" }],
    });
  });

  it("limits previews for images in Pi content blocks", () => {
    rebuildFromMessages([
      {
        role: "user",
        content: [{ type: "image", data: "A".repeat(1_500_001), mimeType: "image/png" }],
      },
    ]);
    expect(get(items)[0]).toMatchObject({
      images: [{ dataUrl: "", name: expect.stringContaining("too large to preview") }],
    });
  });

  it("strips oversized images into a chip", () => {
    rebuildFromMessages([
      {
        role: "user",
        content: "pic",
        attachments: [
          {
            type: "image",
            content: "A".repeat(1_500_001),
            fileName: "big.png",
            mimeType: "image/png",
          },
        ],
      },
    ]);
    const [u] = get(items) as Array<{ images: Array<{ dataUrl: string; name: string }> }>;
    expect(u.images[0].dataUrl).toBe("");
    expect(u.images[0].name).toContain("too large to preview");
  });

  it("renders bash executions with error state from exit code", () => {
    rebuildFromMessages([
      { role: "bashExecution", command: "ls", output: "boom", exitCode: 1 } as never,
    ]);
    const [b] = get(items) as Array<{
      kind: string;
      command: string;
      output: string;
      isError: boolean;
    }>;
    expect(b).toMatchObject({ kind: "bash", command: "ls", output: "boom", isError: true });
  });
});

describe("start view guards", () => {
  it("goHome clears the view and switchToProject restores the panel and surface", async () => {
    projectDir.set("C:\\work\\roundtrip");
    recordProcess("C:\\work\\roundtrip", 11);
    const history = [{ kind: "user" as const, id: "u1", text: "hello", images: [] }];
    items.set(history);
    activeSessionPath.set("C:\\work\\roundtrip\\session.jsonl");
    homePanelCollapsed.set(false);
    connected.set(true);
    vi.mocked(api.piRequest).mockResolvedValue({ success: true, data: {} } as never);

    await goHome();

    expect(get(projectDir)).toBe("");
    expect(get(items)).toEqual([]);
    expect(get(activeSessionPath)).toBe(null);
    expect(get(homePanelCollapsed)).toBe(true);
    expect(get(connected)).toBe(false);

    // piStart refocuses the still-running background process (same pid), so
    // the saved surface comes back and the start-view collapse clears.
    vi.mocked(api.piStart).mockResolvedValueOnce(11);
    await switchToProject("C:\\work\\roundtrip");

    expect(get(projectDir)).toBe("C:\\work\\roundtrip");
    expect(get(connected)).toBe(true);
    expect(get(homePanelCollapsed)).toBe(false);
    expect(get(items).map((i) => i.kind)).toEqual(["user"]);
  });

  it("requestForView-routed actions cannot reach the background project at home", async () => {
    // Silent refresher: the guard rejects before any invoke, swallowed.
    await refreshStats();
    expect(vi.mocked(api.piRequest)).not.toHaveBeenCalled();
    // Surfacing action: rpcAction turns the guard into a visible note.
    await compact();
    expect(vi.mocked(api.piRequest)).not.toHaveBeenCalled();
    expect(get(statusNote)).toContain("No project is open");
  });

  it("openRightPanel opens the collapsed start-view panel instead of closing it", () => {
    homePanelCollapsed.set(true);
    rightPanelOpen.set(true);
    rightPanelTab.set("status");

    openRightPanel("status");

    expect(get(rightPanelOpen)).toBe(true);
    expect(get(rightPanelTab)).toBe("status");
    expect(get(homePanelCollapsed)).toBe(false);
  });

  it("openRightPanel toggles closed on the same tab when the panel is visible", () => {
    homePanelCollapsed.set(false);
    rightPanelOpen.set(true);
    rightPanelTab.set("artifacts");

    openRightPanel("artifacts");

    expect(get(rightPanelOpen)).toBe(false);
  });

  it("openRightPanel switches to a new tab at the start view", () => {
    homePanelCollapsed.set(true);
    rightPanelOpen.set(true);
    rightPanelTab.set("status");

    openRightPanel("files");

    expect(get(rightPanelTab)).toBe("files");
    expect(get(rightPanelOpen)).toBe(true);
    expect(get(homePanelCollapsed)).toBe(false);
  });

  it("newSession stands down at the start view without an rpc", async () => {
    await newSession();
    expect(vi.mocked(api.piRequest)).not.toHaveBeenCalled();
    expect(get(statusNote)).toContain("project");
  });
});

describe("handlePiExit: session chip on process death", () => {
  it("an unexpected foreground exit leaves no 'active'-rendering status on the session", () => {
    projectDir.set("C:\\work\\front");
    recordProcess("C:\\work\\front", 1);
    activeSessionPath.set("/s1.jsonl");
    sessionStates.set({ "/s1.jsonl": { status: "active", note: "working" } });

    handlePiExit("C:\\work\\front", 1, false);

    // "Needs attention" instead of the pulsing Working chip.
    expect(get(sessionStates)["/s1.jsonl"]).toEqual({
      status: "attention",
      note: "process exited",
    });
  });

  it("an expected background exit settles the owning session's chip too", () => {
    projectDir.set("C:\\work\\front");
    recordProcess("C:\\work\\front", 1);
    recordProcess("C:\\work\\bg", 2);
    activeSessionByProject.set({ "C:\\work\\bg": "/bg.jsonl" });
    sessionStates.set({ "/bg.jsonl": { status: "active", note: "working" } });

    handlePiExit("C:\\work\\bg", 2, true);

    // idle (with an empty note) renders no Working chip (resolveThreadPill).
    expect(get(sessionStates)["/bg.jsonl"]).toEqual({ status: "idle", note: "" });
  });

  // Session → project mapping for the exit sweep.
  function sessionInfo(path: string, cwd: string) {
    return {
      path,
      cwd,
      timestamp: "",
      fileModified: 0,
      sessionId: path,
      name: null,
      firstMessage: null,
    };
  }

  it("settles a session switched away from mid-turn on an expected exit, leaving the current one alone", async () => {
    projectDir.set("C:\\work\\front");
    recordProcess("C:\\work\\front", 1);
    sessions.set([
      sessionInfo("/a.jsonl", "C:\\work\\front"),
      sessionInfo("/b.jsonl", "C:\\work\\front"),
    ]);
    activeSessionPath.set("/a.jsonl");
    await handleEvent({ type: "agent_start" }); // real path: A reads active/working
    expect(get(sessionStates)["/a.jsonl"]).toEqual({ status: "active", note: "working" });
    activeSessionPath.set("/b.jsonl"); // user switches mid-turn; pi now owns B

    handlePiExit("C:\\work\\front", 1, true);

    // The process is dead — no future agent_end can settle A, which pi no
    // longer has active; the sweep must catch it. B was never running.
    expect(get(sessionStates)["/a.jsonl"]).toEqual({ status: "idle", note: "" });
    expect(get(sessionStates)["/b.jsonl"]).toBeUndefined();
  });

  it("flags a session switched away from mid-turn on an unexpected exit", async () => {
    projectDir.set("C:\\work\\front");
    recordProcess("C:\\work\\front", 1);
    sessions.set([
      sessionInfo("/a.jsonl", "C:\\work\\front"),
      sessionInfo("/b.jsonl", "C:\\work\\front"),
    ]);
    activeSessionPath.set("/a.jsonl");
    await handleEvent({ type: "agent_start" });
    activeSessionPath.set("/b.jsonl");

    handlePiExit("C:\\work\\front", 1, false);

    // A: the swept live turn. B: pi's open session is flagged even though it
    // sat idle — the pre-existing unexpected-exit semantics.
    expect(get(sessionStates)["/a.jsonl"]).toEqual({ status: "attention", note: "process exited" });
    expect(get(sessionStates)["/b.jsonl"]).toEqual({ status: "attention", note: "process exited" });
  });

  it("an expected exit preserves a pre-existing attention mark on the settled session", () => {
    projectDir.set("C:\\work\\front");
    recordProcess("C:\\work\\front", 1);
    activeSessionPath.set("/s1.jsonl");
    sessionStates.set({ "/s1.jsonl": { status: "attention", note: "error in response" } });

    handlePiExit("C:\\work\\front", 1, true);

    expect(get(sessionStates)["/s1.jsonl"]).toEqual({
      status: "attention",
      note: "error in response",
    });
  });

  it("restartPi starts the resumed session's status clean", async () => {
    projectDir.set("C:\\work\\front");
    activeSessionPath.set("/s1.jsonl");
    sessionStates.set({ "/s1.jsonl": { status: "attention", note: "process exited" } });
    vi.mocked(api.piRequest).mockResolvedValue({
      success: true,
      data: { sessionFile: "/s1.jsonl" },
    } as never);

    try {
      await restartPi();
      expect(get(sessionStates)["/s1.jsonl"]).toEqual({ status: "idle", note: "" });
    } finally {
      vi.mocked(api.piRequest).mockResolvedValue({ success: true, data: {} } as never);
    }
  });
});

describe("exportSessionHtml", () => {
  it("refuses at the start view before opening the save dialog", async () => {
    vi.mocked(saveDialog).mockClear();

    await exportSessionHtml();

    expect(saveDialog).not.toHaveBeenCalled();
    expect(vi.mocked(api.piRequest)).not.toHaveBeenCalled();
    expect(get(statusNote)).toContain("No project is open");
  });

  it("surfaces a failed export instead of dying silently in the catch", async () => {
    projectDir.set("/proj");
    vi.mocked(saveDialog).mockResolvedValueOnce("/tmp/session.html");
    vi.mocked(api.piRequest).mockRejectedValueOnce(new Error("export blew up"));

    const res = await exportSessionHtml();

    expect(res.ok).toBe(false);
    expect(get(statusNote)).toContain("Couldn't export session");
  });
});

describe("forgetProject", () => {
  it("resets the scope filter when it pointed at the forgotten project", () => {
    projectScope.set("/proj");
    forgetProject("/proj");
    expect(get(projectScope)).toBeNull();

    // An unrelated scope survives the forget.
    projectScope.set("/other");
    forgetProject("/proj");
    expect(get(projectScope)).toBe("/other");
  });
});

describe("caught-error notes", () => {
  it("renders an Error's message without doubling the Error: prefix", async () => {
    projectDir.set("C:\\work\\front");
    vi.mocked(api.piRequest).mockRejectedValueOnce(new Error("rpc connection lost"));

    await newSession();

    // Pre-fix this rendered "Error: Error: rpc connection lost".
    expect(get(statusNote)).toBe("Error: rpc connection lost");
  });
});

describe("newSession", () => {
  // keep this describe last: it overrides the shared piRequest mock resolution
  it.each([
    [{ success: false, error: "session creation failed" }, "session creation failed"],
    [{ success: true, data: { cancelled: true } }, "cancelled"],
  ])(
    "preserves the session and model when new_session does not proceed: %j",
    async (response, note) => {
      const history = [
        { kind: "user" as const, id: "keep-1", text: "Keep this conversation", images: [] },
      ];
      items.set(history);
      activeSessionPath.set("/existing.jsonl");
      // newSession stands down with no project open (start view) — these tests
      // exercise the session path, so a project must be active.
      projectDir.set("C:\\work\\front");
      vi.mocked(api.piRequest).mockResolvedValueOnce(response);

      await newSession();

      expect(get(items)).toEqual(history);
      expect(get(activeSessionPath)).toBe("/existing.jsonl");
      expect(get(statusNote)).toContain(note);
      expect(vi.mocked(api.piRequest).mock.calls.map(([c]) => c.type)).toEqual(["new_session"]);
    },
  );

  it("pins the default GLM model on fresh sessions", async () => {
    projectDir.set("C:\\work\\front");
    vi.mocked(api.piRequest).mockResolvedValue({ success: true, data: {} } as never);

    await newSession();

    const calls = vi.mocked(api.piRequest).mock.calls;
    const setModelCall = calls.find(([c]) => (c as { type: string }).type === "set_model");
    expect(setModelCall?.[0]).toMatchObject({
      provider: "openrouter",
      modelId: "z-ai/glm-5.3-flash",
    });
  });

  it("skips the model switch when already on the default model", async () => {
    projectDir.set("C:\\work\\front");
    vi.mocked(api.piRequest).mockResolvedValue({
      success: true,
      data: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } },
    } as never);

    await newSession();

    const types = vi.mocked(api.piRequest).mock.calls.map(([c]) => (c as { type: string }).type);
    expect(types).not.toContain("set_model");
  });
});

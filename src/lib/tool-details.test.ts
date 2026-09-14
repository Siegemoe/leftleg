import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import type { AgentMessage, PiEvent, ToolItem } from "./types";

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
  pendingGuiWriteCount: vi.fn().mockReturnValue(0),
}));

import { handleEvent, items, projectDir, rebuildFromMessages, recordProcess } from "./stores";

function resetStores() {
  items.set([]);
  projectDir.set("/proj");
  recordProcess("/proj", 7);
}

beforeEach(() => {
  resetStores();
});

describe("image_generate tool result details capture", () => {
  it("captures details from tool_execution_end on the live item", async () => {
    const start: PiEvent = { type: "tool_execution_start", toolCallId: "tc1", toolName: "image_generate", args: { prompt: "x" } };
    const end: PiEvent = {
      type: "tool_execution_end",
      toolCallId: "tc1",
      isError: false,
      result: {
        content: [{ type: "text", text: "Saved 1 image (m):\nC:\\p\\x.png" }],
        details: { paths: ["C:\\p\\x.png"], model: "m", usage: { cost: 0.01 } },
      },
    };
    await handleEvent(start);
    await handleEvent(end);

    const tool = get(items).find((i) => i.kind === "tool") as ToolItem;
    expect(tool).toBeTruthy();
    expect(tool.status).toBe("done");
    expect(tool.details).toEqual({ paths: ["C:\\p\\x.png"], model: "m", usage: { cost: 0.01 } });
  });

  it("keeps details undefined when the result carries none", async () => {
    await handleEvent({ type: "tool_execution_start", toolCallId: "tc2", toolName: "bash", args: {} });
    await handleEvent({ type: "tool_execution_end", toolCallId: "tc2", isError: false, result: { content: [{ type: "text", text: "ok" }] } });
    const tool = get(items).find((i) => i.kind === "tool") as ToolItem;
    expect(tool.details).toBeUndefined();
  });

  it("captures details when rebuilding from session history", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "tc3", name: "image_generate", arguments: { prompt: "y" } }] },
      {
        role: "toolResult",
        toolCallId: "tc3",
        content: [{ type: "text", text: "Saved 1 image (m):\nC:\\p\\y.png" }],
        isError: false,
        details: { paths: ["C:\\p\\y.png"], model: "m" },
      },
    ];
    rebuildFromMessages(messages);
    const tool = get(items).find((i) => i.kind === "tool") as ToolItem;
    expect(tool.status).toBe("done");
    expect(tool.details).toEqual({ paths: ["C:\\p\\y.png"], model: "m" });
  });

  it("leaves details unset for history entries without them", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "tc4", name: "read", arguments: { path: "a.ts" } }] },
      { role: "toolResult", toolCallId: "tc4", content: [{ type: "text", text: "contents" }], isError: false },
    ];
    rebuildFromMessages(messages);
    const tool = get(items).find((i) => i.kind === "tool") as ToolItem;
    expect(tool.details).toBeUndefined();
  });
});

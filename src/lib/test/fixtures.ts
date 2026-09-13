// Recorded protocol fixtures — shapes captured from pi's RPC contract
// (docs/rpc.md) and real session files. The fake pi replays these so the
// acceptance suite fails if pi's wire format drifts.

import type { AgentMessage, ExtCommand, PiEvent, SessionInfo } from "../types";

export const PROJECT_DIR = "/work/demo";
export const SESSION_A = `${PROJECT_DIR}/sessions/a.jsonl`;
export const SESSION_B = `${PROJECT_DIR}/sessions/b.jsonl`;
export const SESSION_OTHER = "/other/sessions/c.jsonl";

export const FIXTURE_SESSIONS: SessionInfo[] = [
  {
    path: SESSION_A,
    cwd: PROJECT_DIR,
    timestamp: "2026-01-01T10:00:00.000Z",
    fileModified: 1767223200000,
    sessionId: "aaaa-1111",
    name: null,
    firstMessage: "List the files in src",
  },
  {
    path: SESSION_B,
    cwd: PROJECT_DIR,
    timestamp: "2026-01-01T09:00:00.000Z",
    fileModified: 1767219600000,
    sessionId: "bbbb-2222",
    name: "refactor",
    firstMessage: "Refactor the parser",
  },
  {
    path: SESSION_OTHER,
    cwd: "/other",
    timestamp: "2026-01-02T08:00:00.000Z",
    fileModified: 1767302400000,
    sessionId: "cccc-3333",
    name: null,
    firstMessage: "Other project session",
  },
];

/** Session A history: a completed tool exchange (recorded AgentMessage shapes). */
export const SESSION_A_MESSAGES: AgentMessage[] = [
  { role: "user", content: "List the files in src" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Checking the directory." },
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls src" } },
    ],
    stopReason: "toolUse",
  },
  {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text: "main.ts\nstores.ts" }],
    isError: false,
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "src has two files: main.ts and stores.ts." }],
    stopReason: "stop",
    usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
  },
];

export const SESSION_B_MESSAGES: AgentMessage[] = [
  { role: "user", content: "Refactor the parser" },
  {
    role: "assistant",
    content: [{ type: "text", text: "Parser refactored." }],
    stopReason: "stop",
  },
];

/**
 * A recorded streaming run: thinking → text → tool call with a diff-carrying
 * result. Shapes follow rpc.md exactly (message_update.assistantMessageEvent,
 * tool_execution_update.partialResult, tool_execution_end.result.details.diff).
 */
export const RECORDED_RUN: PiEvent[] = [
  { type: "agent_start" },
  { type: "message_start", message: { role: "assistant" } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Need to inspect first." } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } },
  { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Editing " } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "stores.ts…" } },
  { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "Editing stores.ts…" } },
  {
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_start", id: "call-2", toolName: "edit" },
  },
  {
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      toolCall: { id: "call-2", name: "edit", arguments: { path: "src/stores.ts", changes: 1 } },
    },
  },
  {
    type: "tool_execution_start",
    toolCallId: "call-2",
    toolName: "edit",
    args: { path: "src/stores.ts", changes: 1 },
  },
  {
    type: "tool_execution_update",
    toolCallId: "call-2",
    partialResult: {
      content: [{ type: "text", text: "applying…" }],
      details: { diff: "@@ -1 +1 @@\n-old line\n+new line" },
    },
  },
  {
    type: "tool_execution_end",
    toolCallId: "call-2",
    isError: false,
    result: {
      content: [{ type: "text", text: "Applied 1 edit to src/stores.ts" }],
      details: { diff: "@@ -1 +1 @@\n-old line\n+new line" },
    },
  },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to inspect first." },
        { type: "text", text: "Editing stores.ts…" },
        { type: "toolCall", id: "call-2", name: "edit", arguments: { path: "src/stores.ts", changes: 1 } },
      ],
      stopReason: "toolUse",
      usage: { input: 200, output: 80, cacheRead: 10, cacheWrite: 0, totalTokens: 290 },
    },
  },
  { type: "agent_end", messages: [], willRetry: false },
  { type: "agent_settled" },
];

/** A recorded assistant message ending in a provider error. */
export const RECORDED_ERROR_RUN: PiEvent[] = [
  { type: "agent_start" },
  { type: "message_start", message: { role: "assistant" } },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "provider quota exceeded",
    },
  },
  { type: "agent_end", messages: [], willRetry: false },
  { type: "agent_settled" },
];

/**
 * Recorded fire-and-forget extension UI requests (rpc.md: notify, setStatus,
 * setWidget, setTitle, set_editor_text) plus one interactive select dialog.
 */
export const RECORDED_EXTENSION_EVENTS: PiEvent[] = [
  { type: "extension_ui_request", id: "n1", method: "notify", message: "Command blocked by user", notifyType: "warning" } as never,
  { type: "extension_ui_request", id: "n2", method: "notify", message: "Deployment finished", notifyType: "info" } as never,
  { type: "extension_ui_request", id: "n3", method: "notify", message: "Provider auth expired", notifyType: "error" } as never,
  { type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "review", statusText: "Turn 3 running..." } as never,
  { type: "extension_ui_request", id: "s2", method: "setStatus", statusKey: "draft", statusText: "stale" } as never,
  { type: "extension_ui_request", id: "s3", method: "setStatus", statusKey: "draft" } as never, // clears "draft"
  {
    type: "extension_ui_request",
    id: "w1",
    method: "setWidget",
    widgetKey: "plan",
    widgetLines: ["--- Plan ---", "1. read", "2. edit"],
    widgetPlacement: "aboveEditor",
  } as never,
  {
    type: "extension_ui_request",
    id: "w2",
    method: "setWidget",
    widgetKey: "timer",
    widgetLines: ["00:01"],
    widgetPlacement: "belowEditor",
  } as never,
  {
    type: "extension_ui_request",
    id: "w3",
    method: "setWidget",
    widgetKey: "timer",
  } as never, // clears "timer"
  { type: "extension_ui_request", id: "t1", method: "setTitle", title: "pi - demo" } as never,
  { type: "extension_ui_request", id: "e9", method: "set_editor_text", text: "Continue with step 2" } as never,
  {
    type: "extension_ui_request",
    id: "d1",
    method: "select",
    title: "Apply patch?",
    options: ["Allow", "Deny"],
    message: "edit src/stores.ts",
  } as never,
];

/** Commands pi would report for a project with a few extensions installed. */
export const FIXTURE_COMMANDS: ExtCommand[] = [
  { name: "review", description: "Review recent changes", source: "extension" },
  { name: "plan", description: "Draft an implementation plan", source: "prompt-template" },
  { name: "skill:commit", description: "Commit with a generated message", source: "skill" },
];

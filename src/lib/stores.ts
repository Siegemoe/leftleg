import { writable, get, type Writable } from "svelte/store";
import type {
  AgentMessage, PiEvent, RpcState, SessionInfo, SessionStats, UiItem,
  ToolItem, AssistantItem, Block, ModelInfo, ThinkingLevel,
} from "./types";
import * as api from "./api";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

// ---------- stores ----------

export const theme = writable<"light" | "dark" | "system">("system");
export const projectDir = writable<string>("");
export const sidebarOpen = writable<boolean>(true);
export const settingsOpen = writable<boolean>(false);

export const connected = writable<boolean>(false);
export const rpcState = writable<RpcState | null>(null);
export const items = writable<UiItem[]>([]);
export const streaming = writable<boolean>(false);
export const queue = writable<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] });
export const sessions = writable<SessionInfo[]>([]);
export const models = writable<ModelInfo[]>([]);
export const stats = writable<SessionStats | null>(null);
export const activeSessionPath = writable<string | null>(null);
export const statusNote = writable<string>(""); // transient status line (compaction, retry...)

// Per-session visual state for the sidebar: what each thread is doing.
export type SessionStatus = "idle" | "active" | "attention" | "error";
export const sessionStates = writable<Record<string, { status: SessionStatus; note: string }>>({});

function setSessionStatus(path: string | null, status: SessionStatus, note = "") {
  if (!path) return;
  sessionStates.update((s) => ({ ...s, [path]: { status, note } }));
}

export interface ExtDialogData {
  id: string;
  method: string;
  title: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
}
export const extDialog: Writable<ExtDialogData | null> = writable(null);

// ---------- helpers ----------

function toolResultText(result: { content?: Array<{ type: string; text?: string }> } | undefined): { text: string; truncated: boolean; diff?: string } {
  if (!result?.content) return { text: "", truncated: false };
  let full = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  const diff = (result as { details?: { diff?: string; patch?: string } }).details?.diff
    ?? (result as { details?: { patch?: string } }).details?.patch;
  const truncated = full.length > 6000;
  return { text: truncated ? full.slice(0, 6000) : full, truncated, diff };
}

function contentText(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.filter((c) => c.type === "text").map((c) => (c as { text?: string }).text ?? "").join("");
}

// Base64 data URLs above this size are rendered as file chips instead of <img>.
// Multi-MB embedded images in long histories have crashed the webview.
const MAX_INLINE_IMAGE_BASE64 = 1_500_000;

/** Rebuild the UI item list from a full message array (initial load / session switch). */
export function rebuildFromMessages(messages: AgentMessage[]) {
  const out: UiItem[] = [];
  const toolIndex = new Map<string, ToolItem>();
  for (const m of messages) {
    if (m.role === "user") {
      const images = (m.attachments ?? [])
        .filter((a) => a.type === "image" && a.content)
        .map((a) => {
          const data = a.content ?? "";
          if (data.length > MAX_INLINE_IMAGE_BASE64) {
            // too big to inline: show a chip with the payload stripped
            return { name: `${a.fileName ?? "image"} (${Math.round(data.length * 0.75 / 1e6)} MB — too large to preview)`, dataUrl: "" };
          }
          return { name: a.fileName ?? "image", dataUrl: `data:${a.mimeType ?? "image/png"};base64,${data}` };
        });
      out.push({ kind: "user", text: contentText(m.content as never), images });
    } else if (m.role === "assistant") {
      const blocks: Block[] = [];
      const content = m.content ?? [];
      const arr = Array.isArray(content) ? content : [{ type: "text", text: content as string }];
      for (const c of arr) {
        if (c.type === "text") blocks.push({ type: "text", text: (c as { text?: string }).text ?? "", done: true });
        else if (c.type === "thinking") blocks.push({ type: "thinking", text: (c as { thinking?: string }).thinking ?? "", done: true });
        else if (c.type === "toolCall") {
          const tc = c as { id: string; name: string; arguments: Record<string, unknown> };
          blocks.push({ type: "toolcall", toolCallId: tc.id, name: tc.name, args: JSON.stringify(tc.arguments ?? {}, null, 2) });
        }
      }
      const item: AssistantItem = {
        kind: "assistant", blocks,
        usage: m.usage, stopReason: m.stopReason,
        errorMessage: m.stopReason === "error" ? m.errorMessage : undefined,
        streaming: false,
      };
      out.push(item);
      // register tool calls for pairing with results
      for (const c of arr) {
        if (c.type === "toolCall") {
          const tc = c as { id: string; name: string; arguments: Record<string, unknown> };
          const tool: ToolItem = {
            kind: "tool", toolCallId: tc.id, name: tc.name,
            args: JSON.stringify(tc.arguments ?? {}, null, 2),
            status: "running", output: "", outputTruncated: false, isError: false,
          };
          toolIndex.set(tc.id, tool);
          out.push(tool);
        }
      }
    } else if (m.role === "toolResult") {
      const existing = toolIndex.get(m.toolCallId ?? "");
      if (existing) {
        const { text, truncated, diff } = toolResultText(m as never);
        existing.output = text;
        existing.outputTruncated = truncated;
        existing.diff = diff;
        existing.isError = !!m.isError;
        existing.status = m.isError ? "error" : "done";
      }
    } else if (m.role === "bashExecution") {
      out.push({
        kind: "bash", command: (m as { command?: string }).command ?? "",
        output: (m as { output?: string }).output ?? "",
        exitCode: (m as { exitCode?: number }).exitCode ?? 0,
        isError: ((m as { exitCode?: number }).exitCode ?? 0) !== 0,
      });
    }
  }
  items.set(out);
}

// ---------- event handling ----------

let streamingAssistant: AssistantItem | null = null;

function currentTextBlock(item: AssistantItem, contentIndex: number | undefined): Block | null {
  if (contentIndex === undefined) return null;
  return item.blocks[contentIndex] ?? null;
}

export async function handleEvent(evt: PiEvent) {
  switch (evt.type) {
    case "agent_start":
      streaming.set(true);
      setSessionStatus(get(activeSessionPath), "active", "working");
      break;
    case "agent_end":
    case "agent_settled": {
      streaming.set(false);
      setSessionStatus(get(activeSessionPath), "idle");
      if (streamingAssistant) {
        streamingAssistant.streaming = false;
        for (const b of streamingAssistant.blocks) if (b.type !== "toolcall") b.done = true;
        streamingAssistant = null;
      }
      break;
    }
    case "message_start": {
      const m = evt.message;
      if (m?.role === "assistant") {
        const item: AssistantItem = { kind: "assistant", blocks: [], streaming: true };
        streamingAssistant = item;
        items.update((a) => [...a, item]);
      }
      break;
    }
    case "message_update": {
      const d = evt.assistantMessageEvent;
      if (!d || !streamingAssistant) break;
      const item = streamingAssistant;
      if (d.type === "text_start") {
        item.blocks[d.contentIndex ?? item.blocks.length] = { type: "text", text: "", done: false };
      } else if (d.type === "text_delta") {
        const b = currentTextBlock(item, d.contentIndex);
        if (b && b.type === "text") b.text += d.delta ?? "";
      } else if (d.type === "text_end") {
        const b = currentTextBlock(item, d.contentIndex);
        if (b && b.type === "text") { b.text = (d as { content?: string }).content ?? b.text; b.done = true; }
      } else if (d.type === "thinking_start") {
        item.blocks[d.contentIndex ?? item.blocks.length] = { type: "thinking", text: "", done: false };
      } else if (d.type === "thinking_delta") {
        const b = currentTextBlock(item, d.contentIndex);
        if (b && b.type === "thinking") b.text += d.delta ?? "";
      } else if (d.type === "thinking_end") {
        const b = currentTextBlock(item, d.contentIndex);
        if (b && b.type === "thinking") { b.done = true; }
      } else if (d.type === "toolcall_start") {
        const tool: ToolItem = {
          kind: "tool", toolCallId: d.id ?? "", name: d.toolName ?? "tool",
          args: "", status: "running", output: "", outputTruncated: false, isError: false,
        };
        items.update((a) => [...a, tool]);
      } else if (d.type === "toolcall_delta") {
        // args accumulate; we keep them in the tool item below on end
      } else if (d.type === "toolcall_end") {
        const tc = d.toolCall;
        if (tc) {
          items.update((a) => {
            const t = a.find((x) => x.kind === "tool" && x.toolCallId === tc.id) as ToolItem | undefined;
            if (t) { t.name = tc.name; t.args = JSON.stringify(tc.arguments ?? {}, null, 2); }
            return a;
          });
        }
      }
      items.update((a) => a); // trigger reactivity
      break;
    }
    case "message_end": {
      const m = evt.message;
      if (m?.role === "assistant" && streamingAssistant) {
        if (m.stopReason === "error") {
          setSessionStatus(get(activeSessionPath), "attention", "error in response");
        }
        // Finalize from the authoritative message.
        const content = m.content ?? [];
        const arr = Array.isArray(content) ? content : [];
        const blocks: Block[] = [];
        for (const c of arr) {
          if (c.type === "text") blocks.push({ type: "text", text: (c as { text?: string }).text ?? "", done: true });
          else if (c.type === "thinking") blocks.push({ type: "thinking", text: (c as { thinking?: string }).thinking ?? "", done: true });
          else if (c.type === "toolCall") {
            const tc = c as { id: string; name: string; arguments: Record<string, unknown> };
            blocks.push({ type: "toolcall", toolCallId: tc.id, name: tc.name, args: JSON.stringify(tc.arguments ?? {}, null, 2) });
          }
        }
        streamingAssistant.blocks = blocks;
        streamingAssistant.usage = m.usage;
        streamingAssistant.stopReason = m.stopReason;
        streamingAssistant.errorMessage = m.stopReason === "error" ? m.errorMessage : undefined;
        streamingAssistant.streaming = false;
        streamingAssistant = null;
        items.update((a) => a);
        if (m.usage) refreshStats();
      }
      break;
    }
    case "tool_execution_start": {
      items.update((a) => {
        let t = a.find((x) => x.kind === "tool" && x.toolCallId === evt.toolCallId) as ToolItem | undefined;
        if (!t) {
          t = { kind: "tool", toolCallId: evt.toolCallId ?? "", name: evt.toolName ?? "", args: JSON.stringify(evt.args ?? {}, null, 2), status: "running", output: "", outputTruncated: false, isError: false };
          a.push(t);
        }
        t.args = JSON.stringify(evt.args ?? {}, null, 2);
        t.status = "running";
        return a;
      });
      break;
    }
    case "tool_execution_update": {
      items.update((a) => {
        const t = a.find((x) => x.kind === "tool" && x.toolCallId === evt.toolCallId) as ToolItem | undefined;
        if (t) {
          const { text, truncated, diff } = toolResultText(evt.partialResult as never);
          t.output = text; t.outputTruncated = truncated;
          if (diff) t.diff = diff;
        }
        return a;
      });
      break;
    }
    case "tool_execution_end": {
      items.update((a) => {
        const t = a.find((x) => x.kind === "tool" && x.toolCallId === evt.toolCallId) as ToolItem | undefined;
        if (t) {
          const { text, truncated, diff } = toolResultText(evt.result as never);
          t.output = text; t.outputTruncated = truncated;
          t.diff = diff;
          t.isError = !!evt.isError;
          t.status = evt.isError ? "error" : "done";
        }
        return a;
      });
      break;
    }
    case "queue_update":
      queue.set({ steering: (evt.steering as string[]) ?? [], followUp: (evt.followUp as string[]) ?? [] });
      break;
    case "compaction_start":
      statusNote.set("Compacting context…");
      break;
    case "compaction_end":
      statusNote.set(evt.result ? `Compacted: ${(evt.result as { tokensBefore?: number })?.tokensBefore ?? "?"} → ${(evt.result as { estimatedTokensAfter?: number })?.estimatedTokensAfter ?? "?"} tokens` : "Compaction failed/aborted");
      setTimeout(() => statusNote.set(""), 6000);
      refreshStats();
      break;
    case "auto_retry_start":
      statusNote.set(`Retrying (attempt ${evt.attempt}/${evt.maxAttempts})…`);
      break;
    case "auto_retry_end":
      statusNote.set("");
      break;
    case "extension_error":
      setSessionStatus(get(activeSessionPath), "attention", "extension error");
      break;
    case "extension_ui_request": {
      const id = evt.id as string;
      const method = evt.method as string;
      if (["select", "confirm", "input", "editor"].includes(method)) {
        extDialog.set({
          id, method,
          title: (evt.title as string) ?? "",
          options: evt.options as string[],
          message: (evt as { message?: string }).message as string,
          placeholder: evt.placeholder as string,
          prefill: (evt as { prefill?: string }).prefill as string,
        });
      }
      // notify / setStatus / setWidget / setTitle are fire-and-forget: ignore in v0.
      break;
    }
    default:
      break;
  }
}

// ---------- actions ----------

export function applyTheme(t: "light" | "dark" | "system") {
  const root = document.documentElement;
  const resolved = t === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : t;
  root.dataset.theme = resolved;
  theme.set(t);
}

export async function refreshStats() {
  try {
    const res = await api.piRequest<{ success: boolean; data?: SessionStats }>({ type: "get_session_stats" }, 30);
    if (res.success && res.data) stats.set(res.data);
  } catch { /* ignore */ }
}

export async function refreshRpcState() {
  const res = await api.piRequest<{ success: boolean; data?: RpcState }>({ type: "get_state" }, 30);
  if (res.success && res.data) rpcState.set(res.data);
}

export async function refreshSessions() {
  try { sessions.set(await api.listSessions()); } catch { /* ignore */ }
}

export async function refreshModels() {
  try {
    const res = await api.piRequest<{ success: boolean; data?: { models: ModelInfo[] } }>({ type: "get_available_models" }, 30);
    if (res.success && res.data) models.set(res.data.models);
  } catch { /* ignore */ }
}

export async function sendPrompt(text: string, images: { data: string; mimeType: string; name: string }[]) {
  const trimmed = text.trim();
  if (!trimmed && images.length === 0) return;
  if (!get(connected) || !get(projectDir)) {
    statusNote.set("Pick a project folder first — the pi process isn't running.");
    setTimeout(() => statusNote.set(""), 8000);
    return;
  }
  const isStreaming = get(streaming);
  const cmd: Record<string, unknown> = { type: "prompt", message: trimmed };
  if (images.length > 0) {
    cmd.images = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
  }
  if (isStreaming) cmd.streamingBehavior = "steer";
  // Optimistic user bubble
  items.update((a) => [...a, {
    kind: "user", text: trimmed,
    images: images.map((i) => ({ name: i.name, dataUrl: `data:${i.mimeType};base64,${i.data}` })),
  }]);
  try {
    await api.piRequest(cmd, 600);
  } catch (e) {
    statusNote.set(`Error: ${e}`);
    setTimeout(() => statusNote.set(""), 8000);
  }
  refreshRpcState();
}

export async function abort() {
  try { await api.piRequest({ type: "abort" }, 120); } catch { /* ignore */ }
}

export async function newSession() {
  try {
    await api.piRequest({ type: "new_session" }, 120);
    items.set([]);
    activeSessionPath.set(null);
    await refreshRpcState();
    await refreshSessions();
    await refreshStats();
  } catch (e) {
    statusNote.set(`Error: ${e}`);
  }
}

export async function openSession(path: string) {
  try {
    const res = await api.piRequest<{ success: boolean; data?: { cancelled: boolean } }>({ type: "switch_session", sessionPath: path }, 120);
    if (res.success && !res.data?.cancelled) {
      activeSessionPath.set(path);
      await reloadMessages();
      await refreshRpcState();
      await refreshStats();
    }
  } catch (e) {
    statusNote.set(`Error: ${e}`);
  }
}

export async function reloadMessages() {
  try {
    const res = await api.piRequest<{ success: boolean; data?: { messages: AgentMessage[] } }>({ type: "get_messages" }, 60);
    if (res.success && res.data) rebuildFromMessages(res.data.messages);
  } catch { /* ignore */ }
}

export async function renameSession(name: string) {
  if (!name.trim()) return;
  await api.piRequest({ type: "set_session_name", name: name.trim() }, 30);
  await refreshRpcState();
  await refreshSessions();
}

export async function setModel(provider: string, modelId: string) {
  const res = await api.piRequest<{ success: boolean; data?: ModelInfo }>({ type: "set_model", provider, modelId }, 60);
  if (res.success) { await refreshRpcState(); }
}

export async function setThinkingLevel(level: ThinkingLevel) {
  await api.piRequest({ type: "set_thinking_level", level }, 30);
  await refreshRpcState();
}

export async function setSteeringMode(mode: "all" | "one-at-a-time") {
  await api.piRequest({ type: "set_steering_mode", mode }, 30);
  await refreshRpcState();
}

export async function setFollowUpMode(mode: "all" | "one-at-a-time") {
  await api.piRequest({ type: "set_follow_up_mode", mode }, 30);
  await refreshRpcState();
}

export async function setAutoCompaction(enabled: boolean) {
  await api.piRequest({ type: "set_auto_compaction", enabled }, 30);
  await refreshRpcState();
}

export async function setAutoRetry(enabled: boolean) {
  await api.piRequest({ type: "set_auto_retry", enabled }, 30);
  await refreshRpcState();
}

export async function compact() {
  statusNote.set("Compacting…");
  try { await api.piRequest({ type: "compact" }, 600); } catch { /* ignore */ }
}

export async function respondToExtDialog(response: Record<string, unknown>) {
  const d = get(extDialog);
  if (!d) return;
  await api.piSend({ type: "extension_ui_response", id: d.id, ...response });
  extDialog.set(null);
}

// ---------- bootstrap ----------

/** Pick a project folder, persist it, restart pi by reloading the app. */
export async function chooseProject() {
  const picked = await openFileDialog({
    directory: true,
    multiple: false,
    title: "Choose project folder for pi",
  });
  if (typeof picked !== "string") return;
  projectDir.set(picked);
  try {
    const gui = await api.readGuiState();
    gui.projectDir = picked;
    await api.writeGuiState(gui);
  } catch { /* ignore */ }
  location.reload();
}

export async function boot() {
  // 1. Load GUI state
  let gui: Record<string, unknown> = {};
  try { gui = await api.readGuiState(); } catch { /* first run */ }
  const t = (gui.theme as "light" | "dark" | "system") ?? "system";
  applyTheme(t);
  const dir = (gui.projectDir as string) ?? "";
  projectDir.set(dir);
  sidebarOpen.set((gui.sidebarOpen as boolean) ?? true);

  // Persist theme + sidebar changes
  theme.subscribe(async (v) => {
    gui.theme = v;
    try { await api.writeGuiState(gui); } catch { /* ignore */ }
  });
  sidebarOpen.subscribe(async (v) => {
    gui.sidebarOpen = v;
    try { await api.writeGuiState(gui); } catch { /* ignore */ }
  });

  // React to OS theme changes when in system mode
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (get(theme) === "system") applyTheme("system");
  });

  await refreshSessions();
  if (!dir) return;

  // 2. Start pi
  try {
    await api.piStart(dir);
    connected.set(true);
    await refreshRpcState();
    await refreshModels();
    // 3. Resume most recent session for this project if there is one
    const list = get(sessions).filter((s) => s.cwd === dir);
    if (list.length > 0) {
      activeSessionPath.set(list[0].path);
      await reloadMessages();
    }
    await refreshStats();
  } catch (e) {
    statusNote.set(`Failed to start pi: ${e}`);
  }
}

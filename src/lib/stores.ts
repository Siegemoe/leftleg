import { writable, get, type Writable } from "svelte/store";
import type {
  AgentMessage, PiEvent, RpcState, SessionInfo, SessionStats, UiItem,
  ToolItem, AssistantItem, Block, ModelInfo, ThinkingLevel, ExtCommand, UserItem,
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
/** True after an unexpected pi process death until the user restarts it. */
export const disconnected = writable<boolean>(false);

// Per-session visual state for the sidebar: what each thread is doing.
export type SessionStatus = "idle" | "active" | "attention" | "error";
export const sessionStates = writable<Record<string, { status: SessionStatus; note: string }>>({});

// ---- extension surfaces (pi extension UI protocol, fire-and-forget methods) ----

export interface ExtNotification {
  id: string;
  notifyType: "info" | "warning" | "error";
  message: string;
}
export const notifications = writable<ExtNotification[]>([]);

/** statusKey → statusText (extension-set entries shown in the status bar). */
export const extStatuses = writable<Record<string, string>>({});

export interface ExtWidget {
  lines?: string[];
  placement: "aboveEditor" | "belowEditor";
}
/** widgetKey → widget content (rendered above/below the composer). */
export const extWidgets = writable<Record<string, ExtWidget>>({});

/** Commands pi can execute via a leading `/` (extension commands, templates, skills). */
export const commands = writable<ExtCommand[]>([]);

/** set_editor_text requests: the composer adopts the latest nonce. */
export const composerDraft = writable<{ text: string; nonce: number } | null>(null);

let notifSeq = 0;
const NOTIFY_TTL_MS: Record<string, number> = { info: 6000, warning: 12000, error: 0 }; // 0 = sticky

export function pushNotification(notifyType: "info" | "warning" | "error" | undefined, message: string): string {
  const type = notifyType ?? "info";
  const id = `ntf-${++notifSeq}`;
  notifications.update((a) => [...a.slice(-4), { id, notifyType: type, message }]);
  const ttl = NOTIFY_TTL_MS[type] ?? 6000;
  if (ttl > 0) setTimeout(() => dismissNotification(id), ttl);
  return id;
}

export function dismissNotification(id: string) {
  notifications.update((a) => a.filter((n) => n.id !== id));
}

let draftNonce = 0;
export function requestComposerText(text: string) {
  composerDraft.set({ text, nonce: ++draftNonce });
}

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

/** Close out a dangling streaming assistant item (agent done, or the process died). */
function finalizeStreaming() {
  if (streamingAssistant) {
    streamingAssistant.streaming = false;
    for (const b of streamingAssistant.blocks) if (b.type !== "toolcall") b.done = true;
    streamingAssistant = null;
  }
}

let itemSeq = 0;
function newId(): string {
  itemSeq += 1;
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `ui-${crypto.randomUUID()}`
    : `ui-${Date.now()}-${itemSeq}`;
}

/** Set a visible note that clears itself — unless something else replaced it first. */
function transientNote(note: string, ms = 8000) {
  statusNote.set(note);
  setTimeout(() => {
    if (get(statusNote) === note) statusNote.set("");
  }, ms);
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
      // Don't clobber an "attention" mark (e.g. an errored response that just
      // ended) — the user still needs to see it until the next action.
      const cur = get(sessionStates)[get(activeSessionPath) ?? ""];
      if (cur?.status !== "attention") setSessionStatus(get(activeSessionPath), "idle");
      finalizeStreaming();
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
        break;
      }
      // Fire-and-forget methods: surface what extensions already publish.
      switch (method) {
        case "notify":
          pushNotification(evt.notifyType as "info" | "warning" | "error" | undefined, (evt as { message?: string }).message ?? "");
          break;
        case "setStatus": {
          const key = (evt.statusKey as string) ?? "";
          if (!key) break;
          const text = evt.statusText;
          extStatuses.update((s) => {
            const next = { ...s };
            if (text === undefined || text === null) delete next[key];
            else next[key] = String(text);
            return next;
          });
          break;
        }
        case "setWidget": {
          const key = (evt.widgetKey as string) ?? "";
          if (!key) break;
          const lines = evt.widgetLines as string[] | undefined;
          extWidgets.update((w) => {
            const next = { ...w };
            if (!lines) delete next[key];
            else next[key] = { lines, placement: (evt.widgetPlacement as "aboveEditor" | "belowEditor" | undefined) ?? "aboveEditor" };
            return next;
          });
          break;
        }
        case "setTitle":
          document.title = (evt.title as string) || "Leftleg";
          break;
        case "set_editor_text":
          requestComposerText((evt as { text?: string }).text ?? "");
          break;
        default:
          break; // unknown fire-and-forget method — nothing to render (yet)
      }
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
  if (res.success && res.data) {
    rpcState.set(res.data);
    // pi owns session identity: the UI highlights whatever pi says is active.
    activeSessionPath.set(res.data.sessionFile ?? null);
  }
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

export interface PromptResult {
  ok: boolean;
  error?: string;
}

function updateUserItem(id: string, patch: Partial<import("./types").UserItem>) {
  items.update((a) => a.map((x) => (x.kind === "user" && x.id === id) ? { ...x, ...patch } : x));
}

function failUserItem(id: string, error: string) {
  updateUserItem(id, { status: "failed", error });
  transientNote(`Prompt not delivered: ${error}`);
}

/**
 * Send a user prompt. The optimistic bubble is marked per delivery state:
 * in-flight → "sending", accepted → "accepted", rejected/errored → "failed"
 * (kept on screen with its error so the composer text and Retry stay meaningful).
 * Never throws; callers get `{ ok, error }` and only clear their draft on ok.
 */
export async function sendPrompt(text: string, images: { data: string; mimeType: string; name: string }[]): Promise<PromptResult> {
  const trimmed = text.trim();
  if (!trimmed && images.length === 0) return { ok: false, error: "Nothing to send" };
  if (!get(connected) || !get(projectDir)) {
    transientNote("Pick a project folder first — the pi process isn't running.");
    return { ok: false, error: "pi process not running" };
  }
  const isStreaming = get(streaming);
  const cmd: Record<string, unknown> = { type: "prompt", message: trimmed };
  if (images.length > 0) {
    cmd.images = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
  }
  if (isStreaming) cmd.streamingBehavior = "steer";
  // Optimistic user bubble, visibly in flight until pi answers.
  const bubbleId = newId();
  items.update((a) => [...a, {
    kind: "user", text: trimmed, id: bubbleId, status: "sending",
    images: images.map((i) => ({ name: i.name, dataUrl: `data:${i.mimeType};base64,${i.data}` })),
  }]);
  let result: PromptResult;
  try {
    const res = await api.piRequest<{ success: boolean; error?: string }>(cmd, 600);
    if (res.success) {
      updateUserItem(bubbleId, { status: "accepted" });
      // A successful send supersedes earlier failed attempts.
      items.update((a) => a.filter((x) => !(x.kind === "user" && x.status === "failed")));
      result = { ok: true };
    } else {
      const error = res.error ?? "prompt rejected by pi";
      failUserItem(bubbleId, error);
      result = { ok: false, error };
    }
  } catch (e) {
    const error = typeof e === "string" ? e : String(e);
    failUserItem(bubbleId, error);
    result = { ok: false, error };
  }
  // pi may die between the response and this refresh; never let it escalate
  // into an unhandled rejection.
  void refreshRpcState().catch(() => {});
  return result;
}

/** Re-send a failed bubble's content, dropping the failed bubble first. */
export async function retryFailedUser(id: string): Promise<PromptResult> {
  const item = get(items).find((x) => x.kind === "user" && x.id === id) as import("./types").UserItem | undefined;
  if (!item || item.status !== "failed") return { ok: false, error: "not retryable" };
  const images = item.images
    .filter((i) => i.dataUrl)
    .map((i) => {
      const m = i.dataUrl.match(/^data:([^;]+);base64,(.*)$/);
      return { data: m?.[2] ?? "", mimeType: m?.[1] ?? "image/png", name: i.name };
    });
  items.update((a) => a.filter((x) => !(x.kind === "user" && x.id === id)));
  return sendPrompt(item.text, images);
}

export async function abort() {
  try { await api.piRequest({ type: "abort" }, 120); } catch { /* ignore */ }
}

/** Model pinned for every new session — the stack's default (AGENTS.md rule 7). */
export const DEFAULT_MODEL = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };

export async function newSession() {
  try {
    await api.piRequest({ type: "new_session" }, 120);
    items.set([]);
    activeSessionPath.set(null);
    await refreshRpcState();
    // Fresh sessions otherwise inherit pi's fallback model (often Opus) — pin ours.
    const cur = get(rpcState)?.model;
    if (cur?.provider !== DEFAULT_MODEL.provider || cur?.id !== DEFAULT_MODEL.id) {
      await setModel(DEFAULT_MODEL.provider, DEFAULT_MODEL.id);
    }
    await refreshSessions();
    await refreshStats();
    void persistLastSession(get(activeSessionPath));
  } catch (e) {
    transientNote(`Error: ${e}`);
  }
}

export async function openSession(path: string) {
  try {
    const res = await api.piRequest<{ success: boolean; error?: string; data?: { cancelled: boolean } }>({ type: "switch_session", sessionPath: path }, 120);
    if (!res.success) {
      transientNote(`Couldn't open session: ${res.error ?? "rejected by pi"}`);
      return;
    }
    if (res.data?.cancelled) {
      transientNote("Session switch was cancelled by an extension");
      return;
    }
    // Re-read pi's state so the UI highlights what pi actually loaded.
    await refreshRpcState();
    await reloadMessages();
    await refreshStats();
    void persistLastSession(get(activeSessionPath));
  } catch (e) {
    transientNote(`Error: ${e}`);
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

/** GUI state loaded during boot; reused for last-session persistence. */
let guiStateCache: Record<string, unknown> | null = null;

async function persistLastSession(path: string | null) {
  const dir = get(projectDir);
  if (!dir || !path || !guiStateCache) return;
  const map = (guiStateCache.lastSessionByProject as Record<string, string> | undefined) ?? {};
  if (map[dir] === path) return;
  map[dir] = path;
  guiStateCache.lastSessionByProject = map;
  try { await api.writeGuiState(guiStateCache); } catch { /* ignore */ }
}

/** Fetch pi's executable command list (extension commands, templates, skills). */
export async function refreshCommands() {
  try {
    const res = await api.piRequest<{ success: boolean; data?: { commands: ExtCommand[] } }>({ type: "get_commands" }, 30);
    commands.set(res.success && res.data ? (res.data.commands ?? []) : []);
  } catch {
    commands.set([]);
  }
}

/**
 * The pi subprocess died. Distinguish a deliberate stop from a crash: a crash
 * keeps the last session path and offers a one-click restart-and-resume.
 */
export function handlePiExit(expected: boolean) {
  connected.set(false);
  // Surfaces owned by the dead process: clear extension state with it.
  extStatuses.set({});
  extWidgets.set({});
  finalizeStreaming();
  streaming.set(false);
  if (expected) {
    transientNote("pi stopped", 4000);
  } else {
    disconnected.set(true);
    transientNote("pi exited unexpectedly", 10000);
  }
}

/** Restart pi and resume the session that was active before the exit. */
export async function restartPi() {
  const dir = get(projectDir);
  if (!dir) {
    transientNote("No project folder to restart pi in.");
    return;
  }
  const resumePath = get(activeSessionPath);
  disconnected.set(false);
  try {
    await api.piStart(dir, resumePath);
    connected.set(true);
    transientNote("pi restarted — session resumed", 5000);
    await refreshRpcState();
    if (get(activeSessionPath)) await reloadMessages();
    await refreshStats();
    await refreshSessions();
    await refreshCommands();
  } catch (e) {
    disconnected.set(true);
    transientNote(`Couldn't restart pi: ${e}`);
  }
}

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
  guiStateCache = gui;
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

  // 2. Start pi — resuming the session the sidebar will highlight, so the
  // subprocess boots INTO that session instead of a fresh one.
  try {
    const projSessions = get(sessions).filter((s) => s.cwd === dir);
    const lastMap = (gui.lastSessionByProject as Record<string, string> | undefined) ?? {};
    const remembered = lastMap[dir];
    const resumePath = projSessions.some((s) => s.path === remembered)
      ? remembered
      : projSessions[0]?.path;
    let resumed = false;
    try {
      await api.piStart(dir, resumePath);
      resumed = true;
    } catch (e) {
      // e.g. the remembered session file was deleted — fall back visibly.
      transientNote(`Couldn't resume session (${e}) — starting fresh.`);
      await api.piStart(dir);
    }
    connected.set(true);
    await refreshRpcState();
    // Trust pi: if it didn't boot into the requested session, try once to
    // switch it there; whatever pi reports afterwards is shown as active.
    if (resumed && resumePath && get(activeSessionPath) !== resumePath) {
      try {
        const r = await api.piRequest<{ success: boolean }>({ type: "switch_session", sessionPath: resumePath }, 120);
        if (r.success) await refreshRpcState();
      } catch { /* pi's own state wins */ }
    }
    await refreshModels();
    await refreshCommands();
    if (get(activeSessionPath)) await reloadMessages();
    await refreshStats();
    void persistLastSession(get(activeSessionPath));
  } catch (e) {
    transientNote(`Failed to start pi: ${e}`);
  }
}

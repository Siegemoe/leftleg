import { writable, get, type Writable } from "svelte/store";
import type {
  AgentMessage, PiEvent, RpcState, SessionInfo, SessionStats, UiItem,
  ToolItem, AssistantItem, Block, ModelInfo, ThinkingLevel, ExtCommand, UserItem,
} from "./types";
import * as api from "./api";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { handleMgmtNotify, abortPendingMgmt, pendingManagementCount } from "./settings/mgmt";
import { composerDraftBlockers } from "./composer-drafts";

// ---------- stores ----------

export const theme = writable<"light" | "dark" | "system">("system");
export const projectDir = writable<string>("");
export const sidebarOpen = writable<boolean>(true);
export const settingsOpen = writable<boolean>(false);
/** Artifacts browser (project images + docs) visibility. */
export const artifactsOpen = writable<boolean>(false);
/** Which project the settings modal is scoped to (null = general view). */
export const settingsProject = writable<string | null>(null);

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
/** Brief global lock held only while the updater performs its final safety
 * check, stops every Pi process, and hands control to the installer. */
export const updateInstallLock = writable<boolean>(false);

// Per-session visual state for the sidebar: what each thread is doing.
export type SessionStatus = "idle" | "active" | "attention" | "error";
export const sessionStates = writable<Record<string, { status: SessionStatus; note: string }>>({});

// ---- multi-process orchestration (T3-style: one pi per project) ----

/** The session each project's process has active (powers background routing). */
export const activeSessionByProject = writable<Record<string, string | null>>({});
/** Spawn id per project — envelopes from older process ids are dropped. */
export const lastProcByProject = writable<Record<string, number>>({});

export function recordProcess(project: string, pid: number | undefined | null) {
  if (typeof pid !== "number") return;
  deadProcesses.delete(project);
  const old = get(lastProcByProject)[project];
  if (old !== pid && project === get(projectDir)) commands.set([]);
  if (old !== undefined && old !== pid) abortPendingMgmt("pi process replaced", project, old);
  lastProcByProject.update((m) => ({ ...m, [project]: pid }));
}

function projectLabel(dir: string): string {
  const meta = get(projectMeta)[dir];
  if (meta?.name) return meta.name;
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

// ---- sidebar state (T3-style sections; GUI-owned preferences) ----

export interface ProjectMeta {
  name?: string;
  icon?: string;
  defaultModel?: { provider: string; id: string };
  forgotten?: boolean;
}
/** GUI-owned per-project preferences; pi stays authoritative for agent state. */
export const projectMeta = writable<Record<string, ProjectMeta>>({});
/** Pinned session paths in manual display order. */
export const pins = writable<string[]>([]);
/** Explicitly settled (archived) session paths — GUI-owned; pi has no such concept. */
export const settled = writable<string[]>([]);
/** Last-opened timestamp per session — powers the unseen-completion pill. */
export const visitedAt = writable<Record<string, number>>({});
export const sidebarWidth = writable<number>(256);
/** Sidebar search query; non-empty switches the list into search mode. */
export const sessionQuery = writable<string>("");
/** Project scope filter; null shows all projects. */
export const projectScope = writable<string | null>(null);
/** How the Settled history section renders across projects. */
export const settledView = writable<"per-project" | "unified">("per-project");
/** Mirror of pi's auto-retry flag as last set from Leftleg (pi's get_state doesn't report it). */
export const autoRetry = writable<boolean>(true);

export function togglePin(path: string) {
  const isPinned = get(pins).includes(path);
  pins.update((p) => (isPinned ? p.filter((x) => x !== path) : [...p, path]));
  // Pin/settle are disjoint filing states: pinning pulls a session out of the archive.
  if (!isPinned) settled.update((s) => s.filter((x) => x !== path));
}

/** File a session into the settled (archived) shelf. Unpins it first. */
export function settleSession(path: string) {
  pins.update((p) => p.filter((x) => x !== path));
  settled.update((s) => (s.includes(path) ? s : [...s, path]));
}

/** Return a session from the archive to the active working set. */
export function unsettleSession(path: string) {
  settled.update((s) => s.filter((x) => x !== path));
}

export function reorderPin(path: string, toIndex: number) {
  pins.update((p) => {
    const without = p.filter((x) => x !== path);
    const idx = Math.max(0, Math.min(toIndex, without.length));
    return [...without.slice(0, idx), path, ...without.slice(idx)];
  });
}

export function isPinned(path: string): boolean {
  return get(pins).includes(path);
}

export function markVisited(path: string) {
  visitedAt.update((v) => ({ ...v, [path]: Date.now() }));
}

export function updateProjectMeta(dir: string, patch: ProjectMeta) {
  projectMeta.update((m) => ({ ...m, [dir]: { ...m[dir], ...patch } }));
}

export function forgetProject(dir: string) {
  projectMeta.update((m) => ({ ...m, [dir]: { ...m[dir], forgotten: true } }));
}

export function restoreProject(dir: string) {
  projectMeta.update((m) => {
    const next = { ...m[dir], forgotten: undefined };
    delete next.forgotten;
    return { ...m, [dir]: next };
  });
}

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
  project?: string;
  proc?: number;
  title: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
}
export const extDialog: Writable<ExtDialogData | null> = writable(null);

// Transient rendered surfaces for live processes; Pi files remain authoritative.
// Keeping their reducers alive avoids losing partial messages and extension
// questions while a project is in the background. Nothing here is persisted.
const mainSurface = {
  items, streaming, queue, extStatuses, extWidgets, extDialog, composerDraft, activeSessionPath, statusNote,
  assistant: null as AssistantItem | null,
  dialogs: [] as ExtDialogData[],
};
type RenderSurface = typeof mainSurface;
let transcriptRevision = 0;
let activityRevision = 0;
let historyNeedsRefresh = false;
const backgroundSurfaces = new Map<string, { proc: number; surface: RenderSurface }>();
const deadProcesses = new Map<string, number>();

/** Describe every observable activity or GUI-owned input that makes an app
 * restart unsafe. The updater calls this only after taking updateInstallLock. */
export function collectUpdateInstallBlockers(): string[] {
  const blockers: string[] = [];
  const currentProject = get(projectDir);
  const inspectSurface = (dir: string, surface: RenderSurface) => {
    const label = projectLabel(dir || "current project");
    if (get(surface.streaming)) blockers.push(`${label} has an active agent turn`);
    const queued = get(surface.queue);
    const queuedCount = queued.steering.length + queued.followUp.length;
    if (queuedCount > 0) blockers.push(`${label} has ${queuedCount} queued message${queuedCount === 1 ? "" : "s"}`);
    if (surface.dialogs.length > 0 || get(surface.extDialog)) blockers.push(`${label} has an unanswered extension question`);
    if (get(surface.items).some((item) => item.kind === "user" && item.status === "sending")) {
      blockers.push(`${label} has a prompt still being delivered`);
    }
  };

  inspectSurface(currentProject, mainSurface);
  for (const [dir, entry] of backgroundSurfaces) {
    if (dir !== currentProject) inspectSurface(dir, entry.surface);
  }
  for (const draft of composerDraftBlockers()) {
    if (draft.sending) blockers.push(`${draft.key} has a prompt still being submitted`);
    else {
      const parts = [draft.text ? "unsent text" : "", draft.attachments ? `${draft.attachments} attachment${draft.attachments === 1 ? "" : "s"}` : ""].filter(Boolean);
      blockers.push(`${draft.key} has ${parts.join(" and ")}`);
    }
  }
  if (get(navigating)) blockers.push("a project or session is still opening");
  const management = pendingManagementCount();
  if (management > 0) blockers.push(`${management} settings operation${management === 1 ? " is" : "s are"} still pending`);
  const guiWrites = api.pendingGuiWriteCount();
  if (guiWrites > 0) blockers.push(`${guiWrites} GUI preference write${guiWrites === 1 ? " is" : "s are"} still pending`);
  return [...new Set(blockers)];
}

function blankSurface(): RenderSurface {
  return { items: writable<UiItem[]>([]), streaming: writable(false),
    queue: writable({ steering: [] as string[], followUp: [] as string[] }),
    extStatuses: writable({}), extWidgets: writable({}), extDialog: writable(null),
    composerDraft: writable(null), activeSessionPath: writable(null), statusNote: writable(""), assistant: null, dialogs: [] };
}
function saveSurface() {
  const dir = get(projectDir), proc = get(lastProcByProject)[dir];
  if (!dir || proc === undefined) return;
  backgroundSurfaces.set(dir, { proc, surface: {
    items: writable(get(items)),
    streaming: writable(get(streaming)),
    queue: writable(get(queue)),
    extStatuses: writable(get(extStatuses)),
    extWidgets: writable(get(extWidgets)),
    extDialog: writable(get(extDialog)),
    composerDraft: writable(get(composerDraft)),
    activeSessionPath: writable(get(activeSessionPath)),
    statusNote: writable(get(statusNote)),
    assistant: mainSurface.assistant,
    dialogs: mainSurface.dialogs,
  } });
}
function surfaceFor(dir: string, proc: number): RenderSurface {
  const cached = backgroundSurfaces.get(dir);
  if (cached?.proc === proc) return cached.surface;
  const surface = blankSurface();
  surface.activeSessionPath.set(get(activeSessionByProject)[dir] ?? null);
  backgroundSurfaces.set(dir, { proc, surface });
  return surface;
}
function restoreSurface(dir: string, proc: number) {
  const surface = surfaceFor(dir, proc);
  items.set(get(surface.items));
  streaming.set(get(surface.streaming));
  queue.set(get(surface.queue));
  extStatuses.set(get(surface.extStatuses));
  extWidgets.set(get(surface.extWidgets));
  extDialog.set(get(surface.extDialog));
  composerDraft.set(get(surface.composerDraft));
  activeSessionPath.set(get(surface.activeSessionPath));
  statusNote.set(get(surface.statusNote));
  mainSurface.assistant = surface.assistant;
  mainSurface.dialogs = surface.dialogs;
}

function removeDialog(owner: { project?: string; proc?: number }, id: string) {
  const dir = owner.project ?? get(projectDir);
  if (owner.proc !== undefined && get(lastProcByProject)[dir] !== owner.proc) return;
  const surface = dir === get(projectDir) ? mainSurface : backgroundSurfaces.get(dir)?.surface;
  if (!surface) return;
  surface.dialogs = surface.dialogs.filter((d) => d.id !== id);
  if (get(surface.extDialog)?.id === id) surface.extDialog.set(surface.dialogs[0] ?? null);
}

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
  finalizeStreaming();
  const out: UiItem[] = [];
  const toolIndex = new Map<string, ToolItem>();
  for (const m of messages) {
    if (m.role === "user") {
      const contentImages = Array.isArray(m.content)
        ? m.content.filter((c) => c.type === "image").map((c) => ({
          type: "image", content: c.data, mimeType: c.mimeType, fileName: "image",
        }))
        : [];
      const images = [...contentImages, ...(m.attachments ?? [])]
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
        existing.details = m.details ?? undefined;
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
  // Tool calls persisted without a result (crash mid-run) would come back as
  // eternal spinners on every reload — close them out here instead.
  for (const tool of toolIndex.values()) {
    if (tool.status !== "running") continue;
    tool.status = "error";
    tool.isError = true;
    if (!tool.output) tool.output = "no result recorded";
  }
  items.set(out);
}

// ---------- event handling ----------



function currentTextBlock(item: AssistantItem, contentIndex: number | undefined): Block | null {
  if (contentIndex === undefined) return null;
  return item.blocks[contentIndex] ?? null;
}

/** Close out a dangling streaming assistant item (agent done, or the process died). */
function finalizeStreaming(surface = mainSurface) {
  if (surface.assistant) {
    surface.assistant.streaming = false;
    for (const b of surface.assistant.blocks) if (b.type !== "toolcall") b.done = true;
    surface.assistant = null;
    surface.items.update((a) => a);
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
  if (note.includes("View changed while the request was pending")) return;
  statusNote.set(note);
  setTimeout(() => {
    if (get(statusNote) === note) statusNote.set("");
  }, ms);
}

export async function handleEvent(evt: PiEvent, origin?: { project: string; proc: number }) {
  const owner = origin ?? { project: get(projectDir), proc: get(lastProcByProject)[get(projectDir)] };
  if (origin) {
    const known = get(lastProcByProject)[origin.project];
    if (known !== undefined && known !== origin.proc || deadProcesses.get(origin.project) === origin.proc) return;
    if (evt.type === "extension_ui_request" && evt.method === "notify" && handleMgmtNotify(String(evt.message ?? ""), origin)) return;
    if (origin.project !== get(projectDir)) {
      renderEvent(evt, surfaceFor(origin.project, origin.proc), false, owner);
      return;
    }
  }
  renderEvent(evt, mainSurface, true, owner);
}

function renderEvent(evt: PiEvent, surface: RenderSurface, foreground: boolean, owner: { project: string; proc?: number }) {
  const { items, streaming, queue, extStatuses, extWidgets, extDialog, composerDraft, activeSessionPath, statusNote } = surface;
  if (foreground && (evt.type.startsWith("message_") || evt.type.startsWith("tool_execution_"))) transcriptRevision++;
  if (foreground && evt.type.startsWith("agent_")) activityRevision++;
  switch (evt.type) {
    case "agent_start":
      streaming.set(true);
      setSessionStatus(get(activeSessionPath), "active", "working");
      break;
    case "agent_end":
    case "agent_settled": {
      const continuing = evt.type === "agent_end" && (evt.willRetry === true || get(queue).steering.length + get(queue).followUp.length > 0);
      streaming.set(continuing);
      // Don't clobber an "attention" mark (e.g. an errored response that just
      // ended) — the user still needs to see it until the next action.
      const cur = get(sessionStates)[get(activeSessionPath) ?? ""];
      if (cur?.status !== "attention") setSessionStatus(get(activeSessionPath), continuing ? "active" : "idle", continuing ? "continuing" : "");
      finalizeStreaming(surface);
      if (evt.type === "agent_settled") void refreshSessions();
      if (foreground && evt.type === "agent_settled" && historyNeedsRefresh) void reloadMessages();
      break;
    }
    case "message_start": {
      const m = typeof evt.message === "object" ? evt.message : undefined;
      if (m?.role === "assistant") {
        const item: AssistantItem = { kind: "assistant", blocks: [], streaming: true };
        surface.assistant = item;
        items.update((a) => [...a, item]);
      }
      break;
    }
    case "message_update": {
      const d = evt.assistantMessageEvent;
      if (!d || !surface.assistant) break;
      const item = surface.assistant;
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
        // Pi's contentIndex counts tool calls as well as text/thinking. Keep
        // that slot occupied so later deltas cannot create sparse blocks.
        item.blocks[d.contentIndex ?? item.blocks.length] = {
          type: "toolcall", toolCallId: d.id ?? "", name: d.toolName ?? "tool", args: "",
        };
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
          const b = d.contentIndex === undefined
            ? item.blocks.find((b) => b.type === "toolcall" && b.toolCallId === tc.id)
            : currentTextBlock(item, d.contentIndex);
          if (b?.type === "toolcall") {
            b.toolCallId = tc.id;
            b.name = tc.name;
            b.args = JSON.stringify(tc.arguments ?? {}, null, 2);
          }
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
      const m = typeof evt.message === "object" ? evt.message : undefined;
      if (m?.role === "assistant" && surface.assistant) {
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
        surface.assistant.blocks = blocks;
        surface.assistant.usage = m.usage;
        surface.assistant.stopReason = m.stopReason;
        surface.assistant.errorMessage = m.stopReason === "error" ? m.errorMessage : undefined;
        surface.assistant.streaming = false;
        surface.assistant = null;
        items.update((a) => a);
        if (foreground && m.usage) void refreshStats();
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
          t.details = evt.result?.details ?? undefined;
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
      if (foreground) void refreshStats();
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
        const dialog: ExtDialogData = {
          id, method, project: owner.project, proc: owner.proc,
          title: (evt.title as string) ?? "",
          options: evt.options as string[],
          message: (evt as { message?: string }).message as string,
          placeholder: evt.placeholder as string,
          prefill: (evt as { prefill?: string }).prefill as string,
        };
        if (!get(extDialog)) surface.dialogs = [];
        if (!surface.dialogs.some((d) => d.id === id)) surface.dialogs.push(dialog);
        extDialog.set(surface.dialogs[0]);
        setSessionStatus(get(activeSessionPath), "attention", "extension question");
        if (typeof evt.timeout === "number" && evt.timeout > 0) setTimeout(() => removeDialog(owner, id), evt.timeout);
        break;
      }
      // Fire-and-forget methods: surface what extensions already publish.
      switch (method) {
        case "notify":
          // Management-channel replies are consumed here — they must never
          // surface as user toasts.
          if (handleMgmtNotify((evt as { message?: string }).message ?? "")) break;
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
          if (foreground) document.title = (evt.title as string) || "Leftleg";
          break;
        case "set_editor_text":
          composerDraft.set({ text: (evt as { text?: string }).text ?? "", nonce: ++draftNonce });
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

// ---------- request / navigation ownership ----------
export const navigating = writable(false);
let viewRevision = 0;
let navigationTail: Promise<unknown> = Promise.resolve();
let queuedNavigations = 0;

function navigate<T>(work: () => Promise<T>): Promise<T> {
  if (get(updateInstallLock)) {
    transientNote("Update installation is preparing — new work is temporarily locked.");
    return Promise.resolve(undefined as T);
  }
  queuedNavigations++;
  navigating.set(true);
  const result = navigationTail.then(async () => {
    viewRevision++;
    return work();
  });
  navigationTail = result.catch(() => {});
  return result.finally(() => {
    if (--queuedNavigations === 0) navigating.set(false);
  });
}

/** An RPC response may only update the view that issued it. */
async function requestForView<T = unknown>(command: Record<string, unknown>, timeout = 120): Promise<T> {
  const project = get(projectDir);
  const proc = get(lastProcByProject)[project];
  const revision = viewRevision;
  const res = await api.piRequest<T>(command, timeout, project || null, proc);
  if (project !== get(projectDir) || proc !== get(lastProcByProject)[project] || revision !== viewRevision) {
    throw new Error("View changed while the request was pending");
  }
  return res;
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
    const res = await requestForView<{ success: boolean; data?: SessionStats }>({ type: "get_session_stats" }, 30);
    if (res.success && res.data) stats.set(res.data);
  } catch { /* ignore */ }
}

export async function refreshRpcState() {
  const activity = activityRevision;
  const res = await requestForView<{ success: boolean; data?: RpcState }>({ type: "get_state" }, 30);
  if (!res.success || !res.data) throw new Error("Could not read Pi runtime state");
  if (res.success && res.data) {
    rpcState.set(res.data);
    if (activity === activityRevision) streaming.set(res.data.isStreaming === true);
    // pi owns session identity: the UI highlights whatever pi says is active.
    const file = res.data.sessionFile ?? null;
    activeSessionPath.set(file);
    const dir = get(projectDir);
    if (dir) activeSessionByProject.update((m) => ({ ...m, [dir]: file }));
  }
}

export async function refreshSessions() {
  try { sessions.set(await api.listSessions()); } catch { /* ignore */ }
}

export async function refreshModels() {
  try {
    const res = await requestForView<{ success: boolean; data?: { models: ModelInfo[] } }>({ type: "get_available_models" }, 30);
    if (res.success && res.data) models.set(res.data.models);
  } catch { /* ignore */ }
}

export interface PromptResult {
  ok: boolean;
  error?: string;
}

/**
 * Send a user prompt. The optimistic bubble is marked per delivery state:
 * in-flight → "sending", accepted → "accepted", rejected/errored → "failed"
 * (kept on screen with its error so the composer text and Retry stay meaningful).
 * Never throws; callers get `{ ok, error }` and only clear their draft on ok.
 */
export async function sendPrompt(text: string, images: { data: string; mimeType: string; name: string }[]): Promise<PromptResult> {
  if (get(updateInstallLock)) return { ok: false, error: "Update installation is preparing" };
  if (get(navigating)) return { ok: false, error: "Wait for the session to finish opening" };
  const trimmed = text.trim();
  if (!trimmed && images.length === 0) return { ok: false, error: "Nothing to send" };
  if (!get(connected) || !get(projectDir)) {
    transientNote("Pick a project folder first — the pi process isn't running.");
    return { ok: false, error: "pi process not running" };
  }
  const originProject = get(projectDir);
  const originProc = get(lastProcByProject)[originProject];
  const originRevision = viewRevision;
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
  function delivery(patch: Partial<UserItem>) {
    const surface = originProject === get(projectDir) ? mainSurface : backgroundSurfaces.get(originProject)?.surface;
    surface?.items.update((a) => a.map((x) => x.kind === "user" && x.id === bubbleId ? { ...x, ...patch } : x));
    if (patch.error && originProject === get(projectDir)) transientNote(`Prompt not delivered: ${patch.error}`);
  }
  let result: PromptResult;
  try {
    const res = await api.piRequest<{ success: boolean; error?: string }>(cmd, 600, originProject, originProc);
    if (res.success) {
      delivery({ status: "accepted" });
      // Unrelated failed attempts are NOT removed here: they were never
      // delivered, so their Retry affordance stays until retried or dismissed.
      result = { ok: true };
    } else {
      const error = res.error ?? "prompt rejected by pi";
      delivery({ status: "failed", error });
      result = { ok: false, error };
    }
  } catch (e) {
    const error = typeof e === "string" ? e : String(e);
    delivery({ status: "failed", error });
    result = { ok: false, error };
  }
  // pi may die between the response and this refresh; never let it escalate
  // into an unhandled rejection.
  if (originProject === get(projectDir) && originProc === get(lastProcByProject)[originProject] && originRevision === viewRevision) void refreshRpcState().catch(() => {});
  return result;
}

/** Re-send a failed bubble's content, dropping the failed bubble first. */
export async function retryFailedUser(id: string): Promise<PromptResult> {
  const item = get(items).find((x) => x.kind === "user" && x.id === id) as import("./types").UserItem | undefined;
  if (!item || item.status !== "failed") return { ok: false, error: "not retryable" };
  if (!get(connected) || get(navigating) || get(updateInstallLock)) return { ok: false, error: "pi process not ready" };
  const images = item.images
    .filter((i) => i.dataUrl)
    .map((i) => {
      const m = i.dataUrl.match(/^data:([^;]+);base64,(.*)$/);
      return { data: m?.[2] ?? "", mimeType: m?.[1] ?? "image/png", name: i.name };
    });
  items.update((a) => a.filter((x) => !(x.kind === "user" && x.id === id)));
  return sendPrompt(item.text, images);
}

/** Discard a failed bubble without re-sending it (the user gave up on it). */
export function dismissFailedUser(id: string) {
  items.update((a) => a.filter((x) => !(x.kind === "user" && x.id === id && x.status === "failed")));
}

export async function abort() {
  await rpcAction({ type: "abort" }, 120);
}

/** Model pinned for every new session — the stack's default (AGENTS.md rule 7). */
export const DEFAULT_MODEL = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };

export function newSession() { return navigate(() => newSessionImpl()); }

async function newSessionImpl() {
  try {
    const res = await requestForView<{ success: boolean; error?: string; data?: { cancelled: boolean } }>({ type: "new_session" }, 120);
    if (!res.success) {
      transientNote(`Couldn't create session: ${res.error ?? "rejected by pi"}`);
      return;
    }
    if (res.data?.cancelled) {
      transientNote("New session was cancelled by an extension");
      return;
    }
    finalizeStreaming();
    streaming.set(false);
    queue.set({ steering: [], followUp: [] });
    items.set([]);
    activeSessionPath.set(null);
    composerDraft.set(null);
    await refreshRpcState();
    // Fresh sessions otherwise inherit pi's fallback model (often Opus) — pin
    // the project's default (GUI preference), or the stack default (rule 7).
    const dir = get(projectDir);
    const wanted = (dir ? get(projectMeta)[dir]?.defaultModel : undefined) ?? DEFAULT_MODEL;
    const cur = get(rpcState)?.model;
    if (cur?.provider !== wanted.provider || cur?.id !== wanted.id) {
      await setModel(wanted.provider, wanted.id);
    }
    await refreshSessions();
    await refreshStats();
    void persistLastSession(get(activeSessionPath));
  } catch (e) {
    transientNote(`Error: ${e}`);
  }
}

/**
 * Make a project the active one: spawn its process (or refocus a live one)
 * and load the requested session. Cross-project session opens route here —
 * no app reload, and background projects keep running with their events
 * feeding only the sidebar.
 */
export function switchToProject(dir: string, sessionPath?: string) { return navigate(() => switchToProjectImpl(dir, sessionPath)); }

async function switchToProjectImpl(dir: string, sessionPath?: string) {
  try {
    const pid = await api.piStart(dir, sessionPath ?? null);
    recordProcess(dir, pid);
    saveSurface();
    projectDir.set(dir);
    restoreSurface(dir, pid);
    commands.set([]);
    models.set([]);
    stats.set(null);
    rpcState.set(null);
    connected.set(true);
    disconnected.set(false);
    await refreshRpcState();
    let switched = false;
    // Trust pi: on a reused process it may not be in the requested session.
    if (sessionPath && get(activeSessionPath) !== sessionPath) {
      try {
        const r = await requestForView<{ success: boolean; error?: string; data?: { cancelled: boolean } }>(
          { type: "switch_session", sessionPath },
          120,
        );
        if (r.success && !r.data?.cancelled) {
          // The restored surface belonged to the session pi had active before
          // (possibly mid-stream). After a successful switch, drop those
          // remnants and rebuild from pi so the view matches the session.
          finalizeStreaming();
          items.set([]);
          queue.set({ steering: [], followUp: [] });
          composerDraft.set(null);
          await refreshRpcState();
          await reloadMessages();
          switched = true;
        } else transientNote(`Couldn't open session: ${r.error ?? "cancelled by extension"}`);
      } catch { /* pi's own state wins */ }
    }
    await refreshModels();
    await refreshCommands();
    if (!switched && (!get(streaming) || get(items).length === 0)) await reloadMessages();
    await refreshStats();
    await refreshSessions();
    if (get(activeSessionPath)) markVisited(get(activeSessionPath)!);
    void persistLastSession(get(activeSessionPath));
  } catch (e) {
    transientNote(`Couldn't open project: ${e}`);
  }
}

export function openSession(path: string) { return navigate(() => openSessionImpl(path)); }

async function openSessionImpl(path: string) {
  if (get(activeSessionPath) === path) return;
  const info = get(sessions).find((s) => s.path === path);
  if (info?.cwd && info.cwd !== get(projectDir)) {
    // Cross-project open: focus (or spawn) that project's process on this session.
    await switchToProjectImpl(info.cwd, path);
    return;
  }
  try {
    const res = await requestForView<{ success: boolean; error?: string; data?: { cancelled: boolean } }>({ type: "switch_session", sessionPath: path }, 120);
    if (!res.success) {
      transientNote(`Couldn't open session: ${res.error ?? "rejected by pi"}`);
      return;
    }
    if (res.data?.cancelled) {
      transientNote("Session switch was cancelled by an extension");
      return;
    }
    finalizeStreaming();
    items.set([]);
    queue.set({ steering: [], followUp: [] });
    composerDraft.set(null);
    // Re-read pi's state so the UI highlights what pi actually loaded.
    await refreshRpcState();
    await reloadMessages();
    await refreshStats();
    markVisited(path);
    void persistLastSession(get(activeSessionPath));
  } catch (e) {
    transientNote(`Error: ${e}`);
  }
}

export async function reloadMessages() {
  const revision = transcriptRevision;
  try {
    const res = await requestForView<{ success: boolean; data?: { messages: AgentMessage[] } }>({ type: "get_messages" }, 60);
    if (res.success && Array.isArray(res.data?.messages)) {
      if (revision === transcriptRevision) {
        rebuildFromMessages(res.data.messages);
        historyNeedsRefresh = false;
      } else {
        historyNeedsRefresh = true;
        if (!get(streaming)) queueMicrotask(() => void reloadMessages());
      }
    }
  } catch (e) { transientNote(`Couldn't load session history: ${e}`); }
}

export async function renameSession(name: string, path = get(activeSessionPath) ?? undefined) {
  if (!path || path !== get(activeSessionPath) || get(navigating)) {
    transientNote("Open the session you want to rename first.");
    return;
  }
  if (!name.trim()) return;
  if (!await rpcAction({ type: "set_session_name", name: name.trim() })) return;
  await refreshRpcState();
  await refreshSessions();
}

async function rpcAction(command: Record<string, unknown>, timeout = 30): Promise<boolean> {
  try {
    const res = await requestForView<{ success: boolean; error?: string }>(command, timeout);
    if (!res.success) throw new Error(res.error ?? `${command.type} rejected by pi`);
    return true;
  } catch (e) { transientNote(`Error: ${e}`); return false; }
}
export async function setModel(provider: string, modelId: string) {
  if (await rpcAction({ type: "set_model", provider, modelId }, 60)) await refreshRpcState();
}
export async function setThinkingLevel(level: ThinkingLevel) {
  if (await rpcAction({ type: "set_thinking_level", level })) await refreshRpcState();
}
export async function setSteeringMode(mode: "all" | "one-at-a-time") {
  if (await rpcAction({ type: "set_steering_mode", mode })) await refreshRpcState();
}
export async function setFollowUpMode(mode: "all" | "one-at-a-time") {
  if (await rpcAction({ type: "set_follow_up_mode", mode })) await refreshRpcState();
}
export async function setAutoCompaction(enabled: boolean) {
  if (await rpcAction({ type: "set_auto_compaction", enabled })) await refreshRpcState();
}
export async function setAutoRetry(enabled: boolean) {
  if (await rpcAction({ type: "set_auto_retry", enabled })) autoRetry.set(enabled);
}
export async function compact() {
  statusNote.set("Compacting…");
  if (await rpcAction({ type: "compact" }, 600)) {
    transientNote("Compaction completed");
    await reloadMessages();
    await refreshStats();
  }
}
export async function abortRetry() { await rpcAction({ type: "abort_retry" }); }
export async function clearQueue() { await rpcAction({ type: "clear_queue" }); }

/** Export the active session to a user-chosen HTML file (pi renders it). */
export async function exportSessionHtml(): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const target = await saveFileDialog({
      title: "Export session as HTML",
      defaultPath: "session.html",
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (!target) return { ok: false };
    const res = await requestForView<{ success: boolean; error?: string; data?: { path: string } }>(
      { type: "export_html", outputPath: target },
      120,
    );
    if (!res.success) {
      transientNote(`Couldn't export session: ${res.error ?? "rejected by pi"}`);
      return { ok: false, error: res.error ?? "export failed" };
    }
    const path = res.data?.path ?? target;
    transientNote(`Session exported: ${path}`, 6000);
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Duplicate the active branch into a new session and switch to it. */
export function cloneSession() { return navigate(cloneSessionImpl); }

async function cloneSessionImpl(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await requestForView<{ success: boolean; error?: string; data?: { cancelled: boolean } }>({ type: "clone" }, 120);
    if (!res.success) {
      transientNote(`Couldn't clone session: ${res.error ?? "rejected by pi"}`);
      return { ok: false, error: res.error ?? "clone failed" };
    }
    if (res.data?.cancelled) {
      transientNote("Session clone was cancelled by an extension");
      return { ok: false, error: "cancelled" };
    }
    await refreshRpcState();
    await reloadMessages();
    await refreshStats();
    await refreshSessions();
    if (get(activeSessionPath)) markVisited(get(activeSessionPath)!);
    void persistLastSession(get(activeSessionPath));
    transientNote("Session cloned", 4000);
    return { ok: true };
  } catch (e) {
    transientNote(`Error: ${e}`);
    return { ok: false, error: String(e) };
  }
}

let answeringDialogId: string | null = null;

export async function respondToExtDialog(response: Record<string, unknown>) {
  if (get(updateInstallLock)) {
    transientNote("Update installation is preparing — extension responses are temporarily locked.");
    return;
  }
  const d = get(extDialog);
  if (!d || answeringDialogId === d.id) return; // one answer per dialog
  if (d.proc !== undefined && get(lastProcByProject)[d.project ?? ""] !== d.proc) {
    extDialog.set(null);
    transientNote("Extension request expired with its process");
    return;
  }
  answeringDialogId = d.id;
  try {
    await api.piSend({ type: "extension_ui_response", id: d.id, ...response }, d.project ?? get(projectDir), d.proc);
  } catch (e) {
    transientNote(`Couldn't answer extension request: ${e}`);
  }
  answeringDialogId = null;
  removeDialog(d, d.id);
}

// ---------- bootstrap ----------

/** GUI state loaded during boot; reused for last-session persistence. */
let guiStateCache: Record<string, unknown> | null = null;

async function persistLastSession(path: string | null) {
  const dir = get(projectDir);
  if (!dir || !guiStateCache) return;
  const changedProject = guiStateCache.projectDir !== dir;
  guiStateCache.projectDir = dir;
  if (!path) { await api.writeGuiState(guiStateCache); return; }
  const map = (guiStateCache.lastSessionByProject as Record<string, string> | undefined) ?? {};
  if (map[dir] === path && !changedProject) return;
  map[dir] = path;
  guiStateCache.lastSessionByProject = map;
  try { await api.writeGuiState(guiStateCache); } catch { /* ignore */ }
}

/** Fetch pi's executable command list (extension commands, templates, skills). */
export async function refreshCommands() {
  try {
    const res = await requestForView<{ success: boolean; data?: { commands: ExtCommand[] } }>({ type: "get_commands" }, 30);
    commands.set(res.success && res.data ? (res.data.commands ?? []) : []);
  } catch {
    commands.set([]);
  }
}

/**
 * A pi process died. For the active project this is the crash-banner path;
 * background projects just lose their liveness pill. `pid` filters stale
 * exits from processes that were replaced while this event was in flight.
 */
export function handlePiExit(project: string, pid: number, expected: boolean, error?: string) {
  const known = get(lastProcByProject)[project];
  if (known !== undefined && known !== pid) return; // replaced process — ignore
  deadProcesses.set(project, pid);
  backgroundSurfaces.delete(project);
  lastProcByProject.update((m) => {
    const next = { ...m };
    delete next[project];
    return next;
  });
  if (project !== get(projectDir)) {
    const session = get(activeSessionByProject)[project];
    if (!expected) setSessionStatus(session, "attention", "process exited");
    abortPendingMgmt("pi process exited before the management reply", project, pid);
    return;
  }
  connected.set(false);
  abortPendingMgmt("pi process exited before the management reply", project, pid);
  // Surfaces owned by the dead process: clear extension state with it —
  // including any outstanding dialog, which would otherwise cover the
  // recovery controls and fail on answer (the process is gone).
  extStatuses.set({});
  extWidgets.set({});
  extDialog.set(null);
  finalizeStreaming();
  // The process is gone, so tool_execution_end will never arrive: close out
  // any tool cards still showing a spinner, otherwise they run forever.
  items.update((a) => {
    let touched = false;
    for (const it of a) {
      if (it.kind === "tool" && (it as ToolItem).status === "running") {
        (it as ToolItem).status = "error";
        (it as ToolItem).isError = true;
        if (!(it as ToolItem).output) (it as ToolItem).output = "pi exited while this tool was running";
        touched = true;
      }
    }
    return touched ? [...a] : a;
  });
  streaming.set(false);
  queue.set({ steering: [], followUp: [] });
  mainSurface.dialogs = [];
  commands.set([]);
  if (expected) {
    transientNote("pi stopped", 4000);
  } else {
    disconnected.set(true);
    transientNote(error || "pi exited unexpectedly", 15000);
  }
}

/** Restart the active project's pi process, resuming the active session. */
export function restartPi() { return navigate(() => restartPiImpl()); }

async function restartPiImpl() {
  const dir = get(projectDir);
  if (!dir) {
    transientNote("No project folder to restart pi in.");
    return;
  }
  const resumePath = get(activeSessionPath);
  disconnected.set(false);
  try {
    let resumed = false;
    try {
      // A deliberate restart must respawn even if some other process for the
      // project is somehow alive.
      const pid = await api.piStart(dir, resumePath, true);
      recordProcess(dir, pid);
      resumed = true;
    } catch (resumeError) {
      // pi can report a sessionFile before the file exists on disk (it is
      // created when the first message is persisted). The resume start is
      // then rejected by the file check — fall back visibly to a fresh start
      // and don't claim a resume that didn't happen.
      transientNote(`Couldn't resume session (${resumeError}) — starting fresh.`);
      const pid = await api.piStart(dir);
      recordProcess(dir, pid);
    }
    connected.set(true);
    if (resumed) transientNote("pi restarted — session resumed", 5000);
    await refreshRpcState();
    if (get(activeSessionPath)) await reloadMessages();
    await refreshStats();
    await refreshSessions();
    await refreshCommands();
  } catch (e) {
    connected.set(false);
    disconnected.set(true);
    transientNote(`Couldn't restart pi: ${e}`);
  }
}

/** Pick a project folder, persist it, and make it the active project — no app reload. */
export async function chooseProject() {
  const picked = await openFileDialog({
    directory: true,
    multiple: false,
    title: "Choose project folder for pi",
  });
  if (typeof picked !== "string") return;
  if (guiStateCache) {
    guiStateCache.projectDir = picked;
    try { await api.writeGuiState(guiStateCache); } catch { /* ignore */ }
  }
  await switchToProject(picked);
}

export function boot() { return navigate(() => bootImpl()); }

async function bootImpl() {
  backgroundSurfaces.clear();
  deadProcesses.clear();
  mainSurface.dialogs = [];
  // 1. Load GUI state
  let gui: Record<string, unknown> = {};
  try { gui = await api.readGuiState(); } catch { /* first run */ }
  guiStateCache = gui;
  const t = (gui.theme as "light" | "dark" | "system") ?? "system";
  applyTheme(t);
  const dir = (gui.projectDir as string) ?? "";
  projectDir.set(dir);
  sidebarOpen.set((gui.sidebarOpen as boolean) ?? true);
  // Sidebar state: sections, pins, project preferences, seen/unseen tracking.
  pins.set((gui.pins as string[]) ?? []);
  settled.set((gui.settled as string[]) ?? []);
  projectMeta.set((gui.projectMeta as Record<string, ProjectMeta>) ?? {});
  visitedAt.set((gui.visitedAt as Record<string, number>) ?? {});
  sidebarWidth.set((gui.sidebarWidth as number) ?? 256);
  settledView.set((gui.settledView as "per-project" | "unified") ?? "per-project");
  autoRetry.set(true);

  // Persist theme + sidebar changes
  theme.subscribe(async (v) => {
    gui.theme = v;
    try { await api.writeGuiState(gui); } catch { /* ignore */ }
  });
  sidebarOpen.subscribe(async (v) => {
    gui.sidebarOpen = v;
    try { await api.writeGuiState(gui); } catch { /* ignore */ }
  });
  pins.subscribe(async (v) => {
    gui.pins = v;
    try { await api.writeGuiState(gui); } catch { /* ignore */ }
  });
  settled.subscribe(async (v) => {
    gui.settled = v;
    try { await api.writeGuiState(gui); } catch { /* ignore */ }
  });
  projectMeta.subscribe(async (v) => {
    gui.projectMeta = v;
    try { await api.writeGuiState(gui); } catch { /* ignore */ }
  });
  visitedAt.subscribe(async (v) => {
    gui.visitedAt = v;
    try { await api.writeGuiState(gui); } catch { /* ignore */ }
  });
  sidebarWidth.subscribe(async (v) => {
    gui.sidebarWidth = v;
    try { await api.writeGuiState(gui); } catch { /* ignore */ }
  });
  settledView.subscribe(async (v) => {
    gui.settledView = v;
    try { await api.writeGuiState(gui); } catch { /* ignore */ }
  });
  delete gui.autoRetry; // agent settings are persisted only by Pi

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
      const pid = await api.piStart(dir, resumePath);
      recordProcess(dir, pid);
      resumed = true;
    } catch (e) {
      // e.g. the remembered session file was deleted — fall back visibly.
      transientNote(`Couldn't resume session (${e}) — starting fresh.`);
      const pid = await api.piStart(dir);
      recordProcess(dir, pid);
    }
    connected.set(true);
    await refreshRpcState();
    // Trust pi: if it didn't boot into the requested session, try once to
    // switch it there; whatever pi reports afterwards is shown as active.
    if (resumed && resumePath && get(activeSessionPath) !== resumePath) {
      try {
        const r = await requestForView<{ success: boolean }>({ type: "switch_session", sessionPath: resumePath }, 120);
        if (r.success) await refreshRpcState();
      } catch { /* pi's own state wins */ }
    }
    await refreshModels();
    await refreshCommands();
    if (get(activeSessionPath)) await reloadMessages();
    await refreshStats();
    void persistLastSession(get(activeSessionPath));
  } catch (e) {
    connected.set(false);
    disconnected.set(true);
    transientNote(`Failed to start pi: ${e}`);
  }
}

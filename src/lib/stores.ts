import { writable, readable, get, type Writable } from "svelte/store";
import type {
  AgentMessage,
  PiEvent,
  RpcState,
  SessionInfo,
  SessionStats,
  UiItem,
  ToolItem,
  AssistantItem,
  Block,
  ModelInfo,
  ThinkingLevel,
  ExtCommand,
  UserItem,
} from "./types";
import * as api from "./api";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import {
  handleMgmtNotify,
  abortPendingMgmt,
  pendingManagementCount,
  primeAgentDir,
} from "./settings/mgmt";
import { composerDraftBlockers, pruneEmptyComposerDrafts } from "./composer-drafts";
import { ACTION_IDS, type ActionId } from "./keybindings";

// ---------- stores ----------

/** 30s wall-clock tick backing relative-time UI (sidebar rows, rail
 * tooltips). One shared interval instead of one per consumer — started
 * with the first subscriber, stopped with the last. */
export const nowTick = readable(Date.now(), (set) => {
  const t = setInterval(() => set(Date.now()), 30_000);
  return () => clearInterval(t);
});

export const theme = writable<"light" | "dark" | "system">("system");
export const projectDir = writable<string>("");
export const sidebarOpen = writable<boolean>(true);
export const settingsOpen = writable<boolean>(false);
/** About card overlay (Help → About Leftleg). A store, not TitleBar-local
 * state, so the Esc ladder's lower layers (FileCard) can stand down for it. */
export const aboutOpen = writable<boolean>(false);
/** Right panel (Status / Artifacts / placeholder docks beside the chat). */
export type RightPanelTab =
  "status" | "subagents" | "artifacts" | "diff" | "browser" | "terminal" | "files";
export const rightPanelOpen = writable<boolean>(false);
export const rightPanelTab = writable<RightPanelTab>("status");
export const rightPanelWidth = writable<number>(420);
/** Start view collapses the right panel. It's a default, not a lock: a dock
 * button reopens the panel manually, and choosing a project clears it. */
export const homePanelCollapsed = writable<boolean>(false);
/** Open the right panel on a tab; re-triggering the active tab closes it.
 * The close check is collapse-aware: at the start view homePanelCollapsed
 * hides the panel while rightPanelOpen keeps "what the user last had" (a
 * project entry restores it), so a dock click there must reveal the tab
 * rather than close an already-invisible panel. */
export function openRightPanel(tab: RightPanelTab) {
  const collapsed = get(homePanelCollapsed);
  if (!collapsed && get(rightPanelOpen) && get(rightPanelTab) === tab) rightPanelOpen.set(false);
  else {
    rightPanelTab.set(tab);
    rightPanelOpen.set(true);
  }
  homePanelCollapsed.set(false);
}

// ---------- key bindings ----------

/** User key-binding overrides only (action registry + defaults live in
 * src/lib/keybindings.ts). An absent key means "use the default". Hydrated
 * from GUI state in bootImpl and persisted back through the boot
 * subscription, like every other Leftleg preference. */
export const keybindings = writable<Partial<Record<ActionId, string>>>({});

/** Apply a captured binding for an action, or null to reset it to its
 * default (which deletes the override). */
export function setKeybinding(action: ActionId, binding: string | null): void {
  keybindings.update((map) => {
    const next = { ...map };
    if (binding === null) delete next[action];
    else next[action] = binding;
    return next;
  });
}

/** Bumped to ask the sidebar to focus (and select) its session-search input —
 * the focusSearch keybinding dispatches this. A tick rather than a flag so
 * pressing the chord again re-selects what's there. */
export const searchFocusTick = writable(0);

// ---------- code-viewer card ----------

/** The floating code-viewer card. One instance: opening a file raises it
 * with new content rather than stacking windows. Its rect persists in gui
 * state (screen coordinates are window-relative CSS px, clamped by the
 * component on open) so the card reopens where the user left it. */
export interface FileCardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export const fileCardOpen = writable<boolean>(false);
export const fileCardFile = writable<{ projectDir: string; path: string } | null>(null);
export const fileCardRect = writable<FileCardRect>({ x: 120, y: 80, w: 720, h: 540 });
/** Open (or refocus) the viewer card on a repo-relative file path. */
export function openFileCard(projectDir: string, path: string) {
  fileCardFile.set({ projectDir, path });
  fileCardOpen.set(true);
}
/** Which project the settings modal is scoped to (null = general view). */
export const settingsProject = writable<string | null>(null);
/** Project shown in the dedicated per-project settings card (null = closed). */
export const projectSettingsDir = writable<string | null>(null);
/** Open the per-project settings card for a project directory. */
export function openProjectSettingsCard(dir: string) {
  projectSettingsDir.set(dir);
}

// ---------- new-project card ----------

/** The "create a new project" modal card, reachable from the sidebar scope
 * picker, the settings project manager, and the File menu. */
export const newProjectOpen = writable<boolean>(false);
export function openNewProject() {
  newProjectOpen.set(true);
}

/** Create the folder and make it the active project. Resolves to the new
 * path, or null when the folder dialog was cancelled (no error — the card
 * stays open); throws so the caller (the card) can show the error inline.
 * The parent folder is picked by the Rust-side dialog inside the command, so
 * creation runs inside the navigation gate with a run-time lock re-check —
 * the call-time check alone is racy, and a lock engaging mid-queue must
 * not leave a created-but-never-opened folder behind. */
export async function createProject(name: string): Promise<string | null> {
  const lockedErr = "update installation is preparing — try again in a moment";
  if (get(updateInstallLock)) throw new Error(lockedErr);
  const dir = await navigate<string | null>(async () => {
    if (get(updateInstallLock)) throw new Error(lockedErr);
    const picked = await api.pickAndCreateProject(name);
    if (picked === null) return null; // dialog cancelled — not an error
    // Already inside the serialized navigation — call the impl directly
    // (a nested navigate() would deadlock on its own tail).
    const ok = await switchToProjectImpl(picked);
    if (!ok) throw new Error("couldn't start pi in the new folder");
    return picked;
  });
  // navigate() resolves undefined when its call-time lock check rejects;
  // null means the folder dialog was cancelled.
  if (dir === null) return null;
  if (!dir) throw new Error(lockedErr);
  newProjectOpen.set(false);
  transientNote(`Project created: ${dir}`, 6000);
  return dir;
}

export const connected = writable<boolean>(false);
export const rpcState = writable<RpcState | null>(null);
export const items = writable<UiItem[]>([]);
/** The user prompt sitting at the top of the chat viewport (scroll-spy,
 * published by Chat) — powers the prompt rail's active tick. */
export const activePromptId = writable<string | null>(null);
export const streaming = writable<boolean>(false);
export const queue = writable<{ steering: string[]; followUp: string[] }>({
  steering: [],
  followUp: [],
});
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

/** Prompts pi has accepted whose agent_start hasn't arrived yet, per project.
 * pi flips its internal streaming state synchronously on acceptance — before
 * agent_start fires — so prompts sent in that window must still steer, or pi
 * rejects them as "already processing". Cleared on the agent lifecycle events
 * and on process exit so a lost start event can't leave a stale count. */
const awaitingAgentStart = new Map<string, number>();
function awaitingStartAdjust(project: string, delta: 1 | -1) {
  const next = (awaitingAgentStart.get(project) ?? 0) + delta;
  if (next <= 0) awaitingAgentStart.delete(project);
  else awaitingAgentStart.set(project, next);
}
function awaitingStartCount(project: string): number {
  return awaitingAgentStart.get(project) ?? 0;
}

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
  /** Bold accent color for the project icon (CSS color; empty = theme default). */
  color?: string;
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
/** Pinned image/agent models ("provider/id" keys) shown first in the model dropdown. */
export const pinnedModels = writable<string[]>([]);
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
  // A scope filter pointing at the hidden project would outlive its picker
  // row (the sidebar excludes forgotten projects) — fall back to all projects.
  if (get(projectScope) === dir) projectScope.set(null);
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

export function pushNotification(
  notifyType: "info" | "warning" | "error" | undefined,
  message: string,
): string {
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
  items,
  streaming,
  queue,
  extStatuses,
  extWidgets,
  extDialog,
  composerDraft,
  activeSessionPath,
  statusNote,
  assistant: null as AssistantItem | null,
  dialogs: [] as ExtDialogData[],
  /** GUI-measured turn start (turn_start timestamp); cleared when the turn settles. */
  turnStartTs: null as number | null,
};
type RenderSurface = typeof mainSurface;
let transcriptRevision = 0;
let activityRevision = 0;
let historyNeedsRefresh = false;
const backgroundSurfaces = new Map<string, { proc: number; surface: RenderSurface }>();
const deadProcesses = new Map<string, number>();

/** Describe every observable activity or GUI-owned input that makes an app
 * restart unsafe. The updater calls this only after taking updateInstallLock.
 * `ignoreNavigating` drops the "still opening" entry for callers that wait
 * out navigation themselves instead of skipping on it (the startup pi
 * updater, which fires exactly once per launch and would otherwise starve
 * behind boot's navigation window). */
export function collectUpdateInstallBlockers(opts: { ignoreNavigating?: boolean } = {}): string[] {
  const blockers: string[] = [];
  const currentProject = get(projectDir);
  const inspectSurface = (dir: string, surface: RenderSurface) => {
    const label = projectLabel(dir || "current project");
    if (get(surface.streaming)) blockers.push(`${label} has an active agent turn`);
    const queued = get(surface.queue);
    const queuedCount = queued.steering.length + queued.followUp.length;
    if (queuedCount > 0)
      blockers.push(`${label} has ${queuedCount} queued message${queuedCount === 1 ? "" : "s"}`);
    if (surface.dialogs.length > 0 || get(surface.extDialog))
      blockers.push(`${label} has an unanswered extension question`);
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
      const parts = [
        draft.text ? "unsent text" : "",
        draft.attachments
          ? `${draft.attachments} attachment${draft.attachments === 1 ? "" : "s"}`
          : "",
      ].filter(Boolean);
      blockers.push(`${draft.key} has ${parts.join(" and ")}`);
    }
  }
  if (!opts.ignoreNavigating && get(navigating))
    blockers.push("a project or session is still opening");
  const management = pendingManagementCount();
  if (management > 0)
    blockers.push(
      `${management} settings operation${management === 1 ? " is" : "s are"} still pending`,
    );
  const guiWrites = api.pendingGuiWriteCount();
  if (guiWrites > 0)
    blockers.push(
      `${guiWrites} GUI preference write${guiWrites === 1 ? " is" : "s are"} still pending`,
    );
  return [...new Set(blockers)];
}

function blankSurface(): RenderSurface {
  return {
    items: writable<UiItem[]>([]),
    streaming: writable(false),
    queue: writable({ steering: [] as string[], followUp: [] as string[] }),
    extStatuses: writable({}),
    extWidgets: writable({}),
    extDialog: writable(null),
    composerDraft: writable(null),
    activeSessionPath: writable(null),
    statusNote: writable(""),
    assistant: null,
    dialogs: [],
    turnStartTs: null,
  };
}
function saveSurface() {
  const dir = get(projectDir),
    proc = get(lastProcByProject)[dir];
  if (!dir || proc === undefined) return;
  backgroundSurfaces.set(dir, {
    proc,
    surface: {
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
      turnStartTs: mainSurface.turnStartTs,
    },
  });
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
  mainSurface.turnStartTs = surface.turnStartTs;
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

function toolResultText(result: { content?: Array<{ type: string; text?: string }> } | undefined): {
  text: string;
  truncated: boolean;
  diff?: string;
} {
  if (!result?.content) return { text: "", truncated: false };
  const full = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  const diff =
    (result as { details?: { diff?: string; patch?: string } }).details?.diff ??
    (result as { details?: { patch?: string } }).details?.patch;
  const truncated = full.length > 6000;
  return { text: truncated ? full.slice(0, 6000) : full, truncated, diff };
}

function contentText(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text?: string }).text ?? "")
    .join("");
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
        ? m.content
            .filter((c) => c.type === "image")
            .map((c) => ({
              type: "image",
              content: c.data,
              mimeType: c.mimeType,
              fileName: "image",
            }))
        : [];
      const images = [...contentImages, ...(m.attachments ?? [])]
        .filter((a) => a.type === "image" && a.content)
        .map((a) => {
          const data = a.content ?? "";
          if (data.length > MAX_INLINE_IMAGE_BASE64) {
            // too big to inline: show a chip with the payload stripped
            return {
              name: `${a.fileName ?? "image"} (${Math.round((data.length * 0.75) / 1e6)} MB — too large to preview)`,
              dataUrl: "",
            };
          }
          return {
            name: a.fileName ?? "image",
            dataUrl: `data:${a.mimeType ?? "image/png"};base64,${data}`,
          };
        });
      out.push({
        kind: "user",
        id: newId(),
        text: contentText(m.content as never),
        images,
        timestamp: m.timestamp,
      });
    } else if (m.role === "assistant") {
      const blocks: Block[] = [];
      const content = m.content ?? [];
      const arr = Array.isArray(content) ? content : [{ type: "text", text: content as string }];
      for (const c of arr) {
        if (c.type === "text")
          blocks.push({ type: "text", text: (c as { text?: string }).text ?? "", done: true });
        else if (c.type === "thinking")
          blocks.push({
            type: "thinking",
            text: (c as { thinking?: string }).thinking ?? "",
            done: true,
          });
        else if (c.type === "toolCall") {
          const tc = c as { id: string; name: string; arguments: Record<string, unknown> };
          blocks.push({
            type: "toolcall",
            toolCallId: tc.id,
            name: tc.name,
            args: JSON.stringify(tc.arguments ?? {}, null, 2),
          });
        }
      }
      const item: AssistantItem = {
        kind: "assistant",
        id: newId(),
        blocks,
        usage: m.usage,
        stopReason: m.stopReason,
        errorMessage: m.stopReason === "error" ? m.errorMessage : undefined,
        streaming: false,
        timestamp: m.timestamp,
      };
      out.push(item);
      // register tool calls for pairing with results
      for (const c of arr) {
        if (c.type === "toolCall") {
          const tc = c as { id: string; name: string; arguments: Record<string, unknown> };
          const tool: ToolItem = {
            kind: "tool",
            id: newId(),
            toolCallId: tc.id,
            name: tc.name,
            args: JSON.stringify(tc.arguments ?? {}, null, 2),
            status: "running",
            output: "",
            outputTruncated: false,
            isError: false,
            startedAt: m.timestamp,
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
        existing.timestamp = m.timestamp;
        // History has no live start event — derive execution time from the
        // call-issuance → result-recorded message timestamps.
        if (
          existing.startedAt !== undefined &&
          m.timestamp !== undefined &&
          m.timestamp >= existing.startedAt
        ) {
          existing.endedAt = m.timestamp;
          existing.durationMs = m.timestamp - existing.startedAt;
        }
      }
    } else if (m.role === "bashExecution") {
      out.push({
        kind: "bash",
        id: newId(),
        command: (m as { command?: string }).command ?? "",
        output: (m as { output?: string }).output ?? "",
        exitCode: (m as { exitCode?: number }).exitCode ?? 0,
        isError: ((m as { exitCode?: number }).exitCode ?? 0) !== 0,
        timestamp: m.timestamp,
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

/** Slot-fill holes below `index` so `blocks` can never be sparse: a sparse
 * array renders hole entries in keyed each-blocks and `block.type` throws. */
function fillBlockHoles(item: AssistantItem, index: number): void {
  while (item.blocks.length < index) item.blocks.push({ type: "text", text: "", done: false });
}

/** Close out a dangling streaming assistant item (agent done, or the process died). */
function finalizeStreaming(surface = mainSurface) {
  let changed = false;
  // Stamp the total turn duration on the last assistant item before closing out.
  if (surface.turnStartTs !== null) {
    const a = surface.items;
    const lastAssistant = [...get(a)].reverse().find((x) => x.kind === "assistant") as
      AssistantItem | undefined;
    if (lastAssistant) {
      lastAssistant.turnDurationMs = Math.max(0, Date.now() - surface.turnStartTs);
      changed = true;
    }
    surface.turnStartTs = null;
  }
  if (surface.assistant) {
    surface.assistant.streaming = false;
    for (const b of surface.assistant.blocks) if (b && b.type !== "toolcall") b.done = true;
    surface.assistant = null;
    changed = true;
  }
  if (changed) surface.items.update((a) => a);
}

let itemSeq = 0;
function newId(): string {
  itemSeq += 1;
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `ui-${crypto.randomUUID()}`
    : `ui-${Date.now()}-${itemSeq}`;
}

/** Set a visible note that clears itself — unless something else replaced it first. */
export function transientNote(note: string, ms = 8000) {
  if (note.includes("View changed while the request was pending")) return;
  statusNote.set(note);
  setTimeout(() => {
    if (get(statusNote) === note) statusNote.set("");
  }, ms);
}

/** Render a caught error inside a prefixed note template. An Error's toString
 * already carries the "Error:" prefix, which doubles behind the note's own
 * prefix ("Couldn't open project: Error: …") — use the bare message instead. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function handleEvent(evt: PiEvent, origin?: { project: string; proc: number }) {
  const owner = origin ?? {
    project: get(projectDir),
    proc: get(lastProcByProject)[get(projectDir)],
  };
  if (origin) {
    const known = get(lastProcByProject)[origin.project];
    if (
      (known !== undefined && known !== origin.proc) ||
      deadProcesses.get(origin.project) === origin.proc
    )
      return;
    if (
      evt.type === "extension_ui_request" &&
      evt.method === "notify" &&
      handleMgmtNotify(String(evt.message ?? ""), origin)
    )
      return;
    if (origin.project !== get(projectDir)) {
      renderEvent(evt, surfaceFor(origin.project, origin.proc), false, owner);
      return;
    }
  }
  renderEvent(evt, mainSurface, true, owner);
}

function renderEvent(
  evt: PiEvent,
  surface: RenderSurface,
  foreground: boolean,
  owner: { project: string; proc?: number },
) {
  const {
    items,
    streaming,
    queue,
    extStatuses,
    extWidgets,
    extDialog,
    composerDraft,
    activeSessionPath,
    statusNote,
  } = surface;
  if (foreground && (evt.type.startsWith("message_") || evt.type.startsWith("tool_execution_")))
    transcriptRevision++;
  if (foreground && evt.type.startsWith("agent_")) activityRevision++;
  switch (evt.type) {
    case "agent_start":
      if (surface.turnStartTs === null) surface.turnStartTs = Date.now();
      awaitingAgentStart.delete(owner.project);
      streaming.set(true);
      setSessionStatus(get(activeSessionPath), "active", "working");
      break;
    case "agent_end":
    case "agent_settled": {
      awaitingAgentStart.delete(owner.project);
      const continuing =
        evt.type === "agent_end" &&
        (evt.willRetry === true || get(queue).steering.length + get(queue).followUp.length > 0);
      streaming.set(continuing);
      // Don't clobber an "attention" mark (e.g. an errored response that just
      // ended) — the user still needs to see it until the next action.
      const cur = get(sessionStates)[get(activeSessionPath) ?? ""];
      if (cur?.status !== "attention")
        setSessionStatus(
          get(activeSessionPath),
          continuing ? "active" : "idle",
          continuing ? "continuing" : "",
        );
      finalizeStreaming(surface);
      if (evt.type === "agent_settled") void refreshSessions();
      if (foreground && evt.type === "agent_settled" && historyNeedsRefresh) void reloadMessages();
      break;
    }
    case "message_start": {
      const m = typeof evt.message === "object" ? evt.message : undefined;
      if (m?.role === "assistant") {
        const item: AssistantItem = {
          kind: "assistant",
          id: newId(),
          blocks: [],
          streaming: true,
          timestamp: Date.now(),
        };
        surface.assistant = item;
        items.update((a) => [...a, item]);
      }
      break;
    }
    case "turn_start": {
      // pi's authoritative turn boundary; fall back to our own clock.
      surface.turnStartTs =
        typeof evt.timestamp === "number" ? evt.timestamp : (surface.turnStartTs ?? Date.now());
      break;
    }
    case "message_update": {
      const d = evt.assistantMessageEvent;
      if (!d || !surface.assistant) break;
      const item = surface.assistant;
      if (d.type === "text_start") {
        const i = d.contentIndex ?? item.blocks.length;
        fillBlockHoles(item, i);
        item.blocks[i] = { type: "text", text: "", done: false };
      } else if (d.type === "text_delta") {
        const b = currentTextBlock(item, d.contentIndex);
        if (b && b.type === "text") b.text += d.delta ?? "";
      } else if (d.type === "text_end") {
        const b = currentTextBlock(item, d.contentIndex);
        if (b && b.type === "text") {
          b.text = (d as { content?: string }).content ?? b.text;
          b.done = true;
        }
      } else if (d.type === "thinking_start") {
        const i = d.contentIndex ?? item.blocks.length;
        fillBlockHoles(item, i);
        item.blocks[i] = { type: "thinking", text: "", done: false, startedAt: Date.now() };
      } else if (d.type === "thinking_delta") {
        const b = currentTextBlock(item, d.contentIndex);
        if (b && b.type === "thinking") b.text += d.delta ?? "";
      } else if (d.type === "thinking_end") {
        const b = currentTextBlock(item, d.contentIndex);
        if (b && b.type === "thinking") {
          // Adopt the authoritative content like text_end does — streamed delta
          // concatenation can carry provider debris that the final message fixes.
          b.text = (d as { content?: string }).content ?? b.text;
          b.done = true;
          if (b.startedAt !== undefined) b.durationMs = Date.now() - b.startedAt;
        }
      } else if (d.type === "toolcall_start") {
        // Pi's contentIndex counts tool calls as well as text/thinking. Keep
        // that slot occupied so later deltas cannot create sparse blocks.
        const i = d.contentIndex ?? item.blocks.length;
        fillBlockHoles(item, i);
        item.blocks[i] = {
          type: "toolcall",
          toolCallId: d.id ?? "",
          name: d.toolName ?? "tool",
          args: "",
        };
        const tool: ToolItem = {
          kind: "tool",
          id: newId(),
          toolCallId: d.id ?? "",
          name: d.toolName ?? "tool",
          args: "",
          status: "running",
          output: "",
          outputTruncated: false,
          isError: false,
        };
        items.update((a) => [...a, tool]);
      } else if (d.type === "toolcall_delta") {
        // args accumulate; we keep them in the tool item below on end
      } else if (d.type === "toolcall_end") {
        const tc = d.toolCall;
        if (tc) {
          const b =
            d.contentIndex === undefined
              ? item.blocks.find((b) => b.type === "toolcall" && b.toolCallId === tc.id)
              : currentTextBlock(item, d.contentIndex);
          if (b?.type === "toolcall") {
            b.toolCallId = tc.id;
            b.name = tc.name;
            b.args = JSON.stringify(tc.arguments ?? {}, null, 2);
          }
          items.update((a) => {
            const t = a.find((x) => x.kind === "tool" && x.toolCallId === tc.id) as
              ToolItem | undefined;
            if (t) {
              t.name = tc.name;
              t.args = JSON.stringify(tc.arguments ?? {}, null, 2);
            }
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
          if (c.type === "text")
            blocks.push({ type: "text", text: (c as { text?: string }).text ?? "", done: true });
          else if (c.type === "thinking")
            blocks.push({
              type: "thinking",
              text: (c as { thinking?: string }).thinking ?? "",
              done: true,
            });
          else if (c.type === "toolCall") {
            const tc = c as { id: string; name: string; arguments: Record<string, unknown> };
            blocks.push({
              type: "toolcall",
              toolCallId: tc.id,
              name: tc.name,
              args: JSON.stringify(tc.arguments ?? {}, null, 2),
            });
          }
        }
        surface.assistant.blocks = blocks;
        surface.assistant.usage = m.usage;
        surface.assistant.stopReason = m.stopReason;
        surface.assistant.errorMessage = m.stopReason === "error" ? m.errorMessage : undefined;
        surface.assistant.timestamp =
          typeof m.timestamp === "number" ? m.timestamp : surface.assistant.timestamp;
        surface.assistant.streaming = false;
        surface.assistant = null;
        items.update((a) => a);
        if (foreground && m.usage) void refreshStats();
      }
      break;
    }
    case "tool_execution_start": {
      items.update((a) => {
        let t = a.find((x) => x.kind === "tool" && x.toolCallId === evt.toolCallId) as
          ToolItem | undefined;
        if (!t) {
          t = {
            kind: "tool",
            id: newId(),
            toolCallId: evt.toolCallId ?? "",
            name: evt.toolName ?? "",
            args: JSON.stringify(evt.args ?? {}, null, 2),
            status: "running",
            output: "",
            outputTruncated: false,
            isError: false,
          };
          a.push(t);
        }
        t.args = JSON.stringify(evt.args ?? {}, null, 2);
        t.status = "running";
        t.startedAt = Date.now();
        return a;
      });
      break;
    }
    case "tool_execution_update": {
      items.update((a) => {
        const t = a.find((x) => x.kind === "tool" && x.toolCallId === evt.toolCallId) as
          ToolItem | undefined;
        if (t) {
          const { text, truncated, diff } = toolResultText(evt.partialResult as never);
          t.output = text;
          t.outputTruncated = truncated;
          if (diff) t.diff = diff;
          // The subagent extension re-sends its full per-task snapshot on
          // details with every heartbeat; keeping the freshest one on the item
          // lets the subagents panel render live runs from the transcript
          // itself — no second store to keep in sync.
          if (t.name === "subagent") {
            // A malformed snapshot (null / primitive / array) clears instead
            // of keeping the previous one — stale results must not masquerade
            // as fresh state; the panel falls back to the call arguments.
            const d = evt.partialResult?.details;
            t.details = d && typeof d === "object" && !Array.isArray(d) ? d : undefined;
          }
        }
        return a;
      });
      break;
    }
    case "tool_execution_end": {
      items.update((a) => {
        const t = a.find((x) => x.kind === "tool" && x.toolCallId === evt.toolCallId) as
          ToolItem | undefined;
        if (t) {
          const { text, truncated, diff } = toolResultText(evt.result as never);
          t.output = text;
          t.outputTruncated = truncated;
          t.diff = diff;
          t.isError = !!evt.isError;
          t.status = evt.isError ? "error" : "done";
          t.details = evt.result?.details ?? undefined;
          t.endedAt = Date.now();
          t.timestamp = t.endedAt;
          if (t.startedAt !== undefined) t.durationMs = t.endedAt - t.startedAt;
        }
        return a;
      });
      break;
    }
    case "queue_update":
      queue.set({
        steering: (evt.steering as string[]) ?? [],
        followUp: (evt.followUp as string[]) ?? [],
      });
      break;
    case "compaction_start":
      statusNote.set("Compacting context…");
      break;
    case "compaction_end": {
      const note = evt.result
        ? `Compacted: ${(evt.result as { tokensBefore?: number })?.tokensBefore ?? "?"} → ${(evt.result as { estimatedTokensAfter?: number })?.estimatedTokensAfter ?? "?"} tokens`
        : "Compaction failed/aborted";
      statusNote.set(note);
      // Clear only our own note — an unguarded wipe would eat a newer note
      // (e.g. a "Prompt not delivered" error) set while the timer ran.
      setTimeout(() => {
        if (get(statusNote) === note) statusNote.set("");
      }, 6000);
      if (foreground) void refreshStats();
      break;
    }
    case "auto_retry_start":
      statusNote.set(`Retrying (attempt ${evt.attempt}/${evt.maxAttempts})…`);
      break;
    case "auto_retry_end": {
      if (evt.success === false) {
        // Exhausted retries can end with no errored assistant message — without
        // this the turn just quietly goes idle.
        const detail =
          typeof evt.finalError === "string" && evt.finalError ? evt.finalError : "unknown error";
        if (foreground) transientNote(`Retries failed: ${detail}`);
        setSessionStatus(get(activeSessionPath), "attention", "retries failed");
      } else if (get(statusNote).startsWith("Retrying")) {
        statusNote.set("");
      }
      break;
    }
    case "extension_error":
      setSessionStatus(get(activeSessionPath), "attention", "extension error");
      break;
    case "extension_ui_request": {
      const id = evt.id as string;
      const method = evt.method as string;
      if (["select", "confirm", "input", "editor"].includes(method)) {
        const dialog: ExtDialogData = {
          id,
          method,
          project: owner.project,
          proc: owner.proc,
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
        if (typeof evt.timeout === "number" && evt.timeout > 0)
          setTimeout(() => removeDialog(owner, id), evt.timeout);
        break;
      }
      // Fire-and-forget methods: surface what extensions already publish.
      switch (method) {
        case "notify":
          // Management-channel replies are consumed here — they must never
          // surface as user toasts.
          if (handleMgmtNotify((evt as { message?: string }).message ?? "")) break;
          pushNotification(
            evt.notifyType as "info" | "warning" | "error" | undefined,
            (evt as { message?: string }).message ?? "",
          );
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
            else
              next[key] = {
                lines,
                placement:
                  (evt.widgetPlacement as "aboveEditor" | "belowEditor" | undefined) ??
                  "aboveEditor",
              };
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

/** A request's view died mid-flight (the user navigated away); its response
 * is dead on arrival. Thrown by requestForView, ignored where staleness is
 * expected (transientNote also filters it out of the status line). */
const VIEW_CHANGED_MSG = "View changed while the request was pending";
/** True when a rejection is the stale-view guard's own throw, not a pi
 * failure — callers may skip surfacing it. */
function isViewChangedError(e: unknown): boolean {
  return e instanceof Error && e.message === VIEW_CHANGED_MSG;
}

/** An RPC response may only update the view that issued it. */
async function requestForView<T = unknown>(
  command: Record<string, unknown>,
  timeout = 120,
): Promise<T> {
  const project = get(projectDir);
  // With no open project there is no view to answer: passing `project || null`
  // would route to Rust's active-process pointer and silently mutate a project
  // that goHome left running in the background.
  if (!project) throw new Error("No project is open — open a project first.");
  const proc = get(lastProcByProject)[project];
  const revision = viewRevision;
  const res = await api.piRequest<T>(command, timeout, project || null, proc);
  if (
    project !== get(projectDir) ||
    proc !== get(lastProcByProject)[project] ||
    revision !== viewRevision
  ) {
    throw new Error(VIEW_CHANGED_MSG);
  }
  return res;
}

// ---------- actions ----------

export function applyTheme(t: "light" | "dark" | "system") {
  const root = document.documentElement;
  const resolved =
    t === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : t;
  root.dataset.theme = resolved;
  theme.set(t);
}

/** Advance light → dark → system → light — the View menu's order. */
export function cycleTheme(): void {
  const order = ["light", "dark", "system"] as const;
  const at = order.indexOf(get(theme));
  applyTheme(order[(at + 1) % order.length]);
}

export async function refreshStats() {
  try {
    const res = await requestForView<{ success: boolean; data?: SessionStats }>(
      { type: "get_session_stats" },
      30,
    );
    if (res.success && res.data) stats.set(res.data);
  } catch {
    /* ignore */
  }
}

export async function refreshRpcState() {
  const activity = activityRevision;
  const res = await requestForView<{ success: boolean; data?: RpcState }>(
    { type: "get_state" },
    30,
  );
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
  try {
    sessions.set(await api.listSessions());
  } catch {
    /* ignore */
  }
}

export async function refreshModels() {
  try {
    const res = await requestForView<{ success: boolean; data?: { models: ModelInfo[] } }>(
      { type: "get_available_models" },
      30,
    );
    if (res.success && res.data) models.set(res.data.models);
  } catch {
    /* ignore */
  }
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
export async function sendPrompt(
  text: string,
  images: { data: string; mimeType: string; name: string }[],
): Promise<PromptResult> {
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
  // "Streaming" includes prompts pi accepted but whose agent_start hasn't
  // arrived yet — pi already considers itself busy and rejects unsteered prompts.
  const isStreaming = get(streaming) || awaitingStartCount(originProject) > 0;
  const cmd: Record<string, unknown> = { type: "prompt", message: trimmed };
  if (images.length > 0) {
    cmd.images = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
  }
  if (isStreaming) cmd.streamingBehavior = "steer";
  // Optimistic user bubble, visibly in flight until pi answers.
  const bubbleId = newId();
  items.update((a) => [
    ...a,
    {
      kind: "user",
      text: trimmed,
      id: bubbleId,
      status: "sending",
      timestamp: Date.now(),
      images: images.map((i) => ({ name: i.name, dataUrl: `data:${i.mimeType};base64,${i.data}` })),
    },
  ]);
  function delivery(patch: Partial<UserItem>) {
    const surface =
      originProject === get(projectDir)
        ? mainSurface
        : backgroundSurfaces.get(originProject)?.surface;
    surface?.items.update((a) =>
      a.map((x) => (x.kind === "user" && x.id === bubbleId ? { ...x, ...patch } : x)),
    );
    if (patch.error && originProject === get(projectDir))
      transientNote(`Prompt not delivered: ${patch.error}`);
  }
  let result: PromptResult;
  try {
    const res = await api.piRequest<{ success: boolean; error?: string }>(
      cmd,
      600,
      originProject,
      originProc,
    );
    if (res.success) {
      awaitingStartAdjust(originProject, 1);
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
  if (
    originProject === get(projectDir) &&
    originProc === get(lastProcByProject)[originProject] &&
    originRevision === viewRevision
  )
    void refreshRpcState().catch(() => {});
  return result;
}

/** Retry the most recent failed user bubble, newest first. Silent no-op when
 * nothing in the transcript has failed — the retryFailed keybinding dispatches
 * this, and "nothing failed" is not an error worth interrupting for. */
export async function retryLatestFailed(): Promise<PromptResult | null> {
  const failed = [...get(items)]
    .reverse()
    .find((x) => x.kind === "user" && (x as import("./types").UserItem).status === "failed") as
    import("./types").UserItem | undefined;
  if (!failed) return null;
  return retryFailedUser(failed.id);
}

/** Re-send a failed bubble's content, dropping the failed bubble first. */
export async function retryFailedUser(id: string): Promise<PromptResult> {
  const item = get(items).find((x) => x.kind === "user" && x.id === id) as
    import("./types").UserItem | undefined;
  if (!item || item.status !== "failed") return { ok: false, error: "not retryable" };
  if (!get(connected) || get(navigating) || get(updateInstallLock))
    return { ok: false, error: "pi process not ready" };
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
  items.update((a) =>
    a.filter((x) => !(x.kind === "user" && x.id === id && x.status === "failed")),
  );
}

export async function abort() {
  await rpcAction({ type: "abort" }, 120);
}

/** Model pinned for every new session — the stack's default (AGENTS.md rule 7). */
export const DEFAULT_MODEL = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };

export function newSession() {
  // At the start view a background pi process can still be live (goHome
  // preserves it); a new_session with no project would resolve to that
  // process and create the session invisibly in the background project.
  if (!get(projectDir)) {
    transientNote("No project is open — open one from the start view first.");
    return Promise.resolve();
  }
  return navigate(() => newSessionImpl());
}

async function newSessionImpl() {
  const outgoing = get(activeSessionPath);
  try {
    const res = await requestForView<{
      success: boolean;
      error?: string;
      data?: { cancelled: boolean };
    }>({ type: "new_session" }, 120);
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
    awaitingAgentStart.delete(get(projectDir));
    settleSwitchedAwaySession(outgoing);
    queue.set({ steering: [], followUp: [] });
    items.set([]);
    activeSessionPath.set(null);
    composerDraft.set(null);
    // The old session's draft key is left behind — GC its empty drafts.
    pruneEmptyComposerDrafts(get(projectDir));
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
    transientNote(`Error: ${errorText(e)}`);
  }
}

/**
 * Make a project the active one: spawn its process (or refocus a live one)
 * and load the requested session. Cross-project session opens route here —
 * no app reload, and background projects keep running with their events
 * feeding only the sidebar.
 */
export function switchToProject(dir: string, sessionPath?: string) {
  return navigate(() => switchToProjectImpl(dir, sessionPath));
}

async function switchToProjectImpl(dir: string, sessionPath?: string): Promise<boolean> {
  let resumedFallback = false;
  let startErrText = "";
  // The requested session may be dropped by the fresh-start fallback below.
  let requestedSession: string | undefined = sessionPath;
  try {
    let pid: number;
    try {
      pid = await api.piStart(dir, sessionPath ?? null);
    } catch (startErr) {
      // pi exits at startup when the session file is missing — fall back
      // visibly to a fresh start (the same contract the old boot resume had).
      // The note is emitted at the end of the switch: restoreSurface below
      // would otherwise wipe it from the fresh surface.
      if (!sessionPath) throw startErr;
      resumedFallback = true;
      startErrText = startErr instanceof Error ? startErr.message : String(startErr);
      requestedSession = undefined; // land on the fresh session, not the failed one
      pid = await api.piStart(dir, null);
    }
    recordProcess(dir, pid);
    saveSurface();
    // Leaving the old project: GC its empty per-session drafts (non-empty
    // ones survive for when the user switches back).
    pruneEmptyComposerDrafts(get(projectDir));
    projectDir.set(dir);
    restoreSurface(dir, pid);
    commands.set([]);
    models.set([]);
    stats.set(null);
    rpcState.set(null);
    connected.set(true);
    disconnected.set(false);
    // The start view collapses the right panel by default; entering a
    // project restores it to however the user had it.
    homePanelCollapsed.set(false);
    await refreshRpcState();
    let switched = false;
    // Trust pi: on a reused process it may not be in the requested session.
    if (requestedSession && get(activeSessionPath) !== requestedSession) {
      try {
        const r = await requestForView<{
          success: boolean;
          error?: string;
          data?: { cancelled: boolean };
        }>({ type: "switch_session", sessionPath }, 120);
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
      } catch {
        /* pi's own state wins */
      }
    }
    await refreshModels();
    await refreshCommands();
    if (!switched && (!get(streaming) || get(items).length === 0)) await reloadMessages();
    await refreshStats();
    await refreshSessions();
    // Keep projects with no persisted session yet available in the startup and
    // sidebar pickers. Project metadata is GUI-owned; Pi remains authoritative
    // for the session itself.
    projectMeta.update((m) => (m[dir] ? m : { ...m, [dir]: {} }));
    if (get(activeSessionPath)) markVisited(get(activeSessionPath)!);
    void persistLastSession(get(activeSessionPath));
    if (resumedFallback) {
      transientNote(`Couldn't resume session (${startErrText}) — starting fresh.`);
    }
    return true;
  } catch (e) {
    transientNote(`Couldn't open project: ${errorText(e)}`);
    return false;
  }
}

/** Return to the start view (title-bar logo). The active project's live
 * surface is saved first, so its pi process keeps running in the background
 * (mid-stream turns continue feeding the sidebar) and switching back restores
 * transcript, queue, and extension state exactly as they were. */
export function goHome() {
  return navigate(async () => {
    saveSurface();
    // Leaving the old project: GC its empty per-session drafts (non-empty
    // ones survive for when the user switches back).
    pruneEmptyComposerDrafts(get(projectDir));
    projectDir.set("");
    items.set([]);
    streaming.set(false);
    queue.set({ steering: [], followUp: [] });
    composerDraft.set(null);
    activeSessionPath.set(null);
    activePromptId.set(null);
    statusNote.set("");
    extStatuses.set({});
    extWidgets.set({});
    extDialog.set(null);
    mainSurface.assistant = null;
    mainSurface.dialogs = [];
    mainSurface.turnStartTs = null;
    commands.set([]);
    models.set([]);
    stats.set(null);
    rpcState.set(null);
    connected.set(false);
    // A dead process's exit banner is project-scoped recovery (Restart works
    // on the current project); at the start view there is nothing to restart,
    // so drop the banner — switching back starts a fresh process anyway.
    disconnected.set(false);
    homePanelCollapsed.set(true);
  });
}

export function openSession(path: string) {
  return navigate(() => openSessionImpl(path));
}

async function openSessionImpl(path: string) {
  if (get(activeSessionPath) === path) return;
  const outgoing = get(activeSessionPath);
  const info = get(sessions).find((s) => s.path === path);
  if (info?.cwd && info.cwd !== get(projectDir)) {
    // Cross-project open: focus (or spawn) that project's process on this session.
    await switchToProjectImpl(info.cwd, path);
    return;
  }
  try {
    const res = await requestForView<{
      success: boolean;
      error?: string;
      data?: { cancelled: boolean };
    }>({ type: "switch_session", sessionPath: path }, 120);
    if (!res.success) {
      transientNote(`Couldn't open session: ${res.error ?? "rejected by pi"}`);
      return;
    }
    if (res.data?.cancelled) {
      transientNote("Session switch was cancelled by an extension");
      return;
    }
    finalizeStreaming();
    settleSwitchedAwaySession(outgoing);
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
    transientNote(`Error: ${errorText(e)}`);
  }
}

export async function reloadMessages() {
  const revision = transcriptRevision;
  try {
    const res = await requestForView<{ success: boolean; data?: { messages: AgentMessage[] } }>(
      { type: "get_messages" },
      60,
    );
    if (res.success && Array.isArray(res.data?.messages)) {
      if (revision === transcriptRevision) {
        rebuildFromMessages(res.data.messages);
        historyNeedsRefresh = false;
      } else {
        historyNeedsRefresh = true;
        if (!get(streaming)) queueMicrotask(() => void reloadMessages());
      }
    }
  } catch (e) {
    transientNote(`Couldn't load session history: ${errorText(e)}`);
  }
}

export async function renameSession(name: string, path = get(activeSessionPath) ?? undefined) {
  if (!path || path !== get(activeSessionPath) || get(navigating)) {
    transientNote("Open the session you want to rename first.");
    return;
  }
  if (!name.trim()) return;
  if (!(await rpcAction({ type: "set_session_name", name: name.trim() }))) return;
  await refreshRpcStateForView();
  await refreshSessions();
}

async function rpcAction(command: Record<string, unknown>, timeout = 30): Promise<boolean> {
  try {
    const res = await requestForView<{ success: boolean; error?: string }>(command, timeout);
    if (!res.success) throw new Error(res.error ?? `${command.type} rejected by pi`);
    return true;
  } catch (e) {
    // String(e) keeps string throws readable and avoids a doubled prefix on
    // Errors ("Error: Error: …") — an Error's toString already carries it.
    transientNote(String(e));
    return false;
  }
}
/** Refresh rpc state, tolerant of a stale view: a view-changed rejection
 * means the user navigated away mid-request, so the response belongs to a
 * view that no longer exists — there is nothing left to refresh and nothing
 * to surface (refreshRpcState itself keeps rejecting, which other callers
 * rely on). Any other error still surfaces. */
async function refreshRpcStateForView() {
  try {
    await refreshRpcState();
  } catch (e) {
    if (isViewChangedError(e)) return;
    throw e;
  }
}
/** rpcAction + follow-up state refresh (the standard model/level/mode switch
 * shape), with the stale-view tolerance above so an action that races the
 * user's navigation can't land in the global error banner via `void`. */
async function rpcActionThenRefresh(command: Record<string, unknown>, timeout = 30): Promise<void> {
  if (await rpcAction(command, timeout)) await refreshRpcStateForView();
}
export async function setModel(provider: string, modelId: string) {
  await rpcActionThenRefresh({ type: "set_model", provider, modelId }, 60);
}
export async function setThinkingLevel(level: ThinkingLevel) {
  await rpcActionThenRefresh({ type: "set_thinking_level", level });
}

/** The composer pill's cycle order (ComposerBar.svelte uses the same). */
const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Advance the thinking level one step (backward when requested). No-op while
 * pi hasn't reported a level — there is nothing to cycle from. */
export function cycleThinkingLevel(backward = false): void {
  const cur = get(rpcState)?.thinkingLevel;
  const at = cur ? THINKING_LEVELS.indexOf(cur) : -1;
  if (at < 0) return;
  const next =
    THINKING_LEVELS[(at + (backward ? THINKING_LEVELS.length - 1 : 1)) % THINKING_LEVELS.length];
  void setThinkingLevel(next);
}
export async function setSteeringMode(mode: "all" | "one-at-a-time") {
  await rpcActionThenRefresh({ type: "set_steering_mode", mode });
}
export async function setFollowUpMode(mode: "all" | "one-at-a-time") {
  await rpcActionThenRefresh({ type: "set_follow_up_mode", mode });
}
export async function setAutoCompaction(enabled: boolean) {
  await rpcActionThenRefresh({ type: "set_auto_compaction", enabled });
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
export async function abortRetry() {
  await rpcAction({ type: "abort_retry" });
}
export async function clearQueue() {
  await rpcAction({ type: "clear_queue" });
}

/** Export the active session to a user-chosen HTML file (pi renders it). */
export async function exportSessionHtml(): Promise<{ ok: boolean; path?: string; error?: string }> {
  // Stand down before the dialog, newSession-style: at the start view the
  // request below would hit the view guard and die in the catch unsurfaced —
  // after the user had already looked at a real save dialog.
  if (!get(projectDir)) {
    transientNote("No project is open — open one from the start view first.");
    return { ok: false, error: "No project is open" };
  }
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
    // The caller ignores the return value, so every failure path must surface.
    transientNote(`Couldn't export session: ${errorText(e)}`);
    return { ok: false, error: String(e) };
  }
}

/** Duplicate the active branch into a new session and switch to it. */
export function cloneSession() {
  return navigate(cloneSessionImpl);
}

async function cloneSessionImpl(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await requestForView<{
      success: boolean;
      error?: string;
      data?: { cancelled: boolean };
    }>({ type: "clone" }, 120);
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
    transientNote(`Error: ${errorText(e)}`);
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
    await api.piSend(
      { type: "extension_ui_response", id: d.id, ...response },
      d.project ?? get(projectDir),
      d.proc,
    );
  } catch (e) {
    // Send failed: keep the dialog open (the extension is still waiting) and
    // release the one-shot guard so the answer can be retried.
    answeringDialogId = null;
    transientNote(`Couldn't answer extension request: ${errorText(e)}`);
    return;
  }
  answeringDialogId = null;
  removeDialog(d, d.id);
}

// ---------- bootstrap ----------

/** GUI state loaded during boot; reused for last-session persistence. */
let guiStateCache: Record<string, unknown> | null = null;

/** Read a GUI-state value (post-boot) for lightweight stamps that don't
 * warrant their own store. */
export function guiStateValue(key: string): unknown {
  return guiStateCache?.[key];
}

/** Write a GUI-state value and persist the blob (best-effort). */
export async function setGuiStateValue(key: string, value: unknown): Promise<void> {
  if (!guiStateCache || guiStateCache[key] === value) return;
  guiStateCache[key] = value;
  try {
    await api.writeGuiState(guiStateCache);
  } catch {
    /* ignore */
  }
}

async function persistLastSession(path: string | null) {
  const dir = get(projectDir);
  if (!dir || !guiStateCache) return;
  const changedProject = guiStateCache.projectDir !== dir;
  guiStateCache.projectDir = dir;
  if (!path) {
    await api.writeGuiState(guiStateCache);
    return;
  }
  const map = (guiStateCache.lastSessionByProject as Record<string, string> | undefined) ?? {};
  if (map[dir] === path && !changedProject) return;
  map[dir] = path;
  guiStateCache.lastSessionByProject = map;
  try {
    await api.writeGuiState(guiStateCache);
  } catch {
    /* ignore */
  }
}

/** Fetch pi's executable command list (extension commands, templates, skills). */
export async function refreshCommands() {
  try {
    const res = await requestForView<{ success: boolean; data?: { commands: ExtCommand[] } }>(
      { type: "get_commands" },
      30,
    );
    commands.set(res.success && res.data ? (res.data.commands ?? []) : []);
  } catch {
    commands.set([]);
  }
}

/** Process death settles the dying project's session pills: an expected stop
 * behaves like agent_end (idle), an unexpected death demands attention.
 * Without this a dead process would leave its sessions "Working" until a full
 * agent_start→agent_end cycle ran again. The sweep covers every session of
 * the project, not just the one pi had loaded at exit — the user can switch
 * sessions mid-turn (openSession has no streaming guard), and the
 * switched-away session would otherwise pulse "Working" forever (no future
 * agent_end can arrive: the process is dead). Expected exits preserve
 * non-active statuses (an attention mark survives); an unexpected exit flags
 * the session pi had open even if it sat idle. Session → project comes from
 * pi's session list (cwd); the project's active session covers a list that
 * hasn't refreshed yet. Synchronous, O(sessions of that project). */
function settleProjectSessionsOnProcessExit(project: string, expected: boolean) {
  const paths = new Set<string>();
  for (const s of get(sessions)) if (s.cwd === project) paths.add(s.path);
  const owner = get(activeSessionByProject)[project];
  if (owner) paths.add(owner);
  const foreground = project === get(projectDir) ? get(activeSessionPath) : null;
  if (foreground) paths.add(foreground);
  const states = get(sessionStates);
  for (const path of paths) {
    if (expected) {
      if (states[path]?.status === "active") setSessionStatus(path, "idle");
    } else if (states[path]?.status === "active" || path === owner || path === foreground) {
      setSessionStatus(path, "attention", "process exited");
    }
  }
}

/** A mid-turn session switch leaves the outgoing session with no future
 * agent_end — events land on the surface's new active path — so its
 * "Working" pill would pulse forever. Settle it like the exit sweep's
 * expected branch: active → idle, any attention mark preserved. */
function settleSwitchedAwaySession(outgoing: string | null) {
  if (!outgoing) return;
  if (get(sessionStates)[outgoing]?.status === "active") setSessionStatus(outgoing, "idle");
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
  awaitingAgentStart.delete(project);
  backgroundSurfaces.delete(project);
  pruneEmptyComposerDrafts(project);
  lastProcByProject.update((m) => {
    const next = { ...m };
    delete next[project];
    return next;
  });
  // The dead process's sessions stop pulsing "Working": settle them like
  // agent_end (expected) or flag them (unexpected) — the disconnect banner
  // alone doesn't touch the sidebar chips.
  settleProjectSessionsOnProcessExit(project, expected);
  if (project !== get(projectDir)) {
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
        if (!(it as ToolItem).output)
          (it as ToolItem).output = "pi exited while this tool was running";
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
export function restartPi() {
  return navigate(() => restartPiImpl());
}

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
      transientNote(`Couldn't resume session (${errorText(resumeError)}) — starting fresh.`);
      const pid = await api.piStart(dir);
      recordProcess(dir, pid);
    }
    connected.set(true);
    if (resumed) transientNote("pi restarted — session resumed", 5000);
    await refreshRpcState();
    // A restart (resumed or fresh) starts the session clean: any leftover
    // "Working"/attention pill from the dead process must not outlive it.
    setSessionStatus(get(activeSessionPath), "idle");
    if (get(activeSessionPath)) await reloadMessages();
    await refreshStats();
    await refreshSessions();
    await refreshCommands();
  } catch (e) {
    connected.set(false);
    disconnected.set(true);
    transientNote(`Couldn't restart pi: ${errorText(e)}`);
  }
}

/** Pick a project folder, persist it, and make it the active project — no app reload. */
/** The session a project should resume: the remembered one when it still
 * exists, otherwise the project's most recent session. Undefined = fresh. */
export function lastSessionFor(dir: string): string | undefined {
  const remembered = (guiStateCache?.lastSessionByProject as Record<string, string> | undefined)?.[
    dir
  ];
  const inProject = get(sessions).filter((s) => s.cwd === dir);
  if (remembered && inProject.some((s) => s.path === remembered)) return remembered;
  return [...inProject].sort((a, b) => b.fileModified - a.fileModified)[0]?.path;
}

export async function chooseProject() {
  const picked = await openFileDialog({
    directory: true,
    multiple: false,
    title: "Choose project folder for pi",
  });
  if (typeof picked !== "string") return null;
  // A successful switch persists the project through persistLastSession.
  // Do not replace the last working project when Pi cannot start in this one.
  return (await switchToProject(picked)) ? picked : null;
}

export function boot() {
  return navigate(() => bootImpl());
}

async function bootImpl() {
  backgroundSurfaces.clear();
  deadProcesses.clear();
  mainSurface.dialogs = [];
  // Anchor the settings companion's provenance early — the availability
  // chip and the send gate share this lookup.
  primeAgentDir();
  // 1. Load GUI state
  let gui: Record<string, unknown> = {};
  try {
    gui = await api.readGuiState();
  } catch {
    /* first run */
  }
  guiStateCache = gui;
  const t = (gui.theme as "light" | "dark" | "system") ?? "system";
  applyTheme(t);
  sidebarOpen.set((gui.sidebarOpen as boolean) ?? true);
  // Sidebar state: sections, pins, project preferences, seen/unseen tracking.
  pins.set((gui.pins as string[]) ?? []);
  settled.set((gui.settled as string[]) ?? []);
  projectMeta.set((gui.projectMeta as Record<string, ProjectMeta>) ?? {});
  visitedAt.set((gui.visitedAt as Record<string, number>) ?? {});
  sidebarWidth.set((gui.sidebarWidth as number) ?? 256);
  settledView.set((gui.settledView as "per-project" | "unified") ?? "per-project");
  pinnedModels.set((gui.pinnedModels as string[]) ?? []);
  rightPanelOpen.set((gui.rightPanelOpen as boolean) ?? false);
  rightPanelTab.set((gui.rightPanelTab as RightPanelTab) ?? "status");
  rightPanelWidth.set((gui.rightPanelWidth as number) ?? 420);
  // Boot always lands on the start view, so arrive collapsed like goHome
  // leaves it. The collapse is a default, not persisted — rightPanelOpen
  // keeps the user's last choice for the restore-on-project-enter, and a
  // dock button still reopens the panel.
  homePanelCollapsed.set(true);
  // Key-binding overrides: gui state is schema-less JSON, so keep only known
  // action ids with non-empty string values — foreign junk never reaches the
  // registry or the menus.
  const savedKb = gui.keybindings as Partial<Record<ActionId, string>> | undefined;
  const kbOverrides: Partial<Record<ActionId, string>> = {};
  if (savedKb && typeof savedKb === "object") {
    for (const id of ACTION_IDS) {
      const v = savedKb[id];
      if (typeof v === "string" && v) kbOverrides[id] = v;
    }
  }
  keybindings.set(kbOverrides);
  const cardRect = gui.fileCardRect as Partial<FileCardRect> | undefined;
  fileCardRect.set({
    x: cardRect?.x ?? 120,
    y: cardRect?.y ?? 80,
    w: cardRect?.w ?? 720,
    h: cardRect?.h ?? 540,
  });
  autoRetry.set(true);

  // Persist GUI-state stores. Persistence is fire-and-forget: subscribe
  // callbacks stay synchronous, and a failed write (sync or async) must never
  // wedge the GUI loop — the next state change rewrites the whole gui object
  // anyway. The detached async wrapper keeps the original swallow semantics.
  const persistGui = (): void => {
    void (async () => {
      try {
        await api.writeGuiState(gui);
      } catch {
        /* ignore */
      }
    })();
  };
  theme.subscribe((v) => {
    gui.theme = v;
    persistGui();
  });
  sidebarOpen.subscribe((v) => {
    gui.sidebarOpen = v;
    persistGui();
  });
  pins.subscribe((v) => {
    gui.pins = v;
    persistGui();
  });
  settled.subscribe((v) => {
    gui.settled = v;
    persistGui();
  });
  projectMeta.subscribe((v) => {
    gui.projectMeta = v;
    persistGui();
  });
  visitedAt.subscribe((v) => {
    gui.visitedAt = v;
    persistGui();
  });
  sidebarWidth.subscribe((v) => {
    gui.sidebarWidth = v;
    persistGui();
  });
  settledView.subscribe((v) => {
    gui.settledView = v;
    persistGui();
  });
  pinnedModels.subscribe((v) => {
    gui.pinnedModels = v;
    persistGui();
  });
  rightPanelOpen.subscribe((v) => {
    gui.rightPanelOpen = v;
    persistGui();
  });
  rightPanelTab.subscribe((v) => {
    gui.rightPanelTab = v;
    persistGui();
  });
  rightPanelWidth.subscribe((v) => {
    gui.rightPanelWidth = v;
    persistGui();
  });
  fileCardRect.subscribe((v) => {
    gui.fileCardRect = v;
    persistGui();
  });
  keybindings.subscribe((v) => {
    gui.keybindings = v;
    persistGui();
  });
  delete gui.autoRetry; // agent settings are persisted only by Pi

  // React to OS theme changes when in system mode
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (get(theme) === "system") applyTheme("system");
  });

  await refreshSessions();
  // Project activation is deliberately manual: the start scene lists the
  // saved project as a card and pi starts only when the user picks one —
  // the startup view always holds, and no process spawns unprompted.
}

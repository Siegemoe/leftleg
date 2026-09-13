// Sidebar list model: sections, project grouping, search, and status pills.
//
// Portions adapted from T3 Code (https://github.com/pingdotgg/t3code),
// © 2026 T3 Tools Inc., MIT License — see THIRD_PARTY_NOTICES.md.
// Adapted from T3's Sidebar.logic.ts to Leftleg's pi-session data: threads
// are pi sessions, "settled" means idle history, and unseen completion is
// derived from session file mtime vs last-visited timestamps.

import type { SessionInfo } from "./types";

export type PillKind = "working" | "needs-attention" | "failed" | "completed";

export interface SidebarPill {
  kind: PillKind;
  label: string;
  /** Working pulses; the others are static states. */
  pulse: boolean;
}

/** Sidebar sections — T3's pinned/active/snoozed/settled minus Snoozed. */
export type SidebarSection = "pinned" | "active" | "settled";

export interface SidebarSession {
  path: string;
  /** name ?? firstMessage ?? "Empty session" */
  title: string;
  projectDir: string;
  /** Session file mtime — the closest thing to "when the work ended". */
  timestampMs: number;
  status: "idle" | "active" | "attention" | "error";
  pinned: boolean;
  /** A session is unseen when it changed after it was last opened. */
  seen: boolean;
}

/** T3's status priority: things needing the user outrank liveness. */
const PILL_PRIORITY: Record<PillKind, number> = {
  "needs-attention": 3,
  failed: 2,
  working: 1,
  completed: 0,
};

/**
 * The pill for one session row. Mirrors T3's resolveThreadStatusPill, mapped
 * onto pi's session states plus our visited-tracking for "Completed".
 */
export function resolveThreadPill(input: {
  status: SidebarSession["status"];
  seen: boolean;
  timestampMs: number;
}): SidebarPill | null {
  if (input.status === "active") return { kind: "working", label: "Working", pulse: true };
  if (input.status === "attention") {
    return { kind: "needs-attention", label: "Needs attention", pulse: false };
  }
  if (input.status === "error") return { kind: "failed", label: "Failed", pulse: false };
  // Idle history the user hasn't looked at since it finished.
  if (!input.seen && input.timestampMs > 0) {
    return { kind: "completed", label: "Completed", pulse: false };
  }
  return null;
}

/** Highest-priority pill across a project's sessions (T3's project indicator). */
export function resolveProjectPill(pills: ReadonlyArray<SidebarPill | null>): SidebarPill | null {
  let best: SidebarPill | null = null;
  for (const pill of pills) {
    if (!pill) continue;
    if (best === null || PILL_PRIORITY[pill.kind] > PILL_PRIORITY[best.kind]) best = pill;
  }
  return best;
}

/** T3's searchSidebarThreads: filter the ALREADY-ORDERED list by title; the
 * query only narrows, it never reorders. */
export function filterSessionsByQuery<T extends { title: string }>(sessions: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...sessions];
  return sessions.filter((s) => s.title.toLowerCase().includes(q));
}

export function projectDisplayName(dir: string, metaName: string | undefined): string {
  if (metaName) return metaName;
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

export interface ProjectGroup {
  dir: string;
  displayName: string;
  icon?: string;
  sessions: SidebarSession[];
  pill: SidebarPill | null;
  /** Latest activity across the group — group sort key. */
  activityMs: number;
}

/**
 * Group sessions per project (T3's project snapshots). `forgotten` projects
 * are hidden; scope narrows to a single project. Groups sort by latest
 * activity, most recent first — the active project naturally floats up.
 */
export function groupSessionsByProject(input: {
  sessions: readonly SidebarSession[];
  displayName: (dir: string) => string;
  icon: (dir: string) => string | undefined;
  isForgotten: (dir: string) => boolean;
  scope: string | null;
}): ProjectGroup[] {
  const byDir = new Map<string, SidebarSession[]>();
  for (const s of input.sessions) {
    if (input.scope !== null && s.projectDir !== input.scope) continue;
    if (input.isForgotten(s.projectDir)) continue;
    let list = byDir.get(s.projectDir);
    if (!list) {
      list = [];
      byDir.set(s.projectDir, list);
    }
    list.push(s);
  }
  const groups: ProjectGroup[] = [];
  for (const [dir, sessions] of byDir) {
    const pill = resolveProjectPill(sessions.map((s) => resolveThreadPill(s)));
    groups.push({
      dir,
      displayName: input.displayName(dir),
      icon: input.icon(dir),
      sessions,
      pill,
      activityMs: sessions.reduce((max, s) => Math.max(max, s.timestampMs), 0),
    });
  }
  return groups.sort((a, b) => b.activityMs - a.activityMs);
}

export interface SidebarSections {
  pinned: SidebarSession[];
  active: SidebarSession[];
  settled: SidebarSession[];
}

/**
 * Split one project's sessions into T3-style sections. Pinned keeps manual
 * order; Active is live work (newest first); Settled is history ordered by
 * when the work ended (T3's sortSettledThreadsForSidebar semantics).
 */
export function splitSections(input: {
  sessions: readonly SidebarSession[];
  pinOrder: readonly string[];
}): SidebarSections {
  // Only genuinely pinned sessions, in manual pin order (entries missing from
  // pinOrder append at the end; pinOrder entries that aren't pinned are ignored).
  const pinnedIndex = (s: SidebarSession) => {
    const i = input.pinOrder.indexOf(s.path);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const pinnedInOrder = input.sessions.filter((s) => s.pinned).sort((a, b) => pinnedIndex(a) - pinnedIndex(b));
  const rest = input.sessions.filter((s) => !s.pinned);
  const isActive = (s: SidebarSession) => s.status !== "idle";
  const active = rest.filter(isActive).sort((a, b) => b.timestampMs - a.timestampMs);
  const settled = rest.filter((s) => !isActive(s)).sort((a, b) => b.timestampMs - a.timestampMs);
  return { pinned: pinnedInOrder, active, settled };
}

/** Compact relative stamp for row meta, T3-style. */
export function formatRelativeTime(timestampMs: number, now: number): string {
  if (!timestampMs) return "";
  const diff = Math.max(0, now - timestampMs);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d`;
  const d = new Date(timestampMs);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

/** Build SidebarSessions from the raw session list + GUI state. */
export function toSidebarSessions(input: {
  infos: readonly SessionInfo[];
  statusOf: (path: string) => SidebarSession["status"];
  pinnedSet: ReadonlySet<string>;
  seenOf: (path: string, timestampMs: number) => boolean;
}): SidebarSession[] {
  return input.infos.map((info) => ({
    path: info.path,
    title: info.name ?? info.firstMessage ?? "Empty session",
    projectDir: info.cwd,
    timestampMs: info.fileModified,
    status: input.statusOf(info.path),
    pinned: input.pinnedSet.has(info.path),
    seen: input.seenOf(info.path, info.fileModified),
  }));
}

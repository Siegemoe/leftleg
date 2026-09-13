// Unit tests for the T3-adapted sidebar model (sections, pills, grouping, search).
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./types";
import {
  filterSessionsByQuery, formatRelativeTime, groupSessionsByProject, resolveProjectPill,
  resolveThreadPill, splitSections, toSidebarSessions,
} from "./sidebar-model";

function info(over: Partial<SessionInfo>): SessionInfo {
  return {
    path: "/p/s.jsonl",
    cwd: "/p",
    timestamp: "2026-01-01T10:00:00.000Z",
    fileModified: 1000,
    sessionId: "s",
    name: null,
    firstMessage: null,
    ...over,
  };
}

function session(over: Partial<Parameters<typeof resolveThreadPill>[0]> & { path?: string; title?: string; pinned?: boolean; projectDir?: string }) {
  return {
    path: over.path ?? "/p/s.jsonl",
    title: over.title ?? "a session",
    projectDir: over.projectDir ?? "/p",
    timestampMs: over.timestampMs ?? 1000,
    status: over.status ?? ("idle" as const),
    pinned: over.pinned ?? false,
    seen: over.seen ?? true,
  };
}

describe("resolveThreadPill", () => {
  it("liveness states map to pills in T3 priority order", () => {
    expect(resolveThreadPill({ status: "active", seen: true, timestampMs: 1 })).toEqual({ kind: "working", label: "Working", pulse: true });
    expect(resolveThreadPill({ status: "attention", seen: true, timestampMs: 1 })).toEqual({ kind: "needs-attention", label: "Needs attention", pulse: false });
    expect(resolveThreadPill({ status: "error", seen: true, timestampMs: 1 })).toEqual({ kind: "failed", label: "Failed", pulse: false });
  });

  it("idle + unseen + recent change reads as Completed", () => {
    expect(resolveThreadPill({ status: "idle", seen: false, timestampMs: 5_000 })).toEqual({ kind: "completed", label: "Completed", pulse: false });
  });

  it("idle + seen has no pill", () => {
    expect(resolveThreadPill({ status: "idle", seen: true, timestampMs: 5_000 })).toBeNull();
  });
});

describe("resolveProjectPill", () => {
  it("picks the highest-priority pill across sessions", () => {
    expect(resolveProjectPill([null, { kind: "completed", label: "Completed", pulse: false }, { kind: "working", label: "Working", pulse: true }]))
      .toEqual({ kind: "working", label: "Working", pulse: true });
    expect(resolveProjectPill([{ kind: "working", label: "Working", pulse: true }, { kind: "needs-attention", label: "Needs attention", pulse: false }]))
      .toEqual({ kind: "needs-attention", label: "Needs attention", pulse: false });
    expect(resolveProjectPill([null, null])).toBeNull();
  });
});

describe("filterSessionsByQuery", () => {
  const list = [{ title: "Refactor parser" }, { title: "fix login bug" }, { title: "Add Parser tests" }];
  it("narrows without reordering", () => {
    expect(filterSessionsByQuery(list, "parser").map((s) => s.title)).toEqual(["Refactor parser", "Add Parser tests"]);
  });
  it("empty query keeps everything", () => {
    expect(filterSessionsByQuery(list, "  ")).toHaveLength(3);
  });
});

describe("groupSessionsByProject", () => {
  const sessions = [
    session({ path: "/a/1", projectDir: "/a", timestampMs: 100 }),
    session({ path: "/b/1", projectDir: "/b", timestampMs: 500 }),
    session({ path: "/a/2", projectDir: "/a", timestampMs: 300, status: "active" }),
  ];

  it("groups by dir, sorted by latest activity, and computes group pills", () => {
    const groups = groupSessionsByProject({
      sessions,
      displayName: (d) => d,
      icon: () => undefined,
      isForgotten: () => false,
      scope: null,
    });
    expect(groups.map((g) => g.dir)).toEqual(["/b", "/a"]);
    expect(groups[0].pill).toBeNull();
    expect(groups[1].pill).toEqual({ kind: "working", label: "Working", pulse: true });
  });

  it("scope narrows to one project and forgotten projects are hidden", () => {
    const scoped = groupSessionsByProject({
      sessions,
      displayName: (d) => d,
      icon: () => undefined,
      isForgotten: (d) => d === "/b",
      scope: null,
    });
    expect(scoped.map((g) => g.dir)).toEqual(["/a"]);
  });
});

describe("splitSections", () => {
  it("pinned keeps manual order; active is live; settled is history by end time", () => {
    const s1 = session({ path: "/1", timestampMs: 100 });
    const s2 = session({ path: "/2", timestampMs: 300, status: "active" });
    const s3 = session({ path: "/3", timestampMs: 200 });
    const s4 = session({ path: "/4", timestampMs: 400, pinned: true });
    const sections = splitSections({ sessions: [s1, s2, s3, s4], pinOrder: ["/4", "/2"] });
    // only pinned ones in pin order (s2 is in pinOrder but not pinned — ignored)
    expect(sections.pinned.map((s) => s.path)).toEqual(["/4"]);
    expect(sections.active.map((s) => s.path)).toEqual(["/2"]);
    expect(sections.settled.map((s) => s.path)).toEqual(["/3", "/1"]);
  });
});

describe("toSidebarSessions + formatRelativeTime", () => {
  it("titles prefer name, then first message", () => {
    const out = toSidebarSessions({
      infos: [info({ name: "named", firstMessage: "fallback" }), info({ path: "/2", firstMessage: "fallback" }), info({ path: "/3" })],
      statusOf: () => "idle",
      pinnedSet: new Set(),
      seenOf: () => true,
    });
    expect(out.map((s) => s.title)).toEqual(["named", "fallback", "Empty session"]);
  });

  it("relative stamps stay compact", () => {
    const now = 1_000_000_000_000;
    expect(formatRelativeTime(now - 30_000, now)).toBe("now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe("3d");
  });
});

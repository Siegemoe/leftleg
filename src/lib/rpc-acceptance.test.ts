// Acceptance suite: complete user journeys across the RPC boundary.
//
// Unlike the unit tests (which mock the api module with canned responses),
// these tests drive stores.ts through a deterministic fake `pi --mode rpc`
// process (src/test/fake-pi.ts) wired exactly like the app: commands flow
// through the same `api` module the stores call, and events flow through
// handleEvent/handlePiExit the way App.svelte wires them. Recorded protocol
// fixtures (src/test/fixtures.ts) pin the wire-format contract so drift in
// pi's event shapes fails here, not in production.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import type { SessionInfo } from "./types";
import type { AssistantItem, PiEvent, ToolItem, UserItem } from "./types";

vi.mock("./api", () => {
  const t = () => {
    const impl = (globalThis as unknown as Record<string, unknown>).__leftlegApiTransport as
      | ApiShape
      | undefined;
    if (!impl) throw new Error("api transport not wired");
    return impl;
  };
  return {
    piRequest: (command: Record<string, unknown>, timeoutSecs?: number, project?: string | null, expectedProc?: number) => t().piRequest(command, timeoutSecs, project, expectedProc),
    piSend: (line: Record<string, unknown>, project?: string | null) => t().piSend(line, project),
    piStart: (cwd: string, sessionPath?: string | null, forceRestart?: boolean) => t().piStart(cwd, sessionPath, forceRestart),
    piStop: () => t().piStop(),
    piStatus: () => t().piStatus(),
    listSessions: () => t().listSessions(),
    readGuiState: () => t().readGuiState(),
    writeGuiState: (state: Record<string, unknown>) => t().writeGuiState(state),
    getAgentDir: () => t().getAgentDir(),
  };
});

import {
  abort, activeSessionPath, boot, cloneSession, commands, composerDraft, connected,
  dismissFailedUser, dismissNotification, disconnected, exportSessionHtml, extDialog,
  extStatuses, extWidgets, handleEvent, handlePiExit, items, lastProcByProject, lastSessionFor, newSession,
  notifications, openSession, pins, projectDir, projectMeta, projectScope, queue, restartPi,
  retryFailedUser, rpcState, sendPrompt, sessionQuery, sessionStates, settled, settledView,
  settleSession, sessions, sidebarWidth, statusNote, streaming, activeSessionByProject,
  switchToProject, unsettleSession, visitedAt, togglePin,
} from "./stores";
import type { FakePi } from "./test/fake-pi";
import { FakePiHub, OTHER_PROJECT, type FakePiHubOptions } from "./test/fake-pi-hub";
import {
  FIXTURE_COMMANDS, FIXTURE_SESSIONS, PROJECT_DIR, RECORDED_ERROR_RUN, RECORDED_EXTENSION_EVENTS,
  RECORDED_RUN, SESSION_A, SESSION_A_MESSAGES, SESSION_B, SESSION_B_MESSAGES, SESSION_OTHER,
} from "./test/fixtures";

// exportSessionHtml opens a save dialog; pin it for deterministic journeys.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn().mockResolvedValue("/tmp/session-export.html"),
}));

type ApiShape = {
  piRequest: (command: Record<string, unknown>, timeoutSecs?: number, project?: string | null, expectedProc?: number) => Promise<unknown>;
  piSend: (line: Record<string, unknown>, project?: string | null) => Promise<void>;
  piStart: (project: string, sessionPath?: string | null, forceRestart?: boolean) => Promise<number>;
  piStop: (project?: string | null) => Promise<void>;
  piStatus: (project?: string | null) => Promise<boolean>;
  listSessions: () => Promise<SessionInfo[]>;
  readGuiState: () => Promise<Record<string, unknown>>;
  writeGuiState: (state: Record<string, unknown>) => Promise<void>;
  getAgentDir: () => Promise<string>;
};

function makeHub(opts: FakePiHubOptions = {}): FakePiHub {
  return new FakePiHub({
    guiState: { projectDir: PROJECT_DIR },
    commands: FIXTURE_COMMANDS,
    ...opts,
  });
}

/** Thin view over the hub's ACTIVE process so the single-project journeys
 * keep driving "the" process while the hub manages multi-project state. */
function activeFake(h: FakePiHub): FakePi {
  return new Proxy({} as FakePi, {
    get: (_, prop) => Reflect.get(h.active as object, prop),
    set: (_, prop, value) => {
      Reflect.set(h.active as object, prop, value);
      return true;
    },
  });
}

/** Wire the hub into the api module + App.svelte's event plumbing. */
function wire(h: FakePiHub) {
  (globalThis as unknown as Record<string, unknown>).__leftlegApiTransport = {
    piRequest: (command: Record<string, unknown>, timeoutSecs?: number, project?: string | null, expectedProc?: number) =>
      h.piRequest(command, timeoutSecs, project, expectedProc),
    piSend: (line: Record<string, unknown>, project?: string | null) => h.piSend(line, project),
    piStart: (project: string, sessionPath?: string | null, forceRestart?: boolean) =>
      h.piStart(project, sessionPath, forceRestart),
    piStop: (project?: string | null) => h.piStop(project),
    piStatus: (project?: string | null) => h.piStatus(project),
    listSessions: () => h.listSessions(),
    readGuiState: () => h.readGuiState(),
    writeGuiState: (state: Record<string, unknown>) => h.writeGuiState(state),
    getAgentDir: () => h.getAgentDir(),
  } satisfies ApiShape;
  h.onEvent = (project, pid, evt) => {
    void handleEvent(evt, { project, proc: pid });
  };
  h.onExit = (project, pid, expected) => handlePiExit(project, pid, expected);
}

function unplug() {
  delete (globalThis as unknown as Record<string, unknown>).__leftlegApiTransport;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
async function drain() {
  await flush();
  await flush();
}

/** Boot, then explicitly activate the test project — manual activation is the
 * product behavior now: the start scene owns the first project pick, so pi
 * only starts when a project is chosen. Resumes the project's remembered /
 * most-recent session, mirroring what the old boot auto-resume did. */
async function bootActive() {
  await boot();
  await drain();
  await switchToProject(PROJECT_DIR, lastSessionFor(PROJECT_DIR));
  await drain();
}

// jsdom lacks matchMedia; boot() subscribes to the system theme via it.
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function resetStores() {
  items.set([]);
  streaming.set(false);
  queue.set({ steering: [], followUp: [] });
  sessionStates.set({});
  rpcState.set(null);
  activeSessionPath.set(null);
  statusNote.set("");
  extDialog.set(null);
  connected.set(false);
  disconnected.set(false);
  projectDir.set("");
  notifications.set([]);
  extStatuses.set({});
  extWidgets.set({});
  commands.set([]);
  composerDraft.set(null);
  activeSessionByProject.set({});
  lastProcByProject.set({});
  pins.set([]);
  projectMeta.set({});
  visitedAt.set({});
  sidebarWidth.set(256);
  sessionQuery.set("");
  projectScope.set(null);
  settledView.set("per-project");
  settled.set([]);
}

let hub: FakePiHub;
/** Proxy over the hub's ACTIVE process — single-project journeys keep driving "the" process. */
let fake: FakePi;

beforeEach(() => {
  resetStores();
  hub = makeHub();
  wire(hub);
  fake = activeFake(hub);
});

afterEach(() => {
  unplug();
});

describe("journey: startup and session identity", () => {
  it("picking a project boots pi INTO its most recent session, with the active session derived from pi", async () => {
    await boot();
    await drain();

    // The start scene holds: no pi, no activation until a card is picked.
    expect(get(connected)).toBe(false);
    expect(hub.spawnCount(PROJECT_DIR)).toBe(0);

    await switchToProject(PROJECT_DIR, SESSION_A);
    await drain();

    expect(get(connected)).toBe(true);
    expect(hub.spawnCount(PROJECT_DIR)).toBe(1);
    // The subprocess was started with --session so prompts land in the
    // highlighted session, and the UI reflects pi's own answer.
    expect(fake.sessionFile).toBe(SESSION_A);
    expect(get(activeSessionPath)).toBe(SESSION_A);
    expect(get(rpcState)?.sessionFile).toBe(SESSION_A);
    // History of the resumed session is on screen.
    expect(get(items).map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    const tool = get(items)[2] as ToolItem;
    expect(tool.status).toBe("done");
    expect(tool.output).toContain("main.ts");
    // Last active session is remembered for the next launch.
    const map = hub.gui.lastSessionByProject as Record<string, string>;
    expect(map[PROJECT_DIR]).toBe(SESSION_A);
  });

  it("picking a project with no sessions starts a fresh one", async () => {
    hub = makeHub({ sessions: FIXTURE_SESSIONS.filter((s) => s.cwd !== PROJECT_DIR) });
    wire(hub);
    fake = activeFake(hub);

    await boot();
    await drain();

    // Start scene holds; picking the session-less project starts fresh.
    expect(hub.spawnCount(PROJECT_DIR)).toBe(0);
    await switchToProject(PROJECT_DIR);
    await drain();

    expect(hub.spawnCount(PROJECT_DIR)).toBe(1);
    expect(fake.sessionFile).toBe(`${PROJECT_DIR}/sessions/fresh-1.jsonl`);
    expect(get(activeSessionPath)).toBe(`${PROJECT_DIR}/sessions/fresh-1.jsonl`);
    expect(get(items)).toEqual([]);
  });

  it("resumes the most recent project session when the remembered one is gone", async () => {
    hub = makeHub({
      guiState: { projectDir: PROJECT_DIR, lastSessionByProject: { [PROJECT_DIR]: "/gone/deleted.jsonl" } },
    });
    wire(hub);
    fake = activeFake(hub);

    await boot();
    await drain();

    // Remembered session is gone — the start-scene pick falls back to the
    // project's most recent session.
    expect(lastSessionFor(PROJECT_DIR)).toBe(SESSION_A);
    await switchToProject(PROJECT_DIR, lastSessionFor(PROJECT_DIR));
    await drain();

    expect(fake.sessionFile).toBe(SESSION_A);
    expect(get(activeSessionPath)).toBe(SESSION_A);
  });

  it("falls back to a fresh start when pi cannot be started with a session, visibly", async () => {
    const original = hub.piStart;
    let calls = 0;
    hub.piStart = async (project: string, sessionPath?: string | null, forceRestart?: boolean) => {
      calls += 1;
      if (calls === 1) throw new Error("spawn failed");
      return original(project, sessionPath, forceRestart);
    };

    await switchToProject(PROJECT_DIR, SESSION_A);
    await drain();

    expect(get(statusNote)).toContain("starting fresh");
    expect(hub.spawnCount(PROJECT_DIR)).toBe(1);
    expect(get(connected)).toBe(true);
    expect(get(activeSessionPath)).toBe(`${PROJECT_DIR}/sessions/fresh-1.jsonl`);
  });
});

describe("journey: session selection", () => {
  beforeEach(async () => {
    await bootActive();
    await drain();
  });

  it("switches pi to the picked session and reloads its history", async () => {
    await openSession(SESSION_B);
    await drain();

    expect(fake.sessionFile).toBe(SESSION_B);
    expect(get(activeSessionPath)).toBe(SESSION_B);
    expect(get(items).map((i) => i.kind)).toEqual(["user", "assistant"]);
    const map = hub.gui.lastSessionByProject as Record<string, string>;
    expect(map[PROJECT_DIR]).toBe(SESSION_B);
  });

  it("keeps the current session when an extension cancels the switch", async () => {
    fake.cancelNextSwitch = true;

    await openSession(SESSION_B);
    await drain();

    // boot left SESSION_A active; a cancelled switch must not move the UI.
    expect(get(activeSessionPath)).toBe(SESSION_A);
    expect(fake.sessionFile).toBe(SESSION_A);
    expect(get(statusNote)).toContain("cancelled");
  });

  it("surfaces a rejected switch without touching the UI state", async () => {
    fake.failNextSwitch = "session file corrupted";

    await openSession(SESSION_B);
    await drain();

    expect(get(statusNote)).toContain("session file corrupted");
    expect(get(activeSessionPath)).toBe(SESSION_A);
    expect(fake.sessionFile).toBe(SESSION_A);
  });
});

describe("journey: prompt delivery", () => {
  beforeEach(async () => {
    await bootActive();
    await drain();
  });

  it("accepted prompt: bubble accepted, run streamed, session recorded it", async () => {
    fake.runPlan = [{ kind: "text", text: "Here is the summary." }];

    const res = await sendPrompt("Summarize the session", []);
    await drain();

    expect(res.ok).toBe(true);
    const bubble = [...get(items)].reverse().find((i) => i.kind === "user") as UserItem;
    expect(bubble.text).toBe("Summarize the session");
    expect(bubble.status).toBe("accepted");
    expect(get(streaming)).toBe(false);
    const last = get(items).at(-1) as AssistantItem;
    expect(last.kind).toBe("assistant");
    expect(last.blocks[0]).toEqual({ type: "text", text: "Here is the summary.", done: true });
    expect(fake.messages.get(SESSION_A)?.at(-1)).toMatchObject({ role: "assistant" });
    expect(fake.messages.get(SESSION_A)?.at(-2)).toMatchObject({ role: "user", content: "Summarize the session" });
  });

  it("rejected prompt: result reports failure, bubble stays visible with the error, retry resends it", async () => {
    fake.failNextPrompt = "Model not found: invalid/model";

    const res = await sendPrompt("fix the bug", []);
    await drain();

    expect(res.ok).toBe(false);
    expect(res.error).toBe("Model not found: invalid/model");
    const users = get(items).filter((i) => i.kind === "user") as UserItem[];
    expect(users).toHaveLength(2); // resumed history + the failed bubble
    const failed = users.find((u) => u.status === "failed");
    expect(failed?.text).toBe("fix the bug");
    expect(failed?.error).toContain("Model not found");
    expect(failed?.id).toBeTruthy();

    // Retry once pi accepts again.
    const retry = await retryFailedUser(failed!.id!);
    await drain();
    expect(retry.ok).toBe(true);
    const usersAfter = get(items).filter((i) => i.kind === "user") as UserItem[];
    expect(usersAfter.filter((u) => u.status === "failed")).toHaveLength(0);
    expect(usersAfter.at(-1)?.status).toBe("accepted");
    expect(get(items).at(-1)).toMatchObject({ kind: "assistant" });
  });

  it("keeps an unrelated failed bubble until it is retried or dismissed", async () => {
    fake.failNextPrompt = "temporarily rejected";
    await sendPrompt("first attempt", []);
    await drain();
    let failed = get(items).find((i) => i.kind === "user" && (i as UserItem).status === "failed") as UserItem | undefined;
    expect(failed?.text).toBe("first attempt");

    // An unrelated successful send must NOT remove the failed attempt — it was
    // never delivered, so its Retry affordance stays.
    fake.runPlan = [{ kind: "text", text: "ok" }];
    await sendPrompt("second attempt", []);
    await drain();
    failed = get(items).find((i) => i.kind === "user" && (i as UserItem).status === "failed") as UserItem | undefined;
    expect(failed?.text).toBe("first attempt");
    expect(failed?.id).toBeTruthy();

    // Retrying delivers the content and clears the failure.
    const retry = await retryFailedUser(failed!.id!);
    await drain();
    expect(retry.ok).toBe(true);
    expect(get(items).some((i) => i.kind === "user" && (i as UserItem).status === "failed")).toBe(false);
    const users = get(items).filter((i) => i.kind === "user") as UserItem[];
    expect(users.map((u) => u.text)).toEqual(["List the files in src", "second attempt", "first attempt"]);
  });

  it("a failed bubble can be dismissed without re-sending it", async () => {
    fake.failNextPrompt = "rejected";
    await sendPrompt("doomed", []);
    await drain();
    const failed = get(items).find((i) => i.kind === "user" && (i as UserItem).status === "failed") as UserItem;

    dismissFailedUser(failed.id!);

    expect(get(items).some((i) => i.kind === "user" && (i as UserItem).status === "failed")).toBe(false);
    // Dismissing never sends anything.
    expect(fake.messages.get(SESSION_A)?.some((m) => m.role === "user" && m.content === "doomed")).toBe(false);
  });

  it("prompt while pi is down: no bubble, explicit failure", async () => {
    fake.exit(true);
    await drain();
    expect(get(connected)).toBe(false);

    const before = get(items).length;
    const res = await sendPrompt("hello", []);

    expect(res.ok).toBe(false);
    expect(res.error).toContain("not running");
    expect(get(items)).toHaveLength(before);
  });
});

describe("journey: steering and abort", () => {
  beforeEach(async () => {
    await bootActive();
    await drain();
  });

  it("prompt during a run is queued as steering and delivered after the run settles", async () => {
    fake.holdNextRun = true;
    await sendPrompt("run the tests", []);
    await drain();
    expect(get(streaming)).toBe(true);

    const res2 = await sendPrompt("also lint", []);
    await drain();
    expect(res2.ok).toBe(true);
    expect(get(queue).steering).toEqual(["also lint"]);

    fake.finishHeldRun();
    await drain();

    expect(get(streaming)).toBe(false);
    expect(get(queue).steering).toEqual([]);
    const users = get(items).filter((i) => i.kind === "user") as UserItem[];
    expect(users.map((u) => u.text)).toEqual(["List the files in src", "run the tests", "also lint"]);
    expect(get(items).filter((i) => i.kind === "assistant")).toHaveLength(4); // 2 history + 2 new runs
  });

  it("abort cancels the run and the UI settles", async () => {
    const assistantsBefore = get(items).filter((i) => i.kind === "assistant").length;
    fake.holdNextRun = true;
    await sendPrompt("long task", []);
    await drain();
    expect(get(streaming)).toBe(true);

    await abort();
    await drain();

    expect(get(streaming)).toBe(false);
    expect(get(items).filter((i) => i.kind === "assistant")).toHaveLength(assistantsBefore);
  });
});

describe("journey: process exit and recovery", () => {
  beforeEach(async () => {
    await bootActive();
    await drain();
  });

  it("crash mid-run: banner shows, streaming finalizes, restart resumes the session", async () => {
    fake.holdNextRun = true;
    await sendPrompt("big refactor", []);
    await drain();
    expect(get(streaming)).toBe(true);

    fake.exit(false); // crash
    await drain();

    expect(get(connected)).toBe(false);
    expect(get(disconnected)).toBe(true);
    expect(get(streaming)).toBe(false);

    await restartPi();
    await drain();

    expect(get(connected)).toBe(true);
    expect(get(disconnected)).toBe(false);
    expect(hub.spawnCount(PROJECT_DIR)).toBe(2);
    expect(fake.sessionFile).toBe(SESSION_A);
    expect(get(activeSessionPath)).toBe(SESSION_A);
    // The transcript now reflects pi's own history: the interrupted prompt
    // never reached the session, so it is not shown as delivered.
    expect(get(items).map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("crash with the response in flight: the bubble fails with the exit reason", async () => {
    fake.holdResponses = true;
    const pending = sendPrompt("hello", []);
    await flush();
    expect((get(items).at(-1) as UserItem).status).toBe("sending");

    fake.exit(false);
    const res = await pending;
    await drain();

    expect(res.ok).toBe(false);
    expect(res.error).toContain("pi exited before responding");
    expect((get(items).at(-1) as UserItem).status).toBe("failed");
    expect(get(disconnected)).toBe(true);
  });

  it("deliberate stop is quiet: no crash banner", async () => {
    await hub.piStop();
    await drain();

    expect(get(connected)).toBe(false);
    expect(get(disconnected)).toBe(false);
    expect(get(statusNote)).toBe("pi stopped");
  });

  it("falls back visibly to a fresh start when the crashed session was never persisted", async () => {
    // pi can report a sessionFile before the file exists on disk (the file is
    // created when the first message is persisted). The resume start is then
    // rejected by the file check — recovery must still succeed.
    activeSessionPath.set(`${PROJECT_DIR}/sessions/unpersisted.jsonl`);
    fake.exit(false);
    await drain();
    expect(get(disconnected)).toBe(true);

    await restartPi();
    await drain();

    expect(get(connected)).toBe(true);
    expect(get(disconnected)).toBe(false);
    expect(hub.spawnCount(PROJECT_DIR)).toBe(2);
    // No phantom resume: pi is in a fresh session and the note says so.
    expect(fake.sessionFile).toBe(`${PROJECT_DIR}/sessions/fresh-1.jsonl`);
    expect(get(activeSessionPath)).toBe(`${PROJECT_DIR}/sessions/fresh-1.jsonl`);
    expect(get(statusNote)).toContain("starting fresh");
  });
});

describe("journey: extension surfaces", () => {
  beforeEach(async () => {
    await bootActive();
    await drain();
  });

  it("recorded extension events surface in notifications, status, widgets, title, editor draft, and dialogs", async () => {
    for (const evt of RECORDED_EXTENSION_EVENTS) fake.emit(evt);
    await drain();

    // notify → toast stack (warning, info, sticky error)
    const notes = get(notifications);
    expect(notes.map((n) => n.notifyType)).toEqual(["warning", "info", "error"]);
    // setStatus → "draft" cleared, "review" remains
    expect(get(extStatuses)).toEqual({ review: "Turn 3 running..." });
    // setWidget → "timer" cleared, "plan" remains above the editor
    expect(Object.keys(get(extWidgets))).toEqual(["plan"]);
    expect(get(extWidgets)["plan"]?.lines).toEqual(["--- Plan ---", "1. read", "2. edit"]);
    expect(get(extWidgets)["plan"]?.placement).toBe("aboveEditor");
    // setTitle → window title
    expect(document.title).toBe("pi - demo");
    // set_editor_text → composer draft request
    expect(get(composerDraft)?.text).toBe("Continue with step 2");
    // interactive dialog still opens
    expect(get(extDialog)).toMatchObject({ id: "d1", method: "select", options: ["Allow", "Deny"] });

    dismissNotification(notes[2].id);
    expect(get(notifications)).toHaveLength(2);
  });

  it("command discovery: pi's executable commands are available for the composer", async () => {
    // boot already ran refreshCommands against the fake pi
    expect(get(commands)).toEqual(FIXTURE_COMMANDS);
  });

  it("extension state dies with the process", async () => {
    fake.emit({ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "review", statusText: "busy" } as never);
    fake.emit({
      type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "plan",
      widgetLines: ["--- Plan ---"], widgetPlacement: "aboveEditor",
    } as never);
    fake.emit({ type: "extension_ui_request", id: "d2", method: "confirm", title: "Allow?", message: "run cmd" } as never);
    await drain();
    expect(get(extStatuses)).toEqual({ review: "busy" });
    expect(get(extDialog)).not.toBeNull();

    fake.exit(false);
    await drain();

    expect(get(extStatuses)).toEqual({});
    expect(get(extWidgets)).toEqual({});
    // The dialog must not survive the process: it would cover recovery
    // controls and fail on answer (the process that asked is gone).
    expect(get(extDialog)).toBeNull();
  });
});

describe("recorded protocol replay (compatibility drift guard)", () => {
  it("a recorded streaming run assembles the expected transcript", async () => {
    for (const evt of RECORDED_RUN) await handleEvent(evt);

    const list = get(items);
    expect(list.map((i) => i.kind)).toEqual(["assistant", "tool"]);
    const assistant = list[0] as AssistantItem;
    expect(assistant.blocks.map((b) => b.type)).toEqual(["thinking", "text", "toolcall"]);
    expect(assistant.blocks[1]).toEqual({ type: "text", text: "Editing stores.ts…", done: true });
    expect(assistant.streaming).toBe(false);
    expect(assistant.usage?.totalTokens).toBe(290);
    expect(assistant.stopReason).toBe("toolUse");
    const tool = list[1] as ToolItem;
    expect(tool.toolCallId).toBe("call-2");
    expect(tool.name).toBe("edit");
    expect(tool.args).toBe(JSON.stringify({ path: "src/stores.ts", changes: 1 }, null, 2));
    expect(tool.status).toBe("done");
    expect(tool.output).toBe("Applied 1 edit to src/stores.ts");
    expect(tool.diff).toBe("@@ -1 +1 @@\n-old line\n+new line");
    expect(tool.isError).toBe(false);
  });

  it("a recorded provider error marks the assistant item and the session", async () => {
    activeSessionPath.set(SESSION_A);
    for (const evt of RECORDED_ERROR_RUN) await handleEvent(evt);

    const assistant = get(items)[0] as AssistantItem;
    expect(assistant.stopReason).toBe("error");
    expect(assistant.errorMessage).toBe("provider quota exceeded");
    expect(get(sessionStates)[SESSION_A]).toEqual({ status: "attention", note: "error in response" });
  });
});

describe("journey: session actions", () => {
  beforeEach(async () => {
    await bootActive();
    await drain();
  });

  it("exports the active session to the chosen path", async () => {
    const res = await exportSessionHtml();
    await drain();

    expect(res.ok).toBe(true);
    expect(res.path).toBe("/tmp/session-export.html");
    expect(get(statusNote)).toContain("Session exported");
  });

  it("clone duplicates the session and switches to it", async () => {
    const before = fake.messages.get(SESSION_A)!.length;

    const res = await cloneSession();
    await drain();

    expect(res.ok).toBe(true);
    const cloned = `${PROJECT_DIR}/sessions/fresh-1.jsonl`;
    expect(fake.sessionFile).toBe(cloned);
    expect(fake.messages.get(cloned)!.length).toBe(before);
    expect(get(activeSessionPath)).toBe(cloned);
  });
});

describe("journey: multi-project orchestration", () => {
  beforeEach(async () => {
    await bootActive();
    await drain();
  });

  it("restores a partial assistant and continues its deltas after refocusing", async () => {
    const demo = hub.forProject(PROJECT_DIR)!;
    demo.busy = true;
    demo.emit({ type: "agent_start" });
    demo.emit({ type: "message_start", message: { role: "assistant" } });
    demo.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    demo.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Before " } });
    await openSession(SESSION_OTHER);
    demo.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "during " } });
    await openSession(SESSION_A);
    expect(get(streaming)).toBe(true);
    demo.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "after" } });
    const last = get(items).at(-1) as AssistantItem;
    expect(last.blocks).toEqual([{ type: "text", text: "Before during after", done: false }]);
  });

  it("restores background extension questions, without leaking widgets to another project", async () => {
    const demo = hub.forProject(PROJECT_DIR)!;
    demo.emit({ type: "extension_ui_request", method: "setWidget", widgetKey: "plan", widgetLines: ["Demo only"] });
    await openSession(SESSION_OTHER);
    expect(get(extWidgets)).toEqual({});
    demo.emit({ type: "extension_ui_request", id: "question", method: "confirm", title: "Proceed?" });
    expect(get(extDialog)).toBeNull();
    expect(get(sessionStates)[SESSION_A].status).toBe("attention");
    await openSession(SESSION_A);
    expect(get(extDialog)).toMatchObject({ id: "question", project: PROJECT_DIR });
    expect(get(extWidgets).plan.lines).toEqual(["Demo only"]);
  });

  it("serializes rapid project opens and persists the final focus", async () => {
    await Promise.all([openSession(SESSION_OTHER), openSession(SESSION_B)]);
    expect(get(projectDir)).toBe(PROJECT_DIR);
    expect(get(activeSessionPath)).toBe(SESSION_B);
    expect(hub.active.sessionFile).toBe(SESSION_B);
    expect(hub.gui.projectDir).toBe(PROJECT_DIR);
  });

  it("opening another project's session spawns its process, switches focus, and leaves the first running", async () => {
    fake.holdNextRun = true;
    await sendPrompt("work on demo", []);
    await drain();
    expect(get(streaming)).toBe(true);

    await openSession(SESSION_OTHER);
    await drain();

    expect(get(projectDir)).toBe(OTHER_PROJECT);
    expect(get(activeSessionPath)).toBe(SESSION_OTHER);
    expect(hub.active.sessionFile).toBe(SESSION_OTHER);
    expect(hub.isRunning(PROJECT_DIR)).toBe(true);
    expect(hub.spawnCount(OTHER_PROJECT)).toBe(1);
    // The chat surface was reset for the incoming project.
    expect(get(items)).toEqual([]);
    expect(get(streaming)).toBe(false);

    // The background project finishes its run: sidebar status updates, chat untouched.
    const demo = hub.forProject(PROJECT_DIR)!;
    demo.finishHeldRun();
    await drain();
    expect(get(sessionStates)[SESSION_A]).toEqual({ status: "idle", note: "" });
    expect(get(items)).toEqual([]);

    // Going back reuses the running process (no new spawn) and restores history
    // including the work the background process recorded.
    const spawnsBefore = hub.spawnCount(PROJECT_DIR);
    await openSession(SESSION_A);
    await drain();
    expect(get(projectDir)).toBe(PROJECT_DIR);
    expect(hub.spawnCount(PROJECT_DIR)).toBe(spawnsBefore);
    expect(get(items).map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant", "user", "assistant"]);
  });

  it("a background project's crash marks its session without touching the active chat", async () => {
    // Move focus to the other project so the demo project runs in the background.
    await openSession(SESSION_OTHER);
    await drain();
    const demo = hub.forProject(PROJECT_DIR)!;
    demo.exit(false);
    await drain();

    expect(get(connected)).toBe(true);
    expect(get(disconnected)).toBe(false);
    expect(hub.isRunning(PROJECT_DIR)).toBe(false);
    expect(get(sessionStates)[SESSION_A]).toEqual({ status: "attention", note: "process exited" });
  });

  it("stale envelopes from a replaced process are dropped", async () => {
    const current = get(lastProcByProject)[PROJECT_DIR];

    await handleEvent({ type: "agent_start" }, { project: PROJECT_DIR, proc: current - 1 });
    expect(get(streaming)).toBe(false); // stale — dropped

    await handleEvent({ type: "agent_start" }, { project: PROJECT_DIR, proc: current });
    expect(get(streaming)).toBe(true); // live — applied
  });

  it("pinning a session persists into GUI state", async () => {
    togglePin(SESSION_A);
    expect(hub.gui.pins).toContain(SESSION_A);
    togglePin(SESSION_A);
    expect(hub.gui.pins).not.toContain(SESSION_A);
  });

  it("new sessions populate the list without being auto-settled; settle/unsettle persists", async () => {
    await newSession();
    await drain();
    const fresh = get(activeSessionPath)!;

    // The fresh session shows up in the session list…
    expect(get(sessions).some((s) => s.path === fresh)).toBe(true);
    // …and is NOT archived on creation — settling is explicit.
    expect(get(settled)).not.toContain(fresh);

    settleSession(fresh);
    await drain();
    expect(get(settled)).toContain(fresh);
    expect(hub.gui.settled).toContain(fresh);

    unsettleSession(fresh);
    await drain();
    expect(get(settled)).not.toContain(fresh);
    expect(hub.gui.settled).not.toContain(fresh);
  });
});

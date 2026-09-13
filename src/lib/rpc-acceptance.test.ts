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
    piRequest: (command: Record<string, unknown>, timeoutSecs?: number) => t().piRequest(command, timeoutSecs),
    piSend: (line: Record<string, unknown>) => t().piSend(line),
    piStart: (cwd: string, sessionPath?: string | null) => t().piStart(cwd, sessionPath),
    piStop: () => t().piStop(),
    piStatus: () => t().piStatus(),
    listSessions: () => t().listSessions(),
    readGuiState: () => t().readGuiState(),
    writeGuiState: (state: Record<string, unknown>) => t().writeGuiState(state),
    readFileBase64: (path: string) => t().readFileBase64(path),
    getAgentDir: () => t().getAgentDir(),
  };
});

import {
  abort, activeSessionPath, boot, commands, composerDraft, connected, dismissNotification,
  disconnected, extDialog, extStatuses, extWidgets, handleEvent, handlePiExit, items,
  notifications, openSession, projectDir, queue, restartPi, retryFailedUser, rpcState, sendPrompt,
  sessionStates, statusNote, streaming,
} from "./stores";
import { FakePi, type FakePiOptions } from "./test/fake-pi";
import {
  FIXTURE_COMMANDS, FIXTURE_SESSIONS, PROJECT_DIR, RECORDED_ERROR_RUN, RECORDED_EXTENSION_EVENTS,
  RECORDED_RUN, SESSION_A, SESSION_A_MESSAGES, SESSION_B, SESSION_B_MESSAGES,
} from "./test/fixtures";

type ApiShape = {
  piRequest: (command: Record<string, unknown>, timeoutSecs?: number) => Promise<unknown>;
  piSend: (line: Record<string, unknown>) => Promise<void>;
  piStart: (cwd: string, sessionPath?: string | null) => Promise<void>;
  piStop: () => Promise<void>;
  piStatus: () => Promise<boolean>;
  listSessions: () => Promise<SessionInfo[]>;
  readGuiState: () => Promise<Record<string, unknown>>;
  writeGuiState: (state: Record<string, unknown>) => Promise<void>;
  readFileBase64: (path: string) => Promise<string>;
  getAgentDir: () => Promise<string>;
};

function makeFake(opts: FakePiOptions = {}): FakePi {
  return new FakePi({
    sessions: FIXTURE_SESSIONS,
    guiState: { projectDir: PROJECT_DIR },
    messagesBySession: { [SESSION_A]: SESSION_A_MESSAGES, [SESSION_B]: SESSION_B_MESSAGES },
    ...opts,
  });
}

/** Wire the fake into the api module + App.svelte's event plumbing. */
function wire(p: FakePi) {
  (globalThis as unknown as Record<string, unknown>).__leftlegApiTransport = {
    piRequest: (command: Record<string, unknown>, timeoutSecs?: number) => p.piRequest(command, timeoutSecs),
    piSend: (line: Record<string, unknown>) => p.piSend(line),
    piStart: (cwd: string, sessionPath?: string | null) => p.piStart(cwd, sessionPath),
    piStop: () => p.piStop(),
    piStatus: () => p.piStatus(),
    listSessions: () => p.listSessions(),
    readGuiState: () => p.readGuiState(),
    writeGuiState: (state: Record<string, unknown>) => p.writeGuiState(state),
    readFileBase64: (path: string) => p.readFileBase64(path),
    getAgentDir: () => p.getAgentDir(),
  } satisfies ApiShape;
  p.onEvent = (evt) => { void handleEvent(evt); };
  p.onExit = (payload) => handlePiExit(payload.expected);
}

function unplug() {
  delete (globalThis as unknown as Record<string, unknown>).__leftlegApiTransport;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
async function drain() {
  await flush();
  await flush();
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
}

let fake: FakePi;

beforeEach(() => {
  resetStores();
  fake = makeFake();
  wire(fake);
});

afterEach(() => {
  unplug();
});

describe("journey: startup and session identity", () => {
  it("boots pi INTO the project's most recent session, with the active session derived from pi", async () => {
    await boot();
    await drain();

    expect(get(connected)).toBe(true);
    expect(fake.started).toBe(1);
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
    const map = fake.gui.lastSessionByProject as Record<string, string>;
    expect(map[PROJECT_DIR]).toBe(SESSION_A);
  });

  it("boots a fresh session when the project has none yet", async () => {
    fake = makeFake({
      sessions: FIXTURE_SESSIONS.filter((s) => s.cwd !== PROJECT_DIR),
      guiState: { projectDir: PROJECT_DIR },
    });
    wire(fake);

    await boot();
    await drain();

    expect(fake.started).toBe(1);
    expect(fake.sessionFile).toBe(`${PROJECT_DIR}/sessions/fresh-1.jsonl`);
    expect(get(activeSessionPath)).toBe(`${PROJECT_DIR}/sessions/fresh-1.jsonl`);
    expect(get(items)).toEqual([]);
  });

  it("falls back to the most recent project session when the remembered one is gone", async () => {
    fake = makeFake({
      guiState: { projectDir: PROJECT_DIR, lastSessionByProject: { [PROJECT_DIR]: "/gone/deleted.jsonl" } },
    });
    wire(fake);

    await boot();
    await drain();

    expect(fake.sessionFile).toBe(SESSION_A);
    expect(get(activeSessionPath)).toBe(SESSION_A);
  });

  it("falls back to a fresh start when pi cannot be started with a session, visibly", async () => {
    const original = fake.piStart;
    let calls = 0;
    fake.piStart = async (cwd: string, sessionPath?: string | null) => {
      calls += 1;
      if (calls === 1) throw new Error("spawn failed");
      return original(cwd, sessionPath);
    };

    await boot();
    await drain();

    expect(get(statusNote)).toContain("starting fresh");
    expect(fake.started).toBe(1);
    expect(get(connected)).toBe(true);
    expect(get(activeSessionPath)).toBe(`${PROJECT_DIR}/sessions/fresh-1.jsonl`);
  });
});

describe("journey: session selection", () => {
  beforeEach(async () => {
    await boot();
    await drain();
  });

  it("switches pi to the picked session and reloads its history", async () => {
    await openSession(SESSION_B);
    await drain();

    expect(fake.sessionFile).toBe(SESSION_B);
    expect(get(activeSessionPath)).toBe(SESSION_B);
    expect(get(items).map((i) => i.kind)).toEqual(["user", "assistant"]);
    const map = fake.gui.lastSessionByProject as Record<string, string>;
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
    await boot();
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

  it("a later successful send supersedes stale failed bubbles", async () => {
    fake.failNextPrompt = "temporarily rejected";
    await sendPrompt("first attempt", []);
    await drain();
    expect((get(items).at(-1) as UserItem).status).toBe("failed");

    fake.runPlan = [{ kind: "text", text: "ok" }];
    await sendPrompt("second attempt", []);
    await drain();

    const users = get(items).filter((i) => i.kind === "user") as UserItem[];
    // resumed history + the successful send; the stale failed bubble is gone
    expect(users.map((u) => u.text)).toEqual(["List the files in src", "second attempt"]);
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
    await boot();
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
    await boot();
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
    expect(fake.started).toBe(2);
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
    await fake.piStop();
    await drain();

    expect(get(connected)).toBe(false);
    expect(get(disconnected)).toBe(false);
    expect(get(statusNote)).toBe("pi stopped");
  });
});

describe("journey: extension surfaces", () => {
  beforeEach(async () => {
    await boot();
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
    await drain();
    expect(get(extStatuses)).toEqual({ review: "busy" });

    fake.exit(false);
    await drain();

    expect(get(extStatuses)).toEqual({});
    expect(get(extWidgets)).toEqual({});
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

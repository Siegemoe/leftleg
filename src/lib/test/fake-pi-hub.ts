// Multi-project fake over FakePi: one deterministic fake process per project,
// pid-tagged envelopes, reuse-on-live semantics matching the Rust bridge.
import { FakePi, type FakePiOptions } from "./fake-pi";
import type { PiEvent, SessionInfo } from "../types";
import { FIXTURE_SESSIONS, PROJECT_DIR, SESSION_A_MESSAGES, SESSION_B_MESSAGES } from "./fixtures";

export const OTHER_PROJECT = "/other";

/** Default per-project fixtures (session histories for the demo project). */
function defaultOptionsFor(project: string): Partial<FakePiOptions> {
  if (project === PROJECT_DIR) {
    return {
      messagesBySession: {
        [`${PROJECT_DIR}/sessions/a.jsonl`]: SESSION_A_MESSAGES,
        [`${PROJECT_DIR}/sessions/b.jsonl`]: SESSION_B_MESSAGES,
      },
    };
  }
  return {};
}

export interface FakePiHubOptions {
  guiState?: Record<string, unknown>;
  sessions?: SessionInfo[];
  commands?: import("../types").ExtCommand[];
  /** Per-project FakePi option overrides (sessions, scripts, ...). */
  optionsByProject?: Record<string, Partial<FakePiOptions>>;
}

export class FakePiHub {
  sessions: SessionInfo[];
  gui: Record<string, unknown>;
  commands: import("../types").ExtCommand[];
  activeProject: string | null = null;

  private fakes = new Map<string, { fake: FakePi; pid: number }>();
  private spawnCounts = new Map<string, number>();
  private nextPid = 0;
  private optionsByProject: Record<string, Partial<FakePiOptions>>;

  onEvent: (project: string, pid: number, evt: PiEvent) => void = () => {};
  onExit: (project: string, pid: number, expected: boolean) => void = () => {};

  constructor(opts: FakePiHubOptions = {}) {
    this.sessions = opts.sessions ?? FIXTURE_SESSIONS;
    this.gui = opts.guiState ?? {};
    this.commands = opts.commands ?? [];
    this.optionsByProject = opts.optionsByProject ?? {};
  }

  private optionsFor(project: string): FakePiOptions {
    const base: FakePiOptions = {
      projectDir: project,
      sessions: this.sessions.filter((s) => s.cwd === project),
      guiState: {},
      commands: this.commands,
      ...defaultOptionsFor(project),
    };
    return { ...base, ...this.optionsByProject[project] };
  }

  /** The active project's fake (single-project tests drive the app through it). */
  get active(): FakePi {
    if (!this.activeProject) throw new Error("no active process");
    return this.forProject(this.activeProject)!;
  }

  forProject(project: string): FakePi | undefined {
    return this.fakes.get(project)?.fake;
  }

  isRunning(project: string): boolean {
    return this.fakes.get(project)?.fake.alive ?? false;
  }

  spawnCount(project: string): number {
    return this.spawnCounts.get(project) ?? 0;
  }

  piRequest = (
    command: Record<string, unknown>,
    timeoutSecs?: number,
    project?: string | null,
    expectedProc?: number,
  ): Promise<unknown> => {
    const key = project ?? this.activeProject;
    if (expectedProc !== undefined && this.fakes.get(key ?? "")?.pid !== expectedProc)
      return Promise.reject(new Error("pi process replaced before request dispatch"));
    return this.resolve(project).piRequest(command, timeoutSecs);
  };

  piSend = (line: Record<string, unknown>, project?: string | null): Promise<void> =>
    this.resolve(project).piSend(line);

  piStart = async (
    project: string,
    sessionPath?: string | null,
    forceRestart?: boolean,
  ): Promise<number> => {
    const existing = this.fakes.get(project);
    if (existing && existing.fake.alive && !forceRestart) {
      this.activeProject = project;
      return existing.pid;
    }
    if (existing) {
      existing.fake.exit(true);
      this.fakes.delete(project);
    }
    this.nextPid += 1;
    const pid = this.nextPid;
    const fake = new FakePi(this.optionsFor(project));
    fake.onEvent = (evt) => this.onEvent(project, pid, evt);
    fake.onExit = (payload) => this.onExit(project, pid, payload.expected);
    // Validate before registering: a failed start must leave the previous
    // process and the active pointer untouched (mirrors the Rust bridge).
    await fake.piStart(project, sessionPath);
    this.fakes.set(project, { fake, pid });
    this.spawnCounts.set(project, this.spawnCount(project) + 1);
    this.activeProject = project;
    return pid;
  };

  piStop = async (project?: string | null): Promise<void> => {
    const key = project ?? this.activeProject;
    const entry = key ? this.fakes.get(key) : undefined;
    if (!entry || !key)
      throw new Error(key ? `pi process not running for ${key}` : "no active pi process");
    this.fakes.delete(key);
    if (this.activeProject === key) this.activeProject = null;
    await entry.fake.piStop();
  };

  piStatus = (project?: string | null): Promise<boolean> => {
    const key = project ?? this.activeProject;
    return Promise.resolve(key ? this.isRunning(key) : false);
  };

  listSessions = (): Promise<SessionInfo[]> => {
    // Mirror sessions.rs: report every session the processes know about,
    // including freshly created ones (a new session must populate the list).
    const known = new Set(this.sessions.map((s) => s.path));
    const extras: SessionInfo[] = [];
    for (const [project, entry] of this.fakes) {
      for (const path of entry.fake.messages.keys()) {
        if (!known.has(path)) {
          known.add(path);
          extras.push({
            path,
            cwd: project,
            timestamp: new Date().toISOString(),
            fileModified: Date.now(),
            sessionId: path.split(/[\\/]/).pop() ?? path,
            name: null,
            firstMessage: null,
          });
        }
      }
    }
    return Promise.resolve([...this.sessions, ...extras]);
  };
  readGuiState = (): Promise<Record<string, unknown>> =>
    Promise.resolve(JSON.parse(JSON.stringify(this.gui)));
  writeGuiState = async (state: Record<string, unknown>): Promise<void> => {
    this.gui = JSON.parse(JSON.stringify(state));
  };
  getAgentDir = (): Promise<string> => Promise.resolve("/home/test/.pi/agent");

  private resolve(project?: string | null): FakePi {
    const key = project ?? this.activeProject;
    const entry = key ? this.fakes.get(key) : undefined;
    if (!entry || !key) {
      throw new Error(key ? `pi process not running for ${key}` : "no active pi process");
    }
    return entry.fake;
  }
}

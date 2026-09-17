// A deterministic fake `pi --mode rpc` process for acceptance tests.
//
// It implements the same JSONL command/response contract as the real pi
// subprocess (see pi docs/rpc.md): requests get correlated responses with
// `success: true/false`, and the agent emits events on stdout. The test
// wires `onEvent`/`onExit` to the same handlers App.svelte uses, so the
// journeys exercise the exact wiring the app runs in production.
//
// Determinism: runs are emitted synchronously; two hold-points let tests
// freeze mid-flight — `holdNextRun` (prompt accepted, run events withheld)
// and `holdResponses` (request responses withheld until released).

import type {
  AgentMessage, ContentBlock, ExtCommand, ModelInfo,
  PiEvent, RpcState, SessionInfo, SessionStats, ThinkingLevel,
} from "../types";
import { FIXTURE_COMMANDS, PROJECT_DIR } from "./fixtures";

export type RunStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown>; output: string; isError?: boolean }
  | { kind: "error"; message: string };

export interface FakePiOptions {
  projectDir?: string;
  sessions?: SessionInfo[];
  guiState?: Record<string, unknown>;
  commands?: ExtCommand[];
  messagesBySession?: Record<string, AgentMessage[]>;
  model?: ModelInfo;
}

const DEFAULT_MODEL: ModelInfo = {
  id: "claude-opus-4-8",
  name: "Claude Opus 4.8",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 16_384,
};

let seq = 0;
function nextToolCallId(): string {
  seq += 1;
  return `call-${seq}`;
}

export class FakePi {
  alive = false;
  projectDir: string;
  sessions: SessionInfo[];
  gui: Record<string, unknown>;
  commands: ExtCommand[];
  messages = new Map<string, AgentMessage[]>();
  sessionFile: string | null = null;
  sessionName: string | null = null;
  thinkingLevel: ThinkingLevel = "medium";
  model: ModelInfo;
  busy = false;
  steeringQueue: string[] = [];
  followUpQueue: string[] = [];
  started = 0;
  stopped = 0;

  // scripted behaviors
  failNextPrompt: string | null = null;
  failNextSwitch: string | null = null;
  cancelNextSwitch = false;
  holdNextRun = false;
  holdResponses = false;
  runPlan: RunStep[] | null = null;

  // event sinks — tests wire these to handleEvent/handlePiExit like App.svelte
  onEvent: (evt: PiEvent) => void = () => {};
  onExit: (payload: { expected: boolean }) => void = () => {};

  private deferred: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void; compute: () => unknown }> = [];
  private pendingRun: string | null = null;
  private freshCount = 0;
  private tsBase = Date.parse("2026-01-01T10:00:00.000Z");
  private tsTick = 0;

  constructor(opts: FakePiOptions = {}) {
    this.projectDir = opts.projectDir ?? PROJECT_DIR;
    this.sessions = opts.sessions ?? [];
    this.gui = opts.guiState ?? {};
    this.commands = opts.commands ?? FIXTURE_COMMANDS;
    this.model = opts.model ?? DEFAULT_MODEL;
    for (const [path, msgs] of Object.entries(opts.messagesBySession ?? {})) {
      this.messages.set(path, [...msgs]);
    }
  }

  // ---- Tauri-command transport (the `api` module surface) ----

  piRequest = (command: Record<string, unknown>, _timeoutSecs?: number): Promise<unknown> =>
    this.request(command);

  piSend = async (line: Record<string, unknown>): Promise<void> => {
    // fire-and-forget stdin lines (extension_ui_response)
    if (!this.alive) throw new Error("pi process not running");
    void line;
  };

  piStart = async (cwd: string, sessionPath?: string | null): Promise<void> => {
    if (cwd !== this.projectDir) throw new Error(`not a directory: ${cwd}`);
    if (sessionPath) {
      const known = this.sessions.some((s) => s.path === sessionPath) || this.messages.has(sessionPath);
      if (!known) throw new Error(`session file not found: ${sessionPath}`);
      this.sessionFile = sessionPath;
      if (!this.messages.has(sessionPath)) this.messages.set(sessionPath, []);
    } else {
      this.freshCount += 1;
      this.sessionFile = `${this.projectDir}/sessions/fresh-${this.freshCount}.jsonl`;
      if (!this.messages.has(this.sessionFile)) this.messages.set(this.sessionFile, []);
    }
    this.alive = true;
    this.started += 1;
    this.busy = false;
    this.pendingRun = null;
    this.steeringQueue = [];
    this.followUpQueue = [];
  };

  piStop = async (): Promise<void> => {
    this.stopped += 1;
    this.kill(true);
  };

  piStatus = async (): Promise<boolean> => this.alive;

  listSessions = async (): Promise<SessionInfo[]> => this.sessions.map((s) => ({ ...s }));

  readGuiState = async (): Promise<Record<string, unknown>> => JSON.parse(JSON.stringify(this.gui)) as Record<string, unknown>;

  writeGuiState = async (state: Record<string, unknown>): Promise<void> => {
    this.gui = JSON.parse(JSON.stringify(state));
  };

  getAgentDir = async (): Promise<string> => "/home/test/.pi/agent";

  // ---- process lifecycle ----

  /** Simulate the process dying. expected=false → crash, true → deliberate stop. */
  exit(expected: boolean) {
    this.kill(expected);
  }

  private kill(expected: boolean) {
    const wasAlive = this.alive;
    this.alive = false;
    this.busy = false;
    this.pendingRun = null;
    const held = this.deferred.splice(0);
    for (const d of held) d.reject(new Error("pi exited before responding"));
    if (wasAlive || !expected) this.onExit({ expected });
  }

  // ---- RPC request handling ----

  request(command: Record<string, unknown>): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error("pi process not running"));
    if (this.holdResponses) {
      return new Promise((resolve, reject) => {
        this.deferred.push({ resolve, reject, compute: () => this.processCommand(command) });
      });
    }
    return Promise.resolve(this.processCommand(command));
  }

  /** Resolve withheld responses (in source order). */
  releaseResponses() {
    const held = this.deferred.splice(0);
    for (const d of held) d.resolve(d.compute());
  }

  /** Push an event through the stdout wire (tests inject recorded events). */
  emit(evt: PiEvent) {
    this.onEvent(evt);
  }

  /** Finish a run that was withheld via holdNextRun. */
  finishHeldRun() {
    const message = this.pendingRun;
    this.pendingRun = null;
    if (message === null) return;
    this.run(message);
  }

  private respond(cmd: Record<string, unknown>, success: boolean, data?: unknown, error?: string) {
    const res: Record<string, unknown> = {
      type: "response",
      command: cmd.type ?? "unknown",
      success,
    };
    if (cmd.id !== undefined) res.id = cmd.id;
    if (success && data !== undefined) res.data = data;
    if (!success) res.error = error ?? "command failed";
    return res;
  }

  private get currentMessages(): AgentMessage[] {
    if (!this.sessionFile) return [];
    let list = this.messages.get(this.sessionFile);
    if (!list) {
      list = [];
      this.messages.set(this.sessionFile, list);
    }
    return list;
  }

  private append(msg: AgentMessage) {
    this.currentMessages.push(msg);
  }

  private stamp(): number {
    this.tsTick += 1;
    return this.tsBase + this.tsTick;
  }

  private processCommand(cmd: Record<string, unknown>): unknown {
    switch (cmd.type) {
      case "get_state":
        return this.respond(cmd, true, this.stateData());
      case "get_messages":
        return this.respond(cmd, true, { messages: this.currentMessages.map((m) => structuredClone(m)) });
      case "get_session_stats":
        return this.respond(cmd, true, this.statsData());
      case "get_available_models":
        return this.respond(cmd, true, { models: [this.model] });
      case "set_model": {
        const provider = String(cmd.provider ?? "");
        const modelId = String(cmd.modelId ?? "");
        if (provider !== this.model.provider || modelId !== this.model.id) {
          return this.respond(cmd, false, undefined, `Model not found: ${provider}/${modelId}`);
        }
        return this.respond(cmd, true, this.model);
      }
      case "set_thinking_level":
        this.thinkingLevel = String(cmd.level ?? "off") as ThinkingLevel;
        return this.respond(cmd, true, {});
      case "set_steering_mode":
      case "set_follow_up_mode":
      case "set_auto_compaction":
      case "set_auto_retry":
        return this.respond(cmd, true, {});
      case "set_session_name":
        this.sessionName = String(cmd.name ?? "");
        return this.respond(cmd, true, {});
      case "get_commands":
        return this.respond(cmd, true, { commands: this.commands });
      case "switch_session":
        return this.handleSwitch(cmd, String(cmd.sessionPath ?? ""));
      case "new_session":
        return this.handleSwitch(cmd, null);
      case "prompt":
        return this.handlePrompt(cmd);
      case "steer": {
        this.steeringQueue.push(String(cmd.message ?? ""));
        this.emitQueueUpdate();
        return this.respond(cmd, true);
      }
      case "follow_up": {
        this.followUpQueue.push(String(cmd.message ?? ""));
        this.emitQueueUpdate();
        return this.respond(cmd, true);
      }
      case "clear_queue": {
        this.steeringQueue = [];
        this.followUpQueue = [];
        this.emitQueueUpdate();
        return this.respond(cmd, true);
      }
      case "abort": {
        if (this.busy) {
          // pi aborts the run and waits for the session to become idle.
          this.busy = false;
          this.pendingRun = null;
          this.emit({ type: "agent_end", messages: [], willRetry: false });
          this.emit({ type: "agent_settled" });
        }
        return this.respond(cmd, true);
      }
      case "compact":
        return this.respond(cmd, true, { tokensBefore: 100, estimatedTokensAfter: 40 });
      case "abort_retry":
        return this.respond(cmd, true);
      case "export_html":
        return this.respond(cmd, true, { path: String(cmd.outputPath ?? `${this.projectDir}/session-export.html`) });
      case "clone": {
        if (this.cancelNextSwitch) {
          this.cancelNextSwitch = false;
          return this.respond(cmd, true, { cancelled: true });
        }
        // Duplicate the active branch into a new session and switch to it.
        this.freshCount += 1;
        const target = `${this.projectDir}/sessions/fresh-${this.freshCount}.jsonl`;
        this.messages.set(target, this.currentMessages.map((m) => structuredClone(m)));
        this.sessionFile = target;
        return this.respond(cmd, true, { cancelled: false });
      }
      default:
        return this.respond(cmd, false, undefined, `unknown command: ${String(cmd.type)}`);
    }
  }

  private stateData(): RpcState {
    return {
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.busy,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      sessionFile: this.sessionFile ?? undefined,
      sessionId: this.sessionFile?.split("/").pop()?.replace(".jsonl", "").split("-")[0],
      sessionName: this.sessionName ?? undefined,
      autoCompactionEnabled: true,
      messageCount: this.currentMessages.length,
      pendingMessageCount: this.steeringQueue.length + this.followUpQueue.length,
    };
  }

  private statsData(): SessionStats {
    const msgs = this.currentMessages;
    const userMessages = msgs.filter((m) => m.role === "user").length;
    const assistantMessages = msgs.filter((m) => m.role === "assistant").length;
    const toolCalls = msgs.reduce((n, m) => (
      n + (Array.isArray(m.content) ? m.content.filter((c) => c.type === "toolCall").length : 0)
    ), 0);
    return {
      sessionFile: this.sessionFile ?? undefined,
      userMessages,
      assistantMessages,
      toolCalls,
      totalMessages: msgs.length,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      cost: 0.01,
      contextUsage: { tokens: 150, contextWindow: this.model.contextWindow, percent: 1 },
    };
  }

  private handleSwitch(cmd: Record<string, unknown>, sessionPath: string | null): unknown {
    if (this.failNextSwitch) {
      const error = this.failNextSwitch;
      this.failNextSwitch = null;
      return this.respond(cmd, false, undefined, error);
    }
    if (this.cancelNextSwitch) {
      this.cancelNextSwitch = false;
      return this.respond(cmd, true, { cancelled: true });
    }
    if (sessionPath === null) {
      // new_session
      this.freshCount += 1;
      this.sessionFile = `${this.projectDir}/sessions/fresh-${this.freshCount}.jsonl`;
      if (!this.messages.has(this.sessionFile)) this.messages.set(this.sessionFile, []);
      this.sessionName = null;
    } else {
      const known = this.sessions.some((s) => s.path === sessionPath) || this.messages.has(sessionPath);
      if (!known) return this.respond(cmd, false, undefined, `session not found: ${sessionPath}`);
      this.sessionFile = sessionPath;
      if (!this.messages.has(sessionPath)) this.messages.set(sessionPath, []);
    }
    return this.respond(cmd, true, { cancelled: false });
  }

  private handlePrompt(cmd: Record<string, unknown>): unknown {
    const message = String(cmd.message ?? "");
    if (!message.trim()) return this.respond(cmd, false, undefined, "empty message");
    if (this.failNextPrompt) {
      const error = this.failNextPrompt;
      this.failNextPrompt = null;
      return this.respond(cmd, false, undefined, error);
    }
    if (this.busy) {
      const behavior = String(cmd.streamingBehavior ?? "");
      if (!behavior) {
        return this.respond(cmd, false, undefined, "agent is streaming; specify streamingBehavior to queue");
      }
      const q = behavior === "followUp" ? this.followUpQueue : this.steeringQueue;
      q.push(message);
      this.emitQueueUpdate();
      return this.respond(cmd, true);
    }
    if (this.holdNextRun) {
      // pi accepted the prompt and started the run; events withheld for tests.
      this.holdNextRun = false;
      this.pendingRun = message;
      this.busy = true;
      this.emit({ type: "agent_start" });
      return this.respond(cmd, true);
    }
    this.run(message);
    return this.respond(cmd, true);
  }

  private emitQueueUpdate() {
    this.emit({ type: "queue_update", steering: [...this.steeringQueue], followUp: [...this.followUpQueue] });
  }

  /** Execute a full agent run: user message → scripted steps → settle. */
  private run(message: string) {
    this.busy = true;
    this.emit({ type: "agent_start" });
    this.append({ role: "user", content: message, timestamp: this.stamp() });
    const steps: RunStep[] = this.runPlan ?? [{ kind: "text", text: `Done: ${message}` }];
    for (const step of steps) this.executeStep(step);
    this.emit({ type: "agent_end", messages: [], willRetry: false });
    this.settleOrContinue();
  }

  private executeStep(step: RunStep) {
    if (step.kind === "text") {
      this.emit({ type: "message_start", message: { role: "assistant" } });
      this.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
      this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: step.text } });
      this.emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: step.text } });
      const assistant: AgentMessage = {
        role: "assistant",
        content: [{ type: "text", text: step.text }],
        stopReason: "stop",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        timestamp: this.stamp(),
      };
      this.emit({ type: "message_end", message: assistant });
      this.append(assistant);
      return;
    }
    if (step.kind === "tool") {
      const id = nextToolCallId();
      const blocks: ContentBlock[] = [{ type: "toolCall", id, name: step.name, arguments: step.args }];
      this.emit({ type: "message_start", message: { role: "assistant" } });
      this.emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", id, toolName: step.name } });
      this.emit({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_end", toolCall: { id, name: step.name, arguments: step.args } },
      });
      this.emit({ type: "tool_execution_start", toolCallId: id, toolName: step.name, args: step.args });
      this.emit({
        type: "tool_execution_update",
        toolCallId: id,
        partialResult: { content: [{ type: "text", text: "working…" }] },
      });
      this.emit({
        type: "tool_execution_end",
        toolCallId: id,
        isError: !!step.isError,
        result: { content: [{ type: "text", text: step.output }] },
      });
      const assistant: AgentMessage = {
        role: "assistant",
        content: blocks,
        stopReason: "toolUse",
        timestamp: this.stamp(),
      };
      this.emit({ type: "message_end", message: assistant });
      this.append(assistant);
      this.append({
        role: "toolResult",
        toolCallId: id,
        toolName: step.name,
        content: [{ type: "text", text: step.output }],
        isError: !!step.isError,
      });
      return;
    }
    // error step
    this.emit({ type: "message_start", message: { role: "assistant" } });
    const failed: AgentMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: step.message,
      timestamp: this.stamp(),
    };
    this.emit({ type: "message_end", message: failed });
    this.append(failed);
  }

  /** After a run: deliver queued steering, then follow-ups, then settle. */
  private settleOrContinue() {
    const steered = this.steeringQueue.shift();
    if (steered !== undefined) {
      this.emitQueueUpdate();
      this.run(steered);
      return;
    }
    if (this.steeringQueue.length === 0 && this.followUpQueue.length > 0) {
      const next = this.followUpQueue.shift();
      this.emitQueueUpdate();
      if (next !== undefined) {
        this.run(next);
        return;
      }
    }
    this.emitQueueUpdate();
    this.busy = false;
    this.emit({ type: "agent_settled" });
  }
}

// Mirrors of pi's RPC protocol types (see pi docs/rpc.md).

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelInfo {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface RpcState {
  model: ModelInfo | null;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface AgentMessage {
  role: "user" | "assistant" | "toolResult" | "bashExecution" | string;
  content?: string | ContentBlock[];
  thinking?: string;
  toolCallId?: string;
  toolName?: string;
  command?: string;
  output?: string;
  exitCode?: number;
  isError?: boolean;
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  timestamp?: number;
  attachments?: Array<{ type: string; fileName?: string; mimeType?: string; content?: string }>;
}

export interface SessionMessage {
  role: string;
  content?: string | ContentBlock[];
  [key: string]: unknown;
}

export interface SessionStats {
  sessionFile?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalMessages: number;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: number;
  contextUsage?: { tokens: number; contextWindow: number; percent: number } | null;
}

export interface SessionInfo {
  path: string;
  cwd: string;
  timestamp: string;
  fileModified: number;
  sessionId: string;
  name: string | null;
  firstMessage: string | null;
}

// ---- Leftleg UI item model ----

export type Block =
  | { type: "text"; text: string; done: boolean }
  | { type: "thinking"; text: string; done: boolean }
  | { type: "toolcall"; toolCallId: string; name: string; args: string };

export type ToolStatus = "running" | "done" | "error";

export interface ToolItem {
  kind: "tool";
  toolCallId: string;
  name: string;
  args: string;
  status: ToolStatus;
  output: string;
  outputTruncated: boolean;
  isError: boolean;
  diff?: string;
}

export interface UserItem {
  kind: "user";
  text: string;
  images: { name: string; dataUrl: string }[];
  /**
   * Delivery state of an optimistically-added bubble.
   * - "sending": request in flight
   * - "accepted": pi confirmed the prompt (or it came from session history)
   * - "failed": pi rejected it (success:false) or the RPC failed — kept visible with a Retry affordance
   * Items rebuilt from history have no status (accepted by definition).
   */
  status?: "sending" | "accepted" | "failed";
  id?: string; // client-side id for retry targeting (only on optimistic bubbles)
  error?: string;
}

export interface AssistantItem {
  kind: "assistant";
  blocks: Block[];
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
  streaming: boolean;
}

export interface BashItem {
  kind: "bash";
  command: string;
  output: string;
  exitCode: number;
  isError: boolean;
}

export type UiItem = UserItem | AssistantItem | ToolItem | BashItem;

// ---- pi events ----

/** Payload of the Tauri `pi-exit` event (emitted when the pi subprocess dies). */
export interface PiExitEvent {
  /** true: we killed it on purpose (user stop/restart) — no crash banner. */
  expected: boolean;
}

/** A command pi can execute via `prompt` (extension command, prompt template, or skill). */
export interface ExtCommand {
  name: string;
  description?: string;
  source?: string;
}

export interface AssistantDeltaEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  /** Full content carried by text_end/thinking_end events. */
  content?: string;
  id?: string;
  toolName?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
}

export interface PiEvent {
  type: string;
  [key: string]: unknown;
  assistantMessageEvent?: AssistantDeltaEvent;
  message?: AgentMessage;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: { content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown> };
  result?: { content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; tokensBefore?: number; estimatedTokensAfter?: number };
  isError?: boolean;
  usage?: Usage;
  // extension ui
  id?: string;
  method?: string;
  title?: string;
  options?: string[];
}

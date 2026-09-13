import { invoke } from "@tauri-apps/api/core";

// All RPC commands go through the Rust bridge, which correlates ids.

export function piRequest<T = unknown>(command: Record<string, unknown>, timeoutSecs = 120): Promise<T> {
  return invoke("pi_request", { command, timeoutSecs });
}

export function piSend(line: Record<string, unknown>): Promise<void> {
  return invoke("pi_send", { line });
}

export function piStart(cwd: string, sessionPath?: string | null): Promise<void> {
  return invoke("pi_start", { cwd, sessionPath: sessionPath ?? null });
}

export function piStop(): Promise<void> {
  return invoke("pi_stop");
}

export function piStatus(): Promise<boolean> {
  return invoke("pi_status");
}

export function listSessions() {
  return invoke<import("./types").SessionInfo[]>("list_sessions");
}

export function readGuiState(): Promise<Record<string, unknown>> {
  return invoke("read_gui_state");
}

export function writeGuiState(state: Record<string, unknown>): Promise<void> {
  return invoke("write_gui_state", { state });
}

export function readFileBase64(path: string): Promise<string> {
  return invoke("read_file_base64", { path });
}

export function getAgentDir(): Promise<string> {
  return invoke("get_agent_dir");
}

import { invoke } from "@tauri-apps/api/core";

// All RPC commands go through the Rust bridge, which correlates ids.
// Commands without an explicit `project` target the ACTIVE project's process;
// background projects are addressed by passing their dir.

export function piRequest<T = unknown>(
  command: Record<string, unknown>,
  timeoutSecs = 120,
  project?: string | null,
  expectedProc?: number,
): Promise<T> {
  return invoke("pi_request", { command, timeoutSecs, project: project ?? null, expectedProc: expectedProc ?? null });
}

export function piSend(line: Record<string, unknown>, project?: string | null, expectedProc?: number): Promise<void> {
  return invoke("pi_send", { line, project: project ?? null, expectedProc: expectedProc ?? null });
}

/** Start (or refocus) a project's process. Returns the process id, which the
 * UI records so stale envelopes from a replaced process can be dropped. */
export function piStart(
  project: string,
  sessionPath?: string | null,
  forceRestart?: boolean,
): Promise<number> {
  return invoke("pi_start", {
    project,
    sessionPath: sessionPath ?? null,
    forceRestart: forceRestart ?? false,
  });
}

export function piStop(project?: string | null): Promise<void> {
  return invoke("pi_stop", { project: project ?? null });
}

export function piStatus(project?: string | null): Promise<boolean> {
  return invoke("pi_status", { project: project ?? null });
}

export function listSessions() {
  return invoke<import("./types").SessionInfo[]>("list_sessions");
}

export function readGuiState(): Promise<Record<string, unknown>> {
  return invoke("read_gui_state");
}

let guiWriteTail: Promise<void> = Promise.resolve();
export function writeGuiState(state: Record<string, unknown>): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(state));
  const write = guiWriteTail.then(() => invoke<void>("write_gui_state", { state: snapshot }));
  guiWriteTail = write.catch(() => {});
  return write;
}

export function readFileBase64(path: string): Promise<string> {
  return invoke("read_file_base64", { path });
}

export function getAgentDir(): Promise<string> {
  return invoke("get_agent_dir");
}

/** Explicitly install the settings companion into <agent_dir>/extensions (guarded). */
export function writeAgentExtension(relPath: string, content: string): Promise<void> {
  return invoke("write_agent_extension", { relPath, content });
}

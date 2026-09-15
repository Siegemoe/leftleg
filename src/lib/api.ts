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
let guiWritesPending = 0;
export function writeGuiState(state: Record<string, unknown>): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(state));
  guiWritesPending++;
  const write = guiWriteTail
    .then(() => invoke<void>("write_gui_state", { state: snapshot }))
    .finally(() => { guiWritesPending--; });
  guiWriteTail = write.catch(() => {});
  return write;
}

/** Synchronous lifecycle signal used by the update install guard. */
export function pendingGuiWriteCount(): number {
  return guiWritesPending;
}

/** Stop every Pi process and reject new native Pi work before Windows exits. */
export function prepareForUpdate(): Promise<number> {
  return invoke("prepare_for_update");
}

/** Re-open native Pi commands if launching the installer fails. */
export function cancelUpdateShutdown(): Promise<void> {
  return invoke("cancel_update_shutdown");
}

export function readFileBase64(path: string): Promise<string> {
  return invoke("read_file_base64", { path });
}

export interface ArtifactFile {
  name: string;
  path: string;
  size: number;
  modifiedMs: number;
  exists: boolean;
}

export interface ArtifactsReport {
  images: ArtifactFile[];
  docs: ArtifactFile[];
}

/** Project-scoped artifacts: .pi/images outputs + canonical docs. */
export function listArtifacts(projectDir: string): Promise<ArtifactsReport> {
  return invoke("list_artifacts", { projectDir });
}

/** Delete one image artifact (guarded to <project>/.pi/images). */
export function deleteArtifact(projectDir: string, path: string): Promise<void> {
  return invoke("delete_artifact", { projectDir, path });
}

export interface GitRepoInfo {
  repo: boolean;
  branch: string;
  dirty: number;
  toplevel: string;
}

/** Git checkout info for a project (branch, dirty count, worktree root). */
export function gitRepoInfo(projectDir: string): Promise<GitRepoInfo> {
  return invoke("git_repo_info", { projectDir });
}

export interface PiModuleInfo {
  name: string;
  version: string;
  path: string;
}

/** Identity of the installed pi module (npm package name + version). */
export function piModuleInfo(): Promise<PiModuleInfo> {
  return invoke("pi_module_info");
}

export interface PiManagerResult {
  exitCode: number;
  stdout: string;
}

/** Run `pi update` with allowlisted flags via the guarded Rust runner. */
export function runPiManager(flags: string[]): Promise<PiManagerResult> {
  return invoke("run_pi_manager", { flags });
}

export interface ExtensionIntegrity {
  source: string;
  trusted: boolean;
}

export interface PiIntegrityReport {
  extensions: ExtensionIntegrity[];
}

/** Read-only integrity report over the user's pi extension sources. */
export function piIntegrityReport(): Promise<PiIntegrityReport> {
  return invoke("pi_integrity_report");
}

export function getAgentDir(): Promise<string> {
  return invoke("get_agent_dir");
}

/** Explicitly install the settings companion into <agent_dir>/extensions (guarded). */
export function writeAgentExtension(relPath: string, content: string): Promise<void> {
  return invoke("write_agent_extension", { relPath, content });
}

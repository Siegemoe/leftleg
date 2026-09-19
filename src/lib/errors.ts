import { invoke } from "@tauri-apps/api/core";
import { statusNote } from "./stores";
import { get } from "svelte/store";

export function reportError(kind: string, detail: string) {
  const line = `[${new Date().toISOString()}] ${kind}: ${detail}`;
  console.error(line);
  const note = `⚠ ${detail}`;
  statusNote.set(note);
  setTimeout(() => {
    if (get(statusNote) === note) statusNote.set("");
  }, 15000);
  void invoke("append_log", { line }).catch(() => {});
}

import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { boot, statusNote } from "./lib/stores";
import { invoke } from "@tauri-apps/api/core";

const app = mount(App, { target: document.getElementById("app")! });

// Global error trap: surface every uncaught error visibly and on disk.
// A silent failure mode (clicks doing nothing) is worse than an ugly one.
function logError(kind: string, detail: string) {
  const line = `[${new Date().toISOString()}] ${kind}: ${detail}`;
  console.error(line);
  statusNote.set(kind === "error" ? `⚠ ${detail}` : `⚠ ${detail}`);
  setTimeout(() => statusNote.set(""), 15000);
  try {
    invoke("append_log", { line }).catch(() => { /* disk may not be ready */ });
  } catch { /* ipc not ready */ }
}

window.addEventListener("error", (e) => {
  const stack = e.error?.stack ? `\n${e.error.stack}` : "";
  logError("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}${stack}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  logError("unhandledrejection", typeof r === "string" ? r : (r?.message ?? JSON.stringify(r)));
});

boot().catch((e) => {
  logError("boot", String(e?.stack ?? e));
});

export default app;

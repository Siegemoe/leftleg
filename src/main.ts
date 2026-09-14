import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { reportError as logError } from "./lib/errors";

window.addEventListener("error", (e) => {
  const stack = e.error?.stack ? `\n${e.error.stack}` : "";
  logError("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}${stack}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  logError("unhandledrejection", typeof r === "string" ? r : (r?.message ?? JSON.stringify(r)));
});

const app = mount(App, { target: document.getElementById("app")! });

export default app;

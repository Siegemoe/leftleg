# Leftleg — Project Instructions (read this first)

**Leftleg** is a native desktop control surface for the [Pi coding agent](https://github.com/earendil-works/pi-mono), built with Tauri 2 (Rust) + Svelte 5.

**Core philosophy:** Pi is the harness/runtime and owns all agent state (sessions, credentials, extensions, settings). Leftleg owns **only GUI concerns** and treats the pi RPC protocol as the single integration surface. Do not duplicate agent state in the GUI.

## Architecture (one paragraph)

The Rust layer (`src-tauri/`) spawns `pi --mode rpc` as a subprocess rooted at the chosen project directory, speaks strict JSONL over stdin/stdout (split on `\n` only, strip `\r`), correlates request ids, and forwards every non-response event to the webview via Tauri events (`pi-event`). The Svelte frontend (`src/`) renders agent state from those events and issues RPC commands (`prompt`, `steer`, `abort`, `set_model`, `switch_session`, …) through `invoke("pi_request")`. Extension UI requests (`extension_ui_request`) are surfaced as dialogs and answered with `extension_ui_response`. Reference: pi's `docs/rpc.md`.

## Repo layout

- `src-tauri/src/pi.rs` — RPC bridge: spawn, JSONL framing, request correlation, event forwarding
- `src-tauri/src/sessions.rs` — session listing (parses `~/.pi/agent/sessions/**/*.jsonl` headers), GUI state persistence, base64 file reading
- `src-tauri/src/lib.rs` — Tauri commands (`pi_start/stop/status/request/send`, `list_sessions`, `read/write_gui_state`, `append_log`)
- `src/lib/stores.ts` — central state: RPC event handling, UI item assembly, all agent actions (`sendPrompt`, `openSession`, …)
- `src/lib/api.ts` — typed `invoke` wrappers. `src/lib/types.ts` — RPC protocol mirrors
- `src/components/` — Sidebar, Chat, MessageView, ToolCard, Composer, StatusBar, SettingsModal, ExtDialog
- `docs/` — `ARCHITECTURE.md` (deep dive), `ROADMAP.md` (what's next)

## Rules

1. **After any frontend change:** `npm run build` must pass — it runs `svelte-check` (0 errors, 0 warnings) **and the vitest unit tests** (`npm run test`) before `vite build`, so template type errors and logic regressions fail at build time, not at runtime. After any Rust change: `npm run check:rust`, and `npm run test:rust` if you touched framing/parsing logic (`cargo test` covers JSONL line classification, pending-map correlation, session header parsing, first-user-message extraction, base64). Full release: `npm run tauri build`. Never ship a bare `cargo build --release` exe — without the `tauri/custom-protocol` feature it embeds the dev URL (`localhost:1420`) and shows ERR_CONNECTION_REFUSED outside dev mode. If NSIS bundling is flaky, the exe from `npm run tauri build` (or `cargo build --release --features tauri/custom-protocol`) can be copied directly to `%LOCALAPPDATA%/Leftleg/`.
2. **Svelte 5 syntax only:** `onclick`/`oninput` (not `on:click`), `$state`/`$derived`/`$effect` runes allowed. Inside `$derived.by`, always use `$storeName` (auto-subscription) — a bare store reference is the store *object* and will crash with "not iterable" at minified runtime (this exact bug shipped once — see git history).
3. **Tauri 2 capabilities are explicit:** `src-tauri/capabilities/default.json` grants `core:default`, `dialog:default`, `opener:default`. Any new plugin needs a permission entry there or its invokes silently fail.
4. **Commands in `lib.rs` root must be `fn`, not `pub fn`** — `#[tauri::command]` + `pub` at crate root triggers a `#[macro_export]` re-export collision (E0255).
5. **Errors must never be silent:** `main.ts` installs a global trap that shows a visible banner and appends to `%APPDATA%/dev.leftleg.app/logs/leftleg.log`. When debugging, read that log first. Devtools are enabled in release builds (right-click → Inspect).
6. **pi is authoritative for agent state.** GUI state lives only in `readGuiState/writeGuiState` (theme, projectDir, sidebar). Never persist messages, sessions, or model config in Leftleg.
7. **Default model for the user's stack:** `openrouter/z-ai/glm-5.3-flash` (1M ctx). GLM models are available via OpenRouter only on this machine.

## Build / run

- Dev: `npm run tauri dev` (vite hot reload; cargo debug build)
- Release + installer: `npm run tauri build` → NSIS installer in `src-tauri/target/release/bundle/nsis/`
- Rust toolchain: stable-msvc. MSVC Build Tools are installed. Rust is at `~/.cargo/bin` (add to PATH in fresh shells).

## Current status

See `docs/ROADMAP.md`. The repo is the source of truth for what works: check `git log --oneline`.

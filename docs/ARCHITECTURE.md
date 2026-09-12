# Leftleg Architecture

## Process topology

```
┌─────────────────────────────┐
│ Leftleg.exe (Tauri 2)       │
│                             │
│  ┌───────────┐   ┌──────────────────────┐
│  │ Svelte 5  │   │ Rust supervisor       │
│  │ webview   │──▶│ - spawn cmd /C pi     │
│  │           │   │ - JSONL stdin/stdout  │
│  └───────────┘   │ - id correlation      │
│      ▲           │ - event forwarding    │
│      └───────────┘                       │
└─────────────────────────────┘
        │ spawns (per project dir)
        ▼
  pi --mode rpc  ──▶ ~/.pi/agent (extensions, skills, settings, sessions)
```

## Rust side (`src-tauri/`)

### `pi.rs` — the bridge
- `PiProcess::spawn(app, cwd)`: `cmd /C pi --mode rpc` with `CREATE_NO_WINDOW`, piped stdin/stdout.
- Reader thread: reads stdout as raw bytes, **splits on `\n` only** (pi's RPC uses strict JSONL; do not use generic line readers that split on Unicode separators), strips trailing `\r`, parses JSON.
- Dispatch: `type:"response"` with a known `id` resolves the pending request (one-shot mpsc channel). Everything else is forwarded to the webview with `app.emit("pi-event", value)`.
- On stream end → `pi-exit` event, pending map cleared.
- `request(proc, cmd, timeout)`: assigns an id (`ll-N`) if absent, registers a pending sender, writes the line, blocks with timeout, cleans up on timeout.

### `lib.rs` — Tauri commands
| Command | Purpose |
|---|---|
| `pi_start(cwd)` | kill existing, spawn new pi for project dir |
| `pi_stop` / `pi_status` | lifecycle |
| `pi_request(command, timeout_secs)` | correlated RPC round-trip |
| `pi_send(line)` | fire-and-forget (extension_ui_response) |
| `list_sessions()` | scan `~/.pi/agent/sessions/*/*.jsonl` headers |
| `read/write_gui_state` | Leftleg's own prefs (app_data/leftleg.json) |
| `read_file_base64(path)` | attachments |
| `append_log(line)` | JS error trap → app_data/logs/leftleg.log |

### `sessions.rs` — session listing
Parses the `type:"session"` header line (v3 tree format) for `id`, `timestamp`, `cwd`. Derives a display title from the latest `type:"session_info"` entry (written by `set_session_name`) or the first user message. Sorted by file mtime, newest first.

## Frontend (`src/`)

### State flow
`boot()` → read GUI prefs → apply theme → start pi for projectDir → `get_state` + `get_available_models` → resume most recent session (`switch_session` + `get_messages`) → `get_session_stats`.

### Event assembly (`stores.ts handleEvent`)
- `message_start` (assistant) → new streaming `AssistantItem`
- `message_update` deltas → text/thinking blocks by `contentIndex`; `toolcall_*` → `ToolItem`s
- `message_end` → authoritative rebuild of the assistant item (blocks, usage, stopReason)
- `tool_execution_start/update/end` → tool card status/output/diff (edit tool exposes `details.diff`/`details.patch`)
- `queue_update`, `compaction_*`, `auto_retry_*` → status bar
- `extension_ui_request` → `ExtDialog` → `extension_ui_response`

### UI item model
`UserItem | AssistantItem | ToolItem | BashItem` — `rebuildFromMessages()` reconstructs the full list from `get_messages` (pairing toolResults to toolCalls by `toolCallId`); live events mutate the same shapes.

### Theming
CSS custom properties on `html[data-theme="light"|"dark"]`; "system" follows `prefers-color-scheme` with a live `matchMedia` listener.

## RPC protocol notes (from pi docs/rpc.md)
- Prompt during streaming requires `streamingBehavior: "steer" | "followUp"`.
- `get_entries` supports a durable `since` cursor (not yet used by Leftleg).
- Extension dialog methods (`select/confirm/input/editor`) block until answered; timeout auto-resolves agent-side.
- Sessions are JSONL trees (v3): entries have `id`/`parentId`; `switch_session`, `fork`, `clone` operate on paths/entry ids.

## Known sharp edges (all shipped bugs, see git log)
1. Bare store refs inside `$derived.by` crash minified builds — always `$store`.
2. `pub fn` + `#[tauri::command]` at crate root = E0255 macro collision.
3. Missing capability entries = silent plugin failures.
4. Vite must ignore `src-tauri/target` in its watcher (EBUSY on Windows).

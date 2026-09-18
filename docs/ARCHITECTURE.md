# Leftleg architecture

Leftleg is a Tauri 2 / Svelte 5 desktop view of Pi. Pi owns agent sessions, model configuration, credentials, tools, extensions, and conversation persistence. Leftleg persists only GUI preferences. See `AUDIT-2026-09-17.md` for the latest audit — verification loop and remaining limits.

## Processes and RPC

`PiState` owns one process per project and a focus pointer. `pi_start(project, session_path, force_restart)` reuses a live process unless restart is requested. On Windows, the bridge locates the npm `pi.cmd` installation, resolves the package's `bin.pi` entry, and launches it directly with Node. Session paths are argv values; they never pass through shell expansion.

The reader in `pi.rs` splits stdout on LF only, removes a trailing CR, and classifies JSON lines. Known response IDs resolve pending requests; other lines become `pi-event` envelopes containing project, process generation, and event. Process exit produces `pi-exit` with the same ownership metadata.

`pi_request` resolves the named project and optionally checks the expected process generation, then waits on a blocking worker rather than the UI thread. Duplicate pending IDs are rejected. Failed sends, timeout, EOF, and deliberate stop clean up pending requests. Deliberate stop terminates the process tree before acquiring stdin, so a blocked pipe writer cannot deadlock shutdown. App exit stops the owned processes.

Session scanning and attachment reads also use blocking workers. Attachment reads are bounded to 20 MiB. GUI preference writes are serialized by the API wrapper and use temporary-file replacement in the destination directory.

## Frontend ownership

`stores.ts` serializes project/session navigation. RPC calls capture project, process generation, and a view revision; stale responses cannot update the newly selected view. Process generations are also checked at the Rust dispatch boundary.

Each live process has a transient rendered surface: message cards, partial assistant blocks, queue, extension statuses/widgets/dialogs, and status note. The same reducer handles foreground and background events. Switching focus restores the appropriate surface, preserving partial messages and pending extension questions. These caches are never written to disk. Completed history is reconstructed from Pi's `get_messages`; snapshots that race newer stream events are deferred until the run settles.

Unsent composer drafts and in-flight send flags are held in memory per project/session. Successful sends clear only the submitted draft revision. Replies update the originating project's delivery state even if focus changed.

Extension dialogs are queued and replies are addressed to their owning project/generation. Management replies are consumed before notification rendering, including for background projects. Event listeners are installed before boot starts Pi.

## Shell and theming

The shell (`App.svelte`) is a row: the `Sidebar` is a full-height child, and a `.right-col` column holds everything to its right — the working area (`PromptRail` beside `main`, with the resizable `RightPanel` card at the right edge) and the `StatusBar`, so the bar's left edge follows the sidebar's edge and spans the full window only when the sidebar is hidden. The chat column (`Chat.svelte` wraps the scroller and the `Composer` in one `.col`) is `min(100%, 50vw)`, centered with auto margins: it holds half the window as the side panels open and close, and shrinks only when panels squeeze the remaining space below that — the column owns the width, and the Composer no longer self-caps. `PromptRail.svelte` draws one tick per user prompt in the transcript in view; clicking a tick scrolls the chat to that prompt, and a scroll-spy in `Chat.svelte` publishes the active tick through the `activePromptId` store. The right panel hosts the Status and Artifacts cards plus the Diff and Files docks; Subagents, Browser, and Terminal remain placeholders.

Theming is monochrome by rule: `app.css` sets `--accent` to near-black on light and near-white on dark, with `--on-accent` as the text/icon color on accent fills and `--accent-soft` tints following the theme; color is reserved for indicators (ok/danger/warning) and per-project identity, never chrome. `NewProjectCard.svelte` (modal above Settings, reachable from the sidebar scope picker, the settings project manager, and File → New Project…) is backed by the native `create_project_dir` command: one validated folder name under an absolute parent, rejecting reserved Windows device names, >200 UTF-16 units, and separators/wildcards/control chars; an existing directory opens idempotently, an existing file is refused. The parent is deliberately not containment-checked — a documented mkdir-anywhere primitive, directories only. Copy actions flip in place to a green "Copied" chip for 2s and stay silent on success; failures still surface as status notes.

The title bar's logo is the way back to the start view: `goHome()` runs inside the navigation gate, saves the active project's surface, and clears the working set (items, queue, drafts, extension state, commands/models/stats/rpcState) — the project's pi process keeps running in the background, so returning restores the view mid-stream, the same path as any project switch. The start view collapses the right panel by default (`homePanelCollapsed`): it is a default, not a lock — any dock button reopens the panel, and entering a project clears it. `ProjectSettingsCard.svelte` (modal card opened from the scope picker's per-row gear or a project right-click) presents the Settings projects-section controls for any project without switching to it; its "Advanced settings…" hop opens the full modal scoped to that project. All webview accelerators live in `src/lib/keybindings.ts` — a pure registry (defaults plus GUI-state-persisted user overrides) that TitleBar dispatches through; Settings' Key bindings section captures combinations (Ctrl/Cmd + key; Escape reserved for cancel) and refuses duplicates by naming the action that owns them. The status bar carries no global idle/working label: each sidebar session row renders its own pulsing "working" chip from the same session-state store that drives the row pills.

## Settings

`settings/mgmt.ts` sends the reserved `/settings-mgmt` extension command. It requires the command to be available, binds requests to a project/generation, observes both the RPC acknowledgement and notify reply, and bounds waiting with a timeout. Settings forms retain a binding to the process that supplied their data; switching projects or restarting remounts the workspace.

The companion in `companion/leftleg-settings/index.ts` exposes an allowlist of configuration resources. Content hashes detect stale revisions. Merge operations preserve unknown siblings; namespace replacement is used when deletion/replacement is intentional. A write can include `unsetKeys` so resets and edits commit together under one revision. Temporary files are created beside the destination, making rename work across installations on different drives. Generated model caches remain read-only through both JSON and raw write operations.

The `companion/leftleg-media/index.ts` companion registers the `image_generate` agent tool: OpenRouter's Image API invoked as an explicit, agent-visible tool call, with the credential resolved through pi's model registry (never read from files, never logged or persisted by Leftleg). Images are saved project-scoped under `.pi/images/` with timestamped, prompt-slugged names via atomic tmp+rename writes; the tool result reports saved paths and OpenRouter's reported cost.

Only the two companion installation paths (settings, media) are accepted by the native installer command. No changes in the audit are installed into the user's live Pi directory automatically.

## Verification

`npm run build` runs Svelte checks, Vitest, and Vite. Tests include mounted components, deterministic multi-project RPC journeys, and the real settings companion inside an isolated offline Pi process. `npm run check:rust` and `npm run test:rust` cover native compilation and protocol/file/process helpers. Native packaging must use the Tauri custom-protocol build; a plain Cargo release executable is not a distributable app.

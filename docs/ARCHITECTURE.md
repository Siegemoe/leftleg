# Leftleg architecture

Leftleg is a Tauri 2 / Svelte 5 desktop view of Pi. Pi owns agent sessions, model configuration, credentials, tools, extensions, and conversation persistence. Leftleg persists only GUI preferences. See `AUDIT-2026-09-13.md` for verification and remaining limits.

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

## Settings

`settings/mgmt.ts` sends the reserved `/settings-mgmt` extension command. It requires the command to be available, binds requests to a project/generation, observes both the RPC acknowledgement and notify reply, and bounds waiting with a timeout. Settings forms retain a binding to the process that supplied their data; switching projects or restarting remounts the workspace.

The companion in `companion/leftleg-settings/index.ts` exposes an allowlist of configuration resources. Content hashes detect stale revisions. Merge operations preserve unknown siblings; namespace replacement is used when deletion/replacement is intentional. A write can include `unsetKeys` so resets and edits commit together under one revision. Temporary files are created beside the destination, making rename work across installations on different drives. Generated model caches remain read-only through both JSON and raw write operations.

Only the companion installation path is accepted by the native installer command. No changes in the audit are installed into the user's live Pi directory automatically.

## Verification

`npm run build` runs Svelte checks, Vitest, and Vite. Tests include mounted components, deterministic multi-project RPC journeys, and the real settings companion inside an isolated offline Pi process. `npm run check:rust` and `npm run test:rust` cover native compilation and protocol/file/process helpers. Native packaging must use the Tauri custom-protocol build; a plain Cargo release executable is not a distributable app.

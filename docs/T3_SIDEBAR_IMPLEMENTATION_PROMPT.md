# Implementation prompt: match T3's modern sidebar in Leftleg

Implement the sidebar behavior described below in Leftleg. Read this entire prompt and the referenced source before editing. This is an implementation task, including verification, not a request for another proposal.

## Outcome and scope

I use T3 Code and want the same everyday sidebar interactions in Leftleg: finding projects and sessions, creating sessions, pinning, arranging, settling, reopening, and seeing accurate activity. Match the modern T3 sidebar's layout and behavior closely while retaining Leftleg's theme and Pi integration.

Success: those interactions work consistently with several projects, many sessions, background activity, and an application restart.

Failure to catch: a sidebar that looks similar but silently equates an idle agent with finished work, loses manual order, renames the wrong session, or interrupts work when I use an unrelated row action.

Proof: source-derived behavior tests, mounted UI interaction checks, and an exercised desktop sidebar. A green build alone does not demonstrate parity.

This task covers the local desktop sidebar. T3's remote environments, worktrees, PR integration, mobile UI, subagent browser, full-message command-palette search, and server automations that run while the GUI is closed are outside this implementation. Snoozing and file-drop attachment are separate parity gaps: record them explicitly; do not add placeholder controls. Do not report complete T3 feature parity when these remain. Do not expand into memory extraction, auto titles, Godot, or shared terminals.

## Reference: inspect source instead of guessing

Read `C:/dev/active/pi-agent-gui/AGENTS.md` first. Check the current worktree and preserve unrelated changes. The comparison was made against Leftleg commit `20d6754`; recheck relevant code if it has changed.

The local reference repository is `C:/dev/scratch/t3code`, remote `https://github.com/pingdotgg/t3code`, examined at commit `0e0ddaeedf30698bec131caf040a8e8d7b2e3f37`. Treat it as read-only. If Git reports dubious ownership, use a command-scoped `-c safe.directory=C:/dev/scratch/t3code`; do not modify global Git configuration. If its checkout has moved, inspect the pinned revision with `git show`.

Target **Sidebar.tsx**, not **LegacySidebar.tsx**. T3's `legacySidebarEnabled` setting defaults to false. If my installed app uses the legacy sidebar, that is a different target; do not combine the two designs.

Read these files under `C:/dev/scratch/t3code/`:

- `docs/user/thread-sidebar.md`: interaction rules, especially pinning, ordering, settlement, and scroll preservation.
- `apps/web/src/components/AppSidebarLayout.tsx`: modern versus legacy selection.
- `apps/web/src/components/Sidebar.tsx`: section classification, project scope, search keyboard handling, row actions, drag integration, selected history visibility, and header composition. Read relevant sections rather than repeatedly dumping this large file.
- `apps/web/src/components/Sidebar.logic.ts` and adjacent tests: `planSidebarThreadDrop`, `applySidebarThreadDrop`, `hasUnseenCompletion`, `searchSidebarThreads`, `sortSettledThreadsForSidebar`, and `resolveThreadStatusPill`. Follow imported ordering helpers to their actual implementation when needed.
- `apps/web/src/components/sidebar/SidebarThreadHeader.tsx` and `apps/web/src/components/threadSidebarWidth.ts`: header and dimensions.
- Adjacent `Sidebar.drag`, `Sidebar.motion`, and `Sidebar.pointer` helpers/tests as needed for insertion gaps and pointer behavior.

In Leftleg, inspect `src/components/Sidebar.svelte`, `src/components/SessionRow.svelte`, `src/lib/sidebar-model.ts`, their tests, `src/lib/stores.ts`, `src/lib/api.ts`, `src/lib/types.ts`, and the relevant commands in `src-tauri/src/lib.rs` and `src-tauri/src/sessions.rs`.

T3 is MIT licensed. Preserve its attribution and full license in `THIRD_PARTY_NOTICES.md` for adapted code, and update the adaptation description accurately. Port behavior into Svelte 5; do not bring in React or T3's server architecture.

## Required behavior

### 1. One shared list, with a project filter

- Render one ordered collection across projects: pinned sessions, active sessions, then the Settled shelf. Do not repeat these sections under each project's heading.
- Project selection filters that collection. It does not switch the running Pi process or select a different conversation by itself.
- Preserve the filter across restarts. The project picker includes known GUI projects and the current project even when they have no saved sessions. Distinguish identical folder names using their paths.
- Use a compact header like T3: search plus a grouped set of project-scope, add-project, and new-session controls. Remove the oversized separate New Session strip. Keep the header fixed while sessions scroll.
- The scope control reflects the selected project. Menus support keyboard selection, Escape, outside dismissal, and clear focus restoration.
- With one project, New Session creates there directly. With multiple projects, normal click opens a project choice; Shift+click creates in the current conversation's project, with a sensible fallback when none is open. T3 uses its command palette for this choice; a focused Leftleg picker is sufficient. Respect Leftleg's existing Pi/model-default rules.
- Adding a project makes it immediately discoverable before its first session is saved. Never create an agent session merely to manufacture a project-picker entry.

### 2. Separate organization from runtime activity

The critical correction: **Active means unfinished/unsettled work, not an agent that is currently generating. Settled means deliberately parked finished work, not every idle session.**

- Idle, running, attention-needed, and failed sessions can all remain in Active. A successful turn ending changes its activity indication; it does not settle the session.
- Store GUI organization separately from Pi's runtime state: pin order, active order, explicit settlement timestamp, shelf expansion, and project scope. Pi remains authoritative for session identity, contents, names, and execution state.
- A session belongs to exactly one organization section. Settling removes its pin and active position. Un-settle puts it at the top of Active. Pinning preserves its previous active position so menu-based unpinning can restore that position; an explicit drag position takes precedence.
- Provide working Settle and Un-settle row-menu actions and drag transitions. Neither action deletes or archives a Pi transcript or starts/stops a turn. If an action would require changing live agent state, expose that limitation instead of silently performing it.
- On migration, preserve existing pins and other GUI preferences. Sessions with no explicit settlement metadata default to Active. Do not bulk classify existing idle history as settled or rewrite session JSONL.
- Use a stable, consistently normalized session key. Persist GUI metadata through the existing GUI-state API; do not create a parallel session database. Rapid consecutive GUI-state writes must not lose each other's changes.

### 3. Stable ordering and real drag behavior

- Pinned and Active both support manual ordering, persisted across restart. New sessions enter the top of Active. Runtime events, file mtime changes, search, and refresh do not shuffle manually arranged rows.
- Settled sorts by settlement timestamp, newest first, with a stable tie-breaker.
- Dragging into Pinned pins at the chosen position; Pinned to Active unpins at the chosen position; onto the Settled header settles; Settled to Active un-settles at the drop position; Settled to Pinned restores and pins.
- Display an insertion gap and the appropriate cross-section action, such as Pin, Unpin, Settle, or Un-settle. Support empty Pinned/Active targets and the collapsed Settled header. Drag-only boundary labels must not push the list around.
- Search results must not produce ambiguous reorder operations. Either map drops unambiguously into the full ordering or disable reordering while searching.
- Preserve the sidebar's scroll position when pinning/unpinning from an action. Respect reduced motion and suppress accidental opening on drop.
- Supply Move up/Move down menu actions as a keyboard-accessible alternative to dragging.

### 4. Search and settled history

- Sidebar search filters titles case-insensitively within project scope, using the already ordered full collection, including collapsed/paginated settled sessions. Search does not reorder matches. Do not claim message search or PR search without the corresponding data.
- Arrow keys move through results with wrapping, Enter opens the highlighted result and clears the query, and Escape clears/exits search. Keep the selected result visible and the accessible active descendant valid when the query changes.
- Settled starts collapsed for a new installation and remembers expansion. T3 initially reveals 10 settled entries when expanded and adds 25 per Show more action.
- The currently open settled session remains visible even if the shelf is collapsed or it is outside the loaded page. Render it once. Opening settled history alone does not un-settle it; restoring to Active is a separate action.
- Show correct counts and empty/search-no-results states. Reset pagination when project scope changes.

### 5. Accurate rows and safe row actions

- Match T3's compact row hierarchy: project identity, truncated title, activity/time area, restrained selection, and hover/focus actions. Hover controls should not shift the title or row height. Keep Leftleg's colors and typography unless they prevent a usable compact layout.
- Runtime status is independent of list placement. Derive working, errors, and attention from actual Pi signals. Do not synthesize T3 statuses Pi cannot report.
- An unseen Completed indication needs evidence of a completed turn after a prior visit. File modification time alone is not completion evidence. Imported sessions with no visit/completion evidence do not all display Completed. Track GUI notification/read metadata if necessary without duplicating transcripts or authoritative runtime state.
- Scope status updates to the correct project/session. Background events must not replace the foreground conversation or mark the wrong row as working. Document any Pi event-coverage limitation.
- Row activation, menu activation, pinning, and rename input must have distinct pointer and keyboard handling. Clicking or pressing Enter inside an action or input must not also activate the row.
- Fix the current rename-target trap: `Sidebar.svelte` selects `renamingPath`, but `renameSession(name)` names the active Pi session. Never rename a different session than the selected row. Inspect available Pi RPC support before implementing targeted rename; if inactive-session rename cannot be performed safely, show a truthful disabled action with explanation. Do not secretly switch sessions to perform it.
- Copy session ID uses `SessionInfo.sessionId`, not the session filename. Copy path copies the actual path. Surface failures rather than closing the menu as though an action succeeded.
- Verify navigation against the current one-Pi-process-per-project architecture. Do not assume clicking another session is harmless during a running turn. Inspect the installed Pi RPC behavior. Preserve running work and show a clear limitation if safe viewing/switching requires a separate runtime capability; do not redesign process ownership as an incidental sidebar change.

### 6. Width and persistence

- Match T3's width rules: default 256px, minimum 208px, maximum `max(208, floor(viewportWidth) - 640)`.
- Clamp restored width and reclamp when the window shrinks, not only while dragging. Persist resizing and clean up pointer listeners after release/cancellation.
- Keep existing project settings, extension dialogs, session-switch cancellation handling, process-exit handling, draft handling, and model selection functional.

## Implementation and evidence

First write a short parity checklist identifying the existing mismatches, the GUI metadata needed, and the Pi-dependent limitations. Continue into implementation without stopping for approval on ordinary reversible choices.

Implement and test the pure organization/order transitions first, then connect the Svelte UI and persistence. Replace tests that currently enshrine idle-equals-settled or mtime-equals-completed; do not preserve those assertions as intended behavior. Keep changes focused and readable.

Use fixtures with at least three projects, including one with no sessions; pinned and unpinned idle sessions; a working session; attention/error cases; and more than 35 settled sessions. Prove these cases:

1. A working session finishes a turn and remains Active. An idle session remains Active until explicitly settled.
2. Reordering Active and Pinned survives refresh, unrelated activity, filter changes, and restart. Settling clears the pin; un-settling returns the session to the top.
3. Search reaches a settled session beyond the first page. Arrows/Enter/Escape work. A selected settled session stays visible when collapsed and is never duplicated.
4. Pin/menu/rename actions do not accidentally open a row. Renaming session B cannot rename open session A. Copy ID differs correctly from a timestamp-prefixed filename.
5. Changing project scope does not switch execution context. An empty project remains selectable. Cross-project activity updates the correct row without replacing chat.
6. Migration preserves existing pins/preferences, defaults unclassified sessions to Active, and produces no fabricated completion indicators. Concurrent organization changes survive persistence.
7. A saved oversized width clamps on a smaller window. Empty-section drops and keyboard move actions work.

Use pure tests for state transitions and mounted Svelte interaction tests for propagation, keyboard behavior, and selected-row visibility. Exercise actual desktop drag, scrolling, and layout where tooling permits; mocked RPC tests cannot prove the real Pi switching behavior. If desktop or runtime verification is unavailable, state exactly what remains unverified.

Run `npm run build` with zero svelte-check errors/warnings and passing Vitest tests. If Rust changes, run `npm run check:rust`; run `npm run test:rust` for framing/parsing changes as required by AGENTS.md. Do not produce a release, install, commit, or push unless separately requested.

Finish with a concise report: behavior changed, verification performed, and remaining T3 parity gaps or Pi limitations. Use evidence from the final implementation, not the initial plan.

# Additional bug-hunt round — 2026-09-14

Baseline: `e699e0f` on `master`. Focus: native title bar, startup project and draft transitions, update lifecycle, and status-card session ownership. This is a focused follow-up, not an exhaustive re-audit of every subsystem.

## Findings fixed

| Trigger | Before | After / evidence |
| --- | --- | --- |
| Drag the custom title bar | Tauri rejects `window.start_dragging`; recorded repeatedly in the app log on September 14. | Grant `core:window:allow-start-dragging`. Confirmed against the installed Tauri drag handler and permission manifest. Native check validates the capability; manual dragging remains to verify. |
| Click install while an update check is pending | Installation can use an older native update resource while the check replaces and closes it. | Installation waits for the check before selecting its update. Regression test reproduced the old behavior. |
| Dismiss an update while a check is pending | A late result restores the dismissed banner and stale install affordance. | Invalidate the check result, close its unused resource, and reset the check display. Regression test reproduced the old behavior. |
| Fail to open a project from startup | The reason is stored in `statusNote` but is not visible on the startup screen. | Render that status on startup. Regression test reproduced the missing feedback. |
| Edit the startup draft while its first prompt is pending | Acceptance clears text added after submission. | Consume only the submitted prefix and preserve subsequent edits. Regression test reproduced the loss. |
| Switch projects before the first prompt is rejected | Recovery overwrites the current project's composer. | Restore into the original project/session draft and retain any text already there. Regression test reproduced the wrong ownership. |
| Change session with the status card open | The already-loaded task list still belongs to the previous session. | Close and invalidate the card when its project/session/process changes. Regression test reproduced the stale list. |
| Have two todo calls in one assistant message | The card selects the first call, despite promising the latest task state. | Scan content blocks backwards as well as messages. Regression test reproduced the wrong selection. |

Also verified recovery after the startup component unmounts while project opening is pending.

## Verification and limits

- Focused checks: 19 tests passed across startup, title/status bar, and updater tests.
- Native configuration: `npm run check:rust` passed. No Rust source or parsing changes in this round.
- `npm run build` passed: zero Svelte errors/warnings, 20 test files / 171 tests passed, and Vite production output built successfully.
- Final source/test diff reviewed; `git diff --check` passed.
- Manual native drag, live-provider chat, and real updater installation were not exercised. Updater tests use native API mocks and never install an update.
- Changes are uncommitted. Concurrent `.agents/plans/` work is outside this patch.

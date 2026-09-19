# Pi startup fix — 2026-09-13

The Windows launcher validated the npm bin with `std::fs::canonicalize` and passed that canonical path to Node. Canonicalization adds a verbatim path prefix on Windows. Node 24.18.0 failed before Pi initialized with `EISDIR: illegal operation on a directory, lstat 'C:'`; the same installed Pi 0.85.1 entry without that prefix ran successfully.

Containment validation still uses the canonical path, but the Node argument now uses the ordinary package path. Stderr is drained independently and only its final 8 KiB retained. Unexpected exits append diagnostics to Leftleg's log and include them in the exit event and failed pending RPC requests. Startup waits for event listeners; failed startup shows the recovery state instead of an indefinite starting message.

The existing updater wiring also needed its frontend imports restored and its Rust initialization changed to the public `Builder` API for the current checkout to compile.

Verification:

- `npm run build`: 0 Svelte errors/warnings, 132 tests passed, Vite build passed.
- `npm run check:rust`: passed.
- `npm run test:rust`: 35 tests passed, including executing the resolved npm entry with Node and bounded stderr retention.
- Real Pi 0.85.1: isolated offline fresh startup and restart with an explicit session file both returned successful `get_state` responses; resumed session identity matched. No model turn was sent.

Existing unrelated worktree changes are retained. These results apply to this checkout; they are not a release-wide audit.

Desktop verification: Tauri release build passed with --no-bundle; the installed executable matches the release SHA256 8101B63A49C10B22D41FFF3C4337E721F68FF36E98FDD8773402AABFA73D5339. The relaunched native window showed pi connected, the current project, model, and composer, with no crash banner or starting message. Previous executable retained beside the installed executable as a dated backup.

# Continuous integration

Leftleg uses one stable required check, `Required quality gate`, backed by
independent frontend, real-Pi-contract, and Rust test jobs. Hygiene checks are
temporarily advisory while the pre-existing formatting and lint baseline is
cleaned up. This keeps known debt visible without making every commit red.

## Local commands

Use Node 22 (`.nvmrc`) and the Rust toolchain pinned in
`rust-toolchain.toml`. Install Pi 0.85.1 globally before running the real RPC
integration test.

| Command | Purpose | Current status |
| --- | --- | --- |
| `npm run build:web` | Svelte checks, tests that do not spawn Pi, production web build | Required and green |
| `npm run test:integration` | Five tests against a real isolated `pi --mode rpc` process | Required and green |
| `npm run test:rust` | Native unit and integration tests with the lockfile enforced | Required; green locally, one timing-sensitive test failed on the first hosted run |
| `npm run verify:functional` | Complete local functional gate | Required; green locally |
| `npm run format:check` | Prettier check for frontend, companion, config, and documentation files | Advisory until baseline cleanup |
| `npm run lint` | ESLint recommended rules plus typed promise checks at the application TypeScript boundary | Advisory until baseline cleanup |
| `npm run format:rust:check` | Rustfmt check | Advisory until baseline cleanup |
| `npm run lint:rust` | Clippy for all targets and features with warnings denied | Advisory until baseline cleanup |
| `npm run test:coverage` | Vitest V8 coverage report; no arbitrary percentage threshold | Reporting only |
| `npm run verify` | All frontend and Rust hygiene plus functional checks | Target end state |

`npm run build` remains the frontend gate required by `AGENTS.md`; it includes
all 313 tests and therefore needs Pi on `PATH`. The split commands exist so CI
can identify a frontend regression separately from a real Pi compatibility
regression.

## GitHub checks

### Required functional jobs

- `Frontend`: Svelte checks, 308 isolated tests, and the Vite build.
- `Pi contract`: the five real-process companion tests against pinned Pi.
- `Rust tests`: native behavior on the pinned Rust compiler.
- `Required quality gate`: stable aggregate result for the branch ruleset.
- `Dependency review`: rejects high or critical vulnerabilities introduced by
  dependency changes in pull requests.

Only the aggregate check needs to be named in the branch ruleset. The internal
jobs can then be reorganized without changing repository settings.

### Advisory jobs

- `Frontend hygiene (advisory)`: Prettier and ESLint.
- `Rust hygiene (advisory)`: rustfmt and Clippy.
- `Declared Rust 1.77.2 compatibility (advisory)`: exposes the current mismatch
  between `Cargo.toml` and the source.
- `Coverage report (advisory)`: uploads a 14-day HTML and JSON report on master
  pushes and the weekly schedule.

The initial report covers 59.5% of statements, 50.79% of branches, 48.46% of
functions, and 65.99% of lines. Treat this as a map and a ratchet point, not as
a claim that every covered line has a strong assertion.

Advisory checks allow the individual baseline-check step to fail, then publish
a warning and job summary while leaving the job green. This keeps the pull
request signal readable without hiding the remediation output. Do not add an
advisory job to the branch ruleset.

## Baseline cleanup handoff

The setup deliberately does not rewrite application code. At the time this
pipeline was introduced:

- Prettier reported formatting drift across the existing frontend and docs.
- ESLint reported 50 errors and 16 advisory Svelte structural warnings. The
  errors are primarily unused values, explicit `any`, and promise handling.
- Rustfmt reported existing formatting drift.
- Clippy reported ten diagnostics, including use of Rust 1.80 APIs despite the
  declared Rust 1.77.2 minimum.
- The first GitHub-hosted Windows run failed
  `pimgr::tests::update_deadline_includes_inherited_pipes_after_parent_exit`
  with `pipe drain outlived update deadline`; the same test passes locally.
  Treat this as a timing-sensitive test to diagnose rather than retrying it
  until it happens to pass.
- GitHub Dependabot reports `GHSA-wrw7-89jp-8q8g` in the transitive Rust
  `glib` dependency below 0.20.0. The first patched release is 0.20.0; update
  the owning dependency deliberately and run the native suite rather than
  editing `Cargo.lock` by hand.

Clean each category in a separate commit. For promise findings, confirm whether
the intended behavior is to await, return, or explicitly detach with `void`;
do not mechanically silence the rule. For the minimum Rust version, either
restore genuine 1.77.2 compatibility or update the declaration to the oldest
compiler actually tested and supported.

After every advisory command is green:

1. Remove `continue-on-error` from the advisory check steps in the three
   hygiene/MSRV jobs.
2. Add those jobs to the `quality-gate.needs` list and its result check.
3. Keep `Required quality gate` as the stable branch-rule check.
4. Run `npm run verify` locally and confirm the pull request checks.

## Dependency and security maintenance

Dependabot opens grouped weekly update pull requests for npm, Cargo, and GitHub
Actions. Actions remain pinned to full commit SHAs; Dependabot updates the pin.
The weekly dependency audit continues to run `npm audit` and pinned
`cargo-audit`. GitHub CodeQL default setup is managed in repository settings so
GitHub can maintain the language/build configuration.

The initial CodeQL scan on 2026-09-19 completed successfully and opened 105
findings for the existing default branch. This is a triage queue, not 105
confirmed vulnerabilities:

| Rule | Severity | Findings |
| --- | --- | ---: |
| Rust command-line injection | Critical | 3 |
| Rust path injection | High | 80 |
| JavaScript path injection | High | 19 |
| JavaScript file-system race | High | 1 |
| JavaScript file access to HTTP | Medium | 1 |
| JavaScript prototype-pollution utility | Medium | 1 |

Most findings cluster in `src-tauri/src/sessions.rs` (69),
`companion/leftleg-settings/index.ts` (18), and `src-tauri/src/pi.rs` (9).
Review the three command-line findings first, then group path findings by
shared trust boundary so one validated helper can address a class of reports.
Mark a finding false positive only after documenting why its input is trusted
or constrained.

## Later layers

The next pipeline layer should add a small Windows Tauri WebDriver suite for
launch, prompt streaming, session/project switching, image enlargement,
settings persistence, and crash recovery. Add it only with real journeys and
diagnostic artifacts; an empty E2E scaffold would create confidence without
proof. Rust coverage and selective mutation testing can follow once the hygiene
baseline is green.

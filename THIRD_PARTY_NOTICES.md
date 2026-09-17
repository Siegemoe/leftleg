# Third-party notices

## Fonts

- **Plus Jakarta Sans** — bundled in `src/assets/fonts/` (variable weights
  200–800, normal + italic, latin/latin-ext subsets) under the
  [SIL Open Font License 1.1](https://openfontlicense.org/). © The Plus Jakarta
  Sans Project Authors.

## T3 Code

Portions of Leftleg's sessions sidebar are adapted from
[T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc., which is
licensed under the MIT License. The
adapted functionality includes:

- The sidebar list model: Pinned/Active/Settled section semantics, project
  grouping with per-project status indicators, query filtering that narrows
  without reordering, and status-pill priority ordering
  (`src/lib/sidebar-model.ts`, adapted from T3's `Sidebar.logic.ts`).
- The sidebar UX shape: a fixed header with search plus a project-scope
  picker, collapsible history sections with counts, resizable persisted
  width, and row-level status pills (`src/components/Sidebar.svelte`).
- The projects settings concept: per-project display name, icon, and default
  model with a "forget project" flow (`src/components/SettingsModal.svelte`).

Adaptations are substantial: T3's data model (harness threads, sessions,
machines) was re-mapped onto pi sessions and Leftleg's multi-process
project orchestration, and re-implemented in Svelte 5.

T3 Code's MIT license text follows.

---

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

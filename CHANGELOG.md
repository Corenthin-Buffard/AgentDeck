# Changelog

## [0.1.3.8] - 2026-07-20

### Fixed
- **A heavy gstack skill no longer strands as `done` when it stops to ask.** The daemon
  decides `waiting` vs `done` from the agent's turn text (`looksLikeQuestion`). A long
  `/plan-eng-review`-style turn ends on a decision brief whose *tail* is a `Net:` line with
  no question cue, so the old 500-char/narrow-cue check mis-read it as finished — leaving a
  real gstack agent stuck the moment it needed you. Detection now also does a structural
  check over the last 2000 chars: gstack's decision-brief shape (`Net:`/`Completeness:`
  lines or a `D<n> —` header, incl. split-chain `D<n>.final`/`.revise-k`, plus ≥2 labeled
  options — bold, bullet-listed, or inline), or an explicit "reply with a letter / your
  picks" instruction. Biased toward `waiting`, since stranding an asking agent is the worse
  error. A headless `BLOCKED — AskUserQuestion unavailable` message now reads as waiting too.
- **The reply drawer shows the actual question on a long turn.** `pendingQuestion` stored the
  *head* of the turn (the intro); for a long skill turn the asks are at the *end*, so it now
  keeps the tail (`…` + last 2000 chars).

### Validated
- **Full gstack loop end-to-end (P2).** A real `claude` agent ran `/plan-eng-review` through
  the daemon: it hit the skill's scope-gate `AskUserQuestion`, rendered it as prose, the
  dashboard flipped to `waiting`, an answer resumed it via `claude --resume`, and it ran the
  complete four-section eng review — proving a real gstack skill advances through the loop.
  This run surfaced the detection bug fixed above. Hardened via two adversarial review rounds
  (19 `detect.ts` unit tests pin every real brief shape).

## [0.1.3.7] - 2026-07-20

### Added
- **Browser e2e harness** (`docs/e2e/`) — a reproducible end-to-end proof of the core loop
  with a **real** claude agent: it drives the actual dashboard (click "New task" → the agent
  asks in prose → `waiting` over WebSocket → reply drawer → `claude --resume` → done →
  artifact on disk). Isolated deps; not wired into CI (a real agent costs money + is
  non-deterministic). Proves the P2 "real task creation from the browser" item.

### Changed
- TODOS: closed the browser-e2e P2, and recorded a P3 found during it — the dashboard's
  "Clean up" button dead-ends on a done task whose worktree is dirty with the agent's artifact
  (`cleanupWorktree` safely refuses, but the UI gives no path forward).

### Hardened (review)
- **The e2e cleanup can't leak a real agent.** `run.sh` launches the daemon in its own process
  group (`set -m`) and tree-kills it on exit (`kill -- -$PGID`), so a mid-run failure/timeout
  can't orphan the spawned `claude` — which would otherwise keep burning tokens against a
  `rm -rf`'d worktree. Plus: the daemon log now lives at a stable (gitignored) path so it
  survives cleanup for diagnosis, and a pre-flight port check fails loud instead of silently
  driving a stale daemon on 8788.

## [0.1.3.6] - 2026-07-20

### Changed
- **Dashboard + notifications translated to English.** Every user-facing string in the
  Master Inbox (`public/index.html`) and the Slack/Telegram templates (`src/notify.ts`)
  is now English (`Cruising / Needs you / Done`, the reply drawer, empty state, buttons,
  alerts, relative times). Hardened via `/plan-eng-review` (Codex outside voice).

### Added
- **Reproducible demo-GIF harness** (`docs/demo/`) — boots the real dashboard, drives the
  state timeline over the live WebSocket, captures with headless Chromium, and encodes the
  GIF (deps isolated here; the root package stays dependency-free). The capture **fails on
  any dashboard console error**, so it doubles as a UI-integrity check.
- Regenerated `docs/demo.gif` in English.

## [0.1.3.5] - 2026-07-20

### Added
- **Install with Claude Code** — a copy-paste prompt (README) that installs gstack (if missing)
  + AgentDeck and sets up a `systemd --user` service in one paste. It checks whether gstack is
  already installed, is idempotent, validates the download and the target repo, and bakes the
  runtime PATH into the service so the daemon can actually spawn `claude` agents. Hardened via
  `/plan-eng-review` (Codex outside voice; core-critical bar).

### Docs
- Refreshed the stale status version and completed the `AGENTDECK_*` config-knobs list.

## [0.1.3.4] - 2026-07-20

### Changed
- **Full rename of the internal `gorch` codename to AgentDeck.** Environment variables
  `GORCH_*` → `AGENTDECK_*`, the git branch prefix `gorch/` → `agentdeck/`, the state DB
  `gorch.db` → `agentdeck.db`, the default data dir `~/.gorch` → `~/.agentdeck`, the daemon
  log line, and the `GorchConfig` type. No behavior change — the codebase is now gorch-free.

## [0.1.3.3] - 2026-07-20

### Changed
- **Dashboard branding.** The header wordmark, browser title, and empty-state copy now read
  **AgentDeck** (was the internal codename `gorch·inbox`). Regenerated the demo GIF to match,
  and switched its sample task IDs to the real `t_…` format so nothing off-brand shows.

## [0.1.3.2] - 2026-07-20

Public-readiness pass.

### Added
- **MIT license** (`LICENSE`) — the repo is now legally usable, forkable, and distributable.

### Docs
- README cleaned for a public audience: dropped the internal `spike` section and the
  `A1`/`A1b` proof codenames + dated validation logs, folded the launch requirement into
  its own section, and refreshed the status version.

## [0.1.3.1] - 2026-07-20

### Docs
- **Demo GIF** (`docs/demo.gif`, shown in the README): the Master Inbox with several agents
  cruising, one flipping to `waiting`, the reply drawer opening, an answer typed, and the task
  resuming. Captured from the real server + dashboard driven over its live WebSocket.

## [0.1.3.0] - 2026-07-20

The distribution pipeline (T8). AgentDeck now ships as a single self-contained binary — distribution is the product for an OSS repo.

### Added
- **Single-binary build.** `bun run build` compiles `src/daemon.ts` to a standalone
  executable (`dist/agentdeck`) via `bun build --compile`. The dashboard HTML is embedded
  into the binary (`import indexHtml from "../public/index.html" with { type: "text" }`),
  so it runs from any cwd with no sibling `public/` — verified booting + serving from `/tmp`.
- **Release workflow** (`.github/workflows/release.yml`). Pushing a `v*` tag runs the tests,
  cross-compiles three targets (linux x64/arm64, darwin arm64) from one runner, and uploads
  them to a GitHub Release. All three targets verified to cross-compile locally.
- **CI workflow** (`.github/workflows/ci.yml`). On push/PR: runs the 18 unit tests and
  compiles all three release targets, so a broken cross-target fails the PR, not the tag.
  Pinned to least-privilege `permissions: contents: read`.
- **README install section.** Single-binary `curl` + `chmod` instructions, a "Run from
  source" section, and a demo-GIF placeholder (recording tracked in TODOS).

### Hardened (review)
- **The release actually gets exercised.** CI now smoke-runs the compiled linux-x64
  binary (boots it, curls `/`, asserts the dashboard) and a unit test boots the server
  and asserts `GET "/"` serves the embedded HTML — the pipeline compiled the binary but
  never ran it, so the embed change had zero runtime coverage.
- **Release guardrails.** `release.yml` verifies the pushed tag equals `v<VERSION>` before
  building, and `fail_on_unmatched_files: true` stops it publishing an empty release (and
  404-ing the README download links) if the artifact glob ever misses.

## [0.1.2.2] - 2026-07-20

Two fixes surfaced by the first real end-to-end run; the second was a critical caught in review.

### Fixed
- **Untracked files show in the diff view.** A file an agent just created was invisible
  (`git diff` ignores untracked). Read via `git status --porcelain -z` so paths with
  spaces / accents / newlines survive; list capped; empty returns "".
- **Single-source the agent turn text.** The turn's text now comes from one source — the
  consolidated assistant message. The previous code accumulated deltas *and* the assistant
  message (doubling the question), and a substring-dedup meant to fix that could drop a
  restated question and — since detection only reads the trailing 500 chars — silently flip
  an agent from `waiting` to `done`, stranding it. Deltas are liveness-only now.

## [0.1.2.1] - 2026-07-20

### Docs
- Record the validation result: Claude Code's `Notification` hook does **not** fire under
  headless `claude -p` (the `Stop` hook does, but it's redundant with the stream `result`
  event). The prose heuristic on turn-end is the detection mechanism and it's optimal for
  the headless model. The `Notification` wiring stays opt-in/off, ready for a future
  interactive mode; the HTTP hook transport itself is confirmed working.

## [0.1.2.0] - 2026-07-20

Opt-in Notification-hook wiring for faster "waiting" detection, hardened after review.

### Added
- **Notification-hook wiring (opt-in, `AGENTDECK_HOOKS=true`)**: launched agents load a
  generated settings file via `claude --settings`, so Claude Code POSTs its `Notification`
  (and PreToolUse) HTTP hooks to the daemon — a first-class "needs you" signal that also
  covers permission prompts. The prose heuristic stays primary; the hook corroborates and
  speeds detection. **Off by default** until validated on a VPS.
- `src/hooks-config.ts`: pure settings generator (+ 3 tests).

### Fixed
- **One live child per task (critical)**: a Notification-driven `waiting` can fire while
  the agent is still running; `answer()`/`resumeTask()` now kill the existing child first
  and the exit handler is identity-guarded — no two concurrent `claude --resume` on one
  session, no orphaned or false-error tasks.
- The settings-file write is guarded — a failure degrades to hooks-off instead of crashing
  the daemon.
- Cap the hook message length (2000); skip our `--settings` if the operator passed their own.

## [0.1.1.0] - 2026-07-19

Reply-drawer polish, accessibility, and the first tests.

### Added
- Master Inbox: a **pending-question preview** on waiting agent rows;
  **Cmd/Ctrl+Enter** to submit in the reply and new-task drawers; **Escape** to close
  (unless a non-empty textarea is focused).
- **Screen-reader support**: an `aria-live` region announces agents flipping to
  waiting / error / done — appends one node per message so a burst isn't clobbered,
  and seeds silently on first load so a page reload doesn't announce the whole board.
- **Unit tests (15)** for the state-detection logic: `looksLikeQuestion` + phase mapping.

### Changed
- Extract `looksLikeQuestion` into `src/detect.ts` (pure, testable module).

### Fixed
- Restore the standalone "option" cue in `looksLikeQuestion` — a prose question ending
  in "select an option" was mis-classified as done, stranding a waiting agent (with a
  regression test).
- Isolate each dashboard row render so one bad task can't blank the whole board.
- `esc()` also escapes `'` and `` ` `` (defense in depth).

## [0.1.0.0] - 2026-07-19

First cut. The daemon spine runs end to end and the make-or-break mechanic is proven.

### Added
- **Daemon (`src/`)** — Bun + SQLite. Task lifecycle: `1 task = 1 branch = 1 worktree = 1 agent`.
  - `agent.ts` — headless agent supervisor. Drives Claude Code via the Agent SDK / `claude -p`
    (Path A, no tmux substrate). Human-in-loop = the proven **prose + `claude --resume`** mechanic;
    injection and A2 durability are the same operation. Concurrency cap enforced.
  - `git.ts` — non-destructive worktrees (never `-D`/`--force`; dirty/unmerged trees are surfaced).
  - `db.ts` — SQLite in WAL mode (tasks + events).
  - `phase.ts` — gstack skill → pipeline phase mapping (Plan→Run→Review→QA→Ship→Done).
  - `notify.ts` — Slack + Telegram, notification-only (reply happens in the dashboard).
  - `server.ts` — REST + WebSocket + HTTP hooks. Binds `127.0.0.1` by default (reach via SSH tunnel).
- **Dashboard (`public/index.html`)** — the Master Inbox: attention hierarchy (waiting/error pinned,
  running/done recede), 6-phase progress bars, reply drawer, live over WebSocket.
- **Spike (`spike/`)** — the instrument that proved A1: in headless mode the AskUserQuestion tool is
  unavailable, the agent asks in prose, and a `claude --resume` turn injects the answer and continues.

### Validated
- **A1b — resolved.** A real gstack skill runs headless, asks in prose (no `BLOCKED`), and a
  `claude --resume` turn continues it. Launch config: agents start with
  `--dangerously-skip-permissions` (`AGENTDECK_SKIP_PERMISSIONS`, default on). Path A proven end to end.

### Next
- Reply drawer wired to the `Notification` hook, `resuming` state UI, `aria-live` (DT1–DT3).
- Confirm a *valid* answer advances a gstack workflow (the A1b test used an invalid answer, so the
  agent re-asked — the round-trip mechanic is proven, full-flow advance is the follow-up).

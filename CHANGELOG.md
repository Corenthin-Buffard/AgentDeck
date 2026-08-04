# Changelog

## [0.2.3.1] - 2026-08-04

### Fixed
- **A website you visit can no longer read your board.** If a hostile page's domain resolves to
  `127.0.0.1` (DNS rebinding), the browser treats the daemon as same-origin and the page reaches it
  directly. Reads are open on localhost by design, so `GET /api/tasks` handed over every task title,
  prompt, branch, error and pending question. The `/ws` gate shipped in 0.2.3.0 could not stop this:
  it compared `Origin` against `url.host`, and both come from the attacker-controlled `Host` header,
  so they validated each other. Every route is now checked against a recognised `Host` **before
  routing** — reads included, since the reads were the leak.

  Nothing changes for the documented setup. Loopback names are accepted on **any** port, so
  `ssh -L 9000:127.0.0.1:8787` keeps working even though the browser sends `localhost:9000` while the
  daemon listens on 8787. Behind a reverse proxy, set `AGENTDECK_ALLOWED_HOSTS` to the hostname your
  proxy sends; binding off-loopback without it rejects everything and says so on the first line of
  the boot log rather than leaving you to debug blanket 403s.

## [0.2.3.0] - 2026-08-04

### Added
- **The dashboard says what it is, and where it is.** The header is now two rows: a brand row
  carrying a deck glyph, the AgentDeck wordmark (a real page heading, so screen readers announce
  it) and a line telling you which deployment this tab points at and whether the link is alive —
  the one fact nothing else on screen carried when you keep several SSH tunnels open. Controls sit
  on their own row below. The browser tab finally has an icon, so AgentDeck is findable among ten
  others.
- **The connection indicator tells three states apart.** `live` in green, `reconnecting…` in
  amber, and `daemon unreachable` in red once it has really given up (and it now backs off instead
  of hammering every 1.5s while claiming otherwise). Restarting the daemon reads as a restart, not
  as a failure, and the board recovers on its own with no page reload.
- **`DESIGN.md`** at the repo root: the colour tokens with their roles, the contrast floors with
  measured ratios, the mono-as-identity decision, the header layout invariants, and the interaction
  states. Written because the approved brand lockup had been designed once and then quietly lost.

### Fixed
- **The live feed no longer leaks your board to any website you happen to have open.** WebSockets
  are not covered by the browser's same-origin policy, so any page could open `/ws` and receive the
  full task snapshot pushed on connect — titles, prompts, branch names, errors, pending questions.
  The upgrade is now gated on the dashboard token (sent as a subprotocol, never in the URL, so it
  can't land in proxy logs) plus an Origin check.
- **Text you couldn't read is now readable.** `--faint` measured 4.10:1 in dark and 2.80:1 in light
  — under the 4.5:1 floor for text and under even the 3.0:1 floor for interface elements — and it
  coloured section labels, metadata, timestamps and empty states. `--done` shipped with the exact
  same value and coloured the finished/stopped/resuming chips at 3.13:1. Both raised; every text
  colour now clears 4.5:1 in both themes.
- **The header is usable on a phone.** Its two controls measured 29px and 28px against a 44px
  minimum; they now meet it below 620px, and the bar no longer wraps unpredictably (two competing
  auto-margins were splitting the free space instead of pushing the status to the right).
- **The empty box next to every branch name is gone.** The branch mark was `U+2442`, a character
  almost no installed font carries, so most Linux systems drew a `.notdef` box on every task row —
  including in the README's demo GIF. It's now a drawn icon that doesn't depend on your fonts.

### Internal
- The dashboard token is persisted (0600, `O_EXCL`/`O_NOFOLLOW`, shape-checked) instead of being
  regenerated per process. Once the token also gated `/ws`, a per-process secret meant an open
  dashboard could never reconnect after a restart — it 403'd forever until you reloaded. Caught by
  the new end-to-end test, not by hand.
- New `docs/e2e/conn-states-e2e.mjs`: a browser proof of the connection state machine that costs no
  agent turn. It found the reconnect regression above on its first run. New assertions lock the
  brand lockup, the favicon and the contrast tokens, so the "designed once, silently dropped"
  failure mode that motivated this release can't repeat (89 tests).
- Cross-model pre-landing review (Claude + Codex) surfaced the WebSocket exposure, the `--done`
  contrast twin, an invalid `<h1>`-inside-`<span>` lockup, a hard-coded `ws://` that breaks behind
  an HTTPS proxy, and the token-file symlink handling. A DNS-rebinding vector on the ungated read
  endpoints predates this release and is tracked as P1.

## [0.2.2.0] - 2026-07-22

### Added
- **Auto-clean merged tasks (opt-in).** Set `AGENTDECK_AUTO_CLEAN_MERGED=true` and a periodic
  sweep (30s after boot, then every 5 min) drops a `done` task's worktree + branch + dashboard
  row once its branch is **proven merged** — no more manual "Clean up" on every shipped task.
  "Merged" is proven ONLY by a merged GitHub PR (`gh pr list --head <branch> --base <base>
  --state merged`) whose head commit equals the local tip, so a squash merge is detected where
  plain git can't. Off by default (it's a silent destructive sweep). `done` only — a `stopped`
  task is a deliberate pause and is never touched.

### Internal
- Safety-first by construction: the sweep only ever removes a task whose work is provably in the
  base. Detection returns the exact proven SHA and the branch is deleted via an atomic
  compare-and-swap (`git update-ref -d refs/heads/<b> <sha>`), so a commit landing after the proof
  is never force-deleted. The cleanup refuses a dirty or unreadable worktree, an in-flight guard
  prevents overlapping sweeps, `gh`/subprocess calls are bounded (SIGKILL + hard read deadline so a
  hung child can't wedge the sweep), and an anti-race re-check runs before the destructive step.
  Cross-model pre-landing review (Claude + Codex) drove the SHA compare-and-swap, the base filter,
  and dropping the unsafe `git --is-ancestor` fallback (it couldn't tell a merged branch from a
  zero-commit one). New `test/cleanup.test.ts` + `test/git.test.ts` cases (86 tests).

## [0.2.1.0] - 2026-07-22

### Added
- **Plan-review tracking on the dashboard.** Each task card now shows which of the three gstack
  plan reviews — CEO / Design / Eng — its branch has been through, as calm monochrome marks under
  the plan segment: `○` not run, `✓` clean, `⚠` ran-with-issues, trailing `*` = the review predates
  current HEAD. Eng is emphasized (it's the one that gates `/ship`). The daemon auto-detects this by
  reading the branch's gstack review log (`gstack-review-read`, run in the task's worktree) at each
  turn-end and once on (re)attach — no clicking, no manual state. Hover or screen-reader carries the
  detail (e.g. "Eng review: 13 issues, 0 unresolved"). The reader resolves from `PATH` first
  (override with `AGENTDECK_REVIEW_READ_BIN`); if it's missing the daemon logs once at boot and the
  marks simply stay `○`.

### Internal
- New `plan_reviews` column on `tasks`, added by an additive migration (independent of the `project`
  column, so a DB at any prior schema upgrades cleanly). Detection is best-effort and bounded — a 4s
  timeout+kill on the reader, an in-flight guard so at most one reader runs per task, and writes only
  on a clean, complete read (a killed or non-`clean`-exit reader never clobbers good marks). Short-SHA
  staleness compares by prefix so `git`'s auto-growing short hash doesn't flag the same commit stale.
  Pre-landing review (Claude + Codex, cross-model) hardened all of the above before merge.

## [0.2.0.2] - 2026-07-22

### Security
- **Upload destinations are now pinned to the exact intended dir.** The `/api/upload`
  path check confirmed the write landed under the project repo and not under `.git/`,
  but a pre-placed symlink at `<repo>/.gstack/browse-states` pointing elsewhere *within*
  the repo (e.g. → `src/`) still slipped through — a token-holder with local symlink
  access could drop a file into another repo dir. The check now requires the resolved
  directory to EQUAL the canonical `realpath(trusted base) + literal subpath`, so any
  symlinked path component is rejected: out of the repo, into `.git/`, or to another
  in-repo dir alike. (A residual TOCTOU race remains, inherent to pathname-based writes;
  tracked in TODOS for a future fd-based write.)

## [0.2.0.1] - 2026-07-22

### Fixed
- **QA cookies now actually reach the agent.** `/qa` confirmed the v0.2.0.0 cookie flow
  didn't work: an uploaded browse-state lands in the main repo's `.gstack/browse-states/`,
  but agents run in per-task worktrees and `$B state load qa` resolves that path via
  git-toplevel (the worktree root, which carries no `.gstack/`) — so the agent found nothing
  and QA ran logged-out. `createWorktree` now symlinks the worktree's
  `.gstack/browse-states` to the project repo's shared dir, so `$B state load qa` sees the
  uploaded state (proven end-to-end: `State not found` → `State loaded`). The symlink target
  is absolute (works with a relative `projects.json` path), and `.gstack/` is added to each
  managed repo's local `info/exclude` — so the untracked symlink never dirties the repo, never
  strands "Clean up", and can't be committed into your project branch by a cleanup. Upload path
  unchanged; cookies are never committed.

### Added
- **Drive many repos from one daemon.** Drop a `projects.json` (`[{ id, path, label? }]`)
  in the data dir and one AgentDeck instance orchestrates several repositories. The dashboard
  header gets a **Project** switcher (All projects / per-project), the choice is remembered
  across reloads, and in the all-projects view each row carries a muted project tag. Every
  task's branch and worktree land in that project's repo. Single-repo setups keep working
  unchanged — with no `projects.json`, a `default` project is synthesized from
  `AGENTDECK_TARGET_REPO`.
- **Upload a local file to the VPS from the browser.** A new **Upload** button sends a file
  over the tunnel (no more manual `scp`); it lands under `<dataDir>/uploads/<project>/` and a
  toast gives you the absolute VPS path with a copy button. Determinate progress bar, clear
  error states, 25 MB cap.
- **Authenticated QA on the VPS.** Upload a gstack browse-state (`qa.json`) into a project's
  `.gstack/browse-states/`, then the agent runs `$B state load qa` before the logged-in steps —
  so the headless browser on the server can hit pages behind a login. (Whether a worktree agent
  sees the main-repo copy is being verified in QA; see TODOS.)

### Security
- **All state-changing requests are token-gated (anti-CSRF).** Create/stop/delete/reply and
  upload now require a per-session **dashboard token**, injected into the served HTML (with
  `Cache-Control: no-store`) and sent as an `x-agentdeck-token` header. A cross-origin page
  can't read that token, so it can't forge these even while your SSH tunnel is open — closing a
  CSRF-to-localhost path that could otherwise launch a `--dangerously-skip-permissions` agent.
  This dashboard token is **separate** from the agents' `0600` hook token, which is no longer
  exposed in the page.
- **Upload path containment hardened.** The destination is now realpath-checked against a
  trusted base and any real `.git/` path is refused, so a symlinked directory component (e.g.
  `.gstack/browse-states` → `.git/hooks`) can no longer redirect a write out of the target dir.
  Filenames are reduced to a sanitized basename, project ids with path separators are rejected,
  and writes are temp-then-renamed (no stranded temp files, no leaf-symlink follow).

### Fixed
- **A stale or unknown project no longer runs an agent in the wrong repo.** `POST /api/tasks`
  with an unknown `projectId` returns 400 instead of silently falling back to the first project.
- **Worktree cleanup works for bare repos.** Cleanup derives the repo from the worktree; it no
  longer mis-derives a bare repo's path and leaks the worktree/branch.

## [0.1.3.11] - 2026-07-21

### Security
- **The hook endpoints now require a per-session token.** `/hooks/notification` and
  `/hooks/pre-tool-use` were unauthenticated — any local process could POST a forged
  `session_id` and flip a task to `waiting`. The daemon now generates a per-session secret
  (`hookToken`, `randomUUID` or `AGENTDECK_HOOK_TOKEN`), bakes `?token=<secret>` into the hook
  URLs in the generated settings file (Claude Code's `http` hook has no headers field), writes
  that file `0600` so only the owner can read the secret, and rejects any `/hooks/*` POST whose
  token doesn't match with **403**. The gate runs even when hooks are disabled. Forgery is now
  restricted to the owner user (who already controls the box); the prose-heuristic detection is
  unchanged. Hardened over two adversarial review rounds (empty-token footgun, write→chmod TOCTOU).

### Fixed
- **The drawer diff is capped at 4000 chars.** `openTask()` rendered `df.diff` uncapped
  (events were already capped), so a task touching many files bloated the drawer DOM. It now
  slices to 4000 chars with a "… N more chars truncated (see the worktree)" note. `esc()` still
  wraps the sliced string (slice-then-escape, so nothing is half-escaped).

## [0.1.3.9] - 2026-07-21

### Fixed
- **"Clean up" no longer dead-ends on a done task.** A done task's worktree is always dirty
  (the agent's artifact lives there uncommitted, and nothing else holds it), so
  `cleanupWorktree` safely refused it and the dashboard button just alerted with no way
  forward. `cleanupWorktree` now takes a `mode`: `safe` (default, refuse — nothing destroyed),
  **`commit`** (stage + commit the agent's work onto the branch, then remove the worktree —
  work preserved and PR-able later), or `force` (discard worktree + branch). The dashboard's
  "Clean up" / "Delete" tries `safe`, then on a dirty worktree offers **commit** (recommended)
  or a **discard** escape. `DELETE /api/tasks/:id?mode=commit|force` drives it (validated;
  defaults to `safe`). The `commit` uses a deterministic `AgentDeck` git identity so it works
  even in a repo with none configured.

### Hardened (review)
- **Cleaning up a running task stops its agent first.** `commit`/`force` now `killExisting`
  the live `claude` child before removing the worktree, so it can't be orphaned in the
  concurrency pool or race the `git commit`. Plus: guarded dashboard fetches, a structured
  `dirty` flag (no message-string coupling), a commit-failure → discard fallback, and honest
  discard copy (it deletes committed-but-unmerged branch work too). 5 `git.ts` integration
  tests cover all three modes; hardened over two adversarial review rounds.

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

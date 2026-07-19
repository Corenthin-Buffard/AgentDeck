# Changelog

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
  `--dangerously-skip-permissions` (`GORCH_SKIP_PERMISSIONS`, default on). Path A proven end to end.

### Next
- Reply drawer wired to the `Notification` hook, `resuming` state UI, `aria-live` (DT1–DT3).
- Confirm a *valid* answer advances a gstack workflow (the A1b test used an invalid answer, so the
  agent re-asked — the round-trip mechanic is proven, full-flow advance is the follow-up).

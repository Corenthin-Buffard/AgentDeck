# Changelog

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

### Known / next
- **A1b** — validate the agent launch config (skills in scope + permission mode) on a real VPS;
  a nested sandbox blocks skill resolution. See `README.md`.
- Reply drawer wired to the `Notification` hook, `resuming` state UI, `aria-live` (DT1–DT3).

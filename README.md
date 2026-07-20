# AgentDeck

Self-hosted, **gstack-native** orchestrator for running multiple Claude Code agents in parallel on a VPS. An air-traffic-control board for your agents: one glance tells you which agent needs you, which is cruising, which broke.

`1 task = 1 branch = 1 git worktree = 1 agent.` Strict isolation, no sharing. Agents run on the server, so they keep going when you close your laptop or drop the SSH connection.

<!-- DEMO GIF: record N parallel agents on the board — one flips to `waiting`, a phone
     notification fires, you reply in the drawer, it resumes — and drop it at docs/demo.gif,
     then uncomment the line below. (Tracked in TODOS.md → Distribution.)
<p align="center"><img src="docs/demo.gif" alt="AgentDeck: parallel agents on the Master Inbox board" width="720"></p>
-->

> Status: **v0.1.3.0** — the full loop is proven end to end with a real agent (create task → branch → worktree → agent runs → asks in prose → you reply from the dashboard → `claude --resume` continues → done, with the artifact on disk). A1 + A1b below. Ships as a single self-contained binary (see **Install**). Not yet production-hardened.

## Why this and not Claude Squad / Conductor / amux

Those orchestrate agents generically. AgentDeck is coupled to the **gstack workflow**: the dashboard shows exactly where each agent is in the `Plan → Run → Review → QA → Ship → Done` pipeline, and the human-in-loop moment is a first-class feature. Narrow on purpose — built for people who already run Claude Code + gstack.

## How it works

```
                     ┌──────────────────────────────────────────────┐
   Browser ──WS──────┼─▶ AgentDeck daemon (Bun, systemd --user)       │
   Slack/Telegram ◀──┼── notification-only (reply in the dashboard)   │
                     │   Agent supervisor: N × headless Claude Code    │
                     │   State store (SQLite, keyed by sessionId)      │
                     └───▲──────────────────────────────▲──────────────┘
                         │ HTTP hooks / SDK stream       │
              ┌──────────┴───┐                    ┌──────┴───────┐
              │ Agent 1       │  ...               │ Agent N      │
              │ cwd=worktree-1│                    │ cwd=worktree-N│
              └───────────────┘                    └──────────────┘
                 git worktree                         git worktree
```

**The human-in-loop mechanic (proven):** in headless mode Claude Code has no AskUserQuestion tool, so the agent asks in **prose** and the turn ends. AgentDeck reads the question, notifies you (Slack/Telegram), and when you reply in the dashboard it injects the answer as a new `claude --resume <sessionId>` turn. That same `resume` is also how agents survive a daemon restart — injection and durability are one operation.

**"waiting" detection — the prose heuristic is the mechanism (validated):** when a headless agent asks in prose and its turn ends, the daemon reads the turn-end `result` event and decides waiting-vs-done. A validation run (2026-07-20) confirmed there is **no mid-turn "needs you" signal under `claude -p`**: Claude Code's `Notification` hook does **not** fire headless (the `Stop` hook does, but it's redundant with `result`). So the prose heuristic is the only signal available for this model — and therefore optimal.

The `Notification`-hook wiring still ships but **off by default** (`GORCH_HOOKS=true`). The HTTP hook transport works (verified — `Stop` POSTed); `Notification` is simply inert under `claude -p`. It's kept ready for a future interactive / SDK (`query()` + Channels) mode where `Notification` would fire.

## Install

Grab the single binary for your platform from [Releases](https://github.com/Corenthin-Buffard/AgentDeck/releases/latest) — the dashboard is embedded, so it's self-contained (no runtime, no `node_modules`, no sibling files):

```bash
# Linux x64 (swap the suffix for -linux-arm64 or -darwin-arm64)
curl -fsSL https://github.com/Corenthin-Buffard/AgentDeck/releases/latest/download/agentdeck-linux-x64 -o agentdeck
chmod +x agentdeck
GORCH_TARGET_REPO=/path/to/your/project ./agentdeck
# → http://127.0.0.1:8787  (bind is localhost — reach it via an SSH tunnel)
```

On the box it drives you still need `claude` (Claude Code) on PATH and authenticated, plus gstack for the phase tracking — the binary bundles AgentDeck, not the agents it runs.

Run it under systemd `--user` to survive your laptop closing (that's the whole point — the daemon keeps the agents going while you're away).

## Run from source

Prereqs: [Bun](https://bun.sh), `claude` (Claude Code) on PATH and authenticated, and gstack for the phase tracking.

```bash
bun install   # (no deps yet, but conventional)
GORCH_TARGET_REPO=/path/to/your/project \
GORCH_TG_TOKEN=... GORCH_TG_CHAT=... \
bun run daemon
# → http://127.0.0.1:8787  (bind is localhost — reach it via an SSH tunnel)

bun run build     # → dist/agentdeck, the same self-contained binary CI ships
```

Config knobs (env): `GORCH_HOST` (default `127.0.0.1`), `GORCH_PORT`, `GORCH_TARGET_REPO`, `GORCH_MAX_AGENTS`, `GORCH_PERMISSION_MODE`, `GORCH_CLAUDE_ARGS`, `GORCH_TG_TOKEN`/`GORCH_TG_CHAT`, `GORCH_SLACK_WEBHOOK`.

## The spike (how A1 was proven)

`spike/run.ts` is a throwaway instrument, not a feature. It drives one agent and proves the prose + resume round-trip end to end.

```bash
bun run spike            # plain prose question → resume → continues
bun run spike -- --gstack  # drive a real gstack skill (see A1b caveat)
```

## A1b — resolved ✅

Proven on 2026-07-19: a real gstack skill (`/office-hours`) runs headless and asks its question **in prose** (no `BLOCKED`), then a `claude --resume` turn continues it. The one requirement is the launch config — agents must be started with **`--dangerously-skip-permissions`** so gstack's tools resolve and run unattended (`--permission-mode acceptEdits` was not enough). AgentDeck does this by default (`GORCH_SKIP_PERMISSIONS`, on unless set to `false`). Reproduce with `bun run spike -- --gstack` in a plain shell (not nested inside another Claude Code session, whose sandbox blocks it).

## Layout

```
src/        daemon: config, types, db (SQLite/WAL), git (worktrees), phase,
            agent (supervisor), notify, tasks, bus, server, daemon
public/     Master Inbox dashboard (live over WebSocket)
spike/      A1 instrument (prose+resume proof) + HTTP hook receiver
```

## License

TBD.

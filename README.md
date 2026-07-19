# AgentDeck

Self-hosted, **gstack-native** orchestrator for running multiple Claude Code agents in parallel on a VPS. An air-traffic-control board for your agents: one glance tells you which agent needs you, which is cruising, which broke.

`1 task = 1 branch = 1 git worktree = 1 agent.` Strict isolation, no sharing. Agents run on the server, so they keep going when you close your laptop or drop the SSH connection.

> Status: **v0.1.0.0** — the daemon spine runs end to end (create task → branch → worktree → agent → live dashboard) and the core mechanic is proven end to end: a real gstack skill runs headless, asks in prose, and a `claude --resume` turn continues it (**A1 + A1b, below**). Not yet production-hardened.

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

## Run

Prereqs: [Bun](https://bun.sh), `claude` (Claude Code) on PATH and authenticated, and gstack for the phase tracking.

```bash
bun install   # (no deps yet, but conventional)
GORCH_TARGET_REPO=/path/to/your/project \
GORCH_TG_TOKEN=... GORCH_TG_CHAT=... \
bun run daemon
# → http://127.0.0.1:8787  (bind is localhost — reach it via an SSH tunnel)
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

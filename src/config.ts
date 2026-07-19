import { homedir } from "node:os";
import { join } from "node:path";
import type { GorchConfig } from "./types.ts";

const home = homedir();
const dataDir = process.env.GORCH_DATA_DIR ?? join(home, ".gorch");

export const config: GorchConfig = {
  dataDir,
  // A3: bind localhost only. Reach the dashboard via SSH tunnel, not public exposure.
  // Override with GORCH_HOST=0.0.0.0 ONLY behind a reverse proxy + auth (V2).
  host: process.env.GORCH_HOST ?? "127.0.0.1",
  port: Number(process.env.GORCH_PORT ?? 8787),
  // Default target repo = the current dir; override on the VPS to your project.
  targetRepo: process.env.GORCH_TARGET_REPO ?? process.cwd(),
  worktreesDir: process.env.GORCH_WORKTREES ?? join(dataDir, "worktrees"),
  claudeBin: process.env.GORCH_CLAUDE_BIN ?? "claude",

  // ── A1b launch config (see spike finding) ──────────────────────────────
  // Headless agents need enough permission to actually work. On the VPS this
  // is the knob that decides whether gstack can run. Default is conservative;
  // set GORCH_PERMISSION_MODE=bypassPermissions for fully unattended runs.
  permissionMode: process.env.GORCH_PERMISSION_MODE ?? "acceptEdits",
  extraClaudeArgs: (process.env.GORCH_CLAUDE_ARGS ?? "").split(" ").filter(Boolean),

  maxConcurrentAgents: Number(process.env.GORCH_MAX_AGENTS ?? 4),

  notify: {
    telegram: process.env.GORCH_TG_TOKEN && process.env.GORCH_TG_CHAT
      ? { botToken: process.env.GORCH_TG_TOKEN, chatId: process.env.GORCH_TG_CHAT }
      : undefined,
    slack: process.env.GORCH_SLACK_WEBHOOK
      ? { webhookUrl: process.env.GORCH_SLACK_WEBHOOK }
      : undefined,
  },
};

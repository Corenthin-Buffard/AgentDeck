import { homedir } from "node:os";
import { join } from "node:path";
import type { GorchConfig } from "./types.ts";

const home = homedir();
const dataDir = process.env.GORCH_DATA_DIR ?? join(home, ".gorch");
const port = Number(process.env.GORCH_PORT ?? 8787);

export const config: GorchConfig = {
  dataDir,
  // A3: bind localhost only. Reach the dashboard via SSH tunnel, not public exposure.
  // Override with GORCH_HOST=0.0.0.0 ONLY behind a reverse proxy + auth (V2).
  host: process.env.GORCH_HOST ?? "127.0.0.1",
  port,
  // Default target repo = the current dir; override on the VPS to your project.
  targetRepo: process.env.GORCH_TARGET_REPO ?? process.cwd(),
  worktreesDir: process.env.GORCH_WORKTREES ?? join(dataDir, "worktrees"),
  claudeBin: process.env.GORCH_CLAUDE_BIN ?? "claude",

  // ── A1b launch config (PROVEN by the spike) ─────────────────────────────
  // gstack skills only resolve + run in a headless agent when permissions are
  // fully skipped. This is THE knob that decides whether gstack runs. Default
  // on (unattended orchestrator). Set GORCH_SKIP_PERMISSIONS=false + a
  // GORCH_PERMISSION_MODE only for a supervised debugging session.
  dangerouslySkipPermissions: (process.env.GORCH_SKIP_PERMISSIONS ?? "true") !== "false",
  permissionMode: process.env.GORCH_PERMISSION_MODE ?? "acceptEdits",
  extraClaudeArgs: (process.env.GORCH_CLAUDE_ARGS ?? "").split(" ").filter(Boolean),

  // Notification-hook wiring. Agents are local subprocesses, so they reach the
  // daemon on 127.0.0.1 even when host is 0.0.0.0. Disable with GORCH_HOOKS=false.
  notificationHooks: (process.env.GORCH_HOOKS ?? "true") !== "false",
  hookBaseUrl: process.env.GORCH_HOOK_BASE_URL ?? `http://127.0.0.1:${port}`,
  agentSettingsPath: join(dataDir, "agent-settings.json"),

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

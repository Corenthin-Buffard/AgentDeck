import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentDeckConfig } from "./types.ts";

const home = homedir();
const dataDir = process.env.AGENTDECK_DATA_DIR ?? join(home, ".agentdeck");
const port = Number(process.env.AGENTDECK_PORT ?? 8787);

export const config: AgentDeckConfig = {
  dataDir,
  // A3: bind localhost only. Reach the dashboard via SSH tunnel, not public exposure.
  // Override with AGENTDECK_HOST=0.0.0.0 ONLY behind a reverse proxy + auth (V2).
  host: process.env.AGENTDECK_HOST ?? "127.0.0.1",
  port,
  // Default target repo = the current dir; override on the VPS to your project.
  targetRepo: process.env.AGENTDECK_TARGET_REPO ?? process.cwd(),
  worktreesDir: process.env.AGENTDECK_WORKTREES ?? join(dataDir, "worktrees"),
  claudeBin: process.env.AGENTDECK_CLAUDE_BIN ?? "claude",

  // ── A1b launch config (PROVEN by the spike) ─────────────────────────────
  // gstack skills only resolve + run in a headless agent when permissions are
  // fully skipped. This is THE knob that decides whether gstack runs. Default
  // on (unattended orchestrator). Set AGENTDECK_SKIP_PERMISSIONS=false + a
  // AGENTDECK_PERMISSION_MODE only for a supervised debugging session.
  dangerouslySkipPermissions: (process.env.AGENTDECK_SKIP_PERMISSIONS ?? "true") !== "false",
  permissionMode: process.env.AGENTDECK_PERMISSION_MODE ?? "acceptEdits",
  extraClaudeArgs: (process.env.AGENTDECK_CLAUDE_ARGS ?? "").split(" ").filter(Boolean),

  // Notification-hook wiring. OPT-IN (off by default): it's unproven under
  // headless `claude -p` and it sits in the launch path (every agent gets
  // --settings), so validate on a VPS before trusting it — enable with
  // AGENTDECK_HOOKS=true. Agents are local subprocesses, so they reach the daemon on
  // 127.0.0.1 even when host is 0.0.0.0.
  notificationHooks: process.env.AGENTDECK_HOOKS === "true",
  hookBaseUrl: process.env.AGENTDECK_HOOK_BASE_URL ?? `http://127.0.0.1:${port}`,
  // Per-session shared secret. Agents carry it in the hook URL (?token=); the
  // handlers reject anything else, so a local process can't forge a `waiting`
  // without reading the (0600) settings file. Override to pin it across restarts.
  // `||` (not `??`) on purpose: an empty AGENTDECK_HOOK_TOKEN must NOT disable the
  // gate — a blank token would match a forged `?token=`, silently turning auth off.
  hookToken: process.env.AGENTDECK_HOOK_TOKEN || randomUUID(),
  agentSettingsPath: join(dataDir, "agent-settings.json"),

  maxConcurrentAgents: Number(process.env.AGENTDECK_MAX_AGENTS ?? 4),

  notify: {
    telegram: process.env.AGENTDECK_TG_TOKEN && process.env.AGENTDECK_TG_CHAT
      ? { botToken: process.env.AGENTDECK_TG_TOKEN, chatId: process.env.AGENTDECK_TG_CHAT }
      : undefined,
    slack: process.env.AGENTDECK_SLACK_WEBHOOK
      ? { webhookUrl: process.env.AGENTDECK_SLACK_WEBHOOK }
      : undefined,
  },
};

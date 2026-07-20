// Shared domain types for the AgentDeck daemon.

/** The 6 gstack pipeline phases, plus 'unknown' before we've observed one. */
export type Phase = "plan" | "run" | "review" | "qa" | "ship" | "done" | "unknown";

/** Coarse agent status that drives the Master Inbox attention hierarchy. */
export type Status =
  | "running"    // cruising on its own
  | "waiting"    // needs a human decision — the loud one
  | "error"      // build/test/agent failure
  | "done"       // finished, receded
  | "resuming"   // daemon restarted / reconnecting (A2)
  | "stopped";   // suspended by the user

export interface Task {
  id: string;              // AgentDeck-generated taskId, propagated everywhere (NOT the branch)
  title: string;
  prompt: string;          // the initial instruction handed to the agent
  branch: string;
  worktree: string;        // absolute path to the git worktree
  tmux: string | null;     // optional tmux session name (attach-to-watch)
  sessionId: string | null; // Claude Code session id — the resume handle + A2 durability key
  status: Status;
  phase: Phase;
  pendingQuestion: string | null; // prose question text when status === 'waiting'
  lastActivity: number;    // epoch ms
  createdAt: number;
  error: string | null;
}

export interface AgentEvent {
  taskId: string;
  ts: number;
  kind: "phase" | "status" | "tool" | "question" | "text" | "result" | "log";
  data: string;
}

/** Config knobs — the A1b launch config lives here. */
export interface AgentDeckConfig {
  dataDir: string;
  host: string;            // bind address — 127.0.0.1 by default (A3: localhost + SSH tunnel)
  port: number;
  targetRepo: string;      // the repo whose branches/worktrees agents operate on
  worktreesDir: string;
  claudeBin: string;
  // ── A1b (proven): the launch config that makes agents run gstack headlessly ──
  // The spike proved gstack only resolves + runs unattended with permissions
  // fully skipped. Default true. Set false only for a hands-on debugging run.
  dangerouslySkipPermissions: boolean;
  permissionMode: string;  // used only when dangerouslySkipPermissions=false
  extraClaudeArgs: string[]; // escape hatch for extra claude flags (--add-dir, --model, …)
  // Notification-hook wiring: launched agents POST hook events to the daemon.
  notificationHooks: boolean;    // wire the Notification/PreToolUse HTTP hooks
  hookBaseUrl: string;           // where agents POST hook events (the daemon)
  agentSettingsPath: string;     // the generated `claude --settings` file
  maxConcurrentAgents: number;
  notify: {
    telegram?: { botToken: string; chatId: string };
    slack?: { webhookUrl: string };
  };
}

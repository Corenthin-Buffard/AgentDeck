// Shared domain types for the gorch daemon.

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
  id: string;              // gorch-generated taskId, propagated everywhere (NOT the branch)
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
export interface GorchConfig {
  dataDir: string;
  host: string;            // bind address — 127.0.0.1 by default (A3: localhost + SSH tunnel)
  port: number;
  targetRepo: string;      // the repo whose branches/worktrees agents operate on
  worktreesDir: string;
  claudeBin: string;
  // ── A1b: the launch config that makes agents able to run gstack headlessly ──
  permissionMode: string;  // e.g. 'acceptEdits' | 'bypassPermissions' | 'default'
  extraClaudeArgs: string[]; // escape hatch for --add-dir, --settings, etc.
  maxConcurrentAgents: number;
  notify: {
    telegram?: { botToken: string; chatId: string };
    slack?: { webhookUrl: string };
  };
}

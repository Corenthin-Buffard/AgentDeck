// Shared domain types for the AgentDeck daemon.

/** The 6 gstack pipeline phases, plus 'unknown' before we've observed one. */
export type Phase = "plan" | "run" | "review" | "qa" | "ship" | "done" | "unknown";

/** One gstack plan-review's observed state, from the branch's review log.
 *  `null` (the field's other inhabitant) means the review never ran. */
export type PlanReviewState = {
  status: "clean" | "not-clean"; // "not-clean" = ran without a "clean" status (issues, or a tool failure/abort)
  stale: boolean;                // the review's commit ≠ the worktree's current HEAD
  detail?: string;              // human-readable summary from the log, e.g. "13 issues, 0 unresolved" (title + aria-label)
} | null;

/** The three plan-phase reviews AgentDeck surfaces on a card. */
export interface PlanReviews {
  ceo: PlanReviewState;    // /plan-ceo-review    — scope & strategy
  design: PlanReviewState; // /plan-design-review — UI/UX
  eng: PlanReviewState;    // /plan-eng-review    — architecture (the required one, gates /ship)
}

/** Coarse agent status that drives the Master Inbox attention hierarchy. */
export type Status =
  | "running"    // cruising on its own
  | "waiting"    // needs a human decision — the loud one
  | "error"      // build/test/agent failure
  | "done"       // finished, receded
  | "resuming"   // daemon restarted / reconnecting (A2)
  | "stopped";   // suspended by the user

/** A registered repo an agent can operate on. The registry (projects.json, or a
 *  synthesized `default`) replaces the old single targetRepo. */
export interface Project {
  id: string;              // stable routing key (DB column, dashboard filter)
  path: string;            // absolute path to the git repo
  label: string;           // human name shown in the dashboard (defaults to basename)
}

export interface Task {
  id: string;              // AgentDeck-generated taskId, propagated everywhere (NOT the branch)
  project: string;         // Project.id this task's branch/worktree lives in
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
  planReviews: PlanReviews; // which plan reviews ran on this branch (auto-detected from the gstack log)
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
  targetRepo: string;      // legacy single-repo default; seeds the `default` project
  projects: Project[];     // the project registry — what agents can operate on
  worktreesDir: string;
  uploadsDir: string;      // local→VPS uploads land here (per-project subdir)
  claudeBin: string;
  reviewReadBin: string;   // gstack-review-read — reads a branch's plan-review log (best-effort; may be absent)
  autoCleanMerged: boolean; // opt-in: periodically drop worktree+branch+row for done tasks whose branch is merged
  // ── A1b (proven): the launch config that makes agents run gstack headlessly ──
  // The spike proved gstack only resolves + runs unattended with permissions
  // fully skipped. Default true. Set false only for a hands-on debugging run.
  dangerouslySkipPermissions: boolean;
  permissionMode: string;  // used only when dangerouslySkipPermissions=false
  extraClaudeArgs: string[]; // escape hatch for extra claude flags (--add-dir, --model, …)
  // Notification-hook wiring: launched agents POST hook events to the daemon.
  notificationHooks: boolean;    // wire the Notification/PreToolUse HTTP hooks
  hookBaseUrl: string;           // where agents POST hook events (the daemon)
  hookToken: string;             // per-session secret for AGENTS; hook POSTs carry ?token= (0600 file only)
  dashboardToken: string;        // per-session secret for the BROWSER; injected into the served HTML,
                                 //   sent as x-agentdeck-token on write requests (anti-CSRF)
  agentSettingsPath: string;     // the generated `claude --settings` file
  maxConcurrentAgents: number;
  notify: {
    telegram?: { botToken: string; chatId: string };
    slack?: { webhookUrl: string };
  };
}

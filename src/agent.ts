import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "./config.ts";
import { store } from "./db.ts";
import { emitUpdate } from "./bus.ts";
import { notify } from "./notify.ts";
import { phaseFromSignal, mergePhase, canStillReview } from "./phase.ts";
import { looksLikeQuestion } from "./detect.ts";
import type { Task, Phase, Status, PlanReviews, PlanReviewState } from "./types.ts";

// The agent supervisor. Everything the spike proved lives here:
//   • agents run HEADLESS (no tmux substrate) — Path A
//   • AskUserQuestion is unavailable headless → the agent asks in PROSE and the
//     turn ends → we detect that and mark the task `waiting`
//   • answering == a NEW `claude --resume <sid> -p "<answer>"` turn.
//     Injection AND A2 durability are the SAME operation.

const running = new Map<string, ChildProcess>();

// ── Plan-review tracking ─────────────────────────────────────────────────────
// We surface which of the three gstack plan reviews (CEO/Design/Eng) a task's
// branch has been through, read from the branch's `*-reviews.jsonl` via
// `gstack-review-read`. The parse is pure + exported so it's unit-testable
// without spawning; the refresh is a bounded, best-effort subprocess.

const REVIEW_KEY: Record<string, keyof PlanReviews> = {
  "plan-ceo-review": "ceo",
  "plan-design-review": "design",
  "plan-eng-review": "eng",
};
const REVIEW_READ_TIMEOUT_MS = 4000;
const refreshing = new Set<string>();    // per-task in-flight guard: at most one reader per task
let reviewBinOk: boolean | null = null;  // memoized existsSync — don't re-spawn a missing bin every turn
function reviewReadAvailable(): boolean {
  if (reviewBinOk === null) reviewBinOk = existsSync(config.reviewReadBin);
  return reviewBinOk;
}

/** Build one review's state from its log entry (the LAST entry for that skill). */
function stateFromEntry(e: any, head: string): PlanReviewState {
  const commit = typeof e.commit === "string" ? e.commit : "";
  // Compare short SHAs by PREFIX, not equality: `git rev-parse --short` auto-grows
  // its length as the repo gains commits, so the log's `d04fb79` and a later HEAD
  // `d04fb790` are the SAME commit — exact `!==` would mark it stale forever. Only
  // real, differing commits are stale; `uncommitted`/`unknown` aren't comparable.
  const comparable = !!(commit && head && commit !== "uncommitted" && commit !== "unknown" && head !== "unknown");
  const samePrefix = comparable && (head.startsWith(commit) || commit.startsWith(head));
  const stale = comparable && !samePrefix;
  return { status: e.status === "clean" ? "clean" : "not-clean", stale, detail: detailFor(e) };
}

/** Human-readable summary tailored to each review's log fields; undefined if none. */
function detailFor(e: any): string | undefined {
  const num = (v: any) => (typeof v === "number" ? v : undefined);
  if (e.skill === "plan-eng-review") {
    const issues = num(e.issues_found), unresolved = num(e.unresolved);
    if (issues !== undefined || unresolved !== undefined) return `${issues ?? "?"} issues, ${unresolved ?? "?"} unresolved`;
  } else if (e.skill === "plan-design-review") {
    const score = num(e.overall_score), unresolved = num(e.unresolved);
    if (score !== undefined) return `score ${score}/10, ${unresolved ?? "?"} unresolved`;
  } else if (e.skill === "plan-ceo-review") {
    const acc = num(e.scope_accepted), prop = num(e.scope_proposed);
    if (acc !== undefined && prop !== undefined) return `scope ${acc}/${prop}`;
  }
  // No structured counts: say only whether it was clean, never invent "issues".
  return e.status === "clean" ? undefined : "ran (not clean)";
}

/**
 * Parse `gstack-review-read` output into the three plan-review states. PURE +
 * exported (unit-testable without a process). The reader prints the branch's
 * review-log JSONL (or `NO_REVIEWS`), then `---CONFIG---`, then `---HEAD---`
 * followed by the current short HEAD. Last entry per skill wins — the log is
 * append-only so file order is chronological (no timestamp parsing, robust to a
 * missing/!skewed `timestamp`).
 */
export function parsePlanReviews(output: string): PlanReviews {
  const reviews: PlanReviews = { ceo: null, design: null, eng: null };
  const lines = output.split("\n");
  // The markers are the trailer, always at the END. Match a line that ENDS with the
  // marker (not merely contains it), scanning from the LAST occurrence — so a review
  // -log JSON field that happens to embed `---CONFIG---`/`---HEAD---` mid-string
  // can't be mistaken for the protocol. `endsWith` also handles the real reader's
  // glued `false---HEAD---` (gstack-config prints its value with no trailing newline);
  // HEAD is then the first non-empty line AFTER that marker line.
  const configIdx = lines.findLastIndex((l) => l.trim().endsWith("---CONFIG---"));
  const headIdx = lines.findLastIndex((l) => l.trim().endsWith("---HEAD---"));
  const dataEnd = configIdx >= 0 ? configIdx : (headIdx >= 0 ? headIdx : lines.length);
  let head = "";
  if (headIdx >= 0) {
    for (let i = headIdx + 1; i < lines.length; i++) { const t = lines[i].trim(); if (t) { head = t; break; } }
  }
  for (let i = 0; i < dataEnd; i++) {
    const line = lines[i].trim();
    if (!line || line === "NO_REVIEWS") continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    const key = REVIEW_KEY[e?.skill];
    if (key) reviews[key] = stateFromEntry(e, head); // overwrite → last wins
  }
  return reviews;
}

/**
 * Best-effort refresh of a task's plan-review marks from its worktree's gstack log.
 * Bounded (spawn + kill after ~4s) and silent on any failure — a display nicety,
 * never a reason to disrupt the agent. Diffs against the FRESH DB value (not a
 * possibly-stale in-closure Task), so it writes + broadcasts only on a real change.
 */
export async function refreshPlanReviews(task: Task): Promise<void> {
  // Skip if the bin is gone (don't re-spawn a missing binary every turn) or a reader
  // is already running for this task (bounds concurrency + prevents out-of-order writes).
  if (!reviewReadAvailable() || refreshing.has(task.id)) return;
  refreshing.add(task.id);
  try {
    const proc = Bun.spawn([config.reviewReadBin], { cwd: task.worktree, stdout: "pipe", stderr: "ignore" });
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { proc.kill(); } catch { /* already gone */ } }, REVIEW_READ_TIMEOUT_MS);
    let output = "";
    try { output = await new Response(proc.stdout).text(); }
    finally { clearTimeout(timer); }
    const code = await proc.exited;
    // Only trust a clean, un-killed, COMPLETE run. A timeout-kill, nonzero exit (the
    // real reader is `set -euo pipefail` — a non-gstack branch aborts on unbound
    // $BRANCH before any output), or a missing `---HEAD---` trailer all mean the
    // output is truncated and would parse to all-null. Writing THAT would clobber
    // good marks (and a slow refresh could revert a newer one) — leave prior state.
    if (killed || code !== 0 || !output.includes("---HEAD---")) return;
    const reviews = parsePlanReviews(output);
    const current = store.getTask(task.id)?.planReviews;
    if (JSON.stringify(reviews) !== JSON.stringify(current)) {
      store.setPlanReviews(task.id, reviews);
      emitUpdate(task.id);
    }
  } catch { /* missing bin, non-git worktree, spawn/kill error — all silent by design */ }
  finally { refreshing.delete(task.id); }
}

// Concurrency cap (eng-review + code-review finding): bound parallel `claude`
// processes so N tasks don't blow past API rate limits / RAM. Excess launches
// queue and start as slots free on child exit. Single-threaded → no race
// between the size check and running.set inside attach().
const waitQueue: Array<() => void> = [];
function pump(): void {
  while (running.size < config.maxConcurrentAgents && waitQueue.length) {
    waitQueue.shift()!();
  }
}
function schedule(spawnFn: () => void): void { waitQueue.push(spawnFn); pump(); }

// One live child per task. A resume/answer while a child is still alive (e.g. a
// Notification-driven `waiting` fires mid-turn) must NOT spawn a second
// `claude --resume` on the same session — kill the old one first. Removing it
// from `running` here means its exit handler (identity-guarded) becomes a no-op.
export function killExisting(taskId: string): void {
  const c = running.get(taskId);
  if (c) { running.delete(taskId); try { c.kill("SIGTERM"); } catch { /* already gone */ } }
}

// ── A1b (proven): the launch config that lets an agent run gstack headlessly ──
// The spike confirmed gstack only resolves + runs unattended with permissions
// fully skipped; `--permission-mode acceptEdits` was not enough.
function baseArgs(): string[] {
  const perm = config.dangerouslySkipPermissions
    ? ["--dangerously-skip-permissions"]
    : ["--permission-mode", config.permissionMode];
  // Load the daemon's hook settings so the agent POSTs Notification events back.
  // Skip it if the operator already passed their own --settings (avoid a duplicate flag).
  const userSettings = config.extraClaudeArgs.includes("--settings");
  const settings = config.notificationHooks && !userSettings ? ["--settings", config.agentSettingsPath] : [];
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...perm,
    ...settings,
    ...config.extraClaudeArgs, // e.g. --add-dir, --model
  ];
}

function attach(task: Task, child: ChildProcess) {
  running.set(task.id, child);
  // Backfill on every (re)attach — launch, answer/resume, or A2 restart — so a
  // task whose reviews were logged while the daemon was down (or before this
  // feature existed) gets its marks the moment its agent comes back, not only at
  // the next turn-end. Gated on canStillReview so a resumed ship/done task doesn't
  // spawn a reader for a phase we no longer poll. No-op for a fresh task (empty log).
  if (canStillReview(task.phase)) void refreshPlanReviews(task);
  let buf = "";
  let text = "";
  const now = () => Date.now();

  const patch = (p: Partial<Task>) => { store.patchTask(task.id, { ...p, lastActivity: now() }); emitUpdate(task.id); };
  const log = (kind: any, data: string) => store.addEvent({ taskId: task.id, ts: now(), kind, data });
  const setPhase = (next: Phase) => {
    const t = store.getTask(task.id); if (!t) return;
    const merged = mergePhase(t.phase, next);
    if (merged !== t.phase) { patch({ phase: merged }); log("phase", merged); }
  };

  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      handle(e);
    }
  });

  child.on("exit", (code) => {
    // Only the currently-registered child owns this task's slot + status. A child
    // superseded by killExisting() (answer/resume) is a no-op on exit — otherwise
    // it would delete the new child's slot entry and falsely mark the task error.
    if (running.get(task.id) !== child) return;
    running.delete(task.id);
    const t = store.getTask(task.id);
    if (t && t.status === "running") { patch({ status: "error", error: `agent exited (code ${code}) mid-run` }); notify(store.getTask(task.id)!, "error"); }
    pump(); // free the slot → start the next queued agent
  });

  function handle(e: any) {
    if (e.type === "system" && e.subtype === "init") {
      patch({ sessionId: e.session_id, status: "running" });
      log("log", `session ${e.session_id}`);
      return;
    }
    if (e.type === "stream_event") {
      const ev = e.event;
      if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        const name: string = ev.content_block.name;
        log("tool", name);
        const p = phaseFromSignal({ tool: name }); if (p) setPhase(p);
        if (name === "Skill" && ev.content_block.input?.skill) {
          const sp = phaseFromSignal({ skill: String(ev.content_block.input.skill) }); if (sp) setPhase(sp);
        }
        patch({}); // bump lastActivity
        return;
      }
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") { return; } // liveness-only; not accumulated
    }
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      // Single source of truth for the turn's text: the consolidated assistant
      // message(s). Deltas carry the same text and are NOT accumulated, so there's
      // no doubling — and no substring-dedup that could drop a restated question
      // and silently flip waiting -> done.
      for (const c of e.message.content) if (c.type === "text") text += c.text;
    }
    if (e.type === "result") {
      // Refresh the plan-review marks BEFORE mutating phase/status. Gate on the
      // CURRENT phase (still ≤ review at this instant) so the very turn that
      // finishes a review AND moves the task to `done` isn't skipped — checking
      // after setPhase("done") would fail the gate and miss that completion.
      // Fire-and-forget + best-effort: it reads its own fresh DB row and only
      // broadcasts on a change, so it can't delay or corrupt the transition below.
      const cur = store.getTask(task.id);
      if (cur && canStillReview(cur.phase)) void refreshPlanReviews(cur);
      const finalText = (text || e.result || "").trim();
      log("text", finalText.slice(0, 2000));
      if (e.subtype !== "success") {
        patch({ status: "error", error: `result: ${e.subtype}` });
        notify(store.getTask(task.id)!, "error");
      } else if (looksLikeQuestion(finalText)) {
        // The agent's ask sits at the END of the turn; for a long turn (a heavy
        // gstack skill) keep the TAIL, not the head, so the drawer shows the
        // actual question/decision briefs instead of the intro.
        const shown = finalText.length > 2000 ? "…" + finalText.slice(-1999) : finalText;
        patch({ status: "waiting", pendingQuestion: shown });
        log("question", shown);
        notify(store.getTask(task.id)!, "waiting");
      } else {
        setPhase("done");
        patch({ status: "done" });
        notify(store.getTask(task.id)!, "done");
      }
      text = "";
    }
  }
}

/** Launch a fresh agent for a task (turn 1). */
export function launchTask(task: Task): void {
  schedule(() => {
    const child = spawn(config.claudeBin, [...baseArgs(), task.prompt], {
      cwd: task.worktree, stdio: ["ignore", "pipe", "inherit"],
    });
    attach(task, child);
  });
}

/** Human answer to a waiting agent — the proven prose+resume mechanic. */
export function answer(taskId: string, text: string): void {
  const t = store.getTask(taskId);
  if (!t?.sessionId) throw new Error("no session id to resume");
  killExisting(taskId); // never run two claude --resume on one session
  store.patchTask(taskId, { status: "running", pendingQuestion: null, lastActivity: Date.now() });
  emitUpdate(taskId);
  schedule(() => {
    const child = spawn(config.claudeBin, ["--resume", t.sessionId!, ...baseArgs(), text], {
      cwd: t.worktree, stdio: ["ignore", "pipe", "inherit"],
    });
    attach(t, child);
  });
}

/** A2 durability: after a daemon restart, resume any task that was mid-run. */
export function resumeTask(taskId: string): void {
  const t = store.getTask(taskId);
  if (!t?.sessionId) return;
  killExisting(taskId);
  store.patchTask(taskId, { status: "resuming", lastActivity: Date.now() });
  emitUpdate(taskId);
  schedule(() => {
    const child = spawn(config.claudeBin, ["--resume", t.sessionId!, ...baseArgs(), "continue where you left off"], {
      cwd: t.worktree, stdio: ["ignore", "pipe", "inherit"],
    });
    attach(t, child);
  });
}

export function stopTask(taskId: string): void {
  running.get(taskId)?.kill("SIGTERM");
  store.patchTask(taskId, { status: "stopped", lastActivity: Date.now() });
  emitUpdate(taskId);
}

export function isRunning(taskId: string): boolean { return running.has(taskId); }

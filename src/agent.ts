import { spawn, type ChildProcess } from "node:child_process";
import { config } from "./config.ts";
import { store } from "./db.ts";
import { emitUpdate } from "./bus.ts";
import { notify } from "./notify.ts";
import { phaseFromSignal, mergePhase } from "./phase.ts";
import { looksLikeQuestion } from "./detect.ts";
import type { Task, Phase, Status } from "./types.ts";

// The agent supervisor. Everything the spike proved lives here:
//   • agents run HEADLESS (no tmux substrate) — Path A
//   • AskUserQuestion is unavailable headless → the agent asks in PROSE and the
//     turn ends → we detect that and mark the task `waiting`
//   • answering == a NEW `claude --resume <sid> -p "<answer>"` turn.
//     Injection AND A2 durability are the SAME operation.

const running = new Map<string, ChildProcess>();

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
function killExisting(taskId: string): void {
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

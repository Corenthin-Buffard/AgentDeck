import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "./config.ts";
import { store } from "./db.ts";
import { emitUpdate } from "./bus.ts";
import { clearNotice, notice } from "./notices.ts";
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
//
// Entries carry their taskId so killExisting() can CANCEL a launch that hasn't
// spawned yet. Before that, the queue was invisible to it: `running` only holds
// children that already exist, so a task still waiting for a slot could be
// "stopped" and spawn anyway, and answering one scheduled a SECOND launch beside
// the pending first — two `claude --resume` on one session, which is the exact
// thing killExisting exists to prevent. The second attach() also overwrote the
// first in `running`, so the map undercounted live children (silently breaching
// the cap) and the orphan's identity-guarded exit skipped pump(), leaking a slot.
const waitQueue: Array<{ taskId: string; run: () => void }> = [];
function pump(): void {
  while (running.size < config.maxConcurrentAgents && waitQueue.length) {
    waitQueue.shift()!.run();
  }
}
function schedule(taskId: string, spawnFn: () => void): void {
  waitQueue.push({ taskId, run: spawnFn });
  pump();
}

/** Drop any not-yet-spawned launches for a task. Returns how many were cancelled. */
function cancelQueued(taskId: string): number {
  let n = 0;
  for (let i = waitQueue.length - 1; i >= 0; i--) {
    if (waitQueue[i].taskId === taskId) { waitQueue.splice(i, 1); n++; }
  }
  return n;
}

// Children that were superseded and are on their way out. Marked rather than
// forgotten, so their terminal handler still frees the concurrency slot and pumps
// the queue, but does NOT touch the task's status — the replacement owns that now.
const supersededChildren = new WeakSet<ChildProcess>();
const dying = new Map<string, Promise<void>>();
// A child that ignores SIGTERM (mid tool-call, blocked syscall) must not hold a
// replacement forever. Escalate, then proceed regardless.
const SIGKILL_AFTER_MS = 5000;

// Launch generation per task. Every kill invalidates any replacement that was
// waiting on an earlier one, so two answers in quick succession spawn once, not
// twice, and a stop or delete cancels a replacement that hasn't spawned yet.
const launchGen = new Map<string, number>();
function bumpGen(taskId: string): number {
  const g = (launchGen.get(taskId) ?? 0) + 1;
  launchGen.set(taskId, g);
  return g;
}

/** SIGTERM a child and resolve once it is actually gone (or SIGKILL-ed). */
function retire(taskId: string, child: ChildProcess): Promise<void> {
  const inFlight = dying.get(taskId);
  if (inFlight) return inFlight;
  const p = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { finish(); } }, SIGKILL_AFTER_MS);
    timer.unref?.(); // never hold the process open just to wait on a corpse
    child.once("close", finish);
    child.once("error", finish);
    try { child.kill("SIGTERM"); } catch { finish(); } // already dead
  });
  dying.set(taskId, p);
  void p.then(() => { if (dying.get(taskId) === p) dying.delete(taskId); });
  return p;
}

/**
 * Retire the task's current agent, whether it has spawned yet or not, and resolve
 * once it is GONE.
 *
 * Awaiting the exit is the point. It used to SIGTERM and return in the same tick,
 * so the replacement spawned while the old `claude` was still alive — two agents
 * appending to one session transcript and editing one worktree for however long
 * the old one took to die. Nothing errored; the transcript and the worktree simply
 * disagreed with themselves. The concurrency slot is likewise released when the
 * child actually closes, not when the signal is sent, so the cap stays honest.
 */
export function killExisting(taskId: string): Promise<void> {
  bumpGen(taskId);                       // invalidate any replacement still waiting
  const cancelled = cancelQueued(taskId);
  const c = running.get(taskId);
  if (!c) {
    // Nothing live, but a cancelled queue entry still freed intent — let the queue move.
    if (cancelled) pump();
    return Promise.resolve();
  }
  supersededChildren.add(c);
  return retire(taskId, c);
}

/** Schedule `spawnFn` once the outgoing agent is gone, unless a newer kill wins. */
function scheduleAfterExit(taskId: string, spawnFn: () => void): void {
  const gone = killExisting(taskId);
  const gen = launchGen.get(taskId);
  void gone.then(() => {
    if (launchGen.get(taskId) !== gen) return; // a newer answer/stop/delete superseded us
    schedule(taskId, spawnFn);
  });
}

// ── A1b (proven): the launch config that lets an agent run gstack headlessly ──
// The spike confirmed gstack only resolves + runs unattended with permissions
// fully skipped; `--permission-mode acceptEdits` was not enough. baseArgs() builds
// the flags; agentEnv()/spawnOpts() below build the environment they run in.

/**
 * The environment every spawned agent inherits.
 *
 * Claude Code refuses `--dangerously-skip-permissions` as uid 0 unless it is told
 * it's in a deliberate sandbox, so a root daemon fails every task at spawn.
 * IS_SANDBOX=1 is that signal. We honour the refusal by DEFAULT — an operator who
 * ran the daemon as root by accident (an unset systemd `User=`) should see agents
 * fail loudly, not silently get root agents with permissions skipped.
 * AGENTDECK_ALLOW_ROOT=true is the explicit "I meant it".
 *
 * PURE + exported so the whole matrix is testable without actually being uid 0.
 * Returns `base` unchanged (not a copy) when there's nothing to add, so the common
 * path allocates nothing.
 */
export function agentEnv(base: NodeJS.ProcessEnv, allowRoot: boolean, uid: number | undefined): NodeJS.ProcessEnv {
  if (!allowRoot || uid !== 0) return base;
  return { ...base, IS_SANDBOX: "1" };
}

/**
 * Common spawn options for every `claude` launch — one helper, because with env
 * injection added, three copies of this literal is three places to get root wrong.
 *
 * stderr is PIPED rather than inherited so a crash can carry its own explanation
 * onto the task row. attach() relays every chunk back to our own stderr, so
 * journald still sees what `inherit` gave it. NOTE: piping means SOMEONE MUST
 * DRAIN IT — attach() always attaches a listener on the same tick. A future caller
 * that spawns without attach() would block a chatty agent on a full 64KiB pipe.
 *
 * Not memoized on purpose: the test suite shares one `config` singleton, and a
 * cached env would make config.allowRoot un-overridable in tests.
 */
function spawnOpts(cwd: string): SpawnOptions {
  return {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: agentEnv(process.env, config.allowRoot, process.getuid?.()),
  };
}

// How much of a dead agent's stderr we keep. STDERR_ERROR_MAX is the task.error
// budget — enough for the whole of a real failure (the root refusal is 93 bytes)
// without turning a card into a wall.
// One cap for every event row we persist, so no single row is an outlier and the
// coupling is enforced rather than asserted in a comment. Used by the stderr tail
// and by the `text` event below.
export const EVENT_TEXT_MAX = 2000;
const STDERR_TAIL_MAX = EVENT_TEXT_MAX;
const STDERR_ERROR_MAX = 300;
// How much unflushed relay we tolerate on our OWN stderr before we stop mirroring
// a chatty agent. Only reachable when the log sink (journald) has stalled; 1 MiB
// is generous for a transient hiccup and small enough that four agents hitting it
// at once can't matter.
const STDERR_RELAY_MAX_QUEUE = 1 << 20;

/**
 * Should we mirror this chunk to our own stderr?
 *
 * PURE + exported so the rule is testable against the SHIPPED code. The first
 * implementation keyed on `process.stderr.write()` returning false, which drops
 * nothing — `false` is an advisory "past the high-water mark" and the chunk is
 * queued either way. Only the already-queued length can bound the heap.
 */
export function shouldRelay(queuedBytes: number, max = STDERR_RELAY_MAX_QUEUE): boolean {
  return queuedBytes <= max;
}

/**
 * Bounded stderr accumulator. PURE (no I/O, no timers) + exported so eviction and
 * chunk-boundary behaviour are unit-testable without spawning.
 *
 * Deliberately NOT a line picker. An earlier design latched "the first meaningful
 * line" as the cause; measuring the real failure killed it. `claude -p` with stdin
 * ignored emits exactly one 93-byte line with no ANSI — but give it a tty stdin and
 * it PREPENDS "Warning: no stdin data received in 3s…", pushing the real cause to
 * line 2. Any first-line rule would have shown the operator the stdin warning. The
 * whole (bounded) tail has no such failure mode and is less code.
 */
export function createStderrTail(max = STDERR_TAIL_MAX) {
  let tail = "";
  return {
    push(chunk: string) {
      // Slice the chunk first when it alone overflows, so a single huge write
      // doesn't build a giant intermediate string just to throw most of it away.
      tail = chunk.length >= max ? chunk.slice(-max) : (tail + chunk).slice(-max);
    },
    tail: (): string => tail,
    /** One-line excerpt for `task.error`: newlines collapsed so it can't break a
     *  card's layout, trimmed, and capped. "" when there was nothing on stderr. */
    excerpt: (): string => {
      // trim() BEFORE collapsing: a trailing "\n" would otherwise become " · "
      // and survive as a dangling "·" once the space is trimmed.
      const flat = tail.trim().replace(/\s*[\r\n]+\s*/g, " · ");
      return flat.length > STDERR_ERROR_MAX ? flat.slice(0, STDERR_ERROR_MAX - 1) + "…" : flat;
    },
  };
}

/** Why a child stopped. `signal` was previously dropped, so an OOM-killed agent
 *  read as "code null" — the literal string that started this whole investigation. */
export function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
}

/**
 * Strip secrets out of captured stderr before it is persisted.
 *
 * This matters BECAUSE of the capture: stderr used to be `inherit`, so it reached
 * journald and nothing else. It now lands in `task.error` and the events table,
 * both of which are served by GET reads that carry no dashboard token (only the
 * Host gate). An agent inherits the daemon's environment and can read the 0600
 * agent-settings.json, whose hook URLs embed the hook token as `?token=…` — so a
 * single failed hook POST echoing its URL would publish that token to any reader.
 *
 * PURE + exported so the redaction is testable without spawning. Secrets are
 * passed in rather than read from `config` so a test can't be fooled by ordering.
 */
export function scrubSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    // Guard against short/empty values: a 1-char "secret" would redact everything.
    if (!s || s.length < 8) continue;
    out = out.split(s).join("[redacted]");
  }
  // Belt and braces for anything token-shaped we didn't know to look for.
  return out.replace(/([?&](?:token|api[-_]?key|secret)=)[^&\s"']+/gi, "$1[redacted]");
}

// Claude Code's root refusal, matched loosely on purpose. Anchoring on the exact
// English sentence would be brittle in exactly the scenario this detects: whatever
// upstream change removes IS_SANDBOX can also reword the message.
const ROOT_REFUSAL = /root\/sudo privileges/i;

/** A task whose currently-registered child dying should mark it failed. Both
 *  terminal handlers use this: 'exit' had an allowlist and 'error' a denylist for
 *  the same decision, so a new Status had to be remembered in two shapes and a
 *  `waiting` task was treated differently depending on which handler fired. */
const isLive = (s: Status): boolean => s === "running" || s === "resuming";

/**
 * The bypass must never be able to lie. IS_SANDBOX is an undocumented Claude Code
 * internal; if an auto-update drops it, every task starts failing again while the
 * dashboard still shows the amber "agents are spawned with IS_SANDBOX=1" notice.
 * A wrong banner is worse than no banner, so a task that dies on the refusal while
 * allowRoot is on retracts it with an error notice. Deduped by code, so a hundred
 * failing tasks add exactly one.
 */
function checkRootBypassStillWorks(stderr: string): void {
  // uid guard: without it, a NON-root daemon that merely inherits ALLOW_ROOT from a
  // shared EnvironmentFile would publish a flatly false "no task can start".
  if (process.getuid?.() !== 0 || !config.allowRoot || !ROOT_REFUSAL.test(stderr)) return;
  notice("error", "root-bypass-failed",
    "AGENTDECK_ALLOW_ROOT is set, but Claude Code still refused --dangerously-skip-permissions as root — the IS_SANDBOX escape hatch this relies on is undocumented and appears to have been removed upstream. No task can start. Run the daemon as an unprivileged user, or set AGENTDECK_SKIP_PERMISSIONS=false (agents run, gstack skills won't resolve).");
}

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
  const err = createStderrTail();
  let droppedStderr = 0;
  // Did this child ever get far enough to report a session? A launch the root
  // guard refused never does. Used to keep agent prose from impersonating a
  // daemon-level failure — see captureStderr.
  let sawInit = false;
  const now = () => Date.now();

  const patch = (p: Partial<Task>) => { store.patchTask(task.id, { ...p, lastActivity: now() }); emitUpdate(task.id); };
  const log = (kind: any, data: string) => store.addEvent({ taskId: task.id, ts: now(), kind, data });
  const setPhase = (next: Phase) => {
    const t = store.getTask(task.id); if (!t) return;
    const merged = mergePhase(t.phase, next);
    if (merged !== t.phase) { patch({ phase: merged }); log("phase", merged); }
  };

  // `?.` not `!`: on Bun these streams exist even for a spawn that never started,
  // but a TypeError thrown from the code path whose whole job is surviving a
  // failed spawn would be self-defeating.
  child.stdout?.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      handle(e);
    }
  });

  // stderr: FORWARD first, observe second. The daemon's fd 2 is journald's view of
  // the world and must not change — same bytes, same order, no per-line prefixing.
  //
  // HONOUR BACKPRESSURE. With `inherit` the kernel wired the child's fd 2 straight
  // to journald, so a stalled journald blocked the CHILD. Piping moves that queue
  // into this process: under systemd our stderr is a socket, which Node writes to
  // asynchronously and buffers without limit. Four chatty agents plus a stuck
  // journald would grow the heap of the one process that owns every running agent.
  //
  // Check writableLength BEFORE writing. Reacting to write()'s return value does
  // NOT work: `false` is an advisory "you're past the high-water mark", and the
  // chunk is queued either way — so treating it as a drop bounds nothing and
  // miscounts. Skipping the write is the only thing that actually caps the heap,
  // and it costs nothing that matters: the bounded tail below still has the
  // diagnosis, and journald is only missing bytes while it is already stalled.
  child.stderr?.on("data", (d: Buffer) => {
    try {
      if (shouldRelay(process.stderr.writableLength ?? 0)) process.stderr.write(d);
      else droppedStderr += d.length;
    } catch { droppedStderr += d.length; } // our own stderr is gone; keep observing
    err.push(d.toString());
  });
  // A dead pipe (EPIPE on a killed child) must not surface as an unhandled 'error'
  // on the stream — that's the same daemon-killer this change exists to fix.
  child.stderr?.on("error", () => { /* nothing to say, nothing to do */ });

  /**
   * Claim this task's slot for the terminal handler that fires first.
   *
   * The identity guard is what makes both paths safe: a child superseded by
   * killExisting() (answer/resume) is a no-op here, because its slot already
   * belongs to someone else — otherwise it would delete the new child's entry and
   * falsely mark the task error. And because the first handler to run deletes the
   * entry, a child that fires BOTH 'error' and 'exit' (Node promises neither way)
   * is handled exactly once. The guard doubles as once-semantics.
   */
  const release = (): { held: boolean; owns: boolean } => {
    const held = running.get(task.id) === child;
    if (held) running.delete(task.id);
    // A superseded child still gives its slot back, but the replacement owns the
    // task's status — otherwise the outgoing agent would mark it error under the
    // incoming one's feet.
    return { held, owns: held && !supersededChildren.has(child) };
  };

  /** Record what the child said before it died, and hand back the one-line excerpt.
   *  Everything persisted here is readable over ungated GET reads, so it is
   *  scrubbed first — see scrubSecrets. */
  const captureStderr = (code: number | null, signal: NodeJS.Signals | null): string => {
    const raw = err.tail();
    const tail = scrubSecrets(raw, [config.dashboardToken, config.hookToken]);
    if (tail) log("stderr", droppedStderr ? `${tail}\n… (${droppedStderr} more bytes dropped while our log was stalled)` : tail);
    // Only a child that died BEFORE reaching the init event can be evidence that
    // the root guard refused the launch. Without that condition, an agent merely
    // printing the phrase — reviewing this repo, say, where it appears in the
    // README and the CHANGELOG — would raise an undismissable daemon-wide error.
    if (!sawInit && !signal && code !== 0) checkRootBypassStillWorks(raw);
    return scrubSecrets(err.excerpt(), [config.dashboardToken, config.hookToken]);
  };

  // "close", not "exit". 'exit' fires when the child ends, while its stdio streams
  // may still hold buffered data — so reading the stderr tail there can truncate
  // the very message we captured it for, and `sawInit` can be read before the
  // stdout handler that sets it has run. 'close' is emitted only once the stdio
  // streams are closed, and carries the same (code, signal).
  child.on("close", (code, signal) => {
    const { held, owns } = release();
    if (!held) { pump(); return; }   // already released; still let the queue move
    if (!owns) { pump(); return; }   // superseded: slot returned, status is not ours
    const t = store.getTask(task.id);
    // "resuming" as well as "running": a task whose `claude --resume` dies before
    // the init event never reaches "running", and used to sit in "resuming" for
    // ever with no error text. That is exactly the root-failure path for tasks the
    // A2 loop resumes at daemon restart.
    if (t && isLive(t.status)) {
      // Log the tail BEFORE the patch, so a dashboard that opens the drawer the
      // instant the error appears already has the context. Only on an abnormal
      // exit — a clean exit's warnings are journald's business.
      const why = (signal || code !== 0) ? captureStderr(code, signal) : "";
      patch({ status: "error", error: `agent exited (${exitReason(code, signal)}) mid-run${why ? `: ${why}` : ""}` });
      notify(store.getTask(task.id)!, "error");
    }
    pump(); // free the slot → start the next queued agent
  });

  // A spawn that NEVER STARTED. ENOENT on config.claudeBin is the common one (a
  // systemd unit's PATH is not your login shell's), and 'exit' does NOT fire for
  // it. Without this handler the EventEmitter rethrows and takes the whole daemon
  // down, killing every other running agent with it — and under Restart=on-failure
  // plus the A2 resume loop, that is a crash loop rather than one dead process.
  child.on("error", (e: NodeJS.ErrnoException) => {
    const { held, owns } = release();
    if (!held || !owns) { pump(); return; }
    const why = e.code === "ENOENT"
      ? `'${config.claudeBin}' not found — set AGENTDECK_CLAUDE_BIN to its absolute path`
      : `${e.code ?? "spawn failed"}: ${e.message}`;
    log("log", `spawn failed: ${why}`);
    const t = store.getTask(task.id);
    if (t && isLive(t.status)) {
      patch({ status: "error", error: `agent could not start — ${why}` });
      notify(store.getTask(task.id)!, "error");
    }
    // NOT optional: attach() already took a slot via running.set(). Skipping this
    // burns one of maxConcurrentAgents per failed spawn and deadlocks the queue.
    pump();
  });

  function handle(e: any) {
    if (e.type === "system" && e.subtype === "init") {
      sawInit = true; // the launch got past Claude Code's startup checks
      // Proof that agents CAN start. Retract any standing claim to the contrary,
      // so one bad launch can't pin /api/health to ok:false for the process
      // lifetime while tasks are visibly running fine.
      clearNotice("root-bypass-failed");
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
      log("text", finalText.slice(0, EVENT_TEXT_MAX));
      if (e.subtype !== "success") {
        patch({ status: "error", error: `result: ${e.subtype}` });
        notify(store.getTask(task.id)!, "error");
      } else if (looksLikeQuestion(finalText)) {
        // The agent's ask sits at the END of the turn; for a long turn (a heavy
        // gstack skill) keep the TAIL, not the head, so the drawer shows the
        // actual question/decision briefs instead of the intro.
        const shown = finalText.length > EVENT_TEXT_MAX ? "…" + finalText.slice(-(EVENT_TEXT_MAX - 1)) : finalText;
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
  schedule(task.id, () => {
    const child = spawn(config.claudeBin, [...baseArgs(), task.prompt], spawnOpts(task.worktree));
    attach(task, child);
  });
}

/** Human answer to a waiting agent — the proven prose+resume mechanic. */
export function answer(taskId: string, text: string): void {
  const t = store.getTask(taskId);
  if (!t?.sessionId) throw new Error("no session id to resume");
  store.patchTask(taskId, { status: "running", pendingQuestion: null, lastActivity: Date.now() });
  emitUpdate(taskId);
  // Waits for the outgoing agent to exit first — never two `claude --resume` on one session.
  scheduleAfterExit(taskId, () => {
    const child = spawn(config.claudeBin, ["--resume", t.sessionId!, ...baseArgs(), text], spawnOpts(t.worktree));
    attach(t, child);
  });
}

/** A2 durability: after a daemon restart, resume any task that was mid-run. */
export function resumeTask(taskId: string): void {
  const t = store.getTask(taskId);
  if (!t?.sessionId) return;
  store.patchTask(taskId, { status: "resuming", lastActivity: Date.now() });
  emitUpdate(taskId);
  scheduleAfterExit(taskId, () => {
    const child = spawn(config.claudeBin, ["--resume", t.sessionId!, ...baseArgs(), "continue where you left off"], spawnOpts(t.worktree));
    attach(t, child);
  });
}

export function stopTask(taskId: string): void {
  // Cancel a launch that hasn't spawned yet — otherwise a task queued behind the
  // concurrency cap was marked "stopped" and then started anyway when a slot freed.
  // Not killExisting(): leaving a LIVE child in `running` lets its exit handler run
  // normally, see status "stopped", skip the error patch, and pump() the queue.
  bumpGen(taskId);  // a replacement still waiting on a dying child must not fire
  const cancelled = cancelQueued(taskId);
  running.get(taskId)?.kill("SIGTERM");
  store.patchTask(taskId, { status: "stopped", lastActivity: Date.now() });
  emitUpdate(taskId);
  if (cancelled) pump();
}

export function isRunning(taskId: string): boolean { return running.has(taskId); }

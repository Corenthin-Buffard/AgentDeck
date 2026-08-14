// Preview supervisor: run a project's dev server inside a task's git worktree so the
// operator can look at what the agent actually built.
//
// ── Why this module does not touch agent.ts ──────────────────────────────────────
// A preview is long-lived and must NEVER consume an AGENTDECK_MAX_AGENTS slot. The
// agent supervisor's `running` map, `waitQueue` and `pump()` loop are deliberately
// out of scope here; the shared spawn/capture primitives live in proc.ts instead.
//
// ── Why dev servers bind loopback, always ────────────────────────────────────────
// Never config.host. AGENTDECK_HOST=0.0.0.0 is a supported reverse-proxy setting,
// and inheriting it would publish unreviewed, agent-written code straight to the
// internet on every pool port. The operator reaches previews through the same SSH
// tunnel that carries the dashboard. The deterministic guard is a firewall rule
// (`ufw deny <pool>/tcp`, see the README) — a post-hoc /proc inspection would fail
// open on any host without /proc and would still leave an exposure window.
//
// ── Why the commands are operator-authored ───────────────────────────────────────
// resolvePreview reads projects.json, never the worktree's package.json. A fresh
// `git worktree add` carries only tracked files, and node_modules is gitignored, so
// "just run scripts.dev" fails on the first click — intermittently, depending on
// whether the agent happened to install anything. That is the real reason.
//
// What this does NOT buy, stated plainly because an earlier version of this comment
// claimed it did: it is not a sandbox. The command an operator writes here is
// `npm install` and `npm run dev`, and BOTH execute agent-authored code — lifecycle
// scripts and dependencies from the worktree's package.json, and `scripts.dev`
// itself. Only the ENTRY POINT is operator-authored. The incremental risk is close
// to zero (the agent already ran as this uid with --dangerously-skip-permissions),
// but do not reason from here as though the previewed code were trusted. A real
// boundary would need --ignore-scripts, a separate uid, or a namespace; see TODOS.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, writeSync, constants } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { emitUpdate } from "./bus.ts";
import { notice } from "./notices.ts";
import { createStderrTail, fireAndForget, isAlive, killAndWait, killGroup, scrubSecrets, shouldRelay, spawnOpts, type StderrTail } from "./proc.ts";
import type { PreviewState, PreviewStatus, Project, Task } from "./types.ts";

/** Dev servers bind here. Not configurable — see the header. */
const PREVIEW_HOST = "127.0.0.1";
/** How long a SIGTERM'd process group gets before SIGKILL. Matches the agent
 *  supervisor's grace so an operator only has one number to remember. */
const SIGKILL_AFTER_MS = 5_000;
/** How often the sweep runs. The TTL is hours, so this only needs to be fine
 *  enough that the health check notices a dead dev server promptly. */
const SWEEP_INTERVAL_MS = 30_000;
/** Readiness polling interval. */
const POLL_INTERVAL_MS = 250;
/** How long a reaped orphan gets between SIGTERM and SIGKILL at boot. Shorter than
 *  the live stop's grace: nothing is waiting on a graceful shutdown here, and boot
 *  should not stall on a corpse. */
const REAP_GRACE_MS = 1_500;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — exported so every rule is testable without spawning anything.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split an operator-authored command into child env and argv.
 *
 * Leading `NAME=VALUE` tokens become env; the rest is argv. Deliberately NOT run
 * through `sh -c`: a shell buys `&&` and loses both reliable process-group kill
 * (the shell becomes the group leader and may exec away) and argv-level
 * testability. It also means `&&`, `;` and `$(…)` are inert here — they arrive at
 * the child as literal arguments rather than being interpreted, which is asserted
 * in the tests because it is a security property, not a parsing detail.
 *
 * The array form skips the whitespace split entirely, so an argument may contain
 * spaces. `NAME=VALUE` leading tokens are still honoured there for symmetry.
 */
export function parsePreviewCommand(v: string | string[]): { env: Record<string, string>; argv: string[] } {
  const tokens = Array.isArray(v) ? v.slice() : v.trim().split(/\s+/).filter(Boolean);
  const env: Record<string, string> = {};
  let i = 0;
  for (; i < tokens.length; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tokens[i]);
    if (!m) break;
    env[m[1]] = m[2];
  }
  return { env, argv: tokens.slice(i) };
}

/** Substitute `{port}` everywhere in an argv array or an env map. Unknown
 *  placeholders are left alone — they are far more likely to be a literal the
 *  child wants than a typo we should silently eat. */
export function expandPlaceholders<T extends string[] | Record<string, string>>(v: T, vars: { port: number }): T {
  const sub = (s: string) => s.replace(/\{port\}/g, String(vars.port));
  if (Array.isArray(v)) return v.map(sub) as T;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) out[k] = sub(val);
  return out as T;
}

/**
 * First port in the pool that is neither reserved by a live entry nor already
 * bound by some other process.
 *
 * `taken` MUST include entries in the `stopping` state: their port stays bound for
 * the whole SIGTERM grace window, so handing it to a new preview makes that child
 * die on EADDRINUSE and surface as the far less obvious "did not listen in time".
 *
 * The probe closes a race between two concurrent starts only because reservation
 * happens synchronously between probe and spawn on Bun's single-threaded loop. The
 * wider window — probe until the child actually binds, which is seconds of package
 * manager boot — is not closable here; `--strictPort` in the documented command
 * makes the collision loud instead of silent.
 */
export function pickPort(pool: readonly number[], taken: ReadonlySet<number>, probe: (p: number) => boolean): number | null {
  for (const p of pool) {
    if (taken.has(p)) continue;
    if (probe(p)) return p;
  }
  return null;
}

/**
 * starttime (field 22) out of /proc/<pid>/stat, used to tell a live process from a
 * recycled pid.
 *
 * NOT `split(" ")[21]`. Field 2 is `comm`, wrapped in parentheses, and a process
 * may legitimately be named `my app (dev)` — parens and spaces included. The only
 * correct parse is to find the LAST ')' and split what follows, where index 0 is
 * field 3. Getting this wrong is worse than not reaping at all: a stable wrong
 * value that happens to match would make the daemon SIGKILL an unrelated process.
 */
export function parseStarttime(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const v = Number(rest[19]); // field 22 == index 19 once fields 1-2 are consumed
  return Number.isFinite(v) ? v : null;
}

/**
 * A display string for the resolved command.
 *
 * Env VALUES are redacted unconditionally — never by a denylist. A pattern like
 * /(TOKEN|SECRET|KEY|PASS)/i misses DATABASE_URL, SENTRY_DSN, STRIPE_SK and
 * npm_config__auth, and this is served by an UNGATED GET. Showing the names is
 * enough to answer "what command runs", which is the drawer's only job.
 *
 * LIMIT, stated because the sentence above reads like a completeness claim and is
 * not one: this covers env values only. ARGV is shown as written, so a secret passed
 * as a FLAG (`--api-key sk-live-…`) is served verbatim on that ungated GET —
 * scrubSecrets only knows the daemon's own two tokens and `?token=`-shaped query
 * strings. Keep secrets in the NAME=VALUE form, which is the documented shape
 * anyway. Do not read this function as "the command is safe to publish".
 */
export function redactCommand(argv: string[], env: Record<string, string>): string {
  const envPart = Object.keys(env).sort().map((k) => `${k}=[set]`).join(" ");
  const cmd = scrubSecrets(argv.join(" "), [config.dashboardToken, config.hookToken]);
  return envPart ? `${envPart} ${cmd}` : cmd;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

export type Resolution =
  | { ok: true; preview: string | string[]; install?: string | string[] }
  | { ok: false; reason: string };

/** What this project's preview is, or why it hasn't got one. Never guesses. */
export function resolvePreview(project: Project | undefined): Resolution {
  if (!project) return { ok: false, reason: "unknown project" };
  if (!project.preview) {
    return {
      ok: false,
      reason: `no preview command configured for '${project.id}'. Add one to projects.json in the data dir, for example:\n`
        + `  { "id": "${project.id}", "path": "${project.path}",\n`
        + `    "install": "npm install",\n`
        + `    "preview": "npm run dev -- --port {port} --host 127.0.0.1" }`,
    };
  }
  return { ok: true, preview: project.preview, install: project.install };
}

/**
 * The configured command, safe to serve on an UNGATED read.
 *
 * Exists because the Resolution itself is not safe to serialise: it carries
 * projects.json's `preview`/`install` verbatim, and both accept leading NAME=VALUE
 * tokens — so returning it published every env VALUE an operator had set there.
 * This runs the same parse the spawn path does and hands the result to
 * redactCommand, which shows names and never values.
 */
export function redactedResolution(res: Resolution): { preview: string; install?: string } {
  if (!res.ok) return { preview: "" };
  const fmt = (v: string | string[]) => { const { env, argv } = parsePreviewCommand(v); return redactCommand(argv, env); };
  return { preview: fmt(res.preview), ...(res.install ? { install: fmt(res.install) } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

interface Entry {
  taskId: string;
  port: number;
  status: PreviewStatus;
  startedAt: number;
  error: string | null;
  command: string;                 // redacted, display only
  child: ChildProcess | null;
  pgid: number | null;
  out: StderrTail;
  starting: Promise<PreviewState> | null; // in-flight start, for idempotence
  stopping: Promise<void> | null;
  // Set by stopPreview. The start closure re-checks it at every await boundary,
  // because a stop that arrives DURING install has no child to signal yet and must
  // not let the closure go on to spawn a dev server nothing is tracking.
  aborted: boolean;
}

const previews = new Map<string, Entry>();

const view = (e: Entry): PreviewState => ({
  taskId: e.taskId, status: e.status, port: e.port, startedAt: e.startedAt, error: e.error,
});

export function getPreview(taskId: string): PreviewState | undefined {
  const e = previews.get(taskId);
  return e ? view(e) : undefined;
}

/** Does this task hold a preview? Used by cleanup.ts so the auto-clean sweep never
 *  removes a worktree out from under a dev server the operator is looking at. */
export function isPreviewing(taskId: string): boolean {
  return previews.has(taskId);
}

/** The bounded tail of everything the child has written. Exported so a test can
 *  assert the supervisor really CONSUMED stdout, rather than inferring it from the
 *  preview happening to reach ready. */
export function previewTail(taskId: string): string {
  return previews.get(taskId)?.out.tail() ?? "";
}

/** The redacted command for the drawer. Separate from the PreviewState because it
 *  is only ever fetched on demand, not broadcast to every dashboard. */
export function previewCommand(taskId: string): string | null {
  return previews.get(taskId)?.command ?? null;
}

function setStatus(e: Entry, status: PreviewStatus, error?: string | null) {
  e.status = status;
  if (error !== undefined) e.error = error;
  emitUpdate(e.taskId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Port probing and readiness
// ─────────────────────────────────────────────────────────────────────────────

/** Can we bind this port right now? Bind-then-release is the only check that
 *  reflects what the child is about to attempt. */
function probePort(port: number): boolean {
  try {
    const s = Bun.listen({ hostname: PREVIEW_HOST, port, socket: { data() { /* never */ } } });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Is something accepting connections on this port? Used both for readiness and,
 *  once ready, as the health check. */
async function canConnect(port: number): Promise<boolean> {
  try {
    const s = await Bun.connect({
      hostname: PREVIEW_HOST, port,
      socket: { data() { /* ignore */ }, error() { /* handled by the throw */ } },
    });
    s.end();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Spawning
// ─────────────────────────────────────────────────────────────────────────────

/** Cached result of the memory-cap probe. undefined = not probed yet. */
let memCapAvailable: boolean | undefined;

/**
 * Can we put children under a systemd scope with a memory ceiling?
 *
 * Probed by actually creating a trivial scope, because `systemd-run` being on PATH
 * says nothing about whether this uid may create one (no user session bus, no
 * lingering, a container without systemd). Probed once and cached; a failure is a
 * notice, never an error — an uncapped preview is far better than no preview.
 */
function memoryCapAvailable(): boolean {
  if (memCapAvailable !== undefined) return memCapAvailable;
  if (!Bun.which("systemd-run")) {
    memCapAvailable = false;
  } else {
    // TIMEOUT is mandatory. This runs on the daemon's single event loop, so a
    // systemd-run that hangs on a stalled session bus freezes the HTTP server, the
    // WebSocket, every agent's pipe draining and every timer along with it.
    const r = Bun.spawnSync(["systemd-run", "--user", "--scope", "-q", "-p", "MemoryMax=64M", "--", "true"], {
      stdout: "ignore", stderr: "ignore", timeout: 3_000,
    });
    memCapAvailable = r.exitCode === 0;
  }
  if (!memCapAvailable) {
    notice("warn", "preview-memcap",
      "previews will run without a memory ceiling (systemd-run --user --scope is unavailable here). "
      + "A runaway dev server can then push the box into OOM, and the kernel may pick the daemon rather than the preview. "
      + `Reduce AGENTDECK_PREVIEW_PORTS if that is a concern (currently ${config.preview.ports.length} slots).`);
  }
  return memCapAvailable;
}

/** Wrap argv in a memory-capped transient scope when we can. `--` separates our
 *  flags from the child's, so a child flag can never be read as a systemd-run one. */
function withMemoryCap(argv: string[]): string[] {
  if (!memoryCapAvailable()) return argv;
  return ["systemd-run", "--user", "--scope", "-q", "-p", `MemoryMax=${config.preview.memMax}`, "--", ...argv];
}

/**
 * Spawn a child in the worktree, detached, with BOTH streams drained.
 *
 * Draining is not optional and not just stderr. spawnOpts pipes stdout and stderr;
 * an undrained pipe fills at 64KiB and blocks the writer forever. A dev server
 * writes its banner, its request log and every rebuild to STDOUT, so an undrained
 * preview stops making progress and looks frozen — with no error anywhere. That is
 * the failure this function exists to prevent.
 *
 * `detached` makes the child a process-group leader (pid === pgid), which is what
 * lets killGroup reap the whole `npm run dev` → real-server tree.
 */
function spawnDetached(argv: string[], env: Record<string, string>, cwd: string, out: StderrTail) {
  const base = spawnOpts(cwd, process.getuid?.());
  const full = withMemoryCap(argv);
  const child = spawn(full[0], full.slice(1), {
    ...base,
    detached: true,
    env: { ...base.env, ...env },
  });
  const capture = (d: Buffer) => scrubSecrets(d.toString(), [config.dashboardToken, config.hookToken]);
  // stdout: DRAINED but not mirrored. Draining is mandatory (see above); mirroring
  // is not. A dev server writes a line per request and a block per rebuild, so
  // relaying it would bury the daemon's own journal in HMR noise. It still lands in
  // the bounded tail, which is what the drawer shows when something goes wrong.
  child.stdout?.on("data", (d: Buffer) => out.push(capture(d)));
  // stderr: drained AND mirrored, so a failure is visible in journalctl too. Bounded
  // by shouldRelay in case our own sink has stalled.
  child.stderr?.on("data", (d: Buffer) => {
    const text = capture(d);
    out.push(text);
    if (shouldRelay(process.stderr.writableLength)) process.stderr.write(text);
  });
  return child;
}

/**
 * Run a command to completion (the install step).
 *
 * `onSpawn` hands the child to the caller so a concurrent stop can signal it. An
 * install is the LONGEST phase of a preview (minutes, not seconds), so it is by far
 * the likeliest moment for someone to hit Stop — leaving it unkillable meant Stop
 * appeared to work while npm kept running to completion.
 *
 * Resolves the exit code, or one of two sentinels: `null` for the timeout, `-1` for
 * "never ran or died by signal". The caller distinguishes them so the message can
 * say what actually happened rather than reporting `exit -1`, which no process ever
 * returns.
 */
function runToCompletion(
  argv: string[], env: Record<string, string>, cwd: string,
  out: StderrTail, timeoutMs: number, onSpawn?: (c: ChildProcess) => void,
): Promise<number | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnDetached(argv, env, cwd, out);
      onSpawn?.(child);
    } catch (e: any) {
      out.push(`spawn failed: ${e?.message ?? e}`);
      resolve(-1);
      return;
    }
    let settled = false;
    const finish = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve(code); };
    const timer = setTimeout(() => {
      if (child.pid) killGroup(child.pid, "SIGKILL");
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.once("close", (code) => finish(code ?? -1));
    child.once("error", (e: any) => { out.push(`could not run: ${e?.message ?? e}`); finish(-1); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The pidfile — for REAPING ONLY, never a source of display truth
// ─────────────────────────────────────────────────────────────────────────────
//
// Preview state is in memory on purpose: a dev server has no --resume handle, so a
// persisted "ready" would be a lie after a restart. This file exists for exactly one
// job — a daemon that died hard (SIGKILL, OOM, kill -9 outside systemd) leaves its
// detached children alive and holding pool ports, and with a three-port pool one
// orphan permanently costs a third of capacity.

interface PidRecord { taskId: string; pid: number; port: number; startedAt: number; starttime: number | null }

const pidfilePath = () => join(config.dataDir, "previews.json");

function readStarttime(pid: number): number | null {
  try {
    return parseStarttime(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null; // not Linux, or the process is already gone
  }
}

/** Orphan records reapOrphans could not resolve. They must survive every later
 *  writePidfile, or "kept for the next boot" is false the moment anyone starts or
 *  stops a preview — which was exactly the case. */
let keptOrphans: PidRecord[] = [];

function writePidfile() {
  const records: PidRecord[] = [...keptOrphans];
  for (const e of previews.values()) {
    if (e.pgid) records.push({ taskId: e.taskId, pid: e.pgid, port: e.port, startedAt: e.startedAt, starttime: readStarttime(e.pgid) });
  }
  try {
    if (!records.length) { try { unlinkSync(pidfilePath()); } catch { /* already gone */ } return; }
    // O_NOFOLLOW: never write THROUGH a symlink, the same hardening the dashboard
    // token already has (config.ts). Both the agent and the previewed dev server
    // run as this uid, so either can pre-place a link here; without the flag the
    // daemon would happily TRUNCATE whatever it points at — agent-settings.json, a
    // systemd unit, an authorized_keys — on the next preview start.
    // The explicit 0600 only applies on creation, which is why O_NOFOLLOW rather
    // than the mode is what actually protects this path.
    const fd = openSync(pidfilePath(), constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, JSON.stringify(records)); } finally { closeSync(fd); }
  } catch (e: any) {
    notice("warn", "preview-pidfile", `could not write ${pidfilePath()}: ${e?.message ?? e} — a hard daemon crash may leave dev servers holding preview ports`);
  }
}

/**
 * Kill dev servers a previous daemon left behind.
 *
 * The starttime match is the whole safety story. A pid alone is not identity: pids
 * are recycled, and signalling a recycled one means killing an unrelated process —
 * strictly worse than the port leak we are fixing. Without a readable starttime (no
 * /proc) we do NOT kill; we report instead.
 *
 * A pattern sweep (`pkill -f vite`) is deliberately not an option: pkill -f matches
 * the invoking shell's own command line, which makes it kill the caller and look
 * like the target fighting back.
 *
 * Returns how many groups were signalled.
 */
export async function reapOrphans(): Promise<number> {
  let records: PidRecord[];
  try {
    records = JSON.parse(readFileSync(pidfilePath(), "utf8"));
    if (!Array.isArray(records)) return 0;
  } catch {
    return 0; // absent or malformed — nothing to do, and nothing worth saying
  }
  let killed = 0;
  const kept: PidRecord[] = [];   // records still worth trying on the next boot
  for (const r of records) {
    // The file lives in the data dir, which the agent and the previewed dev server
    // can both write (same uid). Validate it as untrusted input, not as our own
    // state: a forged or corrupted pid must never reach a signal.
    if (!r || !Number.isInteger(r.pid) || r.pid <= 1 || !Number.isInteger(r.port)) continue;
    if (isAlive(r.pid)) {
      const now = readStarttime(r.pid);
      // FAIL CLOSED. Anything short of a positive identity match means we do not
      // signal. The earlier form (`r.starttime !== null && now !== r.starttime`)
      // skipped the comparison entirely when the RECORDED starttime was null —
      // which writePidfile legitimately writes for a child that has already exited
      // — so after a crash a recycled pid matched nothing, fell through, and got
      // its whole group SIGTERMed. That is the exact outcome this check exists to
      // prevent, and it is worse than the port leak it was meant to fix.
      if (now === null || r.starttime === null) {
        notice("warn", "preview-orphan",
          `a process from a previous run may still hold preview port ${r.port} (pid ${r.pid}), but its identity cannot be confirmed, so it was left alone. `
          + `Check with: ss -ltnp 'sport = :${r.port}'`);
        kept.push(r);
        continue;
      }
      if (now !== r.starttime) continue; // pid recycled — definitively not ours, and not worth a notice
      // SIGTERM, then VERIFY. killGroup returning true means the signal was
      // DELIVERED, not that the group died — and this branch's own test fixture has
      // an --ignore-sigterm mode, so a dev server that outlives SIGTERM is a modelled
      // case, not a hypothetical. Counting delivery as a reap made the boot log claim
      // it had recovered a port it was still leaking.
      if (!killGroup(r.pid, "SIGTERM")) continue;   // already gone
      await sleep(REAP_GRACE_MS);
      if (isAlive(r.pid)) killGroup(r.pid, "SIGKILL");
      await sleep(POLL_INTERVAL_MS);
      if (isAlive(r.pid)) {
        // Survived SIGKILL (uninterruptible sleep, or not ours after all). Keep the
        // record so the NEXT boot tries again, and say so — silently dropping it is
        // how a held port becomes permanent with nothing to explain it.
        kept.push(r);
        notice("warn", "preview-orphan",
          `a dev server from a previous run (pid ${r.pid}, port ${r.port}) did not die to SIGKILL. Check with: ss -ltnp 'sport = :${r.port}'`);
        continue;
      }
      killed++;
    } else if (!probePort(r.port)) {
      // The recorded group leader is gone but the port is still held: the wrapper
      // (npm/pnpm) died and left the real dev server behind. Dropping this quietly
      // would leak the port with nothing to explain the later "no free port".
      notice("warn", "preview-orphan",
        `preview port ${r.port} is still in use by a process this daemon did not start. `
        + `Free it with: ss -ltnp 'sport = :${r.port}'`);
      kept.push(r);   // the leader died but the port is held — the permanent-leak case
    }
  }
  // Hand the unresolved records to writePidfile rather than writing them here.
  // Writing them directly was pointless: the next writePidfile rebuilt the file
  // from live entries only, so "kept for the next boot" survived exactly until
  // someone started or stopped a preview.
  keptOrphans = kept;
  writePidfile();
  if (killed) console.log(`[preview] reaped ${killed} dev server(s) left by a previous run`);
  return killed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Start / stop
// ─────────────────────────────────────────────────────────────────────────────

/** Ports a live entry is holding. Includes `stopping` — see pickPort. */
const reservedPorts = (): Set<number> => new Set([...previews.values()].map((e) => e.port));

/**
 * Begin a preview and return as soon as the entry EXISTS — do not wait for it to
 * be ready.
 *
 * This split exists because the HTTP route cannot await the whole thing. Bun.serve
 * kills any handler that takes longer than its `idleTimeout` (10s by default, and
 * capped at 255s), while a cold `npm install` is minutes and even a warm dev server
 * boot routinely passes 10s. Awaiting inside the handler meant the connection was
 * closed under the client, the dashboard's `await fetch` rejected with a socket
 * error, and the operator got no feedback at all — while the install carried on
 * invisibly. Measured on bun 1.3.14.
 *
 * Everything that can fail FAST fails here, synchronously, before any await: the
 * feature being disabled, no configured command, an exhausted pool. Those still
 * throw, so the route can answer 409 with a message that names the fix. Everything
 * slow — install, spawn, readiness — runs in the background and reports through the
 * entry's status, which already rides the WebSocket to the board.
 *
 * IDEMPOTENT. Two rapid clicks return the same entry rather than racing two spawns
 * for one port.
 */
export function beginPreview(task: Task, project: Project | undefined): PreviewState {
  // Do NOT name a cause here. daemon.ts turns this flag off for three different
  // reasons (AGENTDECK_PREVIEW=false, a pool colliding with the dashboard port, an
  // off-loopback bind) and each raises its own notice saying which. Asserting one
  // of them is how the operator ends up chasing the wrong setting.
  if (!config.preview.enabled) throw new Error("previews are disabled on this daemon — see the boot notices for which check disabled them");

  const existing = previews.get(task.id);
  if (existing) {
    if (existing.stopping) throw new Error("this preview is still shutting down — try again in a moment");
    return view(existing);   // in flight, ready, or failed — one entry, one child
  }

  const res = resolvePreview(project);
  if (!res.ok) throw new Error(res.reason);

  const port = pickPort(config.preview.ports, reservedPorts(), probePort);
  if (port === null) {
    const running = [...previews.values()].map((e) => e.taskId).join(", ");
    throw new Error(
      running
        ? `all ${config.preview.ports.length} preview ports are in use (${running}) — stop one first`
        : `no preview port is free in ${config.preview.ports.join(", ")} — something else on this box is using them`,
    );
  }

  const { env: pEnv, argv: pArgv } = parsePreviewCommand(res.preview);
  if (!pArgv.length) throw new Error(`the preview command for '${project!.id}' has no program to run — it is only NAME=VALUE assignments`);
  const argv = expandPlaceholders(pArgv, { port });
  const env = expandPlaceholders(pEnv, { port });

  const entry: Entry = {
    taskId: task.id, port, status: "starting", startedAt: Date.now(), error: null,
    command: redactCommand(argv, env), child: null, pgid: null,
    out: createStderrTail(), starting: null, stopping: null, aborted: false,
  };
  previews.set(task.id, entry);

  const run = (async (): Promise<PreviewState> => {
    // ── install, if the worktree has never been installed into ────────────────
    // A worktree is a fresh checkout of TRACKED files, and node_modules is
    // gitignored, so this is the normal state of a new task — not an edge case.
    if (!existsSync(join(task.worktree, "node_modules"))) {
      if (!res.install) {
        throw new Error(
          `${task.worktree} has no node_modules, and '${project!.id}' has no install command configured. `
          + `Either add one to projects.json ("install": "npm install"), or run it yourself:\n`
          + `  cd ${task.worktree} && npm install`,
        );
      }
      setStatus(entry, "installing");
      const { env: iEnv, argv: iArgv } = parsePreviewCommand(res.install);
      if (!iArgv.length) throw new Error(`the install command for '${project!.id}' has no program to run`);
      const code = await runToCompletion(
        iArgv, iEnv, task.worktree, entry.out, config.preview.installTimeoutMs,
        // Registering the install child is what makes Stop work during the longest
        // phase of a preview. Without it, stopPreview found pgid === null, resolved
        // immediately, deleted the entry — and this closure carried on installing
        // and then spawned a dev server that nothing tracked, holding a pool port
        // until the box rebooted.
        (c) => { entry.child = c; entry.pgid = c.pid ?? null; writePidfile(); },
      );
      entry.child = null; entry.pgid = null;
      if (entry.aborted) throw new AbortedError();
      if (code === null) throw new Error(`install timed out after ${Math.round(config.preview.installTimeoutMs / 1000)}s — ${entry.out.excerpt() || "no output"}`);
      if (code === -1) throw new Error(`the install command could not run — ${entry.out.excerpt() || "no output"}`);
      if (code !== 0) throw new Error(`install failed (exit ${code}) — ${entry.out.excerpt() || "no output"}`);
      setStatus(entry, "starting");
    }
    // Re-check after every await: a stop may have landed while the install ran.
    if (entry.aborted) throw new AbortedError();

    // ── the dev server ────────────────────────────────────────────────────────
    let child: ChildProcess;
    try {
      child = spawnDetached(argv, env, task.worktree, entry.out);
    } catch (e: any) {
      throw new Error(`could not start the preview: ${e?.message ?? e}`);
    }
    entry.child = child;
    entry.pgid = child.pid ?? null;
    writePidfile();

    let dead = false;
    child.once("close", () => {
      dead = true;
      // Drop the handle the instant the OS reaps it. A pid is not an identity: once
      // waitpid has run, the kernel may hand that number to anything, so a stale
      // pgid left here means a later stop/TTL/shutdown SIGTERMs a stranger's group.
      if (entry.child === child) { entry.child = null; entry.pgid = null; writePidfile(); }
      // IDENTITY, not just taskId. killCurrentChild resolves on the SIGKILL timer
      // without waiting for `close`, so a stop can delete this entry and a restart
      // can install a NEW one for the same task while this handler is still pending
      // — and the old child would then mark the new preview failed, with the new
      // entry's output as the explanation. Same hazard the pgid comment above
      // guards for the pid; it applies to the entry too.
      if (previews.get(task.id) !== entry) return;
      if (entry.status === "ready") setStatus(entry, "failed", entry.out.excerpt() || "the dev server exited");
    });
    child.once("error", (e: any) => { dead = true; entry.out.push(`could not run: ${e?.message ?? e}`); });

    const deadline = Date.now() + config.preview.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (dead) throw new Error(`the preview exited before it listened — ${entry.out.excerpt() || "no output"}`);
      if (entry.aborted) throw new AbortedError();
      const up = await canConnect(port);
      // Re-check on the FAR side of the await too. Checking only before it left a
      // window where a stop landed during the connect and `ready` then overwrote
      // `stopping` — pushing a live "Preview ▸" link to every dashboard for a port
      // being torn down. Every await in this closure is an abort boundary; this one
      // was missed because the check reads as if it guards the whole iteration.
      if (entry.aborted) throw new AbortedError();
      if (up) {
        setStatus(entry, "ready", null);
        return view(entry);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `the dev server did not listen on ${PREVIEW_HOST}:${port} within ${Math.round(config.preview.readyTimeoutMs / 1000)}s. `
      + `Check that the command binds {port} and 127.0.0.1 — ${entry.out.excerpt() || "no output"}`,
    );
  })();

  entry.starting = run.catch((e: any) => {
    // An abort is the stop path doing its job, not a failure to report: stopPreview
    // owns the entry from here and will delete it.
    if (e instanceof AbortedError || entry.aborted) throw e;
    // Otherwise keep the entry in `failed` so the drawer can explain what happened.
    // The port stays reserved until the operator dismisses it with Stop. Anything we
    // did manage to spawn is reaped first, or it would hold the port untracked.
    if (entry.pgid) killGroup(entry.pgid, "SIGKILL");
    entry.child = null;
    entry.pgid = null;
    writePidfile();
    setStatus(entry, "failed", String(e?.message ?? e));
    throw e;
  }).finally(() => { entry.starting = null; }) as Promise<PreviewState>;
  // Nothing awaits `run` here. Failures surface as the entry's `failed` status,
  // which emitUpdate has already pushed to every open dashboard.
  entry.starting.catch(() => { /* observed via status; keeps this off unhandledRejection */ });
  return view(entry);
}

/** Thrown by the start closure when a stop landed mid-flight. Not an error the
 *  operator should ever see — it means the stop path is in charge now. */
class AbortedError extends Error {
  constructor() { super("preview stopped before it finished starting"); }
}

/**
 * Start a preview and WAIT for it to be ready (or fail).
 *
 * The awaitable form, for tests and any caller that genuinely wants completion.
 * The HTTP route deliberately does NOT use this — see beginPreview.
 */
export async function startPreview(task: Task, project: Project | undefined): Promise<PreviewState> {
  const state = beginPreview(task, project);
  const entry = previews.get(task.id);
  return entry?.starting ? await entry.starting : state;
}

/**
 * Stop a preview and resolve once its process GROUP is actually gone.
 *
 * The entry stays in the registry as `stopping` for the whole grace window, so
 * pickPort keeps treating the port as taken — it really is still bound.
 */
export function stopPreview(taskId: string, why?: string): Promise<void> {
  const e = previews.get(taskId);
  if (!e) return Promise.resolve();
  if (e.stopping) return e.stopping;

  // Set BEFORE anything else. The start closure re-checks this at every await
  // boundary, so from this instant it will unwind rather than go on to spawn.
  e.aborted = true;
  setStatus(e, "stopping");

  const done = (async () => {
    // Signal whatever child exists RIGHT NOW, not whatever existed when stop was
    // called. During an install that is the package manager; after it, the dev
    // server. The previous version captured child/pgid up front, so a stop during
    // install found null and resolved instantly while the install ran on.
    await killCurrentChild(e);
    // Let an in-flight start finish unwinding before the entry is dropped, so the
    // port stays reserved until nothing is left that could still bind it.
    if (e.starting) await e.starting.catch(() => { /* abort or failure, both fine */ });
    // The closure may have spawned in the window between the kill and the abort
    // check. Cheap to repeat, and the alternative is an untracked dev server.
    await killCurrentChild(e);
    previews.delete(taskId);
    writePidfile();
    emitUpdate(taskId);
    if (why) console.log(`[preview] stopped ${taskId} (${why})`);
  })();

  e.stopping = done;
  return done;
}

/** SIGTERM the entry's current process group, escalate to SIGKILL after the grace
 *  window, and resolve once it is actually gone. No-op when there is no child. */
async function killCurrentChild(e: Entry): Promise<boolean> {
  const pgid = e.pgid;
  const child = e.child;
  if (!pgid || !child) return true;
  // killAndWait VERIFIES. The previous version resolved on the SIGKILL timer
  // firing, which only means the signal was delivered — so removeTask's comment
  // promising the process was gone before `git worktree remove` touched the
  // directory was asserting something nothing had checked.
  const gone = await killAndWait(pgid, SIGKILL_AFTER_MS, (done) => {
    child.once("close", done);
    child.once("error", done);
  });
  if (!gone) {
    notice("warn", "preview-stuck",
      `the dev server for ${e.taskId} (pid ${pgid}, port ${e.port}) did not die to SIGKILL — port ${e.port} stays in use. Check with: ss -ltnp 'sport = :${e.port}'`);
  }
  return gone;
}

/** Stop every preview. Bounded by the caller — see the shutdown handler. */
export async function stopAllPreviews(): Promise<void> {
  await Promise.all([...previews.keys()].map((id) => stopPreview(id, "daemon shutting down")));
}

// ─────────────────────────────────────────────────────────────────────────────
// The sweep: TTL + health
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One sweep pass. Exported for the tests so the interval never has to be waited on.
 *
 * The TTL is a hard lifetime cap, NOT an idle timer. The daemon is not in the
 * request path — dev servers are reached directly over the tunnel — so it cannot
 * observe use, and any "is anyone looking" signal would be a guess. Counting
 * established connections was tried and rejected: under `ssh -L` both ends of every
 * connection are local so each appears twice, one forgotten tab pins a port
 * forever, and browsers freeze background tabs and drop sockets anyway. A ceiling
 * is honest, deterministic, and one click from recovery.
 */
export async function sweepOncePreviews(now = Date.now()): Promise<void> {
  const ttl = config.preview.ttlMs;
  for (const e of [...previews.values()]) {
    if (e.stopping) continue;
    if (ttl > 0 && now - e.startedAt > ttl) {
      // NOT awaited. Each stop can take the full SIGTERM grace, and with a pool of
      // up to POOL_MAX that is minutes of sequential waiting against a 30s interval
      // — passes would stack, and one wedged stop would block the health check for
      // every other preview. stopPreview is idempotent per task, so firing and
      // forgetting is safe; `e.stopping` skips it on the next pass.
      fireAndForget(stopPreview(e.taskId, `reached the ${Math.round(ttl / 60_000)}min lifetime cap`), "preview-ttl");
      continue;
    }
    // Health: a dev server that died on its own must show on the board rather than
    // sitting at `ready` while the tab fails to connect.
    if (e.status !== "ready") continue;
    const reachable = await canConnect(e.port);
    // Re-check on the FAR side. A DELETE landing during that connect sets
    // `stopping`, and writing `failed` over it shows the board a failed preview
    // that is really mid-teardown — Stop re-enables, Retry appears, and Retry then
    // 409s. Same class as the readiness loop's fix; this is its sibling.
    if (e.stopping || e.aborted || previews.get(e.taskId) !== e) continue;
    if (!reachable) setStatus(e, "failed", e.out.excerpt() || "the dev server is no longer listening");
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

let sweeping = false;

export function startPreviewSweep(): void {
  if (sweepTimer) return;
  // Non-overlap guard, the same discipline cleanup.ts documents for its sweep. The
  // health probe is a network call per ready preview; without this, a slow pass
  // overlaps the next one and they pile up.
  sweepTimer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    fireAndForget(sweepOncePreviews().finally(() => { sweeping = false; }), "preview-sweep");
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();  // a sweep must never be the reason the process stays up
}

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown
// ─────────────────────────────────────────────────────────────────────────────

/** Total budget for stopping every preview on the way out: the 5s SIGTERM grace
 *  plus a margin. Must stay well under systemd's TimeoutStopSec (90s default). */
const SHUTDOWN_BUDGET_MS = 6_000;

let shuttingDown = false;

/**
 * Install the SIGTERM/SIGINT handlers that stop previews before the daemon exits.
 *
 * READ THIS BEFORE CHANGING IT. These are the daemon's FIRST signal handlers, and
 * registering a listener for SIGTERM **removes Node's default terminate
 * behaviour**. From that moment the process only exits if this code says so. Get it
 * wrong and `systemctl stop` hangs until TimeoutStopSec, then SIGKILLs — which
 * orphans every running agent, a strictly worse outcome than the leaked dev server
 * this exists to prevent.
 *
 * Hence the shape: the exit is in a `finally`, so neither a throw nor a hang in
 * stopAllPreviews can strand the process, and it is raced against a hard budget so
 * a wedged child cannot hold shutdown open. Idempotent, because a second Ctrl-C
 * must not start a second teardown.
 *
 * Dependencies are injectable so all of that is testable without killing the test
 * runner.
 */
export function installPreviewShutdown(deps: {
  stop?: () => Promise<void>;
  exit?: (code: number) => void;
  on?: (sig: NodeJS.Signals, fn: () => void) => void;
  budgetMs?: number;
} = {}): void {
  const stop = deps.stop ?? stopAllPreviews;
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const on = deps.on ?? ((sig, fn) => { process.on(sig, fn); });
  const budgetMs = deps.budgetMs ?? SHUTDOWN_BUDGET_MS;

  const handler = () => {
    if (shuttingDown) return;   // a second Ctrl-C must not start a second teardown
    shuttingDown = true;
    void (async () => {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const budget = new Promise<void>((r) => { timer = setTimeout(r, budgetMs); timer.unref?.(); });
        await Promise.race([stop(), budget]);
        clearTimeout(timer);
      } catch (e: any) {
        console.error(`[preview] shutdown cleanup failed: ${e?.message ?? e}`);
      } finally {
        exit(0);   // the one line that must run no matter what happened above
      }
    })();
  };

  on("SIGTERM", handler);
  on("SIGINT", handler);
}

/** Test seam: drop all state without signalling anything. */
export function _resetPreviewsForTest(): void {
  shuttingDown = false;
  previews.clear();
  keptOrphans = [];
  memCapAvailable = undefined;
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  sweeping = false;
}

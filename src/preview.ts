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
// (`ufw deny in on <pool>`, see the README) — a post-hoc /proc inspection would fail
// open on any host without /proc and would still leave an exposure window.
//
// ── Why the commands are operator-authored ───────────────────────────────────────
// resolvePreview reads projects.json, never the worktree's package.json. A fresh
// `git worktree add` carries only tracked files, and node_modules is gitignored, so
// "just run scripts.dev" fails on the first click — intermittently, depending on
// whether the agent happened to install anything. And running a script out of an
// AGENT-AUTHORED package.json as the daemon uid, with the daemon's environment, is
// arbitrary code execution behind a button.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, writeSync, constants } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { emitUpdate } from "./bus.ts";
import { notice } from "./notices.ts";
import { createStderrTail, isAlive, killGroup, scrubSecrets, shouldRelay, spawnOpts } from "./proc.ts";
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
  out: ReturnType<typeof createStderrTail>;
  starting: Promise<PreviewState> | null; // in-flight start, for idempotence
  stopping: Promise<void> | null;
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
    const r = Bun.spawnSync(["systemd-run", "--user", "--scope", "-q", "-p", "MemoryMax=64M", "--", "true"], {
      stdout: "ignore", stderr: "ignore",
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
function spawnDetached(argv: string[], env: Record<string, string>, cwd: string, out: ReturnType<typeof createStderrTail>) {
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

/** Run a command to completion (the install step). Resolves with the exit code, or
 *  null if it had to be killed for exceeding the timeout. */
function runToCompletion(
  argv: string[], env: Record<string, string>, cwd: string,
  out: ReturnType<typeof createStderrTail>, timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnDetached(argv, env, cwd, out);
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

function writePidfile() {
  const records: PidRecord[] = [];
  for (const e of previews.values()) {
    if (e.pgid) records.push({ taskId: e.taskId, pid: e.pgid, port: e.port, startedAt: e.startedAt, starttime: readStarttime(e.pgid) });
  }
  try {
    if (!records.length) { try { unlinkSync(pidfilePath()); } catch { /* already gone */ } return; }
    // O_CREAT|O_TRUNC with an explicit mode: the file names live pids on this box.
    const fd = openSync(pidfilePath(), constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY, 0o600);
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
  for (const r of records) {
    if (!r || typeof r.pid !== "number" || typeof r.port !== "number") continue;
    if (isAlive(r.pid)) {
      const now = readStarttime(r.pid);
      if (now === null) {
        notice("warn", "preview-orphan",
          `a process from a previous run may still hold preview port ${r.port} (pid ${r.pid}), but its identity cannot be confirmed on this platform, so it was left alone. `
          + `Check with: ss -ltnp 'sport = :${r.port}'`);
        continue;
      }
      if (r.starttime !== null && now !== r.starttime) continue; // pid recycled — not ours
      // Count only what we actually signalled. killGroup returns false when the
      // group is already gone, and reporting a reap that did not happen would make
      // the boot log claim it recovered ports it did not.
      if (killGroup(r.pid, "SIGTERM")) killed++;
    } else if (!probePort(r.port)) {
      // The recorded group leader is gone but the port is still held: the wrapper
      // (npm/pnpm) died and left the real dev server behind. Dropping this quietly
      // would leak the port with nothing to explain the later "no free port".
      notice("warn", "preview-orphan",
        `preview port ${r.port} is still in use by a process this daemon did not start. `
        + `Free it with: ss -ltnp 'sport = :${r.port}'`);
    }
  }
  try { unlinkSync(pidfilePath()); } catch { /* already gone */ }
  if (killed) console.log(`[preview] reaped ${killed} dev server(s) left by a previous run`);
  return killed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Start / stop
// ─────────────────────────────────────────────────────────────────────────────

/** Ports a live entry is holding. Includes `stopping` — see pickPort. */
const reservedPorts = (): Set<number> => new Set([...previews.values()].map((e) => e.port));

/**
 * Start (or return) the preview for a task.
 *
 * IDEMPOTENT. Two rapid clicks, or a click on an already-running preview, return
 * the same entry rather than racing two spawns for one port. Throws with an
 * operator-readable message when it cannot start; callers surface `e.message`.
 */
export async function startPreview(task: Task, project: Project | undefined): Promise<PreviewState> {
  if (!config.preview.enabled) throw new Error("previews are disabled on this daemon (AGENTDECK_PREVIEW=false)");

  const existing = previews.get(task.id);
  if (existing) {
    if (existing.stopping) throw new Error("this preview is still shutting down — try again in a moment");
    if (existing.starting) return existing.starting;   // in flight: same promise, one child
    return view(existing);                              // ready or failed: nothing to do
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
    out: createStderrTail(), starting: null, stopping: null,
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
      const code = await runToCompletion(iArgv, iEnv, task.worktree, entry.out, config.preview.installTimeoutMs);
      if (code === null) throw new Error(`install timed out after ${Math.round(config.preview.installTimeoutMs / 1000)}s — ${entry.out.excerpt() || "no output"}`);
      if (code !== 0) throw new Error(`install failed (exit ${code}) — ${entry.out.excerpt() || "no output"}`);
      setStatus(entry, "starting");
    }

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
      // Only meaningful once ready: before that, the readiness loop reports it with
      // the captured output, which is a far better message than "it closed".
      const e = previews.get(task.id);
      if (e && e.status === "ready") setStatus(e, "failed", e.out.excerpt() || "the dev server exited");
    });
    child.once("error", (e: any) => { dead = true; entry.out.push(`could not run: ${e?.message ?? e}`); });

    const deadline = Date.now() + config.preview.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (dead) throw new Error(`the preview exited before it listened — ${entry.out.excerpt() || "no output"}`);
      if (await canConnect(port)) {
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

  entry.starting = run;
  try {
    return await run;
  } catch (e: any) {
    // Keep the entry in `failed` so the drawer can explain what happened; the port
    // stays reserved until the operator dismisses it with Stop. Any child we did
    // manage to spawn is reaped first, or it would hold the port with nothing
    // tracking it.
    if (entry.pgid) killGroup(entry.pgid, "SIGKILL");
    entry.child = null;
    entry.pgid = null;
    writePidfile();
    setStatus(entry, "failed", String(e?.message ?? e));
    throw e;
  } finally {
    entry.starting = null;
  }
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

  const pgid = e.pgid;
  const child = e.child;
  setStatus(e, "stopping");

  const done = new Promise<void>((resolve) => {
    if (!pgid || !child) return resolve();       // never spawned, or already reaped
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { killGroup(pgid, "SIGKILL"); finish(); }, SIGKILL_AFTER_MS);
    timer.unref?.();                              // never hold the process open for a corpse
    child.once("close", finish);
    child.once("error", finish);
    if (!killGroup(pgid, "SIGTERM")) finish();    // already gone
  }).then(() => {
    previews.delete(taskId);
    writePidfile();
    emitUpdate(taskId);
    if (why) console.log(`[preview] stopped ${taskId} (${why})`);
  });

  e.stopping = done;
  return done;
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
      await stopPreview(e.taskId, `reached the ${Math.round(ttl / 60_000)}min lifetime cap`);
      continue;
    }
    // Health: a dev server that died on its own must show on the board rather than
    // sitting at `ready` while the tab fails to connect.
    if (e.status === "ready" && !(await canConnect(e.port))) {
      setStatus(e, "failed", e.out.excerpt() || "the dev server is no longer listening");
    }
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startPreviewSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { void sweepOncePreviews(); }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();  // a sweep must never be the reason the process stays up
}

/** Test seam: drop all state without signalling anything. */
export function _resetPreviewsForTest(): void {
  previews.clear();
  memCapAvailable = undefined;
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

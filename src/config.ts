import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readFileSync, mkdirSync, openSync, closeSync, fstatSync, readSync, writeSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AgentDeckConfig, Project } from "./types.ts";
// Dependency-free by construction, so this import cannot close a cycle. See the
// header of notices.ts — the ordering guarantee is what makes it safe to call
// notice() from the module body below.
import { notice } from "./notices.ts";

const home = homedir();
const dataDir = process.env.AGENTDECK_DATA_DIR ?? join(home, ".agentdeck");
const port = Number(process.env.AGENTDECK_PORT ?? 8787);
const targetRepo = process.env.AGENTDECK_TARGET_REPO ?? process.cwd();

/**
 * Validate one optional command field on a projects.json entry.
 *
 * Accepts a non-empty string, or an array of non-empty strings. The array form
 * exists because the string form splits on whitespace (the AGENTDECK_CLAUDE_ARGS
 * convention), which silently mangles any argument that legitimately contains a
 * space — `--define "API=https://x/a b"` becomes four arguments and the dev server
 * gets a usage dump instead of a flag. An array has exactly one reading.
 *
 * Returns a spreadable object so an absent or invalid field simply contributes
 * nothing. Exported for the unit tests; MUST NOT throw (see loadProjects).
 */
export function cmdField(
  projectId: string,
  key: "install" | "preview",
  v: unknown,
): Partial<Pick<Project, "install" | "preview">> {
  if (v === undefined || v === null) return {};
  if (typeof v === "string") {
    if (v.trim()) return { [key]: v } as Partial<Project>;
    notice("warn", "projects", `'${projectId}'.${key} is an empty string — ignoring it`);
    return {};
  }
  if (Array.isArray(v)) {
    if (v.length && v.every((s) => typeof s === "string" && s.length)) return { [key]: v as string[] } as Partial<Project>;
    notice("warn", "projects", `'${projectId}'.${key} must be a non-empty array of non-empty strings — ignoring it`);
    return {};
  }
  notice("warn", "projects", `'${projectId}'.${key} must be a string or an array of strings — ignoring it`);
  return {};
}

/**
 * The project registry. Read from `<dataDir>/projects.json` (an array of
 * `{ id, path, label? }`); on any problem — missing, unreadable, malformed,
 * empty after validation — fall back to a single `default` project synthesized
 * from `targetRepo`. config.ts is imported everywhere, so this MUST NOT throw:
 * a crash here is a systemd crash-loop. Exported so it's testable without the
 * singleton. Duplicate ids are dropped (first wins) so routing is unambiguous.
 */
export function loadProjects(dir: string, fallbackRepo: string): Project[] {
  const fallback = (): Project[] => [{ id: "default", path: fallbackRepo, label: basename(fallbackRepo) || "default" }];
  const file = join(dir, "projects.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e: any) {
    if (e?.code !== "ENOENT") notice("warn", "projects", `could not read ${file}: ${e.message} — using the default repo`);
    return fallback();
  }
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error("projects.json must be a JSON array");
    const seen = new Set<string>();
    const out: Project[] = [];
    for (const p of arr) {
      if (!p || typeof p.id !== "string" || !p.id || typeof p.path !== "string" || !p.path) {
        notice("warn", "projects", `skipping malformed entry: ${JSON.stringify(p)}`);
        continue;
      }
      // The id is used as a path segment (uploads/<id>) and a DB value, so it must
      // be a simple slug — reject separators / `..` so it can't escape uploadsDir.
      if (/[/\\]|\.\./.test(p.id)) {
        notice("warn", "projects", `skipping id with path separators: '${p.id}'`);
        continue;
      }
      if (seen.has(p.id)) { notice("warn", "projects", `duplicate id '${p.id}' — keeping the first`); continue; }
      seen.add(p.id);
      out.push({
        id: p.id, path: p.path,
        label: (typeof p.label === "string" && p.label) ? p.label : (basename(p.path) || p.id),
        // Entries are built field-by-field (unknown keys are dropped), so these
        // have to be carried through explicitly. A malformed value is dropped with
        // a warning rather than kept: a half-valid command would fail at spawn
        // time, in a worktree, minutes later — far from the typo that caused it.
        ...cmdField(p.id, "install", p.install),
        ...cmdField(p.id, "preview", p.preview),
      });
    }
    if (out.length) return out;
    notice("warn", "projects", `${file} had no usable entries — using the default repo`);
    return fallback();
  } catch (e: any) {
    notice("warn", "projects", `${file} is not valid JSON (${e.message}) — using the default repo`);
    return fallback();
  }
}

/**
 * The dashboard token, PERSISTED across restarts (0600 in the data dir).
 *
 * It used to be a fresh `randomUUID()` per process. That was harmless while the
 * token only gated write endpoints — a browser re-reads it from the HTML on the
 * next request. It stopped being harmless once the token also gated the `/ws`
 * upgrade: restarting the daemon minted a new token, the already-open dashboard
 * kept sending the old one, and every reconnect attempt got a 403 forever. Live
 * updates died until the user manually reloaded — and restarting the daemon is
 * the single most common thing an operator does.
 *
 * Same secrecy either way (unguessable UUID, 0600), and `AGENTDECK_DASHBOARD_TOKEN`
 * still overrides. MUST NOT throw: config.ts is imported everywhere, so any I/O
 * problem degrades to an in-memory token rather than crash-looping the daemon.
 */
function loadOrCreateDashboardToken(dir: string): string {
  const file = join(dir, "dashboard-token");
  // O_NOFOLLOW: never read THROUGH a symlink. A pre-planted link would otherwise
  // pin the token to attacker-known content. fstat + size cap: refuse anything
  // that isn't a small regular file, so a fifo or huge file can't hang or blow
  // up config import (which every module pulls in).
  const readToken = (): string | null => {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || st.size === 0 || st.size > 256) return null;
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      const t = buf.toString("utf8").trim();
      // Shape-check: our own tokens are UUIDs. Anything else means the file was
      // tampered with, so mint a fresh one rather than trust it.
      return /^[0-9a-fA-F-]{36}$/.test(t) ? t : null;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
    }
  };

  const existing = readToken();
  if (existing) return existing;

  const token = randomUUID();
  try {
    mkdirSync(dir, { recursive: true });
    // O_EXCL | O_CREAT: create or fail — never write THROUGH an existing path or
    // symlink. EEXIST means either a concurrent daemon won the race or the file
    // failed the checks above; re-read once, and only fall back to an in-memory
    // token if that read is still unusable.
    const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeSync(fd, token); } finally { closeSync(fd); }
    return token;
  } catch (e: any) {
    if (e?.code === "EEXIST") {
      const raced = readToken();
      if (raced) return raced;
    }
    notice("warn", "auth", `could not persist the dashboard token to ${file}: ${e.message} — it will change on restart, so an open dashboard needs a reload after one`);
    return token;
  }
}

/**
 * The strict opt-in coercion, exported so it can be tested for real.
 *
 * `=== "true"`, deliberately NOT the `!== "false"` shape used by
 * AGENTDECK_SKIP_PERMISSIONS: this one relaxes a security guard in someone else's
 * binary, so anything that isn't an explicit "true" must leave it alone.
 */
export const isOptIn = (v: string | undefined): boolean => v === "true";

/** Upper bound for a preview port. Linux's default ephemeral range starts at
 *  32768, and a pool inside it races the kernel handing the same port to an
 *  outgoing connection — a rare, unreproducible "the preview randomly won't
 *  start". Below 1024 needs root we don't have (and shouldn't want). */
const PORT_MIN = 1024;
const PORT_MAX = 32767;
/** Each pool port costs one `ssh -L` line and up to ~600MB of dev server, so a
 *  pool this large is a typo (`8788-9788`), not an intention. */
const POOL_MAX = 16;

/**
 * A non-negative millisecond knob, with the same fail-soft contract as parsePool.
 *
 * `Number("4h")` is NaN, and NaN silently defeats every comparison it touches: a
 * NaN ttlMs makes `ttl > 0` false, so the hard lifetime cap disappears without a
 * word; a NaN readyTimeoutMs makes the readiness deadline expire on the first tick
 * and every preview fails with "did not listen within NaNs". Both are far worse
 * than falling back with a warning.
 *
 * `allowZero` exists because 0 is a meaningful value for the TTL (disable the cap)
 * but a broken one for a timeout.
 */
export function posNum(raw: string | undefined, fallback: number, name: string, allowZero = false): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    notice("warn", "preview-config", `${name}='${raw}' is not a ${allowZero ? "non-negative" : "positive"} number of milliseconds — using ${fallback}`);
    return fallback;
  }
  return n;
}

/**
 * Parse the preview port pool: `"8788-8790"` or `"8788,8790"`.
 *
 * PURE + exported so every rejection is testable. MUST NOT throw — config.ts is
 * imported by every module, so a bad value degrades to the default with a warning
 * rather than crash-looping the daemon (see this file's header).
 */
export function parsePool(spec: string | undefined, fallback: number[]): number[] {
  const raw = (spec ?? "").trim();
  if (!raw) return fallback;
  const bad = (why: string): number[] => {
    notice("warn", "preview-ports", `AGENTDECK_PREVIEW_PORTS='${raw}' ${why} — using ${fallback.join(",")}`);
    return fallback;
  };
  let ports: number[];
  const range = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) {
    const lo = Number(range[1]), hi = Number(range[2]);
    if (hi < lo) return bad("has its bounds reversed");
    if (hi - lo + 1 > POOL_MAX) return bad(`asks for ${hi - lo + 1} ports (max ${POOL_MAX})`);
    ports = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  } else {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length || !parts.every((p) => /^\d+$/.test(p))) return bad("is not a range or a comma-separated list");
    ports = [...new Set(parts.map(Number))];
    if (ports.length > POOL_MAX) return bad(`asks for ${ports.length} ports (max ${POOL_MAX})`);
  }
  if (!ports.every((p) => p >= PORT_MIN && p <= PORT_MAX)) {
    return bad(`is outside ${PORT_MIN}-${PORT_MAX} (above ${PORT_MAX} collides with the kernel's ephemeral range)`);
  }
  return ports;
}

export const config: AgentDeckConfig = {
  dataDir,
  // A3: bind localhost only. Reach the dashboard via SSH tunnel, not public exposure.
  // Override with AGENTDECK_HOST=0.0.0.0 ONLY behind a reverse proxy + auth (V2).
  host: process.env.AGENTDECK_HOST ?? "127.0.0.1",
  // Extra hostnames accepted in the `Host` header, on top of the loopback names.
  // Needed only behind a reverse proxy, where the browser sends YOUR domain.
  // Names only — the port is deliberately ignored, so `ssh -L 9000:127.0.0.1:8787`
  // (a different local port) keeps working. See allowedHost() in server.ts.
  allowedHosts: (process.env.AGENTDECK_ALLOWED_HOSTS ?? "")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  port,
  // Legacy single-repo default (still honored via AGENTDECK_TARGET_REPO). It now
  // just seeds the synthesized `default` project when there's no projects.json.
  targetRepo,
  // The project registry — see loadProjects. Boot-validated in daemon.ts.
  projects: loadProjects(dataDir, targetRepo),
  worktreesDir: process.env.AGENTDECK_WORKTREES ?? join(dataDir, "worktrees"),
  uploadsDir: process.env.AGENTDECK_UPLOADS ?? join(dataDir, "uploads"),
  claudeBin: process.env.AGENTDECK_CLAUDE_BIN ?? "claude",
  // gstack's plan-review-log reader. Resolve from PATH first (survives a systemd
  // service, a different user, a packaged install) and only then fall back to the
  // stock ~/.claude location — never hard-code one machine's layout. daemon.ts
  // boot-logs once if the resolved path is missing (plan-review tracking degrades
  // to "never checks" rather than crashing).
  reviewReadBin: process.env.AGENTDECK_REVIEW_READ_BIN
    ?? (Bun.which("gstack-review-read") ?? join(home, ".claude/skills/gstack/bin/gstack-review-read")),
  // Auto-clean a done task's worktree + branch + row once its branch is merged.
  // OFF by default — it's a silent destructive sweep, so the operator opts in.
  autoCleanMerged: process.env.AGENTDECK_AUTO_CLEAN_MERGED === "true",

  // ── A1b launch config (PROVEN by the spike) ─────────────────────────────
  // gstack skills only resolve + run in a headless agent when permissions are
  // fully skipped. This is THE knob that decides whether gstack runs. Default
  // on (unattended orchestrator). Set AGENTDECK_SKIP_PERMISSIONS=false + a
  // AGENTDECK_PERMISSION_MODE only for a supervised debugging session.
  dangerouslySkipPermissions: (process.env.AGENTDECK_SKIP_PERMISSIONS ?? "true") !== "false",
  // Claude Code REFUSES --dangerously-skip-permissions as uid 0 unless it is told
  // it's in a deliberate sandbox, so a root daemon fails every task at spawn. This
  // opt-in makes agents carry IS_SANDBOX=1, which lifts that guard. `=== "true"`
  // (not `!== "false"`) on purpose: relaxing someone else's security guard is
  // opt-in, so anything that isn't an explicit "true" leaves it alone.
  allowRoot: isOptIn(process.env.AGENTDECK_ALLOW_ROOT),
  permissionMode: process.env.AGENTDECK_PERMISSION_MODE ?? "acceptEdits",
  // Default for a new task's pipeline flag. OFF unless explicitly enabled: this
  // ships the state machine observable and harmless, so upgrading a patch release
  // can never start opening PRs on its own.
  //
  // isOptIn, NOT the `!== "false"` idiom used by AGENTDECK_SKIP_PERMISSIONS. That
  // flag defaults ON, so `!== "false"` is the right shape for it; copying it here
  // inverted the guard — `0`, `off`, `no`, `FALSE` and an empty value (a bare
  // `Environment=AGENTDECK_PIPELINE=` line) all resolved to TRUE, arming a pipeline
  // that ends in git push and a PR. Relaxing a guard is always `=== "true"`.
  pipelineDefault: isOptIn(process.env.AGENTDECK_PIPELINE),
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
  // Distinct from hookToken so the agent↔daemon hook secret is NEVER emitted into
  // the dashboard HTML. This one IS injected there (the browser needs it); keeping
  // it separate means scraping the page can't forge hook events. `||` not `??`:
  // an empty env override must not blank the secret and disable the gate.
  dashboardToken: process.env.AGENTDECK_DASHBOARD_TOKEN || loadOrCreateDashboardToken(dataDir),
  agentSettingsPath: join(dataDir, "agent-settings.json"),

  maxConcurrentAgents: Number(process.env.AGENTDECK_MAX_AGENTS ?? 4),

  // Preview dev servers. `!== "false"` (not isOptIn) because the feature is inert
  // until someone clicks Start AND the project declares a `preview` command — there
  // is no guard being relaxed here, which is what isOptIn is reserved for.
  preview: {
    enabled: (process.env.AGENTDECK_PREVIEW ?? "true") !== "false",
    // One knob for reachability and concurrency: every pool port needs its own
    // `ssh -L` line, so the pool IS the concurrency limit. Three is two more than
    // most sessions need and still only ~1.8GB worst case alongside four agents.
    ports: parsePool(process.env.AGENTDECK_PREVIEW_PORTS, [8788, 8789, 8790]),
    readyTimeoutMs: posNum(process.env.AGENTDECK_PREVIEW_READY_TIMEOUT_MS, 60_000, "AGENTDECK_PREVIEW_READY_TIMEOUT_MS"),
    installTimeoutMs: posNum(process.env.AGENTDECK_PREVIEW_INSTALL_TIMEOUT_MS, 600_000, "AGENTDECK_PREVIEW_INSTALL_TIMEOUT_MS"),
    // A hard lifetime cap, NOT an idle timer. The daemon is not in the request path
    // (dev servers are reached directly over the tunnel), so it cannot observe use;
    // any "idle" signal would be a guess. A ceiling is honest and deterministic.
    ttlMs: posNum(process.env.AGENTDECK_PREVIEW_TTL_MS, 4 * 60 * 60_000, "AGENTDECK_PREVIEW_TTL_MS", true),
    memMax: process.env.AGENTDECK_PREVIEW_MEM_MAX ?? "1G",
  },

  notify: {
    telegram: process.env.AGENTDECK_TG_TOKEN && process.env.AGENTDECK_TG_CHAT
      ? { botToken: process.env.AGENTDECK_TG_TOKEN, chatId: process.env.AGENTDECK_TG_CHAT }
      : undefined,
    slack: process.env.AGENTDECK_SLACK_WEBHOOK
      ? { webhookUrl: process.env.AGENTDECK_SLACK_WEBHOOK }
      : undefined,
  },
};

/**
 * True when this daemon cannot start agents at all: uid 0, permissions skipped,
 * and no explicit AGENTDECK_ALLOW_ROOT. Claude Code refuses the flag under root,
 * so EVERY spawn dies in milliseconds.
 *
 * ONE predicate, two callers on purpose — daemon.ts raises the boot notice and
 * server.ts refuses task creation. Duplicating the condition is how the banner
 * and the route drift apart and start disagreeing about whether tasks can run.
 * The uid is a parameter so the whole matrix is testable without being root.
 */
export function rootBlocksAgents(uid: number | undefined): boolean {
  return uid === 0 && config.dangerouslySkipPermissions && !config.allowRoot;
}

/** The same question for THIS process. Split from the pure form above because a
 *  default parameter cannot express "no uid": passing `undefined` explicitly
 *  triggers the default, so the non-POSIX case was impossible to inject despite
 *  the comment promising it was testable. */
export function rootWillBlockAgents(): boolean {
  return rootBlocksAgents(process.getuid?.());
}

/** The one explanation for the above, shared by the boot notice, the /api/tasks
 *  400 and the dashboard banner, so the operator reads the same sentence
 *  wherever they hit it first. */
export const ROOT_BLOCKED_MESSAGE =
  "running as root: Claude Code refuses --dangerously-skip-permissions as uid 0, so agents cannot start and new tasks are refused. " +
  "The fix is to run the daemon as an unprivileged user — scripts/setup-agent-user.sh creates one and installs the systemd unit (see the README runbook). " +
  "Last resorts, in that order: AGENTDECK_SKIP_PERMISSIONS=false (agents run, gstack skills won't resolve), " +
  "or AGENTDECK_ALLOW_ROOT=true (agents run AS ROOT with permissions skipped — the blast radius becomes the whole box).";

/** Resolve a project by id. Reads the live registry so daemon.ts boot-validation
 *  (which may drop invalid entries) is reflected. */
export function projectById(id?: string | null): Project | undefined {
  if (!id) return undefined;
  return config.projects.find((p) => p.id === id);
}

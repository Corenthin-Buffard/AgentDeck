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
      out.push({ id: p.id, path: p.path, label: (typeof p.label === "string" && p.label) ? p.label : (basename(p.path) || p.id) });
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
  // can never start opening PRs on its own. `!== "false"` rather than `=== "true"`
  // once opted in, matching the AGENTDECK_SKIP_PERMISSIONS idiom above.
  pipelineDefault: (process.env.AGENTDECK_PIPELINE ?? "false") !== "false",
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
  "Run the daemon as an unprivileged user (systemd: User=), or set AGENTDECK_ALLOW_ROOT=true, " +
  "or set AGENTDECK_SKIP_PERMISSIONS=false (agents run, gstack skills won't resolve).";

/** Resolve a project by id. Reads the live registry so daemon.ts boot-validation
 *  (which may drop invalid entries) is reflected. */
export function projectById(id?: string | null): Project | undefined {
  if (!id) return undefined;
  return config.projects.find((p) => p.id === id);
}

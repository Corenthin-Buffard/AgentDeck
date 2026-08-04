import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readFileSync, mkdirSync, openSync, closeSync, fstatSync, readSync, writeSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AgentDeckConfig, Project } from "./types.ts";

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
    if (e?.code !== "ENOENT") console.warn(`[projects] could not read ${file}: ${e.message} — using the default repo`);
    return fallback();
  }
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error("projects.json must be a JSON array");
    const seen = new Set<string>();
    const out: Project[] = [];
    for (const p of arr) {
      if (!p || typeof p.id !== "string" || !p.id || typeof p.path !== "string" || !p.path) {
        console.warn(`[projects] skipping malformed entry: ${JSON.stringify(p)}`);
        continue;
      }
      // The id is used as a path segment (uploads/<id>) and a DB value, so it must
      // be a simple slug — reject separators / `..` so it can't escape uploadsDir.
      if (/[/\\]|\.\./.test(p.id)) {
        console.warn(`[projects] skipping id with path separators: '${p.id}'`);
        continue;
      }
      if (seen.has(p.id)) { console.warn(`[projects] duplicate id '${p.id}' — keeping the first`); continue; }
      seen.add(p.id);
      out.push({ id: p.id, path: p.path, label: (typeof p.label === "string" && p.label) ? p.label : (basename(p.path) || p.id) });
    }
    if (out.length) return out;
    console.warn(`[projects] ${file} had no usable entries — using the default repo`);
    return fallback();
  } catch (e: any) {
    console.warn(`[projects] ${file} is not valid JSON (${e.message}) — using the default repo`);
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
    console.warn(`[auth] could not persist the dashboard token to ${file}: ${e.message} — it will change on restart, so an open dashboard needs a reload after one`);
    return token;
  }
}

export const config: AgentDeckConfig = {
  dataDir,
  // A3: bind localhost only. Reach the dashboard via SSH tunnel, not public exposure.
  // Override with AGENTDECK_HOST=0.0.0.0 ONLY behind a reverse proxy + auth (V2).
  host: process.env.AGENTDECK_HOST ?? "127.0.0.1",
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
  permissionMode: process.env.AGENTDECK_PERMISSION_MODE ?? "acceptEdits",
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

/** Resolve a project by id. Reads the live registry so daemon.ts boot-validation
 *  (which may drop invalid entries) is reflected. */
export function projectById(id?: string | null): Project | undefined {
  if (!id) return undefined;
  return config.projects.find((p) => p.id === id);
}

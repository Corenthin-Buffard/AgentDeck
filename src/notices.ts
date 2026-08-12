import type { BootNotice, NoticeLevel } from "./types.ts";

// Daemon-level notices — the things AgentDeck knows are wrong that a browser
// user would otherwise never see. "running as root", "no valid project", "the
// host gate will 403 you" all used to live in journald only, which is the one
// place someone debugging from a dashboard is not looking.
//
// DELIBERATELY DEPENDENCY-FREE (the only import is type-only, so it's erased).
// config.ts imports this module, and `notices -> config` would close a cycle and
// hit the TDZ on `config` during import — a systemd crash-loop, which is the
// exact failure config.ts's own comments are written to avoid. ESM evaluates a
// module's dependencies before the importer's body, so loadProjects() (called
// from the config object literal) is guaranteed to run AFTER this module has
// finished evaluating, whichever module the process entered through.
//
// DISCLOSURE: these strings are served by GET /api/health and pushed over /ws,
// both open reads. Paths and hostnames are fine — the board already exposes
// prompts, branches and worktree paths. NEVER interpolate a token value.

const MAX_NOTICES = 50;

const list: BootNotice[] = [];
const seen = new Set<string>();
let truncated = false;

/** Called with each new notice so the server can push it to open dashboards.
 *  Set by server.ts; unset in tests and before startServer(). */
let onAdd: ((n: BootNotice) => void) | null = null;
export function setNoticeListener(fn: ((n: BootNotice) => void) | null): void { onAdd = fn; }

/**
 * Record a notice AND log it, so journald output is unchanged in substance:
 * every call still prints `[code] message`, exactly like the console.warn it
 * replaces. Never throws — a notice is never worth crashing the daemon over.
 *
 * Deduped by CODE ALONE, not by message. Two reasons: a projects.json with 500
 * malformed entries must not become 500 banner rows, and a repeatedly failing
 * task must append exactly one runtime notice rather than one per failure.
 */
export function notice(level: NoticeLevel, code: string, message: string): void {
  try {
    (level === "error" ? console.error : console.warn)(`[${code}] ${message}`);
    if (seen.has(code)) return;
    if (list.length >= MAX_NOTICES) { truncated = true; return; }
    seen.add(code);
    const n: BootNotice = { level, code, message };
    list.push(n);
    // Broadcast AFTER the push so a listener that reads notices() sees this one.
    // Guarded: a throwing listener must not turn a warning into a crash.
    try { onAdd?.(n); } catch { /* a broken listener is not worth the daemon */ }
  } catch { /* console gone (detached service) — the daemon still boots */ }
}

/** Snapshot for the API and the websocket. Entries are copied too, not just the
 *  array — these go straight to a route handler and to the notice listener, and
 *  the boot record is the one thing that must read the same all process long.
 *  Bounded by MAX_NOTICES, so the copy is never more than 50 small objects. */
export function notices(): BootNotice[] { return list.map((n) => ({ ...n })); }

/** True once MAX_NOTICES was hit and further notices were logged but not kept. */
export function noticesTruncated(): boolean { return truncated; }

/** Tests only. This module is a process-wide singleton and `bun test` shares one
 *  module registry across files, so a suite that provokes warnings (config.test.ts
 *  feeds loadProjects malformed input) must be able to clean up after itself. */
export function resetNotices(): void {
  list.length = 0;
  seen.clear();
  truncated = false;
  onAdd = null;
}

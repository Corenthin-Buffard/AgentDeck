import type { ServerWebSocket } from "bun";
import { mkdirSync, renameSync, realpathSync, rmSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
// Embed the dashboard into the binary as a string so `bun build --compile`
// yields a self-contained executable (no sibling public/ dir needed at runtime).
import indexHtml from "../public/index.html" with { type: "text" };
// package.json, not the VERSION file: VERSION is extensionless, so bun-types'
// `declare module "*.ext"` shims don't cover it and tsc won't resolve a text
// import of it. Both files carry the same number; keep them in step when bumping.
import pkg from "../package.json" with { type: "json" };
import { config, projectById, rootWillBlockAgents, ROOT_BLOCKED_MESSAGE } from "./config.ts";
import { store } from "./db.ts";
import { bus } from "./bus.ts";
import { notices, noticesTruncated, setNoticeListener } from "./notices.ts";
import { answer, stopTask } from "./agent.ts";
import { createTask, removeTask, findBySession } from "./tasks.ts";
import { parseDecisionBrief } from "./detect.ts";
import { diffStat } from "./git.ts";
import { notify } from "./notify.ts";

const MAX_UPLOAD = 25 * 1024 * 1024; // 25MB app cap; maxRequestBodySize is the first curtain
// The only `dest` the upload accepts beyond the per-project uploads dir: the
// gstack browse-state convention, written into the project repo so an agent can
// `$B state load`. Anything else is rejected (no arbitrary path into the repo).
const BROWSE_STATES = ".gstack/browse-states";

/** Escape a value for safe interpolation into an HTML attribute. */
function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Resolve where an upload should land, or return null if the request tries to
 * escape its root. `dest` empty → per-project uploads dir; `dest` === the
 * browse-states convention → the project repo's browse-states dir. Returns the
 * final `target`, the trusted `base` (uploadsDir or the repo — operator-configured,
 * so we trust symlinks in it), and the intended `root` dir the file must land in.
 * This does LEXICAL containment only — the caller must additionally realpath-check
 * that `root` is exactly the canonical `base`+subpath, because a symlinked
 * directory component would pass a lexical check yet redirect the write elsewhere
 * (out of the repo, into `.git/`, or to another dir like `src/`).
 */
function resolveUploadPath(project: { id: string; path: string }, dest: string, filename: string): { target: string; base: string; root: string } | null {
  const safeName = basename(filename).replace(/[^\w.\-]/g, "_").replace(/^\.+/, "") || "upload";
  const norm = dest.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  let root: string, base: string;
  if (!norm) {
    base = resolve(config.uploadsDir);
    root = resolve(base, project.id);
  } else if (norm === BROWSE_STATES) {
    base = resolve(project.path);
    root = resolve(base, BROWSE_STATES);
  } else {
    return null; // dest not on the whitelist
  }
  const target = resolve(root, safeName);
  const withinRoot = target === root || target.startsWith(root + sep);
  if (!withinRoot) return null;
  if (target.split(sep).includes(".git")) return null; // never write into a .git dir
  return { target, base, root };
}

const clients = new Set<ServerWebSocket<unknown>>();
// Subprotocol name the client offers alongside the token. Echoed on the 101 so
// the browser accepts the handshake; kept in sync with public/index.html.
const WS_PROTOCOL = "agentdeck.v1";

// ── DNS-rebinding gate ────────────────────────────────────────────────────
// A hostile page served from a domain whose DNS resolves to 127.0.0.1 reaches
// this daemon from the user's OWN browser, same-origin. Nothing below stops it:
// reads are ungated by design, so `GET /api/tasks` hands it the whole board, and
// the /ws Origin check can't help because it compares `Origin` against
// `url.host` — and Bun derives `url.host` from the same attacker-controlled
// `Host` header, so the two validate each other.
//
// So decide up front which Host values are ours. Compare NAMES, ignore the port:
// `ssh -L 9000:127.0.0.1:8787` makes the browser send `localhost:9000` while we
// listen on 8787, and that tunnel is the documented way in.
const LOOPBACK_NAMES = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1"]);
// All of 127.0.0.0/8 is loopback and unreachable from off-box, so `127.0.0.2` is
// as safe as `127.0.0.1`. Rebinding doesn't gain anything here: the browser sends
// the ATTACKER'S domain in Host, never the address it resolved to.
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * The bare host NAME from a `Host` header, or null if it isn't a plain host.
 *
 * Parsing strictly matters more than it looks. An earlier version took
 * everything before the first `:` (or between the brackets) and threw the rest
 * away, which is not "ignore the port" — it's "ignore any suffix glued onto a
 * trusted name". `[::1]evil.com`, `[::1]@evil.example` and `localhost:443:evil`
 * all passed as loopback. So: after the name, the ONLY thing allowed is a
 * numeric port. Anything else fails closed.
 */
export function hostName(hostHeader: string | null | undefined): string | null {
  if (!hostHeader) return null; // HTTP/1.1 requires Host; absent = not something we serve
  const raw = hostHeader.trim().toLowerCase();
  let name: string, rest: string;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return null; // unterminated bracket
    name = raw.slice(1, end);
    rest = raw.slice(end + 1);
  } else {
    const colon = raw.indexOf(":");
    name = colon === -1 ? raw : raw.slice(0, colon);
    rest = colon === -1 ? "" : raw.slice(colon);
  }
  if (rest !== "" && !/^:\d+$/.test(rest)) return null;
  // `localhost.` is the absolute form of `localhost` and resolves identically,
  // so a browser sending it must not be locked out.
  if (name.endsWith(".")) name = name.slice(0, -1);
  return name || null;
}

export function allowedHost(hostHeader: string | null | undefined): boolean {
  const name = hostName(hostHeader);
  if (name === null) return false;
  if (LOOPBACK_NAMES.has(name) || IPV4_LOOPBACK.test(name)) return true;
  // Run configured entries through the SAME parser, so an operator who writes
  // `AGENTDECK_ALLOWED_HOSTS=example.com:443` isn't silently never matched.
  return config.allowedHosts.some((h) => hostName(h) === name);
}

/** Loopback bind address? Used for the boot warning, so `127.0.0.2` doesn't warn. */
export function isLoopbackBind(host: string): boolean {
  const name = hostName(host);
  return name !== null && (LOOPBACK_NAMES.has(name) || IPV4_LOOPBACK.test(name));
}

/**
 * Tasks as the dashboard sees them: the stored row, plus the decision brief
 * parsed out of a waiting agent's question so the reply drawer can offer the
 * options as buttons instead of making you retype a letter off a wall of prose.
 *
 * DERIVED, never persisted. It's a view of `pendingQuestion`, so re-parsing on
 * every send costs nothing measurable and means a parser improvement applies to
 * agents that are already waiting, with no migration and nothing to backfill.
 */
/**
 * Read the request body's `pipeline` field, or `undefined` for "not specified"
 * (which lets createTask fall through to config.pipelineDefault).
 *
 * ONLY a real boolean counts. A stale client sending the STRING "false" would be
 * truthy under any looser check, silently turning the pipeline ON for a task the
 * operator asked to keep free-form — and that task would then go and open a PR.
 * Erring toward the configured default is always recoverable; guessing `true`
 * from a string is not. PURE + exported so the coercion is testable without
 * creating a worktree and spawning a real agent.
 */
export function pipelineFlag(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function withBriefs<T extends { status: string; pendingQuestion?: string | null }>(tasks: T[]) {
  return tasks.map((t) => {
    // Only a WAITING agent is asking anything. Parsing a running or done task's
    // last message would put clickable answers under a question nobody asked.
    if (t.status !== "waiting" || !t.pendingQuestion) return t;
    const brief = parseDecisionBrief(t.pendingQuestion);
    return brief ? { ...t, brief } : t;
  });
}

function tasksForClient() {
  return withBriefs(store.listTasks());
}

function sendAll(payload: string) {
  for (const ws of clients) { try { ws.send(payload); } catch { /* dropped */ } }
}

function broadcast() {
  sendAll(JSON.stringify({ type: "tasks", tasks: tasksForClient() }));
}
bus.on("update", broadcast);

// Notices ride their OWN frame, deliberately not folded into the tasks payload.
// broadcast() fires on every tool call and every phase change; notices are a
// handful of strings that almost never change, so bundling them would re-send the
// same static array hundreds of times per task per minute and tie a static
// contract to the hot path. The dashboard ignores unknown `type`s, so an older
// cached page degrades to "no banner" rather than a broken board.
function noticesPayload() {
  return JSON.stringify({ type: "notices", notices: notices() });
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Exit code for a configuration problem the daemon cannot recover from by
 * retrying — currently only "port already bound". 78 is sysexits' EX_CONFIG.
 *
 * It matters which code we pick: the README's systemd unit uses
 * Restart=on-failure, so ANY non-zero exit restarts us, and a port that's busy
 * now will still be busy in a second — a restart loop. The unit pairs this with
 * RestartPreventExitStatus=78 so a config error stops cleanly and stays stopped,
 * while a genuine crash still restarts.
 */
export const EXIT_CONFIG = 78;

/** Bun.serve(), but a port clash prints one line instead of a raw stack trace.
 *  Without this the throw also escapes startServer(), so startAutoCleanSweep()
 *  in daemon.ts never runs and the failure reads like an internal error. */
function serveOrExit(opts: Parameters<typeof Bun.serve>[0]) {
  try {
    return Bun.serve(opts as any);
  } catch (e: any) {
    if (e?.code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(String(e?.message ?? e))) {
      console.error(`[port] ${config.host}:${config.port} is already in use — another AgentDeck daemon may already be running. Set AGENTDECK_PORT to a free port, or stop the other instance.`);
      process.exit(EXIT_CONFIG);
    }
    throw e;
  }
}

export function startServer() {
  // Serve the dashboard with the DASHBOARD token injected (never the hook token),
  // so its write fetches can carry the x-agentdeck-token header. Computed once —
  // fixed for the process. Function replacement so a `$` in a custom token isn't
  // read as a $-pattern.
  // The pipeline default rides along in the same meta-tag mechanism. It belongs
  // here rather than on /api/projects (it is not a property of a project) and not
  // on /api/health (that answers "is this daemon working", not "how is it set up").
  // The New-task checkbox needs it before the first render, so a served constant
  // beats another round trip.
  const dashboardHtml = indexHtml
    .replace("__AD_TOKEN__", () => escAttr(config.dashboardToken))
    .replace("__AD_PIPELINE_DEFAULT__", () => (config.pipelineDefault ? "true" : "false"));
  // From here on, a notice raised at RUNTIME (agent.ts retracting the root-bypass
  // claim) reaches every open dashboard immediately instead of waiting for the next
  // reconnect. Registered before serve() so nothing raised during startup is lost.
  setNoticeListener(() => sendAll(noticesPayload()));
  const server = serveOrExit({
    hostname: config.host, // A3: localhost by default — do not expose the control API publicly
    port: config.port,
    // First curtain on upload size: reject an over-large body before it's buffered
    // into RAM (the 25MB app cap is the second curtain). ~26MB leaves headroom.
    maxRequestBodySize: 26 * 1024 * 1024,
    async fetch(req, srv) {
      // FIRST — ahead of `new URL(req.url)`, not just ahead of routing. Bun
      // builds req.url from the Host header, so a malformed Host makes the URL
      // constructor throw, and Bun's fallback error page answers with a 500 that
      // echoes the attacker's Host back plus an internal path and a stack frame.
      // Reading the header directly needs no parsing and cannot throw.
      //
      // Ahead of routing matters too: the reads are the leak — a rebound page
      // fetching /api/tasks never touches an auth gate.
      if (!allowedHost(req.headers.get("host"))) {
        return new Response(
          "host not allowed — set AGENTDECK_ALLOWED_HOSTS if you serve this behind a reverse proxy\n",
          { status: 403 },
        );
      }

      const url = new URL(req.url);
      const { pathname } = url;

      // WebSockets are NOT covered by the same-origin policy. The "reads stay
      // open on localhost" reasoning below does NOT extend here: CORS stops a
      // cross-origin page from READING an HTTP response, but a WebSocket hands
      // it the bytes directly — and we push the full task snapshot on open
      // (titles, prompts, branches, errors, pending questions). So any page the
      // user happens to have open could slurp the board. Gate the upgrade on the
      // same dashboard token as the writes, and reject a foreign Origin outright.
      // A non-browser client sends no Origin; it still needs the token.
      if (pathname === "/ws") {
        const origin = req.headers.get("origin");
        if (origin) {
          let sameHost = false;
          try { sameHost = new URL(origin).host === url.host; } catch { sameHost = false; }
          if (!sameHost) return new Response(null, { status: 403 });
        }
        // The token rides in Sec-WebSocket-Protocol, not the query string: URLs
        // land in proxy and access logs, which would turn log access into
        // permanent dashboard access. Same reasoning as /api/upload, which puts
        // it in a header for exactly this reason.
        const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
        if (!offered.includes(config.dashboardToken)) {
          return new Response(null, { status: 403 });
        }
        // Echo the NAME, never the secret: the 101 response is not a place to
        // reflect a credential back. A browser closes the socket unless we
        // select one of the protocols it offered.
        return srv.upgrade(req, { headers: { "Sec-WebSocket-Protocol": WS_PROTOCOL } })
          ? undefined : new Response("upgrade failed", { status: 400 });
      }

      // ── Auth gates (all WRITE endpoints; reads stay open on localhost) ───
      // Hooks: AGENTS authenticate with the 0600 hook token via ?token=.
      if (pathname.startsWith("/hooks/") && req.method === "POST" &&
          url.searchParams.get("token") !== config.hookToken) {
        return new Response(null, { status: 403 });
      }
      // Dashboard writes: the BROWSER authenticates with the dashboard token
      // (injected into the served HTML) via the x-agentdeck-token header. Every
      // one of these mutates state — create/kill/drive an agent (--dangerously-
      // skip-permissions, RCE-class) or write a file into a repo. Gating them is
      // anti-CSRF: a cross-origin page can't read the HTML to learn the token, so
      // it can't forge these even with the tunnel open. Reads (GET) stay ungated.
      const perTask = /^\/api\/tasks\/[^/]+/.test(pathname);
      const isDashboardWrite =
        (pathname === "/api/upload" && req.method === "POST") ||
        (pathname === "/api/tasks" && req.method === "POST") ||
        (perTask && (req.method === "DELETE" || req.method === "POST"));
      if (isDashboardWrite && req.headers.get("x-agentdeck-token") !== config.dashboardToken) {
        return new Response(null, { status: 403 });
      }

      // ── REST API ──────────────────────────────────────────────────────
      // What you curl when the dashboard looks wrong, and what the install runbook
      // verifies instead of grepping the page title — a broken config serves a
      // perfectly good page while every task dies. Ungated like the other GET reads
      // (the Host gate above is the perimeter): it discloses strictly less than
      // GET /api/tasks, which already hands over prompts and branch names.
      //
      // ALWAYS 200. The daemon IS up; `ok: false` is what says the configuration
      // isn't. A 503 here would fail `curl -fsS` probes for a non-outage.
      if (pathname === "/api/health" && req.method === "GET") {
        const list = notices();
        // SPLIT payload. Liveness stays open so a plain `curl` works for the
        // install runbook and any monitoring probe — that is what this endpoint is
        // for. The DETAIL needs the dashboard token, because uid plus the notice
        // messages amount to "this box runs an agent orchestrator as root, and
        // here is where its files live", answerable before any task exists.
        const base = {
          ok: !list.some((n) => n.level === "error"),
          version: pkg.version,
          uptimeMs: Math.round(process.uptime() * 1000),
        };
        if (req.headers.get("x-agentdeck-token") !== config.dashboardToken) {
          // Say that detail exists and how to get it, so a failing probe isn't a dead end.
          return json({ ...base, detail: "send x-agentdeck-token for uid and notices" });
        }
        return json({
          ...base,
          uid: process.getuid?.() ?? null,
          notices: list,
          // Otherwise hitting the cap drops notices with nothing to observe it by.
          noticesTruncated: noticesTruncated(),
        });
      }
      if (pathname === "/api/projects" && req.method === "GET") {
        return json({ projects: config.projects.map((p) => ({ id: p.id, label: p.label })) });
      }
      if (pathname === "/api/tasks" && req.method === "GET") {
        return json({ tasks: tasksForClient() });
      }
      if (pathname === "/api/tasks" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        if (!b.title || !b.prompt) return json({ error: "title and prompt required" }, 400);
        if (!config.projects.length) return json({ error: "no project configured — add one to projects.json" }, 400);
        // Don't create work that cannot run. Under root without the opt-in, every
        // spawn dies in milliseconds, so accepting the task would only leave a
        // worktree, a branch and a dead row to clean up. Same predicate and same
        // sentence as the boot notice, so the two can't drift.
        if (rootWillBlockAgents()) return json({ error: ROOT_BLOCKED_MESSAGE }, 400);
        // A provided-but-unknown projectId (stale dashboard, typo) must NOT silently
        // land the agent in the first repo — reject it, like /api/upload does.
        if (b.projectId != null && b.projectId !== "" && !projectById(String(b.projectId))) {
          return json({ error: "unknown project" }, 400);
        }
        const pipeline = pipelineFlag(b.pipeline);
        try {
          const t = await createTask(String(b.title), String(b.prompt), b.projectId ? String(b.projectId) : undefined, pipeline);
          return json({ task: t });
        } catch (e: any) {
          return json({ error: `could not create task: ${e.message}` }, 500);
        }
      }
      const m = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(\w+))?$/);
      if (m) {
        const [, id, action] = m;
        if (!store.getTask(id)) return json({ error: "not found" }, 404);
        if (req.method === "DELETE") {
          const q = url.searchParams.get("mode");
          const mode = q === "commit" || q === "force" ? q : "safe";
          return json(await removeTask(id, mode));
        }
        if (action === "answer" && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          if (!b.text) return json({ error: "text required" }, 400);
          try { answer(id, String(b.text)); return json({ ok: true }); }
          catch (e: any) { return json({ error: e.message }, 409); }
        }
        if (action === "stop" && req.method === "POST") { stopTask(id); return json({ ok: true }); }
        if (action === "events" && req.method === "GET") return json({ events: store.recentEvents(id) });
        if (action === "diff" && req.method === "GET") {
          const t = store.getTask(id)!;
          return json({ diff: await diffStat(t.worktree) });
        }
      }

      // ── Upload (local → VPS): multipart, token-gated at the top ─────────
      if (pathname === "/api/upload" && req.method === "POST") {
        const form = await req.formData().catch(() => null);
        if (!form) return json({ error: "multipart form required" }, 400);
        const file = form.get("file");
        const projectId = String(form.get("project") ?? "");
        const dest = String(form.get("dest") ?? "");
        if (!(file instanceof File)) return json({ error: "file field required" }, 400);
        const project = projectById(projectId);
        if (!project) return json({ error: "unknown project" }, 400);
        if (file.size > MAX_UPLOAD) return json({ error: `file too large (max ${MAX_UPLOAD / 1024 / 1024}MB)` }, 413);
        const resolved = resolveUploadPath(project, dest, file.name);
        if (!resolved) return json({ error: "destination not allowed" }, 400);
        const { target, base, root } = resolved;
        try {
          mkdirSync(root, { recursive: true });
          // Symlink defense: after resolving symlinks, the created dir must BE the
          // canonical intended dir — realpath of the trusted base (operator-configured)
          // plus the LITERAL subpath. Any symlinked component makes realpath differ,
          // which rejects every redirect: out of the repo, into `.git/`, or to another
          // in-repo dir like `src/`. A lexical check alone (or an under-base check) is
          // bypassable by a pre-placed symlink at `.gstack/browse-states`.
          const expected = join(realpathSync(base), relative(base, root));
          if (realpathSync(root) !== expected) {
            return json({ error: "destination not allowed" }, 400);
          }
          // Write to a temp name then rename over the target so a pre-placed
          // symlink at `target` (the leaf) can't redirect the write either.
          const tmp = join(root, `.tmp-${randomUUID()}`);
          try {
            await Bun.write(tmp, file);
            renameSync(tmp, target);
          } catch (e) {
            rmSync(tmp, { force: true }); // don't strand a temp file on failure
            throw e;
          }
          return json({ path: target });
        } catch (e: any) {
          return json({ error: `upload failed: ${e.message}` }, 500);
        }
      }
      if (pathname === "/hooks/notification" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const t = b?.session_id ? findBySession(b.session_id) : undefined;
        if (t && t.status === "running") {
          store.patchTask(t.id, { status: "waiting", pendingQuestion: String(b.message ?? "needs your attention").slice(0, 2000), lastActivity: Date.now() });
          bus.emit("update", t.id);
          notify(store.getTask(t.id)!, "waiting");
        }
        return new Response(null, { status: 204 });
      }
      if (pathname === "/hooks/pre-tool-use" && req.method === "POST") {
        return json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
      }

      // ── Dashboard ───────────────────────────────────────────────────────
      if (pathname === "/" || pathname === "/index.html") {
        // no-store: the HTML carries the per-session token, so it must never be
        // written to a browser/proxy cache where it could be replayed.
        return new Response(dashboardHtml, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        // Notices first, so the banner is up before the board paints. Sent even
        // when EMPTY on purpose: that is what clears a stale banner in a tab left
        // open across the restart that fixed the problem.
        try { ws.send(noticesPayload()); } catch { /* dropped */ }
        ws.send(JSON.stringify({ type: "tasks", tasks: tasksForClient() }));
      },
      close(ws) { clients.delete(ws); },
      message() { /* dashboard is read + REST; ws is push-only */ },
    },
  });
  const projList = config.projects.map((p) => `${p.id}→${p.path}`).join(", ") || "(none)";
  // Report the address we actually bound, not a hardcoded "localhost" — an
  // operator who set AGENTDECK_HOST needs the line to match reality.
  console.log(`AgentDeck daemon on http://${config.host}:${server.port}  (${config.projects.length} project(s): ${projList})`);
  return server;
}

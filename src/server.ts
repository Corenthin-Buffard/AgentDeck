import type { ServerWebSocket } from "bun";
import { mkdirSync, renameSync, realpathSync, rmSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
// Embed the dashboard into the binary as a string so `bun build --compile`
// yields a self-contained executable (no sibling public/ dir needed at runtime).
import indexHtml from "../public/index.html" with { type: "text" };
import { config, projectById } from "./config.ts";
import { store } from "./db.ts";
import { bus } from "./bus.ts";
import { answer, stopTask } from "./agent.ts";
import { createTask, removeTask, findBySession } from "./tasks.ts";
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

function broadcast() {
  const payload = JSON.stringify({ type: "tasks", tasks: store.listTasks() });
  for (const ws of clients) { try { ws.send(payload); } catch { /* dropped */ } }
}
bus.on("update", broadcast);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export function startServer() {
  // Serve the dashboard with the DASHBOARD token injected (never the hook token),
  // so its write fetches can carry the x-agentdeck-token header. Computed once —
  // fixed for the process. Function replacement so a `$` in a custom token isn't
  // read as a $-pattern.
  const dashboardHtml = indexHtml.replace("__AD_TOKEN__", () => escAttr(config.dashboardToken));
  const server = Bun.serve({
    hostname: config.host, // A3: localhost by default — do not expose the control API publicly
    port: config.port,
    // First curtain on upload size: reject an over-large body before it's buffered
    // into RAM (the 25MB app cap is the second curtain). ~26MB leaves headroom.
    maxRequestBodySize: 26 * 1024 * 1024,
    async fetch(req, srv) {
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
      if (pathname === "/api/projects" && req.method === "GET") {
        return json({ projects: config.projects.map((p) => ({ id: p.id, label: p.label })) });
      }
      if (pathname === "/api/tasks" && req.method === "GET") {
        return json({ tasks: store.listTasks() });
      }
      if (pathname === "/api/tasks" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        if (!b.title || !b.prompt) return json({ error: "title and prompt required" }, 400);
        if (!config.projects.length) return json({ error: "no project configured — add one to projects.json" }, 400);
        // A provided-but-unknown projectId (stale dashboard, typo) must NOT silently
        // land the agent in the first repo — reject it, like /api/upload does.
        if (b.projectId != null && b.projectId !== "" && !projectById(String(b.projectId))) {
          return json({ error: "unknown project" }, 400);
        }
        try {
          const t = await createTask(String(b.title), String(b.prompt), b.projectId ? String(b.projectId) : undefined);
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
      open(ws) { clients.add(ws); ws.send(JSON.stringify({ type: "tasks", tasks: store.listTasks() })); },
      close(ws) { clients.delete(ws); },
      message() { /* dashboard is read + REST; ws is push-only */ },
    },
  });
  const projList = config.projects.map((p) => `${p.id}→${p.path}`).join(", ") || "(none)";
  console.log(`AgentDeck daemon on http://localhost:${server.port}  (${config.projects.length} project(s): ${projList})`);
  return server;
}

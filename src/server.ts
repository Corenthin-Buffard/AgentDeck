import type { ServerWebSocket } from "bun";
import { mkdirSync, renameSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
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
 * browse-states convention → the project repo's browse-states dir. The filename
 * is reduced to a sanitized basename (no separators survive), and the final path
 * is re-checked to be inside its root and never under `.git/`.
 */
function resolveUploadPath(project: { id: string; path: string }, dest: string, filename: string): string | null {
  const safeName = basename(filename).replace(/[^\w.\-]/g, "_").replace(/^\.+/, "") || "upload";
  const norm = dest.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  let root: string;
  if (!norm) {
    root = resolve(config.uploadsDir, project.id);
  } else if (norm === BROWSE_STATES) {
    root = resolve(project.path, BROWSE_STATES);
  } else {
    return null; // dest not on the whitelist
  }
  const target = resolve(root, safeName);
  const withinRoot = target === root || target.startsWith(root + sep);
  if (!withinRoot) return null;
  if (target.split(sep).includes(".git")) return null; // never write into a .git dir
  return target;
}

const clients = new Set<ServerWebSocket<unknown>>();

function broadcast() {
  const payload = JSON.stringify({ type: "tasks", tasks: store.listTasks() });
  for (const ws of clients) { try { ws.send(payload); } catch { /* dropped */ } }
}
bus.on("update", broadcast);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export function startServer() {
  // Serve the dashboard with the per-session token injected, so its /api/upload
  // fetch can carry ?token=. Computed once — the token is fixed for the process.
  // Function replacement so a `$` in a custom token isn't read as a $-pattern.
  const dashboardHtml = indexHtml.replace("__AD_TOKEN__", () => escAttr(config.hookToken));
  const server = Bun.serve({
    hostname: config.host, // A3: localhost by default — do not expose the control API publicly
    port: config.port,
    // First curtain on upload size: reject an over-large body before it's buffered
    // into RAM (the 25MB app cap is the second curtain). ~26MB leaves headroom.
    maxRequestBodySize: 26 * 1024 * 1024,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/ws") {
        return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
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

      // ── Token gate: hooks + upload ──────────────────────────────────────
      // These POSTs WRITE (a forged `waiting`, or a file into a repo → RCE), so
      // they require the per-session token. The dashboard gets it injected into
      // its HTML; the hook secret lives only in the 0600 settings file. Read-only
      // /api/* stays ungated (localhost + tunnel trust).
      if ((pathname.startsWith("/hooks/") || pathname === "/api/upload") && req.method === "POST" &&
          url.searchParams.get("token") !== config.hookToken) {
        return new Response(null, { status: 403 });
      }

      // ── Upload (local → VPS): multipart, token-gated above ──────────────
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
        const target = resolveUploadPath(project, dest, file.name);
        if (!target) return json({ error: "destination not allowed" }, 400);
        try {
          const dir = target.slice(0, target.lastIndexOf(sep));
          mkdirSync(dir, { recursive: true });
          // Write to a temp name then rename over the target so a pre-placed
          // symlink at `target` can't redirect the write outside its root.
          const tmp = join(dir, `.tmp-${randomUUID()}`);
          await Bun.write(tmp, file);
          renameSync(tmp, target);
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
        return new Response(dashboardHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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

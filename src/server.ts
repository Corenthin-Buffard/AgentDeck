import type { ServerWebSocket } from "bun";
// Embed the dashboard into the binary as a string so `bun build --compile`
// yields a self-contained executable (no sibling public/ dir needed at runtime).
import indexHtml from "../public/index.html" with { type: "text" };
import { config } from "./config.ts";
import { store } from "./db.ts";
import { bus } from "./bus.ts";
import { answer, stopTask } from "./agent.ts";
import { createTask, removeTask, findBySession } from "./tasks.ts";
import { diffStat } from "./git.ts";
import { notify } from "./notify.ts";

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
  const server = Bun.serve({
    hostname: config.host, // A3: localhost by default — do not expose the control API publicly
    port: config.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/ws") {
        return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      }

      // ── REST API ──────────────────────────────────────────────────────
      if (pathname === "/api/tasks" && req.method === "GET") {
        return json({ tasks: store.listTasks() });
      }
      if (pathname === "/api/tasks" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        if (!b.title || !b.prompt) return json({ error: "title and prompt required" }, 400);
        try {
          const t = await createTask(String(b.title), String(b.prompt));
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

      // ── Hooks (optional enhancement; stream detection also works alone) ──
      // Both hook endpoints require the per-session token (query string). Without
      // it any local process could POST a forged `waiting`; the secret lives only
      // in the 0600 settings file the daemon hands to its own agents.
      if (pathname.startsWith("/hooks/") && req.method === "POST" &&
          url.searchParams.get("token") !== config.hookToken) {
        return new Response(null, { status: 403 });
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
        return new Response(indexHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) { clients.add(ws); ws.send(JSON.stringify({ type: "tasks", tasks: store.listTasks() })); },
      close(ws) { clients.delete(ws); },
      message() { /* dashboard is read + REST; ws is push-only */ },
    },
  });
  console.log(`AgentDeck daemon on http://localhost:${server.port}  (target repo: ${config.targetRepo})`);
  return server;
}

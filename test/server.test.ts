import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";

// `config` is a singleton that may be imported by another suite first (with the
// port unset), so setting AGENTDECK_PORT here would be too late. Mutate the
// resolved config directly to bind an ephemeral port, regardless of import order.

// Regression for the embedded-dashboard serve (v0.1.3.0): the "/" route now
// returns the in-memory `indexHtml` string (baked in at build time), not
// `Bun.file(...)`. Compiling only proves the `with { type: "text" }` import
// bundles; this proves the route actually serves the dashboard at runtime.
test('GET "/" serves the embedded dashboard HTML', async () => {
  config.port = 0; // ephemeral port — don't collide with a running daemon
  const { startServer } = await import("../src/server.ts");
  const server = startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>AgentDeck"); // non-empty + right file
  } finally {
    server.stop(true);
  }
});

// A3/T5: the hook endpoints must reject a forged POST that lacks the per-session
// token, so a random local process can't flip a task to `waiting`.
test("hook endpoints require the per-session token", async () => {
  config.port = 0;
  const { startServer } = await import("../src/server.ts");
  const server = startServer();
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const post = (path: string) => fetch(`${base}${path}`, { method: "POST", body: "{}" });

    expect((await post("/hooks/notification")).status).toBe(403);           // no token
    expect((await post("/hooks/notification?token=nope")).status).toBe(403); // wrong token
    expect((await post("/hooks/notification?token=")).status).toBe(403);     // empty token value (config.hookToken is never blank)
    expect((await post("/hooks/pre-tool-use?token=nope")).status).toBe(403); // guards both endpoints
    // correct token: notification → 204 no-op (no matching session); pre-tool-use → allow
    const tok = `token=${encodeURIComponent(config.hookToken)}`;
    expect((await post(`/hooks/notification?${tok}`)).status).toBe(204);
    const pre = await post(`/hooks/pre-tool-use?${tok}`);
    expect(pre.status).toBe(200);
    expect((await pre.json()).hookSpecificOutput.permissionDecision).toBe("allow");

    // the resolved token is never blank, even if the env override is set empty
    expect(config.hookToken.length).toBeGreaterThan(0);
  } finally {
    server.stop(true);
  }
});

// Multi-project: the registry is exposed for the dashboard switcher.
test("GET /api/projects returns the registry", async () => {
  config.port = 0;
  const { startServer } = await import("../src/server.ts");
  const server = startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/projects`);
    expect(res.status).toBe(200);
    const { projects } = await res.json();
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBeGreaterThan(0);          // synthesized default at minimum
    expect(projects[0]).toHaveProperty("id");
    expect(projects[0]).toHaveProperty("label");
  } finally {
    server.stop(true);
  }
});

// POST /api/tasks with an empty registry is a 400, never a createWorktree(undefined).
test("POST /api/tasks with an empty registry → 400", async () => {
  config.port = 0;
  const savedProjects = config.projects;
  config.projects = [];
  const { startServer } = await import("../src/server.ts");
  const server = startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", prompt: "y" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no project/i);
  } finally {
    config.projects = savedProjects;
    server.stop(true);
  }
});

// /api/upload WRITES a file, so it's token-gated and path-contained (an
// unauthenticated write into a repo would be RCE).
test("/api/upload: token-gated, contained, and writes under uploadsDir", async () => {
  config.port = 0;
  const savedUploads = config.uploadsDir;
  const uploads = mkdtempSync(join(tmpdir(), "agentdeck-uploads-"));
  config.uploadsDir = uploads;
  const projectId = config.projects[0].id;
  const { startServer } = await import("../src/server.ts");
  const server = startServer();
  const base = `http://127.0.0.1:${server.port}`;
  const tok = encodeURIComponent(config.hookToken);
  const upload = (fields: Record<string, string>, withToken = true) => {
    const fd = new FormData();
    fd.append("file", new File(["hello vps\n"], "note.txt"));
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return fetch(`${base}/api/upload${withToken ? `?token=${tok}` : ""}`, { method: "POST", body: fd });
  };
  try {
    // no token → 403
    expect((await upload({ project: projectId }, false)).status).toBe(403);
    // wrong token → 403
    expect((await fetch(`${base}/api/upload?token=nope`, { method: "POST", body: new FormData() })).status).toBe(403);
    // unknown project → 400
    expect((await upload({ project: "does-not-exist" })).status).toBe(400);
    // dest not on the whitelist → 400 (can't write arbitrary paths into the repo)
    expect((await upload({ project: projectId, dest: "../../etc" })).status).toBe(400);
    expect((await upload({ project: projectId, dest: "src" })).status).toBe(400);
    // happy path → 200, file lands under uploadsDir/<project>/
    const ok = await upload({ project: projectId });
    expect(ok.status).toBe(200);
    const { path } = await ok.json();
    expect(path.startsWith(join(uploads, projectId))).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("hello vps\n");
  } finally {
    config.uploadsDir = savedUploads;
    rmSync(uploads, { recursive: true, force: true });
    server.stop(true);
  }
});

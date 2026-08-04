import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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

// The brand lockup was defined in the approved mockup, then quietly dropped
// during implementation — and nothing caught it, because the only assertion
// above covers <title>, which lives in <head>. A title can stay correct while
// the visible header says something else entirely (it did: "gorch·inbox").
// These assertions cover what a user actually SEES.
test('GET "/" serves the AgentDeck brand lockup in the body', async () => {
  config.port = 0;
  const { startServer } = await import("../src/server.ts");
  const server = startServer();
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    const body = html.slice(html.indexOf("<body"));

    expect(body).toContain("AgentDeck");                    // the wordmark is visible
    expect(body).toMatch(/<h1[^>]*class="mark"[^>]*>\s*AgentDeck\s*<\/h1>/); // and is the page heading
    expect(html).toContain('rel="icon"');                   // the tab is identifiable
    expect(html.toLowerCase()).not.toContain("gorch");       // no pre-rename leftovers
  } finally {
    server.stop(true);
  }
});

// DESIGN.md Rule 3: any text colour clears 4.5:1, so --faint (4.10:1 dark,
// 2.80:1 light) is non-text only. That rule was violated the same day it was
// written — --done shipped with --faint's exact hex and coloured .chip.done at
// 3.13:1, and nothing caught it. These assertions are that missing guard: they
// fail if a text rule reaches for --faint again, or if either compliant token
// is silently reverted. Recompute the ratios before changing a value here.
test("serves contrast-compliant colour tokens", async () => {
  config.port = 0;
  const { startServer } = await import("../src/server.ts");
  const server = startServer();
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();

    expect(html).not.toContain("color:var(--faint)"); // --faint never carries text
    expect(html).toContain("--dim:#9aa7b4");          // dark  7.71:1 on --bg
    expect(html).toContain("--dim:#5a6570");          // light 5.59:1 on --bg
    expect(html).toContain("--done:#8c97a4");         // dark  4.55:1 on its own tint
    expect(html).toContain("--done:#5d6975");         // light 4.53:1 on its own tint
    expect(html).toContain("min-height:44px");        // touch targets under 620px
  } finally {
    server.stop(true);
  }
});

// /ws pushes the full task snapshot on open, and WebSockets are NOT covered by
// the same-origin policy — so the "reads stay open on localhost" rule that
// applies to GET endpoints would have let any page the user visits read the
// board. The upgrade is gated on the dashboard token plus an Origin check.
test("/ws rejects an upgrade without the dashboard token", async () => {
  config.port = 0;
  const { startServer } = await import("../src/server.ts");
  const server = startServer();
  try {
    const base = `http://127.0.0.1:${server.port}`;

    // The token rides in Sec-WebSocket-Protocol, never the query string.
    const proto = (t: string) => ({ "sec-websocket-protocol": `agentdeck.v1, ${t}` });

    expect((await fetch(`${base}/ws`)).status).toBe(403);                              // no token
    expect((await fetch(`${base}/ws`, { headers: proto("nope") })).status).toBe(403);  // wrong token
    // A token in the URL must NOT work — that transport was deliberately dropped.
    expect((await fetch(`${base}/ws?token=${config.dashboardToken}`)).status).toBe(403);

    // Right token, foreign Origin — the cross-origin browser case.
    const foreign = await fetch(`${base}/ws`, {
      headers: { ...proto(config.dashboardToken), origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);

    // A malformed Origin must fail CLOSED. `new URL(origin)` throws on garbage,
    // and the catch sets sameHost = false — an attacker sending a junk Origin
    // must not slip past the host check into the token check.
    const junk = await fetch(`${base}/ws`, {
      headers: { ...proto(config.dashboardToken), origin: "not-a-url" },
    });
    expect(junk.status).toBe(403);

    // Right token, no Origin (a non-browser client): passes the gate, then fails
    // the upgrade itself because plain fetch sends no WebSocket handshake — 400,
    // not 403, proves the gate let it through.
    const allowed = await fetch(`${base}/ws`, { headers: proto(config.dashboardToken) });
    expect(allowed.status).toBe(400);
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
      method: "POST", headers: { "Content-Type": "application/json", "x-agentdeck-token": config.dashboardToken },
      body: JSON.stringify({ title: "x", prompt: "y" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no project/i);
  } finally {
    config.projects = savedProjects;
    server.stop(true);
  }
});

// The state-changing task endpoints require the dashboard token (anti-CSRF), but
// reads stay open. The gate runs before the handler, so a missing token is 403
// regardless of whether the task exists.
test("state-changing task endpoints require the dashboard token; reads don't", async () => {
  config.port = 0;
  const { startServer } = await import("../src/server.ts");
  const server = startServer();
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // writes with no token → 403
    expect((await fetch(`${base}/api/tasks`, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await fetch(`${base}/api/tasks/anything`, { method: "DELETE" })).status).toBe(403);
    expect((await fetch(`${base}/api/tasks/anything/stop`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${base}/api/tasks/anything/answer`, { method: "POST", body: "{}" })).status).toBe(403);
    // wrong token → 403
    expect((await fetch(`${base}/api/tasks`, { method: "POST", headers: { "x-agentdeck-token": "nope" }, body: "{}" })).status).toBe(403);
    // reads stay open (no token) — GET /api/tasks, /api/projects
    expect((await fetch(`${base}/api/tasks`)).status).toBe(200);
    expect((await fetch(`${base}/api/projects`)).status).toBe(200);
    // with the right token, the write passes the gate (then 400 for missing fields)
    expect((await fetch(`${base}/api/tasks`, { method: "POST", headers: { "Content-Type": "application/json", "x-agentdeck-token": config.dashboardToken }, body: "{}" })).status).toBe(400);
  } finally {
    server.stop(true);
  }
});

// A provided-but-unknown projectId must 400 (not silently run in the first repo).
// Returns before createTask, so no real agent is spawned.
test("POST /api/tasks with an unknown projectId → 400", async () => {
  config.port = 0;
  const { startServer } = await import("../src/server.ts");
  const server = startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-agentdeck-token": config.dashboardToken },
      body: JSON.stringify({ title: "x", prompt: "y", projectId: "no-such-project" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown project/i);
  } finally {
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
  const dtok = config.dashboardToken; // browser token, sent as a header
  const upload = (fields: Record<string, string>, token: string | null = dtok) => {
    const fd = new FormData();
    fd.append("file", new File(["hello vps\n"], "note.txt"));
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const headers = token == null ? {} : { "x-agentdeck-token": token };
    return fetch(`${base}/api/upload`, { method: "POST", headers, body: fd });
  };
  try {
    // no token → 403
    expect((await upload({ project: projectId }, null)).status).toBe(403);
    // wrong token → 403
    expect((await upload({ project: projectId }, "nope")).status).toBe(403);
    // a query ?token= is NOT accepted for dashboard writes (header only) → 403
    expect((await fetch(`${base}/api/upload?token=${encodeURIComponent(dtok)}`, { method: "POST", body: new FormData() })).status).toBe(403);
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

    // a traversal FILENAME (not dest) is reduced to a contained basename
    const fd = new FormData();
    fd.append("file", new File(["x"], "../../../etc/passwd"));
    fd.append("project", projectId);
    const tr = await fetch(`${base}/api/upload`, { method: "POST", headers: { "x-agentdeck-token": dtok }, body: fd });
    expect(tr.status).toBe(200);
    const trPath = (await tr.json()).path;
    expect(trPath.slice(0, trPath.lastIndexOf("/"))).toBe(join(uploads, projectId)); // dirname == uploads/<project>
  } finally {
    config.uploadsDir = savedUploads;
    rmSync(uploads, { recursive: true, force: true });
    server.stop(true);
  }
});

// The 25MB app cap → 413 (between the cap and the 26MB body curtain).
test("/api/upload rejects an over-cap file with 413", async () => {
  config.port = 0;
  const { startServer } = await import("../src/server.ts");
  const server = startServer();
  try {
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(25 * 1024 * 1024 + 512 * 1024)], "big.bin")); // >25MB, <26MB
    fd.append("project", config.projects[0].id);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/upload`, { method: "POST", headers: { "x-agentdeck-token": config.dashboardToken }, body: fd });
    expect(res.status).toBe(413);
  } finally {
    server.stop(true);
  }
});

// dest=.gstack/browse-states writes into the project repo (the cookies flow), and
// a symlinked directory component is rejected by the realpath re-check (no escape
// into ~/.ssh or the repo's own .git/hooks).
test("/api/upload browse-states: lands in the repo, but symlinked dirs are rejected", async () => {
  config.port = 0;
  const savedPath = config.projects[0].path;
  const savedUploads = config.uploadsDir;
  const repo = mkdtempSync(join(tmpdir(), "agentdeck-proj-"));
  const outside = mkdtempSync(join(tmpdir(), "agentdeck-outside-"));
  config.projects[0].path = repo;
  config.uploadsDir = mkdtempSync(join(tmpdir(), "agentdeck-up2-"));
  const projectId = config.projects[0].id;
  const { startServer } = await import("../src/server.ts");
  const server = startServer();
  const base = `http://127.0.0.1:${server.port}`;
  const put = (name: string) => {
    const fd = new FormData();
    fd.append("file", new File(["[]\n"], name));
    fd.append("project", projectId);
    fd.append("dest", ".gstack/browse-states");
    return fetch(`${base}/api/upload`, { method: "POST", headers: { "x-agentdeck-token": config.dashboardToken }, body: fd });
  };
  try {
    // happy path → lands under <repo>/.gstack/browse-states/
    const ok = await put("qa.json");
    expect(ok.status).toBe(200);
    const okPath = (await ok.json()).path;
    expect(okPath.startsWith(join(repo, ".gstack/browse-states"))).toBe(true);
    expect(existsSync(okPath)).toBe(true);

    // now swap browse-states for a symlink pointing OUT of the repo → rejected
    rmSync(join(repo, ".gstack/browse-states"), { recursive: true, force: true });
    symlinkSync(outside, join(repo, ".gstack/browse-states"));
    expect((await put("escape.json")).status).toBe(400);
    expect(existsSync(join(outside, "escape.json"))).toBe(false); // nothing written outside

    // and a symlink into the repo's own .git → also rejected
    rmSync(join(repo, ".gstack/browse-states"), { force: true });
    mkdirSync(join(repo, ".git/hooks"), { recursive: true });
    symlinkSync(join(repo, ".git/hooks"), join(repo, ".gstack/browse-states"));
    expect((await put("post-checkout")).status).toBe(400);
    expect(existsSync(join(repo, ".git/hooks/post-checkout"))).toBe(false);

    // and a WITHIN-repo redirect (→ src/) → also rejected (the P3 hardening:
    // "under the repo and not .git" used to pass this; exact-dir match rejects it)
    rmSync(join(repo, ".gstack/browse-states"), { force: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    symlinkSync(join(repo, "src"), join(repo, ".gstack/browse-states"));
    expect((await put("payload.js")).status).toBe(400);
    expect(existsSync(join(repo, "src/payload.js"))).toBe(false); // no in-repo overwrite
  } finally {
    config.projects[0].path = savedPath;
    config.uploadsDir = savedUploads;
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    server.stop(true);
  }
});

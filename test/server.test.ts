import { describe, expect, test } from "bun:test";
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

// DNS rebinding: a page on a domain that resolves to 127.0.0.1 talks to this
// daemon from the user's own browser, same-origin. Reads are ungated by design,
// so GET /api/tasks would hand it the whole board. The /ws Origin check cannot
// stop it — Origin and url.host both come from the attacker-controlled Host
// header. Every route is gated on a recognised Host, ahead of routing.
test("rejects every route when the Host header isn't ours", async () => {
  config.port = 0;
  const { startServer } = await import("../src/server.ts");
  const server = startServer();
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const evil = { host: "evil.example" };

    // The reads are the actual leak — they must 403 too, not just the writes.
    expect((await fetch(`${base}/api/tasks`, { headers: evil })).status).toBe(403);
    expect((await fetch(`${base}/api/projects`, { headers: evil })).status).toBe(403);
  expect((await fetch(`${base}/api/health`, { headers: evil })).status).toBe(403);   // a new ungated read must not be rebinding-reachable
    expect((await fetch(`${base}/`, { headers: evil })).status).toBe(403);
    expect((await fetch(`${base}/ws`, { headers: evil })).status).toBe(403);

    // A rebound page holding a valid token is still refused: the Host runs first.
    const withToken = await fetch(`${base}/ws`, {
      headers: { ...evil, "sec-websocket-protocol": `agentdeck.v1, ${config.dashboardToken}` },
    });
    expect(withToken.status).toBe(403);

    // The board is never disclosed — not even an empty task list.
    expect(await (await fetch(`${base}/api/tasks`, { headers: evil })).text()).not.toContain("tasks");

    // A MALFORMED Host must 403, not 500. The gate has to run before
    // `new URL(req.url)`: Bun builds that URL from the Host header, so a
    // malformed one makes the constructor throw, and Bun's fallback error page
    // answers 500 with the attacker's Host echoed back plus an internal path.
    // The unit test on allowedHost() passes either way — only this one catches it.
    for (const bad of ["[::1]evil.com", "localhost:443:evil", "localhost:any"]) {
      const res = await fetch(`${base}/api/tasks`, { headers: { host: bad } });
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).not.toContain("evil");       // no echo of what was sent
      expect(body).not.toContain("bunfs");      // no internal path
    }
  } finally {
    server.stop(true);
  }
});

// The documented way in is an SSH tunnel, and the local port can differ from the
// daemon's (`ssh -L 9000:127.0.0.1:8787` → the browser sends `localhost:9000`).
// So the gate compares NAMES and ignores the port; getting this wrong would lock
// every tunnelled user out.
test("accepts loopback names on any port, and configured proxy hosts", async () => {
  const { allowedHost } = await import("../src/server.ts");

  expect(allowedHost("localhost:9000")).toBe(true);   // tunnel on a different port
  expect(allowedHost("127.0.0.1:8787")).toBe(true);
  expect(allowedHost("localhost")).toBe(true);        // no port at all
  expect(allowedHost("[::1]:8787")).toBe(true);       // bracketed IPv6
  expect(allowedHost("LocalHost:8787")).toBe(true);   // Host is case-insensitive
  expect(allowedHost("localhost.")).toBe(true);       // absolute form of the same name
  expect(allowedHost("127.0.0.2:8787")).toBe(true);   // all of 127/8 is loopback

  expect(allowedHost("evil.example")).toBe(false);
  expect(allowedHost("localhost.evil.example")).toBe(false); // suffix trick
  expect(allowedHost("[::1")).toBe(false);            // malformed bracket fails closed
  expect(allowedHost("")).toBe(false);
  expect(allowedHost(null)).toBe(false);

  // A proxy hostname only passes once it is explicitly allowed.
  expect(allowedHost("agentdeck.example.com")).toBe(false);
  config.allowedHosts.push("agentdeck.example.com");
  try {
    expect(allowedHost("agentdeck.example.com:443")).toBe(true);
  } finally {
    config.allowedHosts.pop();
  }

  // An operator who writes the port into the env var must still match. The
  // allowlist goes through the same parser as the request Host.
  config.allowedHosts.push("proxy.example.com:443");
  try {
    expect(allowedHost("proxy.example.com")).toBe(true);
    expect(allowedHost("proxy.example.com:8443")).toBe(true);
  } finally {
    config.allowedHosts.pop();
  }
});

// "Ignore the port" must not decay into "ignore any suffix after a trusted
// name". The first implementation took everything before the first `:` (or
// between the brackets) and discarded the rest, so a loopback prefix with junk
// glued on sailed through. Every case here passed as loopback before the fix.
test("a trusted name with a junk suffix must not pass as loopback", async () => {
  const { allowedHost } = await import("../src/server.ts");

  expect(allowedHost("[::1]evil.com")).toBe(false);      // suffix after the bracket
  expect(allowedHost("[::1]x:443")).toBe(false);         // suffix plus a port
  expect(allowedHost("[::1]@evil.example")).toBe(false); // userinfo after the bracket
  expect(allowedHost("localhost:any")).toBe(false);      // port isn't numeric
  expect(allowedHost("localhost:443:evil")).toBe(false); // second colon
  expect(allowedHost("localhost:")).toBe(false);         // empty port
  expect(allowedHost("user@localhost")).toBe(false);     // userinfo before the name
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
    expect((await fetch(`${base}/api/health`)).status).toBe(200);   // health is a read: ungated like the others
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
  // This test is about projectId validation, so neutralise the unrelated root
  // guard: on a root box it refuses creation first (correctly — nothing can run),
  // which would mask the "unknown project" contract this exists to pin.
  const wasAllow = config.allowRoot;
  config.allowRoot = true;
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-agentdeck-token": config.dashboardToken },
      body: JSON.stringify({ title: "x", prompt: "y", projectId: "no-such-project" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown project/i);
  } finally {
    config.allowRoot = wasAllow;
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

// The dashboard payload carries the parsed brief so the reply drawer can offer
// the agent's options as buttons. Derived, never persisted — so the seam worth
// testing is the mapping, not the DB.
describe("withBriefs", () => {
  const BRIEF =
    "A) Ship as-is\nB) Add the test (recommended)\n" +
    "Completeness: A=4/10, B=9/10\nNet: one test closes the gap.";

  test("attaches the options for a waiting agent", async () => {
    const { withBriefs } = await import("../src/server.ts");
    const [t] = withBriefs([{ status: "waiting", pendingQuestion: BRIEF }]) as any[];
    expect(t.brief.options.map((o: any) => o.letter)).toEqual(["A", "B"]);
    expect(t.brief.options[1].recommended).toBe(true);
  });

  // A running or done task's last message is not an open question. Parsing it
  // would put clickable answers under something nobody asked.
  test("ignores every status except waiting", async () => {
    const { withBriefs } = await import("../src/server.ts");
    for (const status of ["running", "done", "error", "stopped", "resuming"]) {
      const [t] = withBriefs([{ status, pendingQuestion: BRIEF }]) as any[];
      expect(t.brief).toBeUndefined();
    }
  });

  test("leaves a waiting agent whose question isn't a brief untouched", async () => {
    const { withBriefs } = await import("../src/server.ts");
    // The demo's own question: numbered, no brief markers. Free text, no buttons.
    const [t] = withBriefs([{ status: "waiting", pendingQuestion: "Which one for the MVP? Reply 1 or 2." }]) as any[];
    expect(t.brief).toBeUndefined();
  });

  test("survives a waiting agent with no question text", async () => {
    const { withBriefs } = await import("../src/server.ts");
    expect(withBriefs([{ status: "waiting", pendingQuestion: null }])[0]).toHaveProperty("status", "waiting");
    expect((withBriefs([{ status: "waiting", pendingQuestion: null }])[0] as any).brief).toBeUndefined();
  });
});

// ── Daemon notices: /api/health and the /ws frame ───────────────────────────
// Boot problems (running as root, an empty registry, a host gate that will 403
// this browser) used to live in journald only — the one place someone debugging
// from a browser is not looking. These pin the two ways they now get out.

describe("daemon notices", () => {
  test("GET /api/health reports version, uid and the notice list", async () => {
    config.port = 0;
    const { startServer } = await import("../src/server.ts");
    const { notice, resetNotices } = await import("../src/notices.ts");
    const server = startServer();
    try {
      const j = await (await fetch(`http://127.0.0.1:${server.port}/api/health`)).json();
      expect(typeof j.version).toBe("string");
      expect(j.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(Array.isArray(j.notices)).toBe(true);
      expect(typeof j.uptimeMs).toBe("number");
      // Shape-only on the entries: another suite shares this singleton and may
      // have provoked warnings of its own, so never assert the list is empty.
      for (const n of j.notices) {
        expect(["warn", "error"]).toContain(n.level);
        expect(typeof n.code).toBe("string");
        expect(typeof n.message).toBe("string");
      }
    } finally {
      server.stop(true);
      resetNotices();
    }
  });

  test("ok is false with an error notice, true with only warnings", async () => {
    config.port = 0;
    const { startServer } = await import("../src/server.ts");
    const { notice, resetNotices } = await import("../src/notices.ts");
    const server = startServer();
    const base = `http://127.0.0.1:${server.port}`;
    try {
      resetNotices();
      notice("warn", "test-warn", "degraded but running");
      expect((await (await fetch(`${base}/api/health`)).json()).ok).toBe(true);

      notice("error", "test-error", "nothing can run");
      expect((await (await fetch(`${base}/api/health`)).json()).ok).toBe(false);
    } finally {
      resetNotices();
      server.stop(true);
    }
  });

  // The one thing pinning "sent on open". Its absence is invisible until an
  // operator says the banner never shows up.
  test("/ws pushes a notices frame AND a tasks frame on connect", async () => {
    config.port = 0;
    const { startServer } = await import("../src/server.ts");
    const server = startServer();
    try {
      const frames: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, ["agentdeck.v1", config.dashboardToken]);
      ws.onmessage = (m) => { try { frames.push(JSON.parse(String(m.data))); } catch { /* ignore */ } };
      await new Promise((r) => setTimeout(r, 400));
      ws.close();
      expect(frames.some((f) => f.type === "notices" && Array.isArray(f.notices))).toBe(true);
      expect(frames.some((f) => f.type === "tasks" && Array.isArray(f.tasks))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  // Don't create work that is guaranteed to fail: under root without the opt-in,
  // every spawn dies in milliseconds, leaving a worktree and a branch to clean up.
  test("POST /api/tasks refuses while root blocks agents", async () => {
    config.port = 0;
    const { startServer } = await import("../src/server.ts");
    const server = startServer();
    const wasSkip = config.dangerouslySkipPermissions;
    const wasAllow = config.allowRoot;
    try {
      config.dangerouslySkipPermissions = true;
      config.allowRoot = false;
      const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agentdeck-token": config.dashboardToken },
        body: JSON.stringify({ title: "t", prompt: "p" }),
      });
      if (process.getuid?.() === 0) {
        expect(res.status).toBe(400);
        expect((await res.json()).error).toContain("root");
      } else {
        // Not root: the guard must NOT fire. 400 here would be the empty-registry
        // or missing-field path, never the root one.
        const body = await res.json().catch(() => ({}));
        expect(String(body.error ?? "")).not.toContain("refuses --dangerously-skip-permissions");
      }
    } finally {
      config.dangerouslySkipPermissions = wasSkip;
      config.allowRoot = wasAllow;
      server.stop(true);
    }
  });

  // Same spirit as the brand-lockup test above: the banner is a design decision
  // that could be silently dropped during a refactor with nothing to catch it.
  test('GET "/" ships the notices banner and its socket handler', async () => {
    config.port = 0;
    const { startServer } = await import("../src/server.ts");
    const server = startServer();
    try {
      const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
      expect(html).toContain('id="notices"');
      expect(html).toContain('d.type==="notices"');
      expect(html).toContain("loadNotices()");        // survives a refused /ws upgrade
      expect(html).toContain(".notice .x:focus-visible"); // DESIGN.md focus-ring rule
    } finally {
      server.stop(true);
    }
  });
});

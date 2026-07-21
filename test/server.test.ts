import { expect, test } from "bun:test";
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

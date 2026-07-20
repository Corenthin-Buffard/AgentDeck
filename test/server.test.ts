import { expect, test } from "bun:test";

// Regression for the embedded-dashboard serve (v0.1.3.0): the "/" route now
// returns the in-memory `indexHtml` string (baked in at build time), not
// `Bun.file(...)`. Compiling only proves the `with { type: "text" }` import
// bundles; this proves the route actually serves the dashboard at runtime.
test('GET "/" serves the embedded dashboard HTML', async () => {
  process.env.GORCH_PORT = "0"; // ephemeral port — don't collide with a running daemon
  const { startServer } = await import("../src/server.ts");
  const server = startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>gorch"); // non-empty + right file
  } finally {
    server.stop(true);
  }
});

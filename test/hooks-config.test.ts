import { expect, test, describe } from "bun:test";
import { hookSettings } from "../src/hooks-config.ts";

describe("hookSettings", () => {
  const s = hookSettings("http://127.0.0.1:8787", "tok-123");

  test("wires a Notification HTTP hook to the daemon (async, matches all)", () => {
    const grp = s.hooks.Notification[0];
    expect(grp.matcher).toBe("*");
    const h = grp.hooks[0] as Record<string, unknown>;
    expect(h.type).toBe("http");
    expect(h.url).toBe("http://127.0.0.1:8787/hooks/notification?token=tok-123");
    expect(h.async).toBe(true);
  });

  test("wires a PreToolUse hook matched on AskUserQuestion", () => {
    expect(s.hooks.PreToolUse[0].matcher).toContain("AskUserQuestion");
    const h = s.hooks.PreToolUse[0].hooks[0] as Record<string, unknown>;
    expect(h.url).toBe("http://127.0.0.1:8787/hooks/pre-tool-use?token=tok-123");
  });

  test("honors the given base url", () => {
    const h = hookSettings("http://example:9000", "t").hooks.Notification[0].hooks[0] as Record<string, unknown>;
    expect(h.url).toBe("http://example:9000/hooks/notification?token=t");
  });

  test("url-encodes the token so a weird secret can't break the URL", () => {
    const h = hookSettings("http://x", "a b/c?d&e").hooks.Notification[0].hooks[0] as Record<string, unknown>;
    expect(h.url).toBe("http://x/hooks/notification?token=a%20b%2Fc%3Fd%26e");
  });
});

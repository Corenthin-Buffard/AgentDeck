import { expect, test, describe } from "bun:test";
import { hookSettings } from "../src/hooks-config.ts";

describe("hookSettings", () => {
  const s = hookSettings("http://127.0.0.1:8787");

  test("wires a Notification HTTP hook to the daemon (async, matches all)", () => {
    const grp = s.hooks.Notification[0];
    expect(grp.matcher).toBe("*");
    const h = grp.hooks[0] as Record<string, unknown>;
    expect(h.type).toBe("http");
    expect(h.url).toBe("http://127.0.0.1:8787/hooks/notification");
    expect(h.async).toBe(true);
  });

  test("wires a PreToolUse hook matched on AskUserQuestion", () => {
    expect(s.hooks.PreToolUse[0].matcher).toContain("AskUserQuestion");
    const h = s.hooks.PreToolUse[0].hooks[0] as Record<string, unknown>;
    expect(h.url).toBe("http://127.0.0.1:8787/hooks/pre-tool-use");
  });

  test("honors the given base url", () => {
    const h = hookSettings("http://example:9000").hooks.Notification[0].hooks[0] as Record<string, unknown>;
    expect(h.url).toBe("http://example:9000/hooks/notification");
  });
});

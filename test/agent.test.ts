import { describe, expect, test } from "bun:test";
import { agentEnv, createStderrTail, exitReason } from "../src/agent.ts";

// Pure helpers extracted from the supervisor so the parts that decide whether an
// agent can start — and what the operator is told when it can't — are testable
// without spawning anything, and without actually being uid 0.

describe("agentEnv — the root bypass matrix", () => {
  const base = { PATH: "/usr/bin:/bin", HOME: "/root" } as NodeJS.ProcessEnv;

  test("uid 0 + opt-in → IS_SANDBOX=1 (lifts Claude Code's root guard)", () => {
    expect(agentEnv(base, true, 0).IS_SANDBOX).toBe("1");
  });

  test("uid 0 WITHOUT the opt-in → guard stays up", () => {
    // The whole point of the default: an operator who ran the daemon as root by
    // accident must see agents refuse, not silently get root agents.
    expect(agentEnv(base, false, 0).IS_SANDBOX).toBeUndefined();
  });

  test("non-root → nothing added, even with the opt-in set", () => {
    // No reason to relax a guard that was never going to engage.
    expect(agentEnv(base, true, 1000).IS_SANDBOX).toBeUndefined();
  });

  test("undefined uid (non-POSIX) → nothing added", () => {
    expect(agentEnv(base, true, undefined).IS_SANDBOX).toBeUndefined();
  });

  test("never mutates the caller's env, and PATH survives", () => {
    // Losing PATH would make the default claudeBin ("claude") unresolvable — the
    // agent would fail to spawn for a reason nothing in the message would explain.
    const out = agentEnv(base, true, 0);
    expect(base.IS_SANDBOX).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin:/bin");
    expect(out.HOME).toBe("/root");
  });
});

describe("exitReason", () => {
  // The reported symptom: an OOM-killed agent read as "agent exited (code null)".
  test("a signal is named, and never rendered as null", () => {
    const r = exitReason(null, "SIGKILL");
    expect(r).toBe("signal SIGKILL");
    expect(r).not.toContain("null");
  });

  test("a numeric exit code is reported as-is", () => {
    expect(exitReason(1, null)).toBe("code 1");
    expect(exitReason(0, null)).toBe("code 0");
  });

  test("signal wins when both are somehow present", () => {
    expect(exitReason(0, "SIGTERM")).toBe("signal SIGTERM");
  });

  test("neither → 'unknown', still never the string null", () => {
    expect(exitReason(null, null)).toBe("code unknown");
  });
});

describe("createStderrTail", () => {
  // Measured against the real failure: `claude -p` with stdin ignored emits
  // exactly this, 93 bytes, one line, no ANSI.
  const REFUSAL = "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons";

  test("the real root refusal survives whole", () => {
    const t = createStderrTail();
    t.push(REFUSAL + "\n");
    expect(t.excerpt()).toBe(REFUSAL);
  });

  test("keeps the TAIL, so a prepended warning can't hide the cause", () => {
    // Reproduced by giving claude a tty stdin: it prepends a stdin-timeout
    // warning and the real cause becomes line 2. A "first line" rule would have
    // shown the operator the warning and sent them after the wrong problem.
    const t = createStderrTail();
    t.push("Warning: no stdin data received in 3s, proceeding without it.\n");
    t.push(REFUSAL + "\n");
    expect(t.excerpt()).toContain("root/sudo privileges");
  });

  test("stays bounded well past its cap", () => {
    const t = createStderrTail(100);
    for (let i = 0; i < 500; i++) t.push("0123456789");
    expect(t.tail().length).toBeLessThanOrEqual(100);
  });

  test("a single oversized chunk is truncated, not buffered whole", () => {
    const t = createStderrTail(50);
    t.push("x".repeat(10_000) + "END");
    expect(t.tail().length).toBeLessThanOrEqual(50);
    expect(t.tail().endsWith("END")).toBe(true);
  });

  test("survives a message split across chunk boundaries", () => {
    const t = createStderrTail();
    t.push("--dangerously-skip-permissions cannot be used with ro");
    t.push("ot/sudo privileges for security reasons\n");
    expect(t.excerpt()).toBe(REFUSAL);
  });

  test("excerpt collapses newlines so a card's layout can't break", () => {
    const t = createStderrTail();
    t.push("first line\nsecond line\n\nthird line\n");
    const e = t.excerpt();
    expect(e).not.toContain("\n");
    expect(e).toBe("first line · second line · third line");
  });

  test("excerpt caps long output with an ellipsis", () => {
    const t = createStderrTail();
    t.push("y".repeat(1000));
    expect(t.excerpt().length).toBeLessThanOrEqual(300);
    expect(t.excerpt().endsWith("…")).toBe(true);
  });

  test("a clean exit with no stderr yields an empty excerpt", () => {
    // The exit handler appends ": <excerpt>" only when this is non-empty, so a
    // silent failure must not produce a trailing colon.
    const t = createStderrTail();
    expect(t.excerpt()).toBe("");
    t.push("   \n\n  ");
    expect(t.excerpt()).toBe("");
  });
});

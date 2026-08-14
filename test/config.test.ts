import { afterAll, expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { cmdField, config, isOptIn, loadProjects, parsePool, ROOT_BLOCKED_MESSAGE, rootBlocksAgents, rootWillBlockAgents } from "../src/config.ts";
import { resetNotices } from "../src/notices.ts";

// loadProjects MUST NOT throw — config.ts is imported everywhere, so a throw is a
// systemd crash-loop. Every bad input degrades to the synthesized `default`.
describe("loadProjects", () => {
  const REPO = "/some/repo/path";
  const defaultProject = { id: "default", path: REPO, label: basename(REPO) };

  function withDir(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-cfg-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("missing projects.json → synthesized default", () => {
    withDir((dir) => {
      expect(loadProjects(dir, REPO)).toEqual([defaultProject]);
    });
  });

  test("malformed JSON → default, never throws", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "projects.json"), "{ not json ]");
      expect(() => loadProjects(dir, REPO)).not.toThrow();
      expect(loadProjects(dir, REPO)).toEqual([defaultProject]);
    });
  });

  test("not an array → default", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "projects.json"), JSON.stringify({ id: "x", path: "/y" }));
      expect(loadProjects(dir, REPO)).toEqual([defaultProject]);
    });
  });

  test("empty array → default (never an empty registry)", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "projects.json"), "[]");
      expect(loadProjects(dir, REPO)).toEqual([defaultProject]);
    });
  });

  test("valid entries parse; label defaults to basename; missing path skipped", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "projects.json"), JSON.stringify([
        { id: "api", path: "/srv/api", label: "The API" },
        { id: "web", path: "/srv/web-frontend" },   // no label → basename
        { id: "bad" },                               // no path → skipped
      ]));
      const got = loadProjects(dir, REPO);
      expect(got).toEqual([
        { id: "api", path: "/srv/api", label: "The API" },
        { id: "web", path: "/srv/web-frontend", label: "web-frontend" },
      ]);
    });
  });

  test("ids with path separators or `..` are skipped (can't escape uploadsDir)", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "projects.json"), JSON.stringify([
        { id: "../evil", path: "/srv/a" },
        { id: "a/b", path: "/srv/b" },
        { id: "/tmp/out", path: "/srv/c" },
        { id: "ok", path: "/srv/d" },
      ]));
      expect(loadProjects(dir, REPO)).toEqual([{ id: "ok", path: "/srv/d", label: "d" }]);
    });
  });

  test("duplicate ids → first wins, no ambiguous routing", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "projects.json"), JSON.stringify([
        { id: "api", path: "/srv/api-one" },
        { id: "api", path: "/srv/api-two" },
      ]));
      const got = loadProjects(dir, REPO);
      expect(got).toEqual([{ id: "api", path: "/srv/api-one", label: "api-one" }]);
    });
  });
});

// AGENTDECK_ALLOW_ROOT gates whether agents get IS_SANDBOX=1 under uid 0, which
// relaxes a guard Claude Code put there on purpose. It must be opt-in in the
// strictest sense: `=== "true"`, not the `!== "false"` shape used by
// AGENTDECK_SKIP_PERMISSIONS, so a stray value never silently enables it.
describe("allowRoot opt-in coercion", () => {
  // These assert the REAL coercion src/config.ts uses. The previous version of this
  // block re-declared `v === "true"` inside the test and asserted that, so changing
  // config.ts to the looser `!== "false"` shape would have left all of them green —
  // on the one flag that hands root agents --dangerously-skip-permissions.
  afterAll(resetNotices);

  test("only the exact string 'true' opts in", () => {
    expect(isOptIn("true")).toBe(true);
  });

  test("unset stays off", () => {
    expect(isOptIn(undefined)).toBe(false);
  });

  test("truthy-looking values do NOT opt in", () => {
    for (const v of ["1", "yes", "TRUE", "True", "on", " true", "true ", ""]) {
      expect(isOptIn(v)).toBe(false);
    }
  });

  test("the resolved config used the same coercion", () => {
    // Pins the wiring, not just the helper: config.allowRoot must be a boolean
    // produced by isOptIn, and the suite's preload guarantees the env is unset.
    expect(typeof config.allowRoot).toBe("boolean");
    expect(config.allowRoot).toBe(isOptIn(process.env.AGENTDECK_ALLOW_ROOT));
  });
});

describe("rootWillBlockAgents", () => {
  // The single predicate behind BOTH the boot error notice and the POST /api/tasks
  // 400. Its own comment says the uid is injectable so it's testable without being
  // root — and nothing took that up until now. On a non-root CI runner the route
  // test can only ever assert the negative, so this is the only coverage of the
  // combination that actually refuses work.
  const flags = { skip: config.dangerouslySkipPermissions, allow: config.allowRoot };
  afterAll(() => {
    config.dangerouslySkipPermissions = flags.skip;
    config.allowRoot = flags.allow;
    resetNotices();
  });

  const cases: Array<[boolean, boolean, number | undefined, boolean, string]> = [
    [true,  false, 0,         true,  "root + skip-permissions + no opt-in → blocked"],
    [true,  true,  0,         false, "root + opt-in → allowed"],
    [false, false, 0,         false, "root without skip-permissions → allowed (files just end up root-owned)"],
    [true,  false, 1000,      false, "non-root → never blocked"],
    [true,  false, undefined, false, "no getuid (non-POSIX) → never blocked"],
  ];
  for (const [skip, allow, uid, want, name] of cases) {
    test(name, () => {
      config.dangerouslySkipPermissions = skip;
      config.allowRoot = allow;
      expect(rootBlocksAgents(uid)).toBe(want);
    });
  }

  test("the process-scoped wrapper agrees with the pure form", () => {
    config.dangerouslySkipPermissions = true;
    config.allowRoot = false;
    expect(rootWillBlockAgents()).toBe(rootBlocksAgents(process.getuid?.()));
  });

  test("the shared message names every way out", () => {
    // The banner, the boot log and the 400 body are all this one string.
    expect(ROOT_BLOCKED_MESSAGE).toContain("AGENTDECK_ALLOW_ROOT=true");
    expect(ROOT_BLOCKED_MESSAGE).toContain("AGENTDECK_SKIP_PERMISSIONS=false");
    expect(ROOT_BLOCKED_MESSAGE).toContain("unprivileged user");
  });

  test("it offers the real fix before the workarounds", () => {
    // Order is the point, not the presence: an operator reading a red banner acts
    // on the first remedy they see, and for two releases that was ALLOW_ROOT —
    // which keeps every agent running as root instead of removing the problem.
    const fix = ROOT_BLOCKED_MESSAGE.indexOf("unprivileged user");
    const skip = ROOT_BLOCKED_MESSAGE.indexOf("AGENTDECK_SKIP_PERMISSIONS=false");
    const allowRoot = ROOT_BLOCKED_MESSAGE.indexOf("AGENTDECK_ALLOW_ROOT=true");
    expect(fix).toBeLessThan(skip);
    expect(skip).toBeLessThan(allowRoot);
  });
});

// ── AGENTDECK_PIPELINE arms autonomous behaviour, so it is opt-IN ────────────
// The first version used `(env ?? "false") !== "false"`, copied from
// AGENTDECK_SKIP_PERMISSIONS — a flag that defaults ON, where that shape is
// right. Here it inverted the guard: "0", "off", "no", "FALSE" and an empty
// value (a bare `Environment=AGENTDECK_PIPELINE=` line) all resolved to TRUE,
// loadProjects builds entries field-by-field and drops unknown keys, so a new
// optional field has to be carried through explicitly or it vanishes silently —
// the button would just never appear, with nothing to grep for.
describe("loadProjects carries the preview commands through", () => {
  function withDir(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-cfg-pv-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("install and preview survive, in both shapes", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "projects.json"), JSON.stringify([
        { id: "a", path: "/a", install: "pnpm install", preview: "pnpm dev --port {port}" },
        { id: "b", path: "/b", preview: ["pnpm", "dev", "--define", "K=v w"] },
      ]));
      const [a, b] = loadProjects(dir, "/fallback");
      expect(a.install).toBe("pnpm install");
      expect(a.preview).toBe("pnpm dev --port {port}");
      expect(b.preview).toEqual(["pnpm", "dev", "--define", "K=v w"]);
      expect(b.install).toBeUndefined();
    });
  });

  test("a project without them is still valid — previews are simply unavailable", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "projects.json"), JSON.stringify([{ id: "a", path: "/a" }]));
      const [a] = loadProjects(dir, "/fallback");
      expect(a.id).toBe("a");
      expect(a.preview).toBeUndefined();
    });
  });

  // A bad command must not take the whole project down with it: the project keeps
  // working for agents, and only the preview button is unavailable.
  test("an invalid command is dropped but the project survives", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "projects.json"), JSON.stringify([{ id: "a", path: "/a", preview: 42 }]));
      const [a] = loadProjects(dir, "/fallback");
      expect(a.id).toBe("a");
      expect(a.preview).toBeUndefined();
    });
  });
});

// The preview port pool. parsePool MUST NOT throw for the same reason
// loadProjects must not: config.ts is imported everywhere, so a bad env value has
// to degrade to the default rather than crash-loop the daemon.
describe("parsePool", () => {
  const FALLBACK = [8788, 8789, 8790];

  test("a range expands inclusively", () => {
    expect(parsePool("8788-8790", FALLBACK)).toEqual([8788, 8789, 8790]);
    expect(parsePool("9000-9000", FALLBACK)).toEqual([9000]);
  });

  test("a comma list is taken verbatim, deduped", () => {
    expect(parsePool("8788,9100", FALLBACK)).toEqual([8788, 9100]);
    expect(parsePool("8788, 8788 ,9100", FALLBACK)).toEqual([8788, 9100]);
  });

  test("unset or blank → the default pool", () => {
    expect(parsePool(undefined, FALLBACK)).toEqual(FALLBACK);
    expect(parsePool("   ", FALLBACK)).toEqual(FALLBACK);
  });

  // Above 32767 collides with the kernel's ephemeral range (32768-60999), which
  // would produce a rare, unreproducible "the preview randomly won't start".
  test("ports inside the ephemeral range are refused", () => {
    expect(parsePool("40000-40002", FALLBACK)).toEqual(FALLBACK);
    expect(parsePool("8788,50000", FALLBACK)).toEqual(FALLBACK);
    expect(parsePool("32768", FALLBACK)).toEqual(FALLBACK);
    expect(parsePool("32767", FALLBACK)).toEqual([32767]); // the boundary is inclusive
  });

  test("privileged ports are refused", () => {
    expect(parsePool("80-82", FALLBACK)).toEqual(FALLBACK);
    expect(parsePool("1024", FALLBACK)).toEqual([1024]); // the boundary is inclusive
  });

  // `8788-9788` is a plausible typo and would claim 1001 ports, each of which
  // costs an ssh -L line and up to ~600MB of dev server.
  test("an implausibly large pool is refused", () => {
    expect(parsePool("8788-9788", FALLBACK)).toEqual(FALLBACK);
  });

  test("reversed bounds and junk are refused, never thrown", () => {
    expect(parsePool("8790-8788", FALLBACK)).toEqual(FALLBACK);
    expect(parsePool("not-a-port", FALLBACK)).toEqual(FALLBACK);
    expect(parsePool("8788-", FALLBACK)).toEqual(FALLBACK);
    expect(parsePool("-", FALLBACK)).toEqual(FALLBACK);
    expect(parsePool("8788;8789", FALLBACK)).toEqual(FALLBACK);
  });
});

// The array form of `install`/`preview` exists so an argument can contain a space.
// The string form splits on whitespace (the AGENTDECK_CLAUDE_ARGS convention),
// which would silently turn `--define "API=https://x/a b"` into four arguments.
describe("cmdField", () => {
  test("a non-empty string is kept", () => {
    expect(cmdField("p", "preview", "pnpm dev --port {port}")).toEqual({ preview: "pnpm dev --port {port}" });
  });

  test("an array of non-empty strings is kept verbatim", () => {
    const argv = ["pnpm", "dev", "--define", "API=https://x.test/a b"];
    expect(cmdField("p", "install", argv)).toEqual({ install: argv });
  });

  test("absent contributes nothing", () => {
    expect(cmdField("p", "preview", undefined)).toEqual({});
    expect(cmdField("p", "preview", null)).toEqual({});
  });

  // Dropped rather than kept: a half-valid command fails at spawn time, in a
  // worktree, minutes later — far from the typo that caused it.
  test("empty, wrong-typed and mixed values are dropped, never thrown", () => {
    for (const bad of ["", "   ", [], [""], ["ok", ""], ["ok", 3], 42, true, {}, [[]]]) {
      expect(cmdField("p", "preview", bad)).toEqual({});
    }
  });
});

// arming a pipeline whose last steps are `git push` and opening a PR.
describe("the pipeline opt-in", () => {
  test("only the exact string 'true' arms it", () => {
    expect(isOptIn("true")).toBe(true);
  });

  test("every value an operator would write to DISABLE it leaves it off", () => {
    for (const v of [undefined, "", "0", "off", "no", "false", "FALSE", "1", "yes", "TRUE"]) {
      expect(isOptIn(v)).toBe(false);
    }
  });
});

import { afterAll, expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { config, isOptIn, loadProjects, ROOT_BLOCKED_MESSAGE, rootBlocksAgents, rootWillBlockAgents } from "../src/config.ts";
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

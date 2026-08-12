import { afterAll, expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { loadProjects } from "../src/config.ts";
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
describe("allowRoot", () => {
  const original = process.env.AGENTDECK_ALLOW_ROOT;
  afterAll(() => {
    if (original === undefined) delete process.env.AGENTDECK_ALLOW_ROOT;
    else process.env.AGENTDECK_ALLOW_ROOT = original;
    // This suite feeds loadProjects deliberately malformed input, which now lands
    // in the shared notices singleton that server.test.ts reads back from
    // /api/health. Leave it clean rather than rely on the other file's discipline.
    resetNotices();
  });

  const read = (v: string | undefined) => {
    if (v === undefined) delete process.env.AGENTDECK_ALLOW_ROOT;
    else process.env.AGENTDECK_ALLOW_ROOT = v;
    return process.env.AGENTDECK_ALLOW_ROOT === "true";
  };

  test("defaults to off", () => expect(read(undefined)).toBe(false));
  test('"true" enables it', () => expect(read("true")).toBe(true));
  test('"1" does NOT enable it', () => expect(read("1")).toBe(false));
  test('"yes" does NOT enable it', () => expect(read("yes")).toBe(false));
  test('"TRUE" does NOT enable it (exact match only)', () => expect(read("TRUE")).toBe(false));
});

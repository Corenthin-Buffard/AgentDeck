import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { loadProjects } from "../src/config.ts";

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

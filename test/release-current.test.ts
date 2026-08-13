import { expect, test, describe } from "bun:test";
import { join } from "node:path";

// The release-drift guard, driven through its real subprocess — same seam as
// test/agent-spawn.test.ts, which runs a fake `claude` rather than mocking the
// spawn. The point of extracting this out of ci.yml was that a main-only CI job
// is unexercisable by any pull request: without these, the four branches would
// ship having never run anywhere but in one manual replay.
const SCRIPT = join(import.meta.dir, "..", "scripts", "check-release-current.sh");

function check(args: string[]) {
  const r = Bun.spawnSync(["bash", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

describe("check-release-current", () => {
  test("published release equals VERSION → current", () => {
    const { code, out } = check(["--version", "1.2.3.4", "--published", "v1.2.3.4"]);
    expect(code).toBe(0);
    expect(out).toContain("current");
  });

  test("drift younger than the window says nothing alarming", () => {
    // The normal state between merging a bump and pushing the tag. Turning main
    // red here on every release cycle is what teaches people to ignore red.
    const { code, out } = check([
      "--version", "1.2.3.4", "--published", "v1.2.3.3", "--released-days-ago", "1", "--max-age-days", "3",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("grace window");
  });

  test("drift PAST the window fails, and hands over the exact command", () => {
    // The case that carries the whole feature. A guard that never goes red
    // guards nothing — this repo has caught three inert tests already.
    const { code, out } = check([
      "--version", "1.2.3.4", "--published", "v1.2.3.3", "--released-days-ago", "5", "--max-age-days", "3",
    ]);
    expect(code).toBe(1);
    expect(out).toContain("git tag v1.2.3.4 && git push origin v1.2.3.4");
  });

  test("no release at all, past the window, still fails", () => {
    const { code, out } = check([
      "--version", "1.2.3.4", "--published", "none", "--released-days-ago", "9", "--max-age-days", "3",
    ]);
    expect(code).toBe(1);
    expect(out).toContain("none");
  });

  test("an unreachable API concludes NOTHING", () => {
    // A rate-limited or down API must never read as "you forgot to release":
    // that would send the operator to tag a version already published. Age is
    // deliberately past the window here — `unknown` must win over it.
    const { code, out } = check([
      "--version", "1.2.3.4", "--published", "unknown", "--released-days-ago", "99", "--max-age-days", "3",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("not concluding");
  });
});

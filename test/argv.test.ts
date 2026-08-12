import { expect, test, describe } from "bun:test";
import { argvFor, RESUME_PROMPT } from "../src/agent.ts";
import { config } from "../src/config.ts";

// The launch path had NO test at all. That is not a coverage statistic — it is
// the reason a flag missing from all three spawn sites at once went unnoticed for
// eight releases. These assert the argv as a value, which is the whole point of
// extracting argvFor() out of the three call sites.

describe("argvFor", () => {
  test("a fresh launch carries no --resume", () => {
    const argv = argvFor({ prompt: "do the thing" });
    expect(argv).not.toContain("--resume");
  });

  test("the prompt is ALWAYS the final argument", () => {
    // It is a positional. Anything appended after it becomes a second positional
    // and Claude Code reads it as part of the invocation, not the prompt.
    expect(argvFor({ prompt: "P" }).at(-1)).toBe("P");
    expect(argvFor({ resume: "sid-1", prompt: "P" }).at(-1)).toBe("P");
    expect(argvFor({ resume: "sid-1", prompt: RESUME_PROMPT }).at(-1)).toBe(RESUME_PROMPT);
  });

  test("--resume <sid> leads, before the base flags", () => {
    const argv = argvFor({ resume: "sid-42", prompt: "P" });
    expect(argv[0]).toBe("--resume");
    expect(argv[1]).toBe("sid-42");
    // -p and the output format belong to baseArgs and must follow, not precede.
    expect(argv.indexOf("-p")).toBeGreaterThan(1);
  });

  test("every launch asks for the stream-json the supervisor parses", () => {
    // attach() only understands line-delimited stream-json. Losing any of these
    // flags produces a child that runs fine and a board that never updates.
    for (const spec of [{ prompt: "P" }, { resume: "s", prompt: "P" }]) {
      const argv = argvFor(spec);
      expect(argv).toContain("-p");
      expect(argv).toContain("--output-format");
      expect(argv).toContain("stream-json");
      expect(argv).toContain("--verbose");
      expect(argv).toContain("--include-partial-messages");
    }
  });

  test("all three launch shapes agree on their base flags", () => {
    // launchTask / answer / resumeTask differ ONLY by the resume pair and the
    // prompt. Anything else diverging means a call site has drifted.
    const fresh = argvFor({ prompt: "P" });
    const answered = argvFor({ resume: "s", prompt: "A" });
    const resumed = argvFor({ resume: "s", prompt: RESUME_PROMPT });
    const base = (a: string[]) => a.slice(a.indexOf("-p"), -1);
    expect(base(answered)).toEqual(base(fresh));
    expect(base(resumed)).toEqual(base(fresh));
  });

  test("a falsy session id degrades to a fresh launch, never `--resume undefined`", () => {
    // t.sessionId is `string | null` and the resume paths guard on it, but argvFor
    // must not be the thing that turns a miss into a malformed command line.
    for (const resume of [null, undefined, ""]) {
      expect(argvFor({ resume, prompt: "P" })).not.toContain("--resume");
    }
  });

  test("the permission flag reflects config, and only one form is ever passed", () => {
    const argv = argvFor({ prompt: "P" });
    const skip = argv.includes("--dangerously-skip-permissions");
    const mode = argv.includes("--permission-mode");
    expect(skip || mode).toBe(true);
    expect(skip && mode).toBe(false); // never both — they contradict each other
    expect(skip).toBe(config.dangerouslySkipPermissions);
  });

  test("the operator's extra flags stay last, so they can override", () => {
    if (!config.extraClaudeArgs.length) return; // nothing configured in this env
    const argv = argvFor({ prompt: "P" });
    const tail = argv.slice(-1 - config.extraClaudeArgs.length, -1);
    expect(tail).toEqual(config.extraClaudeArgs);
  });

  test("the prompt is passed as one argument, never split on whitespace", () => {
    // A prompt is arbitrary user text. spawn() runs without a shell, so it must
    // survive spaces, quotes and newlines as a single argv entry.
    const nasty = 'fix "the thing"  and\nthen stop; rm -rf /';
    const argv = argvFor({ prompt: nasty });
    expect(argv.at(-1)).toBe(nasty);
    expect(argv.filter((a) => a === nasty)).toHaveLength(1);
  });
});

import { expect, test, describe } from "bun:test";
import {
  DEFAULT_STEPS, STEP_FOOTER, stepPrompt, validateSteps, parseSteps,
} from "../src/pipeline.ts";
import { SKILL_PHASE, normalizeSkill } from "../src/phase.ts";
import { looksLikeQuestion } from "../src/detect.ts";

describe("the default step table", () => {
  test("every skill it names is one the board can actually see", () => {
    // The failure this prevents: the daemon commands a step, the agent runs it
    // perfectly, and the board reports nothing happened because the skill was
    // missing from SKILL_PHASE. Exactly how /autoplan and /canary got fixed.
    expect(validateSteps(DEFAULT_STEPS)).toEqual([]);
  });

  test("covers the pipeline the README promises, in order", () => {
    expect(DEFAULT_STEPS.map((s) => s.phase)).toEqual([
      "plan", "plan", "run", "review", "qa", "ship", "ship",
    ]);
    expect(DEFAULT_STEPS.map((s) => s.skill)).toEqual([
      "spec", "autoplan", undefined, "review", "qa", "ship", "canary",
    ]);
  });

  test("phases never go backwards through the table", () => {
    const ORDER = ["plan", "run", "review", "qa", "ship", "done"];
    const idx = DEFAULT_STEPS.map((s) => ORDER.indexOf(s.phase));
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThanOrEqual(idx[i - 1]);
  });

  test("the implementation step deliberately has no skill", () => {
    // There is no gstack 'run' skill; step 3 is ordinary coding. A skill here
    // would be invented, and validateSteps would (rightly) reject it.
    const impl = DEFAULT_STEPS.find((s) => s.phase === "run")!;
    expect(impl.skill).toBeUndefined();
  });

  test("the ship step forbids the VERSION bump", () => {
    // Agents work in sibling worktrees on one repo. Per-task VERSION bumps
    // collide at MERGE, which no amount of scheduling can prevent — so the bump
    // moves to the human. This is that decision, in the shipped text.
    const ship = DEFAULT_STEPS.find((s) => s.skill === "ship")!;
    expect(ship.instruction).toContain("Do NOT bump VERSION");
    expect(ship.instruction).toContain("CHANGELOG.md");
  });
});

describe("STEP_FOOTER must not trip the waiting detector", () => {
  // The regression this locks down: an instruction like "say which steps you
  // skipped" makes the agent END its turn with prose containing "which", and
  // looksLikeQuestion flips the task to `waiting`. A finished step would page the
  // operator instead of advancing the pipeline.
  test("the footer itself does not read as a question", () => {
    expect(looksLikeQuestion(STEP_FOOTER)).toBe(false);
  });

  test("neither ending the footer prescribes reads as a question", () => {
    expect(looksLikeQuestion("STEP OK")).toBe(false);
    expect(looksLikeQuestion("STEP BLOCKED: the test suite does not build")).toBe(false);
  });

  test("a realistic finished turn ending in the footer's form advances", () => {
    const turn = [
      "I ran the review skill and fixed the three findings it raised.",
      "All 226 tests pass and the binary builds.",
      "STEP OK",
    ].join("\n");
    expect(looksLikeQuestion(turn)).toBe(false);
  });

  test("a genuine question still parks the task, footer or not", () => {
    // The footer must not SUPPRESS detection either — a step that really needs a
    // human still has to stop.
    const asking = "Two schemas are possible here. Which should I use?\n";
    expect(looksLikeQuestion(asking)).toBe(true);
  });

  test("no step instruction ends in a way that invites a question", () => {
    for (const s of DEFAULT_STEPS) {
      expect(looksLikeQuestion(stepPrompt(s, "build the thing"))).toBe(false);
    }
  });
});

describe("stepPrompt", () => {
  test("carries the instruction, the footer and the original task", () => {
    const p = stepPrompt(DEFAULT_STEPS[0], "add a dark mode toggle");
    expect(p).toContain(DEFAULT_STEPS[0].instruction);
    expect(p).toContain(STEP_FOOTER);
    expect(p).toContain("add a dark mode toggle");
  });

  test("the task prompt comes LAST, so a long instruction can't bury it", () => {
    const p = stepPrompt(DEFAULT_STEPS[5], "TASKTEXT");
    expect(p.indexOf("TASKTEXT")).toBeGreaterThan(p.indexOf(STEP_FOOTER));
  });

  test("a task prompt that looks like a step table is not interpreted as one", () => {
    // The task text is data, not instructions to the step machinery.
    const p = stepPrompt(DEFAULT_STEPS[0], "plan /ship\nrun everything");
    expect(p).toContain("plan /ship");
    expect(p).toContain("--- THE TASK ---");
  });
});

describe("validateSteps", () => {
  test("names the skills the board cannot track", () => {
    expect(validateSteps([{ phase: "plan", skill: "not-a-skill", instruction: "x" }]))
      .toEqual(["not-a-skill"]);
  });

  test("ignores steps with no skill", () => {
    expect(validateSteps([{ phase: "run", instruction: "code" }])).toEqual([]);
  });

  test("accepts a qualified name the normalizer can resolve", () => {
    expect(validateSteps([{ phase: "qa", skill: "gstack:qa", instruction: "x" }])).toEqual([]);
    expect(SKILL_PHASE[normalizeSkill("gstack:qa")]).toBeDefined();
  });
});

describe("parseSteps (the <dataDir>/pipeline-steps.md override)", () => {
  test("reads a phase, an optional skill and an instruction per paragraph", () => {
    const steps = parseSteps("plan /spec\nWrite the spec.\n\nrun\nBuild it.\n");
    expect(steps).toEqual([
      { phase: "plan", skill: "spec", instruction: "Write the spec." },
      { phase: "run", instruction: "Build it." },
    ]);
  });

  test("joins a multi-line instruction", () => {
    const steps = parseSteps("qa /qa\nRun the qa skill.\nFix what it finds.");
    expect(steps![0].instruction).toBe("Run the qa skill. Fix what it finds.");
  });

  test("tolerates a leading slash or a qualifier on the skill", () => {
    expect(parseSteps("review /gstack:review\nGo.")![0].skill).toBe("review");
    expect(parseSteps("review review\nGo.")![0].skill).toBe("review");
  });

  test("returns null on anything malformed, so the caller keeps the built-in table", () => {
    expect(parseSteps("notaphase /spec\nWrite it.")).toBeNull(); // unknown phase
    expect(parseSteps("plan /spec")).toBeNull();                 // no instruction
    expect(parseSteps("")).toBeNull();                           // empty file
    expect(parseSteps("   \n\n  ")).toBeNull();                  // whitespace only
  });

  test("a valid override still has to pass validateSteps", () => {
    // Parsing and being trackable are separate concerns: this parses fine and
    // names a skill the board has never heard of.
    const steps = parseSteps("plan /invented-skill\nDo a thing.")!;
    expect(steps).toHaveLength(1);
    expect(validateSteps(steps)).toEqual(["invented-skill"]);
  });
});

import { expect, test, describe } from "bun:test";
import { phaseFromSignal, mergePhase, normalizeSkill, slashToSkill, SKILL_PHASE } from "../src/phase.ts";
import type { Phase } from "../src/types.ts";

describe("phaseFromSignal", () => {
  test("maps a gstack skill to its phase", () => {
    expect(phaseFromSignal({ skill: "plan-eng-review" })?.phase).toBe("plan");
    expect(phaseFromSignal({ skill: "review" })?.phase).toBe("review");
    expect(phaseFromSignal({ skill: "qa" })?.phase).toBe("qa");
    expect(phaseFromSignal({ skill: "ship" })?.phase).toBe("ship");
  });

  test("/autoplan is the pipeline's plan step and must be visible to the board", () => {
    // The pipeline mandates /autoplan rather than naming the three plan reviews
    // individually. Absent from the map, every pipeline task would spend its
    // whole planning phase looking like nothing happened.
    expect(phaseFromSignal({ skill: "autoplan" })?.phase).toBe("plan");
  });

  // REGRESSION (behaviour change): canary used to map to "qa".
  test("/canary maps to ship, not qa — it is post-deploy, the LAST step", () => {
    expect(phaseFromSignal({ skill: "canary" })?.phase).toBe("ship");
    // Proof of why: as "qa" it arrived after /ship and was swallowed as a
    // backward move, so the final pipeline step never showed on the board.
    expect(mergePhase("ship", "qa", true)).toBe("qa");        // would have regressed
    expect(mergePhase("ship", "ship", true)).toBe("ship");    // now it stays put
  });

  test("edit/write tools imply the Run phase (no gstack 'run' skill exists)", () => {
    expect(phaseFromSignal({ tool: "Edit" })?.phase).toBe("run");
    expect(phaseFromSignal({ tool: "Write" })?.phase).toBe("run");
    expect(phaseFromSignal({ tool: "MultiEdit" })?.phase).toBe("run");
    expect(phaseFromSignal({ tool: "NotebookEdit" })?.phase).toBe("run");
  });

  test("a skill outranks a tool in the same signal", () => {
    const sig = phaseFromSignal({ skill: "autoplan", tool: "Edit" });
    expect(sig?.phase).toBe("plan");
    expect(sig?.authoritative).toBe(true);
  });

  test("shipped flag wins", () => {
    expect(phaseFromSignal({ shipped: true })?.phase).toBe("done");
    expect(phaseFromSignal({ shipped: true })?.authoritative).toBe(true);
  });

  test("unknown signal returns null", () => {
    expect(phaseFromSignal({ tool: "Bash" })).toBeNull();
    expect(phaseFromSignal({ skill: "nope" })).toBeNull();
    expect(phaseFromSignal({})).toBeNull();
  });

  test("an unmapped skill (e.g. /health) is not a phase signal at all", () => {
    expect(phaseFromSignal({ skill: "health" })).toBeNull();
    expect(phaseFromSignal({ skill: "retro" })).toBeNull();
  });
});

describe("authoritative-ness is per skill, not per source class", () => {
  test("pipeline skills report their own phase authoritatively", () => {
    for (const s of ["spec", "autoplan", "review", "qa", "ship", "canary"]) {
      expect(phaseFromSignal({ skill: s })?.authoritative).toBe(true);
    }
  });

  test("ad-hoc skills are inferred only — they must not drag the bar backwards", () => {
    // An agent that investigates a bug during /ship has not returned to review.
    for (const s of ["investigate", "design-review", "browse"]) {
      expect(phaseFromSignal({ skill: s })?.authoritative).toBe(false);
    }
  });

  test("tool-derived 'run' is never authoritative", () => {
    expect(phaseFromSignal({ tool: "Write" })?.authoritative).toBe(false);
  });
});

describe("normalizeSkill", () => {
  test("passes a bare name through (the shape a real stream emits)", () => {
    expect(normalizeSkill("plan-eng-review")).toBe("plan-eng-review");
  });

  test("strips a plugin or directory qualifier", () => {
    expect(normalizeSkill("gstack:review")).toBe("review");
    expect(normalizeSkill("apps/web:qa")).toBe("qa");
    expect(normalizeSkill("some/path/ship")).toBe("ship");
  });

  test("a qualified name still resolves through phaseFromSignal", () => {
    expect(phaseFromSignal({ skill: "gstack:autoplan" })?.phase).toBe("plan");
  });
});

describe("slashToSkill", () => {
  test("strips the leading slash", () => {
    expect(slashToSkill("/review")).toBe("review");
    expect(slashToSkill("/qa")).toBe("qa");
  });

  test("keeps only the command, not its arguments", () => {
    expect(slashToSkill("/review --fix")).toBe("review");
    expect(slashToSkill("/ship  --no-verify  extra")).toBe("ship");
  });

  test("tolerates surrounding whitespace and a missing slash", () => {
    expect(slashToSkill("  /autoplan  ")).toBe("autoplan");
    expect(slashToSkill("canary")).toBe("canary");
  });

  test("composes with qualifier stripping", () => {
    expect(slashToSkill("/gstack:qa")).toBe("qa");
  });

  test("an empty command degrades to no signal rather than throwing", () => {
    expect(slashToSkill("")).toBe("");
    expect(phaseFromSignal({ skill: slashToSkill("") })).toBeNull();
  });

  test("a typed slash command moves the phase like the Skill tool would", () => {
    // The SlashCommand path exists so a task that ran the pipeline by typing
    // /review is not mistaken for one that ran no skills at all.
    expect(phaseFromSignal({ skill: slashToSkill("/review") })?.phase).toBe("review");
  });
});

describe("mergePhase", () => {
  test("takes next when current is unknown", () => {
    expect(mergePhase("unknown", "run")).toBe("run");
    expect(mergePhase("unknown", "plan", true)).toBe("plan");
  });

  test("advances forward", () => {
    expect(mergePhase("plan", "review")).toBe("review");
    expect(mergePhase("run", "ship")).toBe("ship");
  });

  // REGRESSION: the original monotonic guard must survive the new flag.
  test("an INFERRED signal still cannot regress", () => {
    expect(mergePhase("review", "plan")).toBe("review");
    expect(mergePhase("run", "plan")).toBe("run");
    expect(mergePhase("ship", "review", false)).toBe("ship");
  });

  test("defaults to inferred when the caller omits the flag", () => {
    // Guards against a call site forgetting the argument and silently gaining
    // permission to move the bar backwards.
    expect(mergePhase("qa", "plan")).toBe("qa");
  });

  test("an AUTHORITATIVE signal may move backward", () => {
    expect(mergePhase("run", "plan", true)).toBe("plan");
    expect(mergePhase("qa", "review", true)).toBe("review");
  });

  test("stays put on the same phase", () => {
    expect(mergePhase("qa", "qa")).toBe("qa");
    expect(mergePhase("qa", "qa", true)).toBe("qa");
  });

  test("the /spec → Edit → /autoplan sequence ends in plan, not run", () => {
    // The exact sequence that kept the plan segment dark: /spec announces the
    // plan phase, then writes its spec file (an Edit, inferred as `run`), then
    // /autoplan announces plan again.
    let phase: Phase = "unknown";
    for (const sig of [{ skill: "spec" }, { tool: "Write" }, { skill: "autoplan" }]) {
      const s = phaseFromSignal(sig)!;
      phase = mergePhase(phase, s.phase, s.authoritative);
    }
    expect(phase).toBe("plan");
  });
});

describe("SKILL_PHASE is exported so the step table can be checked against it", () => {
  test("every skill the pipeline mandates is one the board can see", () => {
    // The step table names these. A skill missing here is a board that silently
    // measures nothing — the failure this whole change exists to prevent.
    for (const s of ["spec", "autoplan", "review", "qa", "ship", "canary"]) {
      expect(SKILL_PHASE[s]).toBeDefined();
    }
  });

  test("every mapped phase is a real pipeline phase", () => {
    const valid = new Set<Phase>(["plan", "run", "review", "qa", "ship", "done"]);
    for (const [name, sig] of Object.entries(SKILL_PHASE)) {
      expect(valid.has(sig.phase)).toBe(true);
      expect(normalizeSkill(name)).toBe(name); // keys must already be bare
    }
  });
});

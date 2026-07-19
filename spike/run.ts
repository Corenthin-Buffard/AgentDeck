// gorch spike T1 — the make-or-break instrument (v2, resume-per-turn).
//
// EMPIRICAL FINDINGS from v1 (kept here so we don't relearn them):
//   1. In headless `claude -p`, the AskUserQuestion TOOL is NOT available.
//      The agent falls back to asking in plain PROSE. → Branch P is the only path.
//   2. A headless turn ENDS (emits `result`) after the agent asks. The process
//      does not sit on stdin waiting. So "injecting an answer" = starting a NEW
//      turn with `claude --resume <sessionId> -p "<answer>"`.
//
// THE MECHANIC THIS PROVES (and recommends for gorch):
//   answer  == `claude --resume <sid> -p "<answer>"`      (human-in-loop)
//   durability(A2) == `claude --resume <sid> -p "continue"` after daemon restart
//   → injection and A2 are THE SAME operation. The daemon only stores sessionIds.
//
//   run:  bun run spike/run.ts
//         bun run spike/run.ts --gstack        (drive a real gstack skill)
//         bun run spike/run.ts "custom prompt that makes it ask + stop"

import { spawn } from "node:child_process";

const useGstack = process.argv.includes("--gstack");
const custom = process.argv.slice(2).filter((a) => a !== "--gstack").join(" ");
const DEFAULT_PROMPT =
  "Ask me exactly one question — which color to paint the bikeshed: blue, green, or red — " +
  "then STOP and wait for my reply. Do not choose for me.";
const GSTACK_PROMPT =
  "Run the /office-hours skill. Stop at its first question and wait for my answer.";
const PROMPT = custom || (useGstack ? GSTACK_PROMPT : DEFAULT_PROMPT);
const ANSWER = "blue";

const baseOut = ["--output-format", "stream-json", "--verbose", "--include-partial-messages"];
// A1b launch config: an unattended orchestrator must skip permission prompts so
// gstack's tools (Bash, Skill, ...) run without blocking. Mirrors AgentDeck's
// GORCH_PERMISSION_MODE. Only for the gstack test — the plain prose test needs
// no extra perms. MUST run in a plain shell on the VPS, NOT nested inside an
// interactive Claude Code session (that sandbox blocks skill/filesystem access).
const PERM = useGstack ? ["--dangerously-skip-permissions"] : [];

type Turn = { sessionId: string | null; text: string; subtype: string; tools: string[]; auqAvailable: boolean };

function runClaude(args: string[]): Promise<Turn> {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "inherit"] });
    let sessionId: string | null = null, text = "", subtype = "", buf = "", auqAvailable = false;
    const tools: string[] = [];
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let e: any; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "system" && e.subtype === "init") {
          sessionId = e.session_id;
          auqAvailable = (e.tools ?? []).some((t: string) => /AskUserQuestion/.test(t));
        }
        if (e.type === "stream_event" && e.event?.type === "content_block_start"
            && e.event.content_block?.type === "tool_use") tools.push(e.event.content_block.name);
        if (e.type === "stream_event" && e.event?.type === "content_block_delta"
            && e.event.delta?.type === "text_delta") { text += e.event.delta.text; process.stdout.write(e.event.delta.text); }
        if (e.type === "assistant" && Array.isArray(e.message?.content))
          for (const c of e.message.content) if (c.type === "text") text += c.text;
        if (e.type === "result") { subtype = e.subtype ?? ""; if (e.result && !text) text = e.result; }
      }
    });
    child.on("exit", () => resolve({ sessionId, text, subtype, tools, auqAvailable }));
  });
}

console.log(`\n╭─ gorch spike T1 (v2) ${"─".repeat(45)}`);
console.log(`│ mode: ${useGstack ? "gstack skill" : "plain prose question"}`);
console.log(`╰${"─".repeat(66)}\n─ turn 1: agent asks ─\n`);

const t1 = await runClaude(["-p", ...baseOut, ...PERM, PROMPT]);
console.log(`\n\n[turn1] session=${t1.sessionId}  subtype=${t1.subtype}  AUQ-tool-available=${t1.auqAvailable}  tools=[${t1.tools.join(",")}]`);

if (!t1.sessionId) {
  console.log("\n❌ no session id — is `claude` authenticated? (run `claude` once interactively)");
  process.exit(1);
}

const askedInProse = /\?/.test(t1.text) && t1.subtype === "success";
console.log(`\n─ turn 2: gorch injects the human answer via --resume ("${ANSWER}") ─\n`);
const t2 = await runClaude(["--resume", t1.sessionId, "-p", ...baseOut, ...PERM, `My answer: ${ANSWER}`]);

const continued = t2.subtype === "success" && t2.text.trim().length > 0;
const acknowledged = new RegExp(ANSWER, "i").test(t2.text);
// Guard against a FALSE GREEN: if the target skill errored / never launched,
// the "question" is the agent reporting a blocker, not the skill asking.
const blocked = /\b(skill.*error|error.*skill|never (actually )?launched|can'?t (execute|reach|run)|blocker|locked down)\b/i.test(t1.text);

console.log(`\n\n╭─ A1 VERDICT ${"─".repeat(53)}`);
console.log(`│ headless AUQ tool available:   ${t1.auqAvailable ? "yes" : "NO (prose fallback path)"}`);
console.log(`│ agent asked & waited (turn 1): ${askedInProse ? "yes (prose)" : "unclear — inspect above"}`);
console.log(`│ resume accepted the answer:    ${continued ? "yes" : "NO"}`);
console.log(`│ agent acted on "${ANSWER}":         ${acknowledged ? "yes" : "no"}`);
console.log(`│ skill launched cleanly:        ${blocked ? "NO — agent reported a blocker" : (useGstack ? "yes" : "n/a (plain mode)")}`);
console.log(`│`);
if (blocked) {
  console.log(`│ ⛔ INCONCLUSIVE — the target skill never launched (skill/plugin`);
  console.log(`│    resolution or filesystem/permission scope blocked it). The prose`);
  console.log(`│    "question" is the agent flagging that blocker, NOT the skill asking.`);
  console.log(`│    Fix the launch config (skills in scope + permission mode + trusted`);
  console.log(`│    dirs), then re-run. Do NOT read this as A1 proven.`);
} else if (askedInProse && continued && acknowledged) {
  console.log(`│ ✅ A1 HOLDS via PROSE + RESUME — this is the V1 mechanic.`);
  console.log(`│    gorch drives the agent, reads the prose question, notifies you,`);
  console.log(`│    and injects your answer as \`claude --resume <sid> -p\`.`);
} else {
  console.log(`│ ⚠️  partial — read the streams above. If turn 2 ignored the answer,`);
  console.log(`│    the resume path needs adjusting before building.`);
}
console.log(`╰${"─".repeat(66)}\n`);

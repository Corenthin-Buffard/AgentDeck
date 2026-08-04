// Pure detection helpers for headless-agent output. No side-effect imports, so
// these are unit-testable in isolation (see test/detect.test.ts).

// `askuserquestion unavailable` catches gstack's headless BLOCK message — if a skill
// ever emits "BLOCKED — AskUserQuestion unavailable" instead of a prose brief, that's
// still an agent needing a human, not a finished task. (Defense in depth.)
const QUESTION_CUES =
  /\b(which|choose|should i|do you want|would you like|option|let me know|please (confirm|pick|reply)|reply with|waiting for your (answer|reply)|proceed\?)\b|askuserquestion unavailable/i;

// gstack renders an unanswered decision as a labeled "decision brief" and ends the
// turn. A heavy skill (e.g. /plan-eng-review) can emit a long turn that ENDS on such
// a brief — past the 500-char cue window and often on a `Net:` line with no cue word
// — which would strand the agent as `done`. So detect the brief STRUCTURE over a
// wider (2000-char) tail. Key off the brief's BOTTOM markers, which always land in
// the tail: a `Net:` / `Completeness:` line or a `D<n> —` header (incl. split-chain
// `D<n>.final` / `D<n>.revise-k`), plus ≥2 labeled options. Deliberately NOT keyed off
// `Recommendation:` — that also appears in a finished review's summary (false positive).
//
// OPTION_LABEL: a labeled option at a line start, after a list bullet, and/or
//   bold-wrapped (split chains render buckets `**A) Include**, **B) Defer**`). Used
//   only with `.match()`, so the `g` flag carries no lastIndex state across calls.
// EXPLICIT_ASK / BRIEF_MARKER: non-global (no lastIndex state). EXPLICIT_ASK omits a
//   bare `[A-D]` option letter on purpose — it would match the article "a" in "reply
//   with a plan"; a real "reply with A, B, or C" is caught by QUESTION_CUES / options.
const EXPLICIT_ASK =
  /reply with (?:a |the |your )?(?:letter|pick)\b|\bfor your picks?\b|\byour picks? (?:above|below)\b|\bpicks? (?:below|above)\b/i;
const OPTION_LABEL = /(?:^|\n|\*\*)\s*(?:[-*+]\s+)?(?:\*\*)?[A-D]\s?[).]\s/gm;
const BRIEF_MARKER =
  /(?:^|\n)\s*(?:Net|Completeness):|(?:^|\n|\*\*)\s*D\d+(?:\.[\w-]+)?\s*[—–-]/i;

function looksLikeDecisionBrief(wideTail: string): boolean {
  if (EXPLICIT_ASK.test(wideTail)) return true;
  const options = wideTail.match(OPTION_LABEL)?.length ?? 0;
  return options >= 2 && BRIEF_MARKER.test(wideTail);
}

/**
 * Did the agent stop to ask the human something (prose), vs finish the task?
 * Headless mode has no structured AskUserQuestion, so gstack asks in prose and
 * ends the turn — this decides `waiting` vs `done`.
 *
 * Two windows: the narrow 500-char tail catches a plain trailing question, and a
 * wider 2000-char tail catches gstack's structured decision briefs (whose "ask"
 * sits at the bottom of a long review). Conservative on the narrow check (a
 * mid-answer `?` must not trip it); structural on the wide check (Net:/Completeness:
 * + options don't co-occur in a completion statement). Biased toward `waiting` on
 * an ambiguous brief — stranding a waiting agent as `done` is the worse failure.
 */
export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const tail = trimmed.slice(-500);
  if (/\?\s*$/.test(tail) || QUESTION_CUES.test(tail)) return true;
  return looksLikeDecisionBrief(trimmed.slice(-2000));
}

// ── Brief EXTRACTION (the dashboard's reply drawer) ────────────────────────
// Detection above answers "is this an ask?". This answers "what were the
// choices?", so the drawer can offer them as buttons instead of making the
// operator retype a letter off a wall of prose.
//
// This parses PROSE, so it will occasionally be wrong. The UI is built around
// that: a parsed option only PRE-FILLS the reply box, the original brief stays
// on screen, and nothing is sent until the operator presses Send. A mis-parse is
// therefore visible and free — which is the only reason parsing prose is an
// acceptable input to a control surface that drives --dangerously-skip-permissions
// agents. Do not turn these into one-click send.

export interface BriefOption { letter: string; label: string; recommended: boolean }
export interface DecisionBrief { options: BriefOption[] }

const RECOMMENDED_TAG = /\s*\((?:recommended|recommand[ée]e?)\)\s*/i;
// A `Recommendation:` line that names a bare letter. Only a letter counts — the
// canonical form is `Recommendation: <choice> because <reason>`, where <choice>
// is often a label, and guessing which option a label refers to would be exactly
// the kind of clever-but-wrong the mis-parse rule above is written against.
const RECOMMENDATION_LETTER = /(?:^|\n)\s*Recommendation:\s*(?:option\s+)?([A-H])\b/i;

function addOption(map: Map<string, BriefOption>, letter: string, raw: string): void {
  const key = letter.toUpperCase();
  if (map.has(key)) return; // first spelling wins, matching the detector's bias
  let label = raw.trim().replace(/[,;]+$/, "").trim();
  const recommended = RECOMMENDED_TAG.test(label);
  label = label.replace(RECOMMENDED_TAG, " ").trim();
  if (label) map.set(key, { letter: key, label, recommended });
}

/**
 * Pull the labeled options out of a gstack decision brief, or null when the text
 * isn't confidently one.
 *
 * Guards, in order of how much they matter:
 *  - the same BRIEF_MARKER the detector uses, so a finished review that happens
 *    to bullet its findings `A) … B) …` is never turned into clickable answers;
 *  - at least two options;
 *  - letters contiguous from A. Real briefs are A, B, C…; a gap means we latched
 *    onto prose that merely looks like a list.
 */
export function parseDecisionBrief(text: string | null | undefined): DecisionBrief | null {
  if (!text) return null;
  if (!BRIEF_MARKER.test(text)) return null;

  const map = new Map<string, BriefOption>();
  // Split-chain buckets render bold and inline on ONE line:
  // `**A) Include**, **B) Defer**, **C) Cut**, **D) Hold**`. Try that first — a
  // line-based pass would swallow the whole line as option A's label.
  for (const m of text.matchAll(/\*\*\s*([A-H])\s?[).]\s*([^*\n]+?)\s*\*\*/g)) addOption(map, m[1], m[2]);
  if (map.size < 2) {
    map.clear();
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(?:[-*+]\s+)?(?:\*\*)?\s*([A-H])\s?[).]\s+(.+?)\s*$/);
      if (m) addOption(map, m[1], m[2]);
    }
  }
  if (map.size < 2) return null;

  const options = [...map.values()].sort((a, b) => a.letter.localeCompare(b.letter));
  const contiguousFromA = options.every((o, i) => o.letter.charCodeAt(0) === 65 + i);
  if (!contiguousFromA) return null;

  if (!options.some((o) => o.recommended)) {
    const named = text.match(RECOMMENDATION_LETTER)?.[1]?.toUpperCase();
    const hit = named && options.find((o) => o.letter === named);
    if (hit) hit.recommended = true;
  }
  return { options };
}

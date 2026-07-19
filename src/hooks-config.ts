// Generates the settings JSON handed to each launched agent via `claude --settings`.
// It wires Claude Code's HTTP hooks to POST lifecycle events back to the daemon:
//   Notification  → the first-class "agent needs your attention" signal (covers
//                   permission prompts, plan approval, and more — not just AUQ).
//   PreToolUse(AUQ) → ready for interactive mode; a no-op headless (the AUQ tool
//                   doesn't exist under `claude -p`).
//
// Honest scope: whether Notification fires under headless `claude -p` is UNPROVEN
// (the spike detected waiting via the stream/prose heuristic). So this is a
// CORROBORATING signal — the prose heuristic in agent.ts stays the primary,
// proven path. Validate the hook on a real VPS run.

export interface HookSettings {
  hooks: {
    Notification: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>;
    PreToolUse: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>;
  };
}

export function hookSettings(baseUrl: string): HookSettings {
  return {
    hooks: {
      Notification: [
        {
          matcher: "*",
          hooks: [{ type: "http", url: `${baseUrl}/hooks/notification`, timeout: 10, async: true }],
        },
      ],
      PreToolUse: [
        {
          matcher: "AskUserQuestion|mcp__.*__AskUserQuestion",
          hooks: [{ type: "http", url: `${baseUrl}/hooks/pre-tool-use`, timeout: 30, async: false }],
        },
      ],
    },
  };
}

# End-to-end loop proof (real agent)

Proves the whole AgentDeck loop through the **actual browser UX**, with a **real
claude agent** — not curl, not a mock:

```
click "New task"  ->  daemon creates branch + worktree + spawns `claude -p`
   ->  agent asks in prose, turn ends  ->  dashboard flips to `waiting` (WebSocket)
   ->  "Reply" drawer -> type an answer -> "Send to agent"
   ->  daemon injects it via `claude --resume`  ->  agent writes the artifact -> done
```

`run.sh` spins a throwaway target repo + a fresh daemon (temp data dir), drives
the dashboard with headless Chromium (Playwright), then asserts the resumed agent
wrote `color.txt` = the answer.

## Run

```bash
cd docs/e2e
npm install
npx playwright install chromium   # first time only
npm run e2e
```

Requires [Bun](https://bun.sh), Node, and `claude` (Claude Code) **installed and
authenticated** on this machine. **It costs a real agent turn** and is
non-deterministic, so it is NOT wired into CI — run it locally when you touch the
supervisor, the dashboard flow, or the resume mechanic.

Screenshots of each beat land in `shots/`.

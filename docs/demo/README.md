# Demo GIF harness

Regenerates [`../demo.gif`](../demo.gif) (the README's animation) from the **real**
dashboard — not a mockup. It boots the actual server (`src/server.ts` +
`public/index.html`) against a throwaway DB, drives a scripted state timeline
over the live WebSocket, captures the frames with headless Chromium, and encodes
a GIF with a pure-JS encoder. Deps are isolated here so the root package stays
dependency-free.

## Regenerate

```bash
cd docs/demo
npm install
npx playwright install chromium   # first time only
npm run gif                       # → writes ../demo.gif
```

Needs [Bun](https://bun.sh) (runs the driver) and Node (runs capture + encode).

## What it does

- `driver.ts` (Bun) — boots `startServer()` on a temp DB + a small control port;
  `/seed` `/waiting` `/resume` `/done` mutate the store and fire `bus.emit("update")`,
  so the dashboard updates live over its real WebSocket. Serves the current
  `public/index.html`, so the GIF always reflects the latest dashboard.
- `capture.mjs` (Node + Playwright) — drives the sequence (calm board → one agent
  flips to `waiting` → open the reply drawer → type an answer → it resumes → done),
  screenshots each beat, and **fails on any dashboard console error** (the unit
  tests only check `<title>`, so this is the real UI-integrity gate).
- `capture-conn.mjs` (Node + Playwright) — the second artifact, `../demo-conn.gif`:
  the connection states (live → reconnecting → unreachable → recovered). It really
  stops the daemon via the driver's `/down` and `/up`, so the states come from the
  client's own reconnect loop, and it asserts the colour class of each state, not
  just the text. Rendered at a **700px** viewport on purpose: on-screen label size
  is `11px × display_width / viewport_width`, so rendering narrower than the
  README's 820px display width is what makes the label legible (12.9px instead of
  7.8px). Cropping would not help — the device scale factor cancels out.
  Takes ~30s: it waits out the real give-up threshold and the backoff.
- `encode.mjs` (Node) — assembles frames into a GIF (`gifenc` + `pngjs`).
  `node encode.mjs [framesDir] [outFile]`, defaults `frames` → `demo.gif`.

Edit the seed tasks / question in `driver.ts` and the typed answer in `capture.mjs`.

# AgentDeck — design system

This file exists because a design decision was once approved and then quietly
lost. The Master Inbox mockup (2026-07-19) defined a brand lockup; the
implementation dropped it, no test noticed, and the dashboard shipped with the
pre-rename wordmark for weeks. Tokens that live only in a mockup outside the
repo do not survive contact with the code. These do.

Scope: `public/index.html` is the entire UI — one self-contained file, embedded
into the binary at build time (`src/server.ts:7`). Every rule below is
enforceable by reading that one file.

---

## Classification

**App UI**, not a marketing page. The board is a workspace: dense, task-focused,
read a hundred times a day. That sets the posture — calm surfaces, strong
typography, few colors, minimal chrome. Copy is utility language (orientation,
status, action), never mood or aspiration.

---

## Color tokens

Defined once in `:root`, overridden under `prefers-color-scheme: light`. Never
hard-code a hex outside that block. The one exception is the favicon `data:` URI,
which cannot read CSS variables.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--bg` | `#0d1117` | `#f6f8fa` | page |
| `--surface` | `#161b22` | `#fff` | rows, pills, inputs |
| `--line` / `--line-soft` | `#232b36` / `#1a212b` | `#d6dde5` / `#e6ebf0` | borders |
| `--text` | `#e6edf3` | `#1c2128` | primary text |
| `--dim` | `#9aa7b4` | `#5a6570` | **the floor for any text** |
| `--faint` | `#6b7683` | `#8b97a3` | **non-text only** |
| `--accent` | `#4dd0c7` | `#157e77` | brand + interactive, used sparingly |
| `--wait` | `#f5a623` | `#b8770a` | semantic: needs you |
| `--err` | `#f85149` | `#cf222e` | semantic: error |
| `--ok` | `#3fb950` | `#1a7f37` | semantic: running / healthy |
| `--done` | `#8c97a4` | `#5d6975` | semantic: finished, receded — **also text**, see Rule 3 |

### Rule 1 — semantic color is separate from the interactive accent

`--wait`, `--err`, `--ok` and `--done` encode agent state. `--accent` encodes
"you can act on this". Never borrow one for the other: an amber button or a teal
"waiting" chip destroys the attention hierarchy the whole board is built on.

### Rule 2 — `--accent` is used sparingly

It carries the glyph's live row and the primary button. That is the budget. When
a second accent element appears in the same view, one of them is wrong. The
wordmark itself is `--text`; the brand reads through the mono face and the
glyph, not through coloring half the name.

### Rule 3 — `--faint` never carries text

Measured: `--faint` on `--bg` is **4.10:1** in dark and **2.80:1** in light,
below the 4.5:1 floor for text and below even the 3.0:1 floor for UI elements.
`--dim` measures **7.71:1** and **5.59:1**. Any text uses `--dim` or better.
`--faint` remains defined for non-text use only.

The rule binds every token that reaches text, not just `--faint`. `--done` was
shipped with `--faint`'s exact hex and used for `.chip.done/.stopped/.resuming`,
measuring **3.13:1** dark and **2.56:1** light on its own 16% tint; it was raised
to **4.55:1** and **4.53:1**. Before reusing a token as a text colour, measure it
against the surface it actually lands on — a tinted chip background is not `--bg`.

Verify a change with:

```js
const lin=c=>{c/=255;return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4)};
const L=h=>{const n=parseInt(h.slice(1),16);return 0.2126*lin(n>>16&255)+0.7152*lin(n>>8&255)+0.0722*lin(n&255)};
const ratio=(a,b)=>{const[x,y]=[L(a),L(b)].sort((p,q)=>q-p);return(x+0.05)/(y+0.05)};
```

---

## Typography

- `--mono` (`ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas`) is the
  **identity face**. The wordmark, labels, metadata, branch names, counters and
  status text are all mono. This is the deliberate typographic statement: the
  product is a terminal-adjacent control board and it should look like one.
- `--sans` (`system-ui, -apple-system, …`) is **secondary chrome only** — row
  titles and button labels.

On the default sans stack: an AI-slop checklist flags `system-ui` as the "gave up
on typography" signal. Reviewed and kept deliberately (2026-08-04). The
typographic identity is already carried by the mono face; the binary stays
self-contained with no embedded font and no network fetch. If that trade ever
changes, embed a real sans — do not silently drift.

Numeric columns use `font-variant-numeric: tabular-nums` so counters don't jitter.

---

## Header

Two rows, and the split is structural rather than cosmetic.

```
┌ .idbar ────────────────────────────────────────────────────────┐
│ [glyph] AgentDeck                        127.0.0.1:8811 · live │
├ .ctlbar ───────────────────────────────────────────────────────┤
│ PROJECT [select]  [1 waiting] [3 running]   [+ New task] [↑ Up]│
└────────────────────────────────────────────────────────────────┘
```

- **One `margin-left:auto` per row.** A single row held six elements and needed
  two competing auto-margins, which split the free space instead of pushing
  right — the wordmark shifted as pills appeared. If you add an element, it joins
  a row; it does not add a second auto-margin.
- **The wordmark is the page `<h1>`.** It was previously a bare `<span>`, leaving
  the document with no heading at all.
- **The context line states what nothing else on screen states**: which
  deployment this tab points at, and whether the link is alive. Agent counts live
  in the pills; repeating them there is noise.
- **The glyph is a deck of rows of decreasing width**, the live one in `--accent`.
  Three *equal* bars would read as a hamburger menu — a navigation convention we
  must not borrow by accident. The same glyph is the favicon.

---

## Interaction states

Every surface that can be absent, loading, empty, or broken says so.

| Surface | States |
|---|---|
| Connection (`#conn`) | `live` (`--ok`) · `reconnecting…` (`--wait`) · `daemon unreachable` (`--err`, after 8 tries ≈ 12s) |
| Notices (`#notices`) | hidden (nothing wrong) · warn (`--wait` border, dismissible) · error (`--err` border, **not** dismissible) |
| Board, no project | dashed empty state, `projects.json` guidance, Reload action |
| Board, no task | dashed empty state, one-line explanation, primary action |
| Task row | waiting · error · running · resuming · done · stopped, each with a colored rail |

The notice banner is the daemon's own health, not a task's. It sits between
`</header>` and `#board` — below the header, so it joins neither row and adds no
second `margin-left:auto`. Three rules, each learned the hard way:

- **An error is not dismissible.** A warning is a degradation you may knowingly
  accept; an error means tasks cannot run at all, and letting someone hide that
  from themselves only moves the confusion later.
- **Dismissal is keyed on code *and* message.** A changed message is new
  information and must resurface rather than stay hidden behind a dismissal of
  the old wording.
- **Body text is `--text`, never the semantic colour.** `--err`/`--wait` on their
  own tints fall under the 4.5:1 floor in one theme or the other; the border
  carries the meaning and the text stays readable. See Rule 1 and Rule 3.

A daemon restart is routine. It must read as *reconnecting*, never as an error.
But an unchanging retry message hides the difference between a two-second blip
and a daemon that never came back, so the state escalates to `--err` once.

Empty states are features: warmth, context, and a primary action. Never
"No items found."

---

## Accessibility

- **Contrast** — every text/background pair clears 4.5:1 in both themes. See Rule 3.
- **Touch targets** — interactive controls are at least 44px under 620px
  (`.newbtn`, `.projsel select`, `.opt`). Desktop keeps its density; a mouse does
  not need the area. Add every new control to that media query — the reply
  drawer's option rows shipped at 35px until a measurement caught them.
- **Focus** — visible focus rings on every control: `outline: 2px solid var(--accent)`
  with `outline-offset: 2px`. Add new controls to that selector list.
- **Announcements** — `#live` is an `aria-live="polite"` region. State transitions
  that matter (an agent needing you, an error, an unreachable daemon) append one
  node each, so a burst never clobbers a prior message.
- **Labels** — never placeholder-as-label. A visible label stays visible when the
  field has content.

---

## Do not

- Add a card grid, a hero, or a 3-column feature row. This is a workspace.
- Add a card unless the card **is** the interaction. Task rows qualify; nothing
  else so far does.
- Add decorative gradients, blobs, wavy dividers, or emoji as design elements.
- Use `border-left: 3px solid <accent>` as decoration. The task rail is semantic
  and is the only left-edge color on the page.
- Introduce a second accent color.

---

## Changing this file

A design decision that is not in this file will be lost. When a review settles a
durable rule — a token role, a contrast floor, a layout invariant — write it here
in the same commit. `test/server.test.ts` locks the brand lockup and the favicon
so the specific regression that produced this file cannot recur silently.

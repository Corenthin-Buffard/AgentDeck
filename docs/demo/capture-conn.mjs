// Captures the dashboard's CONNECTION STATES into their own GIF.
//
// Why a second capture instead of a coda on demo.gif: in the 1160px hero the
// state label is 11px in the far corner, so between "reconnecting…" and "daemon
// unreachable" only ~0.5% of the pixels change — measured at 405 bytes out of a
// 77 KB frame. It reads as a GIF that froze.
//
// The fix is NOT cropping. On-screen label size is `11px x display_width /
// viewport_width`; the device scale factor cancels out, so a crop changes the
// framing and nothing else. The lever is rendering NARROWER than the display
// width: at a 700px viewport shown at 820px in the README, the label lands at
// ~12.9px instead of 7.8px, and the short frame leaves it nothing to hide behind.
//
// The daemon is really stopped and restarted (driver's /down and /up). Poking
// setConn() from the page would be faster and would be a lie.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.AGENTDECK_PORT || '8790';
const CTRL = process.env.DEMO_CTRL_PORT || '9099';
const DASH = `http://127.0.0.1:${PORT}`;
const FRAMES = join(process.cwd(), 'frames-conn');
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const ctrl = (p) => fetch(`http://127.0.0.1:${CTRL}/${p}`).then((r) => r.text());
const timeline = [];
let n = 0;

const browser = await chromium.launch({ args: ['--no-sandbox', '--force-color-profile=srgb', '--hide-scrollbars'] });
// 700 wide (README shows it at 820, so it scales UP), 168 tall — the two header
// rows plus one task row for context. deviceScaleFactor 2 keeps the type crisp.
const page = await browser.newPage({
  viewport: { width: 700, height: 168 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});

// The outage is deliberate, so the browser MUST log a failed WebSocket per
// retry — that noise is the feature working. Allow exactly that shape, and only
// while the window is open. Anything else, and every pageerror, fails the run.
const jsErrors = [];
let outage = false;
const isOutageNoise = (t) => /WebSocket|ERR_CONNECTION_REFUSED/i.test(t);
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (outage && isOutageNoise(t)) return;
  jsErrors.push('console: ' + t);
});
page.on('pageerror', (e) => jsErrors.push('pageerror: ' + e.message));

async function snap(dur) {
  const file = join(FRAMES, `c${String(++n).padStart(4, '0')}.png`);
  await page.screenshot({ path: file });
  timeline.push({ file, dur });
}

// The GIF sells these states by COLOUR, so assert the class too. A capture that
// silently recorded the wrong tint would be worse than no capture at all.
async function expectConn(text, cls) {
  await page.waitForFunction((t) => document.getElementById('conn')?.textContent === t, text, { timeout: 25000 });
  const got = await page.evaluate(() => {
    const el = document.getElementById('conn');
    return { text: el?.textContent, cls: el?.className };
  });
  if (got.cls !== cls) throw new Error(`"${text}" should use ${cls}, got "${got.cls}"`);
}

await page.goto(DASH, { waitUntil: 'domcontentloaded' });
await ctrl('seed');
await page.waitForSelector('.row.running', { timeout: 5000 });

// 1 — connected. Green, and the board is live.
await expectConn('live', 'conn-ok');
await page.waitForTimeout(300);
await snap(2.0);

// 2 — the daemon goes away (a rebuild, a restart, a crash). Amber: this is
//     expected, so it must NOT read as an error.
await ctrl('down');
outage = true;
await expectConn('reconnecting…', 'conn-wait');
await snap(2.4);

// 3 — it stays gone. After 8 tries the board stops pretending and says so in
//     red, then backs off. ~12s of real waiting compressed into one frame.
await expectConn('daemon unreachable', 'conn-err');
await snap(2.6);

// 4 — it comes back on its own. No page reload: the dashboard token is persisted
//     across restarts, so the reconnect handshake still authenticates.
await ctrl('up');
await expectConn('live', 'conn-ok');
outage = false;
await page.waitForTimeout(300);
await snap(2.4);

await browser.close();

if (jsErrors.length) {
  console.error('DASHBOARD JS ERRORS:\n' + jsErrors.join('\n'));
  process.exit(1);
}

let list = 'ffconcat version 1.0\n';
for (const f of timeline) list += `file '${f.file}'\nduration ${f.dur}\n`;
list += `file '${timeline[timeline.length - 1].file}'\n`;
writeFileSync(join(FRAMES, 'list.txt'), list);
console.log(`captured ${timeline.length} connection-state frames, 0 JS errors`);

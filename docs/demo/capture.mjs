import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.GORCH_PORT || process.env.AGENTDECK_PORT || '8790';
const CTRL = process.env.DEMO_CTRL_PORT || '9099';
const DASH = `http://127.0.0.1:${PORT}`;
const FRAMES = join(process.cwd(), 'frames');
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const ctrl = (p) => fetch(`http://127.0.0.1:${CTRL}/${p}`).then(r => r.text());
const timeline = [];
let n = 0;

const browser = await chromium.launch({ args: ['--no-sandbox', '--force-color-profile=srgb', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1160, height: 840 }, deviceScaleFactor: 1, colorScheme: 'dark' });

// JS-integrity gate: the only unit test checks <title>, so a broken template
// literal / handler would ship silently. Fail the capture on any console error.
const jsErrors = [];
page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console: ' + m.text()); });
page.on('pageerror', (e) => jsErrors.push('pageerror: ' + e.message));

async function snap(dur) {
  const file = join(FRAMES, `f${String(++n).padStart(4, '0')}.png`);
  await page.screenshot({ path: file });
  timeline.push({ file, dur });
}
async function burst(count, gapMs, dur) {
  for (let i = 0; i < count; i++) { await snap(dur); await page.waitForTimeout(gapMs); }
}

await page.goto(DASH, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('conn')?.textContent === 'live', { timeout: 10000 });

// Beat 1 — calm board.
await ctrl('seed');
await page.waitForSelector('.row.running', { timeout: 5000 });
await page.waitForTimeout(350);
await snap(1.9);

// Beat 2 — one agent flips to "needs you".
await ctrl('waiting');
await page.waitForSelector('.row.waiting', { timeout: 5000 });
await burst(3, 150, 0.14);
await snap(2.0);

// Assert the translated section labels render (English), not French.
// Labels use text-transform:uppercase, so innerText is upper — compare case-insensitively.
const bodyText = (await page.evaluate(() => document.body.innerText)).toLowerCase();
for (const w of ['needs you', 'cruising', 'done']) {
  if (!bodyText.includes(w)) throw new Error(`missing English label: "${w}"`);
}

// Beat 3 — open the reply drawer.
await page.click('.row.waiting .btn.primary');
await page.waitForSelector('#ans', { state: 'visible', timeout: 5000 });
await burst(3, 90, 0.10);
await snap(1.2);

// Beat 4 — type the answer.
await page.click('#ans');
await page.evaluate(() => document.getElementById('ans')?.setAttribute('spellcheck', 'false'));
await page.type('#ans', '1 — rotate on every use, we want the MVP safe', { delay: 55 });
await snap(1.7);

// Beat 5 — send: drawer closes, the agent picks it back up (running).
await page.evaluate(() => closeDrawer());
await ctrl('resume');
await page.waitForFunction(() => !document.querySelector('.row.waiting'), { timeout: 5000 });
await page.waitForTimeout(300);
await snap(1.9);

// Beat 6 — it finishes and recedes into "Done".
await ctrl('done');
await page.waitForTimeout(500);
await snap(2.0);

await browser.close();

if (jsErrors.length) {
  console.error('DASHBOARD JS ERRORS (translation broke something):\n' + jsErrors.join('\n'));
  process.exit(1);
}

let list = 'ffconcat version 1.0\n';
for (const f of timeline) list += `file '${f.file}'\nduration ${f.dur}\n`;
list += `file '${timeline[timeline.length - 1].file}'\n`;
writeFileSync(join(FRAMES, 'list.txt'), list);
console.log(`captured ${timeline.length} frames, 0 JS errors, English labels present`);

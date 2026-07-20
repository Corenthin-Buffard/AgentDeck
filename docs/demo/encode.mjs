import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;

// Read the ffconcat list (file + duration pairs) written by capture.mjs.
const lines = readFileSync('frames/list.txt', 'utf8').split('\n');
const frames = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^file '(.+)'$/);
  if (!m) continue;
  const d = (lines[i + 1] || '').match(/^duration ([\d.]+)/);
  frames.push({ file: m[1], delayMs: d ? Math.round(parseFloat(d[1]) * 1000) : 1500 });
}
// Drop the trailing duplicate the ffconcat format requires.
if (frames.length > 1 && frames.at(-1).file === frames.at(-2).file) frames.pop();

const gif = GIFEncoder();
for (const fr of frames) {
  const { width, height, data } = PNG.sync.read(readFileSync(fr.file)); // RGBA
  const palette = quantize(data, 256);
  const index = applyPalette(data, palette);
  gif.writeFrame(index, width, height, { palette, delay: fr.delayMs });
}
gif.finish();
writeFileSync('demo.gif', gif.bytes());
const kb = (readFileSync('demo.gif').length / 1024).toFixed(0);
console.log(`wrote demo.gif — ${frames.length} frames, ${kb} KB`);

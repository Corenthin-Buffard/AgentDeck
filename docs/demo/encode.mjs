import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;

// Usage: node encode.mjs [framesDir] [outFile]   (defaults: frames, demo.gif)
const FRAMES_DIR = process.argv[2] || 'frames';
const OUT = process.argv[3] || 'demo.gif';

// Read the ffconcat list (file + duration pairs) written by the capture script.
const lines = readFileSync(`${FRAMES_DIR}/list.txt`, 'utf8').split('\n');
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
writeFileSync(OUT, gif.bytes());
const kb = (readFileSync(OUT).length / 1024).toFixed(0);
console.log(`wrote ${OUT} — ${frames.length} frames, ${kb} KB`);

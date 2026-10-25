/**
 * HD-CONVERT: before/after numbers and comparison images for the HD conversion, on the owner's HD
 * example and the five 19:33 part drawings. "Before" is cld/artifacts/hd-convert/before/ (the
 * converter as of 2b1fe20e, kept as images); "after" is today's converter. Per frame: isolated
 * pixels, one-pixel holes, outline breaks (edge pixels that are not outline-dark) and, for the
 * example, the silhouette's overlap (IoU) with the original's own mask at the same grid (a block
 * drawn when the figure covers half of it), both aligned by their feet. Writes after/, the
 * comparison images and metrics.json.
 *
 *   npx tsx cld/scripts/measure-hd-convert.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { parsePartFileName } from '../../core/src/cld/partData.js';
import { hdSheetFromBoxes } from '../../server/src/cld/hdSheet.js';
import { importPart } from '../../server/src/cld/partImport.js';
import { type SpriteStats, spriteStats } from '../../server/src/cld/pixelResample.js';

const root = path.resolve(__dirname, '../..');
const SRC = path.join(root, '../specs/owner-art-1025');
const SOURCES = fs.existsSync(SRC) ? SRC : path.resolve(root, '.worktrees/specs/owner-art-1025');
const OUT = path.join(root, 'cld/artifacts/hd-convert');
const FW = 32;
const FH = 64;
const ZOOM = 8;

const read = (file: string) => {
  const p = PNG.sync.read(fs.readFileSync(file));
  return { width: p.width, height: p.height, data: new Uint8Array(p.data) };
};
const write = (file: string, w: number, h: number, data: Uint8Array) => {
  const p = new PNG({ width: w, height: h });
  p.data = Buffer.from(data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(p));
};

/** The frame's drawn mask, moved so its feet's bottom-centre sits at (16, 61). */
function footed(data: Uint8Array, w: number, fx: number, fy: number): Set<number> {
  const pts: [number, number][] = [];
  for (let y = 0; y < FH; y++)
    for (let x = 0; x < FW; x++) if (data[((fy + y) * w + fx + x) * 4 + 3]) pts.push([x, y]);
  if (!pts.length) return new Set();
  const [x0, x1] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
  const y1 = Math.max(...pts.map((p) => p[1]));
  const dx = 16 - Math.round((x0 + x1 + 1) / 2);
  const dy = 61 - y1;
  return new Set(pts.map(([x, y]) => (y + dy) * 1000 + x + dx));
}
const iou = (a: Set<number>, b: Set<number>) => {
  let inter = 0;
  for (const k of a) if (b.has(k)) inter++;
  return inter / Math.max(1, a.size + b.size - inter);
};
const sum = (xs: SpriteStats[]) => ({
  isolated: xs.reduce((t, s) => t + s.isolated, 0),
  holes: xs.reduce((t, s) => t + s.holes, 0),
  outlineBreaks: xs.reduce((t, s) => t + s.outlineBreaks, 0),
  opaque: xs.reduce((t, s) => t + s.opaque, 0),
});

const metrics: Record<string, unknown> = {};
const example = read(path.join(SOURCES, 'hd-bunny-sheet-example.png'));
const after = hdSheetFromBoxes(example, { mirror: [false, false, true] });
const ref = hdSheetFromBoxes(example, {
  mirror: [false, false, true],
  minCover: 0.5,
  clean: false,
});
if ('error' in after || 'error' in ref) throw new Error('conversion failed');
write(path.join(OUT, 'after/bunny-hd-sample.png'), after.width, after.height, after.data);
const before = read(path.join(OUT, 'before/bunny-hd-sample.png'));
const frames: { row: number; frame: number }[] = [];
for (let row = 0; row < 3; row++)
  for (let frame = 0; frame < 3; frame++) frames.push({ row, frame });
const per = (img: { width: number; data: Uint8Array }) =>
  frames.map(({ row, frame }) => {
    const [fx, fy] = [frame * FW, row * FH];
    const st = spriteStats(img.data, img.width, [fx, fy, fx + FW, fy + FH]);
    const overlap = iou(footed(img.data, img.width, fx, fy), footed(ref.data, ref.width, fx, fy));
    return { ...st, iou: Math.round(overlap * 1000) / 1000 };
  });
const b = per(before);
const a = per({ width: after.width, data: after.data });
metrics.example = {
  size: after.report.size,
  gridFound: after.report.gridFound,
  cleaned: after.report.cleaned,
  before: { ...sum(b), iou: b.map((s) => s.iou) },
  after: { ...sum(a), iou: a.map((s) => s.iou) },
};

// the five part drawings: the importer's HD crop
const parts: Record<string, unknown> = {};
for (const f of [
  'top-bunny-f-down.png',
  'top-bunny-f-up.png',
  'top-bunny-f-right.png',
  'hair-bunnybob-f.png',
  'hair-bunnyface-f.png',
]) {
  const what = parsePartFileName(f)!;
  const r = importPart(read(path.join(SOURCES, f)), what.slot, what.view, { mismatch: 'keep' });
  if ('error' in r || !r.hd) throw new Error(`${f}: no HD`);
  write(path.join(OUT, 'after', f), r.hd.width, r.hd.height, r.hd.data);
  const old = read(path.join(OUT, 'before', f));
  const cells = (img: { width: number; height: number; data: Uint8Array }) => {
    const [cw, ch] = what.slot === 'hair' ? [32, 48] : [FW, FH];
    const out: SpriteStats[] = [];
    for (let y = 0; y + ch <= img.height; y += ch)
      for (let x = 0; x + cw <= img.width; x += cw)
        out.push(spriteStats(img.data, img.width, [x, y, x + cw, y + ch]));
    return sum(out);
  };
  parts[f] = {
    before: cells(old),
    after: cells({ width: r.hd.width, height: r.hd.height, data: r.hd.data }),
  };
}
metrics.parts = parts;
fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');

// comparison: per source frame, the original box (scaled to the frame's height), before, after
const boxes = [
  [126, 136, 307, 422],
  [319, 136, 494, 421],
  [507, 136, 687, 422],
];
const panelW = FW * ZOOM;
const panelH = FH * ZOOM;
const W = panelW * 3 * boxes.length + 16 * (boxes.length * 3);
const img = new Uint8Array(W * panelH * 4).fill(255);
const paint = (ox: number, get: (x: number, y: number) => number[] | null) => {
  for (let y = 0; y < panelH; y++)
    for (let x = 0; x < panelW; x++) {
      const c = get(x, y);
      const bg = (Math.floor(x / 32) + Math.floor(y / 32)) % 2 ? 212 : 236;
      img.set([...(c ?? [bg, bg, bg]), 255], (y * W + ox + x) * 4);
    }
};
const pixel = (src: { width: number; data: Uint8Array }, x: number, y: number) => {
  const i = (y * src.width + x) * 4;
  return src.data[i + 3] ? [src.data[i], src.data[i + 1], src.data[i + 2]] : null;
};
boxes.forEach(([x0, y0, x1, y1], k) => {
  const base = k * (panelW * 3 + 48);
  const scale = (y1 - y0) / panelH;
  paint(base, (x, y) => {
    const sx = Math.floor(x0 + (x - (panelW - (x1 - x0) / scale) / 2) * scale);
    const sy = Math.floor(y0 + y * scale);
    return sx >= x0 && sx <= x1 ? pixel(example, sx, sy) : null;
  });
  paint(base + panelW + 16, (x, y) =>
    pixel(before, k * FW + Math.floor(x / ZOOM), Math.floor(y / ZOOM)),
  );
  paint(base + 2 * (panelW + 16), (x, y) =>
    pixel(
      { width: after.width, data: after.data },
      k * FW + Math.floor(x / ZOOM),
      Math.floor(y / ZOOM),
    ),
  );
});
write(path.join(OUT, 'compare-front-orig-before-after.png'), W, panelH, img);
console.log(JSON.stringify(metrics, null, 2));

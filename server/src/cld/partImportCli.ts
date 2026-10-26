/**
 * CHAR-HUMAN: import a folder of the owner's part drawings (`slot-name[-f|-m][-down|-up|-right].png`)
 * the way 부품 가져오기 does. Run from the repo root:
 *
 *   nice -n 10 npx tsx server/src/cld/partImportCli.ts <folder> --dir <partsDir> [--preview <outDir>] [--dry]
 *     [--mismatch borrow|empty|keep] [--frames <file>=<i,j>:<borrow|empty|keep>]...
 *
 * `--dir` is where the parts go (the daemon's is ~/.config/agent-tycoon/parts; it is never assumed);
 * a running daemon reads it at its next start. `--preview` writes each part on the bald body ×4
 * (all 21 frames); `--dry` converts and reports without saving. `--mismatch` is what a frame drawn
 * facing the wrong way becomes (default borrow: the row's nearest right frame); `--frames` sets it for
 * frames by index (0-6) in one file. Prints one line per file and one per flagged frame.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import {
  PART_ALPHABET,
  PART_FRAME_H,
  PART_FRAME_W,
  PART_FRAMES,
  PART_VIEWS,
  type PartData,
  PARTS_META,
  SHEET_H,
  SHEET_W,
} from '../../../core/src/cld/partData.js';
import { CharacterPartStore } from './characterParts.js';
import { parsePartFileName } from './partImport.js';

const PREVIEW_ZOOM = 4;

/** The part on the bald body (its own colours), as RGBA 112×96. */
function onBody(part: PartData): Uint8Array {
  const out = new Uint8Array(SHEET_W * SHEET_H * 4);
  const put = (i: number, p: { palette: string[] }, k: string) => {
    const c = p.palette[PART_ALPHABET.indexOf(k)];
    out.set(
      [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16), 255],
      i * 4,
    );
  };
  const body = PARTS_META.parts.find((p) => p.id === 'basic')!;
  for (let i = 0; i < SHEET_W * SHEET_H; i++)
    if (body.pixels[i] !== '.') put(i, body, body.pixels[i]);
  const { headBox, headAnchors } = PARTS_META;
  if (part.kind === 'sheet') {
    for (let i = 0; i < SHEET_W * SHEET_H; i++)
      if (part.pixels[i] !== '.') put(i, part, part.pixels[i]);
    return out;
  }
  for (let v = 0; v < PART_VIEWS.length; v++)
    for (let f = 0; f < PART_FRAMES; f++) {
      const [ax, ay] = headAnchors[v * PART_FRAMES + f];
      for (let y = 0; y < headBox.h; y++)
        for (let x = 0; x < headBox.w; x++) {
          const k = part.pixels[y * headBox.w * PART_VIEWS.length + v * headBox.w + x];
          const fx = ax + x;
          const fy = ay + y;
          if (k === '.' || fx < 0 || fy < 0 || fx >= PART_FRAME_W || fy >= PART_FRAME_H) continue;
          put((v * PART_FRAME_H + fy) * SHEET_W + f * PART_FRAME_W + fx, part, k);
        }
    }
  return out;
}

function writePreview(file: string, rgba: Uint8Array) {
  const p = new PNG({ width: SHEET_W * PREVIEW_ZOOM, height: SHEET_H * PREVIEW_ZOOM });
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      const i = (Math.floor(y / PREVIEW_ZOOM) * SHEET_W + Math.floor(x / PREVIEW_ZOOM)) * 4;
      p.data.set(
        rgba[i + 3] ? rgba.subarray(i, i + 4) : [200, 200, 208, 255],
        (y * p.width + x) * 4,
      );
    }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(p));
}

function main(args: string[]): number {
  const rest = args.filter((a) => a !== '--dry');
  const option = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest.splice(i, 2)[1] : undefined;
  };
  const dry = args.includes('--dry');
  const target = option('--dir');
  const preview = option('--preview');
  const mismatch = option('--mismatch');
  // --frames <file>=<i,j>:<borrow|empty|keep>, repeatable: the owner's call for those frames
  const frames = new Map<string, Record<number, string>>();
  for (let spec = option('--frames'); spec; spec = option('--frames')) {
    const m = /^(.+)=([\d,]+):(borrow|empty|keep)$/.exec(spec);
    if (!m) {
      console.error(`bad --frames ${spec}`);
      return 1;
    }
    const map = frames.get(m[1]) ?? {};
    for (const i of m[2].split(',')) map[Number(i)] = m[3];
    frames.set(m[1], map);
  }
  const [folder] = rest;
  if (!folder || !target) {
    console.error('usage: partImportCli.ts <folder> --dir <partsDir> [--preview <outDir>] [--dry]');
    return 1;
  }
  const store = new CharacterPartStore(path.resolve(target), () => undefined);
  store.start();
  let failed = 0;
  for (const file of fs
    .readdirSync(folder)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .sort()) {
    const what = parsePartFileName(file);
    if (!what) {
      console.log(`${file}: skipped (not slot-name[-f|-m][-down|-up|-right].png)`);
      continue;
    }
    const body = {
      png: fs.readFileSync(path.join(folder, file)).toString('base64'),
      ...what,
      ...(mismatch && { mismatch }),
      ...(frames.has(file) && { frames: frames.get(file) }),
    };
    const r = store.import(body, !dry);
    if ('error' in r) {
      failed++;
      console.log(`${file}: refused: ${r.error}`);
      continue;
    }
    const p = r.part;
    console.log(
      `${file}: ${dry ? 'would save' : 'saved'} ${p.id} (${p.kind}, ${p.palette.length} colours, ramp ${p.ramp.length})`,
    );
    const { grid, layout, fit } = r.report;
    console.log(`  ${layout} by ${grid}, fit ${fit === null ? '-' : fit.toFixed(2)}`);
    for (const f of r.report.frames)
      if (f.fix !== 'kept' || (f.seen !== 'unknown' && f.seen !== f.want))
        console.log(
          `  frame ${f.frame + 1}: ${f.seen !== f.want && f.seen !== 'unknown' ? `drawn ${f.seen}, the template wants ${f.want}` : 'marked'}: ${f.fix}${f.from !== undefined ? ` from frame ${f.from + 1}` : ''}`,
        );
    if (preview) writePreview(path.join(preview, `${p.id}.png`), onBody(store.get(p.id) ?? p));
  }
  return failed ? 2 : 0;
}

process.exitCode = main(process.argv.slice(2));

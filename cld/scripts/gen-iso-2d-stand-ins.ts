/**
 * iso-prep-1104: top-down stand-ins for the isometric-only furniture (the owner drew these in
 * isometric only), so the 2D office still shows something on their tiles:
 *  - RUG_ROUND: the round rug's picture mapped back from its footprint's diamond to the square
 *    (it is flat, so this is the rug as seen from above);
 *  - CABINET_FRONT / CABINET_SIDE: the filing cabinet's two pictures shrunk to one tile wide.
 * Box-averaged (8×8 samples a pixel), then alpha cut at half: hard edges, as the 2D sprites have.
 * Everything else new (DESK_B, ARMCHAIR, COFFEE_TABLE_B, WHITEBOARD_SIDE) copies the nearest 2D
 * picture as is.
 *
 *   npx tsx cld/scripts/gen-iso-2d-stand-ins.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import owner from '../../webview-ui/src/cld/iso/art/owner-manifest.json';
import { ISO_HALF_H, ISO_HALF_W } from '../../webview-ui/src/constants.js';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'webview-ui/src/cld/iso/art');
const FURN = path.join(ROOT, 'webview-ui/public/assets/furniture');
const TILE = 16;
const SUB = 8;

const read = (file: string) => PNG.sync.read(fs.readFileSync(path.join(ART, file)));

/** A w×h picture whose pixel (x, y) averages `src` at map(x + u, y + v) over SUB×SUB samples. */
function sample(src: PNG, w: number, h: number, map: (x: number, y: number) => [number, number]) {
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0, 0];
      for (let j = 0; j < SUB; j++)
        for (let i = 0; i < SUB; i++) {
          const [sx, sy] = map(x + (i + 0.5) / SUB, y + (j + 0.5) / SUB).map(Math.floor);
          if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
          const k = (sy * src.width + sx) * 4;
          const a = src.data[k + 3];
          for (let c = 0; c < 3; c++) acc[c] += src.data[k + c] * a;
          acc[3] += a;
        }
      const o = (y * w + x) * 4;
      const a = acc[3] / (SUB * SUB);
      if (a < 128) continue;
      for (let c = 0; c < 3; c++) out.data[o + c] = Math.round(acc[c] / acc[3]);
      out.data[o + 3] = 255;
    }
  return out;
}

const write = (dir: string, file: string, png: PNG) => {
  fs.mkdirSync(path.join(FURN, dir), { recursive: true });
  fs.writeFileSync(path.join(FURN, dir, file), PNG.sync.write(png));
};

// The rug: 2D px (x, y) is world px of its footprint; its picture has the footprint's front
// corner (col fw, row fh) on the anchor, at the piece's density.
{
  const p = owner.pieces['o-rug-round'];
  const [fw, fh] = p.footprint;
  const src = read(p.file);
  write(
    'RUG_ROUND',
    'RUG_ROUND.png',
    sample(src, fw * TILE, fh * TILE, (x, y) => {
      const c = x / TILE - fw;
      const r = y / TILE - fh;
      return [
        p.anchor[0] + (c - r) * ISO_HALF_W * p.density,
        p.anchor[1] + (c + r) * ISO_HALF_H * p.density,
      ];
    }),
  );
}

// The cabinet: one tile wide, standing on the bottom of a 1×2 picture.
for (const [piece, file] of [
  ['o-cabinet-a', 'CABINET_FRONT.png'],
  ['o-cabinet-b', 'CABINET_SIDE.png'],
] as const) {
  const src = read(owner.pieces[piece].file);
  const k = src.width / TILE;
  const h = TILE * 2;
  const top = h - src.height / k;
  write(
    'CABINET',
    file,
    sample(src, TILE, h, (x, y) => [x * k, (y - top) * k]),
  );
}

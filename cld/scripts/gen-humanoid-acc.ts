/**
 * CH-5: the person accessories (glasses, headset, cap), drawn here in code: no external image is
 * opened, traced or bundled. Writes webview-ui/src/cld/characters/accessories.json (one piece per
 * view: down, up, right; left is the right row mirrored) and a combination sheet, rendered through
 * the office compositor, to cld/artifacts/char-humanoid/combinations.png. Run:
 *
 *   npx tsx cld/scripts/gen-humanoid-acc.ts
 *
 * A piece is layers of 16-wide rows. Each layer hangs from one of two rows the compositor reads
 * off every frame of the body it goes on: `top` (the head's first row of 4+ pixels) or `eye`
 * (the eyes' first row; on the back view the front frame's distance from the top). `from` drops
 * a layer's pixels above top + from (the headset's side bars reach up to the band on any head).
 * Columns are the cell's own: every body's head sits on the same columns, with the eyes on
 * columns 5-6 and 9-10 seen from the front and 11-12 from the side.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

const root = path.resolve(__dirname, '../..');
const OUT = path.join(root, 'webview-ui/src/cld/characters/accessories.json');
const PREVIEW = path.join(root, 'cld/artifacts/char-humanoid');

interface Layer {
  at: 'top' | 'eye';
  y: number;
  rows: string[];
  from?: number;
}

/* eslint-disable pixel-agents/no-inline-colors -- accessory art colours: data, not UI styling */
/** Upper case like every sprite pixel (a piece's pixels compare equal to a sheet's). */
const palette = {
  o: '#1A1A22', // outline
  g: '#202030', // glasses frame
  k: '#8A91A3', // headset band
  r: '#E04848', // headset cups
  C: '#D24B3E', // cap
  h: '#EC7466', // cap highlight
  D: '#A5362C', // cap shade
  B: '#7E2A24', // cap brim
};
/* eslint-enable pixel-agents/no-inline-colors */

/** The rim on the brow row, the posts and bridge beside the eyes' top row (bodies 2 and 6 have
 *  lashes on the row below); the lenses are the eyes themselves. */
const glasses: Record<'down' | 'right', Layer[]> = {
  down: [
    {
      at: 'eye',
      y: -1,
      rows: [
        '....gggggggg....', //
        '...gg..gg..gg...',
      ],
    },
  ],
  right: [
    {
      at: 'eye',
      y: -1,
      rows: [
        '..........gggg..', //
        '.....gggggg..g..',
      ],
    },
  ],
};

const sideBars = (cols: number[], from: number): Layer => ({
  at: 'eye',
  y: -12,
  from,
  rows: Array.from({ length: 11 }, () =>
    [...'................'].map((c, x) => (cols.includes(x) ? 'k' : c)).join(''),
  ),
});
const frontHeadset: Layer[] = [
  {
    at: 'top',
    y: -1,
    rows: [
      '....oooooooo....', //
      '...okkkkkkkko...',
      '..ko........ok..',
    ],
  },
  sideBars([1, 14], 2),
  {
    at: 'eye',
    y: -1,
    rows: [
      '.oo..........oo.', //
      'orrk........krro',
      'orrk........krro',
      '.oo..........oo.',
    ],
  },
];
const headset: Record<'down' | 'up' | 'right', Layer[]> = {
  down: [
    ...frontHeadset,
    // the microphone, from the cup to the corner of the mouth
    { at: 'eye', y: 3, rows: ['..kkkr..........'] },
  ],
  up: frontHeadset,
  right: [
    { at: 'top', y: -1, rows: ['.....oooo.......', '.....okko.......'] },
    sideBars([6], 1),
    {
      at: 'eye',
      y: -1,
      rows: [
        '.....oooo.......', //
        '.....orro.......',
        '.....orro.......',
        '.....oooo.......',
        '.......kkkkr....',
      ],
    },
  ],
};

const crown = [
  '....oooooooo....', //
  '...oChCCCCCCo...',
  '..oChCCCCCCCCo..',
  '..oCCCCCCCCCCo..',
];
const cap: Record<'down' | 'up' | 'right', Layer[]> = {
  down: [{ at: 'top', y: -1, rows: [...crown, '.oBBBBBBBBBBBBo.'] }],
  up: [{ at: 'top', y: -1, rows: [...crown, '..oDDDDDDDDDDo..'] }],
  right: [{ at: 'top', y: -1, rows: [...crown, '..oDDDDDDDDBBBBo'] }],
};

async function preview(): Promise<void> {
  const { compose } = await import('../../webview-ui/src/cld/characters/compose.js');
  const { HUMANOID_ACCESSORIES, HUMANOID_SWATCHES } = await import('../../core/src/cld/looks.js');
  fs.mkdirSync(PREVIEW, { recursive: true });
  const Z = 3;
  const FW = 16 * Z;
  const FH = 32 * Z;
  const combos = Array.from({ length: 8 }, (_, m) =>
    HUMANOID_ACCESSORIES.filter((_a, i) => m & (1 << i)),
  );
  // per body: 8 accessory sets × (front, side, back), then 4 colour samples × (front, seated, reading)
  const cols = combos.length * 3 + 4 * 3;
  const png = new PNG({ width: cols * FW + 40, height: 6 * (FH + 8) + 8 });
  for (let i = 0; i < png.width * png.height; i++) png.data.set([30, 30, 46, 255], i * 4);
  const blit = (sprite: string[][], x0: number, y0: number) =>
    sprite.forEach((row, y) =>
      row.forEach((c, x) => {
        if (!c) return;
        const rgb = [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16));
        for (let j = 0; j < Z; j++)
          for (let i = 0; i < Z; i++)
            png.data.set([...rgb, 255], ((y0 + y * Z + j) * png.width + x0 + x * Z + i) * 4);
      }),
    );
  const S = HUMANOID_SWATCHES;
  for (let base = 0; base < 6; base++) {
    const y = 8 + base * (FH + 8);
    let x = 8;
    for (const acc of combos) {
      const { sheet } = compose({ v: 2, kind: 'humanoid', base, acc: [...acc] }, { templates: [] });
      for (const f of [sheet.down[1], sheet.right[1], sheet.up[1]]) {
        blit(f, x, y);
        x += FW;
      }
    }
    x += 24;
    for (let n = 0; n < 4; n++) {
      const colors = {
        skin: S.skin[(base + n) % S.skin.length],
        hair: S.hair[(base * 3 + n) % S.hair.length],
        top: S.clothes[(base + n * 3) % S.clothes.length],
        bottom: S.clothes[(base * 2 + n * 5 + 1) % S.clothes.length],
        shoes: S.clothes[(base + n * 7 + 2) % S.clothes.length],
      };
      const acc = combos[(base + n * 3) % combos.length];
      const { sheet } = compose(
        { v: 2, kind: 'humanoid', base, colors, acc: [...acc] },
        { templates: [] },
      );
      for (const f of [sheet.down[1], sheet.down[3], sheet.right[5]]) {
        blit(f, x, y);
        x += FW;
      }
    }
  }
  const file = path.join(PREVIEW, 'combinations.png');
  fs.writeFileSync(file, PNG.sync.write(png));
  console.log(path.relative(root, file));
}

fs.writeFileSync(
  OUT,
  JSON.stringify({
    $comment: 'CH-5, generated by cld/scripts/gen-humanoid-acc.ts: person accessories',
    palette,
    pieces: { glasses, headset, cap },
  }) + '\n',
);
console.log(path.relative(root, OUT));
if (!process.argv.includes('--no-preview')) void preview();

/**
 * Draw the lobby's furniture (T-0046) into webview-ui/public/assets/furniture/:
 * - LED_BOARD: the big board, 28x11 tiles. A dark LED screen (dot matrix) in a
 *   bolted frame on three posts; the top two rows hang on the wall. The board's
 *   live content is a DOM overlay over the screen (webview-ui/src/cld/board/,
 *   BOARD_SCREEN in constants.ts is the screen rect drawn here).
 * - LOBBY_BENCH: a 2-tile wooden bench seen from behind (a back-facing seat,
 *   so whoever sits on it faces the board).
 *
 *   npx tsx cld/scripts/gen-lobby-assets.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

const root = path.resolve(__dirname, '../..');
const dir = (id: string) => path.join(root, 'webview-ui/public/assets/furniture', id);

type Rgba = [number, number, number, number];
const hex = (h: string, a = 255): Rgba => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
  a,
];

function canvas(w: number, h: number) {
  const png = new PNG({ width: w, height: h });
  png.data.fill(0);
  const px = (x: number, y: number, c: Rgba) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    png.data.set(c, (y * w + x) * 4);
  };
  const rect = (x: number, y: number, rw: number, rh: number, c: Rgba) => {
    for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) px(i, j, c);
  };
  return { png, px, rect };
}

function save(id: string, png: PNG, manifest: object): void {
  fs.mkdirSync(dir(id), { recursive: true });
  fs.writeFileSync(path.join(dir(id), `${id}.png`), PNG.sync.write(png));
  fs.writeFileSync(path.join(dir(id), 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${id}: ${png.width}x${png.height}`);
}

// ── LED_BOARD ─────────────────────────────────────────────────
{
  // 28 x 11 tiles: about two office rooms wide. The screen is 3:1 (the
  // board's pages lay out 48 x 16 em).
  const W = 448;
  const H = 176;
  const SCREEN = { x: 5, y: 5, w: 438, h: 146 }; // BOARD_SCREEN in constants.ts
  const PANEL_H = SCREEN.y + SCREEN.h + 11; // the bottom rail holds lamps and a nameplate
  const { png, px, rect } = canvas(W, H);
  const frame = hex('#2b2b45');
  const light = hex('#4d4d75');
  const dark = hex('#15152a');
  const outline = hex('#0a0a14');
  const screen = hex('#06070c');
  const led = hex('#121826');
  const post = hex('#38384f');
  const postLight = hex('#55557a');
  // Posts and feet first, the panel over them.
  for (const x of [56, W / 2 - 4, W - 64]) {
    rect(x, PANEL_H - 2, 8, H - PANEL_H - 2, outline);
    rect(x + 1, PANEL_H - 2, 6, H - PANEL_H - 2, post);
    rect(x + 1, PANEL_H - 2, 2, H - PANEL_H - 2, postLight);
    rect(x - 6, H - 5, 20, 5, outline);
    rect(x - 5, H - 5, 18, 4, post);
    rect(x - 5, H - 5, 18, 1, postLight);
  }
  // The panel: outline, frame with a light top-left and dark bottom-right edge.
  rect(0, 0, W, PANEL_H, outline);
  rect(1, 1, W - 2, PANEL_H - 2, frame);
  rect(1, 1, W - 2, 1, light);
  rect(1, 1, 1, PANEL_H - 2, light);
  rect(1, PANEL_H - 2, W - 2, 1, dark);
  rect(W - 2, 1, 1, PANEL_H - 2, dark);
  // The screen, sunk by a dark rim, LED dots every 2 px.
  rect(SCREEN.x - 1, SCREEN.y - 1, SCREEN.w + 2, SCREEN.h + 2, dark);
  rect(SCREEN.x, SCREEN.y, SCREEN.w, SCREEN.h, screen);
  for (let y = SCREEN.y + 1; y < SCREEN.y + SCREEN.h; y += 2)
    for (let x = SCREEN.x + 1; x < SCREEN.x + SCREEN.w; x += 2) px(x, y, led);
  // Bolts in the corners and along the rails.
  const railY = SCREEN.y + SCREEN.h + 3;
  for (const x of [2, W / 4, W / 2, (3 * W) / 4, W - 4])
    for (const y of [2, railY + 3]) {
      rect(x, y, 2, 2, light);
      px(x + 1, y + 1, dark);
    }
  // Three status lamps on the bottom rail, right, and a nameplate, left.
  for (const [k, c] of ['#58d46a', '#f0b43c', '#f0483c'].entries()) {
    rect(W - 40 + k * 8, railY, 5, 4, outline);
    rect(W - 39 + k * 8, railY + 1, 3, 2, hex(c));
  }
  rect(16, railY, 64, 5, dark);
  rect(17, railY + 1, 62, 3, light);
  save('LED_BOARD', png, {
    id: 'LED_BOARD',
    name: 'LED Board',
    category: 'decor',
    type: 'asset',
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    backgroundTiles: 2,
    width: W,
    height: H,
    footprintW: W / 16,
    footprintH: H / 16,
  });
}

// ── LOBBY_BENCH ───────────────────────────────────────────────
{
  const W = 32;
  const H = 16;
  const { png, rect } = canvas(W, H);
  const outline = hex('#2a1a10');
  const wood = hex('#9a6234');
  const woodLight = hex('#c08048');
  const woodDark = hex('#6e4222');
  // Legs, then the seat edge, then the backrest's two planks (seen from behind).
  for (const x of [3, 26]) {
    rect(x, 9, 3, 7, outline);
    rect(x + 1, 9, 1, 6, woodDark);
  }
  rect(1, 9, 30, 3, outline);
  rect(2, 10, 28, 1, woodDark);
  for (const y of [1, 5]) {
    rect(0, y, 32, 4, outline);
    rect(1, y + 1, 30, 2, wood);
    rect(1, y + 1, 30, 1, woodLight);
  }
  for (const x of [4, 27]) rect(x, 0, 2, 10, outline);
  save('LOBBY_BENCH', png, {
    id: 'LOBBY_BENCH',
    name: 'Lobby Bench',
    category: 'chairs',
    type: 'group',
    groupType: 'rotation',
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: false,
    backgroundTiles: 0,
    members: [
      {
        type: 'asset',
        id: 'LOBBY_BENCH',
        file: 'LOBBY_BENCH.png',
        width: W,
        height: H,
        footprintW: 2,
        footprintH: 1,
        orientation: 'back',
      },
    ],
  });
}

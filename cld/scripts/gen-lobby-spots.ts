/**
 * GFX2: where the lobby art's lights are, so the title scene can animate them (lamp glow and
 * flicker, twinkling fairy lights, a few city windows going off and on). Found in the owner's
 * two lobby pictures by colour (art px), written to webview-ui/src/cld/gfx/lobbySpots.json.
 * The neon sign and the reception desk are placed by hand (below), measured on the pictures.
 *
 *   npx tsx cld/scripts/gen-lobby-spots.ts <path to lobby-bg/lobby>
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

const root = path.resolve(__dirname, '../..');
const OUT = path.join(root, 'webview-ui/src/cld/gfx/lobbySpots.json');

type Box = [x0: number, y0: number, x1: number, y1: number];
type Rgb = (r: number, g: number, b: number) => boolean;
/** A lamp: bright and warm. A fairy light: bright yellow. A lit city window: amber. */
const LAMP: Rgb = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b > 238 && r > 235 && g > 200;
const FAIRY: Rgb = (r, g, b) => r > 235 && g > 215 && b < 190;
const WINDOW: Rgb = (r, g, b) => r > 200 && g > 140 && b < 150;

/** Connected pieces of `ok` inside `box`: centre, width, height, size. */
function pieces(png: PNG, ok: Rgb, box: Box) {
  const [x0, y0, x1, y1] = box;
  const { width: w, data: d } = png;
  const seen = new Set<number>();
  const out: Array<{ x: number; y: number; w: number; h: number; n: number }> = [];
  const hit = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return ok(d[i], d[i + 1], d[i + 2]);
  };
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const k = y * w + x;
      if (seen.has(k) || !hit(x, y)) continue;
      const stack = [k];
      seen.add(k);
      let n = 0,
        sx = 0,
        sy = 0,
        a = x,
        b = x,
        c = y,
        e = y;
      while (stack.length) {
        const q = stack.pop()!;
        const qx = q % w;
        const qy = (q - qx) / w;
        n++;
        sx += qx;
        sy += qy;
        a = Math.min(a, qx);
        b = Math.max(b, qx);
        c = Math.min(c, qy);
        e = Math.max(e, qy);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = qx + dx;
          const ny = qy + dy;
          if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
          const r = ny * w + nx;
          if (!seen.has(r) && hit(nx, ny)) {
            seen.add(r);
            stack.push(r);
          }
        }
      }
      out.push({ x: Math.round(sx / n), y: Math.round(sy / n), w: b - a + 1, h: e - c + 1, n });
    }
  return out;
}

/** Up to `count` of `list`, spread out (every k-th). */
const spread = <T>(list: T[], count: number) =>
  list.length <= count ? list : list.filter((_, i) => i % Math.ceil(list.length / count) === 0);
const small = (p: { w: number; h: number }) => p.w >= 2 && p.w <= 5 && p.h >= 2 && p.h <= 5;

const ARTS = {
  wide: {
    file: 'title_scene_night_no_buttons_1672x941.png',
    fairy: [480, 680, 1140, 900] as Box,
    windows: [100, 0, 270, 280] as Box,
    neon: { x: 745, y: 170, w: 160, h: 85 },
    // In front of the counter (a receptionist is drawn behind it): standing, feet on the floor.
    desk: { seated: false, feetY: 560, xs: [745, 875] },
  },
  tall: {
    file: 'title_scene_alt_1448x1086.png',
    fairy: [440, 780, 1100, 1000] as Box,
    windows: [0, 30, 340, 300] as Box,
    neon: { x: 690, y: 195, w: 190, h: 90 },
    // Behind the empty counter, its top edge hiding the legs: seated, typing.
    desk: { seated: true, feetY: 482, xs: [728, 812] },
  },
};

const lobby = process.argv[2];
if (!lobby) throw new Error('usage: <lobby-bg/lobby>');
const out: Record<string, unknown> = {};
for (const [name, art] of Object.entries(ARTS)) {
  const png = PNG.sync.read(fs.readFileSync(path.join(lobby, art.file)));
  const lamps = pieces(png, LAMP, [0, 0, png.width, png.height])
    .filter((p) => p.n >= 150)
    .sort((a, b) => b.n - a.n)
    .slice(0, 20) // the lamps themselves; the smaller ones are their shine on the floor
    .map((p) => [p.x, p.y, Math.round(Math.max(p.w, p.h) * 1.6)]);
  const twinkles = spread(pieces(png, FAIRY, art.fairy).filter(small), 24).map((p) => [p.x, p.y]);
  const windows = spread(pieces(png, WINDOW, art.windows).filter(small), 10).map((p) => [
    p.x,
    p.y,
    p.w + 2,
    p.h + 2,
  ]);
  out[name] = {
    w: png.width,
    h: png.height,
    lamps,
    twinkles,
    windows,
    neon: art.neon,
    desk: art.desk,
  };
  console.log(name, lamps.length, 'lamps', twinkles.length, 'twinkles', windows.length, 'windows');
}
fs.writeFileSync(OUT, JSON.stringify(out) + '\n');

// Agent Tycoon app icon (acorn speech bubble, chosen 2026-11-04): draws three hand grids (16 favicon,
// 24 taskbar, 32 master) and writes every icon file of the web app and the desktop app from them.
//   node cld/scripts/app-icon.cjs        (rewrites the files in place; no dependency beyond pngjs)
// Rule for every size: the largest whole-number scale of one grid that fits (ties go to the larger
// grid), centred, the rest filled with the tile colour. The art is the one source; never resample.
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..', '..');
const TILE = '#6f42ff'; // --color-accent
// Tori's palette (webview-ui/src/cld/characters/mascots/tori.json) plus the tile
const PAL = {
  o: '#2e1c10',
  a: '#58321b',
  b: '#9a6640',
  c: '#7a4a2a',
  H: '#f2c98c',
  M: '#dda05c',
  S: '#b07738',
  e: '#f08a6a',
  g: '#8a2020',
  j: '#ffffff',
  k: '#0c0c14',
  l: '#5a3016',
  P: TILE,
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const grid = (N) => Array.from({ length: N }, () => Array(N).fill(PAL.P));
const px = (g, x, y, c) => {
  if (y >= 0 && y < g.length && x >= 0 && x < g.length) g[y][x] = PAL[c];
};
const rect = (g, x, y, w, h, c) => {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px(g, i, j, c);
};

// bubble = cell mask (rect + tail cells); the outline is the 4-neighbour ring around it, so corners come out rounded
function bubble(g, x, y, w, h, tail) {
  const cells = new Set();
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) cells.add(`${i},${j}`);
  for (const [i, j] of tail) cells.add(`${i},${j}`);
  for (const key of cells) {
    const [i, j] = key.split(',').map(Number);
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ])
      if (!cells.has(`${i + di},${j + dj}`)) px(g, i + di, j + dj, 'o');
  }
  for (const key of cells) {
    const [i, j] = key.split(',').map(Number);
    px(g, i, j, 'M');
  }
}
// acorn cap: dome from yTop to the brim row, x0..x1 at the brim, cross-hatch, stem above
function cap(g, x0, x1, yTop, yBrim) {
  for (let y = yTop; y < yBrim; y++) {
    const r = y - yTop,
      inset = r === 0 ? 3 : r === 1 ? 2 : 1,
      a = x0 + inset,
      b = x1 - inset;
    for (let x = a; x <= b; x++)
      px(g, x, y, r === 0 ? 'b' : (x + y) % 4 === 0 || (x - y + 64) % 4 === 0 ? 'a' : 'c');
    px(g, a - 1, y, 'o');
    px(g, b + 1, y, 'o');
    if (r === 0) for (let x = a - 1; x <= b + 1; x++) px(g, x, y - 1, 'o');
    if (r === 1) {
      px(g, a - 1, y - 1, 'o');
      px(g, b + 1, y - 1, 'o');
    }
  }
  rect(g, x0, yBrim, x1 - x0 + 1, 1, 'a');
  const s = (x0 + x1 + 1) >> 1;
  px(g, s, yTop - 3, 'o');
  px(g, s, yTop - 2, 'a');
  px(g, s - 1, yTop - 2, 'o');
  px(g, s + 1, yTop - 2, 'o');
}
// chunky tail: right-angle triangle of n rows under the bubble, hugging its left edge at x
const tail = (x, y, n) => {
  const out = [];
  for (let t = 0; t < n; t++) for (let k = 0; k < n - t; k++) out.push([x + k, y + t]);
  return out;
};

// Tori's face as the bubble body; faceSize 1 = 16 grid, 2 = 24 grid, 3 = 32 grid
function toriBubble(g, x, y, w, h, t, faceSize) {
  bubble(g, x, y, w, h, t);
  rect(g, x, y, 1, h, 'H');
  rect(g, x, y + h - 1, w, 1, 'S');
  rect(g, x + w - 1, y, 1, h, 'S');
  for (const [i, j] of t) px(g, i, j, 'S');
  const cx = x + (w >> 1);
  if (faceSize === 3) {
    const ey = y + 2,
      dx = Math.max(3, w >> 2);
    for (const ex of [cx - dx - 1, cx + dx - 1]) {
      rect(g, ex, ey, 2, 3, 'k');
      px(g, ex, ey, 'j');
    }
    px(g, cx - dx - 3, ey + 3, 'e');
    px(g, cx + dx + 2, ey + 3, 'e');
    rect(g, cx - 2, ey + 4, 4, 1, 'l');
    rect(g, cx - 1, ey + 5, 2, 1, 'g');
    px(g, cx - 2, ey + 5, 'l');
    px(g, cx + 1, ey + 5, 'l');
  } else if (faceSize === 2) {
    const ey = y + 2,
      dx = Math.max(3, w >> 2);
    for (const ex of [cx - dx - 1, cx + dx - 1]) {
      px(g, ex, ey, 'j');
      px(g, ex + 1, ey, 'k');
      rect(g, ex, ey + 1, 2, 1, 'k');
    }
    px(g, cx - dx - 2, ey + 2, 'e');
    px(g, cx + dx + 1, ey + 2, 'e');
    rect(g, cx - 1, ey + 3, 2, 1, 'g');
  } else {
    const ey = y + 1,
      dx = Math.max(2, w >> 2);
    px(g, cx - dx - 1, ey, 'k');
    px(g, cx + dx, ey, 'k');
    rect(g, cx - 1, ey + 2, 2, 1, 'g');
  }
}
function acorn(N) {
  const g = grid(N);
  if (N === 32) {
    cap(g, 4, 27, 4, 10);
    toriBubble(g, 5, 11, 22, 13, tail(7, 24, 5), 3);
  } else if (N === 24) {
    cap(g, 2, 21, 3, 7);
    toriBubble(g, 3, 8, 18, 10, tail(5, 18, 4), 2);
  } else {
    cap(g, 1, 14, 2, 5);
    toriBubble(g, 2, 6, 12, 6, tail(3, 12, 3), 1);
  }
  return g;
}
const GRIDS = { 16: acorn(16), 24: acorn(24), 32: acorn(32) };

// grid pixel = `scale` px, centred in out x out, the rest tile colour
function render(g, scale, out) {
  const N = g.length,
    off = Math.floor((out - N * scale) / 2),
    buf = Buffer.alloc(out * out * 4);
  for (let Y = 0; Y < out; Y++)
    for (let X = 0; X < out; X++) {
      const gx = Math.floor((X - off) / scale),
        gy = Math.floor((Y - off) / scale);
      const inside = gx >= 0 && gy >= 0 && gx < N && gy < N;
      buf.set([...hex(inside ? g[gy][gx] : TILE), 255], (Y * out + X) * 4);
    }
  return buf;
}
function plan(size) {
  let best = null;
  for (const n of [16, 24, 32]) {
    const s = Math.floor(size / n);
    if (s >= 1 && (!best || n * s >= best.n * best.s)) best = { n, s };
  }
  return best;
}
const pngOf = (size, scale, n) => {
  const p = new PNG({ width: size, height: size });
  render(GRIDS[n], scale, size).copy(p.data);
  return PNG.sync.write(p);
};
const sized = (size) => {
  const { n, s } = plan(size);
  return pngOf(size, s, n);
};

const written = [];
const put = (rel, data) => {
  const f = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  written.push(rel);
};
const putSized = (rel, size) => put(rel, sized(size));

// PNG-in-ICO, entries small to large
function ico(sizes) {
  const blobs = sizes.map(sized);
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((sz, i) => {
    const o = 6 + 16 * i;
    head[o] = sz >= 256 ? 0 : sz;
    head[o + 1] = sz >= 256 ? 0 : sz;
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(blobs[i].length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += blobs[i].length;
  });
  return Buffer.concat([head, ...blobs]);
}
// icns: PNG payloads (macOS 10.7+); type -> pixel size
function icns() {
  const types = {
    icp4: 16,
    icp5: 32,
    ic11: 32,
    icp6: 64,
    ic12: 64,
    ic07: 128,
    ic08: 256,
    ic13: 256,
    ic09: 512,
    ic14: 512,
    ic10: 1024,
  };
  const parts = Object.entries(types).map(([type, size]) => {
    const data = sized(size),
      h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([h, data]);
  });
  const total = 8 + parts.reduce((n, p) => n + p.length, 0),
    head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...parts]);
}

// ---- web app (webview-ui/public)
const WEB = 'webview-ui/public';
put(`${WEB}/favicon.ico`, ico([16, 24, 32, 48, 64, 256]));
for (const s of [16, 32, 192, 256, 512]) putSized(`${WEB}/icons/icon-${s}.png`, s);
put(`${WEB}/icons/icon-maskable-512.png`, pngOf(512, 12, 32)); // art at 75%: inside the 80% safe circle
for (const f of ['apple-touch-icon.png', 'apple-touch-icon-precomposed.png'])
  put(`${WEB}/${f}`, pngOf(180, 5, 32)); // 32 grid x5 + 10px tile border (the fit rule would pick the 16 grid)
putSized('icon.png', 128); // README / repository picture

// ---- desktop app (tauri.conf.json bundle.icon + Windows tiles)
const ICONS = 'cld/desktop/src-tauri/icons';
putSized(`${ICONS}/32x32.png`, 32);
putSized(`${ICONS}/64x64.png`, 64);
putSized(`${ICONS}/128x128.png`, 128);
putSized(`${ICONS}/128x128@2x.png`, 256);
putSized(`${ICONS}/icon.png`, 512);
put(`${ICONS}/icon.ico`, ico([16, 24, 32, 48, 64, 256]));
put(`${ICONS}/icon.icns`, icns());
for (const s of [30, 44, 71, 89, 107, 142, 150, 284, 310])
  putSized(`${ICONS}/Square${s}x${s}Logo.png`, s);
putSized(`${ICONS}/StoreLogo.png`, 50);

// ---- android launcher (legacy square + round share the art; the adaptive foreground keeps it inside 66%)
for (const [dir, base] of Object.entries({
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
})) {
  for (const f of ['ic_launcher', 'ic_launcher_round'])
    putSized(`${ICONS}/android/mipmap-${dir}/${f}.png`, base); // ponytail: round is not circle-masked, the OS masks it
  const fg = base * 2.25;
  put(
    `${ICONS}/android/mipmap-${dir}/ic_launcher_foreground.png`,
    pngOf(fg, Math.floor((fg * 0.66) / 32), 32),
  );
}
put(
  `${ICONS}/android/values/ic_launcher_background.xml`,
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">${TILE.toUpperCase()}</color>\n</resources>`,
);

// ---- ios (opaque, same rule)
for (const f of fs.readdirSync(path.join(ROOT, ICONS, 'ios'))) {
  const m = /^AppIcon-(\d+(?:\.\d+)?)x\1@(\d)x(?:-1)?\.png$/.exec(f);
  const size = m ? Math.round(Number(m[1]) * Number(m[2])) : f === 'AppIcon-512@2x.png' ? 1024 : 0;
  if (size) putSized(`${ICONS}/ios/${f}`, size);
}
console.log(`[app-icon] wrote ${written.length} files`);

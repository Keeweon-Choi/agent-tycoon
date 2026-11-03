#!/usr/bin/env node
/**
 * WALK-FIX: audit the walk cells of iso8 character sheets (2304×3168) from their alpha: rows 1
 * (three-quarter front), 2 (three-quarter back) and 5 (right side), columns 1 (idle), 2 and 3
 * (the steps) and 8 (the walking neutral). Per cell: the figure's height, width, head top and
 * feet baseline against the idle's, the opaque segments across the legs (more than 2 = an extra
 * leg or a loose prop), the feet on the baseline, ghost pixels (translucent, away from anything
 * opaque: a faint duplicate figure), and a flag list. Heuristics: a flag says "look here".
 *
 *   node cld/scripts/walk-audit.mjs <dir of sheets> <out dir>
 * Writes <out dir>/audit.txt and audit-<name>.png per sheet: a contact sheet at 1/2 (columns
 * idle, 2, 8, 3: the play order 2 → 8 → 3 → 8) with the idle's head and feet lines in green,
 * a cell's own in red where they differ, and a red block per flag above it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const [srcDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const CW = 288,
  CH = 528,
  ROWS = [0, 1, 4],
  COLS = [0, 1, 7, 2];
const ROWN = { 0: 'r1 3/4front', 1: 'r2 3/4back', 4: 'r5 side' };

function load(f) {
  return PNG.sync.read(fs.readFileSync(f));
}
function cell(img, r, c) {
  const a = new Uint8Array(CW * CH),
    rgba = new Uint8Array(CW * CH * 4);
  for (let y = 0; y < CH; y++)
    for (let x = 0; x < CW; x++) {
      const i = ((r * CH + y) * img.width + c * CW + x) * 4,
        j = y * CW + x;
      a[j] = img.data[i + 3];
      rgba.set(img.data.subarray(i, i + 4), j * 4);
    }
  return { a, rgba };
}
function metrics(cl) {
  const { a } = cl;
  let top = CH,
    bot = -1,
    left = CW,
    right = -1,
    sx = 0,
    n = 0;
  for (let y = 0; y < CH; y++)
    for (let x = 0; x < CW; x++)
      if (a[y * CW + x] >= 128) {
        if (y < top) top = y;
        if (y > bot) bot = y;
        if (x < left) left = x;
        if (x > right) right = x;
        sx += x;
        n++;
      }
  const h = bot - top + 1,
    w = right - left + 1;
  // runs per scanline (opaque segments wider than 3 px)
  const runsAt = (y) => {
    const segs = [];
    let s = -1;
    for (let x = 0; x <= CW; x++) {
      const on = x < CW && a[y * CW + x] >= 128;
      if (on && s < 0) s = x;
      else if (!on && s >= 0) {
        if (x - s > 3) segs.push([s, x - 1]);
        s = -1;
      }
    }
    return segs;
  };
  // leg zone: from 70% to 97% of the figure height; the typical number of segments there
  const legCounts = [];
  for (let y = top + Math.round(h * 0.72); y < top + Math.round(h * 0.96); y += 4)
    legCounts.push(runsAt(y).length);
  const mode = (arr) => {
    const m = new Map();
    for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
    return [...m].sort((p, q) => q[1] - p[1])[0]?.[0];
  };
  const legs = mode(legCounts),
    legsMax = Math.max(...legCounts);
  // torso zone (arms): 40%..65%
  const armCounts = [];
  for (let y = top + Math.round(h * 0.4); y < top + Math.round(h * 0.65); y += 4)
    armCounts.push(runsAt(y).length);
  const armsMax = Math.max(...armCounts),
    armsMode = mode(armCounts);
  // ghost pixels: translucent (24..200) with no opaque (>=240) pixel within 2 px
  let ghost = 0;
  for (let y = 2; y < CH - 2; y++)
    for (let x = 2; x < CW - 2; x++) {
      const v = a[y * CW + x];
      if (v < 24 || v > 200) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if (a[(y + dy) * CW + x + dx] >= 240) {
            near = true;
            break;
          }
      if (!near) ghost++;
    }
  // feet baseline: lowest row with >= 6 opaque px; feet width: widest run count at bottom 6%
  let feetY = bot;
  for (let y = bot; y > top; y--) {
    if (runsAt(y).reduce((s, [p, q]) => s + q - p + 1, 0) >= 6) {
      feetY = y;
      break;
    }
  }
  const feetSegs = [];
  for (let y = feetY - Math.round(h * 0.06); y <= feetY; y += 2) feetSegs.push(runsAt(y));
  const feet = Math.max(...feetSegs.map((s) => s.length));
  const feetSpan = Math.max(
    ...feetSegs.map((s) => (s.length ? s[s.length - 1][1] - s[0][0] + 1 : 0)),
  );
  return {
    top,
    bot,
    left,
    right,
    h,
    w,
    cx: Math.round(sx / n),
    n,
    legs,
    legsMax,
    armsMode,
    armsMax,
    ghost,
    feetY,
    feet,
    feetSpan,
    legCounts,
    armCounts,
  };
}

const report = [];
for (const f of fs
  .readdirSync(srcDir)
  .filter((f) => f.endsWith('.png'))
  .sort()) {
  const name = f.replace('.png', '');
  const img = load(path.join(srcDir, f));
  if (img.width !== 2304 || img.height !== 3168) {
    report.push(`${name}: ${img.width}x${img.height} skipped`);
    continue;
  }
  const S = 2; // contact sheet at 1/2
  const cw = CW / S,
    ch = CH / S,
    pad = 6,
    labelH = 10;
  const out = new PNG({
    width: COLS.length * (cw + pad) + pad,
    height: ROWS.length * (ch + pad + labelH) + pad,
  });
  out.data.fill(0);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 40;
    out.data[i + 1] = 40;
    out.data[i + 2] = 48;
    out.data[i + 3] = 255;
  }
  const px = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
    const i = (y * out.width + x) * 4;
    out.data[i] = r;
    out.data[i + 1] = g;
    out.data[i + 2] = b;
    out.data[i + 3] = 255;
  };
  report.push(`== ${name}`);
  ROWS.forEach((r, ri) => {
    const ms = COLS.map((c) => ({ c, m: metrics(cell(img, r, c)) }));
    const idle = ms[0].m;
    COLS.forEach((c, ci) => {
      const cl = cell(img, r, c),
        m = ms[ci].m;
      const ox = pad + ci * (cw + pad),
        oy = pad + ri * (ch + pad + labelH) + labelH;
      for (let y = 0; y < ch; y++)
        for (let x = 0; x < cw; x++) {
          const i = (y * S * CW + x * S) * 4;
          const al = cl.rgba[i + 3] / 255;
          const bg = (x + y) % 2 ? 70 : 78;
          px(
            ox + x,
            oy + y,
            cl.rgba[i] * al + bg * (1 - al),
            cl.rgba[i + 1] * al + bg * (1 - al),
            cl.rgba[i + 2] * al + bg * (1 - al),
          );
        }
      // idle's head and feet lines in green across every cell of the row; this frame's in red if off by >6 px
      for (let x = 0; x < cw; x++) {
        px(ox + x, oy + Math.round(idle.top / S), 0, 220, 0);
        px(ox + x, oy + Math.round(idle.feetY / S), 0, 220, 0);
      }
      const flags = [];
      if (Math.abs(m.top - idle.top) > 8) {
        flags.push(`head ${m.top - idle.top > 0 ? '+' : ''}${m.top - idle.top}`);
        for (let x = 0; x < cw; x++) px(ox + x, oy + Math.round(m.top / S), 255, 40, 40);
      }
      if (Math.abs(m.feetY - idle.feetY) > 6) {
        flags.push(`feet ${m.feetY - idle.feetY > 0 ? '+' : ''}${m.feetY - idle.feetY}`);
        for (let x = 0; x < cw; x++) px(ox + x, oy + Math.round(m.feetY / S), 255, 40, 40);
      }
      if (Math.abs(m.h - idle.h) > 10) flags.push(`height ${m.h} vs ${idle.h}`);
      if (Math.abs(m.w - idle.w) > 30) flags.push(`width ${m.w} vs ${idle.w}`);
      if (m.legsMax > 2) flags.push(`legs max ${m.legsMax} (mode ${m.legs})`);
      if (c !== 0 && m.legs < 2 && m.feet < 2)
        flags.push(`one leg (segments ${m.legs}, feet ${m.feet})`);
      if (m.armsMax > 3) flags.push(`arms: ${m.armsMax} segments at torso`);
      if (m.ghost > 150) flags.push(`ghost px ${m.ghost}`);
      // flag bar: red block in the label strip per flag
      flags.forEach((_, k) => {
        for (let y = 0; y < labelH - 2; y++)
          for (let x = 0; x < 8; x++) px(ox + k * 10 + x, oy - labelH + y, 255, 60, 60);
      });
      report.push(
        `${ROWN[r].padEnd(12)} col${String(c + 1).padEnd(2)} h=${m.h} w=${m.w} top=${m.top} feet=${m.feetY} cx=${m.cx} legs=${m.legs}/${m.legsMax} feet=${m.feet} span=${m.feetSpan} arms=${m.armsMode}/${m.armsMax} ghost=${m.ghost}  ${flags.length ? 'FLAGS: ' + flags.join('; ') : 'ok'}`,
      );
    });
  });
  fs.writeFileSync(path.join(outDir, `audit-${name}.png`), PNG.sync.write(out));
}
fs.writeFileSync(path.join(outDir, 'audit.txt'), report.join('\n') + '\n');
console.log(report.join('\n'));

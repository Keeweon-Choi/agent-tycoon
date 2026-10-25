import { describe, expect, it } from 'vitest';

import {
  baseOf,
  check,
  contours,
  decontaminate,
  fitFloor,
  fitWall,
  HH,
  HW,
  matte,
  mirrorCut,
  mirrorOut,
  type Out,
  type Raw,
  resampleUniform,
  resampleWall,
} from '../../../cld/scripts/lib/isoObjects.js';

/** A picture on the owner's backdrop (magenta with a little noise); `paint` draws the object. */
function onMagenta(
  w: number,
  h: number,
  paint: (set: (x: number, y: number, c: number[]) => void) => void,
): Raw {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const n = (i * 2654435761) % 13; // deterministic noise, as the generated pictures have
    data.set([245 + (n % 6), 6 + n, 245 + ((n * 3) % 6), 255], i * 4);
  }
  paint((x, y, c) => data.set([c[0], c[1], c[2], 255], (y * w + x) * 4));
  return { w, h, data };
}

const mix = (a: number[], b: number[], t: number) =>
  a.map((v, i) => Math.round(v + (b[i] - v) * t));
const MAGENTA = [248, 8, 248];

describe('matte', () => {
  it('reads the backdrop from the border and keeps only the object, with a clean edge', () => {
    const edge = mix([200, 60, 40], MAGENTA, 0.3); // a blended rim pixel, mostly the object
    const img = onMagenta(60, 40, (set) => {
      for (let y = 10; y < 30; y++)
        for (let x = 15; x < 45; x++) {
          const rim = x === 15 || y === 10 || x === 44 || y === 29;
          set(x, y, rim ? edge : [200, 60, 40]);
        }
    });
    const cut = matte(img);
    expect(Math.abs(cut.bg[0] - 248)).toBeLessThan(8);
    expect(cut.bg[1]).toBeLessThan(20);
    // The object, trimmed: nothing of the backdrop in the box.
    expect([cut.w, cut.h]).toEqual([30, 20]);
    expect(cut.mask.every((m) => m === 1)).toBe(true);
    // The tinted rim is not trusted for colour, the inside is.
    const clean = cut.clean.reduce((a, b) => a + b, 0);
    expect(clean).toBeLessThan(30 * 20);
    expect(clean).toBeGreaterThan(20 * 10);
    expect(cut.border).toBe(0);
  });

  it('drops specks, keeps pieces joined across a small gap, and counts an object on the border', () => {
    const img = onMagenta(200, 100, (set) => {
      for (let y = 20; y < 80; y++) for (let x = 20; x < 90; x++) set(x, y, [40, 90, 200]);
      // A wheel 8 px off the body: still the object's.
      for (let y = 40; y < 60; y++) for (let x = 98; x < 118; x++) set(x, y, [40, 90, 200]);
      // A speck far away.
      for (let y = 5; y < 7; y++) for (let x = 170; x < 172; x++) set(x, y, [40, 90, 200]);
    });
    const cut = matte(img);
    expect(cut.w).toBe(118 - 20);
    const onEdge = onMagenta(50, 50, (set) => {
      for (let y = 0; y < 20; y++) for (let x = 10; x < 30; x++) set(x, y, [10, 200, 10]);
    });
    expect(matte(onEdge).border).toBeGreaterThan(0);
  });
});

describe('floor fit', () => {
  /** A 1280x640 diamond (the owner's tile pictures), `c` inside, the backdrop outside. */
  const diamond = (c: (u: number, v: number) => number[]) =>
    onMagenta(1400, 700, (set) => {
      for (let y = 0; y < 640; y++)
        for (let x = 0; x < 1280; x++) {
          const a = (x + 0.5 - 640) / 640;
          const b = (y + 0.5) / 320;
          const u = (a + b) / 2;
          const v = (b - a) / 2;
          if (u > 0 && v > 0 && u < 1 && v < 1) set(x + 60, y + 30, c(u, v));
        }
    });

  it('maps the top face on the 192x96 diamond: exact size, corners transparent, colours kept', () => {
    const cut = matte(diamond((u, v) => (u + v < 1 ? [200, 150, 90] : [90, 130, 200])));
    const f = fitFloor(cut, 0.01);
    expect([f.out.w, f.out.h]).toEqual([2 * HW, 2 * HH]);
    const px = (x: number, y: number) => [
      ...f.out.data.subarray((y * f.out.w + x) * 4, (y * f.out.w + x) * 4 + 4),
    ];
    expect(px(0, 0)[3]).toBe(0);
    expect(px(2 * HW - 1, 2 * HH - 1)[3]).toBe(0);
    expect(px(HW, HH)[3]).toBe(255);
    // u + v < 1 is the diamond's upper half... a colour per half, averaged without leaking.
    expect(px(HW, 10).slice(0, 3)).toEqual([200, 150, 90]);
    expect(px(HW, 2 * HH - 10).slice(0, 3)).toEqual([90, 130, 200]);
    expect(f.err.ratio).toBeLessThan(1.5);
    expect(f.err.skew).toBeLessThan(1.5);
    // Exactly the diamond: every pixel whose centre is inside it, no other.
    for (let y = 0; y < 2 * HH; y++)
      for (let x = 0; x < 2 * HW; x++) {
        const a = (x + 0.5 - HW) / HW;
        const b = (y + 0.5) / HH;
        const inside = (a + b) / 2 > 0 && (b - a) / 2 > 0 && (a + b) / 2 < 1 && (b - a) / 2 < 1;
        expect(px(x, y)[3] === 255, `${x},${y}`).toBe(inside);
      }
    expect(check(f.out)).toMatchObject({ magenta: 0, halo: 0 });
  });
});

describe('object fit', () => {
  it('finds the base centre and width of a box, and scales uniformly without changing colour', () => {
    // A box 400 wide whose base is a diamond (bottom V), 300 tall above it.
    const img = onMagenta(500, 600, (set) => {
      for (let y = 0; y < 560; y++)
        for (let x = 50; x < 450; x++) {
          const d = Math.abs(x - 250) / 2; // the V's rise from the lowest point at x = 250
          if (y < 560 - 200 + d) set(x, y, [120, 130, 140]);
        }
    });
    const cut = matte(img);
    const base = baseOf(cut);
    expect(base.w).toBeGreaterThan(300);
    expect(Math.abs(base.cx - cut.w / 2)).toBeLessThan(4);
    const r = resampleUniform(cut, 0.5, [base.cx, base.cy], [0, 0]);
    expect(Math.abs(r.out.w - cut.w * 0.5)).toBeLessThanOrEqual(1);
    // Flat colour in, flat colour out (area averaging, no palette, no halo).
    for (let i = 0; i < r.out.w * r.out.h; i++)
      if (r.out.data[i * 4 + 3])
        expect([...r.out.data.subarray(i * 4, i * 4 + 3)]).toEqual([120, 130, 140]);
  });

  it('mirrors a picture exactly (twice is the identity)', () => {
    const o: Out = { w: 5, h: 2, data: new Uint8Array(5 * 2 * 4).map((_, i) => (i * 37) % 251) };
    const m = mirrorOut(o);
    expect([...m.data.subarray(0, 4)]).toEqual([...o.data.subarray(16, 20)]);
    expect([...mirrorOut(m).data]).toEqual([...o.data]);
    const cut = matte(
      onMagenta(40, 40, (set) => {
        for (let y = 5; y < 20; y++) for (let x = 5; x < 25; x++) set(x, y, [10, 120, 10 + x]);
      }),
    );
    const mm = mirrorCut(mirrorCut(cut));
    expect([...mm.rgb]).toEqual([...cut.rgb]);
  });
});

describe('wall fit', () => {
  /** A wall running down to the right on a 1:2 base: `run` px along, `height` tall, 12 px of
   *  end face at the right whose base rises again. */
  const wall = (run: number, height: number, slope = 0.5) =>
    matte(
      onMagenta(run + 200, run * slope + height + 120, (set) => {
        for (let x = 0; x < run + 12; x++) {
          const base = 40 + height + Math.round((x < run ? x : run - (x - run)) * slope);
          for (let y = base - height; y <= base; y++)
            set(x + 20, y, y > base - 12 ? [150, 90, 40] : [240, 225, 190]);
        }
      }),
    );

  it('measures the run, the base slope and the height, away from the end face', () => {
    const f = fitWall(wall(400, 300));
    expect(Math.abs(f.run - 400)).toBeLessThanOrEqual(2);
    expect(Math.abs(f.slope - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(f.height - 301)).toBeLessThanOrEqual(2);
    expect(f.dev).toBeLessThan(1.5);
  });

  it('refits the run to a whole number of tiles on the exact 1:2 slope, at the asked height', () => {
    // A source slope a little off 1:2 (0.53): the output base is exactly 1:2 per tile.
    const cut = wall(480, 300, 0.53);
    const f = fitWall(cut);
    const tiles = 3;
    const r = resampleWall(cut, f, (tiles * HW) / f.run, 576 / f.height);
    const { bot } = contours({
      ...cut,
      w: r.out.w,
      h: r.out.h,
      rgb: new Uint8Array(0),
      clean: new Uint8Array(0),
      mask: r.out.data.filter((_, i) => i % 4 === 3).map((a) => (a ? 1 : 0)),
    });
    // Base height at the run's start and one tile along: HH apart (to a pixel).
    const [ax, ay] = r.anchor;
    for (let j = 0; j <= tiles; j++) {
      const x = Math.min(r.out.w - 1, ax + j * HW - (j === tiles ? 1 : 0));
      expect(Math.abs(bot[x] + 1 - (ay + j * HH)), `tile ${j}`).toBeLessThanOrEqual(2);
    }
    // The wall's height at a column: cap to base.
    const col = ax + HW;
    const top =
      [...Array(r.out.h).keys()].find((y) => r.out.data[(y * r.out.w + col) * 4 + 3]) ?? 0;
    expect(Math.abs(bot[col] - top + 1 - 576)).toBeLessThanOrEqual(3);
  });
});

describe('decontaminate', () => {
  it('takes the backdrop tint off a rim pixel and leaves natural colours alone', () => {
    const o: Out = { w: 9, h: 5, data: new Uint8Array(9 * 5 * 4) };
    const put = (x: number, y: number, c: number[]) => o.data.set([...c, 255], (y * 9 + x) * 4);
    for (let y = 1; y < 4; y++) for (let x = 1; x < 8; x++) put(x, y, [60, 90, 60]);
    put(4, 1, [110, 40, 110]); // a purple rim pixel
    put(5, 1, [200, 120, 40]); // a brown-orange one: not a tint
    expect(check(o).halo).toBe(1);
    decontaminate(o);
    expect(check(o).halo).toBe(0);
    expect([...o.data.subarray((1 * 9 + 5) * 4, (1 * 9 + 5) * 4 + 3)]).toEqual([200, 120, 40]);
    expect(o.data[(1 * 9 + 4) * 4 + 1]).toBe(40); // green untouched
  });
});

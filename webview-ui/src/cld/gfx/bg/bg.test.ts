import { describe, expect, it } from 'vitest';

import { DEFAULT_BACKGROUND, nextSeed, parseBackground } from '../../../../../core/src/cld/background.js';
import { BG_BLOCK_TILES, BG_DAY_END_HOUR, BG_DAY_START_HOUR } from '../../../constants.js';
import { isDayAt, isNight } from './clock.js';
import {
  axisCell,
  objectBox,
  objectsIn,
  plotKind,
  plotSpan,
} from './layout.js';
import PALETTES from './palette.json';
import { backgroundHandleMessage, backgroundSettings, resetBackground } from './settings.js';

const FP = { cols: 24, rows: 14 };
const RANGE = { k0: -3, k1: 3, l0: -3, l1: 3 };
const BOX = { x0: -112, y0: -300, x1: 192, y1: 190 };

describe('BACKGROUND layout', () => {
  it('the same seed puts everything in the same place, another seed does not', () => {
    const a = objectsIn(5, 'mixed', FP, RANGE, BOX);
    expect(objectsIn(5, 'mixed', FP, RANGE, BOX)).toEqual(a);
    expect(objectsIn(6, 'mixed', FP, RANGE, BOX)).not.toEqual(a);
  });

  it('a wider range only adds objects: each plot is the same wherever the drawing starts', () => {
    const narrow = objectsIn(9, 'mixed', FP, { k0: -1, k1: 1, l0: -1, l1: 1 }, BOX);
    const wide = objectsIn(9, 'mixed', FP, RANGE, BOX);
    for (const o of narrow) expect(wide).toContainEqual(o);
    expect(wide.length).toBeGreaterThan(narrow.length);
  });

  it('day and night share every position: one layout, two palettes of the same shape', () => {
    // The layout takes no palette; the palettes must offer the same pieces to draw it with.
    const { night, day } = PALETTES;
    expect(day.skyline.length).toBe(night.skyline.length);
    expect(day.house.roofs.length).toBe(night.house.roofs.length);
    expect(Object.keys(day.ground).sort()).toEqual(Object.keys(night.ground).sort());
    expect(day.tower.p).toBe(night.tower.p);
    expect(day.house.p).toBe(night.house.p);
  });

  it('the surroundings decide what stands round the building', () => {
    const kinds = (mix: 'houses' | 'towers' | 'mixed') => {
      const set = new Set<string>();
      for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) set.add(plotKind(3, mix, i, j));
      return set;
    };
    expect(kinds('houses').has('tower')).toBe(false);
    expect(kinds('towers').has('houses')).toBe(false);
    expect(kinds('mixed').has('tower') && kinds('mixed').has('houses')).toBe(true);
  });

  it('keeps the two empty plots and the main one free of towers and houses', () => {
    expect(plotKind(1, 'mixed', 0, 0)).toBe('main');
    expect(plotKind(1, 'mixed', 1, 0)).toBe('empty');
    expect(plotKind(1, 'mixed', 0, 1)).toBe('empty');
    const none = { x0: 1e9, y0: 1e9, x1: 1e9, y1: 1e9 };
    for (const o of objectsIn(1, 'mixed', FP, { k0: 0, k1: 1, l0: 0, l1: 1 }, none)) {
      const where = [axisCell(Math.floor(o.a), FP.cols).plot, axisCell(Math.floor(o.b), FP.rows).plot];
      const home = plotKind(1, 'mixed', where[0], where[1]);
      if (home === 'main' || home === 'empty') expect(['tree', 'lamp']).toContain(o.kind);
    }
  });

  it('no tower or house stands in the way of the building', () => {
    for (const mix of ['houses', 'towers', 'mixed'] as const)
      for (const o of objectsIn(2, mix, FP, RANGE, BOX).filter((x) => x.kind === 'tower' || x.kind === 'house')) {
        const b = objectBox(o);
        const apart = b.x1 < BOX.x0 || b.x0 > BOX.x1 || b.y1 < BOX.y0 || b.y0 > BOX.y1;
        expect(apart).toBe(true);
      }
  });

  it('roads and plots tile the axis without a gap, both ways from the main plot', () => {
    for (const len of [14, 24]) {
      for (let k = -4; k <= 4; k++) {
        const { start, n } = plotSpan(k, len);
        for (let t = 0; t < n; t++) {
          const c = axisCell(start + t, len);
          expect(c).toMatchObject({ plot: k, t, n, road: -1 });
        }
        // The road after it (away from the main plot) is three tiles of road.
        const away = k >= 0 ? start + n : start - 1;
        expect(axisCell(away, len).road).toBe(0);
      }
    }
    expect(plotSpan(1, 24).n).toBe(BG_BLOCK_TILES);
  });
});

describe('BACKGROUND clock', () => {
  const at = (h: number, m: number) => Date.UTC(2026, 10, 1, h, m);
  it('is day from 06:00 up to, not including, 18:00 on the host clock', () => {
    expect(BG_DAY_START_HOUR).toBe(6);
    expect(BG_DAY_END_HOUR).toBe(18);
    expect(isDayAt(at(5, 59), 0)).toBe(false);
    expect(isDayAt(at(6, 0), 0)).toBe(true);
    expect(isDayAt(at(17, 59), 0)).toBe(true);
    expect(isDayAt(at(18, 0), 0)).toBe(false);
    expect(isDayAt(at(0, 0), 0)).toBe(false);
  });

  it('reads the host clock, not the screen\'s', () => {
    // 21:30 UTC is 06:30 the next morning in Seoul (+540).
    expect(isDayAt(at(21, 30), 540)).toBe(true);
    expect(isDayAt(at(21, 30), 0)).toBe(false);
  });

  it('lets the setting override the clock', () => {
    expect(isNight('day', at(2, 0), 0)).toBe(false);
    expect(isNight('night', at(12, 0), 0)).toBe(true);
    expect(isNight('clock', at(12, 0), 0)).toBe(false);
    expect(isNight('clock', at(2, 0), 0)).toBe(true);
  });
});

describe('BACKGROUND settings', () => {
  it('parses what the daemon stores and refuses the rest', () => {
    const ok = { time: 'night', mix: 'towers', seed: 42 };
    expect(parseBackground(ok)).toEqual(ok);
    expect(parseBackground({ ...ok, extra: 1 })).toEqual(ok);
    for (const bad of [null, 3, {}, { ...ok, time: 'dusk' }, { ...ok, mix: 'x' }, { ...ok, seed: -1 }, { ...ok, seed: 1.5 }, { ...ok, seed: 2 ** 31 }])
      expect(parseBackground(bad)).toBeNull();
  });

  it('a daemon message becomes the screen\'s setting, a bad one is ignored', () => {
    resetBackground();
    expect(backgroundSettings()).toEqual(DEFAULT_BACKGROUND);
    backgroundHandleMessage({ type: 'officeBackground', time: 'day', mix: 'houses', seed: 7 });
    expect(backgroundSettings()).toEqual({ time: 'day', mix: 'houses', seed: 7 });
    backgroundHandleMessage({ type: 'officeBackground', time: 'dusk', mix: 'houses', seed: 7 } as never);
    expect(backgroundSettings().time).toBe('day');
    resetBackground();
  });

  it('a new seed is a whole number in range and never the one in use', () => {
    for (const r of [0, 0.5, 0.999999]) {
      const s = nextSeed(1101, () => r);
      expect(Number.isInteger(s)).toBe(true);
      expect(parseBackground({ ...DEFAULT_BACKGROUND, seed: s })).not.toBeNull();
    }
    expect(nextSeed(0, () => 0)).toBe(1);
  });
});

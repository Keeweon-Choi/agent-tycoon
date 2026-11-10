import { describe, expect, it } from 'vitest';

import { IMPORT_PROXY_DENSITY, IMPORT_WORLD_H, IMPORT_WORLD_W } from '../../constants.js';
import { diagSheetOf } from '../../office/sprites/spriteData.js';
import { composeMascot, type DenseSheet, FRAMES, MASCOTS, sheetProblem } from './compose.js';
import { walkOf } from './importedSheet.js';

/** An imported sheet's frame (24×44 world px at the proxy density), every pixel set. */
const frame = () =>
  Array.from({ length: IMPORT_WORLD_H * IMPORT_PROXY_DENSITY }, () =>
    Array.from({ length: IMPORT_WORLD_W * IMPORT_PROXY_DENSITY }, () => 'x'),
  );
const sheetOf = (cols: number): DenseSheet => {
  const row = Array.from({ length: cols }, frame);
  return { down: row, up: row, right: row, density: IMPORT_PROXY_DENSITY };
};

describe('sheetProblem: which imported sheets the looks preview can draw', () => {
  it('draws 7 columns, 8 (the walking neutral) and 9 (BUNNY-9COL), as both the iso and the iso8 top view are', () => {
    expect(sheetProblem(sheetOf(FRAMES))).toBeNull();
    expect(sheetProblem(sheetOf(FRAMES + 1))).toBeNull();
    expect(sheetProblem(sheetOf(FRAMES + 2))).toBeNull();
  });
  it('still refuses any other column count', () => {
    expect(sheetProblem(sheetOf(FRAMES - 1))).toMatch(/frames, not/);
    expect(sheetProblem(sheetOf(FRAMES + 3))).toMatch(/frames, not/);
  });
});

describe('walkOf: the columns an imported standFirst sheet walks on', () => {
  it('7 columns step on the idle, 8 on the walking neutral, 9 on the neutral then the other passing pose', () => {
    expect(walkOf(FRAMES, false)).toEqual([1, 0, 2, 0]);
    expect(walkOf(FRAMES + 1, false)).toEqual([1, 7, 2, 7]);
    expect(walkOf(FRAMES + 2, false)).toEqual([1, 7, 2, 8]);
    expect(walkOf(FRAMES + 2, true)).toEqual([1, 2, 1, 2]);
  });
});

describe('DIAG-1104: a mascot composes its three-quarter walk', () => {
  const species = Object.keys(MASCOTS) as Array<keyof typeof MASCOTS>;
  it('every species: three frames facing lower and upper right, recoloured, with its face', () => {
    for (const s of species) {
      const base = composeMascot({ species: s }, MASCOTS[s]).sheet;
      expect(diagSheetOf(base), s).not.toBeNull();
      expect([base.downRight?.length, base.upRight?.length]).toEqual([3, 3]);
      const color = Object.values(MASCOTS).find((m) => m.color !== MASCOTS[s].color)!.color;
      const recoloured = composeMascot({ species: s, color }, MASCOTS[s]).sheet;
      expect(recoloured.downRight, `${s} recoloured`).not.toEqual(base.downRight);
      const happy = composeMascot({ species: s, expr: 'happy' }, MASCOTS[s]).sheet;
      expect(happy.downRight?.[1], `${s} face`).not.toEqual(base.downRight?.[1]);
      expect(happy.upRight, `${s} back has no face`).toEqual(base.upRight);
      const crowned = composeMascot({ species: s, gear: 'crown' }, MASCOTS[s]);
      expect(crowned.sheet.upRight?.[1], `${s} gear`).not.toEqual(base.upRight?.[1]);
      expect(crowned.clipped, `${s} gear fits`).toBe(0);
    }
  });
  it('a species without one, or a broken one, keeps its four views and still draws', () => {
    const { diag, ...plain } = MASCOTS.tori;
    expect(diagSheetOf(composeMascot({ species: 'tori' }, plain).sheet)).toBeNull();
    const broken = {
      ...MASCOTS.tori,
      diag: { ...diag!, frames: { ...diag!.frames, upRight: [['x']] } },
    };
    const c = composeMascot({ species: 'tori' }, broken);
    expect(diagSheetOf(c.sheet)).toBeNull();
    expect(c.sheet.down).toHaveLength(FRAMES);
  });
});

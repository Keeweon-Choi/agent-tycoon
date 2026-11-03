import { describe, expect, it } from 'vitest';

import { IMPORT_PROXY_DENSITY, IMPORT_WORLD_H, IMPORT_WORLD_W } from '../../constants.js';
import { type DenseSheet, FRAMES, sheetProblem } from './compose.js';

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
  it('draws 7 columns and 8 (the walking neutral), as both the iso and the iso8 top view are', () => {
    expect(sheetProblem(sheetOf(FRAMES))).toBeNull();
    expect(sheetProblem(sheetOf(FRAMES + 1))).toBeNull();
  });
  it('still refuses any other column count', () => {
    expect(sheetProblem(sheetOf(FRAMES - 1))).toMatch(/frames, not/);
    expect(sheetProblem(sheetOf(FRAMES + 2))).toMatch(/frames, not/);
  });
});

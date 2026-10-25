import { describe, expect, it } from 'vitest';

import { Direction } from '../../office/types.js';
import { isoFacing, isoSheetFrame, rowDirection, sheetRows } from './sprites.js';

describe('iso facing', () => {
  // A tiny synthetic sheet: every frame one pixel wide-and-two, its colour says row and column,
  // its left pixel says "not mirrored".
  const frame = (row: number, col: number) => [[`L${row}${col}`, `R${row}${col}`]];
  const rows = (n: number) =>
    Array.from({ length: n }, (_, r) => Array.from({ length: 7 }, (_, c) => frame(r, c)));

  it('tells the formats apart by the sheet height', () => {
    expect(sheetRows(2 * 64, 64)).toBe(2);
    expect(sheetRows(3 * 32, 32)).toBe(3);
  });

  for (const n of [2, 3])
    it(`draws a ${n}-row sheet: front towards the viewer, back away, mirrored for the other diagonal`, () => {
      const sheet = rows(n);
      expect(isoSheetFrame(sheet, Direction.RIGHT, 1)).toEqual([['L01', 'R01']]); // lower right
      expect(isoSheetFrame(sheet, Direction.DOWN, 1)).toEqual([['R01', 'L01']]); // lower left
      expect(isoSheetFrame(sheet, Direction.UP, 3)).toEqual([['L13', 'R13']]); // upper right
      expect(isoSheetFrame(sheet, Direction.LEFT, 3)).toEqual([['R13', 'L13']]); // upper left
    });

  it('keeps the side row of a 3-row sheet unused and maps rows to the top-down directions', () => {
    expect(
      [Direction.UP, Direction.DOWN, Direction.LEFT, Direction.RIGHT].map((d) => isoFacing(d).row),
    ).toEqual([1, 0, 1, 0]);
    expect(rowDirection(0)).toBe(Direction.DOWN);
    expect(rowDirection(1)).toBe(Direction.UP);
  });
});

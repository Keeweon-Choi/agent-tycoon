import { describe, expect, it } from 'vitest';

import { CharacterState, Direction } from '../../office/types.js';
import { characterView, isoFacing, isoSheetFrame, rowDirection, sheetRows } from './sprites.js';

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

describe('CHAR-8DIR: characterView', () => {
  const [TOP, ISO] = [1, 2];
  const { RIGHT, LEFT, UP, DOWN } = Direction;
  /** The row of a 5-row sheet a view draws (0, 1 three-quarter; 2 front, 3 back, 4 side; the top
   *  view's LEFT is its side mirrored) and whether it is mirrored. */
  const row5 = (v: ReturnType<typeof characterView>) =>
    v.palette === ISO
      ? `${v.dir === DOWN ? 0 : 1}${v.mirror ? 'm' : ''}`
      : `${{ [DOWN]: 2, [UP]: 3, [RIGHT]: 4, [LEFT]: 4 }[v.dir]}${v.dir === LEFT ? 'm' : ''}`;
  const walk = (dir: Direction, cldDiagRow?: -1 | 1) => ({
    dir,
    cldDiagRow,
    state: CharacterState.WALK,
    palette: TOP,
  });

  it('a 5-row sheet in the isometric view: 8 screen directions', () => {
    const at = (dir: Direction, diag?: -1 | 1) => row5(characterView(walk(dir, diag), true, ISO));
    expect({
      lowerRight: at(RIGHT),
      lowerLeft: at(DOWN),
      upperRight: at(UP),
      upperLeft: at(LEFT),
      down: at(RIGHT, 1),
      up: at(LEFT, -1),
      right: at(RIGHT, -1),
      left: at(LEFT, 1),
    }).toEqual({
      lowerRight: '0',
      lowerLeft: '0m',
      upperRight: '1',
      upperLeft: '1m',
      down: '2',
      up: '3',
      right: '4',
      left: '4m',
    });
    // seated it faces its seat, whatever its last step
    const seated = { ...walk(RIGHT, 1), state: CharacterState.TYPE };
    expect(row5(characterView(seated, true, ISO))).toBe('0');
  });

  it('a 5-row sheet in the top-down view: straight steps the top view, diagonals three-quarter', () => {
    const at = (dir: Direction, diag?: -1 | 1) => row5(characterView(walk(dir, diag), false, ISO));
    expect([at(DOWN), at(UP), at(RIGHT), at(LEFT)]).toEqual(['2', '3', '4', '4m']);
    expect([at(RIGHT, 1), at(LEFT, 1), at(RIGHT, -1), at(LEFT, -1)]).toEqual([
      '0',
      '0m',
      '1',
      '1m',
    ]);
  });

  it('2- and 3-row sheets (no second palette) keep their four views, a diagonal step aside', () => {
    for (const diag of [undefined, 1, -1] as const)
      for (const dir of [UP, DOWN, LEFT, RIGHT]) {
        const ch = walk(dir, diag);
        const f = isoFacing(dir);
        expect(characterView(ch, true, TOP)).toEqual({
          palette: TOP,
          dir: rowDirection(f.row),
          mirror: f.mirror,
        });
        expect(characterView(ch, false, TOP)).toEqual({ palette: TOP, dir, mirror: false });
      }
  });
});

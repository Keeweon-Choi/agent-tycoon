import { describe, expect, it } from 'vitest';

import {
  getCharacterSprites,
  setCharacterTemplates,
  setIsoPalette,
} from '../../office/sprites/spriteData.js';
import { CharacterState, Direction } from '../../office/types.js';
import {
  characterView,
  drawnView,
  isoFacing,
  isoSheetFrame,
  rowDirection,
  sheetRows,
} from './sprites.js';

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

describe('DIAG-1104: drawnView with the built-in three-quarter walk', () => {
  const { RIGHT, LEFT, UP, DOWN } = Direction;
  // two pixels: a frame flipped into its sheet (the top view's left) reads R first
  const px = (tag: string) => [[`L${tag}`, `R${tag}`]];
  const row = (tag: string, n: number) => Array.from({ length: n }, (_, c) => px(`${tag}${c}`));
  const person = (diag: 'whole' | 'none' | 'short') => ({
    down: row('F', 7),
    up: row('B', 7),
    right: row('S', 7),
    ...(diag !== 'none' && {
      downRight: row('dr', diag === 'whole' ? 3 : 2),
      upRight: row('ur', diag === 'whole' ? 3 : 2),
    }),
  });
  // palettes 0 (with its diagonal walk), 1 (none), 2 (a broken one: two frames)
  setCharacterTemplates([person('whole'), person('none'), person('short')]);
  const ch = (
    palette: number,
    dir: Direction,
    cldDiagRow?: -1 | 1,
    state: string = CharacterState.WALK,
  ) => ({ palette, dir, cldDiagRow, state }) as Parameters<typeof drawnView>[0];
  /** The cell a view draws: the sheet's own row (F front, B back, S side) or the three-quarter
   *  one (dr facing lower right, ur upper right), its standing frame, 'm' mirrored (by the view or
   *  in the sheet). */
  const cell = (c: Parameters<typeof drawnView>[0], iso: boolean, drinking = false) => {
    const v = drawnView(c, iso, drinking);
    const s = getCharacterSprites(v.palette);
    const f = (c.state === CharacterState.TYPE ? s.typing : s.walk)[v.dir][1];
    const flipped = f[0][0].startsWith('R') !== v.mirror;
    return `${f[0][0].slice(1)}${flipped ? 'm' : ''}`;
  };

  it('the isometric view: the world steps (screen diagonals) the three-quarter walk', () => {
    const at = (dir: Direction, diag?: -1 | 1) => cell(ch(0, dir, diag), true);
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
      lowerRight: 'dr1',
      lowerLeft: 'dr1m',
      upperRight: 'ur1',
      upperLeft: 'ur1m',
      down: 'F1',
      up: 'B1',
      right: 'S1',
      left: 'S1m',
    });
  });

  it('the top-down view: straight steps its own views, diagonal steps the three-quarter walk', () => {
    const at = (dir: Direction, diag?: -1 | 1) => cell(ch(0, dir, diag), false);
    expect([at(DOWN), at(UP), at(RIGHT), at(LEFT)]).toEqual(['F1', 'B1', 'S1', 'S1m']);
    expect([at(RIGHT, 1), at(LEFT, 1), at(RIGHT, -1), at(LEFT, -1)]).toEqual([
      'dr1',
      'dr1m',
      'ur1',
      'ur1m',
    ]);
  });

  it('seated or drinking it keeps the front and back rows, mirrored as before', () => {
    const typing = (dir: Direction) => cell(ch(0, dir, undefined, CharacterState.TYPE), true);
    expect([typing(RIGHT), typing(DOWN), typing(UP), typing(LEFT)]).toEqual([
      'F4',
      'F4m',
      'B4',
      'B4m',
    ]);
    const drinking = (dir: Direction, iso: boolean) =>
      cell(ch(0, dir, undefined, CharacterState.IDLE), iso, true);
    expect([drinking(RIGHT, true), drinking(DOWN, true), drinking(DOWN, false)]).toEqual([
      'F1',
      'F1m',
      'F1',
    ]);
    expect(drawnView(ch(0, RIGHT, 1, CharacterState.IDLE), false, true).palette).toBe(0);
  });

  it('without a whole diagonal walk a person keeps its four views (front and back mirrored)', () => {
    for (const palette of [1, 2])
      for (const diag of [undefined, 1, -1] as const)
        for (const dir of [UP, DOWN, LEFT, RIGHT]) {
          const f = isoFacing(dir);
          expect(drawnView(ch(palette, dir, diag), true, false)).toEqual({
            palette,
            dir: rowDirection(f.row),
            mirror: f.mirror,
          });
          expect(drawnView(ch(palette, dir, diag), false, false)).toEqual({
            palette,
            dir,
            mirror: false,
          });
        }
    expect(getCharacterSprites(2).walk[DOWN][1]).toEqual(px('F1')); // and it still draws
  });

  it('an iso8 sheet (a full isometric sheet beside) stays three-quarter seated', () => {
    setIsoPalette(7, 8);
    expect(drawnView(ch(7, RIGHT, undefined, CharacterState.TYPE), true, false).palette).toBe(8);
    expect(drawnView(ch(7, RIGHT, undefined, CharacterState.IDLE), true, true).palette).toBe(8);
  });
});

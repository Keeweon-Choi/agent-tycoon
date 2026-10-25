import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { rgbaToHex } from '../../core/src/assets/colorUtils.js';
import { MASCOT_GEARS, MASCOT_SPECIES } from '../../core/src/cld/looks.js';
import { artIssue, MIN_ART_PIXELS, sheetFrameIssues } from '../../core/src/cld/sheetCheck.js';
import { composeMascot, FRAME_H, FRAME_W, FRAMES, MASCOTS } from '../src/cld/characters/compose.js';
import { History } from '../src/cld/characters/history.js';
import { sheetRgba, spriteRgba } from '../src/cld/characters/sheetPixels.js';
import { setFurnitureType } from '../src/office/editor/editorActions.js';
import type { LoadedCharacterData } from '../src/office/sprites/spriteData.js';
import type { OfficeLayout } from '../src/office/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('CH-6 editor history: one press is one step', () => {
  it('groups a stroke, keeps clicks apart, restores the frame, and drops redo on a new change', () => {
    const h = new History<string>(50);
    let state = 'a';
    const change = (next: string, frame: number) => {
      h.record(() => state, frame);
      state = next;
    };
    h.beginStep();
    change('b', 3);
    change('c', 3);
    change('d', 3);
    h.endStep();
    change('e', 5); // a frame paste: no press, a step of its own
    change('f', 5);
    expect(h.undo(state)).toEqual({ state: 'e', frame: 5 });
    state = 'e';
    expect(h.undo(state)).toEqual({ state: 'd', frame: 5 });
    state = 'd';
    expect(h.undo(state)).toEqual({ state: 'a', frame: 3 });
    state = 'a';
    expect(h.canUndo).toBe(false);
    expect(h.redo(state)).toEqual({ state: 'd', frame: 3 });
    state = 'd';
    h.beginStep();
    change('x', 0);
    h.endStep();
    expect(h.canRedo).toBe(false);
    expect(h.undo(state)).toEqual({ state: 'd', frame: 0 });
  });

  it('reads the state only when a step starts, and keeps at most `limit` steps', () => {
    const h = new History<number>(3);
    let reads = 0;
    h.beginStep();
    for (let i = 0; i < 10; i++) h.record(() => ++reads, 0);
    h.endStep();
    expect(reads).toBe(1);
    for (let i = 0; i < 5; i++) h.record(() => 100 + i, 1);
    let n = 0;
    while (h.undo(0)) n++;
    expect(n).toBe(3);
  });
});

describe('CH-6 sheets the editor starts from pass the daemon check', () => {
  const sheetOfPng = (png: PNG): LoadedCharacterData => {
    const row = (r: number) =>
      Array.from({ length: FRAMES }, (_, f) =>
        Array.from({ length: FRAME_H }, (_, y) =>
          Array.from({ length: FRAME_W }, (_, x) => {
            const i = ((r * FRAME_H + y) * png.width + f * FRAME_W + x) * 4;
            return rgbaToHex(png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]);
          }),
        ),
      );
    return { down: row(0), up: row(1), right: row(2) };
  };

  it('built-in people: hex sheet → RGBA is the PNG itself; no problem, no warning', () => {
    for (let n = 0; n < 6; n++) {
      const png = PNG.sync.read(
        fs.readFileSync(path.join(here, `../public/assets/characters/char_${n}.png`)),
      );
      const want = Uint8ClampedArray.from(png.data);
      for (let p = 0; p < want.length; p += 4) if (want[p + 3] < 2) want.fill(0, p, p + 4);
      const rgba = sheetRgba(sheetOfPng(png));
      expect(rgba).toEqual(want);
      expect(sheetFrameIssues(rgba)).toEqual({ problem: null, warning: null });
    }
  });

  it('every mascot with every gear: no problem, no warning', () => {
    for (const species of MASCOT_SPECIES)
      for (const gear of [undefined, ...MASCOT_GEARS]) {
        const { sheet } = composeMascot({ species, gear }, MASCOTS[species]);
        expect([species, gear, sheetFrameIssues(sheetRgba(sheet))]).toEqual([
          species,
          gear,
          { problem: null, warning: null },
        ]);
      }
  });
});

describe('CH-6b: the editor on one furniture sprite', () => {
  it('reads a sprite of any size as RGBA, its own width wide', () => {
    /* eslint-disable pixel-agents/no-inline-colors -- sprite pixels are data here */
    const sprite = [
      ['#102030', '', '#40506080'],
      ['', '#FFFFFF', ''],
    ];
    /* eslint-enable pixel-agents/no-inline-colors */
    const rgba = spriteRgba(sprite);
    expect(rgba.length).toBe(3 * 2 * 4);
    expect([...rgba.subarray(0, 4)]).toEqual([0x10, 0x20, 0x30, 255]);
    expect([...rgba.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
    expect([...rgba.subarray(8, 12)]).toEqual([0x40, 0x50, 0x60, 0x80]);
    expect([...rgba.subarray(16, 20)]).toEqual([255, 255, 255, 255]);
  });

  it('refuses an (almost) blank sprite: the daemon and the browser share the rule', () => {
    const rgba = new Uint8ClampedArray(48 * 32 * 4);
    for (let i = 0; i < MIN_ART_PIXELS - 1; i++) rgba[i * 4 + 3] = 255;
    expect(artIssue(rgba)?.code).toBe('blank');
    rgba[(MIN_ART_PIXELS - 1) * 4 + 3] = 255;
    expect(artIssue(rgba)).toBeNull();
  });

  it('switches one placed item to the new type and leaves an unchanged layout as it is', () => {
    const layout = {
      version: 1 as const,
      cols: 4,
      rows: 4,
      tiles: [],
      furniture: [
        { uid: 'a', type: 'DESK_FRONT', col: 0, row: 0, color: { h: 1, s: 0, b: 0, c: 0 } },
        { uid: 'b', type: 'DESK_FRONT', col: 2, row: 2 },
      ],
    } as unknown as OfficeLayout;
    const next = setFurnitureType(layout, 'a', 'custom-desk-front-5');
    expect(next.furniture.map((f) => f.type)).toEqual(['custom-desk-front-5', 'DESK_FRONT']);
    expect(next.furniture[0].color).toEqual(layout.furniture[0].color);
    expect(setFurnitureType(next, 'a', 'custom-desk-front-5')).toBe(next);
    expect(setFurnitureType(next, 'nope', 'X')).toBe(next);
  });
});

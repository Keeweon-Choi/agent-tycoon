import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import type { Rgba } from './assetSnap.js';
import { bigRow, BLOCK, px, resize, rgb, source } from './partFixture.js';
import { importPart, parsePartFileName } from './partImport.js';
import { REPO_ROOT } from './testHome.js';

/** A 3×3 box blur: the soft edges an image generator leaves. */
function blur(img: Rgba): Rgba {
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      for (let k = 0; k < 4; k++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue;
            sum += img.data[(yy * img.width + xx) * 4 + k];
            n++;
          }
        out[(y * img.width + x) * 4 + k] = Math.round(sum / n);
      }
  return { ...img, data: out };
}

const rowOf = (part: { palette: string[]; pixels: string }, view: number) =>
  Array.from({ length: 32 * 112 }, (_, i) => px(part, i % 112, view * 32 + Math.floor(i / 112)));

describe('part import (CHAR-HUMAN)', () => {
  it('a ×20 drawing on the row template, shifted and blurred, gives back exactly the drawn part', () => {
    for (const view of [0, 2]) {
      const want = Array.from({ length: 32 * 112 }, (_, i) =>
        source(view)(i % 112, Math.floor(i / 112)),
      );
      const got = importPart(
        blur(bigRow(view, source(view), { shift: [7, 5] })),
        'top',
        view === 0 ? 'down' : 'right',
      );
      if ('error' in got) throw new Error(got.error);
      expect(got.kind).toBe('sheet');
      expect(got.report.layout).toBe('row-x20');
      expect(got.report.fit).toBeGreaterThan(0.95);
      expect(rowOf(got, view)).toEqual(want);
      // the other rows stay empty, nothing green or magenta is left
      for (const other of [0, 1, 2].filter((v) => v !== view))
        expect(rowOf(got, other).every((c) => !c)).toBe(true);
      expect(got.palette.some((c) => c === '00ff00' || c === 'ff00ff' || c === '00a000')).toBe(
        false,
      );
    }
  });

  it('a resized drawing, finer than the blocks: mapped by the frame lines, each block’s dominant colour; the fine one kept as HD', () => {
    const DETAIL = '80c0f0';
    const base = source(0);
    // a detail in one half block of every drawn block: the block is still its base colour
    const fine = (x2: number, y2: number) => {
      const c = base(x2 >> 1, y2 >> 1);
      return c && x2 % 2 && y2 % 2 ? DETAIL : c;
    };
    const img = resize(bigRow(0, base, { lines: true, fine }), 2402, 655);
    const got = importPart(img, 'top', 'down');
    if ('error' in got) throw new Error(got.error);
    expect(got.report.grid).toBe('lines');
    expect(rowOf(got, 0)).toEqual(
      Array.from({ length: 32 * 112 }, (_, i) => base(i % 112, Math.floor(i / 112))),
    );
    expect(got.hd).not.toBeNull();
    const hd = got.hd!;
    expect([hd.width, hd.height]).toEqual([224, 192]);
    let details = 0;
    let wrong = 0;
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 224; x++) {
        const o = (y * 224 + x) * 4;
        const want = fine(x, y);
        const have = hd.data[o + 3]
          ? [0, 1, 2].map((k) => hd.data[o + k].toString(16).padStart(2, '0')).join('')
          : '';
        if (want === DETAIL && have === DETAIL) details++;
        if (!!want !== !!have) wrong++;
      }
    expect(details).toBeGreaterThan(100); // the fine detail survives in HD
    expect(wrong).toBeLessThan(40); // edges may move by a half block, no more
  });

  it('a frame drawn facing the wrong way is found by the eye dots: borrowed, emptied or kept', () => {
    // the front row's typing frames drawn on the back mannequin (no eye dots), as the owner's were
    const img = bigRow(0, source(0), {
      lines: true,
      mannequinRow: (f) => (f === 3 || f === 4 ? 1 : 0),
    });
    const borrow = importPart(img, 'top', 'down');
    if ('error' in borrow) throw new Error(borrow.error);
    expect(borrow.report.frames.map((f) => f.seen)).toEqual([
      'front',
      'front',
      'front',
      'back',
      'back',
      'front',
      'front',
    ]);
    expect(borrow.report.frames[3]).toMatchObject({ want: 'front', fix: 'borrowed' });
    expect(borrow.report.frames[0].fix).toBe('kept');
    const frameOf = (part: { palette: string[]; pixels: string }, f: number) =>
      Array.from({ length: 32 * 16 }, (_, i) => px(part, f * 16 + (i % 16), Math.floor(i / 16)));
    const empty = importPart(img, 'top', 'down', { mismatch: 'empty' });
    const keep = importPart(img, 'top', 'down', { mismatch: 'keep' });
    if ('error' in empty || 'error' in keep) throw new Error('import failed');
    expect(frameOf(empty, 3).every((c) => !c)).toBe(true);
    expect(empty.report.frames[3].fix).toBe('emptied');
    expect(frameOf(keep, 3).some(Boolean)).toBe(true);
    expect(frameOf(borrow, 3).some(Boolean)).toBe(true);
    // negative control: drawn the right way, nothing is flagged
    const right = importPart(bigRow(0, source(0), { lines: true }), 'top', 'down');
    if ('error' in right) throw new Error(right.error);
    expect(right.report.frames.every((f) => f.fix === 'kept' && f.seen === 'front')).toBe(true);
  });

  it('the HD template: a drawing at its 10 px blocks lands HD pixel for HD pixel', () => {
    const file = path.join(REPO_ROOT, 'cld/artifacts/char-parts/templates/body-down-hd-x10.png');
    const t = PNG.sync.read(fs.readFileSync(file));
    // a 3×5 HD-pixel red patch on frame 2's chest (HD x 13-15, y 40-44)
    const [x0, y0] = [40 + 340 + 13 * 10, 40 + 40 * 10];
    for (let y = y0; y < y0 + 50; y++)
      for (let x = x0; x < x0 + 30; x++) t.data.set([200, 30, 30, 255], (y * t.width + x) * 4);
    const got = importPart({ width: t.width, height: t.height, data: t.data }, 'top', 'down');
    if ('error' in got) throw new Error(got.error);
    expect(got.report.grid).toBe('lines');
    expect(got.report.fit).toBeGreaterThan(0.95);
    const hd = got.hd!;
    const red = (x: number, y: number) =>
      hd.data[(y * hd.width + x) * 4 + 3] > 0 && hd.data[(y * hd.width + x) * 4] === 200;
    let inside = 0;
    let outside = 0;
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 224; x++) {
        const want = x >= 32 + 13 && x < 32 + 16 && y >= 40 && y < 45;
        if (red(x, y)) want ? inside++ : outside++;
      }
    expect(inside).toBe(15);
    expect(outside).toBe(0);
  });

  it('refuses another template: the side row read as the front one, a head sheet as a body row', () => {
    const side = importPart(bigRow(2, source(2)), 'top', 'down');
    expect('error' in side && side.error).toMatch(/mannequin does not match/);
    const head = {
      width: 54 * BLOCK,
      height: 28 * BLOCK,
      data: new Uint8Array(54 * 28 * BLOCK * BLOCK * 4).fill(255),
    };
    const wrong = importPart(head, 'top', 'down');
    expect('error' in wrong && wrong.error).toMatch(/not the row template/);
    // negative control for the fit: the right one passes
    expect('error' in importPart(bigRow(2, source(2)), 'top', 'right')).toBe(false);
  });

  it('a 1:1 drawing without its mannequin (exported from a pixel editor) is taken as it is', () => {
    const data = new Uint8Array(112 * 32 * 4);
    const part = source(0);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 112; x++)
        if (part(x, y)) data.set([...rgb(part(x, y)), 255], (y * 112 + x) * 4);
    const got = importPart({ width: 112, height: 32, data }, 'top', 'down');
    if ('error' in got) throw new Error(got.error);
    expect(got.report.layout).toBe('row-1x');
    expect(got.report.fit).toBeNull();
    expect(rowOf(got, 0)).toEqual(
      Array.from({ length: 32 * 112 }, (_, i) => part(i % 112, Math.floor(i / 112))),
    );
  });

  it('the ramp is the main colour and its same-hue steps, never the outline or a button', () => {
    const data = new Uint8Array(48 * 24 * 4);
    const put = (x: number, y: number, hex: string) =>
      data.set([...rgb(hex), 255], (y * 48 + x) * 4);
    for (let x = 0; x < 10; x++) put(x, 2, 'c03028'); // main red
    for (let x = 0; x < 5; x++) put(x, 3, '801810'); // darker red
    for (let x = 0; x < 3; x++) put(x, 4, 'f06050'); // lighter red
    for (let x = 0; x < 4; x++) put(x, 5, '101010'); // outline
    for (let x = 0; x < 2; x++) put(x, 6, '2850c0'); // a blue button
    const got = importPart({ width: 48, height: 24, data }, 'hair');
    if ('error' in got) throw new Error(got.error);
    expect(got.kind).toBe('head');
    expect(new Set(got.ramp)).toEqual(new Set(['c03028', '801810', 'f06050']));
  });

  it('file names: slot, name, gender, row', () => {
    expect(parsePartFileName('top-hoodie-down.png')).toEqual({
      slot: 'top',
      name: 'hoodie',
      view: 'down',
    });
    expect(parsePartFileName('/x/face-basic-f.png')).toEqual({
      slot: 'face',
      name: 'basic',
      gender: 'f',
      view: null,
    });
    expect(parsePartFileName('hair-long-bob-m-right.png')).toEqual({
      slot: 'hair',
      name: 'long-bob',
      gender: 'm',
      view: 'right',
    });
    expect(parsePartFileName('hat-x.png')).toBeNull();
    expect(parsePartFileName('top-.png')).toBeNull();
  });
});

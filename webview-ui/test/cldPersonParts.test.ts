import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { rgbaToHex } from '../../core/src/assets/colorUtils.js';
import { parseHex, rgbToLab } from '../src/cld/characters/color.js';
import {
  classicOf,
  compose,
  FRAME_H,
  FRAME_W,
  FRAMES,
  lookKey,
  portraitOf,
  sheetProblem,
  VIEWS,
} from '../src/cld/characters/compose.js';
import type { PartData, PersonLook } from '../src/cld/characters/parts.js';
import {
  BUILT_IN_PARTS,
  composePerson,
  HEAD_H,
  HEAD_W,
  PARTS_META,
  partsForSlot,
  randomPerson,
  SHEET_H,
  SHEET_W,
} from '../src/cld/characters/parts.js';
import lookHashes from './fixtures/lookHashes.json';
import { LOOK_SAMPLES } from './fixtures/lookSamples.js';

/* eslint-disable pixel-agents/no-inline-colors -- sprite pixels and stored look colours */
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templates = [0, 1, 2, 3, 4, 5].map((i) => {
  const png = PNG.sync.read(
    fs.readFileSync(path.join(root, `public/assets/characters/char_${i}.png`)),
  );
  const frame = (row: number, f: number) =>
    Array.from({ length: FRAME_H }, (_, y) =>
      Array.from({ length: FRAME_W }, (_, x) => {
        const k = ((row * FRAME_H + y) * png.width + f * FRAME_W + x) * 4;
        return rgbaToHex(png.data[k], png.data[k + 1], png.data[k + 2], png.data[k + 3]);
      }),
    );
  const row = (r: number) => Array.from({ length: FRAMES }, (_, f) => frame(r, f));
  return { down: row(0), up: row(1), right: row(2) };
});

const byId = (id: string) => BUILT_IN_PARTS.find((p) => p.id === id)!;
/** A synthetic part: one colour on the given sheet (or head canvas) pixels. */
function solid(
  id: string,
  slot: PartData['slot'],
  kind: PartData['kind'],
  at: number[],
  color = 'ff0000',
): PartData {
  const n = kind === 'sheet' ? SHEET_W * SHEET_H : HEAD_W * HEAD_H;
  const px = new Array(n).fill('.');
  for (const i of at) px[i] = '0';
  return { id, slot, kind, ramp: [], palette: [color], pixels: px.join('') };
}
const sheetAt = (x: number, y: number) => y * SHEET_W + x;
const pixelOf = (s: ReturnType<typeof composePerson>['sheet'], x: number, y: number) =>
  s[VIEWS[Math.floor(y / FRAME_H)]][Math.floor(x / FRAME_W)][y % FRAME_H][x % FRAME_W];

describe('people made of parts (CHAR-HUMAN)', () => {
  it('v1 and v2 looks compose exactly as before the parts system', () => {
    const now = LOOK_SAMPLES.map((look) =>
      createHash('sha256')
        .update(JSON.stringify(compose(look, { templates }).sheet))
        .digest('hex'),
    );
    expect(now).toEqual(lookHashes);
    // negative control: the hash sees a one-degree hue change
    const turned = createHash('sha256')
      .update(JSON.stringify(compose({ palette: 2, hueShift: 46 }, { templates }).sheet))
      .digest('hex');
    expect(turned).not.toBe(lookHashes[1]);
  });

  it('built-in parts: the right size, and every built-in recomposed is a full, visible sheet', () => {
    for (const p of BUILT_IN_PARTS) {
      expect(p.pixels.length, p.id).toBe(p.kind === 'sheet' ? SHEET_W * SHEET_H : HEAD_W * HEAD_H);
      for (const c of p.ramp) expect(p.palette, p.id).toContain(c);
    }
    for (let k = 0; k < 6; k++) {
      const has = (id: string) => BUILT_IN_PARTS.some((p) => p.id === id);
      const look: PersonLook = {
        parts: {
          hair: `hair-${k}`,
          top: `top-${k}`,
          ...(has(`bottom-${k}`) && { bottom: `bottom-${k}` }),
          ...(has(`shoes-${k}`) && { shoes: `shoes-${k}` }),
        },
      };
      const { sheet, missing } = composePerson(look);
      expect(missing).toEqual([]);
      expect(sheetProblem(sheet), `built-in ${k}`).toBeNull();
    }
  });

  it('layers bottom to top: body, face, bottom, shoes, top, outer, hair, accessories, paper last', () => {
    // one standing-front pixel inside the torso, covered by each slot in turn
    const [ax, ay] = PARTS_META.headAnchors[1];
    const x = FRAME_W + 8;
    const y = 22;
    const head = (y - ay) * HEAD_W + (x - FRAME_W - ax);
    const parts = [
      solid('b1', 'bottom', 'sheet', [sheetAt(x, y)], '0000a0'),
      solid('s1', 'shoes', 'sheet', [sheetAt(x, y)], '00a000'),
      solid('t1', 'top', 'sheet', [sheetAt(x, y)], 'a00000'),
      solid('o1', 'outer', 'sheet', [sheetAt(x, y)], 'a0a000'),
      solid('h1', 'hair', 'head', [head], '00a0a0'),
      solid('a1', 'acc', 'head', [head], 'a000a0'),
      solid('empty', 'top', 'sheet', []), // so the default top does not cover the lower layers
    ];
    const ids = { bottom: 'b1', shoes: 's1', top: 't1', outer: 'o1', hair: 'h1' };
    const want = ['#0000A0', '#00A000', '#A00000', '#A0A000', '#00A0A0', '#A000A0'];
    const slots = Object.keys(ids) as (keyof typeof ids)[];
    for (let n = 1; n <= slots.length; n++) {
      const look: PersonLook = {
        parts: { top: 'empty', ...Object.fromEntries(slots.slice(0, n).map((s) => [s, ids[s]])) },
      };
      expect(pixelOf(composePerson(look, parts).sheet, x, y)).toBe(want[n - 1]);
    }
    expect(pixelOf(composePerson({ parts: { ...ids, acc: ['a1'] } }, parts).sheet, x, y)).toBe(
      want[5],
    );
    // the reading paper covers even an accessory
    const paperAt = [...PARTS_META.paper.pixels].findIndex((k) => k !== '.');
    const px = paperAt % SHEET_W;
    const py = Math.floor(paperAt / SHEET_W);
    const over = solid('t2', 'top', 'sheet', [paperAt], 'a00000');
    const paperColor = `#${PARTS_META.paper.palette[0].toUpperCase()}`;
    expect(pixelOf(composePerson({ parts: { top: 't2' } }, [over]).sheet, px, py)).toBe(paperColor);
  });

  it('a head part follows each frame’s head anchor', () => {
    // one pixel at canvas (8, 0) of every view
    const at = VIEWS.map((_, v) => v * PARTS_META.headBox.w + 8);
    const { sheet } = composePerson({ parts: { hair: 'dot' } }, [
      solid('dot', 'hair', 'head', at, '123456'),
    ]);
    VIEWS.forEach((view, v) =>
      sheet[view].forEach((frame, f) => {
        const [ax, ay] = PARTS_META.headAnchors[v * FRAMES + f];
        expect(frame[ay][ax + 8], `${view} ${f}`).toBe('#123456');
      }),
    );
    // the anchors are the built-in heads' own: char_0's hair part lands where char_0 drew its hair
    const hair = composePerson({ parts: { hair: 'hair-0' } }).sheet;
    let same = 0;
    let all = 0;
    VIEWS.forEach((view) =>
      hair[view].forEach((frame, f) =>
        frame.forEach((row, y) =>
          row.forEach((c, x) => {
            const was = templates[0][view][f][y][x];
            if (c && byId('hair-0').palette.some((p) => `#${p.toUpperCase()}` === c)) {
              all++;
              if (was === c) same++;
            }
          }),
        ),
      ),
    );
    expect(same / all).toBeGreaterThan(0.95);
  });

  it('recolouring moves the main ramp with its shading; other colours and the outline stay', () => {
    const top = byId('top-0');
    const plain = composePerson({ parts: { top: 'top-0' } }).sheet;
    const red = composePerson({ parts: { top: 'top-0' }, colors: { top: '#c0392b' } }).sheet;
    const fixed = new Set(
      top.palette.filter((c) => !top.ramp.includes(c)).map((c) => `#${c.toUpperCase()}`),
    );
    const ramp = new Map<string, string>();
    let changed = 0;
    for (let i = 0; i < top.pixels.length; i++) {
      if (top.pixels[i] === '.') continue;
      const x = i % SHEET_W;
      const y = Math.floor(i / SHEET_W);
      const was = pixelOf(plain, x, y);
      const now = pixelOf(red, x, y);
      if (fixed.has(was)) expect(now, `${x},${y}`).toBe(was);
      else if (was !== now) {
        changed++;
        ramp.set(was, now);
      }
    }
    expect(changed).toBeGreaterThan(100);
    expect(fixed.size).toBeGreaterThan(0); // the white shirt, the outline
    // the steps keep their order of lightness, and the main one is the picked colour
    const L = (c: string) => rgbToLab(parseHex(c)).L;
    const pairs = [...ramp];
    for (const [a, a2] of pairs)
      for (const [b, b2] of pairs) if (L(a) < L(b) - 0.01) expect(L(a2)).toBeLessThan(L(b2));
    expect([...ramp.values()]).toContain('#C0392B');
    // the skin: the body's ramp moves, its outline does not
    const dark = composePerson({ colors: { skin: '#6b4128' } }).sheet;
    const light = composePerson({}).sheet;
    expect(pixelOf(dark, FRAME_W + 8, 10)).not.toBe(pixelOf(light, FRAME_W + 8, 10));
    expect(pixelOf(dark, FRAME_W + 2, 10)).toBe(pixelOf(light, FRAME_W + 2, 10)); // skull outline
  });

  it('unknown parts fall back to built-ins (never invisible); glasses only without glasses of one’s own', () => {
    const { sheet, missing } = composePerson({
      parts: { body: 'gone', top: 'gone-too', hair: 'nope', acc: ['x'] },
    });
    expect(missing.sort()).toEqual(['gone', 'gone-too', 'nope', 'x']);
    expect(sheetProblem(sheet)).toBeNull();
    // a part in the wrong slot is unknown there
    expect(composePerson({ parts: { top: 'hair-0' } }).missing).toEqual(['hair-0']);
    // a malformed custom part is ignored
    expect(
      composePerson({ parts: { top: 'bad' } }, [
        { ...solid('bad', 'top', 'sheet', [0]), pixels: '..' },
      ]).missing,
    ).toEqual(['bad']);
    const glassesAt = [...PARTS_META.glasses.pixels].findIndex((k) => k !== '.');
    const gx = glassesAt % SHEET_W;
    const gy = Math.floor(glassesAt / SHEET_W);
    expect(glassesAt).toBeGreaterThan(0);
    expect(pixelOf(composePerson({}).sheet, gx, gy)).toBe('#000000');
    const own = solid('acc-roundglasses', 'acc', 'head', [], 'ffffff');
    expect(pixelOf(composePerson({ parts: { acc: [own.id] } }, [own]).sheet, gx, gy)).not.toBe(
      '#000000',
    );
  });

  it('a v3 person look composes through compose(), with the owner’s parts; its key names what it wears', () => {
    const look = {
      v: 3,
      kind: 'person' as const,
      gender: 'f' as const,
      parts: { hair: 'mine' },
      colors: { top: '#C0392B' },
    };
    const mine = solid('mine', 'hair', 'head', [8], '123456');
    const c = compose(look, { templates, parts: [mine] });
    expect(c.fellBack).toBeNull();
    expect(c.sheet).toEqual(composePerson(look, [mine]).sheet);
    expect(c.sheet).not.toEqual(compose(look, { templates }).sheet); // without the part: no dot
    expect(lookKey(look)).toBe(lookKey({ ...look, colors: { top: '#c0392b' } }));
    expect(lookKey(look)).not.toBe(lookKey({ ...look, gender: 'm' }));
    expect(lookKey(look)).not.toBe(lookKey({ ...look, parts: { hair: 'hair-0' } }));
  });

  it('무작위 stays within the gender; the picker lists the gender’s own parts first', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const theirs = solid('p-hair-long-f', 'hair', 'head', [8]);
    const tagged = [{ ...theirs, gender: 'f' as const }];
    for (let n = 0; n < 200; n++) {
      const look = randomPerson('m', tagged, rand);
      expect(look.gender).toBe('m');
      const worn = [
        ...Object.entries(look.parts ?? {}).flatMap(([, v]) => (Array.isArray(v) ? v : [v])),
      ];
      for (const id of worn)
        expect(BUILT_IN_PARTS.concat(tagged).find((p) => p.id === id)?.gender, id).not.toBe('f');
      expect(sheetProblem(compose(look, { templates, parts: tagged }).sheet)).toBeNull();
    }
    const seen = new Set<string>();
    for (let n = 0; n < 200; n++) seen.add(randomPerson('f', tagged, rand).parts?.hair ?? '');
    expect(seen.has('p-hair-long-f')).toBe(true);
    expect(partsForSlot('face', 'f')[0].id).toBe('face-basic-f');
    expect(partsForSlot('face', 'm')[0].id).toBe('face-basic-m');
    expect(partsForSlot('hair', 'm', tagged).at(-1)!.id).toBe('p-hair-long-f');
  });

  it('HD: a part with HD art makes the look HD (32×64 frames, density 2), classic parts drawn ×2 nearest', () => {
    // an HD top: top-0 at twice the detail, one pixel of every 2×2 block a darker detail
    const top = byId('top-0');
    const W2 = SHEET_W * 2;
    const hdPx: string[] = [];
    for (let y = 0; y < SHEET_H * 2; y++)
      for (let x = 0; x < W2; x++) {
        const k = top.pixels[(y >> 1) * SHEET_W + (x >> 1)];
        hdPx.push(k === '.' ? '.' : x % 2 && y % 2 ? ALPHA[top.palette.length] : k);
      }
    const hdTop: PartData = {
      ...top,
      id: 'hd-top',
      hd: { ramp: top.ramp, palette: [...top.palette, '102030'], pixels: hdPx.join('') },
    };
    const { sheet } = composePerson({ parts: { top: 'hd-top' } }, [hdTop]);
    expect(sheet.density).toBe(2);
    expect(sheetProblem(sheet)).toBeNull();
    expect(sheet.down[1].length).toBe(64);
    expect(sheet.down[1][0].length).toBe(32);
    // the HD detail is there; the classic body is doubled (every 2×2 block of a skull pixel equal)
    expect(sheet.down.flat(2).filter((c) => c === '#102030').length).toBeGreaterThan(50);
    const [hx, hy] = [8, 10]; // inside the bald skull (body is classic only)
    const f = sheet.down[1];
    expect(
      new Set([
        f[2 * hy][2 * hx],
        f[2 * hy + 1][2 * hx],
        f[2 * hy][2 * hx + 1],
        f[2 * hy + 1][2 * hx + 1],
      ]).size,
    ).toBe(1);
    // the classic copy for what cannot draw HD: 16×32 frames, the detail gone, the body as classic
    const classic = classicOf(sheet);
    expect(sheetProblem(classic)).toBeNull();
    expect(classic.down[1].length).toBe(32);
    expect(classic.down[1][hy][hx]).toBe(composePerson({}).sheet.down[1][hy][hx]);
    // the portrait keeps HD detail: twice the classic crop
    expect(portraitOf(sheet).length).toBe(40);
    expect(portraitOf(composePerson({}).sheet).length).toBe(20);
    // through compose(): density survives, the card gets the HD portrait
    const c = compose(
      { v: 3, kind: 'person', parts: { top: 'hd-top' } },
      { templates, parts: [hdTop] },
    );
    expect(c.sheet.density).toBe(2);
    expect(c.mugshot?.length).toBe(40);
    // an HD preset sheet (the owner's sample) composes as it is
    const preset = compose({ preset: 'x' }, { templates, custom: { sheet, mugshot: null } });
    expect(preset.fellBack).toBeNull();
    expect(preset.sheet.density).toBe(2);
    // negative control: a classic look stays classic, no density
    expect(composePerson({}).sheet.density).toBeUndefined();
  });

  describe('the slot registry (CHAR-FACTORY)', () => {
    const [ax, ay] = PARTS_META.headAnchors[1];
    void ax;
    void ay;
    const at = (v: number, x: number, y: number) => sheetAt(FRAME_W + x, v * FRAME_H + y);
    it('a full-body suit clears top and bottom; back is behind the body from the front, over the clothes from behind', () => {
      const suit = solid('suit', 'fullbody', 'sheet', [at(0, 8, 22)], 'a01010');
      const tail = solid('tail', 'back', 'sheet', [at(0, 8, 22), at(1, 8, 22)], '10a010');
      const tee = solid('tee', 'top', 'sheet', [at(0, 8, 22), at(1, 8, 22)], '1010a0');
      const parts = [suit, tail, tee];
      const front = (look: PersonLook) =>
        pixelOf(composePerson(look, parts).sheet, FRAME_W + 8, 22);
      const back = (look: PersonLook) =>
        pixelOf(composePerson(look, parts).sheet, FRAME_W + 8, FRAME_H + 22);
      // with the suit, the chosen top is not drawn (nor the default one)
      expect(front({ parts: { fullbody: 'suit', top: 'tee' } })).toBe('#A01010');
      expect(back({ parts: { fullbody: 'suit', top: 'tee' } })).not.toBe('#1010A0');
      // an unknown suit (its pack off) or one not drawn for the body clears nothing: the built-in top
      const builtInTop = composePerson({ parts: {} }, parts).sheet;
      expect(composePerson({ parts: { fullbody: 'gone/suit' } }, parts).sheet).toEqual(builtInTop);
      expect(
        composePerson({ parts: { fullbody: 'suit' }, body: 'curvy' }, parts).unavailable,
      ).toContain('suit');
      expect(composePerson({ parts: { fullbody: 'suit' }, body: 'curvy' }, parts).sheet).toEqual(
        composePerson({ parts: {}, body: 'curvy' }, parts).sheet,
      );
      // the tail: under the top in front, over it from behind
      expect(front({ parts: { top: 'tee', back: 'tail' } })).toBe('#1010A0');
      expect(back({ parts: { top: 'tee', back: 'tail' } })).toBe('#10A010');
    });

    it('expressions: the chosen one, neutral when the face has none', () => {
      const face: PartData = {
        ...solid('face-x', 'face', 'head', [8], '111111'),
        expressions: {
          smile: { palette: ['222222'], pixels: solid('s', 'face', 'head', [8]).pixels },
        },
      };
      const px = (look: PersonLook) =>
        composePerson(look, [face]).sheet.down[1][PARTS_META.headAnchors[1][1]][8];
      expect(px({ parts: { face: 'face-x' } })).toBe('#111111');
      expect(px({ parts: { face: 'face-x' }, expr: 'smile' })).toBe('#222222');
      expect(px({ parts: { face: 'face-x' }, expr: 'wink' })).toBe('#111111');
    });

    it('bodies: a part drawn for the body, standard art only where the body fits, never stretched', () => {
      const curvyBody: PartData = {
        ...solid('body-c', 'body', 'sheet', [at(0, 1, 22)], 'c0a080'),
        bodies: ['curvy'],
      };
      const tee: PartData = {
        ...solid('tee2', 'top', 'sheet', [at(0, 8, 22)], '1010a0'),
        variants: {
          curvy: { palette: ['a0a010'], pixels: solid('v', 'top', 'sheet', [at(0, 8, 22)]).pixels },
        },
      };
      const plain = solid('plain', 'top', 'sheet', [at(0, 8, 22)], '30a0a0');
      const parts = [curvyBody, tee, plain];
      const r = (look: PersonLook) => composePerson(look, parts);
      expect(pixelOf(r({ parts: { top: 'tee2' }, body: 'curvy' }).sheet, FRAME_W + 8, 22)).toBe(
        '#A0A010',
      );
      // the body slot follows the body variant: the curvy body part is drawn
      expect(pixelOf(r({ parts: { top: 'tee2' }, body: 'curvy' }).sheet, FRAME_W + 1, 22)).toBe(
        '#C0A080',
      );
      // a standard-only part: fits slim, not curvy (reported, not drawn)
      expect(pixelOf(r({ parts: { top: 'plain' }, body: 'slim' }).sheet, FRAME_W + 8, 22)).toBe(
        '#30A0A0',
      );
      const curvy = r({ parts: { top: 'plain' }, body: 'curvy' });
      expect(curvy.unavailable).toContain('plain');
      expect(pixelOf(curvy.sheet, FRAME_W + 8, 22)).not.toBe('#30A0A0');
      expect(curvy.sheet.down[1].flat().some(Boolean)).toBe(true); // the body is always drawn
    });
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { rgbaToHex } from '../../core/src/assets/colorUtils.js';
import {
  HUMANOID_ACCESSORIES,
  HUMANOID_PARTS,
  MASCOT_COLORS,
  MASCOT_SPECIES,
  paletteOfLook,
  randomLook,
  swatchesOf,
} from '../../core/src/cld/looks.js';
import type { CharacterAccessory, CharacterChoice } from '../../core/src/messages.js';
import { parseHex, rgbToLab } from '../src/cld/characters/color.js';
import {
  ACCESSORIES,
  compose,
  composeMascot,
  FRAME_H,
  FRAME_W,
  FRAMES,
  headAnchors,
  HUMAN_SIP,
  lookKey,
  mascotPalette,
  MASCOTS,
  MIN_FRAME_PIXELS,
  sheetProblem,
  VIEWS,
} from '../src/cld/characters/compose.js';
import {
  convertPhoto,
  isSkinLike,
  kmeans,
  MAX_COLORS,
  MIN_COLORS,
  MUGSHOT_SIDE,
  paletteOf,
  WORK_SIDE,
} from '../src/cld/characters/convert.js';
import {
  computeTemplate,
  regionCounts,
  TEMPLATE,
  templateColor,
  TEMPLATES,
} from '../src/cld/characters/template.js';
import { REST_SPRITES, restFrame, RestWatch, sipAnchorOf } from '../src/cld/rest.js';
import { THEME } from '../src/cld/theme.js';
import { REST_ANIM_SEC, REST_SETTLE_MS } from '../src/constants.js';
import type { LoadedCharacterData } from '../src/office/sprites/spriteData.js';
import { getCharacterSprites, setCharacterTemplates } from '../src/office/sprites/spriteData.js';
import { Direction } from '../src/office/types.js';
import { syntheticPhoto } from './fixtures/syntheticPhotos.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sheets = [0, 1, 2, 3, 4, 5].map((i) =>
  PNG.sync.read(fs.readFileSync(path.join(root, `public/assets/characters/char_${i}.png`))),
);
const char0 = sheets[0];

const distinct = (rgba: ArrayLike<number>) => {
  const seen = new Set<string>();
  for (let i = 0; i < rgba.length; i += 4)
    if (rgba[i + 3] > 0) seen.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`);
  return seen;
};

describe('quantization', () => {
  it('k-means finds well separated colours and is stable for a seed', () => {
    const truth = [rgbToLab([200, 30, 30]), rgbToLab([20, 160, 40]), rgbToLab([30, 40, 210])];
    const points = Array.from({ length: 300 }, (_, i) => {
      const c = truth[i % 3];
      return { L: c.L + ((i * 7) % 5) * 0.002, a: c.a, b: c.b };
    });
    const first = kmeans(points, 3, 7);
    expect(first.centers).toHaveLength(3);
    for (const c of truth)
      expect(
        Math.min(...first.centers.map((k) => Math.hypot(k.L - c.L, k.a - c.a, k.b - c.b))),
      ).toBeLessThan(0.01);
    expect(kmeans(points, 3, 7)).toEqual(first);
  });

  it('stops at the number of colours the image has', () => {
    const flat = Array.from({ length: 50 }, (_, i) => rgbToLab(i % 2 ? [255, 0, 0] : [0, 0, 255]));
    expect(kmeans(flat, 8, 1).centers).toHaveLength(2);
  });

  it('palette: at most the chosen count (clamped to 4-16), sorted, every sample counted', () => {
    const photo = syntheticPhoto('brunette', 96);
    for (const [asked, max] of [
      [2, MIN_COLORS],
      [8, 8],
      [99, MAX_COLORS],
    ]) {
      const palette = paletteOf(photo, asked);
      expect(palette.length).toBeLessThanOrEqual(max);
      expect(palette.reduce((sum, c) => sum + c.count, 0)).toBe(WORK_SIDE * WORK_SIDE);
      expect(palette.map((c) => c.count)).toEqual(
        palette.map((c) => c.count).sort((a, b) => b - a),
      );
    }
    expect(paletteOf(photo, 8)).toEqual(paletteOf(photo, 8));
  });
});

describe('region masks', () => {
  it('stable counts on the shipped sheets, and the shipped templates match them', () => {
    const t = computeTemplate(sheets);
    expect(regionCounts(t)).toEqual({ h: 2494, s: 496, t: 793, b: 157, f: 136 });
    expect(t).toEqual(TEMPLATE);
    // CH-5: every body has its own map; bodies 2, 4 and 6 are barefoot, body 2 wears a dress
    const parts = sheets.map((_, i) => Object.keys(regionCounts(computeTemplate(sheets, i))).sort().join(''));
    expect(parts).toEqual(['bfhst', 'hst', 'bfhst', 'bhst', 'bfhst', 'bhst']);
    sheets.forEach((_, i) => expect(computeTemplate(sheets, i)).toEqual(TEMPLATES[i]));
  });

  it.each([0, 1, 2, 3, 4, 5])('body %i: outline and eye pixels are in no region', (body) => {
    const sheet = sheets[body];
    const alpha = (x: number, y: number) => sheet.data[(y * 112 + x) * 4 + 3];
    let fixed = 0;
    let outline = 0;
    for (let i = 0; i < 112 * 96; i++) {
      if (sheet.data[i * 4 + 3] < 2) continue;
      const rgba = [...sheet.data.subarray(i * 4, i * 4 + 4)].join();
      // Eyes, glasses, clipboard: the six sheets agree.
      const same = sheets.every((s) => [...s.data.subarray(i * 4, i * 4 + 4)].join() === rgba);
      // Outline: dark, on the silhouette's edge within its 16×32 frame.
      const [x, y] = [i % 112, Math.floor(i / 112)];
      const frameEdge = x % 16 === 0 || x % 16 === 15 || y % 32 === 0 || y % 32 === 31;
      const edge =
        frameEdge ||
        [alpha(x - 1, y), alpha(x + 1, y), alpha(x, y - 1), alpha(x, y + 1)].some((a) => a < 2);
      const rgb = [...sheet.data.subarray(i * 4, i * 4 + 3)] as [number, number, number];
      const isOutline = edge && rgbToLab(rgb).L < 0.4;
      fixed += same ? 1 : 0;
      outline += isOutline ? 1 : 0;
      if (same || isOutline) expect(TEMPLATES[body].regions[i]).toBe('.');
    }
    expect(fixed).toBeGreaterThan(100);
    expect(outline).toBeGreaterThan(400); // light hair (bodies 2, 4) has no dark edge
  });
});

describe('recolour', () => {
  const photo = syntheticPhoto('brunette', 96);
  const result = convertPhoto(photo, 8);

  it('keeps char_0 where it should: silhouette, outline, eyes, shirt', () => {
    expect(result.sheet).toHaveLength(112 * 96 * 4);
    for (let i = 0; i < 112 * 96; i++) {
      expect(result.sheet[i * 4 + 3]).toBe(char0.data[i * 4 + 3] < 2 ? 0 : 255);
      if (TEMPLATE.regions[i] === '.' && char0.data[i * 4 + 3] >= 2)
        expect([...result.sheet.subarray(i * 4, i * 4 + 3)]).toEqual([
          ...char0.data.subarray(i * 4, i * 4 + 3),
        ]);
    }
  });

  it('dark hair from the top, red top from the bottom, skin from the face', () => {
    const { hair, top, skin } = result.looks;
    expect(rgbToLab(hair!).L).toBeLessThan(0.4);
    expect(top![0]).toBeGreaterThan(top![1] + 80);
    expect(isSkinLike(rgbToLab(skin!))).toBe(true);
    // The hair's main step (char_0's commonest hair colour) is the hair colour itself.
    const i = [...TEMPLATE.regions].findIndex(
      (code, k) => code === 'h' && templateColor(TEMPLATE, k) === '8f6439',
    );
    const main = [...result.sheet.subarray(i * 4, i * 4 + 3)];
    main.forEach((v, k) => expect(Math.abs(v - hair![k])).toBeLessThanOrEqual(2));
  });

  it('a cat keeps char_0 skin: its face is fur, already the hair', () => {
    const cat = convertPhoto(syntheticPhoto('cat', 96), 8).looks;
    expect(cat.skin).toBeNull();
    expect(cat.hair![0]).toBeGreaterThan(cat.hair![2] + 100); // orange
  });

  it('is deterministic, and another crop gives another character', () => {
    expect(convertPhoto(photo, 8)).toEqual(result);
    const crop = { width: 48, height: 48, data: new Uint8ClampedArray(48 * 48 * 4) };
    for (let y = 0; y < 48; y++)
      crop.data.set(
        photo.data.subarray((y + 48) * 96 * 4 + 48 * 4, (y + 48) * 96 * 4 + 96 * 4),
        y * 48 * 4,
      );
    expect(convertPhoto(crop, 8).sheet).not.toEqual(result.sheet);
  });

  it('mugshot: 16×16 in the palette, no more colours than chosen', () => {
    for (const k of [4, 8, 16]) {
      const r = convertPhoto(photo, k);
      expect(r.mugshot).toHaveLength(MUGSHOT_SIDE * MUGSHOT_SIDE * 4);
      const palette = new Set(r.palette.map((c) => c.rgb.join(',')));
      const used = distinct(r.mugshot);
      expect(used.size).toBeLessThanOrEqual(k);
      for (const c of used) expect(palette.has(c)).toBe(true);
    }
  });
});

describe('looks: what the office draws for a saved look (CH-1)', () => {
  it('v1 as today; a v2 humanoid on its base sheet; a mascot as the character palette; never invisible', () => {
    expect(paletteOfLook({ palette: 3, hueShift: 90 })).toEqual({ palette: 3, hueShift: 90 });
    expect(paletteOfLook({ palette: 2 })).toEqual({ palette: 2, hueShift: 0 });
    expect(
      paletteOfLook({
        v: 2,
        kind: 'humanoid',
        base: 4,
        // eslint-disable-next-line pixel-agents/no-inline-colors -- a stored look's colour
        colors: { hair: '#000000' },
        acc: ['cap'],
      }),
    ).toEqual({ palette: 4, hueShift: 0 });
    expect(paletteOfLook({ v: 2, kind: 'humanoid', base: 1, hue: 90, acc: ['cap'] })).toEqual({
      palette: 1,
      hueShift: 90,
    });
    // null = the character's own palette (the daemon's, pinned): looks.ts keeps it.
    expect(paletteOfLook({ v: 2, kind: 'mascot', species: 'byte' })).toBeNull();
    expect(paletteOfLook(undefined)).toBeNull();
  });
});

describe('compositor and mascots (CH-2, CH-3)', () => {
  const sheetOfPng = (png: PNG): LoadedCharacterData => {
    const frame = (row: number, f: number) =>
      Array.from({ length: FRAME_H }, (_, y) =>
        Array.from({ length: FRAME_W }, (_, x) => {
          const i = ((row * FRAME_H + y) * png.width + f * FRAME_W + x) * 4;
          return rgbaToHex(png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]);
        }),
      );
    const row = (r: number) => Array.from({ length: FRAMES }, (_, f) => frame(r, f));
    return { down: row(0), up: row(1), right: row(2) };
  };
  const templates = sheets.map(sheetOfPng);
  setCharacterTemplates(templates);
  /** The 21 frames the office draws for palette:hue, in sheet order. */
  const drawn = (palette: number, hue: number) => {
    const s = getCharacterSprites(palette, hue);
    const row = (d: Direction) => [...s.walk[d].slice(0, 3), ...s.typing[d], ...s.reading[d]];
    return { down: row(Direction.DOWN), up: row(Direction.UP), right: row(Direction.RIGHT) };
  };

  it('a v1 look composes pixel-identical to what the office draws today', () => {
    for (const [palette, hueShift] of [[0, 0], [3, 90], [5, 200]]) {
      const c = compose({ palette, hueShift }, { templates });
      expect(c.fellBack).toBeNull();
      expect(c.sheet).toEqual(drawn(palette, hueShift));
    }
    // negative control: the comparison sees a one-degree hue difference
    expect(compose({ palette: 3, hueShift: 90 }, { templates }).sheet).not.toEqual(drawn(3, 89));
  });

  it('same look, same key; defaults filled in; a provider picks an unnamed species', () => {
    const byte = { v: 2, kind: 'mascot', species: 'byte' } as const;
    expect(lookKey(byte)).toBe(lookKey({ ...byte, color: MASCOT_COLORS.byte[0], expr: 'smile' }));
    expect(lookKey(byte)).not.toBe(lookKey({ ...byte, gear: 'crown' }));
    expect(lookKey({ v: 2, kind: 'mascot' }, 'codex')).toBe(lookKey(byte));
    expect(lookKey({ v: 2, kind: 'mascot' }, null)).toContain(':tori:');
    expect(lookKey({ palette: 2 })).toBe(lookKey({ palette: 2, hueShift: 0 }));
    expect(lookKey(undefined)).toBeNull();
    const a = compose(byte, { templates });
    expect(compose({ ...byte }, { templates }).sheet).toEqual(a.sheet);
  });

  it('fallback: a broken look → the provider mascot → built-in person 0; never invisible', () => {
    const missing = compose({ preset: 'gone' }, { templates, custom: null, provider: 'codex' });
    expect(missing.fellBack).toMatch(/did not load/);
    expect(missing.sheet).toEqual(compose({ v: 2, kind: 'mascot', species: 'byte' }, { templates }).sheet);
    const blank = templates[0].down.map((f) => f.map((r) => r.map(() => '')));
    const empty = compose(
      { preset: 'blank' },
      { templates, custom: { sheet: { ...templates[0], down: blank }, mugshot: null }, provider: 'claude' },
    );
    expect(empty.fellBack).toMatch(/down 1: empty/);
    expect(lookKey({ v: 2, kind: 'mascot' }, 'claude')).toContain(':coral:');
    // a custom sheet that checks out is drawn as it is
    const ok = compose({ preset: 'p' }, { templates, custom: { sheet: templates[4], mugshot: null } });
    expect(ok.fellBack).toBeNull();
    expect(ok.sheet).toBe(templates[4]);
    // with the provider's mascot unreadable too, built-in person 0
    const broken = { ...MASCOTS.tori, frames: { ...MASCOTS.tori.frames, up: [] } };
    expect(() => composeMascot({}, broken)).toThrow();
    const last = compose(
      { v: 2, kind: 'mascot', species: 'puff', expr: 'nope' as never },
      { templates, mascots: { ...MASCOTS, tori: broken } },
    );
    expect(last.fellBack).toMatch(/no face nope/);
    expect(last.sheet).toEqual(drawn(0, 0));
  });

  it('mascot format: 21 non-empty frames, feet on rows 26-31, anchors inside', () => {
    for (const species of MASCOT_SPECIES) {
      const data = MASCOTS[species];
      expect(data.species).toBe(species);
      expect(data.palette[data.body[1]].toLowerCase()).toBe(MASCOT_COLORS[species][0]);
      for (const view of VIEWS) {
        expect(data.frames[view]).toHaveLength(FRAMES);
        data.frames[view].forEach((rows, i) => {
          expect(rows).toHaveLength(FRAME_H);
          for (const row of rows) {
            expect(row).toHaveLength(FRAME_W);
            for (const k of row) expect(k === '.' || k in data.palette).toBe(true);
          }
          const opaque = rows.join('').replace(/\./g, '').length;
          expect(opaque).toBeGreaterThanOrEqual(MIN_FRAME_PIXELS);
          const lowest = rows.findLastIndex((r) => /[^.]/.test(r));
          if (i < 3) expect(lowest).toBeGreaterThanOrEqual(26);
          expect(lowest).toBeLessThanOrEqual(31);
          const a = data.anchors[view][i];
          const [x, y, w] = a.head;
          expect(x).toBeGreaterThanOrEqual(1);
          expect(x + w).toBeLessThanOrEqual(FRAME_W - 1);
          expect(y).toBeGreaterThan(0);
          expect(a.top).toBeGreaterThan(0);
          expect(a.top).toBeLessThanOrEqual(y);
          if (view === 'up') expect(a.face).toBeNull();
          else expect(a.face).not.toBeNull();
        });
      }
      expect(data.mug[1] + 16).toBeLessThanOrEqual(FRAME_H);
    }
  });

  it('every colour × expression × headgear stays inside every frame', () => {
    for (const species of MASCOT_SPECIES)
      for (const color of MASCOT_COLORS[species])
        for (const expr of ['smile', 'happy', 'focus', 'sleepy'] as const)
          for (const gear of [undefined, 'headset', 'beanie', 'sprout', 'crown'] as const) {
            const c = composeMascot({ species, color, expr, gear }, MASCOTS[species]);
            expect(c.clipped, `${species} ${color} ${expr} ${gear}`).toBe(0);
            expect(c.sheet.down[1][c.sip[1]][c.sip[0]]).not.toBe('');
          }
    // recolouring keeps the steps: the default colour gives the designed ramp back (±1)
    const coral = mascotPalette(MASCOTS.coral, MASCOT_COLORS.coral[0]);
    for (const slot of MASCOTS.coral.body)
      parseHex(coral[slot]).forEach((v, k) =>
        expect(Math.abs(v - parseHex(MASCOTS.coral.palette[slot])[k])).toBeLessThanOrEqual(1),
      );
  });

  /* eslint-disable pixel-agents/no-inline-colors -- sprite pixels and stored look colours */
  describe('people: part colours and accessories (CH-5)', () => {
    const COMBOS = Array.from({ length: 8 }, (_, m) =>
      HUMANOID_ACCESSORIES.filter((_a, i) => m & (1 << i)),
    );
    const person = (base: number, extra: Partial<CharacterChoice> = {}): CharacterChoice => ({
      v: 2,
      kind: 'humanoid',
      base,
      ...extra,
    });
    /** A sample of colourings: none, a hue, the first, last and middle swatch of every part. */
    const SAMPLES: Partial<CharacterChoice>[] = [
      {},
      { hue: 120 },
      ...[0, -1, 3].map((n) => ({
        colors: Object.fromEntries(
          HUMANOID_PARTS.map((p) => [p, swatchesOf(p).at(n % swatchesOf(p).length)!]),
        ),
      })),
    ];
    const ourColours = new Set(Object.values(ACCESSORIES.palette));
    const isEye = (c: string) => c === '#000000' || c === '#FFFFFF';

    it('the template draws each body as its PNG does', () => {
      for (let base = 0; base < 6; base++)
        expect(compose(person(base), { templates: [] }).sheet).toEqual(templates[base]);
    });

    it('6 bodies × 8 accessory sets × colour samples: inside the cell, eyes never covered', () => {
      for (let base = 0; base < 6; base++) {
        const anchors = headAnchors(base);
        for (const view of VIEWS)
          anchors[view].forEach((a) => {
            expect(a.top).toBeGreaterThanOrEqual(1);
            expect(a.eye - a.top).toBeGreaterThanOrEqual(9);
          });
        for (const sample of SAMPLES)
          for (const acc of COMBOS) {
            const what = `body ${base} ${JSON.stringify(sample)} ${acc.join('+')}`;
            const plain = compose(person(base, sample), { templates });
            const c = compose(person(base, { ...sample, acc: [...acc] }), { templates });
            expect(c.fellBack, what).toBeNull();
            expect(c.clipped, what).toBe(0);
            expect(sheetProblem(c.sheet), what).toBeNull();
            for (const view of ['down', 'right'] as const)
              for (let f = 0; f < FRAMES; f++) {
                const e = anchors[view][f].eye;
                const reading = f >= 5;
                for (let y = e; y <= e + 2; y++)
                  for (let x = 0; x < FRAME_W; x++) {
                    const was = plain.sheet[view][f][y][x];
                    const now = c.sheet[view][f][y][x];
                    // the eyes: what the frame had there (its typing frame's, once our glasses
                    // replace the reading ones), never a piece
                    if (!reading && isEye(was)) expect(now, `${what} ${view} ${f} ${x},${y}`).toBe(was);
                    if (reading && acc.includes('glasses')) {
                      const dy = e - anchors[view][3].eye;
                      const typed = plain.sheet[view][3][y - dy][x];
                      if (!ourColours.has(now) && now !== typed) expect(now, `${what} ${view} ${f} ${x},${y}`).toBe(was);
                      expect(now === '#000000' && typed !== '#000000', `${what} reading glasses left at ${x},${y}`).toBe(false);
                    }
                  }
              }
            if (!acc.includes('glasses') || acc.length > 1) continue;
            expect(c.sheet.up, `${what}: no glasses on the back`).toEqual(plain.sheet.up);
          }
      }
    });

    it('part colours: a part left out keeps the body colour; a chosen one is its main step', () => {
      for (let base = 0; base < 6; base++) {
        const t = TEMPLATES[base];
        const plain = compose(person(base), { templates: [] }).sheet;
        const hair = '#4f6fd0';
        const c = compose(person(base, { colors: { hair } }), { templates: [] }).sheet;
        const at = (s: LoadedCharacterData, i: number) => {
          const y = Math.floor(i / t.width);
          const x = i % t.width;
          return s[VIEWS[Math.floor(y / FRAME_H)]][Math.floor(x / FRAME_W)][y % FRAME_H][x % FRAME_W];
        };
        const counts = new Map<string, number>();
        for (let i = 0; i < t.width * t.height; i++) {
          if (t.regions[i] !== 'h') expect(at(c, i)).toBe(at(plain, i));
          else counts.set(templateColor(t, i), (counts.get(templateColor(t, i)) ?? 0) + 1);
        }
        const main = [...counts].sort((a, b) => b[1] - a[1])[0][0];
        const i = [...t.regions].findIndex((code, k) => code === 'h' && templateColor(t, k) === main);
        parseHex(at(c, i)).forEach((v, k) => expect(Math.abs(v - parseHex(hair)[k])).toBeLessThanOrEqual(2));
      }
    });

    it('same look, same key: colour case and accessory order do not matter; colours replace the hue', () => {
      const a = person(2, { colors: { hair: '#AABBCC', top: '#112233' }, acc: ['cap', 'glasses'] });
      const b = person(2, { colors: { top: '#112233', hair: '#aabbcc' }, acc: ['glasses', 'cap'] });
      expect(lookKey(a)).toBe(lookKey(b));
      expect(compose(a, { templates }).sheet).toEqual(compose(b, { templates }).sheet);
      expect(lookKey(person(2, { acc: ['cap'] }))).not.toBe(lookKey(person(2, { acc: ['glasses'] })));
      expect(lookKey(person(2, { hue: 30, acc: ['cap'] }))).not.toBe(lookKey(person(2, { acc: ['cap'] })));
      expect(lookKey(person(2))).not.toBe(lookKey(a));
    });

    it('🎲 on a person: a body, a swatch per part, accessories from the list', () => {
      let seed = 7;
      const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
      const seen = new Set<CharacterAccessory>();
      for (let n = 0; n < 200; n++) {
        const look = randomLook('humanoid', new Set(), (l) => lookKey(l) ?? '', rand);
        expect(look.kind).toBe('humanoid');
        for (const part of HUMANOID_PARTS) expect(swatchesOf(part)).toContain(look.colors![part]);
        look.acc?.forEach((a) => seen.add(a));
        expect(look.acc ?? []).toEqual(HUMANOID_ACCESSORIES.filter((a) => look.acc?.includes(a)));
        expect(compose(look, { templates }).clipped).toBe(0);
      }
      expect(seen.size).toBe(3);
    });
  });
  /* eslint-enable pixel-agents/no-inline-colors */
});

describe('rest moment (REST-ANIM)', () => {
  it('plays only on an increase seen live, not on load or a reconnect replay', () => {
    const w = new RestWatch();
    expect(w.observe(1, 3, 0)).toBe(false); // page load: a baseline
    expect(w.observe(1, 3, 1000)).toBe(false);
    expect(w.observe(1, 4, 2000)).toBe(true); // a live compaction
    expect(w.progress(1, 2000 + 1000)).toBeCloseTo(1);
    expect(w.progress(1, 2000 + REST_ANIM_SEC * 1000)).toBeNull(); // over
    expect(w.progress(1, 2000 + 1000)).toBeNull(); // and gone
    w.connected(10_000); // a reconnect: the replay is a baseline, even when it went up meanwhile
    expect(w.observe(1, 6, 10_100)).toBe(false);
    expect(w.observe(1, 7, 10_000 + REST_SETTLE_MS - 1)).toBe(false); // still settling
    expect(w.observe(1, 8, 10_000 + REST_SETTLE_MS)).toBe(true);
    expect(w.observe(2, 1, 20_000)).toBe(false); // a new character: a baseline
    expect(w.observe(1, 2, 20_000)).toBe(false); // a new session counts again from below
    expect(w.observe(1, 3, 21_000)).toBe(true);
  });

  it('the drink: lifted, sipped (two frames), lowered; the theme names it', () => {
    expect(THEME.rest.prop).toBe('coffee');
    expect(restFrame('coffee', 0)).toBe(REST_SPRITES.coffee.frames[0]);
    expect(REST_SPRITES.coffee.frames.slice(1)).toContain(restFrame('coffee', 1));
    expect(restFrame('coffee', REST_ANIM_SEC - 0.01)).toBe(REST_SPRITES.coffee.frames[0]);
    expect(sipAnchorOf(123456)).toEqual(HUMAN_SIP);
  });
});

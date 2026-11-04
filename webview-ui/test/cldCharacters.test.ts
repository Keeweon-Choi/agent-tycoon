import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { rgbaToHex } from '../../core/src/assets/colorUtils.js';
import { CHAR_COUNT } from '../../core/src/assets/constants.js';
import {
  MASCOT_COLORS,
  MASCOT_SPECIES,
  paletteOfLook,
  randomLook,
} from '../../core/src/cld/looks.js';
import type { CharacterChoice } from '../../core/src/messages.js';
import { parseHex } from '../src/cld/characters/color.js';
import {
  BUILT_IN_SIP,
  compose,
  composeMascot,
  FRAME_H,
  FRAME_W,
  FRAMES,
  HUMAN_SIP,
  lookKey,
  mascotPalette,
  MASCOTS,
  MIN_FRAME_PIXELS,
  peopleGroups,
  subagentProvider,
  VIEWS,
} from '../src/cld/characters/compose.js';
import { REST_SPRITES, restFrame, RestWatch, sipAnchorOf } from '../src/cld/rest.js';
import { THEME } from '../src/cld/theme.js';
import { REST_ANIM_SEC, REST_SETTLE_MS } from '../src/constants.js';
import type { LoadedCharacterData } from '../src/office/sprites/spriteData.js';
import { getCharacterSprites, setCharacterTemplates } from '../src/office/sprites/spriteData.js';
import { Direction } from '../src/office/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sheets = [...Array(CHAR_COUNT).keys()].map((i) =>
  PNG.sync.read(fs.readFileSync(path.join(root, `public/assets/characters/char_${i}.png`))),
);

describe('looks: what the office draws for a saved look (CH-1)', () => {
  it('v1 as today; a v2 humanoid on its base sheet; a mascot as the character palette; never invisible', () => {
    expect(paletteOfLook({ palette: 3, hueShift: 90 })).toEqual({ palette: 3, hueShift: 90 });
    expect(paletteOfLook({ palette: 2 })).toEqual({ palette: 2, hueShift: 0 });
    expect(
      paletteOfLook({
        v: 2,
        kind: 'humanoid',
        base: 4,
        // eslint-disable-next-line agent-tycoon/no-inline-colors -- a stored look's colour
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
    for (const [palette, hueShift] of [
      [0, 0],
      [3, 90],
      [5, 200],
    ]) {
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
    expect(missing.sheet).toEqual(
      compose({ v: 2, kind: 'mascot', species: 'byte' }, { templates }).sheet,
    );
    const blank = templates[0].down.map((f) => f.map((r) => r.map(() => '')));
    const empty = compose(
      { preset: 'blank' },
      {
        templates,
        custom: { sheet: { ...templates[0], down: blank }, mugshot: null },
        provider: 'claude',
      },
    );
    expect(empty.fellBack).toMatch(/down 1: empty/);
    expect(lookKey({ v: 2, kind: 'mascot' }, 'claude')).toContain(':coral:');
    // a custom sheet that checks out is drawn as it is
    const ok = compose(
      { preset: 'p' },
      { templates, custom: { sheet: templates[4], mugshot: null } },
    );
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
    // 11-04: twelve species, each with its own sheet
    expect(MASCOT_SPECIES).toHaveLength(12);
    expect(Object.keys(MASCOTS).sort()).toEqual([...MASCOT_SPECIES].sort());
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

  it('DIAG-1104: three-quarter walking rows (diag) in the same slots, feet and head as the front', () => {
    type Anchor = { face: number[] | null; head: number[]; top: number };
    type Diag = {
      frames: Record<'downRight' | 'upRight', string[][]>;
      anchors: Record<'downRight' | 'upRight', Anchor[]>;
      faces: Record<string, { downRight: Array<[number, number, string]> }>;
    };
    for (const species of MASCOT_SPECIES) {
      const data = MASCOTS[species];
      const diag = (data as unknown as { diag: Diag }).diag;
      expect(diag, species).toBeDefined();
      for (const view of ['downRight', 'upRight'] as const) {
        expect(diag.frames[view]).toHaveLength(3);
        diag.frames[view].forEach((rows, i) => {
          expect(rows).toHaveLength(FRAME_H);
          for (const row of rows) {
            expect(row).toHaveLength(FRAME_W);
            for (const k of row) expect(k === '.' || k in data.palette).toBe(true);
          }
          expect(rows.join('').replace(/\./g, '').length).toBeGreaterThanOrEqual(MIN_FRAME_PIXELS);
          const lowest = rows.findLastIndex((r) => /[^.]/.test(r));
          expect(lowest).toBeGreaterThanOrEqual(26);
          expect(lowest).toBeLessThanOrEqual(31);
          // the body colour is in the recolourable slots
          expect(rows.join('')).toMatch(new RegExp(`[${data.body}]`));
          const a = diag.anchors[view][i];
          // the same head box and top as the front (back) frame of that pose
          const base = data.anchors[view === 'downRight' ? 'down' : 'up'][i];
          expect(a.head).toEqual(base.head);
          expect(a.face).toEqual(view === 'upRight' ? null : base.face);
        });
      }
      for (const expr of ['smile', 'happy', 'focus', 'sleepy'])
        for (const [u, v, k] of diag.faces[expr].downRight) {
          expect(k in data.palette).toBe(true);
          const [fx, fy] = diag.anchors.downRight[1].face!;
          expect(diag.frames.downRight[1][fy + v][fx + u], `${species} ${expr}`).not.toBe('.');
        }
      expect(diag.faces.smile.downRight.length).toBeGreaterThan(0);
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

  describe('the built-in people (CHARS-1104)', () => {
    it('an old v2 humanoid draws as its base person: colours and accessories dropped, hue kept', () => {
      const old: CharacterChoice = {
        v: 2,
        kind: 'humanoid',
        base: 2,
        // eslint-disable-next-line agent-tycoon/no-inline-colors -- a stored look's colour
        colors: { hair: '#aabbcc' },
        acc: ['cap'],
      };
      expect(compose(old, { templates }).sheet).toEqual(drawn(2, 0));
      expect(lookKey(old)).toBe(lookKey({ palette: 2, hueShift: 0 }));
      expect(compose({ v: 2, kind: 'humanoid', base: 3, hue: 90 }, { templates }).sheet).toEqual(
        drawn(3, 90),
      );
    });

    it('🎲 on the people tab: one of the built-in people, each one reachable', () => {
      let seed = 7;
      const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
      const seen = new Set<number>();
      for (let n = 0; n < 500; n++) {
        const look = randomLook('humanoid', new Set(), (l) => lookKey(l) ?? '', rand);
        expect(look).toEqual({ palette: expect.any(Number), hueShift: 0 });
        seen.add(look.palette!);
      }
      expect([...seen].sort((x, y) => x - y)).toEqual([...Array(CHAR_COUNT).keys()]);
    });

    it("a built-in sheet's mouth is the people's, a preset sheet's the old body's", () => {
      expect(sipAnchorOf(0)).toEqual(BUILT_IN_SIP);
      expect(sipAnchorOf(CHAR_COUNT - 1)).toEqual(BUILT_IN_SIP);
      expect(compose({ palette: 5 }, { templates }).sip).toEqual(BUILT_IN_SIP);
      // review: an external char_N past the 23 (loaded after them) keeps the old body's mouth
      setCharacterTemplates([...templates, templates[0]]);
      try {
        expect(sipAnchorOf(CHAR_COUNT)).toEqual(HUMAN_SIP);
      } finally {
        setCharacterTemplates(templates);
      }
    });

    it('review: the people tab lists only the sheets that are there (none before they arrive)', () => {
      expect(peopleGroups(0)).toEqual([]);
      expect(peopleGroups(5)).toEqual([{ key: 'nerd', people: [0, 1, 2, 3, 4] }]);
      const all = peopleGroups(CHAR_COUNT);
      expect(all.map((g) => [g.key, g.people.length])).toEqual([
        ['nerd', 10],
        ['valley', 10],
        ['india', 3],
      ]);
      expect(all.flatMap((g) => g.people)).toEqual([...Array(CHAR_COUNT).keys()]);
      expect(
        peopleGroups(CHAR_COUNT + 1)
          .at(-1)!
          .people.at(-1),
      ).toBe(CHAR_COUNT); // an external one
    });

    it('review: a sub-agent with no employee takes Claude when its lead is not on the screen', () => {
      const office = {
        orchestrators: [
          { name: 'eng', provider: 'engine' },
          { name: 'cc', provider: 'claude' },
        ],
      } as never;
      expect(subagentProvider(office, undefined)).toBe('claude'); // an unnamed session
      expect(subagentProvider(office, 'eng')).toBe('claude'); // an engine Lead
      expect(subagentProvider(office, 'cc')).toBe('claude');
    });
  });
});

describe('rest moment (REST-ANIM)', () => {
  it('plays only on an increase seen live, not on load or a reconnect replay', () => {
    const w = new RestWatch();
    expect(w.observe(1, 3, 0)).toBe(false); // page load: a baseline
    expect(w.observe(1, 3, 1000)).toBe(false);
    expect(w.observe(1, 4, 2000)).toBe(true); // a live compaction
    expect(w.progress(1, 2000)).toBeNull(); // the director decides where the drink happens
    w.sip(1, 2000);
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

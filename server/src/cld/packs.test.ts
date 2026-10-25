import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CharacterParts as PartsMessage,
  CharacterPresets as PresetsMessage,
} from '../../../core/src/messages.js';
import { CharacterPartStore } from './characterParts.js';
import { CharacterPresets } from './characterPresets.js';
import { builtInPacksDir, loadPack, PackStore } from './packs.js';

const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
afterEach(() => warn.mockClear());

/** A w×h PNG with an n×n red block at (x, y). */
const png = (w: number, h: number, x = 4, y = 20, n = 3) => {
  const p = new PNG({ width: w, height: h });
  for (let j = y; j < y + n; j++)
    for (let i = x; i < x + n; i++) p.data.set([200, 40, 40, 255], (j * w + i) * 4);
  return PNG.sync.write(p, { colorType: 6 });
};

let root: string;
const pack = (id: string, manifest: Record<string, unknown>, files: Record<string, Buffer>) => {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'parts'), { recursive: true });
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), data);
  fs.writeFileSync(
    path.join(dir, 'pack.json'),
    JSON.stringify({ id, version: 1, title: { ko: '팩', en: 'Pack' }, ...manifest }),
  );
  return dir;
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-packs-'));
});

describe('content packs (CHAR-FACTORY)', () => {
  it('loads parts (classic, HD, per body, a face with expressions) under namespaced ids; refuses unsafe files', () => {
    const dir = pack(
      'demo',
      {
        parts: [
          {
            id: 'tee',
            slot: 'top',
            kind: 'sheet',
            bodies: { standard: 'parts/tee.png', curvy: 'parts/tee-curvy.png' },
            colorable: true,
            name: { ko: '티', en: 'Tee' },
          },
          {
            id: 'hd-hair',
            slot: 'hair',
            kind: 'head',
            file: { file: 'parts/hair-hd.png', density: 2 },
            colorable: true,
          },
          {
            id: 'face',
            slot: 'face',
            kind: 'face',
            expressions: {
              neutral: 'parts/face.png',
              smile: 'parts/face-smile.png',
              bogus: 'parts/face.png',
            },
          },
          { id: 'escape', slot: 'top', kind: 'sheet', file: '../outside.png' },
          { id: 'wrong-size', slot: 'top', kind: 'sheet', file: 'parts/small.png' },
          { id: 'bad slot', slot: 'top', kind: 'sheet', file: 'parts/tee.png' },
          { id: 'hat', slot: 'helmet', kind: 'head', file: 'parts/face.png' },
        ],
        characters: [{ id: 'ann', name: { ko: '앤', en: 'Ann' }, age: 30 }],
        presets: [
          {
            id: 'ann-basic',
            character: 'ann',
            outfit: 'basic',
            name: { ko: '앤', en: 'Ann' },
            look: {
              v: 3,
              kind: 'person',
              parts: {
                top: 'tee',
                hair: 'hd-hair',
                face: 'face',
                bottom: 'bottom-0',
                acc: ['other/ears'],
              },
              expr: 'smile',
            },
          },
          { id: 'broken', name: { ko: 'x', en: 'x' }, look: { palette: 1 } },
        ],
      },
      {
        'parts/tee.png': png(112, 96),
        'parts/tee-curvy.png': png(112, 96, 5),
        'parts/hair-hd.png': png(96, 48, 10, 10, 4),
        'parts/face.png': png(48, 24, 6, 14, 2),
        'parts/face-smile.png': png(48, 24, 6, 15, 2),
        'parts/small.png': png(16, 16, 1, 1),
      },
    );
    fs.writeFileSync(path.join(root, 'outside.png'), png(112, 96));
    const r = loadPack(dir, true);
    if ('error' in r) throw new Error(r.error);
    expect(r.parts.map((p) => p.id)).toEqual(['demo/tee', 'demo/hd-hair', 'demo/face']);
    const [tee, hair, face] = r.parts;
    expect(tee).toMatchObject({
      pack: 'demo',
      label: { ko: '티', en: 'Tee' },
      slot: 'top',
      kind: 'sheet',
    });
    expect(Object.keys(tee.variants ?? {})).toEqual(['curvy']);
    expect(tee.ramp).toEqual(['c82828']);
    expect(hair.hd?.pixels.length).toBe(96 * 48);
    expect(hair.pixels.length).toBe(48 * 24); // its classic copy
    expect(Object.keys(face.expressions ?? {})).toEqual(['smile']);
    // the preset's own ids are namespaced; built-ins and other packs' ids stay
    expect(r.summary.presets).toHaveLength(1);
    expect(r.summary.presets[0]).toMatchObject({
      id: 'demo/ann-basic',
      look: {
        v: 3,
        kind: 'person',
        expr: 'smile',
        parts: {
          top: 'demo/tee',
          hair: 'demo/hd-hair',
          face: 'demo/face',
          bottom: 'bottom-0',
          acc: ['other/ears'],
        },
      },
    });
    const skipped = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(skipped).toMatch(/escape.*(outside|bad file)/);
    expect(skipped).toMatch(/wrong-size/);
    expect(skipped).toMatch(/unknown slot/);
    // a pack whose id is not its folder's name is refused
    const odd = pack('odd', { id: 'other' }, {});
    expect(loadPack(odd, false)).toMatchObject({ error: expect.stringMatching(/folder name/) });
  });

  it('an old pack.json with the removed adult keys loads as an ordinary pack; its parts are worn like any', () => {
    pack(
      'grown',
      {
        adultOnly: true, // the removed gate's keys (10-25): read past
        defaultEnabled: false,
        parts: [{ id: 'suit', slot: 'fullbody', kind: 'sheet', file: 'parts/suit.png' }],
        characters: [{ id: 'ann', name: { ko: '앤', en: 'Ann' }, adultOriginal: true }],
        presets: [],
      },
      { 'parts/suit.png': png(112, 96) },
    );
    const store = new PackStore({ builtInDir: root, userDir: path.join(root, 'none') });
    store.load();
    expect(store.summaries()).toEqual([
      {
        id: 'grown',
        version: 1,
        title: { ko: '팩', en: 'Pack' },
        builtIn: true,
        characters: [{ id: 'ann', name: { ko: '앤', en: 'Ann' } }],
        presets: [],
      },
    ]);
    expect(store.parts().map((p) => p.id)).toEqual(['grown/suit']);
    expect(store.parts()[0]).not.toHaveProperty('adultOnly');
    // the daemon takes a look wearing it as any other
    const config2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-presets-'));
    const published: PresetsMessage[] = [];
    const presets = new CharacterPresets({
      configDir: config2,
      publish: (m) => published.push(m),
      knownKey: () => true,
    });
    presets.start();
    presets.onClientMessage({
      type: 'setCharacter',
      key: 'ann',
      character: { v: 3, kind: 'person', parts: { fullbody: 'grown/suit' } },
    });
    expect(published.at(-1)!.assignments.ann).toEqual({
      v: 3,
      kind: 'person',
      parts: { fullbody: 'grown/suit' },
    });
    presets.dispose();
  });

  it('a linked folder or pack.json leading outside is refused; a pack named constructor loads; caps', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-outside-'));
    fs.writeFileSync(path.join(outside, 'x.png'), png(112, 96));
    const dir = pack(
      'linked',
      { parts: [{ id: 'x', slot: 'top', kind: 'sheet', file: 'out/x.png' }] },
      {},
    );
    fs.symlinkSync(outside, path.join(dir, 'out'));
    const r = loadPack(dir, false);
    if ('error' in r) throw new Error(r.error);
    expect(r.parts).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/out\/x\.png: outside/);
    const pj = path.join(root, 'pj');
    fs.mkdirSync(pj);
    fs.writeFileSync(
      path.join(outside, 'pack.json'),
      JSON.stringify({ id: 'pj', version: 1, title: { ko: 'a', en: 'a' } }),
    );
    fs.symlinkSync(path.join(outside, 'pack.json'), path.join(pj, 'pack.json'));
    expect(loadPack(pj, false)).toMatchObject({ error: expect.stringMatching(/regular file/) });
    pack('constructor', { defaultEnabled: false, parts: [] }, {});
    const look = { v: 3, kind: 'person', parts: {} };
    pack(
      'many',
      {
        characters: Array.from({ length: 300 }, (_, i) => ({
          id: `c${i}`,
          name: { ko: 'a', en: 'a' },
        })),
        presets: Array.from({ length: 900 }, (_, i) => ({
          id: `p${i}`,
          name: { ko: 'a', en: 'a' },
          look,
        })),
      },
      {},
    );
    const many = loadPack(path.join(root, 'many'), false);
    if ('error' in many) throw new Error(many.error);
    expect([many.summary.characters.length, many.summary.presets.length]).toEqual([100, 400]);
    const store = new PackStore({ builtInDir: null, userDir: root });
    store.load();
    expect(store.summaries().some((p) => p.id === 'constructor')).toBe(true);
  });

  it('the part store sends every pack’s parts and presets with the imported ones', () => {
    pack(
      'fixture',
      {
        parts: [{ id: 'tee', slot: 'top', kind: 'sheet', file: 'parts/tee.png', colorable: true }],
        presets: [
          {
            id: 'one',
            name: { ko: '하나', en: 'One' },
            look: { v: 3, kind: 'person', parts: { top: 'tee' } },
          },
        ],
      },
      { 'parts/tee.png': png(112, 96) },
    );
    const msgs: PartsMessage[] = [];
    const parts = new CharacterPartStore(
      path.join(root, 'parts'),
      (m) => msgs.push(m),
      new PackStore({ builtInDir: root, userDir: path.join(root, 'user') }),
    );
    parts.start();
    const m = msgs.at(-1)!;
    expect(m.packs.map((p) => p.id)).toEqual(['fixture']);
    expect(m.packs[0].presets[0].look.parts).toEqual({ top: 'fixture/tee' });
    expect(m.parts.map((p) => p.id)).toEqual(['fixture/tee']);
    // with no packs in the repo, the built-in folder may be missing: no packs, no error
    expect(builtInPacksDir() === null || fs.existsSync(builtInPacksDir()!)).toBe(true);
  });
});

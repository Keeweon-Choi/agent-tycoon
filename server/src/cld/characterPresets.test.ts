import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HUMANOID_PARTS,
  MASCOT_COLORS,
  paletteOfLook,
  randomLook,
} from '../../../core/src/cld/looks.js';
import { checkSheetPng } from '../../../core/src/cld/sheetCheck.js';
import type { CharacterPresets as PresetsMessage } from '../../../core/src/messages.js';
import { AgentRuntime } from '../agentRuntime.js';
import { AgentStateStore } from '../agentStateStore.js';
import { createHttpServer, type HttpServerHandle } from '../httpServer.js';
import { claudeProvider } from '../providers/hook/claude/claude.js';
import {
  AUTO_PIN_TTL_DAYS,
  CharacterPresets,
  MAX_PRESET_BYTES,
  MAX_STORE_BYTES,
  MAX_STORE_ENTRIES,
  MAX_STORE_READ_BYTES,
  parseAppearance,
  parseChoice,
  pngProblem,
  PRESET_ID,
  registerCharacterRoutes,
} from './characterPresets.js';
import { CharacterBinder } from './characters.js';
import { promotePair } from './engine/leadSwap.js';
import { loadRegistry, saveRegistry } from './engine/registry.js';
import { cldHooks } from './hooks.js';
import { REPO_ROOT } from './testHome.js';

const CHAR_0 = fs.readFileSync(
  path.join(REPO_ROOT, 'webview-ui/public/assets/characters/char_0.png'),
);
const png = (w: number, h: number, colorType: 2 | 6 = 6) =>
  PNG.sync.write(new PNG({ width: w, height: h }), { colorType });

let config: string;
let published: PresetsMessage[];
let presets: CharacterPresets;
const names = new Set(['alpha', 'ops']);
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
const last = () => published[published.length - 1];
const make = () =>
  new CharacterPresets({
    configDir: config,
    publish: (m) => published.push(m),
    knownKey: (k) => names.has(k),
  });
const put = (name: string, data: Buffer | string) =>
  fs.writeFileSync(path.join(config, 'characters', name), data);

beforeEach(() => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-presets-'));
  published = [];
  warn.mockClear();
  presets = make();
  presets.start();
});
afterEach(() => {
  presets.dispose();
  fs.rmSync(config, { recursive: true, force: true });
});

describe('preset validation (pngjs)', () => {
  it('accepts the built-in sheets', () => {
    expect(pngProblem(CHAR_0, 112, 96)).toBeNull();
  });

  it('refuses a bad signature, a wrong size, a too big file and a broken body', () => {
    expect(pngProblem(Buffer.from('GIF89a, not a png at all, long enough'), 112, 96)).toBe(
      'bad PNG signature',
    );
    expect(pngProblem(png(16, 16), 112, 96)).toBe('16×16, not 112×96');
    expect(pngProblem(png(112, 95), 112, 96)).toBe('112×95, not 112×96');
    const big = Buffer.concat([CHAR_0, Buffer.alloc(MAX_PRESET_BYTES)]);
    expect(pngProblem(big, 112, 96)).toMatch(/^too big/);
    const broken = Buffer.from(CHAR_0);
    const idat = CHAR_0.indexOf('IDAT') + 4;
    broken.fill(7, idat + 40, idat + 140);
    expect(pngProblem(broken, 112, 96)).toMatch(/^broken PNG/);
  });

  it('wants 8-bit RGBA, non-interlaced; RGB only for the opaque mugshot', () => {
    expect(pngProblem(png(112, 96, 2), 112, 96)).toBe('not an 8-bit RGBA PNG');
    expect(pngProblem(png(16, 16, 2), 16, 16, true)).toBeNull();
    const interlaced = Buffer.from(CHAR_0);
    interlaced[28] = 1;
    expect(pngProblem(interlaced, 112, 96)).toBe('interlaced PNG');
  });
});

describe('ids and paths', () => {
  it('ids are lower-case names, never paths', () => {
    for (const ok of ['a', 'photo-1761040000000', 'x_y-9', 'a'.repeat(41)])
      expect(PRESET_ID.test(ok)).toBe(true);
    for (const bad of ['', '../x', 'a/b', '..', '.hidden', 'A', '-x', 'a b', 'a'.repeat(42)])
      expect(PRESET_ID.test(bad)).toBe(false);
  });

  it('serves only checked presets, by exact name', () => {
    put('ok.png', CHAR_0);
    presets.scan();
    expect(presets.file('ok.png')).toEqual(CHAR_0);
    for (const name of ['../ok.png', '..%2Fok.png', 'ok.png/..', 'OK.png', 'ok', 'README.md'])
      expect(presets.file(name)).toBeNull();
  });

  it('refuses a path-like preset in setCharacter and in characters.json', () => {
    presets.onClientMessage({
      type: 'setCharacter',
      key: 'alpha',
      character: { preset: '../../etc/passwd' },
    });
    expect(last().assignments).toEqual({});
    expect(parseChoice({ preset: '../x' })).toBeNull();
  });
});

describe('presets folder', () => {
  it('creates the folder with a Korean README and publishes the presets', () => {
    expect(fs.readFileSync(path.join(config, 'characters/README.md'), 'utf-8')).toContain(
      '112×96 RGBA PNG',
    );
    put('robot.png', CHAR_0);
    put('robot.json', JSON.stringify({ label: '로봇' }));
    put('robot.mug.png', png(16, 16));
    presets.scan();
    expect(last().presets).toEqual([
      {
        id: 'robot',
        label: '로봇',
        url: expect.stringMatching(/^cld\/characters\/robot\.png\?v=[0-9a-f]{10}$/),
        mugshotUrl: expect.stringMatching(/^cld\/characters\/robot\.mug\.png\?v=/),
      },
    ]);
  });

  it('CHAR-FACTORY: an HD sheet (224×192, density 2) with its 32×32 portrait; a half-HD size is refused', () => {
    const sample = fs.readFileSync(
      path.join(REPO_ROOT, 'cld/artifacts/char-factory/hd-sample/bunny-hd-sample.png'),
    );
    put('bunny.png', sample);
    put('bunny.mug.png', png(32, 32));
    put('odd.png', png(224, 100));
    put('robot.png', CHAR_0);
    presets.scan();
    const byId = Object.fromEntries(last().presets.map((p) => [p.id, p]));
    expect(byId.bunny).toMatchObject({
      id: 'bunny',
      density: 2,
      mugshotUrl: expect.stringMatching(/bunny\.mug\.png/),
    });
    expect(byId.robot.density).toBeUndefined();
    expect(byId.odd).toBeUndefined();
    expect(presets.file('bunny.png')).toEqual(sample);
  });

  it('ignores anything else with one log line per file', () => {
    const bad = {
      'Bad Name.png': CHAR_0,
      'Upper.png': CHAR_0,
      '-dash.png': CHAR_0,
      [`${'a'.repeat(42)}.png`]: CHAR_0,
      'text.png': 'not a png, only named like one',
      'empty.png': '',
      'small.png': png(16, 16),
      'w111.png': png(111, 96),
      'h97.png': png(112, 97),
      'big.png': Buffer.concat([CHAR_0, Buffer.alloc(MAX_PRESET_BYTES + 1 - CHAR_0.length)]),
      'notes.txt': 'hi',
      'orphan.json': '{}',
    };
    for (const [name, data] of Object.entries(bad)) put(name, data);
    put('.hidden.png', CHAR_0); // dotfiles (editor swap files, our temp files) are skipped quietly
    presets.scan();
    put('more.txt', 'x'); // a second scan must not log the first files again
    presets.scan();
    expect(last().presets).toEqual([]);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    for (const name of [...Object.keys(bad), 'more.txt'])
      expect(lines.filter((l) => l.includes(`ignored ${name}:`))).toHaveLength(1);
    expect(lines.some((l) => l.includes('.hidden'))).toBe(false);
  });

  it('a missing or broken label is the id; a README already there is kept', () => {
    presets.dispose();
    fs.writeFileSync(path.join(config, 'characters/README.md'), 'mine');
    put('a.png', CHAR_0);
    put('a.json', '{ broken');
    put('b.png', CHAR_0);
    put('b.json', JSON.stringify({ name: 'no label' }));
    presets = make();
    presets.start();
    expect(last().presets.map((p) => [p.id, p.label])).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ]);
    expect(fs.readFileSync(path.join(config, 'characters/README.md'), 'utf-8')).toBe('mine');
  });

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 80 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(check()).toBe(true);
  };

  it('sees files appear and disappear without a manual scan (fs.watch)', async () => {
    put('late.png', CHAR_0);
    await until(() => last().presets.some((p) => p.id === 'late'));
    fs.rmSync(path.join(config, 'characters/late.png'));
    await until(() => last().presets.length === 0);
  });

  it('without fs.watch, a viewer scans at once and every 30 s; nobody, never', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const watching = presets as unknown as { watcher: fs.FSWatcher | null };
      watching.watcher?.close();
      watching.watcher = null;
      const has = (id: string) => last().presets.some((p) => p.id === id);
      put('polled.png', CHAR_0);
      vi.advanceTimersByTime(10 * 60_000);
      expect(has('polled')).toBe(false);
      presets.setViewing(true);
      expect(has('polled')).toBe(true);
      put('later.png', CHAR_0);
      vi.advanceTimersByTime(29_000);
      expect(has('later')).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(has('later')).toBe(true);
      presets.setViewing(false);
      put('unseen.png', CHAR_0);
      vi.advanceTimersByTime(10 * 60_000);
      expect(has('unseen')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('assignment store', () => {
  it('persists looks by character name across restarts', () => {
    put('robot.png', CHAR_0);
    presets.scan();
    presets.onClientMessage({ type: 'setCharacter', key: 'alpha', character: { preset: 'robot' } });
    presets.onClientMessage({
      type: 'setCharacter',
      key: 'ops',
      character: { palette: 3, hueShift: 90 },
    });
    const want = { alpha: { preset: 'robot' }, ops: { palette: 3, hueShift: 90 } };
    expect(last().assignments).toEqual(want);
    expect(JSON.parse(fs.readFileSync(path.join(config, 'characters.json'), 'utf-8'))).toEqual(
      want,
    );
    presets.dispose();
    presets = make();
    presets.start();
    expect(last().assignments).toEqual(want);
  });

  it('refuses unknown names, unknown presets and bad looks; null resets', () => {
    for (const character of [
      { preset: 'nope' },
      { palette: 6 },
      { palette: 1, hueShift: -5 },
      { x: 1 },
      'red',
    ])
      presets.onClientMessage({ type: 'setCharacter', key: 'alpha', character });
    presets.onClientMessage({ type: 'setCharacter', key: 'stranger', character: { palette: 1 } });
    expect(last().assignments).toEqual({});
    presets.onClientMessage({ type: 'setCharacter', key: 'alpha', character: { palette: 1 } });
    expect(last().assignments).toEqual({ alpha: { palette: 1, hueShift: 0 } });
    presets.onClientMessage({ type: 'setCharacter', key: 'alpha', character: null });
    expect(last().assignments).toEqual({});
  });

  it('keeps entries it cannot read, and backs up a file it cannot parse', () => {
    presets.dispose();
    const store = path.join(config, 'characters.json');
    fs.writeFileSync(store, JSON.stringify({ old: { palette: 99 }, beta: { palette: 2 } }));
    presets = make();
    presets.start();
    presets.onClientMessage({ type: 'setCharacter', key: 'alpha', character: { palette: 1 } });
    expect(JSON.parse(fs.readFileSync(store, 'utf-8'))).toEqual({
      old: { palette: 99 },
      beta: { palette: 2, hueShift: 0 },
      alpha: { palette: 1, hueShift: 0 },
    });
    presets.dispose();
    fs.writeFileSync(store, '{ broken');
    presets = make();
    presets.start();
    presets.onClientMessage({ type: 'setCharacter', key: 'alpha', character: { palette: 1 } });
    const bak = fs.readdirSync(config).find((f) => f.startsWith('characters.json.bak-'));
    expect(fs.readFileSync(path.join(config, bak!), 'utf-8')).toBe('{ broken');
  });
});

describe('routes', () => {
  let server: HttpServerHandle | undefined;
  afterEach(async () => {
    await server?.app.close();
    delete cldHooks.registerRoutes;
  });
  const start = async () => {
    cldHooks.registerRoutes = (app, auth) => registerCharacterRoutes(app, auth, presets);
    server = await createHttpServer({
      embedded: false,
      host: '127.0.0.1',
      token: 'test-server-token',
      store: new AgentStateStore(),
      staticDir: process.cwd(),
      listen: false,
    });
    return server.app;
  };
  const bearer = { authorization: 'Bearer test-server-token' };

  it('needs the login session or token, even for a .png path', async () => {
    put('ok.png', CHAR_0);
    presets.scan();
    const app = await start();
    expect((await app.inject('/cld/characters/ok.png')).statusCode).toBe(401);
    const res = await app.inject({ url: '/cld/characters/ok.png', headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload).toEqual(CHAR_0);
    for (const url of ['/cld/characters/..%2F..%2Fcharacters.json', '/cld/characters/nope.png'])
      expect((await app.inject({ url, headers: bearer })).statusCode).toBe(404);
    const post = await app.inject({ method: 'POST', url: '/cld/characters', payload: {} });
    expect(post.statusCode).toBe(401);
    // A browser's login session (cookie) is enough.
    const { code } = (
      await app.inject({ method: 'POST', url: '/api/login-code', headers: bearer })
    ).json<{ code: string }>();
    const login = await app.inject(`/login?code=${encodeURIComponent(code)}`);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const viaCookie = await app.inject({ url: '/cld/characters/ok.png', headers: { cookie } });
    expect(viaCookie.statusCode).toBe(200);
  });

  it('upload: checks the origin, saves photo-<time>.png with its mugshot, assigns it', async () => {
    const app = await start();
    const page = { host: 'office.test', origin: 'http://office.test' };
    const send = (payload: Record<string, unknown>, headers: Record<string, string> = bearer) =>
      app.inject({
        method: 'POST',
        url: '/cld/characters',
        headers: { ...page, ...headers },
        payload,
      });
    const b64 = (buf: Buffer) => buf.toString('base64');
    const sheet = b64(CHAR_0);
    const mugshot = b64(png(16, 16, 2));
    const big = Buffer.concat([CHAR_0, Buffer.alloc(MAX_PRESET_BYTES + 1 - CHAR_0.length)]);
    const refused = [
      { key: 'alpha', sheet: b64(Buffer.from('GIF89a, not a png at all, long enough')) },
      { key: 'alpha', sheet: b64(png(111, 96)) },
      { key: 'alpha', sheet: b64(png(112, 97)) },
      { key: 'alpha', sheet: b64(big) },
      { key: 'alpha', sheet, mugshot: b64(png(17, 16)) },
      { key: 'alpha', sheet: '!!not base64!!' },
      { key: 'stranger', sheet },
      { key: '../alpha', sheet },
    ];
    for (const payload of refused) expect((await send(payload)).statusCode).toBe(400);
    expect((await send({ key: 'alpha', sheet, mugshot }, {})).statusCode).toBe(401);
    expect(fs.readdirSync(path.join(config, 'characters'))).toEqual(['README.md']);
    const foreign = await send(
      { key: 'alpha', sheet, mugshot },
      { ...bearer, origin: 'https://attacker.example' },
    );
    expect(foreign.statusCode).toBe(403);
    expect(fs.readdirSync(path.join(config, 'characters'))).toEqual(['README.md']);
    const ok = await send({ key: 'alpha', sheet, mugshot });
    expect(ok.statusCode).toBe(200);
    const { id } = ok.json<{ id: string }>();
    expect(id).toMatch(/^photo-\d+$/);
    expect(fs.readFileSync(path.join(config, `characters/${id}.png`))).toEqual(CHAR_0);
    expect(fs.existsSync(path.join(config, `characters/${id}.mug.png`))).toBe(true);
    expect(last().assignments).toEqual({ alpha: { preset: id } });
    expect(last().presets.find((p) => p.id === id)?.label).toBe('alpha 사진');
  });
});

/* eslint-disable pixel-agents/no-inline-colors -- stored looks' colours are data here, not UI */
describe('appearance v2 and the pin migration (CH-1)', () => {
  const store = () => path.join(config, 'characters.json');
  const registry = () => path.join(config, 'projects.json');
  const read = () => JSON.parse(fs.readFileSync(store(), 'utf-8')) as Record<string, unknown>;
  const restart = () => {
    presets.dispose();
    presets = make();
    presets.start();
  };
  const stamp = () => {
    const st = fs.statSync(store());
    return `${st.ino}:${st.mtimeMs}:${fs.readFileSync(store(), 'utf-8')}`;
  };
  const registryNames = () => loadRegistry(registry()).projects.map((p) => p.name);
  /** proj (Lead) + its Worker w1, solo (Lead): the engine's files, the engine itself off. */
  const writeRegistry = () => {
    const folder = config;
    saveRegistry(
      registry(),
      [
        { name: 'proj', folder, wantRunning: false },
        { name: 'solo', folder, wantRunning: false },
      ],
      () => undefined,
    );
    const [proj] = loadRegistry(registry()).projects;
    saveRegistry(
      registry(),
      [
        ...loadRegistry(registry()).projects,
        { projectId: proj.projectId, role: 'worker', name: 'w1', folder, wantRunning: false },
      ],
      () => undefined,
    );
    expect(registryNames()).toEqual(['proj', 'solo', 'w1']);
  };

  const v2 = {
    painted: {
      v: 2,
      kind: 'humanoid',
      base: 2,
      colors: { hair: '#6D4726', top: '#1164a9' },
      acc: ['glasses', 'cap'],
    },
    plain: { v: 2, kind: 'humanoid', base: 4, hue: 90 },
    byte: {
      v: 2,
      kind: 'mascot',
      species: 'byte',
      color: '#3d8fdc',
      expr: 'smile',
      gear: 'headset',
    },
    tori: { v: 2, kind: 'mascot' },
    sheet: { v: 2, kind: 'custom', sheet: 'photo-1761300000000' },
  };
  const stored = {
    painted: {
      v: 2,
      kind: 'humanoid',
      base: 2,
      colors: { hair: '#6d4726', top: '#1164a9' },
      acc: ['glasses', 'cap'],
    },
    plain: { palette: 4, hueShift: 90 }, // unchanged humanoid: the v1 shape
    byte: v2.byte,
    tori: v2.tori,
    sheet: { preset: 'photo-1761300000000' }, // a custom sheet = a v1 preset
  };

  it('parses every v2 kind into its stored form and round-trips it', () => {
    for (const k of Object.keys(v2) as Array<keyof typeof v2>)
      expect(parseAppearance(v2[k])).toEqual(stored[k]);
    for (const k of Object.keys(stored) as Array<keyof typeof stored>)
      expect(parseAppearance(stored[k])).toEqual(stored[k]);
    restart();
    fs.writeFileSync(store(), JSON.stringify({ ...v2, $meta: { v: 2, pinnedAt: 'x' } }, null, 2));
    restart();
    expect(last().assignments).toEqual(stored);
    names.add('painted');
    presets.onClientMessage({
      type: 'setCharacter',
      key: 'alpha',
      character: { v: 2, kind: 'mascot', species: 'coral', expr: 'focus' },
    });
    expect(read()).toEqual({
      ...stored,
      alpha: { v: 2, kind: 'mascot', species: 'coral', expr: 'focus' },
      $meta: { v: 2, pinnedAt: 'x' },
    });
    restart();
    expect(last().assignments.alpha).toEqual({
      v: 2,
      kind: 'mascot',
      species: 'coral',
      expr: 'focus',
    });
    names.delete('painted');
  });

  it('a humanoid keeps its hue beside accessories, and is drawn with it', () => {
    const capped = { v: 2, kind: 'humanoid', base: 1, hue: 90, acc: ['cap'] };
    expect(parseAppearance(capped)).toEqual(capped);
    expect(paletteOfLook(parseAppearance(capped)!)).toEqual({ palette: 1, hueShift: 90 });
    expect(parseAppearance({ ...capped, hue: 0 })).toEqual({
      v: 2,
      kind: 'humanoid',
      base: 1,
      acc: ['cap'],
    });
    expect(paletteOfLook(parseAppearance(v2.painted)!)).toEqual({ palette: 2, hueShift: 0 });
  });

  it('refuses bad v2 values', () => {
    for (const bad of [
      { v: 3, kind: 'humanoid' },
      { v: 2 },
      { v: 2, kind: 'robot' },
      { v: 2, kind: 'humanoid', base: 6 },
      { v: 2, kind: 'humanoid', hue: 350 },
      { v: 2, kind: 'humanoid', hue: 30, colors: { hair: '#000000' } },
      { v: 2, kind: 'humanoid', colors: { hat: '#000000' } },
      { v: 2, kind: 'humanoid', colors: { hair: 'red' } },
      { v: 2, kind: 'humanoid', acc: ['glasses', 'glasses'] },
      { v: 2, kind: 'humanoid', acc: ['monocle'] },
      { v: 2, kind: 'humanoid', palette: 1 },
      { v: 2, kind: 'mascot', species: 'dragon' },
      { v: 2, kind: 'mascot', color: '#12345' },
      { v: 2, kind: 'mascot', expr: 'angry' },
      { v: 2, kind: 'mascot', gear: 'hat' },
      { v: 2, kind: 'custom', sheet: '../x' },
      { v: 2, kind: 'custom' },
      { palette: 1, v: 2 },
    ])
      expect(parseAppearance(bad)).toBeNull();
  });

  it('a v3 person (CHAR-HUMAN): parts and colours per slot, stored as sent (colours lower case)', () => {
    const person = {
      v: 3,
      kind: 'person',
      gender: 'f',
      parts: {
        body: 'basic',
        face: 'face-basic-f',
        top: 'p-top-hoodie-1761',
        hair: 'hair-1',
        acc: ['acc-beanie'],
      },
      colors: { skin: '#E9A384', hair: '#1f1b1c', outer: '#27ae60', acc: '#c0392b' },
    };
    const stored = { ...person, colors: { ...person.colors, skin: '#e9a384' } };
    expect(parseAppearance(person)).toEqual(stored);
    expect(parseAppearance(stored)).toEqual(stored);
    expect(parseAppearance(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    // the least person: built-ins everywhere
    expect(parseAppearance({ v: 3, kind: 'person' })).toEqual({ v: 3, kind: 'person', parts: {} });
    expect(parseAppearance({ v: 3, kind: 'person', parts: { acc: [] } })).toEqual({
      v: 3,
      kind: 'person',
      parts: {},
    });
    // an older daemon's reader (v1 only) does not take it; this one stores it
    expect(parseChoice(person)).toBeNull();
    presets.onClientMessage({ type: 'setCharacter', key: 'alpha', character: person as never });
    expect(last().assignments.alpha).toEqual(stored);
    for (const bad of [
      { v: 3, kind: 'person', gender: 'x' },
      { v: 3, kind: 'person', parts: { hat: 'a' } },
      { v: 3, kind: 'person', parts: { top: '../x' } },
      { v: 3, kind: 'person', parts: { top: 'A' } },
      { v: 3, kind: 'person', parts: { top: 7 } },
      { v: 3, kind: 'person', parts: { acc: 'acc-cap' } },
      { v: 3, kind: 'person', parts: { acc: ['a', 'a'] } },
      { v: 3, kind: 'person', parts: { acc: ['a', 'b', 'c', 'd'] } },
      { v: 3, kind: 'person', colors: { hat: '#000000' } },
      { v: 3, kind: 'person', colors: { top: 'red' } },
      { v: 3, kind: 'person', base: 1 },
      { v: 3, kind: 'person', parts: [] },
      { v: 2, kind: 'person' },
    ])
      expect(parseAppearance(bad), JSON.stringify(bad)).toBeNull();
  });

  it('CHAR-FACTORY: the new slots, body and expression; a full-body suit clears top and bottom; an old adult mark is dropped', () => {
    const look = {
      v: 3,
      kind: 'person',
      body: 'curvy',
      expr: 'wink',
      adult: true, // the removed adult-original mark (10-25): read past, not stored
      parts: {
        top: 'hair-0',
        bottom: 'bottom-0',
        fullbody: 'some-pack/bunny-suit',
        back: 'x/tail',
        legwear: 'a',
        neck: 'b',
        wrist: 'c',
      },
      colors: {
        legwear: '#101010',
        fullbody: '#202020',
        neck: '#303030',
        wrist: '#404040',
        back: '#505050',
      },
    };
    const stored = parseAppearance(look)!;
    expect(stored).toMatchObject({ body: 'curvy', expr: 'wink' });
    expect(stored).not.toHaveProperty('adult');
    expect(stored.parts).toEqual({
      fullbody: 'some-pack/bunny-suit',
      back: 'x/tail',
      legwear: 'a',
      neck: 'b',
      wrist: 'c',
    });
    expect(parseAppearance(stored)).toEqual(stored);
    // defaults are left out of the stored form
    expect(
      parseAppearance({ v: 3, kind: 'person', body: 'standard', expr: 'neutral', adult: false }),
    ).toEqual({ v: 3, kind: 'person', parts: {} });
    for (const bad of [
      { v: 3, kind: 'person', body: 'tall' },
      { v: 3, kind: 'person', expr: 'focus' }, // a mascot face, not a person's
      { v: 3, kind: 'person', parts: { top: 'a/b/c' } },
    ])
      expect(parseAppearance(bad), JSON.stringify(bad)).toBeNull();
    // the mascot faces stay the mascot's
    expect(parseAppearance({ v: 2, kind: 'mascot', expr: 'wink' })).toBeNull();
  });

  it('CHAR-FACTORY: a person look is kept by the persistent name across renew, rebirth, reassignment and restarts', () => {
    // looks are keyed by the persistent name: an engine project (its session renews and is
    // reborn under the same name), a Claude session's name, a roster employee's emp:<id> (a
    // sub-agent or Codex temp reassigned to that employee draws its look)
    names.add('emp:7');
    const look = {
      v: 3,
      kind: 'person',
      gender: 'f',
      body: 'curvy',
      expr: 'smile',
      parts: { hair: 'some-pack/serin-hair', fullbody: 'some-pack/bunny-suit' },
    };
    restart();
    for (const key of ['alpha', 'emp:7'])
      presets.onClientMessage({ type: 'setCharacter', key, character: look });
    const stored = last().assignments.alpha;
    expect(stored).toMatchObject({ body: 'curvy', expr: 'smile' });
    vi.useFakeTimers();
    try {
      // the session renews: the same name comes back live with another palette; nobody's pin moves it
      names.add('gone');
      presets.pin(
        [
          { name: 'alpha', palette: 4, hueShift: 30, provider: 'claude' },
          { name: 'gone', palette: 1, hueShift: 0, provider: null },
        ],
        () => [],
      );
      expect(last().assignments.alpha).toEqual(stored);
      expect(last().assignments.gone).toBeDefined(); // an automatic pin
      // far past the automatic pins' lifetime, not seen at all: the owner's choice stays
      vi.setSystemTime(Date.now() + (AUTO_PIN_TTL_DAYS + 5) * 86_400_000);
      presets.pin([], () => []);
      expect(last().assignments.alpha).toEqual(stored);
      expect(last().assignments['emp:7']).toEqual(stored);
      // negative control: the automatic pin of a name not seen since does go
      expect(last().assignments.gone).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    // a daemon restart reads it back as it was
    restart();
    expect(last().assignments.alpha).toEqual(stored);
    expect(last().assignments['emp:7']).toEqual(stored);
  });

  it('CHAR-FACTORY verify: a look waits out a gap (name gone, daemon restarted, its pack off) and holds no session id', () => {
    names.add('w1');
    const look = {
      v: 3,
      kind: 'person',
      body: 'curvy',
      expr: 'wink',
      parts: { hair: 'mypack/bob', fullbody: 'mypack/suit', acc: ['mypack/ears'] },
      colors: { hair: '#aa3322', back: '#123456' },
    };
    restart();
    presets.onClientMessage({ type: 'setCharacter', key: 'w1', character: look });
    const stored = last().assignments.w1;
    expect(stored).toMatchObject({ body: 'curvy', expr: 'wink', parts: look.parts });
    // the Worker is between lives: not live, not known; the daemon restarts without its pack's parts
    names.delete('w1');
    restart();
    presets.pin([], () => []);
    expect(last().assignments.w1).toEqual(stored);
    // reborn under the same name with a new session and palette: the same look
    names.add('w1');
    presets.pin([{ name: 'w1', palette: 3, hueShift: 120, provider: 'claude' }], () => []);
    expect(last().assignments.w1).toEqual(stored);
    const file = fs.readFileSync(path.join(config, 'characters.json'), 'utf-8');
    expect(file).not.toMatch(/session|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('keeps an entry it cannot read byte for byte; that character gets no choice', () => {
    const odd = {
      dragon: { v: 2, kind: 'mascot', species: 'dragon', color: '#ffffff' },
      future: { v: 3, kind: 'hologram', layers: [1, 2, { deep: true }] },
      both: { v: 2, kind: 'humanoid', hue: 30, colors: { hair: '#000000' } },
    };
    const text = JSON.stringify({ ...odd, beta: { palette: 2, hueShift: 0 } }, null, 2) + '\n';
    restart();
    fs.writeFileSync(store(), text);
    restart();
    expect(last().assignments).toEqual({ beta: { palette: 2, hueShift: 0 } });
    presets.onClientMessage({ type: 'setCharacter', key: 'alpha', character: { palette: 1 } });
    const after = fs.readFileSync(store(), 'utf-8');
    for (const [key, value] of Object.entries(odd)) {
      const entry = `  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, '\n  ')}`;
      expect(text).toContain(entry);
      expect(after).toContain(entry);
    }
    expect(Object.keys(read())).toEqual(['dragon', 'future', 'both', 'beta', 'alpha']);
  });

  it('adds at most 500 entries and 64 KB; reads a bigger file (up to 1 MB) and keeps its choices', () => {
    const entries = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`c${i}`, { palette: i % 6, hueShift: 0 }]),
      );
    const meta = { $meta: { v: 2, pinnedAt: 'x' } };
    restart();
    fs.writeFileSync(store(), JSON.stringify({ ...entries(600), ...meta }));
    restart();
    expect(Object.keys(last().assignments)).toHaveLength(600); // an older version wrote it: kept
    const before = stamp();
    presets.onClientMessage({ type: 'setCharacter', key: 'alpha', character: { palette: 1 } });
    expect(stamp()).toBe(before); // a 601st is refused
    expect(last().assignments.alpha).toBeUndefined();
    names.add('c0');
    presets.onClientMessage({ type: 'setCharacter', key: 'c0', character: { palette: 5 } });
    presets.onClientMessage({ type: 'setCharacter', key: 'c0', character: null });
    names.delete('c0');
    expect(read().c0).toBeUndefined(); // changing or removing one of them is fine
    expect(Object.keys(read())).toHaveLength(600); // 599 + $meta
    // Still past 500: the file may shrink, never grow.
    presets.onClientMessage({ type: 'setCharacter', key: 'alpha', character: { palette: 1 } });
    expect(read().alpha).toBeUndefined();

    fs.writeFileSync(
      store(),
      JSON.stringify({ blob: { note: 'x'.repeat(MAX_STORE_BYTES - 100) } }),
    );
    restart();
    const bigBefore = stamp();
    presets.onClientMessage({
      type: 'setCharacter',
      key: 'alpha',
      character: {
        v: 2,
        kind: 'humanoid',
        colors: { hair: '#000000', skin: '#111111', top: '#222222' },
      },
    });
    expect(stamp()).toBe(bigBefore); // past 64 KB by this addition: not written
    const huge = JSON.stringify({ alpha: { palette: 3 }, blob: 'x'.repeat(MAX_STORE_READ_BYTES) });
    fs.writeFileSync(store(), huge);
    restart();
    expect(last().assignments).toEqual({}); // past the 1 MB sanity cap: not parsed
    expect(MAX_STORE_ENTRIES).toBe(500);
  });

  it('an unreadable file is kept as a new .bak-<time> each time, never over an earlier one', () => {
    const baks = () => fs.readdirSync(config).filter((f) => f.startsWith('characters.json.bak'));
    restart();
    fs.writeFileSync(store(), '{ first broken');
    restart();
    presets.onClientMessage({ type: 'setCharacter', key: 'alpha', character: { palette: 1 } });
    expect(baks()).toHaveLength(1);
    fs.writeFileSync(store(), '[ "second broken" ]');
    restart();
    presets.onClientMessage({ type: 'setCharacter', key: 'alpha', character: { palette: 2 } });
    const kept = baks().map((f) => fs.readFileSync(path.join(config, f), 'utf-8'));
    expect(kept.sort()).toEqual(['[ "second broken" ]', '{ first broken'].sort());
    expect(baks().every((f) => /^characters\.json\.bak-\d+(-\d+)?$/.test(f))).toBe(true);
  });

  it('first start: pins every live and registry name in one write, then $meta; a second start writes nothing', () => {
    writeRegistry();
    restart();
    expect(fs.existsSync(store())).toBe(false);
    const sent = published.length;
    presets.pin([{ name: 'alpha', palette: 2, hueShift: 0 }], registryNames);
    expect(published.length).toBe(sent + 1); // one change, one save
    const file = read();
    expect(Object.keys(file)).toEqual(['alpha', 'proj', 'solo', 'w1', '$meta']);
    expect(file.alpha).toEqual({ palette: 2, hueShift: 0 });
    const day = Math.floor(Date.now() / 86_400_000);
    expect(file.$meta).toEqual({
      v: 2,
      pinnedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      // automatic looks, each with the exact v1 look and day it was last seen
      auto: {
        alpha: { d: day, palette: 2, hueShift: 0 },
        proj: { d: day, palette: expect.any(Number), hueShift: 0 },
        solo: { d: day, palette: expect.any(Number), hueShift: 0 },
        w1: { d: day, palette: expect.any(Number), hueShift: 0 },
      },
    });
    const palettes = ['alpha', 'proj', 'solo', 'w1'].map(
      (n) => (file[n] as { palette: number }).palette,
    );
    expect(new Set(palettes).size).toBe(4); // the server's diversity rule: unused palettes first
    expect(fs.existsSync(`${store()}.tmp`)).toBe(false);

    const before = stamp();
    restart();
    const looks = last().assignments;
    presets.pin([{ name: 'alpha', palette: 4, hueShift: 120 }], registryNames);
    presets.pin([], registryNames);
    expect(stamp()).toBe(before);
    expect(last().assignments).toEqual(looks);
    expect(presets.paletteOf('alpha')).toEqual({ palette: 2, hueShift: 0 });
  });

  it('after $meta a new name is pinned once, registry names are not re-read', () => {
    restart();
    presets.pin([], () => []);
    expect(Object.keys(read())).toEqual(['$meta']);
    restart();
    presets.pin([{ name: 'newbie', palette: 3, hueShift: 45, provider: 'codex' }], () => {
      throw new Error('the registry is read only by the first pin');
    });
    const byte = { v: 2, kind: 'mascot', species: 'byte', color: MASCOT_COLORS.byte[0] };
    expect(read().newbie).toEqual(byte);
    const before = stamp();
    presets.pin([{ name: 'newbie', palette: 0, hueShift: 0, provider: 'claude' }], () => []);
    restart();
    presets.pin([{ name: 'newbie', palette: 1, hueShift: 0 }], () => []);
    expect(stamp()).toBe(before);
    expect(last().assignments.newbie).toEqual(byte); // a provider change keeps it
    expect(presets.paletteOf('newbie')).toBeNull(); // the screen draws the mascot
  });

  it("CH-3: a new name gets its provider's mascot in the least used colour; pinned names keep theirs", () => {
    restart();
    presets.pin([{ name: 'old', palette: 2, hueShift: 0, provider: 'claude' }], () => []); // first start
    expect(read().old).toEqual({ palette: 2, hueShift: 0 });
    const seen = (name: string, provider?: string) => ({ name, palette: 1, hueShift: 0, provider });
    presets.pin(
      [
        seen('old', 'codex'),
        seen('c1', 'claude'),
        seen('c2', 'claude'),
        seen('x1', 'codex'),
        seen('t1', 'gemini'),
        seen('t2'),
      ],
      () => [],
    );
    const file = read();
    const mascot = (species: string, color: string) => ({ v: 2, kind: 'mascot', species, color });
    expect(file.old).toEqual({ palette: 2, hueShift: 0 }); // untouched
    expect(file.c1).toEqual(mascot('coral', MASCOT_COLORS.coral[0]));
    expect(file.c2).toEqual(mascot('coral', MASCOT_COLORS.coral[1]));
    expect(file.x1).toEqual(mascot('byte', MASCOT_COLORS.byte[0]));
    expect(file.t1).toEqual(mascot('tori', MASCOT_COLORS.tori[0]));
    expect(file.t2).toEqual(mascot('tori', MASCOT_COLORS.tori[1]));
    // remembered as automatic looks, across a restart, until the owner changes one
    const auto = (read().$meta as { auto: Record<string, unknown> }).auto;
    expect(auto.c1).toEqual(
      expect.objectContaining({ species: 'coral', color: MASCOT_COLORS.coral[0] }),
    );
    restart();
    presets.pin([seen('c1', 'claude')], () => []);
    expect((read().$meta as { auto: Record<string, unknown> }).auto).toHaveProperty('c1');
    names.add('c1');
    try {
      presets.onClientMessage({
        type: 'setCharacter',
        key: 'c1',
        character: {
          v: 2,
          kind: 'mascot',
          species: 'coral',
          color: MASCOT_COLORS.coral[0],
          gear: 'crown',
        },
      });
    } finally {
      names.delete('c1');
    }
    expect((read().$meta as { auto: Record<string, unknown> }).auto).not.toHaveProperty('c1');
  });

  it('CH-4 꾸미기: a saved look round trips; 기본으로 (null) becomes the recommendation at the next pin', () => {
    restart();
    presets.pin([], () => []); // first start: $meta
    const look = {
      v: 2,
      kind: 'mascot',
      species: 'puff',
      color: '#f58ab4',
      expr: 'sleepy',
      gear: 'crown',
    };
    presets.onClientMessage({ type: 'setCharacter', key: 'alpha', character: look });
    restart();
    expect(last().assignments.alpha).toEqual(look);
    presets.onClientMessage({ type: 'setCharacter', key: 'alpha', character: null });
    expect(last().assignments).not.toHaveProperty('alpha');
    presets.pin([{ name: 'alpha', palette: 3, hueShift: 0, provider: 'codex' }], () => []);
    expect(last().assignments.alpha).toEqual({
      v: 2,
      kind: 'mascot',
      species: 'byte',
      color: MASCOT_COLORS.byte[0],
    });
  });

  it('CH-4 🎲: every random look is one the daemon stores as it is, and it rerolls past taken looks', () => {
    const key = (l: object) => JSON.stringify(l);
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 300; i++)
      for (const kind of ['mascot', 'humanoid'] as const) {
        const look = randomLook(kind, new Set(), key, rand);
        expect(parseAppearance(look)).toEqual(look);
        if (look.kind === 'mascot') expect(MASCOT_COLORS[look.species!]).toContain(look.color);
        else expect(Object.keys(look.colors!).sort()).toEqual([...HUMANOID_PARTS].sort());
      }
    // the first draw is taken: the next one is used
    const draws = [0, 0, 0, 0, 0.99, 0.99, 0.99, 0.99];
    const scripted = () => draws.shift() ?? 0;
    const first = randomLook('mascot', new Set(), key, () => 0);
    expect(randomLook('mascot', new Set([key(first)]), key, scripted)).not.toEqual(first);
  });

  it('$meta is never a character: not by setCharacter, not by a pin', () => {
    restart();
    fs.writeFileSync(store(), JSON.stringify({ $meta: { v: 2, pinnedAt: 'x' } }));
    restart();
    names.add('$meta');
    try {
      presets.onClientMessage({ type: 'setCharacter', key: '$meta', character: { palette: 1 } });
      presets.pin([{ name: '$meta', palette: 3, hueShift: 0 }], () => ['$meta']);
    } finally {
      names.delete('$meta');
    }
    expect(read()).toEqual({ $meta: { v: 2, pinnedAt: 'x' } });
    expect(last().assignments).toEqual({});
  });

  describe('automatic looks (pins) give way to the owner', () => {
    const DAY = 86_400_000;
    const at = (day: number) => vi.setSystemTime(day * DAY + 3_600_000);
    const pinned = (d: number, palette: number, hueShift = 0) => ({ d, palette, hueShift });
    const auto = () =>
      (read().$meta as { auto?: Record<string, ReturnType<typeof pinned>> }).auto ?? {};
    const replies: Array<Record<string, unknown>> = [];
    const choose = (key: string, character: unknown) =>
      presets.onClientMessage({ type: 'setCharacter', key, character }, (m) => replies.push(m));
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      replies.length = 0;
    });
    afterEach(() => vi.useRealTimers());

    it('the owner choosing a pinned name makes it theirs; a name unseen for 90 days loses its pin', () => {
      at(20_000);
      restart();
      presets.pin(
        [
          { name: 'alpha', palette: 1, hueShift: 0 },
          { name: 'old', palette: 2, hueShift: 0 },
          { name: 'ops', palette: 3, hueShift: 0 },
        ],
        () => [],
      );
      expect(auto()).toEqual({
        alpha: pinned(20_000, 1),
        old: pinned(20_000, 2),
        ops: pinned(20_000, 3),
      });
      choose('ops', { palette: 5 });
      expect(auto()).toEqual({ alpha: pinned(20_000, 1), old: pinned(20_000, 2) });
      at(20_000 + AUTO_PIN_TTL_DAYS);
      presets.pin([{ name: 'alpha', palette: 1, hueShift: 0 }], () => []); // seen today
      expect(auto()).toEqual({
        alpha: pinned(20_000 + AUTO_PIN_TTL_DAYS, 1),
        old: pinned(20_000, 2),
      });
      at(20_000 + AUTO_PIN_TTL_DAYS + 1);
      restart();
      presets.pin([], () => []);
      expect(read()).toEqual({
        alpha: { palette: 1, hueShift: 0 },
        ops: { palette: 5, hueShift: 0 }, // the owner's: never dropped
        $meta: expect.objectContaining({
          auto: { alpha: pinned(20_000 + AUTO_PIN_TTL_DAYS, 1) },
        }),
      });
      expect(read().old).toBeUndefined();
    });

    it("at 500 the least recently seen pin gives way to the owner's choice; a full file answers why", () => {
      at(30_000);
      const pins = Object.fromEntries(
        Array.from({ length: MAX_STORE_ENTRIES }, (_, i) => [
          `p${i}`,
          { palette: i % 6, hueShift: 0 },
        ]),
      );
      const seen = Object.fromEntries(
        Object.keys(pins).map((n, i) => [n, pinned(29_000 + i, Number(n.slice(1)) % 6)]),
      );
      seen.p7 = pinned(28_000, 1); // the least recently seen
      restart();
      fs.writeFileSync(
        store(),
        JSON.stringify({ ...pins, $meta: { v: 2, pinnedAt: 'x', auto: seen } }, null, 2) + '\n',
      );
      restart();
      choose('alpha', { palette: 4 });
      expect(replies).toEqual([]);
      const file = read();
      expect(file.alpha).toEqual({ palette: 4, hueShift: 0 });
      expect(file.p7).toBeUndefined();
      expect(Object.keys(file)).toHaveLength(MAX_STORE_ENTRIES + 1);

      // 500 of the owner's own choices: nothing may give way, and the client is told.
      const mine = Object.fromEntries(Object.keys(pins).map((n) => [n, { preset: 'robot' }]));
      fs.writeFileSync(store(), JSON.stringify({ ...mine, $meta: { v: 2, pinnedAt: 'x' } }));
      restart();
      const before = stamp();
      choose('alpha', { palette: 4 });
      expect(stamp()).toBe(before);
      expect(replies).toEqual([{ type: 'characterRefused', key: 'alpha', reason: 'full' }]);
      choose('stranger', { palette: 4 });
      choose('alpha', { palette: 99 });
      expect(replies.slice(1)).toEqual([
        { type: 'characterRefused', key: 'stranger', reason: 'unknown' },
        { type: 'characterRefused', key: 'alpha', reason: 'invalid' },
      ]);
    });

    it('an older daemon changing a pin never lets it be pruned or evicted as automatic', () => {
      at(20_000);
      restart();
      presets.pin([{ name: 'chosen-old', palette: 2, hueShift: 0 }], () => []);
      const others = Object.fromEntries(
        Array.from({ length: MAX_STORE_ENTRIES - 1 }, (_, i) => [
          `p${i}`,
          { palette: i % 6, hueShift: 0 },
        ]),
      );
      const otherAuto = Object.fromEntries(
        Object.keys(others).map((name, i) => [name, pinned(20_099 + i, i % 6)]),
      );
      // An older daemon understands the v1 entry but leaves $meta untouched.
      fs.writeFileSync(
        store(),
        JSON.stringify(
          {
            ...others,
            'chosen-old': { palette: 5, hueShift: 30 },
            $meta: {
              v: 2,
              pinnedAt: 'x',
              auto: { 'chosen-old': pinned(20_000, 2), ...otherAuto },
            },
          },
          null,
          2,
        ) + '\n',
      );
      at(20_100);
      restart();
      presets.pin([{ name: 'newbie', palette: 1, hueShift: 0 }], () => []);

      const file = read();
      expect(file['chosen-old']).toEqual({ palette: 5, hueShift: 30 }); // not pruned at 100 days
      expect(file.p0).toBeUndefined(); // a real automatic pin gave way at the cap
      expect(auto()).not.toHaveProperty('chosen-old'); // the following save discarded stale metadata
    });

    it('load cleanup keeps a preset whose stale automatic record survived an older daemon', () => {
      at(20_000);
      restart();
      fs.writeFileSync(
        store(),
        JSON.stringify({
          chosen: { preset: 'robot' },
          $meta: {
            v: 2,
            pinnedAt: 'x',
            auto: { chosen: pinned(20_000, 2) },
          },
        }),
      );
      at(20_100);
      restart();
      presets.pin([{ name: 'newbie', palette: 1, hueShift: 0 }], () => []);

      expect(read().chosen).toEqual({ preset: 'robot' });
      expect(auto()).not.toHaveProperty('chosen');
    });

    it('a pin that does not fit is not retried before the next day', () => {
      at(40_000);
      const mine = Object.fromEntries(
        Array.from({ length: MAX_STORE_ENTRIES }, (_, i) => [
          `m${i}`,
          { palette: i % 6, hueShift: 0 },
        ]),
      );
      restart();
      fs.writeFileSync(store(), JSON.stringify({ ...mine, $meta: { v: 2, pinnedAt: 'x' } }));
      restart();
      const stringify = vi.spyOn(JSON, 'stringify');
      try {
        presets.pin([{ name: 'newbie', palette: 1, hueShift: 0 }], () => []);
        const tried = stringify.mock.calls.length;
        expect(tried).toBeGreaterThan(0);
        presets.pin([{ name: 'newbie', palette: 1, hueShift: 0 }], () => []);
        presets.pin([{ name: 'newbie', palette: 1, hueShift: 0 }], () => []);
        expect(stringify.mock.calls.length).toBe(tried); // no retry on every recompute
        at(40_001);
        presets.pin([{ name: 'newbie', palette: 1, hueShift: 0 }], () => []);
        expect(stringify.mock.calls.length).toBeGreaterThan(tried);
      } finally {
        stringify.mockRestore();
      }
      expect(read().newbie).toBeUndefined();
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('not saved')).length).toBe(1);
    });
  });

  it('never pins over a choice or an entry it cannot read', () => {
    restart();
    fs.writeFileSync(
      store(),
      JSON.stringify({ alpha: { preset: 'robot' }, odd: { v: 9 }, $meta: { v: 2, pinnedAt: 'x' } }),
    );
    restart();
    presets.pin(
      [
        { name: 'alpha', palette: 1, hueShift: 0 },
        { name: 'odd', palette: 1, hueShift: 0 },
      ],
      () => [],
    );
    expect(read()).toEqual({
      alpha: { preset: 'robot' },
      odd: { v: 9 },
      $meta: { v: 2, pinnedAt: 'x' },
    });
  });

  it('a provider change and a D3b Lead swap keep each name its look', () => {
    writeRegistry();
    restart();
    presets.pin([], registryNames);
    const looks = { ...last().assignments };
    const before = stamp();
    // The Worker becomes the Lead: the two assignments swap names (names are seats).
    const swapped = promotePair(loadRegistry(registry()).projects, 'w1', 'worker');
    if ('error' in swapped) throw new Error(swapped.error);
    saveRegistry(registry(), swapped.records, () => undefined);
    // And the new Lead's provider changes.
    const records = loadRegistry(registry()).projects.map((p) =>
      p.name === 'proj' ? { ...p, provider: 'codex' } : p,
    );
    saveRegistry(registry(), records, () => undefined);
    expect(loadRegistry(registry()).projects.find((p) => p.name === 'proj')?.provider).toBe(
      'codex',
    );
    restart();
    presets.pin([], registryNames);
    expect(stamp()).toBe(before);
    expect(last().assignments).toEqual(looks);
  });

  it('an older daemon (parseChoice) reads every pin', () => {
    writeRegistry();
    restart();
    presets.pin([{ name: 'alpha', palette: 5, hueShift: 200 }], registryNames);
    const { $meta: _meta, ...entries } = read();
    expect(Object.keys(entries)).toHaveLength(4);
    for (const value of Object.values(entries)) expect(parseChoice(value)).toEqual(value);
  });

  it('three restarts: every character is made with the same palette (binder + pin, like the office)', () => {
    writeRegistry();
    const live = ['proj', 'solo', 'w1', 'session-a', 'session-b'];
    const boot = (): Record<string, [number, number]> => {
      restart();
      const s = new AgentStateStore();
      const binder = new CharacterBinder(new AgentRuntime(s, claudeProvider), s);
      // the engine is off on the first start: only the Claude sessions are live
      const names = boot.count++ === 0 ? live.slice(3) : live;
      binder.reconcile(
        names.map((n) => ({
          key: `k:${n}`,
          label: n,
          transcript: null,
          look: presets.paletteOf(n),
        })),
      );
      const seen = names.map((n) => ({ name: n, ...s.get(binder.idOf(`k:${n}`)!)! }));
      presets.pin(
        seen.map((a) => ({ name: a.name, palette: a.palette!, hueShift: a.hueShift ?? 0 })),
        registryNames,
      );
      binder.dispose();
      return Object.fromEntries(seen.map((a) => [a.name, [a.palette!, a.hueShift ?? 0]]));
    };
    boot.count = 0;
    const first = boot(); // the engine off: sessions only, the engine's names pinned from its files
    const runs = [boot(), boot(), boot()];
    runs.forEach((run, i) => {
      for (const n of Object.keys(first))
        expect(run[n], `${n} after restart ${i + 1}`).toEqual(first[n]);
      for (const n of live) expect(run[n], `${n} after restart ${i + 1}`).toEqual(runs[0][n]);
    });
    const pinned = read() as Record<string, { palette: number; hueShift: number }>;
    for (const n of live) expect(runs[0][n]).toEqual([pinned[n].palette, pinned[n].hueShift]);
  });
});
/* eslint-enable pixel-agents/no-inline-colors */

describe('CH-6 sheet checks: the daemon and the browser give the same answer', () => {
  /** CHAR_0 with `edit` applied to its pixels. */
  const edited = (edit: (data: Buffer) => void) => {
    const img = PNG.sync.read(CHAR_0);
    edit(img.data);
    return PNG.sync.write(img, { colorType: 6 });
  };
  const at = (x: number, y: number) => (y * 112 + x) * 4;
  const clearCell = (row: number, frame: number) => (d: Buffer) => {
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 16; x++) d[at(frame * 16 + x, row * 32 + y) + 3] = 0;
  };
  /** Lift one walk frame by `dy` rows (its feet leave the floor). */
  const lift = (row: number, frame: number, dy: number) => (d: Buffer) => {
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 16; x++) {
        const from = y + dy < 32 ? at(frame * 16 + x, row * 32 + y + dy) : -1;
        const to = at(frame * 16 + x, row * 32 + y);
        if (from < 0) d.fill(0, to, to + 4);
        else d.copy(d, to, from, from + 4);
      }
  };
  const interlaced = Buffer.from(CHAR_0);
  interlaced[28] = 1;
  const vectors: Array<[string, Buffer, string | null, string | null]> = [
    ['good', CHAR_0, null, null],
    ['empty cell', edited(clearCell(1, 3)), 'empty', null],
    [
      'nearly empty cell',
      edited((d) => {
        clearCell(2, 6)(d);
        for (let x = 0; x < 7; x++) d[at(6 * 16 + x, 2 * 32 + 20) + 3] = 255;
      }),
      'empty',
      null,
    ],
    ['feet off the floor', edited(lift(0, 1, 6)), null, 'feet'],
    ['over 64 KB', Buffer.concat([CHAR_0, Buffer.alloc(MAX_PRESET_BYTES)]), 'tooBig', null],
    ['interlaced', interlaced, 'interlaced', null],
    ['wrong size', png(111, 96), 'size', null],
    ['RGB', png(112, 96, 2), 'format', null],
  ];
  const decode = (b: Uint8Array) => PNG.sync.read(Buffer.from(b)).data;

  it('the shared check names each vector; the upload refuses or keeps it accordingly', async () => {
    for (const [name, bytes, problem, warning] of vectors) {
      const check = await checkSheetPng(bytes, decode);
      expect([name, check.problem?.code ?? null, check.warning?.code ?? null]).toEqual([
        name,
        problem,
        warning,
      ]);
      const saved = await presets.saveSheet({
        key: 'alpha',
        sheet: bytes.toString('base64'),
        kind: 'custom',
      });
      if (problem) expect(saved).toEqual({ error: check.problem!.text });
      else {
        expect(saved).toMatchObject({ id: expect.stringMatching(/^custom-\d+/) });
        expect('warning' in saved ? saved.warning : undefined).toBe(check.warning?.text);
      }
    }
    expect((await checkSheetPng(edited(clearCell(1, 3)), decode)).problem?.params).toMatchObject({
      row: 2,
      frame: 4,
    });
    expect((await checkSheetPng(edited(lift(0, 1, 6)), decode)).warning?.params).toMatchObject({
      row: 1,
      frame: 2,
      lowest: 24,
    });
  });

  it('an editor save is custom-<time> with a 16×16 face cut from the front frame, assigned', async () => {
    const saved = await presets.saveSheet({
      key: 'alpha',
      sheet: CHAR_0.toString('base64'),
      kind: 'custom',
    });
    expect(saved).toMatchObject({ id: expect.stringMatching(/^custom-\d+$/) });
    const id = (saved as { id: string }).id;
    const face = PNG.sync.read(fs.readFileSync(path.join(config, `characters/${id}.mug.png`)));
    expect([face.width, face.height]).toEqual([16, 16]);
    // char_0's standing front frame starts at row 3: the face's first row is that row.
    const front = PNG.sync.read(CHAR_0);
    const row = (img: PNG, w: number, x0: number, y: number) =>
      img.data.subarray((y * w + x0) * 4, (y * w + x0 + 16) * 4);
    expect(row(face, 16, 0, 0)).toEqual(row(front, 112, 16, 3));
    expect(last().assignments).toEqual({ alpha: { preset: id } });
    expect(last().presets.find((p) => p.id === id)?.label).toBe('alpha 커스텀');
  });
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PART_ALPHABET, partProblem, SHEET_W } from '../../../core/src/cld/partData.js';
import { MAX_IMPORT_BYTES } from '../../../core/src/cld/sheetCheck.js';
import type { CharacterParts } from '../../../core/src/messages.js';
import { AgentStateStore } from '../agentStateStore.js';
import { createHttpServer, type HttpServerHandle } from '../httpServer.js';
import { CharacterPartStore, importRequest, registerPartRoutes } from './characterParts.js';
import { cldHooks } from './hooks.js';
import { bigRow, resize, source } from './partFixture.js';

/** A 1:1 row (112×32): one red pixel block in every frame, the given colour. */
const rowPng = (color = [200, 40, 40]) => {
  const p = new PNG({ width: 112, height: 32 });
  for (let f = 0; f < 7; f++)
    for (let y = 20; y < 23; y++)
      for (let x = 5; x < 9; x++) p.data.set([...color, 255], (y * 112 + f * 16 + x) * 4);
  return PNG.sync.write(p, { colorType: 6 });
};
const b64 = (buf: Buffer) => buf.toString('base64');
const colourAt = (part: { palette: string[]; pixels: string }, x: number, y: number) => {
  const k = part.pixels[y * SHEET_W + x];
  return k === '.' ? '' : part.palette[PART_ALPHABET.indexOf(k)];
};

let dir: string;
let sent: CharacterParts[];
let store: CharacterPartStore;
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
vi.spyOn(console, 'log').mockImplementation(() => undefined);
beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-parts-')), 'parts');
  sent = [];
  store = new CharacterPartStore(dir, (m) => sent.push(m));
  store.start();
});
afterEach(() => warn.mockClear());

describe('imported parts (CHAR-HUMAN)', () => {
  it('checks the request before decoding anything', () => {
    const png = b64(rowPng());
    expect(importRequest({ png, slot: 'hat', name: 'x' })).toEqual({ error: 'unknown slot' });
    expect(importRequest({ png, slot: 'top', name: '!!!' })).toEqual({ error: 'no name' });
    expect(importRequest({ png, slot: 'top', name: 'x', gender: 'x' })).toEqual({
      error: 'bad gender',
    });
    expect(importRequest({ png, slot: 'top', name: 'x', view: 'left' })).toEqual({
      error: 'bad row',
    });
    expect(importRequest({ png, slot: 'top', name: 'x', mismatch: 'flip' })).toEqual({
      error: 'bad mismatch',
    });
    expect(importRequest({ png, slot: 'top', name: 'x', frames: { 9: 'keep' } })).toEqual({
      error: 'bad frames',
    });
    expect(importRequest({ png, slot: 'top', name: 'x', frames: { 1: 'x' } })).toEqual({
      error: 'bad frames',
    });
    expect(importRequest({ png, slot: 'top', name: 'x', frames: { 1: 'empty' } })).toMatchObject({
      frames: { 1: 'empty' },
    });
    expect(importRequest({ png: 'not base64!', slot: 'top', name: 'x' })).toEqual({
      error: 'not base64',
    });
    const big = Buffer.alloc(MAX_IMPORT_BYTES + 1);
    expect(importRequest({ png: b64(big), slot: 'top', name: 'x' })).toMatchObject({
      error: /too big/,
    });
    const huge = rowPng();
    huge.writeUInt32BE(100_000, 16); // IHDR width: refused from the header, never inflated
    expect(importRequest({ png: b64(huge), slot: 'top', name: 'x' })).toMatchObject({
      error: /too large/,
    });
    const interlaced = rowPng();
    interlaced[28] = 1;
    expect(importRequest({ png: b64(interlaced), slot: 'top', name: 'x' })).toMatchObject({
      error: /interlaced/,
    });
    expect(importRequest({ png, slot: 'top', name: 'My Hoodie', view: 'down' })).toMatchObject({
      slot: 'top',
      name: 'my-hoodie',
      view: 'down',
    });
  });

  it('saves 0700/0600 under parts/<id>/, sends the list, reads it back, and removes only its own', () => {
    const r = store.import(
      { png: b64(rowPng()), slot: 'top', name: 'hoodie', gender: 'f', view: 'down' },
      true,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.part).toMatchObject({
      id: 'p-top-hoodie',
      slot: 'top',
      kind: 'sheet',
      gender: 'f',
      name: 'hoodie',
    });
    const folder = path.join(dir, 'p-top-hoodie');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(folder, 'part.json')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(folder).sort()).toEqual(['part.json', 'source-down.png']); // a 1:1 drawing has no HD
    expect(fs.statSync(path.join(folder, 'source-down.png')).mode & 0o777).toBe(0o600);
    expect(sent.at(-1)!.parts.map((p) => p.id)).toEqual(['p-top-hoodie']);
    // a preview stores nothing
    const before = sent.length;
    expect(
      'error' in
        store.import({ png: b64(rowPng()), slot: 'top', name: 'other', view: 'down' }, false),
    ).toBe(false);
    expect(fs.existsSync(path.join(dir, 'p-top-other'))).toBe(false);
    expect(sent.length).toBe(before);
    // a restart reads the folder; a foreign or broken folder is skipped
    fs.mkdirSync(path.join(dir, 'p-top-broken'));
    fs.writeFileSync(path.join(dir, 'p-top-broken', 'part.json'), '{"id":"p-top-broken"}');
    fs.mkdirSync(path.join(dir, 'Not-ours'));
    const again = new CharacterPartStore(dir, (m) => sent.push(m));
    again.start();
    expect(sent.at(-1)!.parts.map((p) => p.id)).toEqual(['p-top-hoodie']);
    expect(again.get('p-top-hoodie')).toEqual(r.part);
    // removal: only an imported part's folder
    expect(again.remove('basic')).toEqual({ error: 'not an imported part' });
    expect(again.remove('p-top-nope')).toEqual({ error: 'not found' });
    expect(again.remove('../x')).toEqual({ error: 'not an imported part' });
    expect(again.remove('p-top-hoodie')).toEqual({ ok: true });
    expect(fs.existsSync(folder)).toBe(false);
    expect(sent.at(-1)!.parts).toEqual([]);
  });

  it('a second row of the same name keeps the first row; the same row again replaces it', () => {
    const down = store.import(
      { png: b64(rowPng([200, 40, 40])), slot: 'top', name: 'tee', view: 'down' },
      true,
    );
    const up = store.import(
      { png: b64(rowPng([40, 40, 200])), slot: 'top', name: 'tee', view: 'up' },
      true,
    );
    if ('error' in down || 'error' in up) throw new Error('import failed');
    const part = store.get('p-top-tee')!;
    expect(colourAt(part, 5, 20)).toBe('c82828'); // the down row, still there
    expect(colourAt(part, 5, 32 + 20)).toBe('2828c8'); // the up row
    expect(colourAt(part, 5, 64 + 20)).toBe(''); // no side row yet
    store.import(
      { png: b64(rowPng([40, 160, 200])), slot: 'top', name: 'tee', view: 'down' },
      true,
    );
    expect(colourAt(store.get('p-top-tee')!, 5, 20)).toBe('28a0c8');
    expect(colourAt(store.get('p-top-tee')!, 5, 32 + 20)).toBe('2828c8');
  });
});

/* eslint-disable pixel-agents/no-inline-colors -- stored look colours */
describe('HD art (CHAR-FACTORY)', () => {
  it('a drawing finer than its blocks keeps that detail in part.hd; another row keeps both resolutions', () => {
    const toPng = (img: { width: number; height: number; data: Uint8Array }) => {
      const p = new PNG({ width: img.width, height: img.height });
      p.data = Buffer.from(img.data);
      return b64(PNG.sync.write(p));
    };
    const fine = (view: number) => (x2: number, y2: number) => {
      const c = source(view)(x2 >> 1, y2 >> 1);
      return c && x2 % 2 && y2 % 2 ? '40e0e0' : c;
    };
    const row = (view: number) =>
      resize(bigRow(view, source(view), { lines: true, fine: fine(view) }), 2402, 655);
    for (const [view, name] of [
      [0, 'down'],
      [1, 'up'],
    ] as const) {
      const r = store.import(
        { png: toPng(row(view)), slot: 'top', name: 'fine', view: name },
        true,
      );
      if ('error' in r) throw new Error(r.error);
    }
    const part = store.get('p-top-fine')!;
    expect(partProblem(part)).toBeNull();
    expect(part.hd!.pixels.length).toBe(112 * 96 * 4);
    const hdAt = (x: number, y: number) => {
      const k = part.hd!.pixels[y * 224 + x];
      return k === '.' ? '' : part.hd!.palette[PART_ALPHABET.indexOf(k)];
    };
    // the detail colour is in HD (both rows), not in the classic copy
    const detail = (y0: number) => {
      let n = 0;
      for (let y = y0; y < y0 + 64; y++)
        for (let x = 0; x < 224; x++) if (hdAt(x, y) === '40e0e0') n++;
      return n;
    };
    expect(detail(0)).toBeGreaterThan(100);
    expect(detail(64)).toBeGreaterThan(100);
    expect(part.palette).not.toContain('40e0e0');
    expect(fs.existsSync(path.join(dir, 'p-top-fine', 'source-down.png'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'p-top-fine', 'source-up.png'))).toBe(true);
  });
});

describe('named person looks (CHAR-HUMAN)', () => {
  it('saves, replaces by name, removes; only person looks; kept across a restart', () => {
    const look = {
      v: 3,
      kind: 'person',
      gender: 'f',
      parts: { hair: 'hair-1' },
      colors: { top: '#C0392B' },
    };
    expect(store.setPreset({ name: ' 출근룩 ', look })).toEqual({ ok: true });
    expect(sent.at(-1)!.presets).toEqual([
      { name: '출근룩', look: { ...look, colors: { top: '#c0392b' } } },
    ]);
    expect(fs.statSync(path.join(dir, 'presets.json')).mode & 0o777).toBe(0o600);
    expect(store.setPreset({ name: '출근룩', look: { ...look, gender: 'm' } })).toEqual({
      ok: true,
    });
    expect(sent.at(-1)!.presets.map((p) => p.look.gender)).toEqual(['m']);
    expect(store.setPreset({ name: '주말', look: { palette: 1 } })).toEqual({
      error: 'not a person look',
    });
    expect(store.setPreset({ name: '', look })).toEqual({ error: 'no name' });
    const again = new CharacterPartStore(dir, (m) => sent.push(m));
    again.start();
    expect(sent.at(-1)!.presets.map((p) => p.name)).toEqual(['출근룩']);
    expect(again.setPreset({ name: '출근룩', look: null })).toEqual({ ok: true });
    expect(sent.at(-1)!.presets).toEqual([]);
  });
});

describe('routes', () => {
  let server: HttpServerHandle | undefined;
  afterEach(async () => {
    await server?.app.close();
    delete cldHooks.registerRoutes;
  });
  const page = {
    host: 'office.test',
    origin: 'http://office.test',
    authorization: 'Bearer test-server-token',
  };

  it('converts and saves for a logged-in client from the office page only', async () => {
    cldHooks.registerRoutes = (app, auth) => registerPartRoutes(app, auth, store);
    server = await createHttpServer({
      embedded: false,
      host: '127.0.0.1',
      token: 'test-server-token',
      store: new AgentStateStore(),
      staticDir: process.cwd(),
      listen: false,
    });
    const app = server.app;
    const payload = { png: b64(rowPng()), slot: 'top', name: 'tee', view: 'down' };
    const post = (url: string, headers: Record<string, string>) =>
      app.inject({ method: 'POST', url, headers, payload });
    expect(
      (await post('/cld/parts', { host: 'office.test', origin: 'http://office.test' })).statusCode,
    ).toBe(401);
    expect(
      (await post('/cld/parts', { ...page, origin: 'https://attacker.example' })).statusCode,
    ).toBe(403);
    expect(fs.existsSync(path.join(dir, 'p-top-tee'))).toBe(false);
    const preview = await post('/cld/parts/preview', page);
    expect(preview.statusCode).toBe(200);
    expect(preview.json<{ part: { id: string } }>().part.id).toBe('p-top-tee');
    expect(fs.existsSync(path.join(dir, 'p-top-tee'))).toBe(false);
    expect((await post('/cld/parts', page)).statusCode).toBe(200);
    expect(fs.existsSync(path.join(dir, 'p-top-tee', 'part.json'))).toBe(true);
    const bad = await app.inject({
      method: 'POST',
      url: '/cld/parts',
      headers: page,
      payload: { ...payload, slot: 'hat' },
    });
    expect(bad.statusCode).toBe(400);
    const preset = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/cld/parts/presets',
        headers,
        payload: { name: 'a', look: { v: 3, kind: 'person' } },
      });
    expect((await preset({ host: 'office.test', origin: 'http://office.test' })).statusCode).toBe(
      401,
    );
    expect((await preset({ ...page, origin: 'https://x.example' })).statusCode).toBe(403);
    expect((await preset(page)).statusCode).toBe(200);
    const del = (headers: Record<string, string>) =>
      app.inject({ method: 'DELETE', url: '/cld/parts/p-top-tee', headers });
    expect((await del({ host: 'office.test' })).statusCode).toBe(401);
    expect((await del({ ...page, origin: 'https://x.example' })).statusCode).toBe(403);
    expect((await del(page)).statusCode).toBe(200);
    expect(fs.existsSync(path.join(dir, 'p-top-tee'))).toBe(false);
  });
});

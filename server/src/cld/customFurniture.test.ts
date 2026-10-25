import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FurnitureAsset } from '../../../core/src/assets/manifestUtils.js';
import { MAX_SHEET_BYTES } from '../../../core/src/cld/sheetCheck.js';
import { AgentStateStore } from '../agentStateStore.js';
import { loadAllFurniture } from '../assetReload.js';
import { createHttpServer, type HttpServerHandle } from '../httpServer.js';
import {
  registerFurnitureRoutes,
  removeCustomFurniture,
  saveCustomFurniture,
} from './customFurniture.js';
import { cldHooks } from './hooks.js';
import { REPO_ROOT } from './testHome.js';

const DESK: FurnitureAsset = {
  id: 'DESK_FRONT',
  name: 'Desk',
  label: 'Desk',
  category: 'desks',
  file: 'DESK_FRONT.png',
  width: 48,
  height: 32,
  footprintW: 3,
  footprintH: 2,
  isDesk: true,
  canPlaceOnWalls: false,
  canPlaceOnSurfaces: false,
  backgroundTiles: 1,
  groupId: 'DESK',
  orientation: 'front',
};
const catalog = [DESK];
/** A w×h RGBA PNG with `opaque` red pixels from the top-left. */
const png = (w: number, h: number, opaque = 10, opts: { interlace?: boolean } = {}) => {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < opaque; i++) p.data.set([255, 0, 0, 255], i * 4);
  const buf = PNG.sync.write(p, { colorType: 6 });
  if (opts.interlace) buf[28] = 1; // IHDR interlace byte: the header check refuses it first
  return buf;
};
const b64 = (buf: Buffer) => buf.toString('base64');

let dir: string;
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
vi.spyOn(console, 'log').mockImplementation(() => undefined);
beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-furniture-')), 'furniture');
});
afterEach(() => warn.mockClear());

describe('saveCustomFurniture', () => {
  it('writes exactly the png and the manifest the daemon builds, 0600, which the loader reads', async () => {
    const art = png(48, 32);
    const r = saveCustomFurniture(
      dir,
      catalog,
      { base: 'DESK_FRONT', png: b64(art) },
      1761000000000,
    );
    expect(r).toEqual({ id: 'custom-desk-front-1761000000000' });
    const id = (r as { id: string }).id;
    const folder = path.join(dir, id);
    expect(fs.readdirSync(folder).sort()).toEqual([`${id}.png`, 'manifest.json']);
    expect(fs.readFileSync(path.join(folder, `${id}.png`))).toEqual(art);
    expect(JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf-8'))).toEqual({
      id,
      name: 'Desk 커스텀',
      category: 'desks',
      type: 'asset',
      file: `${id}.png`,
      width: 48,
      height: 32,
      footprintW: 3,
      footprintH: 2,
      canPlaceOnWalls: false,
      canPlaceOnSurfaces: false,
      backgroundTiles: 1,
    });
    for (const f of [`${id}.png`, 'manifest.json'])
      expect(fs.statSync(path.join(folder, f)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700);

    const loaded = await loadAllFurniture(path.join(REPO_ROOT, 'webview-ui/public'), [], dir);
    const entry = loaded?.catalog.find((a) => a.id === id);
    expect(entry).toMatchObject({ isDesk: true, footprintW: 3, footprintH: 2, backgroundTiles: 1 });
    expect(loaded?.sprites.get(id)?.[0][0]).toMatch(/^#ff0000/i); // the red top-left pixel
    expect(loaded?.catalog.some((a) => a.id === 'DESK_FRONT')).toBe(true);
  });

  it('refuses a wrong size, interlaced, too big, blank, broken or non-base64 PNG and unknown bases', () => {
    const refused = [
      { base: 'DESK_FRONT', png: b64(png(48, 33)) },
      { base: 'DESK_FRONT', png: b64(png(32, 32)) },
      { base: 'DESK_FRONT', png: b64(png(48, 32, 10, { interlace: true })) },
      { base: 'DESK_FRONT', png: b64(Buffer.concat([png(48, 32), Buffer.alloc(MAX_SHEET_BYTES)])) },
      { base: 'DESK_FRONT', png: b64(png(48, 32, 2)) },
      { base: 'DESK_FRONT', png: b64(png(48, 32).subarray(0, 60)) },
      { base: 'DESK_FRONT', png: '!!not base64!!' },
      { base: 'NOPE', png: b64(png(48, 32)) },
      { png: b64(png(48, 32)) },
    ];
    for (const body of refused)
      expect(saveCustomFurniture(dir, catalog, body)).toHaveProperty('error');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('never reuses an id: a second save in the same millisecond gets the next number', () => {
    const body = { base: 'DESK_FRONT', png: b64(png(48, 32)) };
    const a = saveCustomFurniture(dir, catalog, body, 5);
    const b = saveCustomFurniture(dir, catalog, body, 5);
    expect(a).toEqual({ id: 'custom-desk-front-5' });
    expect(b).toEqual({ id: 'custom-desk-front-5-1' });
    // A redraw of a custom item is another new item, with one suffix.
    const custom = { ...DESK, id: 'custom-desk-front-1761000000000', label: 'Desk 커스텀' };
    const c = saveCustomFurniture(dir, [custom], { ...body, base: custom.id }, 1762000000000);
    expect(c).toEqual({ id: 'custom-desk-front-1762000000000' });
    const manifest = path.join(dir, 'custom-desk-front-1762000000000', 'manifest.json');
    expect(JSON.parse(fs.readFileSync(manifest, 'utf-8')).name).toBe('Desk 커스텀');
  });
});

describe('removeCustomFurniture', () => {
  it('removes only a custom item folder', () => {
    const { id } = saveCustomFurniture(dir, catalog, {
      base: 'DESK_FRONT',
      png: b64(png(48, 32)),
    }) as { id: string };
    for (const bad of ['DESK_FRONT', '../furniture', 'custom-../x', 'custom-missing-1', 7])
      expect(removeCustomFurniture(dir, bad)).toHaveProperty('error');
    fs.symlinkSync(path.join(dir, id), path.join(dir, 'custom-link'));
    expect(removeCustomFurniture(dir, 'custom-link')).toHaveProperty('error');
    expect(fs.existsSync(path.join(dir, id, 'manifest.json'))).toBe(true);
    expect(removeCustomFurniture(dir, id)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, id))).toBe(false);
  });
});

describe('routes', () => {
  let server: HttpServerHandle | undefined;
  let reloads = 0;
  afterEach(async () => {
    await server?.app.close();
    delete cldHooks.registerRoutes;
  });
  const start = async () => {
    reloads = 0;
    cldHooks.registerRoutes = (app, auth) =>
      registerFurnitureRoutes(app, auth, {
        dir,
        catalog: () => catalog,
        reload: async () => void reloads++,
      });
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
  const page = {
    host: 'office.test',
    origin: 'http://office.test',
    authorization: 'Bearer test-server-token',
  };
  const body = { base: 'DESK_FRONT', png: b64(png(48, 32)) };

  it('saves and removes for a logged-in client from the office page only', async () => {
    const app = await start();
    const post = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/cld/furniture', headers, payload: body });
    // Without a login session or the token (a viewer): refused before the body is read.
    expect((await post({ host: 'office.test', origin: 'http://office.test' })).statusCode).toBe(
      401,
    );
    expect((await post({ ...page, origin: 'https://attacker.example' })).statusCode).toBe(403);
    expect(fs.existsSync(dir)).toBe(false);
    expect(reloads).toBe(0);
    const ok = await post(page);
    expect(ok.statusCode).toBe(200);
    const { id } = ok.json<{ id: string }>();
    expect(reloads).toBe(1);
    const del = (url: string, headers: Record<string, string> = page) =>
      app.inject({ method: 'DELETE', url, headers });
    expect((await del(`/cld/furniture/${id}`, { host: 'office.test' })).statusCode).toBe(401);
    expect(
      (await del(`/cld/furniture/${id}`, { ...page, origin: 'https://x.example' })).statusCode,
    ).toBe(403);
    expect((await del('/cld/furniture/DESK_FRONT')).statusCode).toBe(400);
    expect((await del(`/cld/furniture/${id}`)).statusCode).toBe(200);
    expect(fs.existsSync(path.join(dir, id))).toBe(false);
    expect(reloads).toBe(2);
  });
});

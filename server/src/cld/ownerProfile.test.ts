/** MSG-UI3: the owner's profile picture routes. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_SHEET_BYTES } from '../../../core/src/cld/sheetCheck.js';
import { AgentStateStore } from '../agentStateStore.js';
import { createHttpServer, type HttpServerHandle } from '../httpServer.js';
import { cldHooks } from './hooks.js';
import { registerOwnerProfileRoutes } from './ownerProfile.js';

const png = (w: number, h: number, colorType: 2 | 6 = 6) =>
  PNG.sync.write(new PNG({ width: w, height: h }), { colorType });
const b64 = (buf: Buffer) => buf.toString('base64');

let dir: string;
let server: HttpServerHandle | undefined;
const bearer = { authorization: 'Bearer test-server-token' };
const page = { host: 'office.test', origin: 'http://office.test' };
vi.spyOn(console, 'warn').mockImplementation(() => undefined);

const start = async () => {
  cldHooks.registerRoutes = (app, auth) => registerOwnerProfileRoutes(app, auth, dir);
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

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-profile-')), 'profile');
});
afterEach(async () => {
  await server?.app.close();
  delete cldHooks.registerRoutes;
});

describe('owner profile picture', () => {
  const post = (app: Awaited<ReturnType<typeof start>>, payload: unknown, headers = {}) =>
    app.inject({
      method: 'POST',
      url: '/cld/profile/owner',
      headers: { ...page, ...bearer, ...headers },
      payload: payload as object,
    });

  it('saves a 128x128 PNG (RGBA or RGB) 0600, serves it to a logged-in client, resets', async () => {
    const app = await start();
    expect((await app.inject('/cld/profile/owner.png')).statusCode).toBe(401);
    expect((await app.inject({ url: '/cld/profile/owner.png', headers: bearer })).statusCode).toBe(404);
    for (const type of [6, 2] as const) {
      const sent = png(128, 128, type);
      expect((await post(app, { png: b64(sent) })).statusCode).toBe(200);
      const got = await app.inject({ url: '/cld/profile/owner.png', headers: bearer });
      expect(got.statusCode).toBe(200);
      expect(got.headers['content-type']).toBe('image/png');
      expect(got.rawPayload).toEqual(sent);
    }
    expect(fs.statSync(path.join(dir, 'owner.png')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['owner.png']); // no temp file left
    const etag = String((await app.inject({ url: '/cld/profile/owner.png', headers: bearer })).headers.etag);
    const again = await app.inject({ url: '/cld/profile/owner.png', headers: { ...bearer, 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    const reset = await app.inject({ method: 'DELETE', url: '/cld/profile/owner', headers: { ...page, ...bearer } });
    expect(reset.statusCode).toBe(200);
    expect((await app.inject({ url: '/cld/profile/owner.png', headers: bearer })).statusCode).toBe(404);
  });

  it('refuses the wrong size, an interlaced file, one over 64 KB, a non-PNG and bad base64', async () => {
    const app = await start();
    const interlaced = Buffer.from(png(128, 128));
    interlaced[28] = 1;
    const big = Buffer.concat([png(128, 128), Buffer.alloc(MAX_SHEET_BYTES)]);
    const refused = [
      png(127, 128),
      png(128, 129),
      interlaced,
      big,
      Buffer.from('GIF89a, not a png at all, long enough'),
    ].map((buf) => post(app, { png: b64(buf) }));
    for (const res of await Promise.all(refused)) expect(res.statusCode).toBe(400);
    expect((await post(app, { png: '!!not base64!!' })).statusCode).toBe(400);
    expect((await post(app, {})).statusCode).toBe(400);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('needs a session and the same origin to write', async () => {
    const app = await start();
    const body = { png: b64(png(128, 128)) };
    expect(
      (await app.inject({ method: 'POST', url: '/cld/profile/owner', headers: page, payload: body })).statusCode,
    ).toBe(401);
    expect((await post(app, body, { origin: 'https://attacker.example' })).statusCode).toBe(403);
    const del = await app.inject({
      method: 'DELETE',
      url: '/cld/profile/owner',
      headers: { ...bearer, origin: 'https://attacker.example' },
    });
    expect(del.statusCode).toBe(403);
    expect(fs.existsSync(dir)).toBe(false);
  });

});

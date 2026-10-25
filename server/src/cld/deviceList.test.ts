import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deviceKind, devicePath } from './auth.js';
import {
  type AuthServer,
  deviceSession,
  funnel,
  makeFakeDist,
  proveSession,
  startAuthServer,
  stopAuthServer,
} from './authTestKit.js';

describe('O2 device list helpers', () => {
  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'phone'],
    ['iPad', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'tablet'],
    ['Android phone', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile', 'phone'],
    ['Android tablet', 'Mozilla/5.0 (Linux; Android 14; SM-T736B) AppleWebKit/537.36', 'tablet'],
    ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'desktop'],
    ['macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'desktop'],
    ['Linux', 'Mozilla/5.0 (X11; Linux x86_64)', 'desktop'],
    ['unknown', 'curl/8.5.0', 'unknown'],
  ] as const)('classifies %s', (_name, userAgent, kind) => {
    expect(deviceKind(userAgent)).toBe(kind);
  });

  it.each([
    ['http://127.0.0.1:18240', 'local'],
    ['http://[::1]:18240', 'local'],
    ['http://localhost:18240', 'local'],
    ['http://192.168.0.5:18240', 'lan'],
    ['http://10.1.2.3:18240', 'lan'],
    ['http://172.20.0.1:18240', 'lan'],
    ['http://172.32.0.1:18240', 'remote'],
    ['http://host.local:18240', 'lan'],
    ['https://100.101.102.103', 'tailscale'],
    ['https://x.ts.net', 'tailscale'],
    ['https://public.example', 'remote'],
  ] as const)('classifies %s', (origin, path) => {
    expect(devicePath(origin)).toBe(path);
  });
});

const ORIGIN = 'https://office.tail0000.ts.net';
const dist = makeFakeDist();
let server: AuthServer;
let configDir: string;
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));
beforeEach(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-o2-'));
  server = await startAuthServer(dist.staticDir, { configDir });
});
afterEach(async () => {
  await stopAuthServer(server);
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('O2 session nickname endpoint', () => {
  const rename = (cookie: string | undefined, id: string, name: unknown) =>
    server.app.inject({
      method: 'POST',
      url: `/api/auth/sessions/${encodeURIComponent(id)}/nickname`,
      headers: { ...funnel(), origin: ORIGIN, ...(cookie ? { cookie } : {}) },
      payload: { name },
    });

  it('requires a session', async () => {
    expect((await rename(undefined, 'missing', 'Laptop')).statusCode).toBe(401);
  });

  it('refuses a cookie without a fresh step-up and keeps the device unchanged', async () => {
    const owner = await deviceSession(server.auth, ORIGIN, 'Windows · Chrome');
    const refused = await rename(owner.cookie, owner.device.id, 'Laptop');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'stepup' });
    expect(server.auth.listSessions(owner.id)).toContainEqual(
      expect.objectContaining({ id: owner.device.id, label: 'Windows · Chrome' }),
    );
  });

  it('rejects invalid names', async () => {
    const owner = await deviceSession(server.auth, ORIGIN, 'Windows · Chrome');
    proveSession(server.auth, owner.cookie);
    for (const name of ['', 'x'.repeat(41), 'bad\u0007name', 'bad\u202ename'])
      expect((await rename(owner.cookie, owner.device.id, name)).statusCode).toBe(400);
  });

  it('answers 404 for an unknown device row', async () => {
    const owner = await deviceSession(server.auth, ORIGIN, 'Windows · Chrome');
    proveSession(server.auth, owner.cookie);
    expect((await rename(owner.cookie, 'unknown-device', 'Laptop')).statusCode).toBe(404);
  });

  it('renames the device and its next list row', async () => {
    const owner = await deviceSession(server.auth, ORIGIN, 'Windows · Chrome');
    proveSession(server.auth, owner.cookie);
    expect((await rename(owner.cookie, owner.device.id, '  Office laptop  ')).json()).toEqual({
      ok: true,
      name: 'Office laptop',
    });
    const list = await server.app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { ...funnel(), origin: ORIGIN, cookie: owner.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ sessions: Array<Record<string, unknown>> }>().sessions).toContainEqual(
      expect.objectContaining({
        id: owner.device.id,
        label: 'Office laptop',
        device: 'Windows · Chrome',
      }),
    );
  });
});

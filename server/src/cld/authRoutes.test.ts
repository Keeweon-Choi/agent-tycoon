import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { moveTarget } from './authRoutes.js';
import {
  type AuthServer,
  funnel,
  makeFakeDist,
  proveSession,
  SoftDevice,
  startAuthServer,
  stopAuthServer,
  tailnet,
} from './authTestKit.js';
import { cldHooks } from './hooks.js';

let dist: { root: string; staticDir: string };
let server: AuthServer | undefined;
beforeAll(() => {
  dist = makeFakeDist();
});
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));
afterEach(async () => {
  await stopAuthServer(server);
  server = undefined;
});

describe('HTML content security policy', () => {
  it('sets the app CSP for HTML using only an allowed Host', async () => {
    server = await startAuthServer(dist.staticDir);
    const { app, auth } = server;
    const { code } = auth.createLoginCode();
    const login = await app.inject({ url: `/login?code=${code}`, headers: funnel() });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const get = (url: string, host: string) =>
      app.inject({ url, headers: { ...funnel(), host, cookie } });
    const appPage = await get('/', funnel().host);
    expect(appPage.headers['content-security-policy']).toContain(
      `connect-src 'self' wss://${funnel().host} ws://${funnel().host}`,
    );
    expect(appPage.headers['content-security-policy']).toContain("worker-src 'self'");
    expect((await get('/index.html', funnel().host)).headers['content-security-policy']).toBe(
      appPage.headers['content-security-policy'],
    );
    expect((await get('/some/spa/route', funnel().host)).headers['content-security-policy']).toBe(
      appPage.headers['content-security-policy'],
    );
    const forged = await get('/', 'attacker.example');
    expect(forged.headers['content-security-policy']).toContain("connect-src 'self';");
    expect(forged.headers['content-security-policy']).not.toContain('attacker.example');
    expect(
      (await get('/assets/index-abc.js', funnel().host)).headers['content-security-policy'],
    ).toBeUndefined();
    expect(
      (await get('/manifest.webmanifest', funnel().host)).headers['content-security-policy'],
    ).toBeUndefined();
    expect((await get('/sw.js', funnel().host)).headers['content-security-policy']).toBeUndefined();
    const loginPage = await app.inject({ url: '/', headers: funnel() });
    expect(loginPage.headers['content-security-policy']).toContain("default-src 'none'");
  });
});

describe('S-22 CORS', () => {
  it('a standalone server does not echo a foreign Origin as allowed', async () => {
    server = await startAuthServer(dist.staticDir);
    const res = await server.app.inject({
      url: '/api/health',
      headers: { ...funnel(), origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('S4 Tailscale and move targets', () => {
  it('does not create a session from forged Tailscale identity headers, even with the retired option', async () => {
    // This is the negative control: restoring the former header-trust branch makes
    // the loopback serve case below 200 with a cookie.
    server = await startAuthServer(dist.staticDir, { legacyTailscaleTrust: true });
    const viaServe = await server.app.inject({ url: '/', headers: tailnet });
    const loopbackForged = await server.app.inject({
      url: '/',
      headers: { ...tailnet, host: 'localhost:18240' },
    });
    for (const response of [viaServe, loopbackForged]) {
      expect(response.statusCode).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('permits move targets only after outside verification or for an allowed host', () => {
    expect(moveTarget('https://verified.example/secret/', 'https://evil.example/', [])).toBe(
      'https://verified.example/secret',
    );
    expect(moveTarget(undefined, 'https://office.tail0000.ts.net/', ['office.tail0000.ts.net'])).toBe(
      'https://office.tail0000.ts.net',
    );
    expect(moveTarget(undefined, 'https://evil.example/', ['office.tail0000.ts.net'])).toBeNull();
  });

  it('issues a move code only for a verified or allowed target origin', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-move-target-'));
    const previous = { canonicalUrl: cldHooks.canonicalUrl, verifiedOutsideUrl: cldHooks.verifiedOutsideUrl };
    try {
      server = await startAuthServer(dist.staticDir, { configDir });
      const device = await SoftDevice.create();
      server.auth.devices!.register(
        device.id, await device.publicKey(), 'http://localhost:18240', 'Laptop', false,
      );
      const session = server.auth.createSession('device', 'Laptop', device.id);
      const cookie = proveSession(server.auth, `cld_session=${session.id}`);
      const headers = { host: 'localhost:18240', origin: 'http://localhost:18240', cookie };
      const create = vi.spyOn(server.auth, 'createMoveCode');
      cldHooks.canonicalUrl = () => 'https://unverified.example/';
      delete cldHooks.verifiedOutsideUrl;
      expect((await server.app.inject({ method: 'POST', url: '/api/auth/move-code', headers })).statusCode).toBe(400);
      expect(create).not.toHaveBeenCalled();

      cldHooks.canonicalUrl = () => 'https://office.tail0000.ts.net/';
      const issued = await server.app.inject({ method: 'POST', url: '/api/auth/move-code', headers });
      expect(issued.statusCode).toBe(200);
      expect(issued.json<{ url: string }>().url).toMatch(/^https:\/\/office\.tail0000\.ts\.net\/login\?code=/);
    } finally {
      if (previous.canonicalUrl) cldHooks.canonicalUrl = previous.canonicalUrl;
      else delete cldHooks.canonicalUrl;
      if (previous.verifiedOutsideUrl) cldHooks.verifiedOutsideUrl = previous.verifiedOutsideUrl;
      else delete cldHooks.verifiedOutsideUrl;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

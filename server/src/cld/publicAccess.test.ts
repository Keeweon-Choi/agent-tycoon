/**
 * T-0022 step 1: the daemon behind Tailscale Funnel. A Funnel request is
 * public: no Tailscale auto-login, no Bearer token, and with no session it may
 * load only the health check, the login page and the web-app manifest/icons.
 * Every auth endpoint is rate-limited per client and per code.
 */
import * as fs from 'fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthLimiter, clientAddress, redactLoginCode, type StandaloneAuth } from './auth.js';
import {
  type AuthServer,
  funnel,
  makeFakeDist,
  OWNER,
  startAuthServer,
  stopAuthServer,
  tailnet,
  TOKEN,
} from './authTestKit.js';

let dist: { root: string; staticDir: string };
beforeAll(() => {
  dist = makeFakeDist();
});
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));

describe('public (Funnel) requests', () => {
  let server: AuthServer | undefined;
  let auth: StandaloneAuth;

  afterEach(async () => {
    await stopAuthServer(server);
    server = undefined;
    vi.useRealTimers();
  });

  async function start(): Promise<AuthServer> {
    server = await startAuthServer(dist.staticDir);
    auth = server.auth;
    return server;
  }

  // S4 retired Tailscale header login: a tailnet identity alone gets no session either.
  it('does not auto-log in a tailnet identity header (S4)', async () => {
    const { app } = await start();
    const res = await app.inject({ url: '/', headers: tailnet });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('never auto-logs in a Funnel request, even with an identity header', async () => {
    const { app } = await start();
    const res = await app.inject({
      url: '/',
      headers: { ...funnel(), 'tailscale-user-login': OWNER },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toContain('로그인 코드');
  });

  it('ignores an identity header that did not come through tailscale serve', async () => {
    const { app } = await start();
    // Forged by a peer on the network (daemon bound beyond loopback) ...
    const lan = await app.inject({ url: '/', headers: tailnet, remoteAddress: '192.168.1.20' });
    // ... or sent to 127.0.0.1 under a Host that is not the serve name.
    const local = await app.inject({
      url: '/',
      headers: { ...tailnet, host: '127.0.0.1:18256' },
    });
    expect(lan.statusCode).toBe(401);
    expect(local.statusCode).toBe(401);
    expect(lan.headers['set-cookie']).toBeUndefined();
    expect(local.headers['set-cookie']).toBeUndefined();
  });

  it('never accepts the host Bearer token from a Funnel request', async () => {
    const { app } = await start();
    const bearer = { authorization: `Bearer ${TOKEN}` };
    const mint = await app.inject({
      method: 'POST',
      url: '/api/login-code',
      headers: { ...funnel(), ...bearer },
    });
    const ws = await app.inject({ url: '/ws', headers: { ...funnel(), ...bearer } });
    const local = await app.inject({ method: 'POST', url: '/api/login-code', headers: bearer });
    expect(mint.statusCode).toBe(401);
    expect(ws.statusCode).toBe(401);
    expect(local.statusCode).toBe(200);
  });

  it('gives an anonymous visitor only the login page, health, manifest and icons', async () => {
    const { app } = await start();
    const get = (url: string, method: 'GET' | 'POST' = 'GET') =>
      app.inject({ method, url, headers: funnel() }).then((r) => r.statusCode);

    for (const url of [
      '/ws',
      '/api/login-code',
      '/api/anything',
      '/api/anything.json',
      '/cld/characters/alpha.png',
      '/cld/other.png',
      '/index.html',
      '/assets/index-abc.js',
      '/assets/sheet.png',
      '/icons/missing.png',
      '/some/spa/route',
      '/login',
      '/login?code=nope',
    ])
      expect([url, await get(url)]).toEqual([url, 401]);
    expect(await get('/api/hooks/claude', 'POST')).toBe(401);
    expect(await get('/api/login-code', 'POST')).toBe(401);
    expect(await get('/nothing', 'POST')).toBe(401);
    expect(await get('/terminal/1')).toBe(404);

    expect(await get('/')).toBe(401); // the login page itself
    for (const url of [
      '/api/health',
      '/manifest.webmanifest',
      '/icons/icon-256.png',
      '/login/login.js',
      '/login/login.css',
      '/fonts/FSPixelSansUnicode-Regular.ttf',
      '/fonts/galmuri/Galmuri11.woff2',
      '/fonts/galmuri/Galmuri11-Bold.woff2',
    ])
      expect([url, await get(url)]).toEqual([url, 200]);
    expect(await get('/login/other.js')).toBe(401);
    expect(await get('/fonts/other.ttf')).toBe(401);
    expect(await get('/fonts/galmuri/other.woff2')).toBe(401);
    expect(await get('/fonts/galmuri/OFL.txt')).toBe(401);
  });

  it('serves the app to a logged-in Funnel client', async () => {
    const { app } = await start();
    const { code } = auth.createLoginCode();
    const login = await app.inject({ url: `/login?code=${code}`, headers: funnel() });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect(login.statusCode).toBe(303);
    expect(String(login.headers['set-cookie'])).toContain('Secure');
    for (const url of ['/', '/index.html', '/assets/index-abc.js', '/cld/characters/a.png'])
      expect([
        url,
        (await app.inject({ url, headers: { ...funnel(), cookie } })).statusCode,
      ]).toEqual([url, 200]);
  });

  it('answers unknown, expired and used codes the same way', async () => {
    vi.useFakeTimers();
    const { app } = await start();
    const used = auth.createLoginCode().code;
    await app.inject({ url: `/login?code=${used}`, headers: funnel('198.51.100.1') });
    const expired = auth.createLoginCode().code;
    vi.advanceTimersByTime(61_000);
    const answers = await Promise.all(
      ['unknown-code', expired, used].map((code) =>
        app.inject({ url: `/login?code=${code}`, headers: funnel('198.51.100.2') }),
      ),
    );
    expect(new Set(answers.map((r) => `${r.statusCode} ${r.body}`)).size).toBe(1);
    expect(answers[0].statusCode).toBe(401);
  });

  it('blocks a client after 10 wrong codes a minute, for 5 minutes', async () => {
    vi.useFakeTimers();
    const { app } = await start();
    const attacker = funnel('203.0.113.66');
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ url: `/login?code=guess-${i}`, headers: attacker });
      expect(res.statusCode).toBe(401);
    }
    // Blocked: even a valid code is refused, and not consumed.
    const { code } = auth.createLoginCode();
    const blocked = await app.inject({ url: `/login?code=${code}`, headers: attacker });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['set-cookie']).toBeUndefined();
    // Another client is not affected, and the code still works there.
    const other = await app.inject({ url: `/login?code=${code}`, headers: funnel('198.51.100.9') });
    expect(other.statusCode).toBe(303);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    const later = await app.inject({ url: '/login?code=guess-x', headers: attacker });
    expect(later.statusCode).toBe(401);
  });

  it('blocks one code tried from many addresses', async () => {
    const { app } = await start();
    for (let i = 0; i < 10; i++)
      await app.inject({ url: '/login?code=same-guess', headers: funnel(`203.0.113.${i}`) });
    const res = await app.inject({
      url: '/login?code=same-guess',
      headers: funnel('198.51.100.200'),
    });
    expect(res.statusCode).toBe(429);
  });

  it('rate-limits wrong Bearer tokens', async () => {
    const { app } = await start();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login-code',
            headers: { authorization: `Bearer wrong-${i}` },
            remoteAddress: '192.168.1.30',
          })
        ).statusCode,
      );
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);
  });

  it('counts a network peer by its own address, whatever X-Forwarded-For it sends', async () => {
    const { app } = await start();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push(
        (
          await app.inject({
            url: `/login?code=guess-${i}`,
            headers: { 'x-forwarded-for': `203.0.113.${i}` },
            remoteAddress: '192.168.1.40',
          })
        ).statusCode,
      );
    expect(statuses[10]).toBe(429);
  });
});

describe('clientAddress', () => {
  it('trusts X-Forwarded-For only from the loopback proxy', () => {
    expect(clientAddress('127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddress('::ffff:127.0.0.1', 'spoofed, 203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddress('127.0.0.1', undefined)).toBe('127.0.0.1');
    expect(clientAddress('192.168.1.5', '203.0.113.7')).toBe('192.168.1.5');
  });
});

describe('redactLoginCode', () => {
  it('keeps login codes out of the request log', () => {
    expect(redactLoginCode('/login?code=abc-123')).toBe('/login?code=[redacted]');
    expect(redactLoginCode('/login?x=1&code=abc#f')).toBe('/login?x=1&code=[redacted]#f');
    expect(redactLoginCode('/login?codes=2')).toBe('/login?codes=2');
  });
});

describe('AuthLimiter', () => {
  it('blocks on the 10th failure in a window and forgets after the block', () => {
    const limiter = new AuthLimiter();
    for (let i = 0; i < 9; i++) limiter.fail(['k'], 1_000);
    expect(limiter.blocked(['k'], 1_000)).toBe(false);
    limiter.fail(['k'], 1_000);
    expect(limiter.blocked(['k'], 1_000)).toBe(true);
    expect(limiter.blocked(['other', 'k'], 1_000)).toBe(true);
    expect(limiter.blocked(['k'], 1_000 + 5 * 60_000)).toBe(false);
  });

  it('starts a new window after a minute', () => {
    const limiter = new AuthLimiter();
    for (let i = 0; i < 9; i++) limiter.fail(['k'], 0);
    limiter.fail(['k'], 60_000);
    expect(limiter.blocked(['k'], 60_000)).toBe(false);
  });
});

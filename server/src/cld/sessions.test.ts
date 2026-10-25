/**
 * T-0022 session list: every logged-in device with its label, method and last
 * seen time; sign one out (its sockets close) or all the others.
 * T-0034: sessions survive a daemon restart (sessions.json keeps token hashes).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { hashToken, SESSION_TTL_MS, StandaloneAuth } from './auth.js';
import {
  type AuthServer,
  cookieOf,
  funnel,
  HOST,
  makeFakeDist,
  proveSession,
  startAuthServer,
  stopAuthServer,
} from './authTestKit.js';
import { cldHooks } from './hooks.js';

let dist: { root: string; staticDir: string };
beforeAll(() => {
  dist = makeFakeDist();
});
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));

const ORIGIN = `https://${HOST}`;

describe('StandaloneAuth sessions', () => {
  afterEach(() => vi.useRealTimers());

  it('lists sessions with method, label and last seen, and closes signed-out sockets', () => {
    vi.useFakeTimers();
    const auth = new StandaloneAuth();
    const phone = auth.createSession('short', 'iPhone · Safari');
    const laptop = auth.createSession('passkey', 'Windows · Edge');
    const closed: string[] = [];
    auth.bindSocket(laptop.id, () => closed.push('ws'));
    const unbind = auth.bindSocket(laptop.id, () => closed.push('chat'));
    unbind();
    vi.advanceTimersByTime(60_000);
    auth.validSession(phone.id);

    const list = auth.listSessions(phone.id);
    expect(list).toEqual([
      expect.objectContaining({
        id: phone.handle,
        method: 'short',
        current: true,
        connected: false,
      }),
      expect.objectContaining({
        id: laptop.handle,
        method: 'passkey',
        current: false,
        connected: true,
      }),
    ]);
    expect(list[0].lastSeen - list[1].lastSeen).toBe(60_000);
    expect(JSON.stringify(list)).not.toContain(phone.id);

    expect(auth.revoke(laptop.handle)).toBe(true);
    expect(closed).toEqual(['ws']);
    expect(auth.validSession(laptop.id)).toBe(false);
    expect(auth.revoke(laptop.handle)).toBe(false);
  });
});

describe('session routes', () => {
  let server: AuthServer | undefined;

  afterEach(async () => {
    await stopAuthServer(server);
    server = undefined;
    vi.restoreAllMocks();
  });

  async function start() {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    server = await startAuthServer(dist.staticDir);
    const { auth } = server;
    const me = auth.createSession('qr', 'iPhone · Safari');
    const other = auth.createSession('short', 'Windows · Edge');
    const third = auth.createSession('tailscale', 'Mac · Safari');
    // S1: signing others out wants a fresh step-up
    const headers = {
      ...funnel(),
      cookie: proveSession(auth, `cld_session=${me.id}`),
      origin: ORIGIN,
    };
    return { app: server.app, auth, me, other, third, headers };
  }

  it('lists the devices and signs one out', async () => {
    const { app, me, other, headers } = await start();
    const list = await app.inject({ url: '/api/auth/sessions', headers });
    expect(
      list.json().sessions.map((s: { label: string; current: boolean }) => [s.label, s.current]),
    ).toEqual([
      ['iPhone · Safari', true],
      ['Windows · Edge', false],
      ['Mac · Safari', false],
    ]);
    const out = await app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${other.handle}`,
      headers,
    });
    expect(out.statusCode).toBe(200);
    const gone = await app.inject({
      url: '/api/auth/sessions',
      headers: { ...funnel(), cookie: `cld_session=${other.id}` },
    });
    expect(gone.statusCode).toBe(401);
    // Signing itself out clears its cookie.
    const self = await app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${me.handle}`,
      headers,
    });
    expect(self.statusCode).toBe(200);
    expect(String(self.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('the device list says which devices have push on (only when this daemon has push)', async () => {
    const { app, me, other, headers } = await start();
    const flags = async () =>
      (await app.inject({ url: '/api/auth/sessions', headers }))
        .json()
        .sessions.map((s: { push?: boolean }) => s.push);
    expect(await flags()).toEqual([undefined, undefined, undefined]);
    cldHooks.pushDevices = () => new Set([me.handle]);
    try {
      expect(await flags()).toEqual([true, false, false]);
    } finally {
      delete cldHooks.pushDevices;
    }
    void other;
  });

  it('signs out every other device', async () => {
    const { app, auth, me, headers } = await start();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sessions/revoke-others',
      headers,
    });
    expect(res.json()).toEqual({ count: 2 });
    expect(auth.listSessions(me.id).map((s) => s.current)).toEqual([true]);
  });

  it('refuses a sign-out from another origin', async () => {
    const { app, other, headers } = await start();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${other.handle}`,
      headers: { ...headers, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('persisted sessions (T-0034)', () => {
  let configDir: string;
  const file = () => path.join(configDir, 'sessions.json');
  const stored = () => JSON.parse(fs.readFileSync(file(), 'utf-8')).sessions;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-config-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('keeps logins across a restart and stores only the hash of each token', () => {
    const before = new StandaloneAuth({ configDir });
    const phone = before.createSession('short', 'iPhone · Safari');
    const laptop = before.createSession('passkey', 'Windows · Edge');

    const raw = fs.readFileSync(file(), 'utf-8');
    expect(raw).not.toContain(phone.id);
    expect(raw).not.toContain(laptop.id);
    expect(stored()).toEqual([
      {
        hash: hashToken(phone.id),
        handle: phone.handle,
        method: 'short',
        label: 'iPhone · Safari',
        // O2: the user agent's class (none was given here), no secret.
        kind: 'unknown',
        createdAt: phone.createdAt,
        lastSeen: phone.lastSeen,
        expiresAt: phone.expiresAt,
      },
      expect.objectContaining({ hash: hashToken(laptop.id), method: 'passkey' }),
    ]);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);

    // The restart: a new daemon reads the file.
    const after = new StandaloneAuth({ configDir });
    expect(after.validSession(phone.id)).toBe(true);
    expect(after.validSession(laptop.id)).toBe(true);
    expect(after.validSession(hashToken(phone.id))).toBe(false); // the hash is no cookie
    expect(after.listSessions(phone.id)).toEqual([
      expect.objectContaining({ id: phone.handle, label: 'iPhone · Safari', current: true }),
      expect.objectContaining({ id: laptop.handle, label: 'Windows · Edge', current: false }),
    ]);
  });

  it('slides the expiry 90 days from each use and writes a use at most once a minute', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const auth = new StandaloneAuth({ configDir });
    const s = auth.createSession('qr', 'iPhone · Safari');

    vi.advanceTimersByTime(30_000);
    expect(auth.validSession(s.id)).toBe(true);
    expect(stored()[0]).toMatchObject({ lastSeen: 1_000_000 }); // in memory only
    vi.advanceTimersByTime(29_999);
    auth.validSession(s.id);
    expect(stored()[0]).toMatchObject({ lastSeen: 1_000_000 });
    vi.advanceTimersByTime(1); // a minute after the last write
    auth.validSession(s.id);
    expect(stored()[0]).toMatchObject({
      lastSeen: 1_060_000,
      expiresAt: 1_060_000 + SESSION_TTL_MS,
    });

    // Used every 89 days, it outlives the first 90.
    vi.advanceTimersByTime(SESSION_TTL_MS - 86_400_000);
    expect(auth.validSession(s.id)).toBe(true);
    vi.advanceTimersByTime(SESSION_TTL_MS - 86_400_000);
    expect(auth.validSession(s.id)).toBe(true);
    // Unused for 90 days, it is gone, also from the file and after a restart.
    vi.advanceTimersByTime(SESSION_TTL_MS);
    expect(auth.validSession(s.id)).toBe(false);
    expect(stored()).toEqual([]);
    expect(new StandaloneAuth({ configDir }).validSession(s.id)).toBe(false);
  });

  it('leaves out sessions that expired while the daemon was down', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const s = new StandaloneAuth({ configDir }).createSession('short', 'x');
    vi.advanceTimersByTime(SESSION_TTL_MS);
    const after = new StandaloneAuth({ configDir });
    expect(after.listSessions(undefined)).toEqual([]);
    expect(after.validSession(s.id)).toBe(false);
  });

  it('a signed-out device stays signed out after a restart', () => {
    const auth = new StandaloneAuth({ configDir });
    const a = auth.createSession('short', 'a');
    const b = auth.createSession('qr', 'b');
    const c = auth.createSession('passkey', 'c');
    expect(auth.revoke(b.handle)).toBe(true);
    const second = new StandaloneAuth({ configDir });
    expect([a, b, c].map((s) => second.validSession(s.id))).toEqual([true, false, true]);

    expect(second.revokeOthers(a.id)).toBe(1);
    const third = new StandaloneAuth({ configDir });
    expect([a, b, c].map((s) => third.validSession(s.id))).toEqual([true, false, false]);
  });

  it.each([
    ['not JSON', '{"v":1,"sessions":['],
    ['another shape', '{"v":2,"sessions":[]}'],
    [
      'a raw token where a hash belongs',
      '{"v":1,"sessions":[{"hash":"short","handle":"h","method":"qr","label":"x","createdAt":1,"lastSeen":1,"expiresAt":1}]}',
    ],
  ])('keeps an unreadable sessions.json (%s) as it is; logins still work', (_what, body) => {
    fs.writeFileSync(file(), body);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const auth = new StandaloneAuth({ configDir });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sessions.json is unreadable'));

    const s = auth.createSession('short', 'x');
    expect(auth.validSession(s.id)).toBe(true);
    auth.revoke(s.handle);
    expect(fs.readFileSync(file(), 'utf-8')).toBe(body);
  });
});

describe('persisted session routes (T-0034)', () => {
  let configDir: string;
  let server: AuthServer | undefined;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-config-'));
  });
  afterEach(async () => {
    await stopAuthServer(server);
    server = undefined;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('a device logged in with a code is still in after the daemon restarts', async () => {
    server = await startAuthServer(dist.staticDir, { configDir });
    const { code } = server.auth.createLoginCode('short');
    const login = await server.app.inject({
      method: 'POST',
      url: '/login',
      headers: { ...funnel(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: `code=${code}`,
    });
    expect(login.statusCode).toBe(303);
    const cookie = cookieOf(login.headers['set-cookie']);
    await stopAuthServer(server);

    server = await startAuthServer(dist.staticDir, { configDir });
    const page = await server.app.inject({ url: '/', headers: { ...funnel(), cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<div id="root">');
    // The app load renews the cookie's Max-Age (90 days), same value.
    const renewed = String(page.headers['set-cookie']);
    expect(renewed).toContain(`${cookie};`);
    expect(renewed).toContain('Max-Age=7776000');
    expect(renewed).toContain('Secure');
    const me = await server.app.inject({ url: '/api/auth/me', headers: { ...funnel(), cookie } });
    expect(me.json()).toMatchObject({ method: 'short' });
  });

  it('an app load without a session renews nothing', async () => {
    server = await startAuthServer(dist.staticDir, { configDir });
    const page = await server.app.inject({
      url: '/',
      headers: { ...funnel(), cookie: 'cld_session=forged' },
    });
    expect(page.statusCode).toBe(401);
    expect(page.headers['set-cookie']).toBeUndefined();
  });
});

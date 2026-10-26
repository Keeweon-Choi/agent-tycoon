/**
 * T-0022 passkeys: @simplewebauthn/server with a software authenticator
 * (ES256): register on a logged-in device, log in from the login page, the
 * signature counter, one credential list per RP ID, the file on disk, and
 * the limits.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  type AuthServer,
  cookieOf,
  deviceSession,
  formLogin,
  funnel,
  HOST,
  makeFakeDist,
  proveSession,
  SoftAuthenticator,
  startAuthServer,
  stopAuthServer,
  tailnet,
} from './authTestKit.js';

let dist: { root: string; staticDir: string };
beforeAll(() => {
  dist = makeFakeDist();
});
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));

/** A browser on this machine through an SSH tunnel: http://localhost. */
const LOCAL = { host: 'localhost:18240' };
const LOCAL_ORIGIN = 'http://localhost:18240';
const PUBLIC_ORIGIN = `https://${HOST}`;

describe('passkeys', () => {
  let server: AuthServer | undefined;
  let configDir: string;

  afterEach(async () => {
    await stopAuthServer(server);
    server = undefined;
    fs.rmSync(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function start(): Promise<AuthServer> {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-config-'));
    server = await startAuthServer(dist.staticDir, { configDir });
    return server;
  }

  /** Register a passkey from a logged-in device at `headers`/`origin`. */
  async function register(
    authenticator: SoftAuthenticator,
    headers: Record<string, string>,
    origin: string,
    name = 'iPhone',
  ) {
    const { app, auth } = server!;
    // S5: a passkey is tied to the device its session is.
    const cookie = proveSession(auth, (await deviceSession(auth, origin)).cookie);
    const begin = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/options',
      headers: { ...headers, cookie, origin },
    });
    expect(begin.statusCode).toBe(200);
    const { ceremony, options } = begin.json();
    return app.inject({
      method: 'POST',
      url: '/api/auth/passkeys',
      headers: { ...headers, cookie, origin },
      payload: { ceremony, response: authenticator.register(options, origin), name },
    });
  }

  /** Log in from the login page at `headers`/`origin`. */
  async function login(
    authenticator: SoftAuthenticator,
    headers: Record<string, string>,
    origin: string,
    counter?: number,
  ) {
    const { app } = server!;
    const begin = await app.inject({ method: 'POST', url: '/login/passkey/options', headers });
    expect(begin.statusCode).toBe(200);
    const { ceremony, options } = begin.json();
    return app.inject({
      method: 'POST',
      url: '/login/passkey',
      headers,
      payload: { ceremony, response: authenticator.login(options, origin, counter) },
    });
  }

  it('registers a passkey on a logged-in device and logs in with it over Funnel', async () => {
    const { app } = await start();
    const authenticator = new SoftAuthenticator();
    const before = await app.inject({ url: '/', headers: funnel() });
    expect(before.body).not.toContain('패스키로 로그인');

    const registered = await register(authenticator, funnel(), PUBLIC_ORIGIN, 'iPhone');
    expect(registered.statusCode).toBe(200);
    expect(registered.json().passkey).toMatchObject({ rpID: HOST, name: 'iPhone' });

    const page = await app.inject({ url: '/', headers: funnel() });
    expect(page.body).toContain('패스키로 로그인');

    const res = await login(authenticator, funnel(), PUBLIC_ORIGIN);
    expect(res.statusCode).toBe(200);
    const cookie = cookieOf(res.headers['set-cookie']);
    expect(String(res.headers['set-cookie'])).toContain('Secure');
    const me = await app.inject({ url: '/api/auth/me', headers: { ...funnel(), cookie } });
    expect(me.json()).toMatchObject({ method: 'passkey', label: 'iPhone', passkeyHere: true });
  });

  it('a passkey still logs in through a Tailscale serve host', async () => {
    await start();
    const authenticator = new SoftAuthenticator();
    const serve = { ...tailnet, 'x-forwarded-proto': 'https' };
    expect((await register(authenticator, serve, PUBLIC_ORIGIN, 'Tailnet phone')).statusCode).toBe(200);
    expect((await login(authenticator, serve, PUBLIC_ORIGIN)).statusCode).toBe(200);
  });

  it('requires a recent passkey assertion by this session to turn passkey-required off', async () => {
    const { app, auth } = await start();
    const authenticator = new SoftAuthenticator();
    expect((await register(authenticator, funnel(), PUBLIC_ORIGIN)).statusCode).toBe(200);
    const cookie = `cld_session=${auth.createSession('short', 'Owner').id}`;
    const other = `cld_session=${auth.createSession('short', 'Other').id}`;
    const settings = (who: string, on: boolean) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/settings',
        headers: { ...funnel(), cookie: who, origin: PUBLIC_ORIGIN },
        payload: { passkeyRequired: on },
      });
    // On takes this device's own passkey, tapped (a session with no device has none).
    expect((await settings(cookie, true)).statusCode).toBe(409);
    auth.devices!.setPasskeyRequired(true);
    const refused = await settings(cookie, false);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toContain('패스키로 확인');
    const begin = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/verify/options',
      headers: { ...funnel(), cookie, origin: PUBLIC_ORIGIN },
    });
    expect(begin.statusCode).toBe(200);
    const { ceremony, options } = begin.json();
    const response = authenticator.login(options, PUBLIC_ORIGIN);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/passkeys/verify',
          headers: { ...funnel(), cookie: other, origin: PUBLIC_ORIGIN },
          payload: { ceremony, response },
        })
      ).statusCode,
    ).toBe(403);
    const fresh = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/verify/options',
      headers: { ...funnel(), cookie, origin: PUBLIC_ORIGIN },
    });
    const proof = fresh.json();
    const verify = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/passkeys/verify',
        headers: { ...funnel(), cookie, origin: PUBLIC_ORIGIN },
        payload: payload as object,
      });
    const signed = authenticator.login(proof.options, PUBLIC_ORIGIN);
    expect((await verify({ ceremony: proof.ceremony, response: signed })).statusCode).toBe(200);
    // Replays never count: the ceremony is single use, and an old assertion
    // was signed over another ceremony's challenge.
    expect((await verify({ ceremony: proof.ceremony, response: signed })).statusCode).toBe(403);
    const third = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/verify/options',
      headers: { ...funnel(), cookie, origin: PUBLIC_ORIGIN },
    });
    expect((await verify({ ceremony: third.json().ceremony, response: signed })).statusCode).toBe(
      403,
    );
    expect((await settings(other, false)).statusCode).toBe(403);
    expect((await settings(cookie, false)).statusCode).toBe(200);
    // Not this device's passkey (the session has no device): on stays refused.
    expect((await settings(cookie, true)).statusCode).toBe(409);
    auth.devices!.setPasskeyRequired(true);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60_000);
    expect((await settings(cookie, false)).statusCode).toBe(403);
    const late = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/verify/options',
      headers: { ...funnel(), cookie, origin: PUBLIC_ORIGIN },
    });
    expect((await verify({ ceremony: late.json().ceremony, response: signed })).statusCode).toBe(
      403,
    );
    expect((await settings(cookie, false)).statusCode).toBe(403);
  });

  it('keeps one credential list per RP ID', async () => {
    const { app } = await start();
    const authenticator = new SoftAuthenticator();
    expect((await register(authenticator, LOCAL, LOCAL_ORIGIN)).statusCode).toBe(200);
    expect((await login(authenticator, LOCAL, LOCAL_ORIGIN)).statusCode).toBe(200);
    // The ts.net login page has none: no button, and the localhost passkey can't sign there.
    expect((await app.inject({ url: '/', headers: funnel() })).body).not.toContain(
      '패스키로 로그인',
    );
    const begin = await app.inject({
      method: 'POST',
      url: '/login/passkey/options',
      headers: funnel(),
    });
    const { ceremony, options } = begin.json();
    expect(options.rpId).toBe(HOST);
    const forged = authenticator.login({ ...options, rpId: 'localhost' }, PUBLIC_ORIGIN);
    const res = await app.inject({
      method: 'POST',
      url: '/login/passkey',
      headers: funnel(),
      payload: { ceremony, response: forged },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a replayed signature counter, another origin and a used ceremony', async () => {
    const { app } = await start();
    const authenticator = new SoftAuthenticator();
    await register(authenticator, funnel(), PUBLIC_ORIGIN);
    expect((await login(authenticator, funnel(), PUBLIC_ORIGIN, 5)).statusCode).toBe(200);
    // Counter 5 again (and 3): a cloned key or a replay.
    expect((await login(authenticator, funnel(), PUBLIC_ORIGIN, 5)).statusCode).toBe(401);
    expect((await login(authenticator, funnel(), PUBLIC_ORIGIN, 3)).statusCode).toBe(401);
    expect((await login(authenticator, funnel(), PUBLIC_ORIGIN, 6)).statusCode).toBe(200);
    // A phishing page's origin.
    expect((await login(authenticator, funnel(), 'https://evil.example')).statusCode).toBe(401);
    // One ceremony, one answer.
    const begin = await app.inject({
      method: 'POST',
      url: '/login/passkey/options',
      headers: funnel(),
    });
    const { ceremony, options } = begin.json();
    const response = authenticator.login(options, PUBLIC_ORIGIN);
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/login/passkey',
        headers: funnel(),
        payload: { ceremony, response },
      });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(401);
  });

  it('registers only for a session, from the same origin, in its own ceremony', async () => {
    const { app, auth } = await start();
    const authenticator = new SoftAuthenticator();
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/options',
      headers: { ...funnel(), origin: PUBLIC_ORIGIN },
    });
    expect(anonymous.statusCode).toBe(401);
    const cookie = proveSession(auth, `cld_session=${auth.createSession().id}`);
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/options',
      headers: { ...funnel(), cookie, origin: 'https://other.tail0000.ts.net' },
    });
    expect(crossSite.statusCode).toBe(403);
    // A ceremony begun by one session can't be finished by another.
    const begin = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/options',
      headers: { ...funnel(), cookie, origin: PUBLIC_ORIGIN },
    });
    const { ceremony, options } = begin.json();
    const other = proveSession(auth, `cld_session=${auth.createSession().id}`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/passkeys',
      headers: { ...funnel(), cookie: other, origin: PUBLIC_ORIGIN },
      payload: { ceremony, response: authenticator.register(options, PUBLIC_ORIGIN) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('stores credentials 0600 and lists, renames and removes them', async () => {
    const { app, auth } = await start();
    const authenticator = new SoftAuthenticator();
    await register(authenticator, funnel(), PUBLIC_ORIGIN, 'iPhone');
    const file = path.join(configDir, 'passkeys.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8')).byRp)).toEqual([HOST]);

    const cookie = proveSession(auth, `cld_session=${auth.createSession().id}`);
    const headers = { ...funnel(), cookie, origin: PUBLIC_ORIGIN };
    const list = await app.inject({ url: '/api/auth/passkeys', headers });
    const [key] = list.json().passkeys;
    expect(list.json().rpID).toBe(HOST);
    expect(key).toMatchObject({ rpID: HOST, name: 'iPhone', lastUsedAt: null });

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/auth/passkeys/${key.id}`,
      headers,
      payload: { name: '아이폰 15' },
    });
    expect(renamed.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/auth/passkeys', headers })).json().passkeys[0].name).toBe(
      '아이폰 15',
    );
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/auth/passkeys/${key.id}`,
      headers,
    });
    expect(removed.statusCode).toBe(200);
    expect((await login(authenticator, funnel(), PUBLIC_ORIGIN)).statusCode).toBe(401);
  });

  it('never overwrites a passkeys.json it cannot read', async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-config-'));
    fs.writeFileSync(path.join(configDir, 'passkeys.json'), '{ not json');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    server = await startAuthServer(dist.staticDir, { configDir });
    const res = await register(new SoftAuthenticator(), funnel(), PUBLIC_ORIGIN);
    expect(res.statusCode).toBe(400);
    expect(fs.readFileSync(path.join(configDir, 'passkeys.json'), 'utf-8')).toBe('{ not json');
  });

  it('blocks a client after 10 failed passkey logins', async () => {
    const { app } = await start();
    const authenticator = new SoftAuthenticator();
    await register(authenticator, funnel(), PUBLIC_ORIGIN);
    for (let i = 0; i < 10; i++)
      expect(
        (await login(authenticator, funnel('203.0.113.9'), 'https://evil.example')).statusCode,
      ).toBe(401);
    const blocked = await login(authenticator, funnel('203.0.113.9'), PUBLIC_ORIGIN);
    expect(blocked.statusCode).toBe(429);
    expect((await login(authenticator, funnel('203.0.113.10'), PUBLIC_ORIGIN)).statusCode).toBe(
      200,
    );
    void app;
  });

  it('keeps working while short codes are locked', async () => {
    const { app } = await start();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const authenticator = new SoftAuthenticator();
    await register(authenticator, funnel(), PUBLIC_ORIGIN);
    for (let i = 0; i < 20; i++)
      await app.inject(formLogin(`7777 ${String(i).padStart(4, '0')}`, funnel(`198.51.100.${i}`)));
    expect((await app.inject(formLogin('7777 9999', funnel('192.0.2.1')))).statusCode).toBe(429);
    expect((await login(authenticator, funnel('192.0.2.2'), PUBLIC_ORIGIN)).statusCode).toBe(200);
  });

  it('is off without a config dir, and never reads ~/.config/agent-tycoon', async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-config-'));
    server = await startAuthServer(dist.staticDir);
    const res = await server.app.inject({
      method: 'POST',
      url: '/login/passkey/options',
      headers: funnel(),
    });
    expect(res.statusCode).toBe(404);
    expect(server.auth.passkeys).toBeUndefined();
  });
});

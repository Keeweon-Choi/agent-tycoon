/**
 * S5 (F-6): passkeys belong to a device registration. Revoking a device ends
 * its passkeys at once (by credential id, so a synced copy stops too, and the
 * id can't be registered again); a legacy "기기 미지정" passkey alone never
 * makes a session -- the same browser must also prove a registered device key,
 * and the passkey is tied to that device from then on; unbound passkeys can
 * be assigned (step-up) or deleted and expire after 30 days; passkeys.json v1
 * becomes v2 with the original kept, and a file that can't be read is never
 * written over.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { StandaloneAuth } from './auth.js';
import {
  type AuthServer,
  cookieOf,
  deviceProof,
  deviceSession,
  funnel,
  HOST,
  makeFakeDist,
  proveSession,
  SoftAuthenticator,
  SoftDevice,
  startAuthServer,
  stopAuthServer,
} from './authTestKit.js';
import { LOGIN_ERRORS } from './loginPage.js';
import { Passkeys, REVOKED_CREDENTIAL, UNBOUND_TTL_MS } from './passkeys.js';

const ORIGIN = `https://${HOST}`;
const DAY = 86_400_000;

let dist: { root: string; staticDir: string };
beforeAll(() => {
  dist = makeFakeDist();
});
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));

describe('passkeys and devices (S5)', () => {
  let server: AuthServer | undefined;
  let configDir: string;
  const file = () => path.join(configDir, 'passkeys.json');

  afterEach(async () => {
    await stopAuthServer(server);
    server = undefined;
    fs.chmodSync(configDir, 0o700);
    fs.rmSync(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function start(): Promise<AuthServer> {
    configDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'cld-config-'));
    server = await startAuthServer(dist.staticDir, { configDir });
    return server;
  }
  async function startFresh(): Promise<AuthServer> {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-config-'));
    return start();
  }

  const call = (cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    server!.app.inject({
      method,
      url,
      headers: { ...funnel(), cookie, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    });

  /** Register `authenticator`'s passkey from a session (stepped up first), optionally offering `credentialId` again. */
  async function register(
    cookie: string,
    authenticator: SoftAuthenticator,
    credentialId?: string,
  ) {
    proveSession(server!.auth, cookie);
    const begin = (await call(cookie, 'POST', '/api/auth/passkeys/options')).json();
    return call(cookie, 'POST', '/api/auth/passkeys', {
      ceremony: begin.ceremony,
      response: authenticator.register(begin.options, ORIGIN, credentialId),
      name: 'iPhone',
    });
  }

  /** The login page's passkey login, with or without a device-key proof beside it. */
  async function login(
    authenticator: SoftAuthenticator,
    device?: SoftDevice,
    ip = '203.0.113.7',
  ) {
    const headers = { ...funnel(ip), origin: ORIGIN };
    const begin = (
      await server!.app.inject({ method: 'POST', url: '/login/passkey/options', headers })
    ).json();
    return server!.app.inject({
      method: 'POST',
      url: '/login/passkey',
      headers,
      payload: {
        ceremony: begin.ceremony,
        response: authenticator.login(begin.options, ORIGIN),
        ...(device ? { device: await deviceProof(server!, device, headers) } : {}),
      },
    });
  }

  it('revoking a device ends its passkey at once, synced copies and open sessions included, for good', async () => {
    await startFresh();
    const { auth } = server!;
    const phone = await deviceSession(auth, ORIGIN, 'iPhone');
    const laptop = await deviceSession(auth, ORIGIN, 'Laptop');
    const authenticator = new SoftAuthenticator();
    const registered = await register(phone.cookie, authenticator);
    expect(registered.statusCode).toBe(200);
    const credential = registered.json().passkey.id as string;
    expect(registered.json().passkey.deviceId).toBe(phone.device.id);

    // Tied to the phone, the passkey logs in alone -- on the phone or as a synced copy elsewhere.
    const first = await login(authenticator);
    expect(first.statusCode).toBe(200);
    const sessionCookie = cookieOf(first.headers['set-cookie']);
    expect((await call(sessionCookie, 'GET', '/api/auth/me')).statusCode).toBe(200);

    // The revoke confirmation can say so beforehand: the device row counts its passkeys.
    proveSession(auth, laptop.cookie);
    const rows = (await call(laptop.cookie, 'GET', '/api/auth/sessions')).json().sessions;
    expect(rows.find((r: { id: string }) => r.id === phone.device.id).passkeys).toBe(1);
    expect(rows.find((r: { id: string }) => r.id === laptop.device.id).passkeys).toBe(0);

    expect(
      (await call(laptop.cookie, 'DELETE', `/api/auth/sessions/${phone.device.id}`)).statusCode,
    ).toBe(200);
    expect(auth.passkeys!.list()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).revoked).toEqual([credential]);
    // The session that passkey made is gone, and the same credential (a synced copy) is refused.
    expect((await call(sessionCookie, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await login(authenticator)).statusCode).toBe(401);
    expect((await login(authenticator, laptop.device)).statusCode).toBe(401);

    // It can't be registered again, from a stepped-up device either.
    const again = await register(laptop.cookie, authenticator, credential);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe(REVOKED_CREDENTIAL);
    expect(auth.passkeys!.list()).toEqual([]);
    // A fresh credential on a registered device is fine (the invite + step-up path).
    expect((await register(laptop.cookie, new SoftAuthenticator())).statusCode).toBe(200);
  });

  it('revoke-others also revokes the passkeys of the devices it signs out', async () => {
    await startFresh();
    const { auth } = server!;
    const phone = await deviceSession(auth, ORIGIN, 'iPhone');
    const laptop = await deviceSession(auth, ORIGIN, 'Laptop');
    const authenticator = new SoftAuthenticator();
    expect((await register(phone.cookie, authenticator)).statusCode).toBe(200);
    proveSession(auth, laptop.cookie);
    expect((await call(laptop.cookie, 'POST', '/api/auth/sessions/revoke-others')).statusCode).toBe(200);
    expect(auth.passkeys!.list()).toEqual([]);
    expect((await login(authenticator)).statusCode).toBe(401);
  });

  it('an unbound passkey alone never creates a session; with a registered device key it binds', async () => {
    await startFresh();
    const { auth } = server!;
    // A session with no device key registers it: "기기 미지정".
    const plain = `cld_session=${auth.createSession('short', 'Old browser').id}`;
    const authenticator = new SoftAuthenticator();
    const registered = await register(plain, authenticator);
    expect(registered.statusCode).toBe(200);
    const credential = registered.json().passkey;
    expect(credential.deviceId).toBeNull();
    expect(credential.expiresAt).toBeGreaterThan(Date.now() + 29 * DAY);

    const alone = await login(authenticator);
    expect(alone.statusCode).toBe(401);
    expect(alone.json().error).toBe(LOGIN_ERRORS.passkeyUnbound);
    expect(alone.headers['set-cookie']).toBeUndefined();

    // A device key that is not registered does not count; neither does a revoked one.
    const stranger = await SoftDevice.create();
    expect((await login(authenticator, stranger)).statusCode).toBe(401);
    const gone = await deviceSession(auth, ORIGIN, 'Lost phone');
    auth.revoke(gone.device.id);
    expect((await login(authenticator, gone.device)).statusCode).toBe(401);
    expect(auth.passkeys!.list()[0].deviceId).toBeNull();

    // The same browser also proves a registered device key: logged in, passkey tied to it.
    const device = await deviceSession(auth, ORIGIN, 'iPhone');
    const bound = await login(authenticator, device.device);
    expect(bound.statusCode).toBe(200);
    expect(auth.passkeys!.list()[0].deviceId).toBe(device.device.id);
    expect(auth.passkeys!.list()[0].expiresAt).toBeUndefined();
    // From then on it logs in on its own, like any bound passkey.
    expect((await login(authenticator)).statusCode).toBe(200);
  });

  it('assigning an unbound passkey needs a step-up and an existing device; deleting it works', async () => {
    await startFresh();
    const { auth } = server!;
    const plain = `cld_session=${auth.createSession('short', 'Old browser').id}`;
    const authenticator = new SoftAuthenticator();
    const id = (await register(plain, authenticator)).json().passkey.id as string;
    const owner = await deviceSession(auth, ORIGIN, 'iPhone');
    const assign = (deviceId: unknown) =>
      call(owner.cookie, 'POST', `/api/auth/passkeys/${id}/device`, { deviceId });

    auth.session(owner.id)!.shellProofAt = undefined;
    expect((await assign(owner.device.id)).json()).toEqual({ error: 'stepup' });
    expect(auth.passkeys!.list()[0].deviceId).toBeNull();
    proveSession(auth, owner.cookie);
    expect((await assign('no-such-device-id-0000000')).statusCode).toBe(404);
    expect((await assign(owner.device.id)).statusCode).toBe(200);
    expect(auth.passkeys!.list()[0].deviceId).toBe(owner.device.id);
    // Tied now; a second assignment is not offered, and the passkey logs in on its own.
    expect((await assign(owner.device.id)).statusCode).toBe(409);
    expect((await login(authenticator)).statusCode).toBe(200);

    const other = new SoftAuthenticator();
    const loose = (await register(plain, other)).json().passkey.id as string;
    expect((await call(owner.cookie, 'DELETE', `/api/auth/passkeys/${loose}`)).statusCode).toBe(200);
    expect(auth.passkeys!.list().map((k) => k.id)).toEqual([id]);
  });

  it('an unbound passkey expires after 30 days; a bound one does not', async () => {
    await startFresh();
    const { auth } = server!;
    const plain = `cld_session=${auth.createSession('short', 'Old browser').id}`;
    const loose = new SoftAuthenticator();
    expect((await register(plain, loose)).statusCode).toBe(200);
    const phone = await deviceSession(auth, ORIGIN, 'iPhone');
    expect((await register(phone.cookie, new SoftAuthenticator())).statusCode).toBe(200);
    const spy = vi.spyOn(Date, 'now');
    const t0 = Date.now();
    spy.mockReturnValue(t0 + UNBOUND_TTL_MS - 1000);
    expect(auth.passkeys!.list()).toHaveLength(2);
    spy.mockReturnValue(t0 + UNBOUND_TTL_MS + 1000);
    expect(auth.passkeys!.list().map((k) => k.deviceId)).toEqual([phone.device.id]);
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).byRp[HOST]).toHaveLength(1);
  });

  it('v1 → v2: existing passkeys stay, tied to no device; the v1 file is kept; logins still work', async () => {
    await startFresh();
    const { auth } = server!;
    const authenticator = new SoftAuthenticator();
    const plain = `cld_session=${auth.createSession('short', 'Old browser').id}`;
    expect((await register(plain, authenticator)).statusCode).toBe(200);
    await stopAuthServer(server);
    server = undefined;

    // What an older daemon left on disk.
    const v2 = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    const v1 = {
      v: 1,
      userId: v2.userId,
      byRp: Object.fromEntries(
        Object.entries(v2.byRp as Record<string, Array<Record<string, unknown>>>).map(([rp, keys]) => [
          rp,
          keys.map(({ deviceId: _d, unboundSince: _u, ...key }) => key),
        ]),
      ),
    };
    const v1Text = `${JSON.stringify(v1, null, 2)}\n`;
    fs.writeFileSync(file(), v1Text, { mode: 0o600 });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await start();
    const migrated = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    expect(migrated.v).toBe(2);
    expect(migrated.revoked).toEqual([]);
    expect(migrated.userId).toBe(v1.userId);
    expect(migrated.byRp[HOST][0]).toMatchObject({
      id: v1.byRp[HOST][0].id,
      publicKey: v1.byRp[HOST][0].publicKey,
      deviceId: null,
    });
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(`${file()}.v1.bak`, 'utf-8')).toBe(v1Text);
    expect(server!.auth.passkeys!.list()).toHaveLength(1);

    // The old passkey works again the way S5 allows: with a registered device key.
    expect((await login(authenticator)).statusCode).toBe(401);
    const device = await deviceSession(server!.auth, ORIGIN, 'iPhone');
    expect((await login(authenticator, device.device)).statusCode).toBe(200);

    // A later start never replaces the kept v1 copy.
    await stopAuthServer(server);
    server = undefined;
    await start();
    expect(fs.readFileSync(`${file()}.v1.bak`, 'utf-8')).toBe(v1Text);
  });

  it.skipIf(process.getuid?.() === 0)('a v1 file that cannot be backed up is left exactly as it is', async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-config-'));
    const v1 = JSON.stringify({ v: 1, userId: 'u', byRp: {} });
    fs.writeFileSync(file(), v1, { mode: 0o600 });
    fs.chmodSync(configDir, 0o500); // no new files: no backup
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new Passkeys(file());
    expect(store.list()).toEqual([]);
    fs.chmodSync(configDir, 0o700);
    expect(fs.readFileSync(file(), 'utf-8')).toBe(v1);
    expect(fs.readdirSync(configDir)).toEqual(['passkeys.json']);
  });

  it('unreadable, unknown or malformed files are preserved byte for byte, whatever happens', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const text of [
      '{ not json',
      JSON.stringify({ v: 3, userId: 'u', byRp: {}, revoked: [] }),
      JSON.stringify({ v: 1, byRp: {} }),
      JSON.stringify({ v: 2, userId: 'u', byRp: {} }),
    ]) {
      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-config-'));
      fs.writeFileSync(file(), text);
      server = await startAuthServer(dist.staticDir, { configDir });
      const device = await deviceSession(server.auth, ORIGIN);
      const res = await register(device.cookie, new SoftAuthenticator());
      expect(res.statusCode).toBe(400);
      expect(server.auth.passkeys!.revokeDevice(device.device.id)).toEqual([]);
      expect(server.auth.passkeys!.bind('x', device.device.id)).toBe(false);
      expect(fs.readFileSync(file(), 'utf-8')).toBe(text);
      expect(fs.readdirSync(configDir).filter((f) => f.startsWith('passkeys'))).toEqual([
        'passkeys.json',
      ]);
      await stopAuthServer(server);
      server = undefined;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-config-'));
  });

  it('StandaloneAuth.passkeyLogin refuses an unbound passkey without a proven device', () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-config-'));
    const auth = new StandaloneAuth({ configDir });
    const unbound = {
      id: 'x',
      rpID: HOST,
      name: 'old',
      createdAt: 1,
      lastUsedAt: null,
      deviceId: null,
    };
    expect(auth.passkeyLogin(unbound, null)).toBeNull();
    expect(auth.listSessions(undefined)).toEqual([]);
  });
});

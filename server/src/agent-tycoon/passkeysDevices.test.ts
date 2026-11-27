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
  formLogin,
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
    configDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'agty-config-'));
    server = await startAuthServer(dist.staticDir, { configDir });
    return server;
  }
  async function startFresh(): Promise<AuthServer> {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-config-'));
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

  it('S1.1: revoking a device also removes the key a synced copy of its passkey registered elsewhere', async () => {
    await startFresh();
    const { auth } = server!;
    const phone = await deviceSession(auth, ORIGIN, 'iPhone');
    const laptop = await deviceSession(auth, ORIGIN, 'Laptop');
    const authenticator = new SoftAuthenticator();
    expect((await register(phone.cookie, authenticator)).statusCode).toBe(200);
    // A synced copy logs in alone on another browser, which then makes its own device key E.
    const copy = cookieOf((await login(authenticator)).headers['set-cookie']);
    const stranger = await SoftDevice.create();
    const made = await call(copy, 'POST', '/api/auth/device', {
      deviceId: stranger.id,
      publicKey: await stranger.publicKey(),
    });
    expect(made.statusCode).toBe(200);
    // E logs in again by itself once, so no session of the passkey is left to find it by.
    const headers = { ...funnel(), origin: ORIGIN };
    const relogin = { method: 'POST' as const, url: '/login/device', headers };
    expect((await server!.app.inject({ ...relogin, payload: await deviceProof(server!, stranger, headers) })).statusCode).toBe(200);

    proveSession(auth, laptop.cookie);
    expect((await call(laptop.cookie, 'DELETE', `/api/auth/sessions/${phone.device.id}`)).statusCode).toBe(200);
    // E is gone with the phone: it can't log back in, and its row left the list.
    expect((await server!.app.inject({ ...relogin, payload: await deviceProof(server!, stranger, headers) })).statusCode).toBe(401);
    const rows = (await call(laptop.cookie, 'GET', '/api/auth/sessions')).json().sessions as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([laptop.device.id]);
  });

  it('S1.1: revoking a device follows the chain past one hop (key -> passkey -> key)', async () => {
    await startFresh();
    const { auth } = server!;
    const phone = await deviceSession(auth, ORIGIN, 'iPhone');
    const laptop = await deviceSession(auth, ORIGIN, 'Laptop');
    const p = new SoftAuthenticator();
    expect((await register(phone.cookie, p)).statusCode).toBe(200);
    const headers = { ...funnel(), origin: ORIGIN };
    /** A passkey-only session registers a device key, which then logs in by itself. */
    async function keyFrom(authenticator: SoftAuthenticator): Promise<{ key: SoftDevice; cookie: string }> {
      const copy = cookieOf((await login(authenticator)).headers['set-cookie']);
      const key = await SoftDevice.create();
      const made = await call(copy, 'POST', '/api/auth/device', { deviceId: key.id, publicKey: await key.publicKey() });
      expect(made.statusCode).toBe(200);
      const res = await server!.app.inject({ method: 'POST', url: '/login/device', headers, payload: await deviceProof(server!, key, headers) });
      expect(res.statusCode).toBe(200);
      return { key, cookie: cookieOf(res.headers['set-cookie']) };
    }
    const e = await keyFrom(p);
    const q = new SoftAuthenticator();
    expect((await register(e.cookie, q)).statusCode).toBe(200);
    const f = await keyFrom(q);

    proveSession(auth, laptop.cookie);
    // A plain passkey login that never registered a key: a keyless row, still dead with the chain.
    expect((await login(q)).statusCode).toBe(200);
    const keyless = auth.listSessions(undefined).filter((r) => !r.deviceKey).map((r) => r.id);
    expect((await call(laptop.cookie, 'DELETE', `/api/auth/sessions/${phone.device.id}`)).statusCode).toBe(200);
    const relogin = await server!.app.inject({ method: 'POST', url: '/login/device', headers, payload: await deviceProof(server!, f.key, headers) });
    expect(relogin.statusCode).toBe(401);
    expect((await login(q)).statusCode).toBe(401);
    expect(auth.passkeys!.list()).toEqual([]);
    const rows = (await call(laptop.cookie, 'GET', '/api/auth/sessions')).json().sessions as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([laptop.device.id]);
    // The owner gets a record of each key that went down the chain, not only of the one they picked.
    // The keyless rows the passkey logins made (no device key, so no `devices` entry) go down it too.
    const revoked = auth.audit.read(0, 50).lines.filter((l) => l.kind === 'deviceRevoked');
    expect(revoked.map((l) => [l.device?.id, l.detail]).sort()).toEqual(
      [
        [phone.device.id, undefined],
        [e.key.id, 'chain'],
        [f.key.id, 'chain'],
        ...keyless.map((id) => [id, 'chain']),
      ].sort(),
    );
    expect(keyless.length).toBeGreaterThan(0);
  });

  it('S1.1: what a synced copy let in (an invite, its handoff, an approval) goes with the device', async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-config-'));
    server = await startAuthServer(dist.staticDir, { configDir, allowApprovalRequests: true });
    const { auth, app } = server;
    const phone = await deviceSession(auth, ORIGIN, 'iPhone');
    const laptop = await deviceSession(auth, ORIGIN, 'Laptop');
    const p = new SoftAuthenticator();
    expect((await register(phone.cookie, p)).statusCode).toBe(200);
    const copy = proveSession(auth, cookieOf((await login(p)).headers['set-cookie']));
    const headers = { ...funnel(), origin: ORIGIN };
    const keyFor = async (cookie: string) => {
      const key = await SoftDevice.create();
      const made = await call(cookie, 'POST', '/api/auth/device', { deviceId: key.id, publicKey: await key.publicKey() });
      expect(made.statusCode).toBe(200);
      return key;
    };
    const signIn = async (code: string) => cookieOf((await app.inject(formLogin(code))).headers['set-cookie']);

    // The copy invites a phone by QR; that tab hands off to its Home-Screen app; both make keys.
    const invite = (await call(copy, 'POST', '/api/auth/device-code')).json();
    const qr = proveSession(auth, await signIn(new URL(invite.link).searchParams.get('code')!));
    const handoff = (await call(qr, 'POST', '/api/auth/handoff-code')).json();
    const home = await keyFor(await signIn(handoff.code));
    const invited = await keyFor(qr);
    // And it approves a new device's request.
    const asked = (await app.inject({ method: 'POST', url: '/login/approval', headers: funnel('203.0.113.50'), payload: { label: 'x' } })).json();
    const [{ id }] = (await call(copy, 'GET', '/api/auth/approvals')).json().approvals;
    expect((await call(copy, 'POST', `/api/auth/approvals/${id}`, { approve: true, code: asked.code })).json().result).toBe('approved');
    const polled = await app.inject({ method: 'POST', url: '/login/approval/poll', headers: funnel('203.0.113.50'), payload: { secret: asked.secret } });
    const approved = await keyFor(cookieOf(polled.headers['set-cookie']));

    proveSession(auth, laptop.cookie);
    expect((await call(laptop.cookie, 'DELETE', `/api/auth/sessions/${phone.device.id}`)).statusCode).toBe(200);
    for (const key of [home, invited, approved]) {
      const relogin = await app.inject({ method: 'POST', url: '/login/device', headers, payload: await deviceProof(server, key, headers) });
      expect(relogin.statusCode).toBe(401);
    }
    const rows = (await call(laptop.cookie, 'GET', '/api/auth/sessions')).json().sessions as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([laptop.device.id]);
  });

  it('S1.1: a synced copy cannot tie a passkey it made to a device outside its chain', async () => {
    await startFresh();
    const { auth } = server!;
    const phone = await deviceSession(auth, ORIGIN, 'iPhone');
    const laptop = await deviceSession(auth, ORIGIN, 'Laptop');
    const p = new SoftAuthenticator();
    expect((await register(phone.cookie, p)).statusCode).toBe(200);
    // The copy has no device key, so the passkey U it registers is unbound ...
    const copy = cookieOf((await login(p)).headers['set-cookie']);
    const u = new SoftAuthenticator();
    const made = await register(copy, u);
    expect(made.json().passkey.deviceId).toBeNull();
    // ... and tying U to the laptop (whose id the list shows) would let it log in alone, past the revoke.
    const bind = await call(copy, 'POST', `/api/auth/passkeys/${made.json().passkey.id}/device`, {
      deviceId: laptop.device.id,
    });
    expect(bind.statusCode).toBe(403);
    expect(auth.passkeys!.list().find((k) => k.id === made.json().passkey.id)?.deviceId).toBeNull();

    proveSession(auth, laptop.cookie);
    expect((await call(laptop.cookie, 'DELETE', `/api/auth/sessions/${phone.device.id}`)).statusCode).toBe(200);
    expect((await login(p)).statusCode).toBe(401);
    expect((await login(u)).statusCode).toBe(401);
  });

  it('S1.1: a session a passkey made ends with its device after a restart too', async () => {
    await startFresh();
    const phone = await deviceSession(server!.auth, ORIGIN, 'iPhone');
    const authenticator = new SoftAuthenticator();
    expect((await register(phone.cookie, authenticator)).statusCode).toBe(200);
    const copy = cookieOf((await login(authenticator)).headers['set-cookie']);
    await stopAuthServer(server);
    await start();
    expect((await call(copy, 'GET', '/api/auth/me')).statusCode).toBe(200);
    server!.auth.revoke(phone.device.id);
    expect((await call(copy, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('S1.3: a flood of anonymous login ceremonies never pushes out a session step-up', async () => {
    await startFresh();
    const phone = await deviceSession(server!.auth, ORIGIN, 'iPhone');
    const authenticator = new SoftAuthenticator();
    expect((await register(phone.cookie, authenticator)).statusCode).toBe(200);
    const begin = (await call(phone.cookie, 'POST', '/api/auth/passkeys/verify/options')).json();
    for (let i = 0; i < 250; i++)
      await server!.app.inject({ method: 'POST', url: '/login/passkey/options', headers: { ...funnel(`203.0.113.${i}`), origin: ORIGIN } });
    const verified = await call(phone.cookie, 'POST', '/api/auth/passkeys/verify', {
      ceremony: begin.ceremony,
      response: authenticator.login(begin.options, ORIGIN),
    });
    expect(verified.statusCode).toBe(200);
  });

  it('S1.3: anonymous login ceremonies count per client', async () => {
    await startFresh();
    const ask = () =>
      server!.app.inject({ method: 'POST', url: '/login/passkey/options', headers: { ...funnel(), origin: ORIGIN } });
    for (let i = 0; i < 10; i++) expect((await ask()).statusCode).toBe(200);
    const refused = await ask();
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe(LOGIN_ERRORS.tooMany);
    // Another client is not held up.
    const other = await server!.app.inject({ method: 'POST', url: '/login/passkey/options', headers: { ...funnel('198.51.100.4'), origin: ORIGIN } });
    expect(other.statusCode).toBe(200);
    // Nor is the same client's silent device-key re-login: its nonce has a bucket of its own.
    const nonce = await server!.app.inject({ method: 'GET', url: '/login/device/challenge', headers: { ...funnel(), origin: ORIGIN } });
    expect(nonce.statusCode).toBe(200);
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
    const plain = `agty_session=${auth.createSession('short', 'Old browser').id}`;
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
    const plain = `agty_session=${auth.createSession('short', 'Old browser').id}`;
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
    const plain = `agty_session=${auth.createSession('short', 'Old browser').id}`;
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
    const plain = `agty_session=${auth.createSession('short', 'Old browser').id}`;
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
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-config-'));
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
      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-config-'));
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
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-config-'));
  });

  it('StandaloneAuth.passkeyLogin refuses an unbound passkey without a proven device', () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-config-'));
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

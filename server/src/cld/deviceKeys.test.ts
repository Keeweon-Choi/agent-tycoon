/**
 * T-0034 silent device keys. The store (devices.json): the challenge, the
 * signature (WebCrypto P1363 and DER), the origin, one key per device, the
 * cap, the 180-day prune and an unreadable file. The routes: the silent
 * re-login, rate limits, revoking a device and all the others, "패스키(생체
 * 인증) 필수", proving a known key after a code login, moving a device
 * between two addresses, and the new-device notice.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { NEW_DEVICE_NOTICE_MS, StandaloneAuth } from './auth.js';
import {
  type AuthServer,
  cookieOf,
  funnel,
  HOST,
  makeFakeDist,
  proveSession,
  SoftDevice,
  startAuthServer,
  stopAuthServer,
  tailnet,
} from './authTestKit.js';
import { DEVICE_ERRORS, DEVICE_UNUSED_MS, DeviceKeys, MAX_DEVICES } from './deviceKeys.js';
import { cldHooks } from './hooks.js';

const LOCAL_ORIGIN = 'http://localhost:18240';
/** A browser on this machine (or through an SSH tunnel). */
const LOCAL = { host: 'localhost:18240' };
const PUBLIC_ORIGIN = `https://${HOST}`;
const DAY = 86_400_000;

let configDir: string;
beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-config-'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(configDir, { recursive: true, force: true });
});
const devicesFile = () => path.join(configDir, 'devices.json');

describe('DeviceKeys (devices.json)', () => {
  async function registered(store: DeviceKeys, origin = LOCAL_ORIGIN) {
    const device = await SoftDevice.create();
    const result = store.register(device.id, await device.publicKey(), origin, 'iPhone', false);
    expect(result).toMatchObject({ isNew: true });
    return device;
  }
  async function proof(store: DeviceKeys, device: SoftDevice, origin = LOCAL_ORIGIN) {
    const { nonce } = store.challenge(origin);
    return { nonce, signature: await device.sign(nonce) };
  }

  it('verifies a WebCrypto signature (P1363) and a DER one over the nonce', async () => {
    const store = new DeviceKeys(devicesFile());
    const device = await registered(store);
    const { nonce, signature } = await proof(store, device);
    expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
    expect(store.verify(device.id, nonce, signature, LOCAL_ORIGIN)?.id).toBe(device.id);

    // Another signer's DER encoding of the same kind of key.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
    const id = crypto.randomBytes(16).toString('base64url');
    store.register(id, { kty, crv, x, y }, LOCAL_ORIGIN, 'Linux', false);
    const challenge = store.challenge(LOCAL_ORIGIN).nonce;
    const der = crypto.sign('sha256', Buffer.from(challenge), privateKey);
    expect(der.length).toBeGreaterThan(64);
    expect(store.verify(id, challenge, der.toString('base64url'), LOCAL_ORIGIN)?.id).toBe(id);
  });

  it('uses a nonce up on its first answer, right or wrong, and lets it live 60 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = new DeviceKeys(devicesFile());
    const device = await registered(store);
    const first = await proof(store, device);
    expect(store.verify(device.id, first.nonce, first.signature, LOCAL_ORIGIN)).not.toBeNull();
    expect(store.verify(device.id, first.nonce, first.signature, LOCAL_ORIGIN)).toBeNull();

    const wrong = await proof(store, device);
    expect(store.verify(device.id, wrong.nonce, 'AAAA', LOCAL_ORIGIN)).toBeNull();
    expect(store.verify(device.id, wrong.nonce, wrong.signature, LOCAL_ORIGIN)).toBeNull();

    const late = await proof(store, device);
    vi.advanceTimersByTime(60_000);
    expect(store.verify(device.id, late.nonce, late.signature, LOCAL_ORIGIN)).toBeNull();
    const forged = crypto.randomBytes(32).toString('base64url'); // never issued
    expect(store.verify(device.id, forged, await device.sign(forged), LOCAL_ORIGIN)).toBeNull();
  });

  it('accepts a key only on its own origin, with a nonce issued there', async () => {
    const store = new DeviceKeys(devicesFile());
    const device = await registered(store, LOCAL_ORIGIN);
    const there = await proof(store, device, PUBLIC_ORIGIN);
    expect(store.verify(device.id, there.nonce, there.signature, PUBLIC_ORIGIN)).toBeNull();
    const here = await proof(store, device, LOCAL_ORIGIN);
    expect(store.verify(device.id, here.nonce, here.signature, PUBLIC_ORIGIN)).toBeNull();
    const again = await proof(store, device, LOCAL_ORIGIN);
    expect(store.verify(device.id, again.nonce, again.signature, LOCAL_ORIGIN)).not.toBeNull();
  });

  it('takes P-256 public keys only, and well-formed ids', async () => {
    const store = new DeviceKeys(devicesFile());
    const jwk = await (await SoftDevice.create()).publicKey();
    const id = crypto.randomBytes(16).toString('base64url');
    const p384 = crypto
      .generateKeyPairSync('ec', { namedCurve: 'P-384' })
      .publicKey.export({ format: 'jwk' });
    const priv = crypto
      .generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ format: 'jwk' });
    for (const [badId, key] of [
      [id, { ...jwk, y: Buffer.alloc(32, 7).toString('base64url') }], // off the curve
      [id, p384],
      [id, priv], // a private key is never taken
      [id, { ...jwk, kty: 'RSA' }],
      [id, null],
      ['short', jwk],
      [42, jwk],
    ] as const)
      expect(store.register(badId, key, LOCAL_ORIGIN, 'x', false)).toEqual({
        status: 400,
        error: DEVICE_ERRORS.bad,
      });
    expect(store.list()).toEqual([]);
  });

  it('keeps one key per device id, and at most 20 devices', async () => {
    const store = new DeviceKeys(devicesFile());
    const device = await registered(store);
    const before = store.get(device.id);
    const other = await (await SoftDevice.create()).publicKey();
    expect(store.register(device.id, other, PUBLIC_ORIGIN, 'x', false)).toEqual({
      status: 409,
      error: DEVICE_ERRORS.taken,
    });
    const replaced = store.register(device.id, other, PUBLIC_ORIGIN, 'x', true);
    expect(replaced).toMatchObject({ isNew: false, device: { id: device.id, label: 'iPhone' } });
    expect(store.list()).toHaveLength(1);
    expect(store.get(device.id)).toMatchObject({ origin: PUBLIC_ORIGIN, publicKey: other });
    expect(store.get(device.id)?.createdAt).toBe(before?.createdAt);

    for (let i = 1; i < MAX_DEVICES; i++) await registered(store);
    const extra = await SoftDevice.create();
    expect(store.register(extra.id, await extra.publicKey(), LOCAL_ORIGIN, 'x', false)).toEqual({
      status: 403,
      error: DEVICE_ERRORS.full,
    });
    expect(DEVICE_ERRORS.full).toContain('로그인한 기기');
    // A device already in the list can still change its key.
    expect(store.register(device.id, other, LOCAL_ORIGIN, 'x', true)).toMatchObject({
      isNew: false,
    });
  });

  it('drops a key unused for 180 days; use keeps it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = new DeviceKeys(devicesFile());
    const used = await registered(store);
    const idle = await registered(store);
    vi.advanceTimersByTime(DEVICE_UNUSED_MS - DAY);
    store.touch(used.id);
    vi.advanceTimersByTime(2 * DAY);
    expect(store.list().map((d) => d.id)).toEqual([used.id]);
    expect(new DeviceKeys(devicesFile()).list().map((d) => d.id)).toEqual([used.id]);
    expect(idle.id).not.toBe(used.id);
  });

  it('writes devices.json 0600 with public keys only, and keeps an unreadable one', async () => {
    const store = new DeviceKeys(devicesFile());
    const device = await registered(store);
    expect(store.setPasskeyRequired(true)).toBe(true);
    expect(fs.statSync(devicesFile()).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(fs.readFileSync(devicesFile(), 'utf-8'));
    expect(saved).toMatchObject({ v: 1, passkeyRequired: true });
    expect(Object.keys(saved.devices[0]).sort()).toEqual(
      // `kind` (phone/tablet/desktop/unknown, O2) is the user agent's class: no secret.
      ['createdAt', 'id', 'kind', 'label', 'lastUsedAt', 'origin', 'publicKey'].sort(),
    );
    expect(Object.keys(saved.devices[0].publicKey).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(new DeviceKeys(devicesFile()).get(device.id)).toBeDefined();

    fs.writeFileSync(devicesFile(), '{"v":1,"devices":');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = new DeviceKeys(devicesFile());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('devices.json is unreadable'));
    expect(broken.broken).toBe(true);
    const next = await SoftDevice.create();
    expect(broken.register(next.id, await next.publicKey(), LOCAL_ORIGIN, 'x', false)).toEqual({
      status: 503,
      error: DEVICE_ERRORS.unreadable,
    });
    expect(broken.setPasskeyRequired(false)).toBe(false);
    expect(fs.readFileSync(devicesFile(), 'utf-8')).toBe('{"v":1,"devices":');
  });
});

describe('device key routes', () => {
  let dist: { root: string; staticDir: string };
  let server: AuthServer | undefined;
  beforeAll(() => {
    dist = makeFakeDist();
  });
  afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));
  afterEach(async () => {
    await stopAuthServer(server);
    server = undefined;
    delete cldHooks.verifiedOutsideUrl;
  });

  async function start(): Promise<AuthServer> {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    server = await startAuthServer(dist.staticDir, { configDir });
    return server;
  }

  /** A browser logged in with a code: its cookie. S1: it has also just stepped up. */
  function loggedIn(label = 'Windows · Edge') {
    return proveSession(
      server!.auth,
      `cld_session=${server!.auth.createSession('short', label).id}`,
    );
  }

  function call(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    at: Record<string, string>,
    origin: string,
    cookie?: string,
    payload?: unknown,
  ) {
    return server!.app.inject({
      method,
      url,
      headers: { ...at, origin, ...(cookie ? { cookie } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }

  async function register(device: SoftDevice, cookie: string, at = LOCAL, origin = LOCAL_ORIGIN) {
    return call('POST', '/api/auth/device', at, origin, cookie, {
      deviceId: device.id,
      publicKey: await device.publicKey(),
    });
  }

  /** The login page's silent re-login (or, with a cookie, the app proving its key). */
  async function prove(
    device: SoftDevice,
    at = LOCAL,
    origin = LOCAL_ORIGIN,
    url = '/login/device',
    cookie?: string,
  ) {
    const challenge = await call('GET', '/login/device/challenge', at, origin);
    expect(challenge.statusCode).toBe(200);
    const { nonce, expiresIn } = challenge.json();
    expect(expiresIn).toBe(60);
    return call('POST', url, at, origin, cookie, {
      deviceId: device.id,
      nonce,
      signature: await device.sign(nonce),
    });
  }

  const rows = async (cookie: string, at = LOCAL, origin = LOCAL_ORIGIN) =>
    (await call('GET', '/api/auth/sessions', at, origin, cookie)).json().sessions;
  const me = async (cookie: string, at = LOCAL, origin = LOCAL_ORIGIN) =>
    (await call('GET', '/api/auth/me', at, origin, cookie)).json();

  it('limits anonymous challenge churn per client', async () => {
    await start();
    const attacker = funnel('203.0.113.66');
    for (let i = 0; i < 10; i++)
      expect(
        (await call('GET', '/login/device/challenge', attacker, PUBLIC_ORIGIN)).statusCode,
      ).toBe(200);
    expect((await call('GET', '/login/device/challenge', attacker, PUBLIC_ORIGIN)).statusCode).toBe(
      429,
    );
    expect(
      (await call('GET', '/login/device/challenge', funnel('203.0.113.67'), PUBLIC_ORIGIN))
        .statusCode,
    ).toBe(200);
  });

  it('a device whose cookie is gone logs back in by itself, and stays one row', async () => {
    await start();
    const device = await SoftDevice.create();
    const first = loggedIn();
    expect((await register(device, first)).json()).toEqual({ deviceId: device.id });
    expect(await me(first)).toMatchObject({ id: device.id, deviceId: device.id, deviceKeys: true });

    const page = await call('GET', '/', LOCAL, LOCAL_ORIGIN);
    expect(page.statusCode).toBe(401);
    expect(page.body).toContain('data-device="1"');

    const res = await prove(device);
    expect(res.statusCode).toBe(200);
    const cookie = cookieOf(res.headers['set-cookie']);
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly; SameSite=Strict');
    expect(await me(cookie)).toMatchObject({
      method: 'device',
      id: device.id,
      label: 'Windows · Edge',
    });
    // The lost session ended: one session per device, one row.
    expect((await call('GET', '/api/auth/me', LOCAL, LOCAL_ORIGIN, first)).statusCode).toBe(401);
    expect(await rows(cookie)).toEqual([
      expect.objectContaining({ id: device.id, method: 'device', deviceKey: true, current: true }),
    ]);
    // Restarted, the key still works.
    await stopAuthServer(server);
    await start();
    expect((await prove(device)).statusCode).toBe(200);
  });

  it('a device key still logs in through a Tailscale serve host', async () => {
    await start();
    const device = await SoftDevice.create();
    const serve = { ...tailnet, 'x-forwarded-proto': 'https' };
    expect((await register(device, loggedIn(), serve, PUBLIC_ORIGIN)).statusCode).toBe(200);
    expect((await prove(device, serve, PUBLIC_ORIGIN)).statusCode).toBe(200);
  });

  it('limits failed device logins per client, valid ones included while blocked', async () => {
    await start();
    const device = await SoftDevice.create();
    await register(device, loggedIn());
    const other = await SoftDevice.create(); // signs, but is not registered
    for (let i = 0; i < 10; i++) expect((await prove(other)).statusCode).toBe(401);
    expect((await call('GET', '/login/device/challenge', LOCAL, LOCAL_ORIGIN)).statusCode).toBe(
      429,
    );
    // Another client is not blocked.
    const elsewhere = { ...LOCAL, 'x-forwarded-for': '100.64.0.7' };
    expect((await prove(device, elsewhere)).statusCode).toBe(200);
  });

  it('refuses a proof sent from another origin, or a key from another address', async () => {
    await start();
    const device = await SoftDevice.create();
    await register(device, loggedIn());
    expect((await prove(device, LOCAL, 'https://evil.example')).statusCode).toBe(401);
    // Registered on localhost, used through the public name.
    expect((await prove(device, funnel(), PUBLIC_ORIGIN)).statusCode).toBe(401);
    // Registration needs a session and the page's own origin.
    expect((await register(device, loggedIn(), LOCAL, 'https://evil.example')).statusCode).toBe(
      403,
    );
    expect(
      (await call('POST', '/api/auth/device', LOCAL, LOCAL_ORIGIN, undefined, {})).statusCode,
    ).toBe(401);
  });

  it('removing a device deletes its key and session and closes its sockets', async () => {
    await start();
    const device = await SoftDevice.create();
    const mine = loggedIn('iPhone · Safari');
    await register(device, mine);
    const closed: string[] = [];
    server!.auth.bindSocket(mine.split('=')[1], () => closed.push('ws'));
    const admin = loggedIn();
    const res = await call('DELETE', `/api/auth/sessions/${device.id}`, LOCAL, LOCAL_ORIGIN, admin);
    expect(res.statusCode).toBe(200);
    expect(closed).toEqual(['ws']);
    expect((await call('GET', '/api/auth/me', LOCAL, LOCAL_ORIGIN, mine)).statusCode).toBe(401);
    expect((await prove(device)).statusCode).toBe(401);
    expect((await rows(admin)).map((r: { id: string }) => r.id)).not.toContain(device.id);
    expect(JSON.parse(fs.readFileSync(devicesFile(), 'utf-8')).devices).toEqual([]);
  });

  it('signing out all other devices deletes their keys too', async () => {
    await start();
    const [a, b] = [await SoftDevice.create(), await SoftDevice.create()];
    const aCookie = loggedIn('A');
    loggedIn('C'); // no key
    await register(a, aCookie);
    // B's session is long gone; its key alone is a row too.
    server!.auth.devices!.register(b.id, await b.publicKey(), LOCAL_ORIGIN, 'B', false);
    expect(await rows(aCookie)).toHaveLength(3);
    const res = await call(
      'POST',
      '/api/auth/sessions/revoke-others',
      LOCAL,
      LOCAL_ORIGIN,
      aCookie,
    );
    expect(res.json()).toEqual({ count: 2 });
    expect((await rows(aCookie)).map((r: { id: string }) => r.id)).toEqual([a.id]);
    expect((await prove(b)).statusCode).toBe(401);
    expect((await prove(a)).statusCode).toBe(200);
  });

  it('패스키(생체 인증) 필수 turns silent logins off, not the keys', async () => {
    await start();
    const device = await SoftDevice.create();
    const cookie = loggedIn();
    await register(device, cookie);
    const set = (on: boolean, origin = LOCAL_ORIGIN) =>
      call('POST', '/api/auth/settings', LOCAL, origin, cookie, { passkeyRequired: on });
    expect((await set(true, 'https://evil.example')).statusCode).toBe(403);
    // On takes this device's own passkey here, just tapped: a cookie (and a key) is not enough.
    expect((await set(true)).statusCode).toBe(409);
    server!.auth.devices!.setPasskeyRequired(true);
    expect(await me(cookie)).toMatchObject({ passkeyRequired: true });
    expect((await call('GET', '/', LOCAL, LOCAL_ORIGIN)).body).not.toContain('data-device');
    const challenge = (await call('GET', '/login/device/challenge', LOCAL, LOCAL_ORIGIN)).json();
    const off = await call('POST', '/login/device', LOCAL, LOCAL_ORIGIN, undefined, {
      deviceId: device.id,
      nonce: challenge.nonce,
      signature: await device.sign(challenge.nonce),
    });
    expect(off.statusCode).toBe(404);
    // Restarted, still on; a code-only session cannot weaken it.
    await stopAuthServer(server);
    await start();
    expect((await prove(device)).statusCode).toBe(404);
    expect((await set(false)).statusCode).toBe(403);
    expect((await prove(device)).statusCode).toBe(404);
  });

  it('a code login on a device with a known key proves it and stays one row', async () => {
    await start();
    const device = await SoftDevice.create();
    const before = loggedIn();
    await register(device, before);
    const after = loggedIn(); // the cookie was lost; this time a QR code
    // Another session may not take over this device's id without its key.
    expect((await register(device, after)).statusCode).toBe(409);
    const linked = await prove(device, LOCAL, LOCAL_ORIGIN, '/api/auth/device/link', after);
    expect(linked.json()).toEqual({ deviceId: device.id });
    expect(await me(after)).toMatchObject({ id: device.id, deviceId: device.id, method: 'short' });
    expect((await call('GET', '/api/auth/me', LOCAL, LOCAL_ORIGIN, before)).statusCode).toBe(401);
    expect(await rows(after)).toHaveLength(1);
  });

  it('a session that is a device keeps its key: no other key, no other id', async () => {
    await start();
    const device = await SoftDevice.create();
    const cookie = loggedIn();
    await register(device, cookie);
    // A stolen cookie (or an XSS) holding no private key: it may not plant
    // a key of its own under this device's row, nor rebind the row elsewhere.
    const planted = await SoftDevice.create(device.id);
    expect((await register(planted, cookie)).statusCode).toBe(409);
    expect((await register(await SoftDevice.create(), cookie)).statusCode).toBe(409);
    expect((await prove(planted)).statusCode).toBe(401);
    expect((await prove(device)).statusCode).toBe(200);
    expect(server!.auth.devices!.list()).toHaveLength(1);
  });

  it('keeps only a well-formed origin for a key (the device list parses it)', async () => {
    await start();
    for (const host of ['localhost:99999', 'localhost:018240', 'LOCALHOST']) {
      const cookie = loggedIn();
      const res = await register(await SoftDevice.create(), cookie, { host }, `http://${host}`);
      expect(res.statusCode, host).toBe(400);
    }
    expect(server!.auth.devices!.list()).toEqual([]);
  });

  it('refuses a device proof that carries no Origin header', async () => {
    await start();
    const device = await SoftDevice.create();
    await register(device, loggedIn());
    const { nonce } = (await call('GET', '/login/device/challenge', LOCAL, LOCAL_ORIGIN)).json();
    const res = await server!.app.inject({
      method: 'POST',
      url: '/login/device',
      headers: LOCAL,
      payload: { deviceId: device.id, nonce, signature: await device.sign(nonce) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('moves a device to the canonical address under the same id (two host names)', async () => {
    await start();
    // T-0090b installs this probe hook even before a connection has passed an
    // outside check. Its missing value must fall back to the canonical URL.
    cldHooks.verifiedOutsideUrl = () => undefined;
    const device = await SoftDevice.create();
    const here = loggedIn('Mac · Safari');
    await register(device, here);
    expect(await me(here)).toMatchObject({ moveTo: PUBLIC_ORIGIN });
    const move = await call('POST', '/api/auth/move-code', LOCAL, LOCAL_ORIGIN, here);
    const { url, expiresIn } = move.json();
    expect(expiresIn).toBe(300);
    expect(url).toMatch(new RegExp(`^${PUBLIC_ORIGIN}/login\\?code=[\\w-]+$`));

    // On the canonical address: logged in by the code, as the same device.
    const path = new URL(url).pathname + new URL(url).search;
    const opened = await server!.app.inject({ url: path, headers: funnel() });
    // Not a redirect: the move began on another site, so the Strict cookie
    // would stay behind on it. This page's own hop to / takes it along.
    expect(opened.statusCode).toBe(200);
    expect(opened.body).toContain('<meta http-equiv="refresh" content="0;url=/">');
    expect(opened.headers['content-security-policy']).toContain("default-src 'none'");
    const there = cookieOf(opened.headers['set-cookie']);
    expect(await me(there, funnel(), PUBLIC_ORIGIN)).toMatchObject({
      method: 'move',
      id: device.id,
      deviceId: device.id,
      moveTo: null,
    });
    expect((await server!.app.inject({ url: path, headers: funnel() })).statusCode).toBe(401);

    // Its new key there replaces the one here: still one row, but other devices hear it.
    const moved = await SoftDevice.create(device.id);
    const res = await register(moved, there, funnel(), PUBLIC_ORIGIN);
    expect(res.json()).toEqual({ deviceId: device.id });
    expect(await rows(there, funnel(), PUBLIC_ORIGIN)).toEqual([
      expect.objectContaining({ id: device.id, origin: PUBLIC_ORIGIN, current: true }),
    ]);
    expect((await call('GET', '/api/auth/me', LOCAL, LOCAL_ORIGIN, here)).statusCode).toBe(401);
    expect((await prove(device)).statusCode).toBe(401); // the old key, here
    expect((await prove(moved, funnel(), PUBLIC_ORIGIN)).statusCode).toBe(200);
    expect(server!.broadcasts.filter((m) => m.type === 'newDeviceLogin')).toEqual([
      expect.objectContaining({ id: device.id, label: 'Mac · Safari' }),
      expect.objectContaining({ id: device.id, label: '기기 열쇠가 바뀌었어요: Mac · Safari' }),
    ]);
  });

  it('a move code needs a device key, and dies with its device', async () => {
    await start();
    const keyless = loggedIn();
    expect(
      (await call('POST', '/api/auth/move-code', LOCAL, LOCAL_ORIGIN, keyless)).statusCode,
    ).toBe(400);
    const device = await SoftDevice.create();
    const cookie = loggedIn();
    await register(device, cookie);
    const { url } = (await call('POST', '/api/auth/move-code', LOCAL, LOCAL_ORIGIN, cookie)).json();
    await call('DELETE', `/api/auth/sessions/${device.id}`, LOCAL, LOCAL_ORIGIN, keyless);
    const path = new URL(url).pathname + new URL(url).search;
    expect((await server!.app.inject({ url: path, headers: funnel() })).statusCode).toBe(401);
  });

  it('a move link expires after five minutes', async () => {
    await start();
    const cookie = loggedIn();
    await register(await SoftDevice.create(), cookie);
    const { url, expiresIn } = (
      await call('POST', '/api/auth/move-code', LOCAL, LOCAL_ORIGIN, cookie)
    ).json();
    expect(expiresIn).toBe(300);
    vi.useFakeTimers();
    vi.advanceTimersByTime(300_001);
    const path = new URL(url).pathname + new URL(url).search;
    expect((await server!.app.inject({ url: path, headers: funnel() })).statusCode).toBe(401);
  });

  it('compares origins: a canonical address with a path is still this origin', async () => {
    // T-0024's direct connector makes the canonical address https://<ip>/<secret>;
    // an allowed host with a path stands in for it here.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    server = await startAuthServer(dist.staticDir, {
      configDir,
      allowedHosts: [`${HOST}/s3cret`],
    });
    const there = loggedIn();
    await register(await SoftDevice.create(), there, funnel(), PUBLIC_ORIGIN);
    expect(await me(there, funnel(), PUBLIC_ORIGIN)).toMatchObject({ moveTo: null });
    const self = await call('POST', '/api/auth/move-code', funnel(), PUBLIC_ORIGIN, there);
    expect(self.statusCode).toBe(400);

    // Anywhere else, the move goes there with the whole address.
    const here = loggedIn();
    await register(await SoftDevice.create(), here);
    expect(await me(here)).toMatchObject({ moveTo: `${PUBLIC_ORIGIN}/s3cret` });
    const { url } = (await call('POST', '/api/auth/move-code', LOCAL, LOCAL_ORIGIN, here)).json();
    expect(url).toMatch(new RegExp(`^${PUBLIC_ORIGIN}/s3cret/login\\?code=[\\w-]+$`));
  });

  it('announces a new device to every client; a known one logging back in is quiet', async () => {
    await start();
    const device = await SoftDevice.create();
    await register(device, loggedIn('iPhone · Safari'));
    const notices = () => server!.broadcasts.filter((m) => m.type === 'newDeviceLogin');
    expect(notices()).toEqual([
      { type: 'newDeviceLogin', id: device.id, label: 'iPhone · Safari', at: expect.any(Number) },
    ]);
    expect((await prove(device)).statusCode).toBe(200);
    const link = await prove(device, LOCAL, LOCAL_ORIGIN, '/api/auth/device/link', loggedIn());
    expect(link.statusCode).toBe(200);
    expect(notices()).toHaveLength(1);
  });
});

describe('the new-device notice for logins that never become a known device', () => {
  it('comes 30 s after a login that registered nothing, and never for a known device', async () => {
    const device = await SoftDevice.create();
    const publicKey = await device.publicKey();
    vi.useFakeTimers();
    const auth = new StandaloneAuth({ configDir });
    const heard = vi.fn();
    auth.onNewDevice = heard;

    const first = auth.createSession('short', 'iPhone · Safari');
    auth.registerDevice(auth.session(first.id)!, device.id, publicKey, LOCAL_ORIGIN);
    expect(heard).toHaveBeenCalledTimes(1); // the registration itself
    auth.deviceLogin(auth.devices!.get(device.id)!); // quiet: a known device
    const again = auth.createSession('qr', 'iPhone · Safari'); // its cookie lost, a QR code
    auth.linkDevice(auth.session(again.id)!, device.id); // proved its key: quiet
    const script = auth.createSession('short', 'curl'); // never becomes a device

    vi.advanceTimersByTime(NEW_DEVICE_NOTICE_MS - 1);
    expect(heard).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(heard).toHaveBeenLastCalledWith({
      id: script.handle,
      label: 'curl',
      at: script.createdAt,
    });
    expect(auth.validSession(again.id)).toBe(true);
  });
});

/**
 * O5 (F-5): a registered page moves itself to the host's verified outside
 * address, with no hands. Only there, only the address the page was told,
 * only on its own device key's fresh step-up; the code is single use and
 * short; every move and every refusal is in the security record.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AuditLine } from './audit.js';
import { type AuthServer, cookieOf, makeFakeDist, SoftDevice, startAuthServer, stopAuthServer } from './authTestKit.js';
import { cldHooks } from './hooks.js';

const LAN = { host: 'localhost:18240', origin: 'http://localhost:18240' };
const OUTSIDE = 'https://outside.example';

let dist: { root: string; staticDir: string };
let server: AuthServer;
let configDir: string;
const previous = { canonicalUrl: cldHooks.canonicalUrl, verifiedOutsideUrl: cldHooks.verifiedOutsideUrl };

beforeAll(() => {
  dist = makeFakeDist();
});
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));
afterEach(async () => {
  vi.useRealTimers();
  await stopAuthServer(server);
  if (previous.canonicalUrl) cldHooks.canonicalUrl = previous.canonicalUrl;
  else delete cldHooks.canonicalUrl;
  if (previous.verifiedOutsideUrl) cldHooks.verifiedOutsideUrl = previous.verifiedOutsideUrl;
  else delete cldHooks.verifiedOutsideUrl;
  fs.rmSync(configDir, { recursive: true, force: true });
});

const audit = (): AuditLine[] => {
  try {
    return fs
      .readFileSync(path.join(configDir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AuditLine);
  } catch {
    return [];
  }
};

/** A phone registered at the LAN address: its key there, a session that is that device. */
async function registeredPhone(outside: string | undefined) {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-o5-'));
  server = await startAuthServer(dist.staticDir, { configDir });
  if (outside) cldHooks.verifiedOutsideUrl = () => outside;
  else delete cldHooks.verifiedOutsideUrl;
  const device = await SoftDevice.create();
  server.auth.devices!.register(device.id, await device.publicKey(), LAN.origin, 'Phone', false);
  const session = server.auth.createSession('device', 'Phone', device.id);
  const cookie = `cld_session=${session.id}`;
  const call = (method: 'GET' | 'POST', url: string, body?: unknown, who = cookie) =>
    server.app.inject({ method, url, headers: { ...LAN, cookie: who }, ...(body === undefined ? {} : { payload: body as object }) });
  /** The page's silent step-up: its device key signs a nonce. */
  const keyStepUp = async () => {
    const { nonce } = (await call('GET', '/login/device/challenge')).json<{ nonce: string }>();
    const res = await call('POST', '/api/auth/stepup/device', { deviceId: device.id, nonce, signature: await device.sign(nonce) });
    expect(res.statusCode).toBe(200);
  };
  const me = async () => (await call('GET', '/api/auth/me')).json<{ autoMoveTo: string | null }>();
  return { device, session, cookie, call, keyStepUp, me };
}

/** Open the move link at the outside address, as the browser would. */
const openAt = (url: string) => {
  const parsed = new URL(url);
  return server.app.inject({
    url: `${parsed.pathname}${parsed.search}`,
    headers: { host: parsed.host, 'x-forwarded-proto': 'https' },
  });
};

describe('O5 automatic move', () => {
  it('a verified outside address: the page is told, moves with its key, and ends a device there', async () => {
    const phone = await registeredPhone(`${OUTSIDE}/`);
    expect((await phone.me()).autoMoveTo).toBe(OUTSIDE);
    await phone.keyStepUp();
    const issued = await phone.call('POST', '/api/auth/move-code', { auto: OUTSIDE });
    expect(issued.statusCode).toBe(200);
    const { url, expiresIn } = issued.json<{ url: string; expiresIn: number }>();
    expect(url).toMatch(/^https:\/\/outside\.example\/login\?code=[\w-]{32}$/);
    expect(expiresIn).toBe(60);
    expect(audit().at(-1)).toMatchObject({ kind: 'moveCodeCreated', detail: 'auto', device: { id: phone.device.id } });

    const landed = await openAt(url);
    expect(landed.statusCode).toBe(200);
    const moved = server.auth.session(cookieOf(landed.headers['set-cookie']).split('=')[1]);
    expect(moved).toMatchObject({ method: 'move', deviceId: phone.device.id });
    expect(audit().at(-1)).toMatchObject({ kind: 'loginCodeUsed', detail: 'move', device: { id: phone.device.id } });
    // There, the moved session may hand an iPhone's Home-Screen app a code (O5 extends S3).
    expect(server.auth.mayHandoff(moved!)).toBe(true);
    // Single use.
    expect((await openAt(url)).statusCode).toBe(401);
  });

  it('refuses an address the host has not verified (no allowlist fallback), and audits it', async () => {
    const phone = await registeredPhone(undefined);
    // The manual move may still use an allowed serve name; the automatic one never.
    cldHooks.canonicalUrl = () => 'https://office.tail0000.ts.net/';
    expect((await phone.me()).autoMoveTo).toBeNull();
    await phone.keyStepUp();
    const create = vi.spyOn(server.auth, 'createMoveCode');
    const auto = await phone.call('POST', '/api/auth/move-code', { auto: 'https://office.tail0000.ts.net' });
    expect(auto.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(audit().at(-1)).toMatchObject({ kind: 'moveRefused', detail: 'target' });
    // Regression: the manual move to the allowed name still works, and is recorded as manual.
    const manual = await phone.call('POST', '/api/auth/move-code');
    expect(manual.statusCode).toBe(200);
    expect(audit().at(-1)).toMatchObject({ kind: 'moveCodeCreated', detail: 'manual' });
  });

  it('refuses when the verified address changed after the page learned it', async () => {
    const phone = await registeredPhone(`${OUTSIDE}/`);
    const told = (await phone.me()).autoMoveTo;
    cldHooks.verifiedOutsideUrl = () => 'https://new.example/';
    await phone.keyStepUp();
    const res = await phone.call('POST', '/api/auth/move-code', { auto: told });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'move_target_changed' });
    expect(audit().at(-1)).toMatchObject({ kind: 'moveRefused', detail: 'changed' });
  });

  it('refuses without a session, without a device key, or without the key’s own step-up', async () => {
    const phone = await registeredPhone(`${OUTSIDE}/`);
    const create = vi.spyOn(server.auth, 'createMoveCode');
    // No session.
    expect((await phone.call('POST', '/api/auth/move-code', { auto: OUTSIDE }, '')).statusCode).toBe(401);
    // A session, no step-up at all.
    const none = await phone.call('POST', '/api/auth/move-code', { auto: OUTSIDE });
    expect(none.statusCode).toBe(403);
    expect(none.json()).toMatchObject({ error: 'stepup' });
    // A step-up, but by passkey: the automatic move wants the device key itself.
    server.auth.provedStepUp(server.auth.session(phone.session.id)!, 'passkey');
    const passkey = await phone.call('POST', '/api/auth/move-code', { auto: OUTSIDE });
    expect(passkey.statusCode).toBe(403);
    expect(audit().at(-1)).toMatchObject({ kind: 'moveRefused', detail: 'key' });
    // A session that is no device with a key (a code login whose key never registered).
    const keyless = server.auth.createSession('link', 'Tab');
    server.auth.provedStepUp(server.auth.session(keyless.id)!, 'key');
    expect((await phone.me()).autoMoveTo).toBe(OUTSIDE);
    const meKeyless = await phone.call('GET', '/api/auth/me', undefined, `cld_session=${keyless.id}`);
    expect(meKeyless.json()).toMatchObject({ autoMoveTo: null });
    const res = await phone.call('POST', '/api/auth/move-code', { auto: OUTSIDE }, `cld_session=${keyless.id}`);
    expect(res.statusCode).toBe(400);
    expect(audit().at(-1)).toMatchObject({ kind: 'moveRefused', detail: 'target' });
    expect(create).not.toHaveBeenCalled();
  });

  it('an automatic move code expires after 60 seconds', async () => {
    const phone = await registeredPhone(`${OUTSIDE}/`);
    await phone.keyStepUp();
    const { url } = (await phone.call('POST', '/api/auth/move-code', { auto: OUTSIDE })).json<{ url: string }>();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    expect((await openAt(url)).statusCode).toBe(401);
  });

  it('a moved tab’s Home-Screen app code: audited, the same device, and revoking that device ends it', async () => {
    const phone = await registeredPhone(`${OUTSIDE}/`);
    await phone.keyStepUp();
    const { url } = (await phone.call('POST', '/api/auth/move-code', { auto: OUTSIDE })).json<{ url: string }>();
    const tab = cookieOf((await openAt(url)).headers['set-cookie']);
    const outside = { host: 'outside.example', origin: OUTSIDE, 'x-forwarded-proto': 'https' };
    const at = (method: 'GET' | 'POST', path: string, cookie: string, body?: object) =>
      server.app.inject({ method, url: path, headers: { ...outside, cookie }, ...(body ? { payload: body } : {}) });
    // The moved tab brings its key to the outside address first (what its page does on load).
    const key = await SoftDevice.create(phone.device.id);
    expect((await at('POST', '/api/auth/device', tab, { deviceId: key.id, publicKey: await key.publicKey() })).statusCode).toBe(200);

    const handoff = await at('POST', '/api/auth/handoff-code', tab);
    expect(handoff.statusCode).toBe(200);
    expect(audit().at(-1)).toMatchObject({
      kind: 'handoffCodeCreated',
      device: { id: phone.device.id },
      detail: OUTSIDE,
      by: 'Phone',
    });
    const app = cookieOf((await openAt(`${OUTSIDE}/login?code=${handoff.json<{ code: string }>().code}`)).headers['set-cookie']);
    const appSession = server.auth.session(app.split('=')[1])!;
    expect(appSession).toMatchObject({ method: 'handoff', deviceId: phone.device.id });
    // The app brings the device's key into its own storage, once, at the device's address only.
    const appKey = await SoftDevice.create(phone.device.id);
    expect(
      (await server.app.inject({
        method: 'POST',
        url: '/api/auth/device',
        headers: { ...LAN, cookie: app },
        payload: { deviceId: appKey.id, publicKey: await appKey.publicKey() },
      })).statusCode,
    ).toBe(409);
    expect((await at('POST', '/api/auth/device', app, { deviceId: appKey.id, publicKey: await appKey.publicKey() })).statusCode).toBe(200);
    expect(audit().at(-1)).toMatchObject({ kind: 'deviceRegistered', detail: 'replaced', device: { id: phone.device.id } });
    expect((await at('POST', '/api/auth/device', app, { deviceId: appKey.id, publicKey: await appKey.publicKey() })).statusCode).toBe(409);

    // 끊기 on the device ends the app too.
    expect(server.auth.revoke(phone.device.id)).toBe(true);
    expect(server.auth.session(app.split('=')[1])).toBeUndefined();
  });
});

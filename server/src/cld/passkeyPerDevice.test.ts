/**
 * 10-24: "패스키(생체 인증) 필수" was on with no passkey left (the owner removed
 * both, then turned it on; the office is opened at an IP address, where a
 * passkey can never be made). The device key was refused as a step-up and
 * there was no passkey to tap, so every dangerous action -- 기기 추가, adding
 * a passkey, deleting one, turning the setting off -- was refused for good.
 *
 * Now: with 필수 on every step-up is a passkey tap -- unless no passkey exists
 * anywhere, when the device key works again (lockout recovery). Turning it on
 * takes this device's own passkey here, just tapped; turning it off a recent
 * tap, or the key when no passkey exists, or the host's token. A step-up only
 * accepts credentials still stored. And a passkey is made per device: its own
 * user handle, only its own credentials excluded (a synced authenticator does
 * not refuse or overwrite a second device's), five per device per address.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';

import {
  type AuthServer,
  makeFakeDist,
  SoftAuthenticator,
  SoftDevice,
  startAuthServer,
  stopAuthServer,
  TOKEN,
} from './authTestKit.js';
import { MAX_PER_DEVICE, PASSKEY_CAP } from './passkeys.js';

const origin = 'http://localhost:18240';
const headers = { host: 'localhost:18240', origin };
const dist = makeFakeDist();
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));

let server: AuthServer;
let configDir: string;
beforeEach(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-pk-device-'));
});
afterEach(async () => {
  await stopAuthServer(server);
  fs.rmSync(configDir, { recursive: true, force: true });
});

/** The owner's files: device keys, 필수 on, a v2 passkeys.json with nothing in it. */
async function ownerState(labels: string[], passkeyRequired = true) {
  const devices = await Promise.all(labels.map(() => SoftDevice.create()));
  const now = Date.now();
  fs.writeFileSync(
    path.join(configDir, 'devices.json'),
    JSON.stringify({
      v: 1,
      passkeyRequired,
      devices: await Promise.all(
        devices.map(async (d, i) => ({
          id: d.id,
          label: labels[i],
          publicKey: await d.publicKey(),
          origin,
          createdAt: now,
          lastUsedAt: now,
        })),
      ),
    }),
  );
  fs.writeFileSync(
    path.join(configDir, 'passkeys.json'),
    JSON.stringify({ v: 2, userId: 'dXNlcg', revoked: [], byRp: {} }),
  );
  server = await startAuthServer(dist.staticDir, { configDir });
  return devices.map((device, i) => {
    const id = server.auth.createSession('short', labels[i], device.id).id;
    return { device, cookie: `cld_session=${id}` };
  });
}

type Who = { device: SoftDevice; cookie: string };
const call = (who: Who, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  server.app.inject({ method, url, headers: { ...headers, cookie: who.cookie }, payload });
const me = async (who: Who) => (await call(who, 'GET', '/api/auth/me')).json();
async function keyStepUp(who: Who) {
  const { nonce } = (
    await server.app.inject({ method: 'GET', url: '/login/device/challenge', headers })
  ).json<{ nonce: string }>();
  return call(who, 'POST', '/api/auth/stepup/device', {
    deviceId: who.device.id,
    nonce,
    signature: await who.device.sign(nonce),
  });
}
async function registrationOptions(who: Who) {
  return (await call(who, 'POST', '/api/auth/passkeys/options')).json();
}
async function registerPasskey(who: Who, authenticator: SoftAuthenticator) {
  const begin = await registrationOptions(who);
  return call(who, 'POST', '/api/auth/passkeys', {
    ceremony: begin.ceremony,
    response: authenticator.register(begin.options, origin),
    name: 'Face ID',
  });
}
async function passkeyStepUp(who: Who, authenticator: SoftAuthenticator) {
  const begin = (await call(who, 'POST', '/api/auth/passkeys/verify/options')).json();
  return call(who, 'POST', '/api/auth/passkeys/verify', {
    ceremony: begin.ceremony,
    response: authenticator.login(begin.options, origin),
  });
}

const settings = (who: Who, on: boolean) =>
  call(who, 'POST', '/api/auth/settings', { passkeyRequired: on });

/** 필수 off first, so `who` steps up with its key and registers its own passkey; then 필수 goes on by that passkey. */
async function ownPasskeyThenRequired(who: Who) {
  const faceId = new SoftAuthenticator();
  expect((await keyStepUp(who)).statusCode).toBe(200);
  const added = await registerPasskey(who, faceId);
  expect(added.json().passkey.deviceId).toBe(who.device.id);
  expect((await passkeyStepUp(who, faceId)).statusCode).toBe(200);
  expect((await settings(who, true)).json()).toEqual({ passkeyRequired: true });
  return { faceId, id: added.json().passkey.id as string };
}

it('lockout recovery: 필수 on with no passkey anywhere, the device key steps up (기기 추가, a passkey) and turns 필수 off', async () => {
  const [phone] = await ownerState(['iPhone · Chrome']);
  expect(await me(phone)).toMatchObject({ passkeyRequired: true, keyStepUp: true });
  // Was 403 "패스키로 확인해 주세요": nothing could ever prove this device.
  expect((await keyStepUp(phone)).statusCode).toBe(200);
  expect((await call(phone, 'POST', '/api/auth/device-code')).json().code).toMatch(/^\d{8}$/);

  // A passkey now exists: every step-up is a tap again.
  const faceId = new SoftAuthenticator();
  const added = await registerPasskey(phone, faceId);
  expect(added.statusCode).toBe(200);
  expect(await me(phone)).toMatchObject({ passkeyHere: true, keyStepUp: false });
  expect((await keyStepUp(phone)).statusCode).toBe(403);
  expect((await passkeyStepUp(phone, faceId)).statusCode).toBe(200);
  const id = added.json().passkey.id as string;
  expect((await call(phone, 'DELETE', `/api/auth/passkeys/${id}`)).statusCode).toBe(200);

  // None left: the key again, and 필수 goes off with a fresh key step-up (not a cookie alone).
  expect(await me(phone)).toMatchObject({ keyStepUp: true });
  // A new session of the same device: no recent tap, no step-up yet.
  const fresh = server.auth.createSession('short', 'iPhone · Chrome', phone.device.id).id;
  const again = { device: phone.device, cookie: `cld_session=${fresh}` };
  expect((await settings(again, false)).json()).toEqual({ error: 'stepup' });
  expect((await keyStepUp(again)).statusCode).toBe(200);
  expect((await settings(again, false)).json()).toEqual({ passkeyRequired: false });
});

it("(a') a stolen cookie of a session with no key yet registers a key of its own: still no step-up while a passkey exists", async () => {
  const [owner] = await ownerState(['Windows · Chrome'], false);
  await ownPasskeyThenRequired(owner);
  const stolen = `cld_session=${server.auth.createSession('short', 'iPhone · Safari').id}`;
  const thief = { device: await SoftDevice.create(), cookie: stolen };
  const registered = await call(thief, 'POST', '/api/auth/device', {
    deviceId: thief.device.id,
    publicKey: await thief.device.publicKey(),
  });
  expect(registered.statusCode).toBe(200);
  expect((await keyStepUp(thief)).statusCode).toBe(403);
  for (const [method, url] of [
    ['POST', '/api/auth/device-code'],
    ['POST', '/api/auth/passkeys/options'],
    ['POST', '/api/auth/sessions/revoke-others'],
  ] as const)
    expect((await call(thief, method, url)).json()).toEqual({ error: 'stepup' });
  expect((await settings(thief, false)).statusCode).toBe(403);
  expect(await me(owner)).toMatchObject({ passkeyRequired: true });
});

it('(b) an unlocked browser of a device with no passkey here: no step-up, no deleting the other passkey, no 필수 off', async () => {
  const [phone, windows] = await ownerState(['iPhone · Chrome', 'Windows · Chrome'], false);
  const { id } = await ownPasskeyThenRequired(phone);
  expect(await me(windows)).toMatchObject({ keyStepUp: false, passkeyRequired: true });
  expect((await keyStepUp(windows)).statusCode).toBe(403);
  expect((await call(windows, 'DELETE', `/api/auth/passkeys/${id}`)).json()).toEqual({
    error: 'stepup',
  });
  expect((await call(windows, 'GET', '/api/auth/passkeys')).json().passkeys).toHaveLength(1);
  const off = await settings(windows, false);
  expect(off.statusCode).toBe(403);
  expect(off.json().error).toBe('패스키로 확인한 뒤 끌 수 있어요');
  expect(await me(windows)).toMatchObject({ passkeyRequired: true });
});

it("필수 on takes this device's own passkey at this address, tapped in the last 5 minutes", async () => {
  const [phone, windows] = await ownerState(['iPhone · Chrome', 'Windows · Chrome'], false);
  const conflict = { error: '이 기기의 패스키로 이 주소에서 확인한 뒤 켤 수 있어요' };
  // A cookie alone, even with a fresh key step-up: no.
  expect((await keyStepUp(windows)).statusCode).toBe(200);
  const refused = await settings(windows, true);
  expect(refused.statusCode).toBe(409);
  expect(refused.json()).toMatchObject(conflict);
  // Registered but not tapped: no. Tapped: yes.
  const faceId = new SoftAuthenticator();
  expect((await keyStepUp(phone)).statusCode).toBe(200);
  expect((await registerPasskey(phone, faceId)).statusCode).toBe(200);
  // /me: a passkey here for both, but only the phone's own (what the checkbox greys on).
  expect(await me(phone)).toMatchObject({ passkeyHere: true, ownPasskeyHere: true });
  expect(await me(windows)).toMatchObject({ passkeyHere: true, ownPasskeyHere: false });
  expect((await settings(phone, true)).json()).toMatchObject(conflict);
  // Windows tapping the phone's (synced) passkey is not Windows' own: no.
  expect((await passkeyStepUp(windows, faceId)).statusCode).toBe(200);
  expect((await settings(windows, true)).json()).toMatchObject(conflict);
  expect((await passkeyStepUp(phone, faceId)).statusCode).toBe(200);
  expect((await settings(phone, true)).json()).toEqual({ passkeyRequired: true });
});

it('signing out its own device under 필수 takes a passkey tap when that ends passkeys; without the authenticator, the host token', async () => {
  const [phone, windows] = await ownerState(['iPhone · Chrome', 'Windows · Chrome'], false);
  const { faceId } = await ownPasskeyThenRequired(phone);
  // A new session of the phone: a cookie, no recent tap.
  const cookie = `cld_session=${server.auth.createSession('short', 'iPhone · Chrome', phone.device.id).id}`;
  const again = { device: phone.device, cookie };
  const signOut = () => call(again, 'DELETE', `/api/auth/sessions/${phone.device.id}`);
  expect((await signOut()).json()).toEqual({ error: 'stepup' });
  // Its passkeys stay, so no device key steps up and 필수 stays on.
  expect((await call(windows, 'GET', '/api/auth/passkeys')).json().passkeys).toHaveLength(1);
  expect((await keyStepUp(windows)).statusCode).toBe(403);
  expect(await me(windows)).toMatchObject({ passkeyRequired: true });
  // With a tap it goes.
  expect((await passkeyStepUp(again, faceId)).statusCode).toBe(200);
  expect((await signOut()).statusCode).toBe(200);
  expect((await call(windows, 'GET', '/api/auth/passkeys')).json().passkeys).toHaveLength(0);
});

it('a device that lost its authenticator: the host token turns 필수 off, then it signs itself out', async () => {
  const [phone] = await ownerState(['iPhone · Chrome'], false);
  await ownPasskeyThenRequired(phone);
  const cookie = `cld_session=${server.auth.createSession('short', 'iPhone · Chrome', phone.device.id).id}`;
  const lost = { device: phone.device, cookie };
  const signOut = () => call(lost, 'DELETE', `/api/auth/sessions/${phone.device.id}`);
  expect((await signOut()).json()).toEqual({ error: 'stepup' });
  expect((await keyStepUp(lost)).statusCode).toBe(403);
  const host = await server.app.inject({
    method: 'POST',
    url: '/api/auth/settings',
    headers: { host: 'localhost:18240', authorization: `Bearer ${TOKEN}` },
    payload: { passkeyRequired: false },
  });
  expect(host.json()).toEqual({ passkeyRequired: false });
  expect((await signOut()).statusCode).toBe(200);
});

it("the host's own token always turns 필수 off; a stranger's Bearer does not", async () => {
  const [phone] = await ownerState(['iPhone · Chrome'], false);
  await ownPasskeyThenRequired(phone);
  const host = (token: string) =>
    server.app.inject({
      method: 'POST',
      url: '/api/auth/settings',
      headers: { host: 'localhost:18240', authorization: `Bearer ${token}` },
      payload: { passkeyRequired: false },
    });
  expect((await host('not-the-token')).statusCode).toBe(401);
  expect(await me(phone)).toMatchObject({ passkeyRequired: true });
  expect((await host(TOKEN)).json()).toEqual({ passkeyRequired: false });
  expect(await me(phone)).toMatchObject({ passkeyRequired: false });
  // The record: on by the phone, off by the host.
  const lines = fs
    .readFileSync(path.join(configDir, 'audit.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((line) => line.kind === 'passkeyRequired');
  expect(lines).toEqual([
    expect.objectContaining({
      detail: 'on',
      device: expect.objectContaining({ id: phone.device.id }),
    }),
    expect.objectContaining({ detail: 'off', by: 'host' }),
  ]);
});

it("a step-up lists the stored credentials only, so a deleted passkey's synced copy can't be picked", async () => {
  const [phone] = await ownerState(['iPhone · Chrome'], false);
  const faceId = new SoftAuthenticator();
  expect((await keyStepUp(phone)).statusCode).toBe(200);
  const kept = (await registerPasskey(phone, faceId)).json().passkey.id as string;
  const gone = (await registerPasskey(phone, new SoftAuthenticator())).json().passkey.id as string;
  expect((await call(phone, 'DELETE', `/api/auth/passkeys/${gone}`)).statusCode).toBe(200);
  const begin = (await call(phone, 'POST', '/api/auth/passkeys/verify/options')).json();
  expect(begin.options.allowCredentials.map((c: { id: string }) => c.id)).toEqual([kept]);
  // The login page still lets the authenticator offer its own (discoverable) passkeys.
  const login = (
    await server.app.inject({ method: 'POST', url: '/login/passkey/options', headers })
  ).json();
  expect(login.options.allowCredentials ?? []).toEqual([]);
});

it(`a device keeps at most ${MAX_PER_DEVICE} passkeys at one address`, async () => {
  const [phone, windows] = await ownerState(['iPhone · Chrome', 'Windows · Chrome'], false);
  expect((await keyStepUp(phone)).statusCode).toBe(200);
  for (let i = 0; i < MAX_PER_DEVICE; i++)
    expect((await registerPasskey(phone, new SoftAuthenticator())).statusCode).toBe(200);
  const sixth = await registerPasskey(phone, new SoftAuthenticator());
  expect(sixth.statusCode).toBe(400);
  expect(sixth.json()).toMatchObject({ error: PASSKEY_CAP });
  // Another device has its own five.
  expect((await keyStepUp(windows)).statusCode).toBe(200);
  expect((await registerPasskey(windows, new SoftAuthenticator())).statusCode).toBe(200);
});

it('each device gets its own passkey: its own user handle, only its own credentials excluded', async () => {
  const [windows, phone] = await ownerState(['Windows · Chrome', 'iPhone · Chrome'], false);
  // Synced (Google Password Manager on both): one authenticator, two devices.
  const synced = new SoftAuthenticator();
  expect((await keyStepUp(windows)).statusCode).toBe(200);
  const first = await registerPasskey(windows, synced);
  expect(first.statusCode).toBe(200);
  expect((await keyStepUp(phone)).statusCode).toBe(200);
  const forPhone = await registrationOptions(phone);
  const forWindows = (await keyStepUp(windows), await registrationOptions(windows));
  // A synced authenticator refuses a registration that excludes a credential it holds
  // (InvalidStateError), and replaces one with the same user handle.
  expect(forPhone.options.excludeCredentials).toEqual([]);
  expect(forWindows.options.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([
    first.json().passkey.id,
  ]);
  expect(forPhone.options.user.id).not.toBe(forWindows.options.user.id);
  expect(forPhone.options.user.name).toContain('iPhone · Chrome');
  const second = await call(phone, 'POST', '/api/auth/passkeys', {
    ceremony: forPhone.ceremony,
    response: synced.register(forPhone.options, origin),
    name: 'Face ID',
  });
  expect(second.json().passkey.deviceId).toBe(phone.device.id);
  const list = (await call(phone, 'GET', '/api/auth/passkeys')).json().passkeys;
  expect(list.map((k: { deviceId: string }) => k.deviceId).sort()).toEqual(
    [windows.device.id, phone.device.id].sort(),
  );
});

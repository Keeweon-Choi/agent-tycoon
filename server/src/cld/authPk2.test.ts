/**
 * AUTH-PK2 (10-24): the owner's iPhone pressed 패스키 필수 off twice and nothing happened.
 * Its cookie pointed at its device row, but the browser no longer held that row's key.
 *
 * - S2: a context that logs in by code (a handoff to the Home-Screen app, a 기기 추가 code)
 *   gets its own row and a key the server accepts; a plain cookie still never binds a key
 *   to a known device (409), and a move's cookie only once, at its new address.
 * - S1: a logged-in session's nonce requests count per session, not per address; only
 *   failed proofs feed the per-address block, and a block leaves a security-record line.
 * - A key proof taken before 필수 bound the keys (필수 went on, or the first passkey came
 *   under it) proves nothing afterwards.
 * - Signing out by a session handle counts the passkeys of the device that handle resolves to.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';

import {
  type AuthServer,
  cookieOf,
  formLogin,
  HOST,
  makeFakeDist,
  SoftAuthenticator,
  SoftDevice,
  startAuthServer,
  stopAuthServer,
  TOKEN,
} from './authTestKit.js';

const origin = 'http://localhost:18240';
const headers = { host: 'localhost:18240', origin };
const dist = makeFakeDist();
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));

let server: AuthServer;
let configDir: string;
beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-pk2-'));
});
afterEach(async () => {
  await stopAuthServer(server);
  fs.rmSync(configDir, { recursive: true, force: true });
});

type Who = { device: SoftDevice; cookie: string };

/** Devices with keys at `origin`, each with a session, from files (as after a restart). */
async function ownerState(labels: string[], passkeyRequired: boolean) {
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
  return devices.map((device, i): Who => {
    const id = server.auth.createSession('short', labels[i], device.id).id;
    return { device, cookie: `cld_session=${id}` };
  });
}

const call = (who: { cookie: string }, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  server.app.inject({ method, url, headers: { ...headers, cookie: who.cookie }, payload });
const nonceFor = async (who?: { cookie: string }) =>
  server.app.inject({ url: '/login/device/challenge', headers: { ...headers, ...(who ? { cookie: who.cookie } : {}) } });
async function keyStepUp(who: Who, signer = who.device) {
  const { nonce } = (await nonceFor(who)).json<{ nonce: string }>();
  return call(who, 'POST', '/api/auth/stepup/device', {
    deviceId: who.device.id,
    nonce,
    signature: await signer.sign(nonce),
  });
}
async function registerPasskey(who: Who, authenticator: SoftAuthenticator) {
  const begin = (await call(who, 'POST', '/api/auth/passkeys/options')).json();
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
const registerKey = async (cookie: string, device: SoftDevice) =>
  call({ cookie }, 'POST', '/api/auth/device', { deviceId: device.id, publicKey: await device.publicKey() });
const auditLines = () =>
  fs
    .readFileSync(path.join(configDir, 'audit.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind: string; detail?: unknown; device?: { id: string } });

// ── S2 ──────────────────────────────────────────────────────────

it('a handoff code logs the Home-Screen app in as the same device, which brings its key there once and steps up', async () => {
  const [windows] = await ownerState(['Windows · Chrome'], true);
  expect((await keyStepUp(windows)).statusCode).toBe(200); // no passkey anywhere: the key steps up
  const invite = (await call(windows, 'POST', '/api/auth/device-code')).json<{ link: string }>();
  // The phone's browser opens the QR...
  const qr = await server.app.inject({ url: new URL(invite.link).pathname + new URL(invite.link).search, headers });
  const browser = cookieOf(qr.headers['set-cookie']);
  const browserKey = await SoftDevice.create();
  expect((await registerKey(browser, browserKey)).statusCode).toBe(200);
  // ...and hands the Home-Screen app (its own storage, no key) a code.
  const { code } = (await call({ cookie: browser }, 'POST', '/api/auth/handoff-code')).json<{ code: string }>();
  const login = await server.app.inject(formLogin(code, headers));
  expect(login.statusCode).toBe(303);
  const app = cookieOf(login.headers['set-cookie']);
  // O5 review: the app is the issuing device (revoking it ends the app too).
  const me = (await call({ cookie: app }, 'GET', '/api/auth/me')).json();
  expect(me).toMatchObject({ method: 'handoff', deviceId: browserKey.id });
  // A key of its own under another id is refused; the device's id is taken into the app once.
  expect((await registerKey(app, await SoftDevice.create())).statusCode).toBe(409);
  const appKey = await SoftDevice.create(browserKey.id);
  expect((await registerKey(app, appKey)).json()).toEqual({ deviceId: browserKey.id });
  expect((await registerKey(app, await SoftDevice.create(browserKey.id))).statusCode).toBe(409);
  expect((await keyStepUp({ device: appKey, cookie: app })).statusCode).toBe(200);
  // Two rows: Windows and the phone (its browser tab ended when the app took the key).
  const rows = (await call(windows, 'GET', '/api/auth/sessions')).json().sessions as Array<{ id: string }>;
  expect(rows.map((r) => r.id).sort()).toEqual([windows.device.id, browserKey.id].sort());
  expect((await call({ cookie: browser }, 'GET', '/api/auth/me')).statusCode).toBe(401);
});

it("a 기기 추가 code typed in a context whose key was lost: a new row, a key the server accepts; the cookie of the old row still can't bind one", async () => {
  const [windows, phone] = await ownerState(['Windows · Chrome', 'iPhone · Chrome'], true);
  // The phone's browser lost its key: its cookie, a fresh key under its own id or a new one, is refused.
  const lostUnderOwnId = await SoftDevice.create(phone.device.id);
  expect((await registerKey(phone.cookie, lostUnderOwnId)).statusCode).toBe(409);
  expect((await registerKey(phone.cookie, await SoftDevice.create())).statusCode).toBe(409);
  // A key it does not hold proves nothing.
  expect((await keyStepUp(phone, lostUnderOwnId)).statusCode).toBe(403);
  // Recovery: it signs itself out (no passkey: no step-up) and logs in with a 기기 추가 code.
  expect((await call(phone, 'DELETE', `/api/auth/sessions/${phone.device.id}`)).statusCode).toBe(200);
  expect((await keyStepUp(windows)).statusCode).toBe(200);
  const { code } = (await call(windows, 'POST', '/api/auth/device-code')).json<{ code: string }>();
  const login = await server.app.inject(formLogin(code, headers));
  const cookie = cookieOf(login.headers['set-cookie']);
  const fresh = await SoftDevice.create();
  expect((await registerKey(cookie, fresh)).json()).toEqual({ deviceId: fresh.id });
  // It proves itself by key again, and turns 필수 off with that proof (no passkey anywhere).
  const again = { device: fresh, cookie };
  expect((await call(again, 'POST', '/api/auth/settings', { passkeyRequired: false })).json()).toEqual({ error: 'stepup' });
  expect((await keyStepUp(again)).statusCode).toBe(200);
  expect((await call(again, 'POST', '/api/auth/settings', { passkeyRequired: false })).json()).toEqual({
    passkeyRequired: false,
  });
});

it("a move's cookie binds a key once: not again under another Host the daemon answers to, nor after a restart", async () => {
  const [phone] = await ownerState(['iPhone · Chrome'], false);
  // A move session of the phone, at a new address (the device's key is still the old address's).
  server.auth.devices!.get(phone.device.id)!.origin = 'https://old.example';
  const moved = `cld_session=${server.auth.createSession('move', 'iPhone · Chrome', phone.device.id).id}`;
  const tailnet = { host: HOST, origin: `http://${HOST}` };
  const registerAt = async (at: Record<string, string>) =>
    server.app.inject({
      method: 'POST',
      url: '/api/auth/device',
      headers: { ...at, cookie: moved },
      payload: { deviceId: phone.device.id, publicKey: await (await SoftDevice.create(phone.device.id)).publicKey() },
    });
  expect((await registerAt(headers)).statusCode).toBe(200);
  // The same cookie under the daemon's other names: a plain cookie now.
  expect((await registerAt(tailnet)).statusCode).toBe(409);
  expect((await registerAt(headers)).statusCode).toBe(409);
  // A restart keeps that (sessions.json).
  await stopAuthServer(server);
  server = await startAuthServer(dist.staticDir, { configDir });
  expect((await registerAt(tailnet)).statusCode).toBe(409);
  expect((await registerAt(headers)).statusCode).toBe(409);
});

it('a bad moveUsed never makes sessions.json unreadable, and a move session without a valid flag counts as used', async () => {
  const [phone] = await ownerState(['iPhone · Chrome'], false);
  const moved = `cld_session=${server.auth.createSession('move', 'iPhone · Chrome', phone.device.id).id}`;
  await stopAuthServer(server);
  // The device's key at an old address, so only the flag can refuse the move's cookie.
  const devicesFile = path.join(configDir, 'devices.json');
  const devices = JSON.parse(fs.readFileSync(devicesFile, 'utf8')) as { devices: Array<{ origin: string }> };
  devices.devices[0].origin = 'https://old.example';
  fs.writeFileSync(devicesFile, JSON.stringify(devices));
  const sessionsFile = path.join(configDir, 'sessions.json');
  const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8')) as { sessions: Array<Record<string, unknown>> };
  data.sessions.forEach((s, i) => (s.moveUsed = [null, 'yes', 1][i % 3]));
  fs.writeFileSync(sessionsFile, JSON.stringify(data));
  server = await startAuthServer(dist.staticDir, { configDir });
  for (const cookie of [phone.cookie, moved])
    expect((await call({ cookie }, 'GET', '/api/auth/me')).statusCode).toBe(200);
  const register = await call({ cookie: moved }, 'POST', '/api/auth/device', {
    deviceId: phone.device.id,
    publicKey: await (await SoftDevice.create(phone.device.id)).publicKey(),
  });
  expect(register.statusCode).toBe(409);
});

// ── S1 ──────────────────────────────────────────────────────────

it('nonces of logged-in sessions count per session: one busy page behind an address does not block another', async () => {
  const [windows, phone] = await ownerState(['Windows · Chrome', 'iPhone · Chrome'], false);
  // Many terminal panes re-proving after a restart: more than the per-address 10.
  for (let i = 0; i < 29; i++) expect((await nonceFor(windows)).statusCode).toBe(200);
  expect((await keyStepUp(windows)).statusCode).toBe(200); // the 30th
  expect((await nonceFor(windows)).statusCode).toBe(429);
  // The phone behind the same address (hairpin NAT) is not affected.
  expect((await keyStepUp(phone)).statusCode).toBe(200);
  // The busy session's block is on the record.
  server.auth.audit.flush();
  expect(auditLines().filter((l) => l.kind === 'stepUpFailed')).toEqual([
    expect.objectContaining({ device: expect.objectContaining({ id: windows.device.id }) }),
  ]);
  // Without a session: per address, as before.
  for (let i = 0; i < 10; i++) expect((await nonceFor()).statusCode).toBe(200);
  expect((await nonceFor()).statusCode).toBe(429);
  expect((await keyStepUp(phone)).statusCode).toBe(200);
});

it('only failed proofs count toward the per-address block of key step-ups', async () => {
  const [windows, phone] = await ownerState(['Windows · Chrome', 'iPhone · Chrome'], false);
  for (let i = 0; i < 12; i++) expect((await keyStepUp(phone)).statusCode).toBe(200);
  const stranger = await SoftDevice.create();
  for (let i = 0; i < 10; i++) expect((await keyStepUp(windows, stranger)).statusCode).toBe(403);
  expect((await keyStepUp(phone)).statusCode).toBe(429);
});

// ── A key proof under 필수 ───────────────────────────────────────

it('필수 on with no passkey: a key proof taken before the first passkey proves nothing after it', async () => {
  const [phone] = await ownerState(['iPhone · Chrome'], true);
  expect((await keyStepUp(phone)).statusCode).toBe(200);
  expect((await registerPasskey(phone, new SoftAuthenticator())).statusCode).toBe(200);
  // A stolen cookie with that proof: deleting the row (and its passkey) would leave 필수 on with none.
  expect((await call(phone, 'DELETE', `/api/auth/sessions/${phone.device.id}`)).json()).toEqual({ error: 'stepup' });
  expect((await call(phone, 'POST', '/api/auth/device-code')).json()).toEqual({ error: 'stepup' });
  expect((await call(phone, 'GET', '/api/auth/passkeys')).json().passkeys).toHaveLength(1);
});

it('a key proof taken while 필수 was off proves nothing once 필수 goes on', async () => {
  const [phone, windows] = await ownerState(['iPhone · Chrome', 'Windows · Chrome'], false);
  expect((await keyStepUp(windows)).statusCode).toBe(200);
  const faceId = new SoftAuthenticator();
  expect((await keyStepUp(phone)).statusCode).toBe(200);
  expect((await registerPasskey(phone, faceId)).statusCode).toBe(200);
  expect((await passkeyStepUp(phone, faceId)).statusCode).toBe(200);
  expect((await call(phone, 'POST', '/api/auth/settings', { passkeyRequired: true })).json()).toEqual({
    passkeyRequired: true,
  });
  // Windows' proof is still inside its 120 s, but it was a key's.
  expect((await call(windows, 'DELETE', `/api/auth/sessions/${phone.device.id}`)).json()).toEqual({ error: 'stepup' });
  expect((await call(windows, 'GET', '/api/auth/passkeys')).json().passkeys).toHaveLength(1);
  // The phone's own proof was a passkey tap: it still counts.
  expect((await call(phone, 'POST', '/api/auth/device-code')).statusCode).toBe(200);
});

it('the check alone: a key proof is refused under 필수 even when 필수 came on without clearing proofs', async () => {
  const [phone, windows] = await ownerState(['iPhone · Chrome', 'Windows · Chrome'], false);
  expect((await keyStepUp(windows)).statusCode).toBe(200);
  expect((await keyStepUp(phone)).statusCode).toBe(200);
  expect((await registerPasskey(phone, new SoftAuthenticator())).statusCode).toBe(200);
  // On behind the routes' back (no dropKeyProofs): stepUpFresh alone must refuse the key proof.
  server.auth.devices!.setPasskeyRequired(true);
  expect((await call(windows, 'DELETE', `/api/auth/sessions/${phone.device.id}`)).json()).toEqual({ error: 'stepup' });
});

it('the clearing alone: a key proof taken before 필수 does not come back when 필수 goes off again', async () => {
  const [phone, windows] = await ownerState(['iPhone · Chrome', 'Windows · Chrome'], false);
  expect((await keyStepUp(windows)).statusCode).toBe(200);
  const faceId = new SoftAuthenticator();
  expect((await keyStepUp(phone)).statusCode).toBe(200);
  expect((await registerPasskey(phone, faceId)).statusCode).toBe(200);
  expect((await passkeyStepUp(phone, faceId)).statusCode).toBe(200);
  expect((await call(phone, 'POST', '/api/auth/settings', { passkeyRequired: true })).statusCode).toBe(200);
  // The host token turns it off inside Windows' 120 s: the key no longer bound, but its old proof is gone.
  const off = await server.app.inject({
    method: 'POST',
    url: '/api/auth/settings',
    headers: { host: 'localhost:18240', authorization: `Bearer ${TOKEN}` },
    payload: { passkeyRequired: false },
  });
  expect(off.json()).toEqual({ passkeyRequired: false });
  expect((await call(windows, 'DELETE', `/api/auth/sessions/${phone.device.id}`)).json()).toEqual({ error: 'stepup' });
});

it('no passkey anywhere: the key still steps up under 필수 (the recovery)', async () => {
  const [phone] = await ownerState(['iPhone · Chrome'], true);
  expect((await keyStepUp(phone)).statusCode).toBe(200);
  expect((await call(phone, 'POST', '/api/auth/device-code')).statusCode).toBe(200);
});

// ── Signing out by a session handle ─────────────────────────────

it("signing out by a session handle counts the passkeys of the device it resolves to", async () => {
  const [phone] = await ownerState(['iPhone · Chrome'], false);
  const faceId = new SoftAuthenticator();
  expect((await keyStepUp(phone)).statusCode).toBe(200);
  expect((await registerPasskey(phone, faceId)).statusCode).toBe(200);
  expect((await passkeyStepUp(phone, faceId)).statusCode).toBe(200);
  expect((await call(phone, 'POST', '/api/auth/settings', { passkeyRequired: true })).statusCode).toBe(200);
  // The device row is gone (pruned) but its passkey is still tied to it; a session of it, no proof.
  server.auth.devices!.remove(phone.device.id);
  const left = server.auth.createSession('short', 'iPhone · Chrome', phone.device.id);
  const who = { cookie: `cld_session=${left.id}` };
  // Its row is its handle: "its own", but revoking it ends the passkey -- under 필수 a step-up.
  expect((await call(who, 'DELETE', `/api/auth/sessions/${left.handle}`)).json()).toEqual({ error: 'stepup' });
  expect(server.auth.passkeys!.countFor(phone.device.id)).toBe(1);
});

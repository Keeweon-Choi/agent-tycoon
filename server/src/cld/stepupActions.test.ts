/**
 * S1: every dangerous action wants a fresh step-up (the shell gate's proof and
 * window), not just a session cookie. Cookie-only: refused, nothing changed;
 * after a step-up: allowed; after the window: refused again.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type AuthServer,
  funnel,
  makeFakeDist,
  proveSession,
  SoftAuthenticator,
  SoftDevice,
  startAuthServer,
  stopAuthServer,
  TOKEN,
} from './authTestKit.js';
import { SHELL_PROOF_MS } from './shell/gate.js';

const ORIGIN = 'https://office.tail0000.ts.net';
const dist = makeFakeDist();
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));

let server: AuthServer;
let configDir: string;
beforeEach(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-s1-'));
  server = await startAuthServer(dist.staticDir, { configDir });
});
afterEach(async () => {
  await stopAuthServer(server);
  fs.rmSync(configDir, { recursive: true, force: true });
});

const login = (label = 'Phone') => {
  const id = server.auth.createSession('short', label).id;
  return { id, cookie: `cld_session=${id}` };
};
const call = (who: { cookie: string }, method: 'POST' | 'DELETE', url: string, payload?: object) =>
  server.app.inject({
    method,
    url,
    headers: { ...funnel(), cookie: who.cookie, origin: ORIGIN },
    payload,
  });
const age = (who: { id: string }, ms: number) => {
  server.auth.session(who.id)!.shellProofAt = Date.now() - ms;
};
const STEPUP = { error: 'stepup' };

describe('device invite', () => {
  it('a cookie alone cannot mint a code; a step-up can, for the window only', async () => {
    const who = login();
    const refused = await call(who, 'POST', '/api/auth/device-code');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual(STEPUP);
    proveSession(server.auth, who.cookie);
    expect((await call(who, 'POST', '/api/auth/device-code')).json().code).toMatch(/^\d{8}$/);
    age(who, SHELL_PROOF_MS + 1_000);
    expect((await call(who, 'POST', '/api/auth/device-code')).json()).toEqual(STEPUP);
  });

  it("the host's Bearer token still mints login codes", async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/login-code',
      headers: { authorization: `Bearer ${TOKEN}`, host: 'localhost:18240' },
      payload: { short: true },
    });
    expect(res.statusCode).toBe(200);
  });

  it('the real step-up (a device key signature) opens it, with the terminal opt-in off', async () => {
    const device = await SoftDevice.create();
    const origin = 'http://localhost:18240';
    const headers = { host: 'localhost:18240', origin };
    server.auth.devices!.register(device.id, await device.publicKey(), origin, 'Laptop', false);
    const session = server.auth.createSession('link', 'Laptop', device.id);
    const cookie = `cld_session=${session.id}`;
    const invite = () =>
      server.app.inject({
        method: 'POST',
        url: '/api/auth/device-code',
        headers: { ...headers, cookie },
      });
    expect((await invite()).json()).toEqual(STEPUP);
    const nonce = (
      await server.app.inject({ method: 'GET', url: '/login/device/challenge', headers })
    ).json().nonce as string;
    const proof = await server.app.inject({
      method: 'POST',
      url: '/api/auth/stepup/device',
      headers: { ...headers, cookie },
      payload: { deviceId: device.id, nonce, signature: await device.sign(nonce) },
    });
    expect(proof.statusCode).toBe(200);
    expect((await invite()).statusCode).toBe(200);
  });
});

describe('device revoke and "sign out all other devices"', () => {
  it('revoking another device asks; the target stays signed in until it is proven', async () => {
    const actor = login('Laptop');
    const target = login('Phone');
    const row = server.auth.rowId(server.auth.session(target.id)!);
    const refused = await call(actor, 'DELETE', `/api/auth/sessions/${row}`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual(STEPUP);
    expect(server.auth.validSession(target.id)).toBe(true);
    proveSession(server.auth, actor.cookie);
    expect((await call(actor, 'DELETE', `/api/auth/sessions/${row}`)).statusCode).toBe(200);
    expect(server.auth.validSession(target.id)).toBe(false);
  });

  it('signing this device out needs no step-up', async () => {
    const actor = login();
    const row = server.auth.rowId(server.auth.session(actor.id)!);
    expect((await call(actor, 'DELETE', `/api/auth/sessions/${row}`)).statusCode).toBe(200);
    expect(server.auth.validSession(actor.id)).toBe(false);
  });

  it('sign out all others: refused on a cookie alone and after the window, nothing signed out', async () => {
    const actor = login('Laptop');
    const other = login('Phone');
    expect((await call(actor, 'POST', '/api/auth/sessions/revoke-others')).json()).toEqual(STEPUP);
    expect(server.auth.validSession(other.id)).toBe(true);
    proveSession(server.auth, actor.cookie);
    age(actor, SHELL_PROOF_MS + 1_000);
    expect((await call(actor, 'POST', '/api/auth/sessions/revoke-others')).json()).toEqual(STEPUP);
    expect(server.auth.validSession(other.id)).toBe(true);
    age(actor, 5_000);
    expect((await call(actor, 'POST', '/api/auth/sessions/revoke-others')).json()).toEqual({
      count: 1,
    });
    expect(server.auth.validSession(other.id)).toBe(false);
  });
});

describe('passkey add and delete', () => {
  const key = new SoftAuthenticator();
  const register = async (who: { cookie: string }) => {
    const begin = await call(who, 'POST', '/api/auth/passkeys/options');
    if (begin.statusCode !== 200) return begin;
    const { ceremony, options } = begin.json();
    return call(who, 'POST', '/api/auth/passkeys', {
      ceremony,
      response: key.register(options, ORIGIN),
      name: 'iPhone',
    });
  };

  it('adding: refused on a cookie alone (both steps), allowed after a step-up', async () => {
    const who = login();
    const refused = await register(who);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual(STEPUP);
    // Even with a ceremony in hand from before, the finish step asks too.
    proveSession(server.auth, who.cookie);
    const begin = (await call(who, 'POST', '/api/auth/passkeys/options')).json();
    age(who, SHELL_PROOF_MS + 1_000);
    const finish = await call(who, 'POST', '/api/auth/passkeys', {
      ceremony: begin.ceremony,
      response: key.register(begin.options, ORIGIN),
      name: 'iPhone',
    });
    expect(finish.json()).toEqual(STEPUP);
    expect(server.auth.passkeys!.list()).toHaveLength(0);
    proveSession(server.auth, who.cookie);
    expect((await register(who)).statusCode).toBe(200);
    expect(server.auth.passkeys!.list()).toHaveLength(1);
  });

  it('deleting: refused on a cookie alone, the passkey stays; allowed after a step-up', async () => {
    const who = login();
    proveSession(server.auth, who.cookie);
    expect((await register(who)).statusCode).toBe(200);
    const [{ id }] = server.auth.passkeys!.list();
    age(who, SHELL_PROOF_MS + 1_000);
    const refused = await call(who, 'DELETE', `/api/auth/passkeys/${id}`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual(STEPUP);
    expect(server.auth.passkeys!.list()).toHaveLength(1);
    proveSession(server.auth, who.cookie);
    expect((await call(who, 'DELETE', `/api/auth/passkeys/${id}`)).statusCode).toBe(200);
    expect(server.auth.passkeys!.list()).toHaveLength(0);
  });
});

describe('adding a device the other ways', () => {
  it('a move code asks', async () => {
    const device = await SoftDevice.create();
    server.auth.devices!.register(device.id, await device.publicKey(), ORIGIN, 'Laptop', false);
    const session = server.auth.createSession('link', 'Laptop', device.id);
    const mover = { id: session.id, cookie: `cld_session=${session.id}` };
    expect((await call(mover, 'POST', '/api/auth/move-code')).json()).toEqual(STEPUP);
    proveSession(server.auth, mover.cookie);
    expect((await call(mover, 'POST', '/api/auth/move-code')).statusCode).not.toBe(403);
  });
});

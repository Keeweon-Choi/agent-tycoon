/**
 * O1: the "기기 추가" invitation as its issuer follows it -- status, cancel,
 * and the new device's nickname. Issuing and naming need the S1 step-up;
 * status and cancel need only the session that issued the invitation.
 * Nothing here ever returns or logs a code.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validNickname } from './auth.js';
import {
  type AuthServer,
  funnel,
  makeFakeDist,
  proveSession,
  SoftDevice,
  startAuthServer,
  stopAuthServer,
} from './authTestKit.js';
import { SHELL_PROOF_MS } from './shell/gate.js';

const ORIGIN = 'https://office.tail0000.ts.net';
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const dist = makeFakeDist();
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));

let server: AuthServer;
let configDir: string;
beforeEach(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-o1-'));
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
const proven = (label?: string) => {
  const who = login(label);
  proveSession(server.auth, who.cookie);
  return who;
};
const call = (
  who: { cookie?: string },
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
) =>
  server.app.inject({
    method,
    url,
    headers: { ...funnel(), ...(who.cookie ? { cookie: who.cookie } : {}), origin: ORIGIN },
    payload,
  });
/** The inviting device asks for a code. */
const invite = async (who: { cookie: string }) =>
  (await call(who, 'POST', '/api/auth/device-code')).json() as {
    code: string;
    link: string;
    id: string;
  };
/** The new device opens the link (or types the code); the cookie it got, if any. */
const open = async (code: string, userAgent = WINDOWS_UA) => {
  const res = await server.app.inject({
    method: 'GET',
    url: `/login?code=${encodeURIComponent(code)}`,
    headers: { ...funnel('203.0.113.9'), 'user-agent': userAgent },
  });
  return { status: res.statusCode, cookie: res.headers['set-cookie'] };
};
const linkCode = (link: string) => new URL(link).searchParams.get('code')!;
const status = (who: { cookie?: string }, id: string) => call(who, 'GET', `/api/auth/device-invite/${id}`);
const cancel = (who: { cookie?: string }, id: string) =>
  call(who, 'POST', `/api/auth/device-invite/${id}/cancel`);
const rename = (who: { cookie?: string }, id: string, name: unknown) =>
  call(who, 'POST', `/api/auth/device-invite/${id}/nickname`, { name });

describe('cancel', () => {
  it('makes both the link and the typed code unusable at once, and twice is fine', async () => {
    const who = proven();
    const a = await invite(who);
    expect((await cancel(who, a.id)).json()).toEqual({ ok: true, state: 'cancelled' });
    expect((await cancel(who, a.id)).json()).toEqual({ ok: true, state: 'cancelled' });
    expect((await open(linkCode(a.link))).status).toBe(401);
    expect((await open(a.code)).status).toBe(401);
    expect((await status(who, a.id)).json()).toEqual({ state: 'cancelled' });
    // The other invitation was not touched.
    const b = await invite(who);
    expect((await open(linkCode(b.link))).status).toBe(303);
  });

  it('cancelling after the code was used keeps the device it registered', async () => {
    const who = proven();
    const a = await invite(who);
    expect((await open(a.code)).status).toBe(303);
    // The answer says so: the screen must not claim a cancel that did not happen.
    expect((await cancel(who, a.id)).json()).toEqual({
      ok: true,
      state: 'registered',
      device: { label: 'Windows · Chrome' },
    });
    expect((await status(who, a.id)).json().state).toBe('registered');
  });

  it('only the issuing session can cancel; a stranger gets the same 404 as an unknown id', async () => {
    const who = proven();
    const other = proven('Other');
    const a = await invite(who);
    expect((await cancel(other, a.id)).statusCode).toBe(404);
    expect((await cancel(who, 'nope')).statusCode).toBe(404);
    expect((await open(linkCode(a.link))).status).toBe(303);
  });
});

describe('privilege', () => {
  it('status, cancel and rename refuse a caller with no session', async () => {
    const who = proven();
    const a = await invite(who);
    expect((await open(a.code)).status).toBe(303);
    for (const res of [
      await status({}, a.id),
      await cancel({}, a.id),
      await rename({}, a.id, 'Laptop'),
    ])
      expect(res.statusCode).toBe(401);
    const ok = await status(who, a.id);
    expect(ok.json().state).toBe('registered');
    expect(ok.body).not.toContain(a.code);
  });

  it('status and cancel need the issuing session, not a fresh step-up: they work after the window lapsed', async () => {
    const who = proven();
    const a = await invite(who);
    server.auth.session(who.id)!.shellProofAt = Date.now() - SHELL_PROOF_MS - 1_000;
    expect((await status(who, a.id)).json()).toEqual({ state: 'pending' });
    expect((await cancel(who, a.id)).json()).toEqual({ ok: true, state: 'cancelled' });
    expect((await status(who, a.id)).json()).toEqual({ state: 'cancelled' });
  });

  it("another session -- with or without a step-up -- gets the unknown id's 404 from status and cancel", async () => {
    const who = proven();
    const a = await invite(who);
    for (const other of [proven('Other'), login('Cookie only')]) {
      expect((await status(other, a.id)).statusCode).toBe(404);
      expect((await cancel(other, a.id)).statusCode).toBe(404);
    }
    expect((await status(who, a.id)).json()).toEqual({ state: 'pending' });
    expect((await open(linkCode(a.link))).status).toBe(303);
  });

  it('rename still wants a fresh step-up: a cookie alone, or a lapsed window, is refused and nothing changes', async () => {
    const who = proven();
    const a = await invite(who);
    await open(a.code);
    server.auth.session(who.id)!.shellProofAt = Date.now() - SHELL_PROOF_MS - 1_000;
    const refused = await rename(who, a.id, 'Laptop');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'stepup' });
    expect((await status(who, a.id)).json().device).toEqual({ label: 'Windows · Chrome' });
    proveSession(server.auth, who.cookie);
    expect((await rename(who, a.id, 'Laptop')).statusCode).toBe(200);
  });

  it('a host Bearer token is not a session here', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/auth/device-invite/x',
      headers: { host: 'localhost:18240', authorization: 'Bearer test-server-token' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('status', () => {
  it('is pending, then registered with the device label after a registration with that code', async () => {
    const who = proven();
    const a = await invite(who);
    expect((await status(who, a.id)).json()).toEqual({ state: 'pending' });
    expect((await open(a.code)).status).toBe(303);
    expect((await status(who, a.id)).json()).toEqual({
      state: 'registered',
      device: { label: 'Windows · Chrome' },
    });
  });

  it('is invisible to another session, and expiry shows as expired', async () => {
    const who = proven();
    const other = proven('Other');
    const a = await invite(who);
    expect((await status(other, a.id)).statusCode).toBe(404);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 6 * 60_000);
      expect((await status(who, a.id)).json()).toEqual({ state: 'expired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never carries a device secret: a registered device shows a label and nothing else', async () => {
    const who = proven();
    const a = await invite(who);
    await open(a.code);
    const keys = Object.keys((await status(who, a.id)).json().device);
    expect(keys).toEqual(['label']);
  });
});

describe('nickname', () => {
  it('names the device in the device list, before and after its key registers', async () => {
    const who = proven();
    const a = await invite(who);
    const got = await open(a.code);
    expect((await rename(who, a.id, '  Laptop  ')).json()).toEqual({ ok: true, name: 'Laptop' });
    const rows = () =>
      server.auth.listSessions(who.id).map((r) => ({ label: r.label, current: r.current }));
    expect(rows()).toContainEqual({ label: 'Laptop', current: false });
    expect((await status(who, a.id)).json().device).toEqual({
      label: 'Windows · Chrome',
      nickname: 'Laptop',
    });

    // The new device's key registers afterwards: the nickname follows it.
    const newCookie = String(got.cookie).split(';')[0];
    const device = await SoftDevice.create();
    const reg = await server.app.inject({
      method: 'POST',
      url: '/api/auth/device',
      headers: { ...funnel('203.0.113.9'), cookie: newCookie, origin: ORIGIN },
      payload: { deviceId: device.id, publicKey: await device.publicKey() },
    });
    expect(reg.statusCode).toBe(200);
    expect(server.auth.devices!.get(device.id)?.nickname).toBe('Laptop');
    expect(rows().filter((r) => r.label === 'Laptop')).toHaveLength(1);
    // Renamed again once it is a device row.
    expect((await rename(who, a.id, 'Desk')).statusCode).toBe(200);
    expect(server.auth.devices!.get(device.id)?.nickname).toBe('Desk');
  });

  it('refuses a nickname that is empty, too long or has control characters', async () => {
    const who = proven();
    const a = await invite(who);
    await open(a.code);
    for (const bad of ['', '   ', 'x'.repeat(41), 'a\nb', 'a\u0007b', 42, null])
      expect((await rename(who, a.id, bad)).statusCode).toBe(400);
    expect((await rename(who, a.id, '가'.repeat(40))).statusCode).toBe(200);
  });

  it('is 404 before anyone used the code, and for another session', async () => {
    const who = proven();
    const other = proven('Other');
    const a = await invite(who);
    expect((await rename(who, a.id, 'Laptop')).statusCode).toBe(404);
    await open(a.code);
    expect((await rename(other, a.id, 'Laptop')).statusCode).toBe(404);
  });

  it('validNickname refuses bidi controls, isolates, zero-width characters, separators and BOM', () => {
    const hidden = [
      '\u061c',
      ...'\u200b\u200c\u200d\u200e\u200f',
      ...'\u2028\u2029\u202a\u202b\u202c\u202d\u202e',
      ...'\u2066\u2067\u2068\u2069',
      '\ufeff',
    ];
    for (const ch of hidden) {
      expect(validNickname(`a${ch}b`), ch.codePointAt(0)!.toString(16)).toBeNull();
      expect(validNickname(`${ch}ab`), ch.codePointAt(0)!.toString(16)).toBeNull();
    }
    expect(validNickname('노트북 2')).toBe('노트북 2');
  });

  it('validNickname trims and counts characters', () => {
    expect(validNickname(' a ')).toBe('a');
    expect(validNickname('😀'.repeat(40))).not.toBeNull();
    expect(validNickname('😀'.repeat(41))).toBeNull();
  });
});

describe('logs', () => {
  it('no log line carries a code or a link', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.join(' '))),
    );
    try {
      const who = proven();
      const a = await invite(who);
      await status(who, a.id);
      await open(a.code);
      await rename(who, a.id, 'Laptop');
      await cancel(who, a.id);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const all = lines.join('\n');
    const a = await invite(proven());
    expect(all).not.toMatch(/\d{8}/);
    expect(all).not.toContain('code=');
    expect(a.id).toBeTruthy();
  });
});

describe('lifetime of an invitation', () => {
  it('issuing past the cap evicts the oldest invitation together with its codes', async () => {
    const who = proven();
    const first = await invite(who);
    for (let i = 0; i < 200; i++) server.auth.createDeviceCodes(server.auth.session(who.id)!);
    expect((await status(who, first.id)).statusCode).toBe(404);
    expect((await open(linkCode(first.link))).status).toBe(401);
    expect((await open(first.code)).status).toBe(401);
    // A recent one still works.
    const recent = await invite(who);
    expect((await open(linkCode(recent.link))).status).toBe(303);
  });

  it('a pending invitation dies with the session that issued it', async () => {
    const who = proven();
    const other = proven('Other');
    const a = await invite(who);
    const b = await invite(other);
    server.auth.revoke(server.auth.rowId(server.auth.session(who.id)!));
    expect(server.auth.validSession(who.id)).toBe(false);
    expect((await open(linkCode(a.link))).status).toBe(401);
    expect((await open(a.code)).status).toBe(401);
    // Someone else's invitation is not touched.
    expect((await open(linkCode(b.link))).status).toBe(303);
  });

  it('a session that expires takes its pending invitation with it', async () => {
    const who = proven();
    const a = await invite(who);
    server.auth.session(who.id)!.expiresAt = Date.now() - 1;
    expect(server.auth.session(who.id)).toBeUndefined();
    expect((await open(a.code)).status).toBe(401);
  });

  it('issuing sweeps expired codes out of memory', async () => {
    const who = proven();
    const codes = () => (server.auth as unknown as { codes: Map<string, unknown> }).codes;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let i = 0; i < 20; i++) await invite(who);
      expect(codes().size).toBe(40);
      vi.setSystemTime(Date.now() + 6 * 60_000);
      proveSession(server.auth, who.cookie);
      await invite(who);
      expect(codes().size).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

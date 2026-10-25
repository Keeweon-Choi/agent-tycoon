/**
 * T-0022 update (10-21 22:3x): the short typed code is the primary login.
 * 8 digits, 5 minutes, single use, spaces ignored; per client, per code and a
 * global lock (20 failures in 10 minutes lock short codes for 10 minutes)
 * that leaves QR links alone.
 */
import * as fs from 'fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { formatShortCode, isShortCode, StandaloneAuth } from './auth.js';
import {
  type AuthServer,
  cookieOf,
  formLogin,
  funnel,
  HOST,
  makeFakeDist,
  proveSession,
  startAuthServer,
  stopAuthServer,
  TOKEN,
} from './authTestKit.js';

let dist: { root: string; staticDir: string };
beforeAll(() => {
  dist = makeFakeDist();
});
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));

describe('short codes in StandaloneAuth', () => {
  afterEach(() => vi.useRealTimers());

  it('issues 8 random digits for 5 minutes, used once, typed with spaces', () => {
    const auth = new StandaloneAuth();
    const { code, expiresIn } = auth.createLoginCode('short');
    expect(code).toMatch(/^\d{8}$/);
    expect(expiresIn).toBe(300);
    expect(isShortCode(formatShortCode(code))).toBe(true);
    const session = auth.login(` ${formatShortCode(code)} `, 'iPhone · Safari');
    expect(session?.method).toBe('short');
    expect(session?.label).toBe('iPhone · Safari');
    expect(auth.login(code)).toBeNull();
  });

  it('expires after 5 minutes', () => {
    vi.useFakeTimers();
    const auth = new StandaloneAuth();
    const { code } = auth.createLoginCode('short');
    vi.advanceTimersByTime(5 * 60_000);
    expect(auth.login(code)).toBeNull();
  });

  it('keeps a QR code 10 minutes and a link code 60 s', () => {
    vi.useFakeTimers();
    const auth = new StandaloneAuth();
    const qr = auth.createLoginCode('qr');
    const lateQr = auth.createLoginCode('qr');
    const link = auth.createLoginCode('link');
    expect(qr.expiresIn).toBe(600);
    expect(link.expiresIn).toBe(60);
    vi.advanceTimersByTime(60_000);
    expect(auth.login(link.code)).toBeNull();
    vi.advanceTimersByTime(9 * 60_000 - 1);
    expect(auth.login(qr.code)?.method).toBe('qr');
    vi.advanceTimersByTime(1);
    expect(auth.login(lateQr.code)).toBeNull();
  });

  it('gives different codes', () => {
    const auth = new StandaloneAuth();
    const codes = new Set(Array.from({ length: 200 }, () => auth.createLoginCode('short').code));
    expect(codes.size).toBe(200);
  });

  it('"기기 추가": one invitation, one use -- QR then 8 digits is refused', () => {
    const auth = new StandaloneAuth();
    const invite = auth.createDeviceCodes();
    expect(auth.login(invite.link)?.method).toBe('qr');
    expect(auth.login(invite.link)).toBeNull();
    expect(auth.login(invite.short)).toBeNull();
    expect(auth.listSessions(undefined).map((s) => s.method)).toEqual(['qr']);
  });

  it('"기기 추가": one invitation, one use -- 8 digits then QR is refused', () => {
    const auth = new StandaloneAuth();
    const invite = auth.createDeviceCodes();
    expect(auth.login(invite.short)?.method).toBe('short');
    expect(auth.login(invite.link)).toBeNull();
    expect(auth.login(invite.short)).toBeNull();
    // Another invitation is its own credential.
    const next = auth.createDeviceCodes();
    expect(auth.login(next.link)?.method).toBe('qr');
  });

  it('"기기 추가": both codes expire together after 5 minutes', () => {
    vi.useFakeTimers();
    const auth = new StandaloneAuth();
    const unused = auth.createDeviceCodes();
    vi.advanceTimersByTime(5 * 60_000);
    expect(auth.login(unused.link)).toBeNull();
    expect(auth.login(unused.short)).toBeNull();
  });

  it('a lone QR code or short code (no invitation) is untouched by the partner rule', () => {
    const auth = new StandaloneAuth();
    const qr = auth.createLoginCode('qr');
    const short = auth.createLoginCode('short');
    expect(auth.login(qr.code)?.method).toBe('qr');
    expect(auth.login(short.code)?.method).toBe('short');
  });

  describe('handoff code (S3)', () => {
    const qrSession = (auth: StandaloneAuth) => {
      const session = auth.login(auth.createDeviceCodes().link)!;
      return auth.session(session.id)!;
    };

    it('is 8 digits for 2 minutes, works once, and is a session of its own', () => {
      vi.useFakeTimers();
      const auth = new StandaloneAuth();
      const safari = qrSession(auth);
      const { code, expiresIn } = auth.createHandoffCode(safari)!;
      expect(code).toMatch(/^\d{8}$/);
      expect(expiresIn).toBe(120);
      const app = auth.login(formatShortCode(code), 'iPhone · Home Screen');
      expect(app?.method).toBe('handoff');
      expect(app?.hash).not.toBe(safari.hash);
      expect(auth.login(code)).toBeNull();
    });

    it('is refused after 2 minutes', () => {
      vi.useFakeTimers();
      const auth = new StandaloneAuth();
      const { code } = auth.createHandoffCode(qrSession(auth))!;
      vi.advanceTimersByTime(2 * 60_000);
      expect(auth.login(code)).toBeNull();
    });

    it('a new ask replaces the last code; the old one is refused', () => {
      const auth = new StandaloneAuth();
      const safari = qrSession(auth);
      const first = auth.createHandoffCode(safari)!;
      const second = auth.createHandoffCode(safari)!;
      expect(auth.login(first.code)).toBeNull();
      expect(auth.login(second.code)?.method).toBe('handoff');
    });

    it('only a session a QR just logged in may ask: not a typed code, not an old QR session', () => {
      vi.useFakeTimers();
      const auth = new StandaloneAuth();
      expect(auth.createHandoffCode(auth.login(auth.createDeviceCodes().short)!)).toBeNull();
      expect(auth.createHandoffCode(auth.createSession('passkey'))).toBeNull();
      const safari = qrSession(auth);
      expect(auth.mayHandoff(safari)).toBe(true);
      vi.advanceTimersByTime(10 * 60_000 + 1);
      expect(auth.mayHandoff(safari)).toBe(false);
      expect(auth.createHandoffCode(safari)).toBeNull();
    });

    it('dies with the Safari session that asked for it', () => {
      const auth = new StandaloneAuth();
      const safari = qrSession(auth);
      const { code } = auth.createHandoffCode(safari)!;
      auth.revoke(safari.handle);
      expect(auth.login(code)).toBeNull();
    });
  });
});

describe('short-code login over HTTP', () => {
  let server: AuthServer | undefined;

  afterEach(async () => {
    await stopAuthServer(server);
    server = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function start(): Promise<AuthServer> {
    server = await startAuthServer(dist.staticDir);
    return server;
  }

  it('logs in with the login form, "1234 5678" style, and a cookie for the app', async () => {
    const { app, auth } = await start();
    const { code } = auth.createLoginCode('short');
    const res = await app.inject(formLogin(formatShortCode(code)));
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/');
    const cookie = cookieOf(res.headers['set-cookie']);
    expect((await app.inject({ url: '/', headers: { ...funnel(), cookie } })).statusCode).toBe(200);
    // Single use.
    expect((await app.inject(formLogin(code))).statusCode).toBe(401);
  });

  it('accepts a short code in a link too', async () => {
    const { app, auth } = await start();
    const { code } = auth.createLoginCode('short');
    const spaced = encodeURIComponent(formatShortCode(code));
    const res = await app.inject({ url: `/login?code=${spaced}`, headers: funnel() });
    expect(res.statusCode).toBe(303);
  });

  it('answers every failure with the identical 401', async () => {
    // Only the clock: light-my-request streams POST bodies through real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, auth } = await start();
    const used = auth.createLoginCode('short').code;
    await app.inject(formLogin(used, funnel('198.51.100.1')));
    const expired = auth.createLoginCode('short').code;
    vi.advanceTimersByTime(5 * 60_000 + 1);
    const answers = await Promise.all(
      ['00000000', '1234 5678', expired, used, 'not-a-code'].map((code, i) =>
        app.inject(formLogin(code, funnel(`198.51.100.${10 + i}`))),
      ),
    );
    expect(answers.map((r) => r.statusCode)).toEqual([401, 401, 401, 401, 401]);
    expect(new Set(answers.map((r) => r.body)).size).toBe(1);
    expect(answers[0].body).toContain('코드가 맞지 않거나 만료됐어요');
  });

  it('blocks one client after 10 failures, and one code tried from 10 clients', async () => {
    const { app, auth } = await start();
    for (let i = 0; i < 10; i++)
      expect(
        (await app.inject(formLogin(`1111 00${String(i).padStart(2, '0')}`, funnel('203.0.113.1'))))
          .statusCode,
      ).toBe(401);
    const { code } = auth.createLoginCode('short');
    const blocked = await app.inject(formLogin(code, funnel('203.0.113.1')));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toContain('잠시 후 다시 시도하세요');
    // Not consumed: it still works from another client.
    expect((await app.inject(formLogin(code, funnel('203.0.113.2')))).statusCode).toBe(303);

    for (let i = 0; i < 10; i++)
      await app.inject(formLogin('2222 3333', funnel(`198.51.100.${i}`)));
    expect((await app.inject(formLogin('2222 3333', funnel('198.51.100.99')))).statusCode).toBe(
      429,
    );
  });

  it('S-18: cross-site fetches with wrong codes lock neither the client nor the short codes', async () => {
    const { app, auth } = await start();
    const attack = { ...funnel('203.0.113.1'), 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' };
    for (let i = 0; i < 25; i++)
      await app.inject({ url: `/login?code=${String(i).padStart(8, '0')}`, headers: attack });
    const { code } = auth.createLoginCode('short');
    // Same client, same link: a typed code and a tapped QR link still log in.
    expect((await app.inject(formLogin(code, funnel('203.0.113.1')))).statusCode).toBe(303);
    const qr = auth.createLoginCode('qr').code;
    const nav = { ...funnel('203.0.113.2'), 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' };
    expect((await app.inject({ url: `/login?code=${qr}`, headers: nav })).statusCode).toBe(303);
  });

  it('S-18: a window another site keeps re-aiming (top-level navigations) locks nothing either', async () => {
    const { app, auth } = await start();
    const nav = { ...funnel('203.0.113.1'), 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    for (let i = 0; i < 25; i++) {
      await app.inject({ url: `/login?code=${String(i).padStart(8, '0')}`, headers: nav });
      await app.inject({ url: `/login?code=wrong-long-code-${i}`, headers: nav });
    }
    // A short code never comes from another site: refused even when right, so it can't be guessed that way.
    const short = auth.createLoginCode('short').code;
    expect((await app.inject({ url: `/login?code=${short}`, headers: nav })).statusCode).toBe(401);
    expect((await app.inject(formLogin(short, funnel('203.0.113.1')))).statusCode).toBe(303);
    // A link handed over from another site (a pasted invite, a move) still logs in.
    const link = auth.createLoginCode('link').code;
    expect((await app.inject({ url: `/login?code=${link}`, headers: nav })).statusCode).toBe(303);
  });

  it('locks short codes for everyone after 20 failures in 10 minutes, but not QR links', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { app, auth } = await start();
    // 20 clients, one wrong guess each: no per-client block is involved.
    for (let i = 0; i < 20; i++)
      expect(
        (
          await app.inject(
            formLogin(`5555 ${String(i).padStart(4, '0')}`, funnel(`203.0.113.${i}`)),
          )
        ).statusCode,
      ).toBe(401);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('short-code login locked'));

    // A fresh client with a valid short code: locked, and the code is kept.
    const short = auth.createLoginCode('short').code;
    const locked = await app.inject(formLogin(short, funnel('198.51.100.50')));
    expect(locked.statusCode).toBe(429);
    expect(locked.body).toContain('잠시 후 다시 시도하세요');

    // QR and link codes keep working during the lock.
    const qr = auth.createLoginCode('qr').code;
    const viaQr = await app.inject({ url: `/login?code=${qr}`, headers: funnel('198.51.100.51') });
    expect(viaQr.statusCode).toBe(303);
    const link = auth.createLoginCode('link').code;
    expect((await app.inject(formLogin(link, funnel('198.51.100.52')))).statusCode).toBe(303);

    // Ten minutes later short codes work again.
    vi.advanceTimersByTime(10 * 60_000 + 1);
    const later = auth.createLoginCode('short').code;
    expect((await app.inject(formLogin(later, funnel('198.51.100.53')))).statusCode).toBe(303);
  });

  it('issues short codes to the host over Bearer, never over Funnel', async () => {
    const { app } = await start();
    const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const res = await app.inject({
      method: 'POST',
      url: '/api/login-code',
      headers: bearer,
      payload: { short: true },
    });
    expect(res.statusCode).toBe(200);
    // `url`: where to type it, the canonical address (T-0024; here the serve name)
    expect(res.json()).toEqual({
      code: expect.stringMatching(/^\d{8}$/),
      expiresIn: 300,
      url: 'https://office.tail0000.ts.net',
    });
    const qr = await app.inject({
      method: 'POST',
      url: '/api/login-code',
      headers: bearer,
      payload: { qr: true },
    });
    expect(qr.json().expiresIn).toBe(600);
    const overFunnel = await app.inject({
      method: 'POST',
      url: '/api/login-code',
      headers: { ...funnel(), ...bearer },
      payload: { short: true },
    });
    expect(overFunnel.statusCode).toBe(401);
  });

  it('gives a logged-in device a code and QR link for the next one ("기기 추가")', async () => {
    const { app, auth } = await start();
    const cookie = proveSession(
      auth,
      `cld_session=${auth.createSession('passkey', 'Mac · Safari').id}`,
    ); // S1: inviting wants a fresh step-up
    const origin = `https://${HOST}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/device-code',
      headers: { ...funnel(), cookie, origin },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ code: string; link: string; expiresIn: number }>();
    expect(body.code).toMatch(/^\d{8}$/);
    expect(body.expiresIn).toBe(300);
    expect(body.link).toMatch(new RegExp(`^https://${HOST}/login\\?code=[\\w-]{32}$`));

    // The new device types the code: logged in, and the QR link is used up.
    expect((await app.inject(formLogin(body.code))).statusCode).toBe(303);
    const qr = await app.inject({ url: new URL(body.link).pathname + new URL(body.link).search });
    expect(qr.statusCode).toBe(401);

    // Not without a session, and not from another origin.
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/auth/device-code',
      headers: { ...funnel(), origin },
    });
    expect(anonymous.statusCode).toBe(401);
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/auth/device-code',
      headers: { ...funnel(), cookie, origin: 'https://other.tail0000.ts.net' },
    });
    expect(crossSite.statusCode).toBe(403);
  });

  it('S3 handoff over HTTP: the Safari page gets a code, nobody else does, the app logs in with it once', async () => {
    const { app, auth } = await start();
    const origin = `https://${HOST}`;
    const invite = auth.createDeviceCodes();
    // The phone's camera opens the QR in Safari.
    const safari = await app.inject({ url: `/login?code=${invite.link}`, headers: funnel() });
    expect(safari.statusCode).toBe(303);
    const safariCookie = cookieOf(safari.headers['set-cookie']);
    // The 8 digits went with the QR.
    expect((await app.inject(formLogin(invite.short))).statusCode).toBe(401);
    const me = await app.inject({ url: '/api/auth/me', headers: { ...funnel(), cookie: safariCookie } });
    expect(me.json().handoff).toBe(true);

    const ask = (cookie: string, extra: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/handoff-code',
        headers: { ...funnel(), cookie, origin, ...extra },
      });
    const got = await ask(safariCookie);
    expect(got.statusCode).toBe(200);
    expect(got.headers['cache-control']).toBe('no-store');
    const { code, expiresIn } = got.json<{ code: string; expiresIn: number }>();
    expect(code).toMatch(/^\d{8}$/);
    expect(expiresIn).toBe(120);

    // Visible only to that page: no other session, no anonymous client, no cross-site page.
    const typed = auth.login(auth.createDeviceCodes().short)!;
    const other = `cld_session=${typed.id}`;
    expect((await ask(other)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/handoff-code', headers: { ...funnel(), origin } })).statusCode).toBe(401);
    expect((await ask(safariCookie, { origin: 'https://other.tail0000.ts.net' })).statusCode).toBe(403);
    const everything = JSON.stringify([
      (await app.inject({ url: '/api/auth/sessions', headers: { ...funnel(), cookie: other } })).body,
      (await app.inject({ url: '/api/auth/me', headers: { ...funnel(), cookie: other } })).body,
    ]);
    expect(everything).not.toContain(code);

    // The Home-Screen app types it: logged in, once.
    const app1 = await app.inject(formLogin(formatShortCode(code)));
    expect(app1.statusCode).toBe(303);
    expect(
      (await app.inject({ url: '/api/auth/me', headers: { ...funnel(), cookie: cookieOf(app1.headers['set-cookie']) } })).json().method,
    ).toBe('handoff');
    expect((await app.inject(formLogin(code))).statusCode).toBe(401);
  });
});


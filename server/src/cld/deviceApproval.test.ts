/**
 * T-0022 new-device approval: off by default; when on, the logged-in device
 * must type the code the new device shows (a tap is never enough), the
 * request carries where it came from, answers are single use and expire.
 */
import * as fs from 'fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
import { isTailscaleAddress } from './deviceApproval.js';

let dist: { root: string; staticDir: string };
beforeAll(() => {
  dist = makeFakeDist();
});
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));

const ORIGIN = `https://${HOST}`;

describe('new-device approval', () => {
  let server: AuthServer | undefined;

  afterEach(async () => {
    await stopAuthServer(server);
    server = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function start(allowApprovalRequests = true): Promise<AuthServer> {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    server = await startAuthServer(dist.staticDir, { allowApprovalRequests });
    return server;
  }

  /** A logged-in device's headers for the session-gated API. */
  function trusted(): Record<string, string> {
    return {
      ...funnel('100.64.0.2'),
      // S1: approving a device wants a fresh step-up
      cookie: proveSession(
        server!.auth,
        `cld_session=${server!.auth.createSession('passkey', 'Mac · Safari').id}`,
      ),
      origin: ORIGIN,
    };
  }

  const ask = (headers: Record<string, string> = funnel('203.0.113.50'), label = '내 노트북') =>
    server!.app.inject({ method: 'POST', url: '/login/approval', headers, payload: { label } });
  const poll = (secret: string, headers: Record<string, string> = funnel('203.0.113.50')) =>
    server!.app.inject({
      method: 'POST',
      url: '/login/approval/poll',
      headers,
      payload: { secret },
    });
  const answer = (id: string, body: Record<string, unknown>, headers = trusted()) =>
    server!.app.inject({
      method: 'POST',
      url: `/api/auth/approvals/${id}`,
      headers,
      payload: body,
    });

  it('is off by default: no button, no routes', async () => {
    const { app } = await start(false);
    expect((await app.inject({ url: '/', headers: funnel() })).body).not.toContain('승인 요청');
    expect((await ask()).statusCode).toBe(404);
    expect((await poll('x')).statusCode).toBe(404);
    const cli = await app.inject({
      method: 'POST',
      url: '/api/device-approval',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { code: '123456' },
    });
    expect(cli.statusCode).toBe(404);
    expect((await app.inject({ url: '/api/auth/approvals', headers: trusted() })).json()).toEqual({
      approvals: [],
    });
  });

  it('approving asks for a fresh step-up (S1); denying does not', async () => {
    const { broadcasts } = await start();
    const { code } = (await ask()).json();
    const [request] = broadcasts.filter((m) => m.type === 'deviceApprovalRequest');
    const bare = { ...trusted(), cookie: `cld_session=${server!.auth.createSession('short', 'Phone').id}` };
    const refused = await answer(String(request.id), { approve: true, code }, bare);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'stepup' });
    expect((await answer(String(request.id), { approve: false }, bare)).json()).toEqual({
      result: 'refused',
    });
    const again = (await ask()).json();
    const [, second] = broadcasts.filter((m) => m.type === 'deviceApprovalRequest');
    expect(
      (await answer(String(second.id), { approve: true, code: again.code })).json(),
    ).toEqual({ result: 'approved' });
  });

  it('approves only with the typed code, once, and logs the new device in', async () => {
    const { app, broadcasts } = await start();
    expect((await app.inject({ url: '/', headers: funnel() })).body).toContain(
      '다른 기기에서 승인 요청',
    );
    const asked = await ask();
    expect(asked.statusCode).toBe(200);
    const { secret, code, expiresIn } = asked.json();
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresIn).toBe(300);

    // The logged-in devices hear where it came from, never the code.
    const [request] = broadcasts.filter((m) => m.type === 'deviceApprovalRequest');
    expect(request).toMatchObject({ label: '내 노트북', ip: '203.0.113.50', network: 'funnel' });
    expect(JSON.stringify(broadcasts)).not.toContain(code);
    const listed = await app.inject({ url: '/api/auth/approvals', headers: trusted() });
    expect(listed.json().approvals).toEqual([expect.objectContaining({ id: request.id })]);
    expect(JSON.stringify(listed.json())).not.toContain(code);

    expect((await poll(secret)).json()).toEqual({ state: 'pending', expiresIn: 300 });
    // A tap is not enough, and a wrong code is not either.
    expect((await answer(String(request.id), { approve: true })).json()).toEqual({
      result: 'wrong-code',
    });
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await answer(String(request.id), { approve: true, code: wrong })).json()).toEqual({
      result: 'wrong-code',
    });
    expect((await poll(secret)).json().state).toBe('pending');

    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect((await answer(String(request.id), { approve: true, code: spaced })).json()).toEqual({
      result: 'approved',
    });
    expect(broadcasts).toContainEqual({
      type: 'deviceApprovalClosed',
      id: request.id,
      outcome: 'approved',
    });

    const approved = await poll(secret);
    expect(approved.json()).toEqual({ state: 'approved' });
    const cookie = cookieOf(approved.headers['set-cookie']);
    const me = await app.inject({ url: '/api/auth/me', headers: { ...funnel(), cookie } });
    expect(me.json()).toMatchObject({ method: 'approval', label: '내 노트북' });
    // Single use: the answer is handed out once.
    expect((await poll(secret)).json()).toEqual({ state: 'gone' });
    expect((await answer(String(request.id), { approve: true, code })).json()).toEqual({
      result: 'gone',
    });
  });

  it('refuses on request, and after three wrong codes', async () => {
    const { broadcasts } = await start();
    const first = (await ask(funnel('203.0.113.60'))).json();
    const firstId = String(broadcasts.at(-1)?.id);
    expect((await answer(firstId, { approve: false })).json()).toEqual({ result: 'refused' });
    expect((await poll(first.secret, funnel('203.0.113.60'))).json()).toEqual({ state: 'refused' });
    expect((await poll(first.secret, funnel('203.0.113.60'))).json()).toEqual({ state: 'gone' });

    const second = (await ask(funnel('203.0.113.61'))).json();
    const secondId = String(
      broadcasts.filter((m) => m.type === 'deviceApprovalRequest').at(-1)?.id,
    );
    const wrong = second.code === '999999' ? '888888' : '999999';
    for (let i = 0; i < 3; i++) await answer(secondId, { approve: true, code: wrong });
    expect((await answer(secondId, { approve: true, code: second.code })).json()).toEqual({
      result: 'gone',
    });
    expect((await poll(second.secret, funnel('203.0.113.61'))).json()).toEqual({
      state: 'refused',
    });
  });

  it('expires after 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { broadcasts } = await start();
    const { secret, code } = (await ask()).json();
    const id = String(broadcasts[0].id);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect((await poll(secret)).json()).toEqual({ state: 'gone' });
    expect(broadcasts).toContainEqual({ type: 'deviceApprovalClosed', id, outcome: 'expired' });
    expect((await answer(id, { approve: true, code })).json()).toEqual({ result: 'gone' });
  });

  it('lets the host approve by code with its Bearer token, never over Funnel', async () => {
    const { app } = await start();
    const { secret, code } = (await ask()).json();
    const cli = (headers: Record<string, string>, body: unknown) =>
      app.inject({ method: 'POST', url: '/api/device-approval', headers, payload: body as object });
    const bearer = { authorization: `Bearer ${TOKEN}` };
    expect((await cli({ ...funnel(), ...bearer }, { code })).statusCode).toBe(401);
    expect((await cli(bearer, { code: code === '123456' ? '654321' : '123456' })).statusCode).toBe(
      400,
    );
    const ok = await cli(bearer, { code });
    expect(ok.json()).toEqual({ ok: true });
    expect((await poll(secret)).json()).toEqual({ state: 'approved' });
  });

  it('caps pending requests per client and says where each came from', async () => {
    const { app, broadcasts } = await start();
    for (let i = 0; i < 3; i++) expect((await ask(funnel('203.0.113.70'))).statusCode).toBe(200);
    expect((await ask(funnel('203.0.113.70'))).statusCode).toBe(429);
    // Through tailscale serve from a tailnet device, straight to 127.0.0.1, from the LAN.
    await ask({ host: HOST, 'x-forwarded-for': '100.101.102.103', 'x-forwarded-proto': 'https' });
    await ask({ host: 'localhost:18240' });
    await app.inject({
      method: 'POST',
      url: '/login/approval',
      headers: { host: '192.168.1.9:18240' },
      remoteAddress: '192.168.1.20',
      payload: { label: 'lan' },
    });
    const networks = broadcasts
      .filter((m) => m.type === 'deviceApprovalRequest')
      .map((m) => `${String(m.network)} ${String(m.ip)}`);
    expect(networks.slice(3)).toEqual([
      'tailnet 100.101.102.103',
      'local 127.0.0.1',
      'lan 192.168.1.20',
    ]);
  });

  it('keeps working while short codes are locked', async () => {
    const { app } = await start();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let i = 0; i < 20; i++)
      await app.inject(formLogin(`3333 ${String(i).padStart(4, '0')}`, funnel(`198.51.100.${i}`)));
    expect((await app.inject(formLogin('3333 9999', funnel('192.0.2.1')))).statusCode).toBe(429);
    expect((await ask()).statusCode).toBe(200);
  });
});

describe('isTailscaleAddress', () => {
  it('knows 100.64.0.0/10 and fd7a:115c:a1e0::/48', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(true);
    expect(isTailscaleAddress('100.127.255.255')).toBe(true);
    expect(isTailscaleAddress('100.128.0.1')).toBe(false);
    expect(isTailscaleAddress('100.63.0.1')).toBe(false);
    expect(isTailscaleAddress('::ffff:100.100.1.1')).toBe(true);
    expect(isTailscaleAddress('fd7a:115c:a1e0::1')).toBe(true);
    expect(isTailscaleAddress('203.0.113.1')).toBe(false);
  });
});

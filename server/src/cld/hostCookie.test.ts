/**
 * MHO 3.6: two daemons on two ports of one browser's `localhost` keep their own logins. Cookies do
 * not separate ports (RFC 6265 8.5), so the jar here is one map of name -> value for `localhost`,
 * whatever the port, as a browser keeps it. An old shared `cld_session` still logs in once and moves.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { LEGACY_SESSION_COOKIE, sessionCookieName } from './auth.js';
import {
  type AuthServer,
  funnel,
  HOST,
  makeFakeDist,
  proveSession,
  startAuthServer,
  stopAuthServer,
  tailnet,
} from './authTestKit.js';
import { loadOrCreateHost } from './engine/host.js';
import { hostLabel, registerHostNameRoute } from './hostName.js';
import { STEPUP_REQUIRED } from './shell/gate.js';

const HOST_A = '1a2b3c4d-0000-4000-8000-000000000001';
const HOST_B = '5e6f7a8b-0000-4000-8000-000000000002';
const PORT_A = 19030;
const PORT_B = 19031;

const NASTY_NAME = '<b>&"';

let dist: ReturnType<typeof makeFakeDist>;
let home: string;
let renamed = 0;
let a: AuthServer;
let b: AuthServer;
const jar = new Map<string, string>();

function keep(res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';');
    const [name, ...value] = pair.trim().split('=');
    if (attrs.some((attr) => attr.trim() === 'Max-Age=0')) jar.delete(name);
    else jar.set(name, value.join('='));
  }
}

async function call(port: number, path: string): Promise<Response> {
  const res = await fetch(`http://localhost:${String(port)}${path}`, {
    redirect: 'manual',
    headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  keep(res);
  return res;
}

const me = async (port: number) => (await call(port, '/api/auth/me')).status;
const login = async (server: AuthServer, port: number) =>
  (await call(port, `/login?code=${server.auth.createLoginCode().code}`)).status;

/** The /ws handshake with the jar's cookies: 101 when the gate lets it through. */
function wsStatus(port: number): Promise<number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://localhost:${String(port)}/ws`, {
      headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    socket.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      socket.terminate();
    });
    socket.once('open', () => {
      resolve(101);
      socket.close();
    });
    socket.once('error', () => resolve(0));
  });
}

beforeAll(async () => {
  dist = makeFakeDist();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-hostname-'));
  loadOrCreateHost(home);
  a = await startAuthServer(dist.staticDir, {
    listen: true,
    port: PORT_A,
    hostId: HOST_A,
    hostName: () => NASTY_NAME,
    routes: (app, auth, stepUpFresh, actorOf, kindOf) =>
      registerHostNameRoute(app, home, () => renamed++, auth, stepUpFresh, kindOf, actorOf),
  });
  b = await startAuthServer(dist.staticDir, { listen: true, port: PORT_B, hostId: HOST_B });
});
afterAll(async () => {
  await stopAuthServer(a);
  await stopAuthServer(b);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dist.root, { recursive: true, force: true });
});
afterEach(() => jar.clear());

describe('one session cookie per host', () => {
  it('names the cookie after the host id, and falls back to the old name without one', () => {
    expect(sessionCookieName(HOST_A)).toBe('cld_session_1a2b3c4d');
    expect(sessionCookieName(null)).toBe(LEGACY_SESSION_COOKIE);
    expect(sessionCookieName('not-a-uuid')).toBe(LEGACY_SESSION_COOKIE);
  });

  it('keeps both daemons logged in after logging into the second', async () => {
    expect(await login(a, PORT_A)).toBe(303);
    expect(await me(PORT_A)).toBe(200);
    expect(await me(PORT_B)).toBe(401);
    expect(await login(b, PORT_B)).toBe(303);
    expect([...jar.keys()].sort()).toEqual(['cld_session_1a2b3c4d', 'cld_session_5e6f7a8b']);
    expect(await me(PORT_A)).toBe(200);
    expect(await me(PORT_B)).toBe(200);
    expect(await wsStatus(PORT_A)).toBe(101);
    expect(await wsStatus(PORT_B)).toBe(101);
    // One host's cookie is nothing to the other.
    jar.delete('cld_session_1a2b3c4d');
    expect(await me(PORT_A)).toBe(401);
    expect(await wsStatus(PORT_A)).toBe(401);
    expect(await me(PORT_B)).toBe(200);
  });

  it('reads an old cld_session once, moves it to the new name and clears only its own', async () => {
    const old = a.auth.createSession('link', 'phone').id;
    jar.set(LEGACY_SESSION_COOKIE, encodeURIComponent(old));
    expect(await wsStatus(PORT_A)).toBe(101);
    // The app page renews the cookie: under the new name, and the old one goes (it was A's).
    expect((await call(PORT_A, '/')).status).toBe(200);
    expect(jar.get('cld_session_1a2b3c4d')).toBe(encodeURIComponent(old));
    expect(jar.has(LEGACY_SESSION_COOKIE)).toBe(false);
    expect(await me(PORT_A)).toBe(200);

    // B's login leaves an old cld_session alone when it is not B's (it may be another daemon's).
    jar.set(LEGACY_SESSION_COOKIE, encodeURIComponent(old));
    expect(await login(b, PORT_B)).toBe(303);
    expect(jar.get(LEGACY_SESSION_COOKIE)).toBe(encodeURIComponent(old));
  });

  it('signs this device out by the cookie that named its session', async () => {
    const signOut = async (id: string) => {
      const res = await fetch(`http://localhost:${String(PORT_A)}/api/auth/sessions/${id}`, {
        method: 'DELETE',
        headers: {
          cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
          origin: `http://localhost:${String(PORT_A)}`,
        },
      });
      keep(res);
      return res.status;
    };
    for (const name of ['cld_session_1a2b3c4d', LEGACY_SESSION_COOKIE]) {
      const session = a.auth.createSession('link', 'phone');
      jar.set(name, encodeURIComponent(session.id));
      jar.set('cld_session_5e6f7a8b', 'b-stays');
      expect(await signOut(a.auth.rowId(session))).toBe(200);
      expect(jar.has(name)).toBe(false);
      expect(jar.get('cld_session_5e6f7a8b')).toBe('b-stays');
      jar.clear();
    }
    // An old cld_session naming another live session of this host goes too: else the next
    // request would fall back to it, still signed in.
    const now = a.auth.createSession('link', 'phone');
    jar.set('cld_session_1a2b3c4d', encodeURIComponent(now.id));
    jar.set(LEGACY_SESSION_COOKIE, encodeURIComponent(a.auth.createSession('link', 'phone').id));
    expect(await signOut(a.auth.rowId(now))).toBe(200);
    expect(jar.size).toBe(0);
    expect(await me(PORT_A)).toBe(401);
  });
});

describe('the host name on the login page and its route', () => {
  const titleOf = (body: string) => /<title>(.*)<\/title>/.exec(body)?.[1] ?? '';

  it('names the host, escaped, on this PC; never over Funnel', async () => {
    const local = await a.app.inject({ url: '/', headers: { host: 'localhost' } });
    expect(local.statusCode).toBe(401);
    expect(titleOf(local.body)).toContain('&lt;b&gt;&amp;&quot;');
    expect(local.body).not.toContain(NASTY_NAME);
    const outside = await a.app.inject({ url: '/', headers: funnel() });
    expect(outside.statusCode).toBe(401);
    expect(titleOf(outside.body)).not.toContain('&lt;b&gt;');
    expect(titleOf(outside.body)).toBe(titleOf((await b.app.inject({ url: '/', headers: funnel() })).body));
  });

  const post = (name: unknown, headers: Record<string, string>) =>
    a.app.inject({ method: 'POST', url: '/api/cld/host-name', headers, payload: { name } });
  const here = () => ({
    host: 'localhost',
    origin: 'http://localhost',
    cookie: `${a.auth.cookieName}=${a.auth.createSession('link', 'laptop').id}`,
  });

  it('refuses hidden characters, another origin, and a remote device without a fresh step-up', async () => {
    const before = renamed;
    for (const bad of ['a\u202eb', 'zero\u200bwidth', 'x'.repeat(41), '   ', 42])
      expect((await post(bad, here())).statusCode).toBe(400);
    expect((await post('Desk', { ...here(), origin: 'http://evil.example' })).statusCode).toBe(403);
    const cookie = `${a.auth.cookieName}=${a.auth.createSession('link', 'phone').id}`;
    const remote = { ...tailnet, origin: `http://${HOST}`, cookie };
    const stale = await post('Desk', remote);
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toEqual({ error: STEPUP_REQUIRED });
    expect(renamed).toBe(before);
    expect(hostLabel(home).hostName).toBe(os.hostname());

    expect((await post('Desk', { ...remote, cookie: proveSession(a.auth, cookie) })).statusCode).toBe(200);
    expect(hostLabel(home).hostName).toBe('Desk');
    expect((await post('', here())).json()).toEqual({ ok: true, hostName: os.hostname() });
    expect(renamed).toBe(before + 2);
  });
});

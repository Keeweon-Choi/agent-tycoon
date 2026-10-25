/**
 * T-0024 end to end on a real server: who may auto-login (only loopback
 * tailnet identities), invitations carrying the canonical external URL with
 * its secret path, a laptop joining from outside with the phone's invite,
 * strangers seeing nothing, the direct listener's login rules, moving a LAN
 * device, rotating the secret. Fake router, STUN and certificates; the
 * server listens on 127.0.0.1 only.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import * as tls from 'tls';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { AgentStateStore } from '../../agentStateStore.js';
import { CUT_GRACE_MS } from '../../constants.js';
import { createHttpServer, type HttpServerHandle } from '../../httpServer.js';
import { auditLog } from '../audit.js';
import { LAN_SESSION_TTL_MS, SESSION_TTL_MS, StandaloneAuth } from '../auth.js';
import { funnel, makeFakeDist, OWNER, proveSession, SoftDevice, tailnet, TOKEN } from '../authTestKit.js';
import { cldHooks } from '../hooks.js';
import { waitFor } from '../waitKit.js';
import {
  canonicalUrl,
  listenPlan,
  type RemoteOptions,
  startRemote,
  tailscaleServing,
} from './index.js';
import { relayCommands } from './net.js';
import {
  cookies,
  fakeGateway,
  fakeIssuer,
  type Fetched,
  httpsGet,
  loopbackRelay,
  tempDir,
  type TestCa,
  testCa,
} from './testKit.js';
import { cloudflaredArgs } from './tunnel.js';

const PUBLIC = '203.0.113.7';
let ca: TestCa;
let dist: { root: string; staticDir: string };
beforeAll(async () => {
  ca = await testCa();
  dist = makeFakeDist();
});
afterAll(() => fs.rmSync(dist.root, { recursive: true, force: true }));

describe('connector choices (pure)', () => {
  it('bind addresses per connector: loopback always; LAN for lan and direct; the TLS port only for direct', () => {
    expect(listenPlan('local', '192.168.0.100', 18240, 18443)).toEqual([]);
    expect(listenPlan('tailscale', '192.168.0.100', 18240, 18443)).toEqual([]);
    expect(listenPlan('lan', '192.168.0.100', 18240, 18443)).toEqual([
      { kind: 'lan', host: '192.168.0.100', port: 18240 },
    ]);
    expect(listenPlan('direct', '192.168.0.100', 18240, 18443)).toEqual([
      { kind: 'lan', host: '192.168.0.100', port: 18240 },
      { kind: 'direct', host: '192.168.0.100', port: 18443 },
    ]);
    expect(listenPlan('direct', null, 18240, 18443)).toEqual([]);
  });

  it('the canonical URL: the outside path when there is one, else the LAN, else localhost', () => {
    const f = { port: 18240, directUrl: null, tailscaleHost: null, lanIp: null };
    expect(
      canonicalUrl({
        ...f,
        connector: 'direct',
        directUrl: `https://${PUBLIC}/s3cret/`,
        lanIp: '192.168.0.100',
      }),
    ).toBe(`https://${PUBLIC}/s3cret/`);
    expect(
      canonicalUrl({
        ...f,
        connector: 'tailscale',
        tailscaleHost: 'office.tail0000.ts.net',
        lanIp: '192.168.0.100',
      }),
    ).toBe('https://office.tail0000.ts.net/');
    expect(canonicalUrl({ ...f, connector: 'lan', lanIp: '192.168.0.100' })).toBe(
      'http://192.168.0.100:18240/',
    );
    expect(canonicalUrl({ ...f, connector: 'lan' })).toBe('http://localhost:18240/');
    expect(canonicalUrl({ ...f, connector: 'local', lanIp: '192.168.0.100' })).toBe(
      'http://localhost:18240/',
    );
    // direct still being set up: the LAN until the certificate exists
    expect(canonicalUrl({ ...f, connector: 'direct', lanIp: '192.168.0.100' })).toBe(
      'http://192.168.0.100:18240/',
    );
  });
});

/** A plain http GET (no undici timers, so it works under fake timers too). */
const lanUp = (port: number) =>
  new Promise<boolean>((resolve) =>
    http
      .get({ host: '127.0.0.2', port, path: '/api/health', agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      })
      .on('error', () => resolve(false)),
  );
/** The LAN listener answers: what the 50 ms sleep after startup stood for. */
const lanListening = (port: number) => waitFor(async () => expect(await lanUp(port)).toBe(true));

interface Running {
  server: HttpServerHandle;
  auth: StandaloneAuth;
  remote: ReturnType<typeof startRemote>;
  /** HTTPS through the direct listener, as a device outside would. */
  outside(
    path: string,
    options?: {
      cookie?: string;
      method?: string;
      body?: string;
      headers?: Record<string, string>;
      from?: string;
    },
  ): Promise<Fetched>;
}

async function run(
  options: {
    connector?: 'direct' | 'lan' | 'local' | 'tailscale';
    readOnly?: boolean;
    deviceKeys?: boolean;
    configDir?: string;
    allowTerminal?: boolean;
    deps?: RemoteOptions['deps'];
    allowedHosts?: string[];
    approvals?: boolean;
  } = {},
): Promise<Running> {
  // Device keys (T-0034) live in devices.json: a temp config dir turns them on.
  const auth = new StandaloneAuth({
    ...(options.deviceKeys ? { configDir: tempDir() } : {}),
    ...(options.approvals ? { allowApprovalRequests: true } : {}),
  });
  const store = new AgentStateStore();
  const token: { current?: string } = { current: TOKEN };
  const remote = startRemote({
    connector: options.connector ?? 'direct',
    allowedHosts: options.allowedHosts ?? [],
    readOnly: options.readOnly ?? false,
    configDir: options.configDir ?? tempDir(),
    token,
    directPort: 0,
    deps: {
      // The LAN listener binds here (Linux loopback); LAN peers are injected below.
      lanIp: '127.0.0.2',
      wslMode: async () => null,
      listenHost: '127.0.0.1',
      findGateway: async () => fakeGateway(() => PUBLIC).gateway,
      observedIp: async () => PUBLIC,
      issue: fakeIssuer(ca).issue,
      selfTest: async () => ({ ok: true, text: 'fake self-test' }),
      // Never this machine's own `tailscale`: a setup request would spawn it (twice), and on a
      // busy CPU those real processes alone ate the test's 10 s. A test that wants tailscale passes its own.
      setupCommand: async () => null,
      tailscaleServe: async () => null,
      // Never this machine's own /etc/ufw or sshd_config, nor its sshd.
      readFile: () => null,
      sshd: async () => ({ open: false, banner: '' }),
      ...options.deps,
    },
  });
  const server = await createHttpServer({
    embedded: false,
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    store,
    staticDir: dist.staticDir,
    auth,
    allowTerminal: options.allowTerminal,
  });
  const outside: Running['outside'] = (path, o = {}) =>
    httpsGet(remote.direct?.listeningPort() ?? 0, path, {
      ca: ca.cert,
      checkAs: PUBLIC,
      method: o.method,
      body: o.body,
      localAddress: o.from,
      headers: {
        host: PUBLIC,
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...(o.method && o.method !== 'GET' ? { origin: `https://${PUBLIC}` } : {}),
        ...(o.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...o.headers,
      },
    });
  return { server, auth, remote, outside };
}

/** Network facts for a setup request whose choice does not read them: no probe, no `which` spawns. */
const noFacts = async () => ({
  natKind: 'cgnat' as const, upnp: false, wslMode: null, relayReady: false,
  tailscaleInstalled: false, tailscaleLoggedIn: false, cloudflaredInstalled: false,
});

/** Turn direct on the way the installer does: the host's Bearer, over loopback. */
async function enableDirect(r: Running): Promise<string> {
  const res = await r.server.app.inject({
    method: 'POST',
    url: '/api/cld/connector/enable',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { connector: 'direct' },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json<{ ok: boolean; url: string; connector: string }>();
  expect(body).toMatchObject({ ok: true, connector: 'direct' });
  return body.url;
}

/** Follow a login link from outside: the session and gate cookies it leaves. */
async function join(r: Running, link: string, options: { move?: boolean } = {}): Promise<string> {
  const url = new URL(link);
  const res = await r.outside(url.pathname + url.search);
  if (options.move) {
    // T-0034: a move came from another site, so it lands on a same-origin hop
    // page; its bare `/` comes back under the secret path from the gate.
    expect(res.status).toBe(200);
    expect(res.body).toContain('url=/');
    const hop = await r.outside('/', { cookie: cookies(res.headers['set-cookie']) });
    expect(hop.status).toBe(302);
    expect(hop.headers.location).toBe(`/${r.remote.direct?.secret}/`);
  } else {
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/${r.remote.direct?.secret}/`);
  }
  const jar = cookies(res.headers['set-cookie']);
  expect(jar).toMatch(/cld_session=.+; cld_gate=/);
  return jar;
}

describe('remote access on a real server', () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.remote.dispose();
    await r?.server.app.close();
    r = undefined;
    for (const hook of ['registerRoutes', 'onListening', 'canonicalUrl'] as const)
      delete cldHooks[hook];
  });

  it('setup runs only the chosen plan and refuses an unknown choice or read-only client', async () => {
    const setup = { natKind: 'cgnat' as const, upnp: false, wslMode: null, relayReady: false,
      tailscaleInstalled: false, tailscaleLoggedIn: false, cloudflaredInstalled: false };
    r = await run({ readOnly: true, connector: 'local', deps: { setupFacts: async () => setup, sshd: async () => ({ open: false, banner: '' }) } });
    const host = { authorization: `Bearer ${TOKEN}` };
    const post = (choice: string, headers: Record<string, string> = host) => r!.server.app.inject({
      method: 'POST', url: '/api/cld/connector/setup', headers, payload: { choice },
    });
    for (const [choice, marker] of [
      ['local', '이 PC'], ['lan', '와이파이'], ['direct', 'CGNAT'], ['ssh', 'SSH'],
      ['duckdns', 'CGNAT'], ['tailscale', 'Tailscale'], ['tunnel', 'cloudflared'],
    ]) {
      const result = await post(choice);
      expect(result.statusCode, choice).toBe(200);
      expect(JSON.stringify(result.json().steps), choice).toContain(marker);
    }
    expect((await post('wrong')).statusCode).toBe(400);
    const { code } = r.auth.createLoginCode('qr');
    const login = await r.server.app.inject({ url: `/login?code=${code}` });
    const session = cookies(login.headers['set-cookie'] as string[] | string);
    expect((await post('tailscale', { cookie: session, origin: 'http://127.0.0.2:80', host: '127.0.0.2:80' })).statusCode).toBe(403);
  });

  it('forged Tailscale identity headers never create a session, even at a serve host', async () => {
    r = await run({ connector: 'direct' });
    const app = r.server.app;
    // Deliberately pass the retired option: this would fail if header trust were restored.
    const trusted = await createHttpServer({
      embedded: false,
      host: '127.0.0.1',
      token: TOKEN,
      store: new AgentStateStore(),
      staticDir: dist.staticDir,
      listen: false,
      allowedHosts: [tailnet.host],
      trustedTailscaleUsers: [OWNER],
      auth: new StandaloneAuth(),
    });
    const viaServe = await trusted.app.inject({ url: '/', headers: tailnet });
    const lanForged = await trusted.app.inject({
      url: '/',
      headers: tailnet,
      remoteAddress: '192.168.0.50',
    });
    const funnelForged = await trusted.app.inject({
      url: '/',
      headers: { ...funnel(), 'tailscale-user-login': OWNER },
    });
    for (const res of [viaServe, lanForged, funnelForged]) {
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    await trusted.app.close();

    // the host token: loopback only, never from the LAN or the direct listener
    const bearer = { authorization: `Bearer ${TOKEN}` };
    expect(
      (await app.inject({ method: 'POST', url: '/api/login-code', headers: bearer })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login-code',
          headers: bearer,
          remoteAddress: '192.168.0.50',
        })
      ).statusCode,
    ).toBe(401);
    await enableDirect(r);
    const secret = r.remote.direct?.secret ?? '';
    const outsideBearer = await r.outside(`/${secret}/api/login-code`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(outsideBearer.status).toBe(401);
    // a forged identity from outside: scrubbed, no session
    const outsideForged = await r.outside(`/${secret}/`, {
      headers: { 'tailscale-user-login': OWNER, 'x-forwarded-for': '127.0.0.1' },
    });
    expect(outsideForged.status).toBe(401);
    expect(cookies(outsideForged.headers['set-cookie'])).toBe(`cld_gate=${secret}`);
  });

  it("invites carry the canonical external URL with the secret path; a laptop joins from outside with the phone's invite", async () => {
    r = await run();
    const canonical = await enableDirect(r);
    const secret = r.remote.direct?.secret ?? '';
    expect(canonical).toBe(`https://${PUBLIC}/${secret}/`);

    // the host CLI (cld-gui-login --qr): the code and the canonical URL
    const minted = await r.server.app.inject({
      method: 'POST',
      url: '/api/login-code',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { qr: true },
    });
    const { code, url } = minted.json<{ code: string; url: string }>();
    expect(url).toBe(canonical.replace(/\/$/, '')); // links append /login?code=

    // the phone scans it from anywhere
    const phone = await join(r, `${url}/login?code=${code}`);
    expect((await r.outside(`/${secret}/`, { cookie: phone })).status).toBe(200);

    // the phone's "기기 추가": URL + 8-digit code, and a QR link that is URL + code
    proveSession(r.auth, phone); // S1: inviting needs a fresh step-up
    const invite = await r.outside('/api/auth/device-code', { method: 'POST', cookie: phone });
    expect(invite.status).toBe(200);
    const offer = JSON.parse(invite.body) as { code: string; url: string; link: string };
    expect(offer.url).toBe(canonical.replace(/\/$/, ''));
    expect(offer.link).toMatch(
      new RegExp(
        `^https://${PUBLIC.replaceAll('.', '\\.')}/${secret}/login\\?code=[A-Za-z0-9_-]{32}$`,
      ),
    );
    expect(offer.code).toMatch(/^\d{8}$/);

    // a laptop at a café: opens the URL (the gate lets it in, the login page asks), types the code
    const bare = await r.outside(new URL(offer.url).pathname);
    expect(bare.status).toBe(302);
    expect(bare.headers.location).toBe(`/${secret}/`);
    const first = await r.outside(`/${secret}/`);
    expect(first.status).toBe(401);
    expect(first.body).toContain('로그인 코드');
    expect(first.body).not.toContain('패스키로 로그인');
    const gateOnly = cookies(first.headers['set-cookie']);
    const typed = await r.outside(`/${secret}/login`, {
      method: 'POST',
      cookie: gateOnly,
      body: `code=${offer.code}`,
    });
    expect(typed.status).toBe(303);
    expect(typed.headers.location).toBe(`/${secret}/`);
    const laptop = cookies(typed.headers['set-cookie']);
    const me = await r.outside('/api/auth/me', { cookie: `${gateOnly}; ${laptop}` });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body)).toMatchObject({ method: 'short', passkeys: false });
    // the code and its QR partner were one credential: the link is spent
    expect(
      (await r.outside(new URL(offer.link).pathname + new URL(offer.link).search)).status,
    ).toBe(401);
  });

  it('a stranger without the invitation gets empty 404s, wherever they knock', async () => {
    r = await run();
    await enableDirect(r);
    for (const path of [
      '/',
      '/login',
      '/login?code=12345678',
      '/api/health',
      '/api/auth/me',
      '/api/cld/connector',
      '/manifest.webmanifest',
      '/icons/icon-256.png',
    ]) {
      const res = await r.outside(path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).toBe('');
    }
  });

  it('the direct listener offers codes and device keys only, with a stricter cap', async () => {
    r = await run();
    await enableDirect(r);
    const secret = r.remote.direct?.secret ?? '';
    for (const path of [
      '/login/passkey/options',
      '/login/passkey',
      '/login/approval',
      '/login/approval/poll',
    ]) {
      const res = await r.outside(`/${secret}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status, path).toBe(404);
    }
    // 10 wrong codes in an hour, each from another address (so no per-address
    // limit trips), lock code logins there for everyone ...
    const gateOnly = `cld_gate=${secret}`;
    for (let i = 0; i < 10; i += 1) {
      const res = await r.outside(`/${secret}/login`, {
        method: 'POST',
        cookie: gateOnly,
        body: `code=${String(10_000_000 + i)}`,
        from: `127.0.0.${10 + i}`,
      });
      expect(res.status).toBe(401);
    }
    const { code } = r.auth.createLoginCode('short');
    const locked = await r.outside(`/${secret}/login`, {
      method: 'POST',
      cookie: gateOnly,
      body: `code=${code}`,
      from: '127.0.0.99',
    });
    expect(locked.status).toBe(429);
    // ... but not on the LAN: the same, unspent code still works there
    const lan = await r.server.app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: '192.168.0.50',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `code=${code}`,
    });
    expect(lan.statusCode).toBe(303);
  });

  it('a LAN device moves to the canonical address with its device key (T-0034 move code); its LAN session ends', async () => {
    r = await run({ deviceKeys: true });
    await enableDirect(r);
    const app = r.server.app;
    const secret = r.remote.direct?.secret ?? '';
    const lanHeaders = { host: '192.168.0.100:18240', origin: 'http://192.168.0.100:18240' };
    const lan = (url: string, method: 'GET' | 'POST', cookie: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        remoteAddress: '192.168.0.50',
        headers: { ...lanHeaders, cookie },
        payload: payload as Record<string, unknown>,
      });
    // at home, on the LAN address: a code login and the web app's device key
    const { code } = r.auth.createLoginCode('short');
    const login = await app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: '192.168.0.50',
      headers: { ...lanHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `code=${code}`,
    });
    const lanCookie = cookies(login.headers['set-cookie'] as string[] | string);
    const device = await SoftDevice.create();
    const registered = await lan('/api/auth/device', 'POST', lanCookie, {
      deviceId: device.id, // the web app makes the id, like the key
      publicKey: await device.publicKey(),
    });
    expect(registered.statusCode).toBe(200);
    const { deviceId } = registered.json<{ deviceId: string }>();
    // the outside path exists now: the app offers the move, the move code points there
    const me = await lan('/api/auth/me', 'GET', lanCookie);
    expect(me.json<{ moveTo: string }>().moveTo).toBe(`https://${PUBLIC}/${secret}`);
    // S1: a move code adds a device, so it wants a fresh step-up
    expect((await lan('/api/auth/move-code', 'POST', lanCookie)).json()).toEqual({ error: 'stepup' });
    proveSession(r.auth, lanCookie);
    const move = await lan('/api/auth/move-code', 'POST', lanCookie);
    expect(move.statusCode).toBe(200);
    const { url } = move.json<{ url: string }>();
    expect(url).toMatch(
      new RegExp(`^https://${PUBLIC.replaceAll('.', '\\.')}/${secret}/login\\?code=`),
    );
    // the same device opens it through the direct listener and registers a new key under its id
    const moved = await join(r, url, { move: true });
    const fresh = await SoftDevice.create(deviceId);
    const rekey = await r.outside('/api/auth/device', {
      method: 'POST',
      cookie: moved,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId, publicKey: await fresh.publicKey() }),
    });
    expect(rekey.status).toBe(200);
    expect(JSON.parse(rekey.body)).toEqual({ deviceId });
    // one device, now on the canonical origin; the LAN session is gone
    expect((await lan('/api/auth/me', 'GET', lanCookie)).statusCode).toBe(401);
    // on the canonical address itself there is nowhere to move (origins compared, not the path)
    const there = JSON.parse((await r.outside('/api/auth/me', { cookie: moved })).body) as {
      moveTo: string | null;
    };
    expect(there.moveTo).toBeNull();
    const rows = JSON.parse((await r.outside('/api/auth/sessions', { cookie: moved })).body) as {
      sessions: Array<{ id: string; origin?: string }>;
    };
    expect(rows.sessions).toEqual([
      expect.objectContaining({ id: deviceId, origin: `https://${PUBLIC}` }),
    ]);
  });

  it('status shows the canonical URL to logged-in devices only; rotating the secret re-pairs everyone else', async () => {
    r = await run();
    await enableDirect(r);
    const secret = r.remote.direct?.secret ?? '';
    const { code } = r.auth.createLoginCode('qr');
    const phone = await join(r, `https://${PUBLIC}/${secret}/login?code=${code}`);
    expect((await r.outside('/api/cld/connector', { cookie: `cld_gate=${secret}` })).status).toBe(
      401,
    );
    const status = JSON.parse((await r.outside('/api/cld/connector', { cookie: phone })).body) as {
      canonicalUrl: string;
      connector: string;
    };
    expect(status).toMatchObject({
      connector: 'direct',
      canonicalUrl: `https://${PUBLIC}/${secret}/`,
    });
    // S1: a new secret path needs a fresh step-up on the session
    const cookieOnly = await r.outside('/api/cld/connector/rotate', { method: 'POST', cookie: phone });
    expect(cookieOnly.status).toBe(403);
    expect(JSON.parse(cookieOnly.body)).toEqual({ error: 'stepup' });
    expect(r.remote.direct?.secret).toBe(secret);
    proveSession(r.auth, phone);
    const rotated = await r.outside('/api/cld/connector/rotate', { method: 'POST', cookie: phone });
    expect(rotated.status).toBe(200);
    const fresh = (JSON.parse(rotated.body) as { url: string }).url;
    expect(fresh).not.toContain(secret);
    expect((await r.outside(`/${secret}/`)).status).toBe(404);
    expect((await r.outside('/api/auth/me', { cookie: phone })).status).toBe(404); // old gate cookie
    expect(
      (await r.outside(`${new URL(fresh).pathname}api/auth/me`, { cookie: phone })).status,
    ).toBe(200);
  });

  it('the secret path never reaches the log; switching to local closes the LAN listener', async () => {
    const configDir = tempDir();
    const first = await run({ configDir });
    await enableDirect(first);
    const secret = first.remote.direct?.secret ?? '';
    await first.remote.dispose();
    await first.server.app.close();
    for (const hook of ['registerRoutes', 'onListening', 'canonicalUrl'] as const)
      delete cldHooks[hook];
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    });
    try {
      r = await run({ configDir }); // a restart with direct on: the startup line names the URL
      expect(r.remote.direct?.secret).toBe(secret);
      await waitFor(() =>
        expect(lines.some((l) => l.includes('[cld remote] connector direct: https://'))).toBe(true),
      );
      expect(lines.filter((l) => l.includes(secret))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    const port = (r.server.app.server.address() as { port: number }).port;
    const lan = () =>
      fetch(`http://127.0.0.2:${port}/api/health`).then(
        (res) => res.status,
        () => 0,
      );
    expect(await lan()).toBe(200);
    const res = await r.server.app.inject({
      method: 'POST',
      url: '/api/cld/connector/enable',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { connector: 'local' },
    });
    expect(res.json()).toMatchObject({ ok: true, connector: 'local' });
    expect(await lan()).toBe(0);
  });

  it('read-only: a logged-in device may not change the connector; the host may', async () => {
    r = await run({ readOnly: true });
    const { code } = r.auth.createLoginCode('qr');
    const login = await r.server.app.inject({ url: `/login?code=${code}` });
    const session = cookies(login.headers['set-cookie'] as string[] | string);
    const res = await r.server.app.inject({
      method: 'POST',
      url: '/api/cld/connector/enable',
      headers: { cookie: session, origin: 'http://localhost:80', host: 'localhost:80' },
      payload: { connector: 'direct' },
    });
    expect(res.statusCode).toBe(403);
    await enableDirect(r);
    const secret = r.remote.direct?.secret ?? '';
    const { code: outsideCode } = r.auth.createLoginCode('qr');
    const phone = await join(r, `https://${PUBLIC}/${secret}/login?code=${outsideCode}`);
    expect(
      (await r.outside('/api/cld/connector/rotate', { method: 'POST', cookie: phone })).status,
    ).toBe(403);
    expect(r.remote.direct?.secret).toBe(secret);
  });
});

/** A WebSocket handshake: open, closed with a code, or refused with an HTTP status. */
function wsTry(
  url: string,
  options: { headers?: Record<string, string>; ca?: string; checkAs?: string },
): Promise<{ open: boolean; code?: number; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      headers: options.headers,
      ca: options.ca,
      ...(options.checkAs
        ? {
            checkServerIdentity: (_host: string, cert: never) =>
              tls.checkServerIdentity(options.checkAs as string, cert),
          }
        : {}),
    });
    let open = false;
    ws.once('open', () => (open = true));
    ws.once('close', (code) => resolve({ open, code }));
    ws.once('unexpected-response', (_req, res) => {
      resolve({ open: false, status: res.statusCode });
      ws.terminate();
    });
    ws.once('error', () => resolve({ open, status: 0 }));
  });
}

describe('T-0074: public by the listener a request came in on, never by its peer address', () => {
  let r: Running | undefined;
  let relay: { port: number; close(): void } | undefined;
  afterEach(async () => {
    relay?.close();
    relay = undefined;
    await r?.remote.dispose();
    await r?.server.app.close();
    r = undefined;
    for (const hook of ['registerRoutes', 'onListening', 'canonicalUrl'] as const)
      delete cldHooks[hook];
  });

  it('the direct listener behind a loopback relay: no host token, no Tailscale identity, no Bearer WebSocket or shell, its own rate-limit bucket', async () => {
    r = await run({ connector: 'direct', allowTerminal: true });
    await enableDirect(r);
    const running = r;
    relay = await loopbackRelay(() => running.remote.direct?.listeningPort() ?? 0);
    const secret = r.remote.direct?.secret ?? '';
    const via = (path: string, o: { method?: string; headers?: Record<string, string> } = {}) =>
      httpsGet(relay?.port ?? 0, path, {
        ca: ca.cert,
        checkAs: PUBLIC,
        method: o.method,
        headers: { host: PUBLIC, ...o.headers },
      });
    const bearer = { authorization: `Bearer ${TOKEN}` };

    // the same host token that works on the loopback listener ...
    expect(
      (await r.server.app.inject({ method: 'POST', url: '/api/login-code', headers: bearer }))
        .statusCode,
    ).toBe(200);
    // ... is refused when the relay hands it over from 127.0.0.1
    const minted = await via(`/${secret}/api/login-code`, {
      method: 'POST',
      headers: { ...bearer, origin: `https://${PUBLIC}` },
    });
    expect(minted.status).toBe(401);
    expect((await via(`/${secret}/api/cld/connector`, { headers: bearer })).status).toBe(401);
    // a tailnet identity through the relay: no auto-login, the login page
    const forged = await via(`/${secret}/`, {
      headers: { 'tailscale-user-login': OWNER, 'x-forwarded-for': '100.64.0.9' },
    });
    expect(forged.status).toBe(401);
    expect(forged.headers['set-cookie']).not.toContain('cld_session=');
    expect(forged.body).not.toContain('passkey');
    // the WebSocket with the host token: closed unauthorized
    const ws = await wsTry(`wss://127.0.0.1:${relay.port}/${secret}/ws`, {
      headers: { ...bearer, host: PUBLIC },
      ca: ca.cert,
      checkAs: PUBLIC,
    });
    expect(ws.open).toBe(false);
    expect([401, 4001]).toContain(ws.code ?? ws.status);
    // the terminal path: the shell API and its socket want a session, the old route is gone
    expect((await via(`/${secret}/api/shell`, { headers: bearer })).status).toBe(401);
    const shell = await wsTry(`wss://127.0.0.1:${relay.port}/${secret}/cld/shell/x`, {
      headers: { ...bearer, host: PUBLIC },
      ca: ca.cert,
      checkAs: PUBLIC,
    });
    expect(shell.open).toBe(false);
    expect(shell.status).toBe(401);
    expect((await via(`/${secret}/terminal/x`, { headers: bearer })).status).toBe(404);
    // ten wrong codes through the relay must not lock the host's own loopback logins
    for (let i = 0; i < 10; i += 1)
      await via(`/${secret}/login?code=${String(20_000_000 + i)}`, {
        headers: { cookie: `cld_gate=${secret}` },
      });
    const { code } = r.auth.createLoginCode('link');
    const local = await r.server.app.inject({ url: `/login?code=${code}` });
    expect(local.statusCode).toBe(303);
  });

  it('the LAN listener: a loopback peer there is public too (a portproxy may point at it)', async () => {
    r = await run({ connector: 'lan' });
    const port = (r.server.app.server.address() as net.AddressInfo).port;
    // the LAN listener binds 127.0.0.2 here; we connect from 127.0.0.1, a loopback peer
    await lanListening(port);
    const res = await fetch(`http://127.0.0.2:${port}/api/login-code`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(401);
    const ws = await wsTry(`ws://127.0.0.2:${port}/ws`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ws.open).toBe(false);
    expect([401, 4001]).toContain(ws.code ?? ws.status);
    // the loopback listener itself still trusts the host
    const own = await fetch(`http://127.0.0.1:${port}/api/login-code`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(own.status).toBe(200);
  });
  it('the LAN listener creates a fixed 12-hour session from its socket, not Host or Origin', async () => {
    r = await run({ connector: 'lan' });
    const port = (r.server.app.server.address() as net.AddressInfo).port;
    await lanListening(port);
    const { code } = r.auth.createLoginCode('link');
    // These are loopback-looking headers, but the accepting LAN listener decides.
    const login = await fetch(`http://127.0.0.2:${port}/login?code=${code}`, {
      redirect: 'manual',
      headers: { host: `localhost:${port}`, origin: `http://localhost:${port}` },
    });
    expect(login.status).toBe(303);
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('Max-Age=43200');
    const id = decodeURIComponent(/cld_session=([^;]+)/.exec(setCookie)?.[1] ?? '');
    const lan = r.auth.session(id)!;
    expect(lan).toMatchObject({ lifetime: 'lan', expiresAt: lan.createdAt + LAN_SESSION_TTL_MS });
    const expiresAt = lan.expiresAt;

    // The faked clock must not outlive this block: later tests mint TLS certificates from Date.now().
    const clock = vi.spyOn(Date, 'now').mockReturnValue(lan.createdAt + 60 * 60 * 1000);
    try {
      const later = await fetch(`http://127.0.0.2:${port}/`, {
        headers: { cookie: `cld_session=${encodeURIComponent(id)}` },
      });
      expect(later.headers.get('set-cookie')).toContain('Max-Age=43200');
      expect(r.auth.session(id)?.expiresAt).toBe(expiresAt);
      clock.mockReturnValue(lan.createdAt + LAN_SESSION_TTL_MS + 1);
      expect(r.auth.validSession(id)).toBe(false);
    } finally {
      clock.mockRestore();
    }

    // Conversely, forged LAN headers on the loopback listener do not shorten it.
    const { code: localCode } = r.auth.createLoginCode('link');
    const local = await r.server.app.inject({
      url: `/login?code=${localCode}`,
      headers: { host: `127.0.0.2:${port}`, origin: `http://127.0.0.2:${port}` },
    });
    expect(String(local.headers['set-cookie'])).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    const localId = decodeURIComponent(/cld_session=([^;]+)/.exec(String(local.headers['set-cookie']))?.[1] ?? '');
    expect(r.auth.session(localId)?.lifetime).toBeUndefined();
  });
  it('the LAN listener: an approval request from a loopback peer is shown as the LAN, not this PC', async () => {
    r = await run({ connector: 'lan', approvals: true });
    const port = (r.server.app.server.address() as net.AddressInfo).port;
    await lanListening(port);
    const asked = await fetch(`http://127.0.0.2:${port}/login/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'relayed' }),
    });
    expect(asked.status).toBe(200);
    const { code } = r.auth.createLoginCode('link');
    const login = await r.server.app.inject({ url: `/login?code=${code}` });
    const cookie = cookies(login.headers['set-cookie'] as string[] | string);
    const listed = await r.server.app.inject({ url: '/api/auth/approvals', headers: { cookie } });
    expect(listed.json()).toMatchObject({ approvals: [{ label: 'relayed', network: 'lan' }] });
  });
});

describe("T-0074: the 접속 방식 screen's server side", () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.remote.dispose();
    await r?.server.app.close();
    r = undefined;
    for (const hook of ['registerRoutes', 'onListening', 'canonicalUrl'] as const)
      delete cldHooks[hook];
  });
  const bearer = { authorization: `Bearer ${TOKEN}` };
  const call = async (running: Running, url: string, payload?: unknown) => {
    const res = await running.server.app.inject({
      method: payload === undefined ? 'GET' : 'POST',
      url,
      headers: bearer,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return res.json<Record<string, unknown>>();
  };

  it('WSL NAT, no router: status carries the PowerShell relay, the probe says no UPnP step, sshd and tailscale are checked', async () => {
    r = await run({
      connector: 'local',
      deps: {
        wslMode: async () => 'nat',
        listenHost: undefined,
        findGateway: async () => {
          throw new Error('never asked from inside WSL NAT');
        },
        windowsAddresses: async () => [PUBLIC],
        sshd: async (port) => ({ open: port === 22, banner: 'SSH-2.0-OpenSSH_9.6p1' }),
        tailscaleServe: async () => null,
      },
    });
    const status = await call(r, '/api/cld/connector?access=1');
    expect(status).toMatchObject({
      connector: 'local',
      mayAct: true,
      start: true,
      wsl: { mode: 'nat' },
      relay: {
        add: [
          'netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=443 connectaddress=127.0.0.1 connectport=0',
          'Remove-NetFirewallRule -Name cld-gui-443 -ErrorAction SilentlyContinue; New-NetFirewallRule -Name cld-gui-443 -DisplayName "cld-gui 443" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow',
        ],
      },
      ssh: { port: 22, open: true, banner: 'SSH-2.0-OpenSSH_9.6p1' },
      tailscale: null,
    });
    // the cheap status (every page load) runs no sshd or tailscale check
    expect(await call(r, '/api/cld/connector')).not.toHaveProperty('ssh');
    const probe = await call(r, '/api/cld/connector/probe', {});
    expect(probe.ok).toBe(true);
    expect(JSON.stringify(probe.steps)).toContain('UPnP 단계는 필요 없어요');
    // same Wi-Fi can't work behind WSL NAT: said, not attempted
    const lan = await call(r, '/api/cld/connector/enable', { connector: 'lan' });
    expect(lan).toMatchObject({ ok: false, connector: 'local' });
  });

  it('switching never drops the current connector before the new one passes; one tap goes back', async () => {
    const configDir = tempDir();
    let relayUp = false;
    let outside = { ok: false, text: '바깥 확인 실패 (fake)' };
    r = await run({
      connector: 'tailscale',
      configDir,
      allowedHosts: [tailnet.host],
      deps: {
        wslMode: async () => 'nat',
        listenHost: undefined,
        windowsAddresses: async () => [PUBLIC],
        relayUp: () => relayUp,
        relayGapMs: 5,
        selfTest: async () => outside,
        tailscaleServe: async () => ({
          Web: {
            [`${tailnet.host}:443`]: {
              Handlers: {
                '/': {
                  Proxy: `http://127.0.0.1:${(r?.server.app.server.address() as net.AddressInfo).port}`,
                },
              },
            },
          },
          AllowFunnel: { [`${tailnet.host}:443`]: true },
        }),
      },
    });
    const canonical = `https://${tailnet.host}/`;
    expect((await call(r, '/api/cld/connector')).canonicalUrl).toBe(canonical);
    // 1) the portproxy is missing: still tailscale, the commands come back
    const missing = await call(r, '/api/cld/connector/enable', { connector: 'direct' });
    expect(missing).toMatchObject({ ok: false, connector: 'tailscale', url: canonical });
    expect(JSON.stringify(missing.steps)).toContain('netsh interface portproxy add v4tov4');
    // 2) relayed, certificate issued, but the outside check fails: still tailscale
    relayUp = true;
    const failed = await call(r, '/api/cld/connector/enable', { connector: 'direct' });
    expect(failed).toMatchObject({ ok: false, connector: 'tailscale', url: canonical });
    expect(r.remote.direct?.enabled).toBe(false);
    expect(r.remote.direct?.listeningPort()).toBeNull();
    expect(fs.existsSync(`${configDir}/config.json`)).toBe(false);
    // 3) the outside check passes: direct, written down
    outside = { ok: true, text: '바깥 확인 (fake)' };
    const on = await call(r, '/api/cld/connector/enable', { connector: 'direct' });
    expect(on).toMatchObject({ ok: true, connector: 'direct' });
    expect(on.url).toBe(`https://${PUBLIC}/${r.remote.direct?.secret}/`);
    expect(JSON.parse(fs.readFileSync(`${configDir}/config.json`, 'utf8'))).toMatchObject({
      connector: 'direct',
      accessChosen: true,
    });
    // 4) one tap back to tailscale: serve still points here, so it switches and direct closes
    const back = await call(r, '/api/cld/connector/enable', { connector: 'tailscale' });
    expect(back).toMatchObject({ ok: true, connector: 'tailscale', url: canonical });
    expect(r.remote.direct?.enabled).toBe(false);
  });

  it('"나중에" ends the start screen; a local host page can dismiss it in read-only mode', async () => {
    r = await run({ connector: 'local', readOnly: true });
    expect((await call(r, '/api/cld/connector')).start).toBe(true);
    const { code } = r.auth.createLoginCode('qr');
    const login = await r.server.app.inject({ url: `/login?code=${code}` });
    const session = cookies(login.headers['set-cookie'] as string[] | string);
    const asLocalPage = { cookie: session, origin: 'http://localhost:80', host: 'localhost:80' };
    const seen = await r.server.app.inject({ url: '/api/cld/connector', headers: asLocalPage, remoteAddress: '127.0.0.1' });
    expect(seen.json()).toMatchObject({ mayAct: false, maySetup: true, start: true });
    const refused = await r.server.app.inject({
      method: 'POST',
      url: '/api/cld/connector/chosen',
      headers: asLocalPage,
      remoteAddress: '127.0.0.1',
    });
    expect(refused.statusCode).toBe(200);
    expect((await call(r, '/api/cld/connector/chosen', {})).ok).toBe(true);
    expect((await call(r, '/api/cld/connector')).start).toBe(false);
  });

  it('tailscale serve status: only the HTTP proxy to this port counts', () => {
    const web = (proxy: string) => ({
      Web: { 'a.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } },
      AllowFunnel: { 'a.ts.net:443': true },
    });
    expect(tailscaleServing(web('http://127.0.0.1:18240'), 18240)).toEqual({
      host: 'a.ts.net',
      funnel: true,
    });
    expect(tailscaleServing(web('http://127.0.0.1:9999'), 18240)).toBeNull();
    expect(tailscaleServing(null, 18240)).toBeNull();
  });
});

describe('S6: a change that would cut the connection it came through', () => {
  let r: Running | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    await r?.remote.dispose();
    await r?.server.app.close();
    r = undefined;
    for (const hook of ['registerRoutes', 'onListening', 'canonicalUrl'] as const)
      delete cldHooks[hook];
  });
  const bearer = { authorization: `Bearer ${TOKEN}` };
  const portOf = (running: Running) => (running.server.app.server.address() as net.AddressInfo).port;
  const session = async (running: Running) => {
    const { code } = running.auth.createLoginCode('qr');
    const login = await running.server.app.inject({ url: `/login?code=${code}` });
    return proveSession(running.auth, cookies(login.headers['set-cookie'] as string[] | string)); // S1: widening needs a step-up
  };
  const ledgerOf = (configDir: string) =>
    fs.existsSync(`${configDir}/exposure.json`)
      ? (JSON.parse(fs.readFileSync(`${configDir}/exposure.json`, 'utf8')) as { entries: Array<Record<string, unknown>> }).entries
      : null;
  const logs = () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
    return { lines, restore: () => spy.mockRestore() };
  };
  /**
   * A fake `tailscale`, modelled on what was seen on 1.104.2: one https:443
   * handler, and `funnel --https=443 off` (like `serve … off`) removes it whole.
   * Whether `serve --bg` on a funneled port clears Funnel is unknown, so both.
   */
  const fakeTailscale = (serveClearsFunnel = true) => {
    let handler: { port: number; funnel: boolean } | null = null;
    const commands: string[] = [];
    /** `serve status` fails (null) from the next `--bg` on. */
    let readsFailAfterBg = false;
    let readsFail = false;
    return {
      commands,
      failReadsAfterBg: () => void (readsFailAfterBg = true),
      healReads: () => void (readsFail = readsFailAfterBg = false),
      live: () => handler,
      set: (next: { port: number; funnel: boolean } | null) => void (handler = next),
      setupCommand: async (command: string, args: string[]) => {
        commands.push([command, ...args].join(' '));
        const line = args.join(' ');
        if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${tailnet.host}.` } });
        const target = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(line)?.[1] ?? 0);
        if (line.includes('--bg') && readsFailAfterBg) readsFail = true;
        if (line === 'funnel --https=443 off' || line === 'serve --https=443 off') handler = null;
        else if (line.startsWith('serve --bg'))
          handler = { port: target, funnel: !serveClearsFunnel && handler?.port === target && handler.funnel };
        else if (line.startsWith('funnel --bg')) handler = { port: target, funnel: true };
        return '';
      },
      tailscaleServe: async () => {
        if (readsFail) return null;
        if (!handler) return {};
        const at = `${tailnet.host}:443`;
        return {
          Web: { [at]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${handler.port}` } } } },
          ...(handler.funnel ? { AllowFunnel: { [at]: true } } : {}),
        };
      },
    };
  };
  const servePointingAt = (port: () => number, funnelOn = false) => async () => ({
    Web: { [`${tailnet.host}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port()}` } } } },
    ...(funnelOn ? { AllowFunnel: { [`${tailnet.host}:443`]: true } } : {}),
  });

  it('via the LAN: 409 and nothing changes; confirmed, the LAN closes only after the grace', async () => {
    const configDir = tempDir();
    r = await run({ connector: 'lan', configDir });
    const port = portOf(r);
    await lanListening(port);
    const cookie = await session(r);
    const fromLan = { cookie, host: `127.0.0.2:${port}`, origin: `http://127.0.0.2:${port}` };
    for (const [url, payload] of [
      ['/api/cld/connector/setup', { choice: 'local' }],
      ['/api/cld/connector/enable', { connector: 'local' }],
    ] as const) {
      const refused = await r.server.app.inject({ method: 'POST', url, headers: fromLan, payload });
      expect(refused.statusCode, url).toBe(409);
      expect(refused.json(), url).toMatchObject({ error: 'cut', via: 'lan', to: 'local' });
    }
    // nothing changed: no config write, no ledger, the LAN still answers, still lan
    expect(fs.existsSync(`${configDir}/config.json`)).toBe(false);
    expect(ledgerOf(configDir)).toBeNull();
    expect(await lanUp(port)).toBe(true);
    expect((await r.server.app.inject({ url: '/api/cld/connector', headers: bearer })).json()).toMatchObject({ connector: 'lan' });
    // staying on the LAN cuts nothing: no question
    const same = await r.server.app.inject({ method: 'POST', url: '/api/cld/connector/enable', headers: fromLan, payload: { connector: 'lan' } });
    expect(same.statusCode).toBe(200);

    const log = logs();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const done = await r.server.app.inject({
        method: 'POST', url: '/api/cld/connector/setup', headers: fromLan, payload: { choice: 'local', confirmCut: true },
      });
      expect(done.json()).toMatchObject({ ok: true, connector: 'local' });
      expect(await lanUp(port)).toBe(true); // the answer got out; the page can move
      await vi.advanceTimersByTimeAsync(CUT_GRACE_MS - 100);
      expect(await lanUp(port)).toBe(true);
      await vi.advanceTimersByTimeAsync(200);
      expect(await lanUp(port)).toBe(false);
    } finally {
      vi.useRealTimers();
      log.restore();
    }
    expect(log.lines).toContain('[cld remote] connector lan → local (setup local; via lan)');
    expect(log.lines.some((l) => l.startsWith('[cld remote] lan off (setup local'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${configDir}/config.json`, 'utf8'))).toMatchObject({ connector: 'local' });
  });

  it('via loopback: no question, the LAN closes at once, one log line names the host token', async () => {
    r = await run({ connector: 'lan', deps: { setupFacts: noFacts } });
    const port = portOf(r);
    await lanListening(port);
    const log = logs();
    try {
      const res = await r.server.app.inject({ method: 'POST', url: '/api/cld/connector/setup', headers: bearer, payload: { choice: 'local' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, connector: 'local' });
    } finally {
      log.restore();
    }
    expect(await lanUp(port)).toBe(false);
    expect(log.lines).toContain('[cld remote] connector lan → local (setup local; via local; host token)');
    expect(log.lines).toContain('[cld remote] lan off (setup local)');
  });

  it('S-10: turning the LAN off closes the WebSockets that came in over it', async () => {
    r = await run({ connector: 'lan', deps: { setupFacts: noFacts } });
    const port = portOf(r);
    await lanListening(port);
    const { code } = r.auth.createLoginCode('link');
    const login = await fetch(`http://127.0.0.2:${port}/login?code=${code}`, { redirect: 'manual' });
    const cookie = cookies(login.headers.getSetCookie());
    const ws = new WebSocket(`ws://127.0.0.2:${port}/ws`, { headers: { cookie } });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    const res = await r.server.app.inject({ method: 'POST', url: '/api/cld/connector/setup', headers: bearer, payload: { choice: 'local' } });
    expect(res.statusCode).toBe(200);
    await waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED), { timeout: 3000 });
    await closed;
  });

  it('a LAN socket with a forged tailscale Host is still the LAN: LAN → Tailscale asks first', async () => {
    r = await run({ connector: 'lan', allowedHosts: [tailnet.host], deps: { tailscaleServe: servePointingAt(() => portOf(r!)) } });
    const port = portOf(r);
    await lanListening(port);
    const cookie = await session(r);
    const payload = JSON.stringify({ choice: 'tailscale' });
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.2', port, method: 'POST', path: '/api/cld/connector/setup', agent: false,
        headers: {
          host: tailnet.host, origin: `http://${tailnet.host}`, cookie,
          'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
        },
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end(payload);
    });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'cut', via: 'lan' });
    expect(await lanUp(port)).toBe(true);
  });

  it('via tailscale serve: 409 for a switch that drops tailscale', async () => {
    r = await run({ connector: 'tailscale', allowedHosts: [tailnet.host], deps: { tailscaleServe: servePointingAt(() => portOf(r!)) } });
    const cookie = await session(r);
    const res = await r.server.app.inject({
      method: 'POST', url: '/api/cld/connector/setup',
      headers: { ...tailnet, 'x-forwarded-proto': 'https', origin: `https://${tailnet.host}`, cookie },
      payload: { choice: 'lan' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'cut', via: 'tailscale' });
  });

  it('via the direct listener: 409; confirmed, direct stays up for the grace, then closes', async () => {
    r = await run({ connector: 'direct', deps: { setupFacts: noFacts } });
    await enableDirect(r);
    const secret = r.remote.direct?.secret ?? '';
    const { code } = r.auth.createLoginCode('qr');
    const phone = await join(r, `https://${PUBLIC}/${secret}/login?code=${code}`);
    const post = (body: Record<string, unknown>) => r!.outside(`/${secret}/api/cld/connector/setup`, {
      method: 'POST', cookie: phone, body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    });
    const refused = await post({ choice: 'local' });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({ error: 'cut', via: 'direct' });
    expect(r.remote.direct?.enabled).toBe(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const done = await post({ choice: 'local', confirmCut: true });
    expect(JSON.parse(done.body)).toMatchObject({ ok: true, connector: 'local' });
    expect(r.remote.direct?.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(CUT_GRACE_MS + 10);
    vi.useRealTimers();
    await waitFor(() => expect(r?.remote.direct?.enabled).toBe(false));
  });

  it('via direct, the temporary-address card asks first; confirmed, direct closes after the tunnel passed and the grace', async () => {
    const configDir = tempDir();
    let opened = 0;
    r = await run({
      connector: 'direct', configDir,
      deps: {
        setupFacts: async () => ({
          natKind: 'open' as const, upnp: true, wslMode: null, relayReady: false,
          tailscaleInstalled: false, tailscaleLoggedIn: false, cloudflaredInstalled: true,
        }),
        setupTunnel: async (_target, secret) => {
          opened += 1;
          return { url: `https://new.trycloudflare.com/${secret}/`, close: async () => undefined };
        },
        setupSelfTest: async (url) => ({ ok: true, url, checkedAt: 1, steps: [{ ok: true, text: 'fake outside check' }] }),
      },
    });
    await enableDirect(r);
    const secret = r.remote.direct?.secret ?? '';
    const { code } = r.auth.createLoginCode('qr');
    const phone = await join(r, `https://${PUBLIC}/${secret}/login?code=${code}`);
    proveSession(r.auth, phone);
    const post = (body: Record<string, unknown>) => r!.outside(`/${secret}/api/cld/connector/setup`, {
      method: 'POST', cookie: phone, body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    });
    const config = () => JSON.parse(fs.readFileSync(`${configDir}/config.json`, 'utf8')) as Record<string, unknown>;
    const refused = await post({ choice: 'tunnel' });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({ error: 'cut', via: 'direct', to: 'tunnel' });
    expect(opened).toBe(0);
    expect(ledgerOf(configDir)).toBeNull();
    expect(config()).toMatchObject({ connector: 'direct' });
    expect(r.remote.direct?.enabled).toBe(true);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const done = await post({ choice: 'tunnel', confirmCut: true });
    expect(JSON.parse(done.body)).toMatchObject({ ok: true, connector: 'tunnel' });
    expect(opened).toBe(1);
    expect(config()).toMatchObject({ connector: 'local' }); // a restart leaves only this PC
    expect(ledgerOf(configDir)).toMatchObject([{ kind: 'tunnel' }]);
    expect(r.remote.direct?.enabled).toBe(true); // the answer still gets out through direct
    await vi.advanceTimersByTimeAsync(CUT_GRACE_MS + 10);
    vi.useRealTimers();
    await waitFor(() => expect(r?.remote.direct?.enabled).toBe(false));
    expect(ledgerOf(configDir)).toMatchObject([{ kind: 'tunnel' }]); // the tunnel stays
  });

  describe('the ledger: tailscale → direct', () => {
    const setupFacts = async () => ({
      natKind: 'open' as const, upnp: true, wslMode: null, relayReady: false,
      tailscaleInstalled: true, tailscaleLoggedIn: true, cloudflaredInstalled: false,
    });
    const start = async (options: { ledger: boolean; servePort?: number; outside: { ok: boolean } }) => {
      const configDir = tempDir();
      const ts = fakeTailscale();
      const commands = ts.commands;
      r = await run({
        connector: 'tailscale', configDir, allowedHosts: [tailnet.host],
        deps: {
          setupFacts,
          tailscaleServe: ts.tailscaleServe,
          setupCommand: ts.setupCommand,
          setupSelfTest: async (url) => ({ ok: options.outside.ok, url, checkedAt: 1, steps: [{ ok: options.outside.ok, text: 'fake outside check' }] }),
        },
      });
      ts.set({ port: options.servePort ?? portOf(r), funnel: false });
      if (options.ledger)
        fs.writeFileSync(`${configDir}/exposure.json`, JSON.stringify({ v: 1, entries: [
          { kind: 'tailscale', host: tailnet.host, port: portOf(r), funnel: false, by: 'installer', at: 1 },
        ] }));
      return { configDir, commands };
    };
    const toDirect = () => r!.server.app.inject({ method: 'POST', url: '/api/cld/connector/setup', headers: bearer, payload: { choice: 'direct' } });

    it('serve goes off only after direct passed its outside check', async () => {
      const outside = { ok: false };
      const { configDir, commands } = await start({ ledger: true, outside });
      expect((await toDirect()).json()).toMatchObject({ ok: false });
      expect(commands.filter((c) => c.endsWith('off'))).toEqual([]);
      expect(ledgerOf(configDir)).toHaveLength(1);
      expect(r?.remote.direct?.enabled).toBe(false);
      outside.ok = true;
      const log = logs();
      try {
        expect((await toDirect()).json()).toMatchObject({ ok: true, connector: 'direct' });
      } finally {
        log.restore();
      }
      expect(commands.filter((c) => c.endsWith('off'))).toEqual(['tailscale serve --https=443 off']);
      expect(ledgerOf(configDir)).toEqual([]);
      expect(log.lines).toContain('[cld remote] connector tailscale → direct (setup direct; via local; host token)');
      expect(log.lines).toContain('[cld remote] tailscale serve off (setup direct)');
    });

    it('a serve config that is not in the ledger is never touched', async () => {
      const { commands } = await start({ ledger: false, outside: { ok: true } });
      expect((await toDirect()).json()).toMatchObject({ ok: true, connector: 'direct' });
      expect(commands.filter((c) => c.endsWith('off'))).toEqual([]);
    });

    it('a serve that no longer points at our port: the entry goes, the config stays', async () => {
      const { configDir, commands } = await start({ ledger: true, servePort: 9, outside: { ok: true } });
      expect((await toDirect()).json()).toMatchObject({ ok: true, connector: 'direct' });
      expect(commands.filter((c) => c.endsWith('off'))).toEqual([]);
      expect(ledgerOf(configDir)).toEqual([]);
    });
  });

  it('startup reverts a stale tailscale entry the configured connector does not want', async () => {
    const configDir = tempDir();
    fs.writeFileSync(`${configDir}/exposure.json`, JSON.stringify({ v: 1, entries: [
      { kind: 'tailscale', host: tailnet.host, port: 18240, funnel: true, by: 'installer', at: 1 },
    ] }));
    const ts = fakeTailscale();
    ts.set({ port: 18240, funnel: true });
    const log = logs();
    try {
      r = await run({ connector: 'local', configDir, deps: { tailscaleServe: ts.tailscaleServe, setupCommand: ts.setupCommand } });
      await waitFor(() => expect(ledgerOf(configDir)).toEqual([]));
    } finally {
      log.restore();
    }
    expect(ts.commands).toEqual(['tailscale funnel --https=443 off']);
    expect(ts.live()).toBeNull();
    expect(log.lines).toContain('[cld remote] tailscale funnel off (startup)');
  });

  describe('Serve ↔ Funnel on our one 443 handler converges in place', () => {
    const facts = async () => ({
      natKind: 'cgnat' as const, upnp: false, wslMode: null, relayReady: false,
      tailscaleInstalled: true, tailscaleLoggedIn: true, cloudflaredInstalled: false,
    });
    const start = async (from: { funnel: boolean } | 'foreign', serveClearsFunnel: boolean, outside = { ok: true }) => {
      const configDir = tempDir();
      fs.writeFileSync(`${configDir}/config.json`, JSON.stringify({ funnel: from !== 'foreign' && from.funnel }));
      const ts = fakeTailscale(serveClearsFunnel);
      r = await run({
        connector: 'tailscale', configDir, allowedHosts: [tailnet.host],
        deps: {
          setupFacts: facts, setupCommand: ts.setupCommand, tailscaleServe: ts.tailscaleServe,
          setupSelfTest: async (url) => ({ ok: outside.ok, url, checkedAt: 1, steps: [{ ok: outside.ok, text: 'fake outside check' }] }),
        },
      });
      const port = portOf(r);
      ts.set(from === 'foreign' ? { port: 9, funnel: false } : { port, funnel: from.funnel });
      if (from !== 'foreign')
        fs.writeFileSync(`${configDir}/exposure.json`, JSON.stringify({ v: 1, entries: [
          { kind: 'tailscale', host: tailnet.host, port, funnel: from.funnel, by: 'installer', at: 1 },
        ] }));
      const setup = (choice: string) => r!.server.app.inject({ method: 'POST', url: '/api/cld/connector/setup', headers: bearer, payload: { choice } });
      return { configDir, ts, port, setup };
    };

    for (const serveClearsFunnel of [true, false]) {
      const variant = serveClearsFunnel ? '`serve --bg` clears Funnel' : '`serve --bg` leaves Funnel on';
      it(`Funnel → Serve ends serve-only (${variant}); one entry, updated in place`, async () => {
        const { configDir, ts, port, setup } = await start({ funnel: true }, serveClearsFunnel);
        expect((await setup('tailscale')).json()).toMatchObject({ ok: true, connector: 'tailscale' });
        expect(ts.live()).toEqual({ port, funnel: false });
        expect(ledgerOf(configDir)).toMatchObject([{ kind: 'tailscale', port, funnel: false }]);
        expect(JSON.parse(fs.readFileSync(`${configDir}/config.json`, 'utf8'))).toMatchObject({ connector: 'tailscale', funnel: false });
        const target = `http://127.0.0.1:${port}`;
        expect(ts.commands.filter((c) => c !== 'tailscale status --json')).toEqual(serveClearsFunnel
          ? [`tailscale serve --bg --https=443 ${target}`]
          : [`tailscale serve --bg --https=443 ${target}`, 'tailscale funnel --https=443 off', `tailscale serve --bg --https=443 ${target}`]);
      });

      it(`a Funnel try that fails its check goes back to Serve in place (${variant})`, async () => {
        const { configDir, ts, port, setup } = await start({ funnel: false }, serveClearsFunnel, { ok: false });
        expect((await setup('funnel')).json()).toMatchObject({ ok: false });
        expect(ts.live()).toEqual({ port, funnel: false });
        expect(ledgerOf(configDir)).toMatchObject([{ kind: 'tailscale', port, funnel: false }]);
      });
    }

    it('Serve → Funnel: `funnel --bg`, verified, the entry updated in place, nothing turned off', async () => {
      const { configDir, ts, port, setup } = await start({ funnel: false }, true);
      expect((await setup('funnel')).json()).toMatchObject({ ok: true, connector: 'funnel' });
      expect(ts.live()).toEqual({ port, funnel: true });
      expect(ledgerOf(configDir)).toMatchObject([{ kind: 'tailscale', port, funnel: true }]);
      expect(ts.commands.filter((c) => c.endsWith('off'))).toEqual([]);
    });

    for (const wantFunnel of [false, true]) {
      it(`\`${wantFunnel ? 'funnel' : 'serve'} --bg\` succeeds but the status read fails: the exposure is recorded, never lost`, async () => {
        const configDir = tempDir();
        const ts = fakeTailscale();
        r = await run({
          connector: 'local', configDir,
          deps: {
            setupFacts: facts, setupCommand: ts.setupCommand, tailscaleServe: ts.tailscaleServe,
            setupSelfTest: async (url) => ({ ok: true, url, checkedAt: 1, steps: [{ ok: true, text: 'fake outside check' }] }),
          },
        });
        const port = portOf(r);
        ts.failReadsAfterBg();
        const res = await r.server.app.inject({ method: 'POST', url: '/api/cld/connector/setup', headers: bearer, payload: { choice: wantFunnel ? 'funnel' : 'tailscale' } });
        expect(res.json()).toMatchObject({ ok: false });
        expect(ts.live()).toEqual({ port, funnel: wantFunnel }); // it is on
        expect(ledgerOf(configDir)).toMatchObject([{ kind: 'tailscale', host: tailnet.host, port, funnel: wantFunnel }]);
        // once the status reads again, the next change reverts it (local does not want it)
        ts.healReads();
        await r.server.app.inject({ method: 'POST', url: '/api/cld/connector/setup', headers: bearer, payload: { choice: 'local' } });
        expect(ts.live()).toBeNull();
        expect(ledgerOf(configDir)).toEqual([]);
      });
    }

    it('a 443 handler that is not ours is never touched', async () => {
      const { ts, setup } = await start('foreign', true);
      expect((await setup('tailscale')).json()).toMatchObject({ ok: false });
      expect(ts.live()).toEqual({ port: 9, funnel: false });
      expect(ts.commands.filter((c) => c !== 'tailscale status --json')).toEqual([]);
    });
  });

  it('the Funnel card: `tailscale funnel`, checked on, written to the config and the ledger', async () => {
    const configDir = tempDir();
    const commands: string[] = [];
    let funnelOn = false;
    r = await run({
      connector: 'local', configDir,
      deps: {
        setupFacts: async () => ({
          natKind: 'cgnat' as const, upnp: false, wslMode: null, relayReady: false,
          tailscaleInstalled: true, tailscaleLoggedIn: true, cloudflaredInstalled: false,
        }),
        setupCommand: async (command, args) => {
          commands.push([command, ...args].join(' '));
          if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${tailnet.host}.` } });
          if (args[0] === 'funnel') funnelOn = true;
          return '';
        },
        tailscaleServe: async () => (funnelOn ? servePointingAt(() => portOf(r!), true)() : {}),
        setupSelfTest: async (url) => ({ ok: true, url, checkedAt: 1, steps: [{ ok: true, text: 'fake outside check' }] }),
      },
    });
    const port = portOf(r);
    const log = logs();
    let res;
    try {
      res = await r.server.app.inject({ method: 'POST', url: '/api/cld/connector/setup', headers: bearer, payload: { choice: 'funnel' } });
    } finally {
      log.restore();
    }
    expect(res.json()).toMatchObject({ ok: true, connector: 'funnel', url: `https://${tailnet.host}/` });
    expect(commands).toContain(`tailscale funnel --bg --https=443 http://127.0.0.1:${port}`);
    expect(JSON.parse(fs.readFileSync(`${configDir}/config.json`, 'utf8'))).toMatchObject({ connector: 'tailscale', funnel: true });
    expect(ledgerOf(configDir)).toMatchObject([{ kind: 'tailscale', host: tailnet.host, port, funnel: true, by: 'daemon' }]);
    expect(fs.statSync(`${configDir}/exposure.json`).mode & 0o777).toBe(0o600);
    expect(log.lines).toContain('[cld remote] tailscale funnel on (setup funnel)');
    expect(log.lines).toContain('[cld remote] connector local → tailscale funnel (setup funnel; via local; host token)');
  });

  describe('a recorded tunnel pid (fake /proc, fake kill)', () => {
    const procStat = (start: string) => `4242 (cloudflared) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 9 0 ${start} 123456 789`;
    const ourArgv = `${['cloudflared', ...cloudflaredArgs(40001)].join('\0')}\0`;
    const entry = { kind: 'tunnel', url: 'https://old.trycloudflare.com/s/', pid: 4242, localPort: 40001, startTime: '987654', by: 'daemon', at: 1 };
    for (const [name, start, cmdline, killed] of [
      ['a reused pid (another start time): not killed', '555', ourArgv, []],
      ['the same start time but another argv: not killed', '987654', 'cloudflared\0tunnel\0run\0my-named-tunnel\0', []],
      ['our process, exactly: killed', '987654', ourArgv, [4242]],
    ] as const) {
      it(name, async () => {
        const configDir = tempDir();
        fs.writeFileSync(`${configDir}/exposure.json`, JSON.stringify({ v: 1, entries: [entry] }));
        const kills: number[] = [];
        r = await run({
          connector: 'local', configDir,
          deps: { procFile: (_pid, file) => (file === 'stat' ? procStat(start) : cmdline), killTunnel: (pid) => void kills.push(pid) },
        });
        await waitFor(() => expect(ledgerOf(configDir)).toEqual([]));
        expect(kills).toEqual(killed);
      });
    }

    it('the tunnel records its start time and local port when it opens; the argv matches the ledger', async () => {
      const { tunnelArgv } = await import('../../../../core/src/exposureLedger.mjs');
      expect(['cloudflared', ...cloudflaredArgs(40001)]).toEqual(tunnelArgv(40001));
      const configDir = tempDir();
      r = await run({
        connector: 'local', configDir,
        deps: {
          setupFacts: async () => ({
            natKind: 'cgnat' as const, upnp: false, wslMode: null, relayReady: false,
            tailscaleInstalled: false, tailscaleLoggedIn: false, cloudflaredInstalled: true,
          }),
          setupTunnel: async (_target, secret) => ({ url: `https://new.trycloudflare.com/${secret}/`, pid: 4242, localPort: 40001, close: async () => undefined }),
          setupSelfTest: async (url) => ({ ok: true, url, checkedAt: 1, steps: [{ ok: true, text: 'fake outside check' }] }),
          procFile: (_pid, file) => (file === 'stat' ? procStat('987654') : ourArgv),
          killTunnel: () => { throw new Error('no kill here'); },
        },
      });
      const res = await r.server.app.inject({ method: 'POST', url: '/api/cld/connector/setup', headers: bearer, payload: { choice: 'tunnel' } });
      expect(res.json()).toMatchObject({ ok: true, connector: 'tunnel' });
      expect(ledgerOf(configDir)).toMatchObject([{ kind: 'tunnel', pid: 4242, localPort: 40001, startTime: '987654' }]);
    });
  });

  it('S-22: a closed tunnel\'s name leaves the Host allowlist', async () => {
    r = await run({
      connector: 'local',
      deps: {
        setupFacts: async () => ({
          natKind: 'cgnat' as const, upnp: false, wslMode: null, relayReady: false,
          tailscaleInstalled: false, tailscaleLoggedIn: false, cloudflaredInstalled: true,
        }),
        setupTunnel: async (_target, secret) => ({ url: `https://old.trycloudflare.com/${secret}/`, close: async () => undefined }),
        setupSelfTest: async (url) => ({ ok: true, url, checkedAt: 1, steps: [{ ok: true, text: 'fake outside check' }] }),
      },
    });
    // The page's CSP names a Host only while the allowlist holds it.
    const { code } = r.auth.createLoginCode('link');
    const login = await r.server.app.inject({ url: `/login?code=${code}` });
    const cookie = cookies(login.headers['set-cookie'] as string[] | string);
    const allowed = async () =>
      String((await r!.server.app.inject({ url: '/', headers: { host: 'old.trycloudflare.com', cookie } })).headers['content-security-policy']).includes('old.trycloudflare.com');
    const setup = (choice: string) => r!.server.app.inject({ method: 'POST', url: '/api/cld/connector/setup', headers: bearer, payload: { choice } });
    expect((await setup('tunnel')).json()).toMatchObject({ ok: true, connector: 'tunnel' });
    expect(await allowed()).toBe(true);
    expect((await setup('local')).json()).toMatchObject({ ok: true });
    expect(await allowed()).toBe(false);
  });

  for (const [name, old] of [
    ['broken', '{"v":1,"entries":[{"kind":"tail'],
    ['newer', JSON.stringify({ v: 2, entries: [{ kind: 'tailscale', host: tailnet.host, port: 18240, funnel: true }] })],
  ] as const) {
    it(`a ${name} exposure ledger is moved aside with a warning, never overwritten`, async () => {
      const configDir = tempDir();
      fs.writeFileSync(`${configDir}/exposure.json`, old);
      const warned: string[] = [];
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.join(' ')));
      try {
        r = await run({
          connector: 'local', configDir,
          deps: {
            setupFacts: async () => ({
              natKind: 'cgnat' as const, upnp: false, wslMode: null, relayReady: false,
              tailscaleInstalled: false, tailscaleLoggedIn: false, cloudflaredInstalled: true,
            }),
            setupTunnel: async (_target, secret) => ({ url: `https://new.trycloudflare.com/${secret}/`, close: async () => undefined }),
            setupSelfTest: async (url) => ({ ok: true, url, checkedAt: 1, steps: [{ ok: true, text: 'fake outside check' }] }),
          },
        });
        const res = await r.server.app.inject({ method: 'POST', url: '/api/cld/connector/setup', headers: bearer, payload: { choice: 'tunnel' } });
        expect(res.json()).toMatchObject({ ok: true });
      } finally {
        spy.mockRestore();
      }
      const aside = fs.readdirSync(configDir).filter((f) => f.startsWith('exposure.json.bad-'));
      expect(aside).toHaveLength(1);
      expect(fs.readFileSync(`${configDir}/${aside[0]}`, 'utf8')).toBe(old);
      expect(ledgerOf(configDir)).toMatchObject([{ kind: 'tunnel' }]);
      expect(warned.some((l) => l.includes('moved to') && l.includes('exposure.json.bad-'))).toBe(true);
    });
  }

  it("the ledger's portproxy undo lines are the relay's own", async () => {
    const { portproxyRemoveCommands } = await import('../../../../core/src/exposureLedger.mjs');
    expect(portproxyRemoveCommands(443)).toEqual(relayCommands(18443, 443).remove);
  });
});

describe('S1: opening something wider needs a fresh step-up', () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.remote.dispose();
    await r?.server.app.close();
    r = undefined;
    for (const hook of ['registerRoutes', 'onListening', 'canonicalUrl'] as const)
      delete cldHooks[hook];
  });
  const bearer = { authorization: `Bearer ${TOKEN}` };
  /** A logged-in browser session on this PC: a cookie only, no step-up. */
  const cookieOnly = async (running: Running) => {
    const { code } = running.auth.createLoginCode('qr');
    const login = await running.server.app.inject({ url: `/login?code=${code}` });
    const cookie = cookies(login.headers['set-cookie'] as string[] | string);
    return { cookie, origin: 'http://localhost:80', host: 'localhost:80' };
  };
  const post = (running: Running, url: string, headers: Record<string, string>, payload: object = {}) =>
    running.server.app.inject({ method: 'POST', url, headers, payload });
  const connectorOf = async (running: Running) =>
    (await running.server.app.inject({ url: '/api/cld/connector', headers: bearer })).json<{ connector: string }>().connector;
  const enable = (running: Running, headers: Record<string, string>, connector: string) =>
    post(running, '/api/cld/connector/enable', headers, { connector });

  it('local → LAN: refused on a cookie alone, allowed inside the window, refused again after it; the host token is unchanged', async () => {
    r = await run({ connector: 'local' });
    const who = await cookieOnly(r);
    const refused = await enable(r, who, 'lan');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'stepup' });
    expect(await connectorOf(r)).toBe('local');
    const session = r.auth.session(/cld_session=([^;]+)/.exec(who.cookie)![1])!;
    session.shellProofAt = Date.now() - 30_000;
    expect((await enable(r, who, 'lan')).statusCode).toBe(200);
    expect(await connectorOf(r)).toBe('lan');
    // narrowing needs nothing, even with the proof long gone
    session.shellProofAt = Date.now() - 121_000;
    expect((await enable(r, who, 'local')).statusCode).toBe(200);
    expect(await connectorOf(r)).toBe('local');
    // the window is over: widening is refused again
    expect((await enable(r, who, 'lan')).statusCode).toBe(403);
    expect(await connectorOf(r)).toBe('local');
    // the host's Bearer token is not a browser session
    expect((await enable(r, bearer, 'lan')).statusCode).toBe(200);
    expect(await connectorOf(r)).toBe('lan');
  });

  it('every way out to the internet asks: the setup choices tunnel, funnel and direct', async () => {
    const opened = vi.fn();
    r = await run({ connector: 'local', deps: { setupTunnel: async () => { opened(); throw new Error('must not open'); } } });
    const who = await cookieOnly(r);
    for (const choice of ['tunnel', 'funnel', 'direct', 'duckdns', 'lan', 'tailscale']) {
      const res = await post(r, '/api/cld/connector/setup', who, { choice });
      expect(res.statusCode, choice).toBe(403);
      expect(res.json(), choice).toEqual({ error: 'stepup' });
    }
    expect(opened).not.toHaveBeenCalled();
    expect(await connectorOf(r)).toBe('local');
    expect(r.remote.direct?.enabled).toBe(false);
  });

  it('S-22: repointing DuckDNS (a name or token) asks even when direct is already on', async () => {
    const configDir = tempDir();
    r = await run({ connector: 'direct', configDir, deps: { setupFacts: noFacts } });
    await enableDirect(r);
    const who = await cookieOnly(r);
    const res = await post(r, '/api/cld/connector/setup', who, {
      choice: 'duckdns', duckdnsName: 'evil.duckdns.org', duckdnsToken: 'abcdefgh-1234',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'stepup' });
    expect(fs.existsSync(`${configDir}/tls/ddns.json`)).toBe(false);
  });

  it('the order is step-up, then the S6 cut guard, then the change', async () => {
    r = await run({ connector: 'lan' });
    const port = (r.server.app.server.address() as net.AddressInfo).port;
    const who = await cookieOnly(r);
    const fromLan = { ...who, host: `127.0.0.2:${port}`, origin: `http://127.0.0.2:${port}` };
    // a temporary address is wider and would close the LAN this page came through
    const first = await post(r, '/api/cld/connector/setup', fromLan, { choice: 'tunnel' });
    expect(first.statusCode).toBe(403);
    expect(first.json()).toEqual({ error: 'stepup' });
    r.auth.session(/cld_session=([^;]+)/.exec(who.cookie)![1])!.shellProofAt = Date.now();
    const second = await post(r, '/api/cld/connector/setup', fromLan, { choice: 'tunnel' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'cut', via: 'lan', to: 'tunnel' });
    expect(await connectorOf(r)).toBe('lan');
  });

  it('rotating the direct secret path asks; the host token does not', async () => {
    r = await run({ connector: 'direct' });
    await enableDirect(r);
    const secret = r.remote.direct?.secret ?? '';
    const who = await cookieOnly(r);
    const refused = await post(r, '/api/cld/connector/rotate', who);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'stepup' });
    expect(r.remote.direct?.secret).toBe(secret);
    r.auth.session(/cld_session=([^;]+)/.exec(who.cookie)![1])!.shellProofAt = Date.now();
    expect((await post(r, '/api/cld/connector/rotate', who)).statusCode).toBe(200);
    const rotated = r.remote.direct?.secret;
    expect(rotated).not.toBe(secret);
    expect((await post(r, '/api/cld/connector/rotate', bearer)).statusCode).toBe(200);
    expect(r.remote.direct?.secret).not.toBe(rotated);
  });

  it('O3: the record keeps the direct lockout, the connector and exposure changes and a rotated secret path', async () => {
    const configDir = tempDir();
    r = await run({ connector: 'local', deviceKeys: true, configDir });
    await enableDirect(r);
    const secret = r.remote.direct?.secret ?? '';
    for (let i = 0; i < 10; i += 1)
      await r.outside(`/${secret}/login`, {
        method: 'POST',
        cookie: `cld_gate=${secret}`,
        body: `code=${String(10_000_000 + i)}`,
        from: `127.0.0.${10 + i}`,
      });
    expect((await post(r, '/api/cld/connector/rotate', bearer)).statusCode).toBe(200);
    const mine = (dir: string) => auditLog(dir).read(0, 50).lines.reverse();
    expect(mine(configDir).map((l) => [l.kind, l.detail, l.by, l.via])).toEqual(
      expect.arrayContaining([
        ['exposure', 'direct on', undefined, undefined],
        ['exposure', 'lan on', undefined, undefined],
        ['connector', 'local>direct', 'host', 'local'],
        ['tokenRotated', 'path', 'host', 'local'],
      ]),
    );
    expect(fs.readFileSync(path.join(configDir, 'audit.jsonl'), 'utf8')).not.toContain(secret);
    expect(r.auth.audit.read(0, 5).lines).toMatchObject([{ kind: 'lockout', detail: 'direct', via: 'remote' }]);
  });

  it('step-up, then a widening with confirmCut, then the move code: one proof covers all three', async () => {
    let opened = 0;
    r = await run({
      connector: 'direct',
      deviceKeys: true,
      deps: {
        setupFacts: async () => ({
          natKind: 'open' as const, upnp: true, wslMode: null, relayReady: false,
          tailscaleInstalled: false, tailscaleLoggedIn: false, cloudflaredInstalled: true,
        }),
        setupTunnel: async (_target, secret) => {
          opened += 1;
          return { url: `https://new.trycloudflare.com/${secret}/`, close: async () => undefined };
        },
        setupSelfTest: async (url) => ({ ok: true, url, checkedAt: 1, steps: [{ ok: true, text: 'fake outside check' }] }),
      },
    });
    await enableDirect(r);
    const secret = r.remote.direct?.secret ?? '';
    const { code } = r.auth.createLoginCode('qr');
    const phone = await join(r, `https://${PUBLIC}/${secret}/login?code=${code}`);
    const device = await SoftDevice.create();
    const json = { 'content-type': 'application/json' };
    const registered = await r.outside('/api/auth/device', {
      method: 'POST', cookie: phone, headers: json,
      body: JSON.stringify({ deviceId: device.id, publicKey: await device.publicKey() }),
    });
    expect(registered.status).toBe(200);
    const post = (url: string, body: Record<string, unknown> = {}) =>
      r!.outside(`/${secret}${url}`, { method: 'POST', cookie: phone, headers: json, body: JSON.stringify(body) });
    // no proof yet: widening is refused before the cut question, the move code too
    expect(JSON.parse((await post('/api/cld/connector/setup', { choice: 'tunnel', confirmCut: true })).body)).toEqual({ error: 'stepup' });
    expect(opened).toBe(0);
    expect(JSON.parse((await post('/api/auth/move-code')).body)).toEqual({ error: 'stepup' });
    // one step-up, then the confirmed widening and the move code, with no second prompt
    proveSession(r.auth, phone);
    const widened = await post('/api/cld/connector/setup', { choice: 'tunnel', confirmCut: true });
    expect(JSON.parse(widened.body)).toMatchObject({ ok: true, connector: 'tunnel' });
    expect(opened).toBe(1);
    const move = await post('/api/auth/move-code');
    expect(move.status).toBe(200);
    expect(JSON.parse(move.body).url).toMatch(/^https:\/\/new\.trycloudflare\.com\/.+\/login\?code=/);
  });
});

describe('REMOTE-XPLAT: each platform gets its own firewall step, and turning off says what is left', () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.remote.dispose();
    await r?.server.app.close();
    r = undefined;
    for (const hook of ['registerRoutes', 'onListening', 'canonicalUrl'] as const) delete cldHooks[hook];
  });
  const bearer = { authorization: `Bearer ${TOKEN}` };
  type Outcome = { ok: boolean; pending?: boolean; steps: Array<{ ok: boolean; text: string; confirm?: boolean; guide?: string; actions?: Array<{ text?: string }> }> };
  const setup = async (payload: Record<string, unknown>) =>
    (await r!.server.app.inject({ method: 'POST', url: '/api/cld/connector/setup', headers: bearer, payload })).json<Outcome>();
  const portOf = () => (r!.server.app.server.address() as net.AddressInfo).port;
  const commandsOf = (o: Outcome) => o.steps.flatMap((step) => step.actions ?? []).map((a) => a.text).join('\n');

  it('Linux with ufw on: the LAN waits for "I ran it" (no timer), then opens; off names the exact undo', async () => {
    const configDir = tempDir();
    r = await run({ connector: 'local', configDir, deps: { platform: 'linux', readFile: (f) => (f === '/etc/ufw/ufw.conf' ? 'ENABLED=yes\n' : null) } });
    const port = portOf();
    const first = await setup({ choice: 'lan' });
    expect(first).toMatchObject({ ok: false, pending: false });
    expect(first.steps[0]).toMatchObject({ text: 'ufw 방화벽이 켜져 있어 바깥에서 오는 연결을 막아요', confirm: true });
    expect(commandsOf(first)).toBe(`sudo ufw allow ${port}/tcp`);
    expect(await lanUp(port)).toBe(false); // nothing opened before the firewall step
    const done = await setup({ choice: 'lan', firewallDone: true });
    expect(done.ok).toBe(true);
    await lanListening(port);
    expect(JSON.parse(fs.readFileSync(`${configDir}/config.json`, 'utf8')).firewallAck).toEqual({ kind: 'ufw', ports: [port] });
    // Asked once: the next run goes straight through.
    expect((await setup({ choice: 'lan' })).ok).toBe(true);
    const off = await setup({ choice: 'local' });
    expect(off.ok).toBe(true);
    const left = off.steps.find((step) => step.text.startsWith('방화벽 규칙은'));
    expect(left?.actions?.[0].text).toBe(`sudo ufw delete allow ${port}/tcp`);
    expect(left?.guide).toContain('터미널');
  });

  it('native Windows: the rule is read back (no confirm), so the page re-checks by itself; off removes only rules that exist', async () => {
    let rules = '';
    r = await run({ connector: 'local', deps: { platform: 'win32', setupCommand: async (command) => (command === 'powershell.exe' ? rules : null) } });
    const port = portOf();
    const first = await setup({ choice: 'lan' });
    expect(first).toMatchObject({ ok: false, pending: true });
    expect(first.steps[0].confirm).toBeUndefined();
    expect(commandsOf(first)).toBe(`Remove-NetFirewallRule -Name cld-gui-${port} -ErrorAction SilentlyContinue; New-NetFirewallRule -Name cld-gui-${port} -DisplayName "cld-gui ${port}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow`);
    expect(first.steps[0].guide).toContain('관리자 PowerShell');
    rules = `cld-gui-${port}\r\n`;
    expect((await setup({ choice: 'lan' })).ok).toBe(true);
    const off = await setup({ choice: 'local' });
    const left = off.steps.find((step) => step.text.startsWith('방화벽 규칙은'));
    expect(left?.actions?.[0].text).toBe(`Remove-NetFirewallRule -Name cld-gui-${port} -ErrorAction SilentlyContinue`);
  });

  it('WSL mirrored: direct asks for the Hyper-V rule, never a portproxy', async () => {
    r = await run({ connector: 'local', deps: { platform: 'linux', wslMode: async () => 'mirrored', setupCommand: async (command) => (command === 'powershell.exe' ? '' : null) } });
    const first = await setup({ choice: 'direct' });
    expect(first.pending).toBe(true);
    expect(first.steps[0].text).toBe('WSL mirrored 모드라 Windows 방화벽(Hyper-V)이 바깥에서 오는 연결을 막아요');
    expect(commandsOf(first)).toContain('New-NetFirewallHyperVRule');
    expect(commandsOf(first)).not.toContain('portproxy');
  });

  it('Linux and macOS with no firewall on: no firewall step at all', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      r = await run({ connector: 'local', deps: { platform } });
      expect((await setup({ choice: 'lan' })).ok, platform).toBe(true);
      await r.remote.dispose();
      await r.server.app.close();
      for (const hook of ['registerRoutes', 'onListening', 'canonicalUrl'] as const) delete cldHooks[hook];
      r = undefined;
    }
  });

  it('a router forward made by hand: turning off says this PC cannot remove it', async () => {
    r = await run({ connector: 'local', deps: { findGateway: async () => null } });
    const on = await r.server.app.inject({ method: 'POST', url: '/api/cld/connector/enable', headers: bearer, payload: { connector: 'direct', options: { manualForward: true } } });
    expect(on.json()).toMatchObject({ ok: true });
    const off = await setup({ choice: 'local' });
    expect(off.steps.map((step) => step.text)).toContain(
      '공유기에 손으로 넣은 포트 포워드(외부 443)는 이 PC가 지울 수 없어요. 더 쓰지 않으면 공유기 관리 화면에서 지우세요',
    );
  });

  it('the scan route lists what is there, and the SSH card names the SSH that already answers (no server install line)', async () => {
    r = await run({
      connector: 'local',
      deps: {
        platform: 'linux',
        lanIp: '127.0.0.2',
        readFile: (f) => (f === '/etc/ssh/sshd_config' ? 'Port 2233\n' : null),
        sshd: async (p) => ({ open: p === 2233, banner: 'SSH-2.0-OpenSSH_9.6p1' }),
      },
    });
    const port = portOf();
    const found = (await r.server.app.inject({ url: '/api/cld/connector/existing', headers: bearer })).json<{ found: Outcome['steps'] }>().found;
    expect(found[0].text).toBe('SSH 서버가 이미 2233번에서 답해요 (SSH-2.0-OpenSSH_9.6p1)');
    const ssh = await setup({ choice: 'ssh' });
    expect(ssh.steps[0].text).toBe('이미 있는 SSH로 붙어요: 새 포트를 열지 않는 가장 비공개인 길이에요');
    expect(commandsOf(ssh)).toBe(`ssh -N -L ${port}:127.0.0.1:${port} -p 2233 ${(await import('os')).userInfo().username}@127.0.0.2`);
  });
});

describe('REMOTE-XPLAT review: the read-only scan names other machines, so a remote device needs a fresh step-up', () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.remote.dispose();
    await r?.server.app.close();
    r = undefined;
    for (const hook of ['registerRoutes', 'onListening', 'canonicalUrl'] as const) delete cldHooks[hook];
  });
  const scanned: string[] = [];
  const deps: RemoteOptions['deps'] = {
    platform: 'linux',
    sshd: async () => ({ open: true, banner: 'SSH-2.0-OpenSSH_9.6p1' }),
    setupCommand: async (command) => {
      scanned.push(command);
      return command === 'ss' ? '0 0 192.168.0.100:22 198.51.100.77:51515\n' : null;
    },
    dial: async () => { throw new Error('nothing on 443/80'); },
    findGateway: async () => ({
      ...fakeGateway(() => PUBLIC).gateway,
      entry: async (p: number) => (p === 22 ? { externalPort: 22, internalPort: 22, internalClient: '192.168.0.99', description: 'nas' } : null),
    }),
  };
  const texts = (body: string) => JSON.stringify(JSON.parse(body).found);

  it('a phone logged in from outside sees nothing until it steps up; this PC and the host token see the peers and the router', async () => {
    r = await run({ deps });
    await enableDirect(r);
    const secret = r.remote.direct?.secret ?? '';
    const { code } = r.auth.createLoginCode('qr');
    const phone = await join(r, `https://${PUBLIC}/${secret}/login?code=${code}`);
    const before = await r.outside('/api/cld/connector/existing', { cookie: phone });
    expect(before.status).toBe(200);
    expect(texts(before.body)).toBe('[]');
    proveSession(r.auth, phone);
    const after = await r.outside('/api/cld/connector/existing', { cookie: phone });
    expect(texts(after.body)).toContain('198.51.100.77');
    expect(texts(after.body)).toContain('192.168.0.99');
    const host = await r.server.app.inject({ url: '/api/cld/connector/existing', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(texts(host.body)).toContain('198.51.100.77');
  });

  it('parallel requests share one scan (no process storm)', async () => {
    r = await run({ connector: 'local', deps });
    scanned.length = 0;
    const bearer = { authorization: `Bearer ${TOKEN}` };
    await Promise.all(Array.from({ length: 5 }, () => r!.server.app.inject({ url: '/api/cld/connector/existing', headers: bearer })));
    expect(scanned.filter((c) => c === 'ss')).toHaveLength(1);
  });
});

describe('REMOTE-XPLAT review: a Windows firewall that cannot be read back', () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.remote.dispose();
    await r?.server.app.close();
    r = undefined;
    for (const hook of ['registerRoutes', 'onListening', 'canonicalUrl'] as const) delete cldHooks[hook];
  });
  const bearer = { authorization: `Bearer ${TOKEN}` };
  type Outcome = { ok: boolean; steps: Array<{ text: string; confirm?: boolean; actions?: Array<{ text?: string }> }> };
  const setup = async (payload: Record<string, unknown>) =>
    (await r!.server.app.inject({ method: 'POST', url: '/api/cld/connector/setup', headers: bearer, payload })).json<Outcome>();

  it('"I ran it" lets the LAN open, and turning off still names the undo', async () => {
    // powershell.exe unavailable (null): the rule can't be read, so the person confirms it.
    r = await run({ connector: 'local', configDir: tempDir(), deps: { platform: 'win32', setupCommand: async () => null } });
    const port = (r.server.app.server.address() as net.AddressInfo).port;
    expect((await setup({ choice: 'lan' })).steps[0].confirm).toBe(true);
    expect((await setup({ choice: 'lan', firewallDone: true })).ok).toBe(true);
    const off = await setup({ choice: 'local' });
    const left = off.steps.find((step) => step.text.startsWith('방화벽 규칙은'));
    expect(left?.actions?.[0].text).toContain(`Remove-NetFirewallRule -Name cld-gui-${port} -ErrorAction SilentlyContinue`);
    // Asked again next time: the person was just told to remove it.
    expect((await setup({ choice: 'lan' })).steps[0].confirm).toBe(true);
  });
});

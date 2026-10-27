/**
 * T-0024 direct connector: the secret path gate, the steps with a fake router
 * / STUN / issuer, renewal timing, IP changes and TLS-ALPN-01 serving. Real
 * TLS on 127.0.0.1 with a test CA; no router, STUN server or CA is contacted.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as net from 'net';
import * as tls from 'tls';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  DirectConnector,
  type DirectDeps,
  gate,
  ISSUE_RETRY_MS,
  MAINTENANCE_MS,
  newSecret,
  prefixLocation,
  renewAt,
} from './direct.js';
import { reverseDnsName } from './net.js';
import {
  cookies,
  fakeGateway,
  fakeIssuer,
  httpsGet,
  loopbackRelay,
  tempDir,
  type TestCa,
  testCa,
} from './testKit.js';

const PUBLIC = '203.0.113.7';
let ca: TestCa;
beforeAll(async () => {
  ca = await testCa();
});

describe('the secret path gate (pure)', () => {
  const secret = newSecret();

  it('a 128-bit secret, url-safe', () => {
    expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(16);
  });

  it('passes only the secret path or the gate cookie', () => {
    expect(gate(`/${secret}/login?code=x`, undefined, secret)).toEqual({
      pass: true,
      url: '/login?code=x',
      viaPath: true,
    });
    expect(gate(`/${secret}/`, undefined, secret)).toEqual({ pass: true, url: '/', viaPath: true });
    expect(gate(`/${secret}`, undefined, secret)).toEqual({ pass: true, redirect: `/${secret}/` });
    expect(gate('/api/auth/me', `a=1; cld_gate=${secret}`, secret)).toEqual({
      pass: true,
      url: '/api/auth/me',
      viaPath: false,
    });
    for (const url of [
      '/',
      '/login',
      '/api/health',
      '/manifest.webmanifest',
      `/${newSecret()}/`,
      `/${secret}x/`,
      '*',
      `http://x/${secret}/`,
    ])
      expect(gate(url, undefined, secret)).toEqual({ pass: false });
    expect(gate('/api/auth/me', `cld_gate=${newSecret()}`, secret)).toEqual({ pass: false });
  });

  it('keeps redirects under the secret path', () => {
    expect(prefixLocation('/', 's')).toBe('/s/');
    expect(prefixLocation('/login?x=1', 's')).toBe('/s/login?x=1');
    expect(prefixLocation('/s/x', 's')).toBe('/s/x');
    expect(prefixLocation('https://elsewhere/', 's')).toBe('https://elsewhere/');
    expect(prefixLocation('//elsewhere/', 's')).toBe('//elsewhere/');
  });

  it('renews at two thirds of a 160 h certificate', () => {
    const start = Date.UTC(2026, 9, 21);
    expect(renewAt(start, start + 160 * 3_600_000) - start).toBe((160 * 3_600_000 * 2) / 3);
  });
});

/** Stands in for the Fastify server: answers every forwarded request so the test sees what arrived. */
function fakeApp() {
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; encrypted: boolean }> = [];
  const upgrades: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push({
      url: req.url ?? '',
      headers: req.headers,
      encrypted: !!(req.socket as tls.TLSSocket).encrypted,
    });
    if (req.url === '/login?code=good') {
      res.writeHead(303, { location: '/', 'set-cookie': 'cld_session=abc; Path=/; HttpOnly' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`app ${req.url}`);
  });
  server.on('upgrade', (req, socket) => {
    upgrades.push(req.url ?? '');
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
  });
  return { server, seen, upgrades };
}

describe('DirectConnector', () => {
  let direct: DirectConnector | undefined;
  afterEach(async () => {
    await direct?.close();
    direct = undefined;
  });

  function connector(
    overrides: Partial<DirectDeps> & { wan?: () => string; observed?: string | null } = {},
  ) {
    const router = fakeGateway(overrides.wan ?? (() => PUBLIC));
    const issuer = fakeIssuer(ca, { now: overrides.now });
    const app = fakeApp();
    const hosts = new Set<string>();
    const logs: string[] = [];
    const dir = overrides.dir ?? tempDir();
    direct = new DirectConnector({
      dir,
      lanIp: '127.0.0.1',
      port: 0,
      listenHost: '127.0.0.1',
      target: app.server,
      hosts,
      findGateway: async () => router.gateway,
      observedIp: async () => (overrides.observed === undefined ? PUBLIC : overrides.observed),
      issue: issuer.issue,
      selfTest: async () => ({ ok: true, text: 'self-test (fake)' }),
      log: (line) => logs.push(line),
      ...overrides,
    });
    return { direct, router, issuer, app, hosts, logs, dir };
  }

  it('turns on: maps 443, listens, gets a certificate for the public IP, keeps the files private', async () => {
    const { direct, router, issuer, hosts, dir } = connector();
    const result = await direct.enable();
    expect(result.ok).toBe(true);
    expect(router.mappings).toEqual([
      { externalPort: 443, internalPort: 0, internalClient: '127.0.0.1', description: 'cld-gui' },
    ]);
    expect(issuer.requests).toEqual([{ ip: PUBLIC, name: undefined }]);
    expect(result.url).toBe(`https://${PUBLIC}/${direct.secret}/`);
    expect(hosts.has(PUBLIC)).toBe(true);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    for (const file of ['state.json', 'cert.pem', 'cert.key'])
      expect(fs.statSync(`${dir}/${file}`).mode & 0o777).toBe(0o600);
    const state = JSON.parse(fs.readFileSync(`${dir}/state.json`, 'utf8')) as {
      secret: string;
      enabled: boolean;
    };
    expect(state).toMatchObject({ enabled: true, secret: direct.secret });
  });

  it('a scanner without the secret gets an empty 404 and no WebSocket; nothing reaches the app', async () => {
    const { direct, app } = connector();
    await direct.enable();
    const port = direct.listeningPort() ?? 0;
    for (const pathname of [
      '/',
      '/login',
      '/api/health',
      '/manifest.webmanifest',
      '/ws',
      `/${newSecret()}/`,
    ]) {
      const res = await httpsGet(port, pathname, { ca: ca.cert, checkAs: PUBLIC });
      expect(res.status, pathname).toBe(404);
      expect(res.body, pathname).toBe('');
      expect(res.headers['set-cookie'], pathname).toBeUndefined();
      expect(res.headers.date, pathname).toBeUndefined();
    }
    const upgraded = await rawUpgrade(port, '/ws', '');
    expect(upgraded).toBe('closed');
    expect(app.seen).toEqual([]);
    expect(app.upgrades).toEqual([]);
  });

  it('close() ends a live WebSocket through the listener instead of waiting for it', async () => {
    const { direct, app } = connector();
    await direct.enable();
    const port = direct.listeningPort() ?? 0;
    // The app keeps the upgraded socket open, as a live /ws does.
    app.server.removeAllListeners('upgrade');
    app.server.on('upgrade', (_req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
    });
    const client = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
    client.on('error', () => undefined);
    await new Promise<void>((resolve) => client.once('secureConnect', () => resolve()));
    client.write(
      `GET /${direct.secret}/ws HTTP/1.1\r\nHost: ${PUBLIC}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
    );
    await new Promise<void>((resolve) => client.once('data', () => resolve()));
    const closed = direct.close().then(() => 'closed' as const);
    const late = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2_000));
    expect(await Promise.race([closed, late])).toBe('closed');
    client.destroy();
  });

  it('the secret path reaches the app as a public https request, and hands over the gate cookie', async () => {
    const { direct, app } = connector();
    await direct.enable();
    const port = direct.listeningPort() ?? 0;
    const res = await httpsGet(port, `/${direct.secret}/`, {
      ca: ca.cert,
      checkAs: PUBLIC,
      headers: {
        'x-forwarded-for': '10.0.0.1',
        'x-forwarded-proto': 'http',
        'tailscale-user-login': 'owner@localhost',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('app /');
    const gateCookie = cookies(res.headers['set-cookie']);
    expect(gateCookie).toBe(`cld_gate=${direct.secret}`);
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    // what the app saw: no client-chosen forwarding or identity headers, https
    expect(app.seen[0].headers['x-forwarded-proto']).toBe('https');
    expect(app.seen[0].headers['x-forwarded-for']).toBeUndefined();
    expect(app.seen[0].headers['tailscale-user-login']).toBeUndefined();
    expect(app.seen[0].encrypted).toBe(true);
    // the app's own absolute paths pass with the cookie, and only with it
    const api = await httpsGet(port, '/api/auth/me', {
      ca: ca.cert,
      checkAs: PUBLIC,
      headers: { cookie: gateCookie },
    });
    expect(api.body).toBe('app /api/auth/me');
    expect(await rawUpgrade(port, '/ws', gateCookie)).toBe('upgraded');
    expect(app.upgrades).toEqual(['/ws']);
    // a navigation to a bare `/` (after a device-key login) comes back under the secret path
    const home = await httpsGet(port, '/?x=1', {
      ca: ca.cert,
      checkAs: PUBLIC,
      headers: { cookie: gateCookie },
    });
    expect(home.status).toBe(302);
    expect(home.headers.location).toBe(`/${direct.secret}/?x=1`);
  });

  it('a redirect stays under the secret path, next to the session cookie', async () => {
    const { direct } = connector();
    await direct.enable();
    const port = direct.listeningPort() ?? 0;
    const res = await httpsGet(port, `/${direct.secret}/login?code=good`, {
      ca: ca.cert,
      checkAs: PUBLIC,
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/${direct.secret}/`);
    expect(cookies(res.headers['set-cookie'])).toBe(`cld_session=abc; cld_gate=${direct.secret}`);
    const bare = await httpsGet(port, `/${direct.secret}`, { ca: ca.cert, checkAs: PUBLIC });
    expect(bare.status).toBe(302);
    expect(bare.headers.location).toBe(`/${direct.secret}/`);
  });

  it('a new secret locks out every old invitation, cookie and installed app', async () => {
    const { direct } = connector();
    await direct.enable();
    const port = direct.listeningPort() ?? 0;
    const old = direct.secret;
    const fresh = direct.rotateSecret();
    expect(fresh).not.toBe(old);
    expect((await httpsGet(port, `/${old}/`, { ca: ca.cert, checkAs: PUBLIC })).status).toBe(404);
    expect(
      (
        await httpsGet(port, '/', {
          ca: ca.cert,
          checkAs: PUBLIC,
          headers: { cookie: `cld_gate=${old}` },
        })
      ).status,
    ).toBe(404);
    expect((await httpsGet(port, `/${fresh}/`, { ca: ca.cert, checkAs: PUBLIC })).status).toBe(200);
  });

  it('answers a TLS-ALPN-01 validation only under the reverse name, with acme-tls/1', async () => {
    const { direct } = connector();
    await direct.enable();
    const port = direct.listeningPort() ?? 0;
    const challenge = await ca.issue('203.0.113.7');
    direct.alpn.set(reverseDnsName(PUBLIC), challenge.key, challenge.cert);
    const validator = await peer(port, reverseDnsName(PUBLIC), ['acme-tls/1']);
    expect(validator.alpn).toBe('acme-tls/1');
    expect(validator.fingerprint).toBe(new crypto.X509Certificate(challenge.cert).fingerprint256);
    const browser = await peer(port, undefined, ['h2', 'http/1.1']);
    expect(browser.alpn).toBe('http/1.1');
    expect(browser.fingerprint).not.toBe(validator.fingerprint);
    direct.alpn.clear(reverseDnsName(PUBLIC));
    expect((await peer(port, reverseDnsName(PUBLIC), ['acme-tls/1'])).fingerprint).toBe(
      browser.fingerprint,
    );
  });

  it('stops before touching the router behind CGNAT or double NAT, and says why', async () => {
    for (const [wan, kind] of [
      ['100.72.1.2', 'CGNAT'],
      ['192.168.55.10', '이중 NAT'],
    ]) {
      const { direct, router, issuer } = connector({ wan: () => wan });
      const result = await direct.enable();
      expect(result.ok).toBe(false);
      expect(result.steps.map((s) => s.text).join('\n')).toContain(kind);
      expect(router.mappings).toEqual([]);
      expect(issuer.requests).toEqual([]);
      expect(direct.listeningPort()).toBeNull();
      await direct.close();
    }
    // the router's WAN looks public but the internet sees another address: a carrier NAT above it
    const { direct: d, router } = connector({ wan: () => '198.51.100.20' });
    const mismatch = await d.enable();
    expect(mismatch.ok).toBe(false);
    expect(mismatch.steps.map((s) => s.text).join('\n')).toContain('통신사 NAT');
    expect(router.mappings).toEqual([]);
  });

  it('without UPnP: says so with the manual port-forward step; --manual-forward goes on to the certificate', async () => {
    const { direct, issuer } = connector({ findGateway: async () => null });
    const off = await direct.enable();
    expect(off.ok).toBe(false);
    const step = off.steps.find((s) => s.text.includes('UPnP'));
    expect(step?.fix).toContain('외부 TCP 443 → 127.0.0.1:0');
    expect(issuer.requests).toEqual([]);
    const manual = await direct.enable({ manualForward: true });
    expect(manual.ok).toBe(true);
    expect(issuer.requests).toEqual([{ ip: PUBLIC, name: undefined }]);
  });

  describe('WSL NAT behind a Windows portproxy (T-0074)', () => {
    let relay: { port: number; close(): void } | undefined;
    afterEach(() => {
      relay?.close();
      relay = undefined;
    });
    /** Relay mode: no router is ever asked; `dial` reaches the listener only while `up`. */
    async function relayed(
      o: {
        windows?: string[] | null;
        observed?: string | null;
        up?: boolean;
        selfTest?: DirectDeps['selfTest'];
      } = {},
    ) {
      let up = o.up ?? true;
      const dialed: string[] = [];
      let gatewayAsked = false;
      const made = connector({
        relay: async () => true,
        listenHost: undefined,
        findGateway: async () => {
          gatewayAsked = true;
          return null;
        },
        observed: o.observed,
        windowsAddresses: async () =>
          o.windows === undefined ? [PUBLIC, '172.20.0.1'] : o.windows,
        relayGapMs: 10,
        dial: async (host) => {
          dialed.push(host);
          if (!up) throw new Error('connection refused');
          relay ??= await loopbackRelay(() => made.direct.listeningPort() ?? 0);
          await new Promise<void>((resolve, reject) => {
            const s = net.connect(relay?.port ?? 0, '127.0.0.1', () => {
              s.end();
              resolve();
            });
            s.on('error', reject);
          });
        },
        ...(o.selfTest ? { selfTest: o.selfTest } : {}),
      });
      return { ...made, dialed, gatewayAsked: () => gatewayAsked, setUp: (v: boolean) => (up = v) };
    }

    it('modem-direct (no router): the probe says no UPnP step is needed and never asks a router', async () => {
      const { direct, gatewayAsked } = await relayed();
      const probe = await direct.probe();
      expect(probe.ok).toBe(true);
      const text = probe.steps.map((s) => s.text).join('\n');
      expect(text).toContain('WSL NAT');
      expect(text).toContain(`모뎀 직결: Windows가 공인 주소 ${PUBLIC}`);
      expect(text).toContain('UPnP 단계는 필요 없어요');
      expect(probe.steps.every((s) => s.ok)).toBe(true);
      expect(gatewayAsked()).toBe(false);
    });

    it('behind a router: one port forward to Windows, as a step; a carrier NAT stops it', async () => {
      const { direct } = await relayed({ windows: ['192.168.0.12', '172.20.0.1'] });
      const probe = await direct.probe();
      expect(probe.ok).toBe(true);
      expect(probe.relayHost).toBe('192.168.0.12');
      expect(probe.steps.find((s) => s.fix)?.fix).toContain('외부 TCP 443 → 192.168.0.12:443');
      const { direct: cgnat } = await relayed({ observed: '100.72.1.2' });
      const blocked = await cgnat.probe();
      expect(blocked.ok).toBe(false);
      expect(blocked.steps.at(-1)?.text).toContain('통신사 NAT');
    });

    it('no portproxy yet: the PowerShell commands, no certificate asked for, nothing left listening; then 다시 확인 works', async () => {
      const { direct, issuer, dialed, setUp } = await relayed({ up: false });
      const first = await direct.enable();
      expect(first.ok).toBe(false);
      const missing = first.steps.find((s) => s.admin);
      expect(missing?.text).toContain('넘겨 주지 않아요');
      expect(missing?.admin).toEqual({ kind: 'relay', directPort: 0, externalPort: 443 });
      expect(missing?.actions?.[0]).toEqual({
        kind: 'copy',
        text: 'netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=443 connectaddress=127.0.0.1 connectport=0\n' +
          'Remove-NetFirewallRule -Name cld-gui-443 -ErrorAction SilentlyContinue; New-NetFirewallRule -Name cld-gui-443 -DisplayName "cld-gui 443" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow',
        label: 'PowerShell 명령 복사',
      });
      expect(issuer.requests).toEqual([]);
      expect(direct.listeningPort()).toBeNull();
      expect(direct.enabled).toBe(false);
      expect(dialed).toEqual([PUBLIC, PUBLIC, PUBLIC]);
      setUp(true);
      const again = await direct.enable();
      expect(again.steps.filter((s) => !s.ok)).toEqual([]);
      expect(again.ok).toBe(true);
      expect(again.steps.map((s) => s.text).join('\n')).toContain(
        `Windows 중계 확인: ${PUBLIC}:443`,
      );
      expect(again.url).toBe(`https://${PUBLIC}/${direct.secret}/`);
      expect(issuer.requests).toEqual([{ ip: PUBLIC, name: undefined }]);
      expect(direct.status().upnp).toBe(false);
      // the listener is on loopback, where WSL's localhost forwarding delivers
      expect(again.steps.map((s) => s.text).join('\n')).toContain('HTTPS 대기 127.0.0.1:');
    });

    it('a failed outside check keeps the current connector: direct stays off and closes again', async () => {
      const { direct, hosts } = await relayed({
        selfTest: async () => ({ ok: false, text: '비밀 주소 없이도 응답이 와요 (fake)' }),
      });
      const result = await direct.enable();
      expect(result.ok).toBe(false);
      expect(result.url).toBeNull();
      expect(result.steps.at(-1)?.text).toContain('지금 연결을 그대로');
      expect(direct.enabled).toBe(false);
      expect(direct.url()).toBeNull();
      expect(direct.listeningPort()).toBeNull();
      expect(hosts.has(PUBLIC)).toBe(false);
    });
  });

  it('443 taken by another device on the router: no listener, no certificate', async () => {
    const router = fakeGateway(() => PUBLIC, { conflict: '192.168.0.33' });
    const { direct, issuer } = connector({ findGateway: async () => router.gateway });
    const result = await direct.enable();
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.text).toContain('192.168.0.33');
    expect(issuer.requests).toEqual([]);
  });

  it('renews at two thirds of the lifetime, not before; re-maps 443 on every check', async () => {
    let now = Date.now();
    const { direct, router, issuer } = connector({ now: () => now });
    await direct.enable();
    const { notBefore = 0, notAfter = 0 } = direct.status().certificate ?? {};
    now = renewAt(notBefore, notAfter) - 60_000;
    await direct.maintain();
    expect(issuer.requests).toHaveLength(1);
    expect(router.mappings).toHaveLength(2); // the router may have rebooted: map again
    now = renewAt(notBefore, notAfter) + 1;
    await direct.maintain();
    expect(issuer.requests).toHaveLength(2);
    expect(direct.status().certificate?.notBefore).toBeGreaterThan(notBefore);
    expect(MAINTENANCE_MS).toBe(10 * 60_000);
  });

  it('a new public IP: noticed, certificate issued for it, the old name leaves the allowlist, LAN clients get told', async () => {
    let wan = PUBLIC;
    let now = Date.now();
    const { direct, issuer, hosts } = connector({ wan: () => wan, observed: null, now: () => now });
    await direct.enable();
    wan = '198.51.100.99';
    now += MAINTENANCE_MS;
    await direct.maintain();
    expect(issuer.requests.at(-1)).toEqual({ ip: '198.51.100.99', name: undefined });
    expect(hosts.has('198.51.100.99')).toBe(true);
    expect(hosts.has(PUBLIC)).toBe(false);
    expect(direct.status()).toMatchObject({
      ip: '198.51.100.99',
      previousIp: PUBLIC,
      ipChangedAt: now,
    });
    expect(direct.url()).toBe(`https://198.51.100.99/${direct.secret}/`);
  });

  it('a failed issue after an IP change is retried on a later check (once an hour at most)', async () => {
    let wan = PUBLIC;
    let now = Date.now();
    let failing = false;
    const issuer = fakeIssuer(ca, { fail: () => failing, now: () => now });
    const { direct } = connector({
      wan: () => wan,
      observed: null,
      now: () => now,
      issue: issuer.issue,
    });
    await direct.enable();
    wan = '198.51.100.99';
    failing = true;
    await direct.maintain();
    expect(issuer.requests).toHaveLength(2);
    now += MAINTENANCE_MS;
    await direct.maintain(); // within the hour: no new try
    expect(issuer.requests).toHaveLength(2);
    failing = false;
    now += 60 * 60_000;
    await direct.maintain();
    expect(issuer.requests).toHaveLength(3);
    expect(direct.status().certificate).not.toBeNull();
  });

  it('IP mode asks for an IP certificate when a stale saved certificate names DuckDNS', async () => {
    const duck = {
      name: 'office.duckdns.org',
      client: { txt: async () => undefined, update: async () => undefined },
    };
    const dir = tempDir();
    const saved = await ca.issue(duck.name);
    fs.writeFileSync(`${dir}/cert.key`, saved.key, { mode: 0o600 });
    fs.writeFileSync(`${dir}/cert.pem`, saved.cert, { mode: 0o600 });
    fs.writeFileSync(
      `${dir}/state.json`,
      `${JSON.stringify({
        enabled: true,
        secret: newSecret(),
        ip: PUBLIC,
        upnp: true,
        certFor: duck.name,
        notBefore: saved.notBefore,
        notAfter: saved.notAfter,
      })}\n`,
      { mode: 0o600 },
    );
    const { direct, issuer } = connector({ dir, duck });

    await direct.maintain();

    expect(issuer.requests).toEqual([{ ip: PUBLIC, name: undefined }]);
    expect(JSON.parse(fs.readFileSync(`${dir}/state.json`, 'utf8'))).toMatchObject({ certFor: PUBLIC });
  });

  it('name mode asks for its DuckDNS name and keeps an IP certificate slot', async () => {
    let wan = PUBLIC;
    const updates: string[] = [];
    const duck = {
      name: 'office.duckdns.org',
      client: { txt: async () => undefined, update: async (ip: string) => void updates.push(ip) },
    };
    const { direct, issuer, dir } = connector({ wan: () => wan, observed: null, duck });
    const result = await direct.enable();
    expect(result.url).toBe(`https://office.duckdns.org/${direct.secret}/`);
    expect(issuer.requests).toEqual([
      { ip: undefined, name: 'office.duckdns.org' },
      { ip: PUBLIC, name: undefined },
    ]);
    for (const file of ['ip-cert.pem', 'ip-cert.key'])
      expect(fs.statSync(`${dir}/${file}`).mode & 0o777).toBe(0o600);
    wan = '198.51.100.99';
    await direct.maintain();
    expect(updates).toEqual([PUBLIC, '198.51.100.99']);
    expect(issuer.requests.at(-1)).toEqual({ ip: '198.51.100.99', name: undefined });
    expect(direct.status().ipCertificate?.notAfter).toBeTypeOf('number');
    expect(direct.url()).toBe(`https://office.duckdns.org/${direct.secret}/`);
  });

  it('IP mode serves its renewed IP certificate to clients without SNI', async () => {
    const duck = {
      name: 'office.duckdns.org',
      client: { txt: async () => undefined, update: async () => undefined },
    };
    const dir = tempDir();
    const saved = await ca.issue(duck.name);
    fs.writeFileSync(`${dir}/cert.key`, saved.key, { mode: 0o600 });
    fs.writeFileSync(`${dir}/cert.pem`, saved.cert, { mode: 0o600 });
    fs.writeFileSync(
      `${dir}/state.json`,
      `${JSON.stringify({
        enabled: true,
        secret: newSecret(),
        ip: PUBLIC,
        upnp: true,
        certFor: duck.name,
        notBefore: saved.notBefore,
        notAfter: saved.notAfter,
      })}\n`,
      { mode: 0o600 },
    );
    const { direct, issuer } = connector({ dir, duck });
    await direct.resume();
    await direct.maintain();

    expect(issuer.requests).toEqual([{ ip: PUBLIC, name: undefined }]);
    const fingerprint = new crypto.X509Certificate(fs.readFileSync(`${dir}/cert.pem`)).fingerprint256;
    expect((await peer(direct.listeningPort() ?? 0, undefined, ['http/1.1'])).fingerprint).toBe(
      fingerprint,
    );
  });

  it('a DuckDNS listener serves its IP certificate without SNI and its name certificate with SNI', async () => {
    const duck = {
      name: 'office.duckdns.org',
      client: { txt: async () => undefined, update: async () => undefined },
    };
    const { direct, dir } = connector({ duck });
    await direct.enable();
    const port = direct.listeningPort() ?? 0;
    const ipFingerprint = new crypto.X509Certificate(fs.readFileSync(`${dir}/ip-cert.pem`)).fingerprint256;
    const nameFingerprint = new crypto.X509Certificate(fs.readFileSync(`${dir}/cert.pem`)).fingerprint256;
    expect((await peer(port, undefined, ['http/1.1'])).fingerprint).toBe(ipFingerprint);
    expect((await peer(port, 'OFFICE.DUCKDNS.ORG', ['http/1.1'])).fingerprint).toBe(
      nameFingerprint,
    );
  });

  it('an IP certificate failure leaves DuckDNS enabled and retries after its own cooldown', async () => {
    let now = Date.now();
    let failIp = true;
    const issuer = fakeIssuer(ca, {
      now: () => now,
      fail: () => failIp && issuer.requests.at(-1)?.ip === PUBLIC,
    });
    const duck = {
      name: 'office.duckdns.org',
      client: { txt: async () => undefined, update: async () => undefined },
    };
    const { direct } = connector({ now: () => now, issue: issuer.issue, duck });
    const enabled = await direct.enable();
    expect(enabled.ok).toBe(true);
    expect(enabled.steps.filter((step) => !step.ok).map((step) => step.text)).toEqual([
      expect.stringContaining('IP 주소'),
    ]);
    expect(issuer.requests).toHaveLength(2);
    await direct.maintain();
    expect(issuer.requests).toHaveLength(2);
    failIp = false;
    now += ISSUE_RETRY_MS;
    await direct.maintain();
    expect(issuer.requests).toHaveLength(3);
    expect(direct.status().ipCertificate).not.toBeNull();
  });

  it('running enable again (a redeploy) keeps a current certificate: no duplicate issue', async () => {
    const { direct, issuer, router } = connector();
    await direct.enable();
    const again = await direct.enable();
    expect(again.ok).toBe(true);
    expect(issuer.requests).toHaveLength(1);
    expect(router.mappings).toHaveLength(2); // the mapping itself is refreshed
    expect(again.steps.map((s) => s.text).join('\n')).toContain('인증서는 그대로 써요');
  });

  it('a first try whose listener cannot start closes the router port again', async () => {
    const busy = http.createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r));
    const { port } = busy.address() as AddressInfo;
    const { direct, router, issuer } = connector({ port });
    const result = await direct.enable();
    busy.close();
    expect(result.ok).toBe(false);
    expect(router.mappings).toHaveLength(1);
    expect(router.unmapped).toEqual([443]);
    expect(issuer.requests).toEqual([]);
    expect(direct.enabled).toBe(false);
  });

  it('a LAN device posing as the router cannot move the public address while STUN disagrees', async () => {
    let wan = PUBLIC;
    const { direct, issuer, hosts } = connector({ wan: () => wan });
    await direct.enable();
    wan = '198.51.100.66'; // a spoofed SSDP/UPnP answer
    await direct.maintain();
    expect(direct.url()).toBe(`https://${PUBLIC}/${direct.secret}/`);
    expect(hosts.has('198.51.100.66')).toBe(false);
    expect(issuer.requests).toHaveLength(1);
  });

  it('a renewal that fails is logged, not only kept in the status', async () => {
    let now = Date.now();
    let failing = false;
    const issuer = fakeIssuer(ca, { fail: () => failing, now: () => now });
    const { direct, logs } = connector({ now: () => now, issue: issuer.issue });
    await direct.enable();
    const { notBefore = 0, notAfter = 0 } = direct.status().certificate ?? {};
    failing = true;
    now = renewAt(notBefore, notAfter) + 1;
    await direct.maintain();
    expect(direct.listeningPort()).not.toBeNull(); // the listener stays up meanwhile
    expect(logs.some((l) => l.includes('✖') && l.includes("Let's Encrypt"))).toBe(true);
  });

  it('comes back after a restart with the same secret and certificate, and off removes the mapping', async () => {
    const dir = tempDir();
    const first = connector({ dir });
    await first.direct.enable();
    const secret = first.direct.secret;
    await first.direct.close();
    const second = connector({ dir });
    expect(second.direct.secret).toBe(secret);
    await second.direct.resume();
    expect(second.direct.listeningPort()).not.toBeNull();
    expect(second.hosts.has(PUBLIC)).toBe(true);
    await second.direct.disable();
    expect(second.router.unmapped).toEqual([443]);
    expect(second.direct.listeningPort()).toBeNull();
    expect(second.direct.url()).toBeNull();
  });
});

function peer(port: number, servername: string | undefined, ALPNProtocols: string[]) {
  return new Promise<{ alpn: string | false; fingerprint: string }>((resolve, reject) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port, servername, ALPNProtocols, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerX509Certificate();
        resolve({ alpn: socket.alpnProtocol ?? false, fingerprint: cert?.fingerprint256 ?? '' });
        socket.end();
      },
    );
    socket.on('error', reject);
  });
}

/** A WebSocket handshake by hand: 'upgraded' when the app answered 101, 'closed' when the gate hung up. */
function rawUpgrade(
  port: number,
  pathname: string,
  cookie: string,
): Promise<'upgraded' | 'closed'> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\nHost: ${PUBLIC}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`,
      );
    });
    let data = '';
    socket.on('data', (chunk: Buffer) => (data += chunk.toString()));
    socket.on('close', () => resolve(data.startsWith('HTTP/1.1 101') ? 'upgraded' : 'closed'));
    socket.on('error', () => undefined);
  });
}

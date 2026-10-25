/**
 * T-0024: the real acme-client against a fake ACME server on 127.0.0.1 (no
 * real certificate request). The fake validates TLS-ALPN-01 the way Let's
 * Encrypt does -- it connects to our TLS listener with the reverse name as
 * SNI and acme-tls/1 as ALPN -- and DNS-01 by reading what our DuckDNS
 * client set. It records the order so the test can check the IP identifier,
 * the `shortlived` profile and the anonymous account.
 */
// @peculiar/x509 2.x (the copy @simplewebauthn/server brought) needs this first.
import 'reflect-metadata';

import * as x509 from '@peculiar/x509';
import { crypto as acmeCrypto } from 'acme-client';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as net from 'net';
import * as tls from 'tls';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { acmeDirectory, acmeIssuer, duckDns, LETS_ENCRYPT, LETS_ENCRYPT_STAGING } from './acme.js';
import { DirectConnector } from './direct.js';
import { reverseDnsName } from './net.js';
import { fakeGateway, httpsGet, loopbackRelay, tempDir, type TestCa, testCa } from './testKit.js';

const PUBLIC = '203.0.113.7';
let ca: TestCa;
beforeAll(async () => {
  ca = await testCa();
});

const b64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

interface Recorded {
  account?: Record<string, unknown>;
  order?: Record<string, unknown>;
  validation?: { sni: string; alpn: string | false; valid: boolean };
  csrNames?: string[];
  csrSubject?: string;
}

/** A tiny RFC 8555 server: one account, one order, one authorization. */
async function fakeAcme(options: {
  type: 'tls-alpn-01' | 'dns-01';
  identifier: { type: string; value: string };
  tlsPort?: () => number;
  dnsTxt?: () => string | undefined;
}) {
  const rec: Recorded = {};
  let base = '';
  let jwk: Record<string, string> = {};
  const token = crypto.randomBytes(16).toString('base64url');
  let authzStatus = 'pending';
  let orderStatus = 'pending';
  let pem = '';
  const keyAuth = () => {
    const thumb = crypto
      .createHash('sha256')
      .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
      .digest('base64url');
    return `${token}.${thumb}`;
  };
  const challenge = () => ({
    type: options.type,
    url: `${base}/chall`,
    token,
    status: authzStatus === 'valid' ? 'valid' : authzStatus === 'invalid' ? 'invalid' : 'pending',
  });
  const order = () => ({
    status: orderStatus,
    identifiers: [options.identifier],
    authorizations: [`${base}/authz`],
    finalize: `${base}/finalize`,
    ...(orderStatus === 'valid' ? { certificate: `${base}/cert` } : {}),
  });

  async function validate(): Promise<void> {
    if (options.type === 'dns-01') {
      const expected = crypto.createHash('sha256').update(keyAuth()).digest('base64url');
      authzStatus = options.dnsTxt?.() === expected ? 'valid' : 'invalid';
      return;
    }
    const sni = reverseDnsName(options.identifier.value);
    const result = await new Promise<{ alpn: string | false; cert: string }>((resolve) => {
      const socket = tls.connect(
        {
          host: '127.0.0.1',
          port: options.tlsPort?.() ?? 0,
          servername: sni,
          ALPNProtocols: ['acme-tls/1'],
          rejectUnauthorized: false,
        },
        () => {
          resolve({
            alpn: socket.alpnProtocol ?? false,
            cert: socket.getPeerX509Certificate()?.toString() ?? '',
          });
          socket.end();
        },
      );
      socket.on('error', () => resolve({ alpn: false, cert: '' })); // unreachable: invalid
    });
    let valid = false;
    try {
      valid =
        result.alpn === 'acme-tls/1' &&
        acmeCrypto.isAlpnCertificateAuthorizationValid(result.cert, keyAuth());
    } catch {
      valid = false;
    }
    rec.validation = { sni, alpn: result.alpn, valid };
    authzStatus = valid ? 'valid' : 'invalid';
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      void (async () => {
        const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(status, {
            'content-type': 'application/json',
            'replay-nonce': crypto.randomBytes(8).toString('hex'),
            ...headers,
          });
          res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };
        const url = req.url ?? '';
        if (url === '/dir')
          return reply(200, {
            newNonce: `${base}/nonce`,
            newAccount: `${base}/acct`,
            newOrder: `${base}/order`,
            revokeCert: `${base}/revoke`,
            keyChange: `${base}/key`,
            meta: { termsOfService: `${base}/tos`, profiles: { classic: '', shortlived: '' } },
          });
        if (url === '/nonce') return reply(204, '');
        const jws = raw
          ? (JSON.parse(raw) as { protected: string; payload: string })
          : { protected: '', payload: '' };
        const header = jws.protected
          ? (JSON.parse(b64(jws.protected)) as { jwk?: Record<string, string> })
          : {};
        const payload = jws.payload
          ? (JSON.parse(b64(jws.payload)) as Record<string, unknown>)
          : null;
        if (url === '/acct') {
          jwk = header.jwk ?? jwk;
          rec.account = payload ?? {};
          return reply(201, { status: 'valid' }, { location: `${base}/acct/1` });
        }
        if (url === '/order') {
          rec.order = payload ?? {};
          return reply(201, order(), { location: `${base}/order/1` });
        }
        if (url === '/order/1') return reply(200, order(), { location: `${base}/order/1` });
        if (url === '/authz')
          return reply(200, {
            status: authzStatus,
            identifier: options.identifier,
            challenges: [challenge()],
          });
        if (url === '/chall') {
          if (payload && authzStatus === 'pending') await validate();
          return reply(200, challenge());
        }
        if (url === '/finalize') {
          const csr = new x509.Pkcs10CertificateRequest(
            Buffer.from(String(payload?.csr), 'base64url'),
          );
          const san = csr.getExtension('2.5.29.17') as x509.SubjectAlternativeNameExtension | null;
          rec.csrNames = san?.names.items.map((n) => `${n.type}:${n.value}`) ?? [];
          rec.csrSubject = csr.subject;
          const now = Date.now() - 60_000;
          pem = `${(await ca.sign(await csr.publicKey, options.identifier.value, now, now + 160 * 3_600_000)).trim()}\n${ca.cert.trim()}\n`;
          orderStatus = 'valid';
          return reply(200, order(), { location: `${base}/order/1` });
        }
        if (url === '/cert')
          return reply(200, pem, { 'content-type': 'application/pem-certificate-chain' });
        reply(404, { type: 'urn:ietf:params:acme:error:malformed' });
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, rec, directoryUrl: `${base}/dir` };
}

it("the daemon's CA is Let's Encrypt; the environment may pick only its staging CA", () => {
  expect(acmeDirectory(undefined)).toBe(LETS_ENCRYPT);
  expect(acmeDirectory('staging')).toBe(LETS_ENCRYPT_STAGING);
  expect(acmeDirectory(LETS_ENCRYPT_STAGING)).toBe(LETS_ENCRYPT_STAGING);
  for (const other of ['https://acme.evil.example/directory', 'http://127.0.0.1:1/dir', ''])
    expect(acmeDirectory(other)).toBe(LETS_ENCRYPT);
});

describe("Let's Encrypt through acme-client (fake ACME server)", () => {
  const close: Array<() => unknown> = [];
  afterEach(async () => {
    for (const c of close.splice(0)) await c();
  });

  it('an IP certificate: ip identifier, shortlived profile, anonymous account, TLS-ALPN-01 on our listener', async () => {
    let direct: DirectConnector | undefined;
    const acme = await fakeAcme({
      type: 'tls-alpn-01',
      identifier: { type: 'ip', value: PUBLIC },
      tlsPort: () => direct?.listeningPort() ?? 0,
    });
    close.push(() => acme.server.close());
    const dir = tempDir();
    const router = fakeGateway(() => PUBLIC);
    direct = new DirectConnector({
      dir,
      lanIp: '127.0.0.1',
      port: 0,
      listenHost: '127.0.0.1',
      target: http.createServer((_q, s) => s.end('app')),
      hosts: new Set(),
      findGateway: async () => router.gateway,
      observedIp: async () => PUBLIC,
      issue: acmeIssuer({ dir, directoryUrl: acme.directoryUrl, backoffMs: 5 }),
      selfTest: async () => ({ ok: true, text: 'fake self-test' }),
      log: () => undefined,
    });
    close.push(() => direct?.close());

    const result = await direct.enable();
    expect(result.steps.filter((s) => !s.ok)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(acme.rec.account).toEqual({ termsOfServiceAgreed: true }); // no contact: anonymous
    expect(acme.rec.order).toEqual({
      identifiers: [{ type: 'ip', value: PUBLIC }],
      profile: 'shortlived',
    });
    expect(acme.rec.validation).toEqual({
      sni: '7.113.0.203.in-addr.arpa',
      alpn: 'acme-tls/1',
      valid: true,
    });
    expect(acme.rec.csrNames).toEqual([`ip:${PUBLIC}`]);
    expect(acme.rec.csrSubject).toBe(''); // no CN
    expect(fs.statSync(`${dir}/account.key`).mode & 0o777).toBe(0o600);
    // the issued certificate is what the listener serves now
    const res = await httpsGet(direct.listeningPort() ?? 0, '/', { ca: ca.cert, checkAs: PUBLIC });
    expect(res.status).toBe(404);
    // and the challenge certificate is gone again
    const after = await new Promise<string>((resolve) => {
      const s = tls.connect(
        {
          host: '127.0.0.1',
          port: direct?.listeningPort() ?? 0,
          servername: reverseDnsName(PUBLIC),
          ALPNProtocols: ['acme-tls/1'],
          rejectUnauthorized: false,
        },
        () => {
          resolve(s.getPeerX509Certificate()?.subject ?? '');
          s.end();
        },
      );
      // The connector's close() ends its sockets: a reset here is not this test's failure.
      s.on('error', () => undefined);
    });
    expect(after).toBe('CN=cld-gui test leaf');
  });

  it('WSL NAT (T-0074): TLS-ALPN-01 passes through the Windows portproxy, the only port forwarded is 443', async () => {
    let direct: DirectConnector | undefined;
    // portproxy + WSL localhost forwarding: a byte pipe to the loopback listener
    const relay = await loopbackRelay(() => direct?.listeningPort() ?? 0);
    close.push(() => relay.close());
    const acme = await fakeAcme({
      type: 'tls-alpn-01',
      identifier: { type: 'ip', value: PUBLIC },
      tlsPort: () => relay.port, // Let's Encrypt reaches 443 = the relay
    });
    close.push(() => acme.server.close());
    const dir = tempDir();
    direct = new DirectConnector({
      dir,
      lanIp: '172.20.5.9',
      port: 0,
      target: http.createServer((_q, s) => s.end('app')),
      hosts: new Set(),
      relay: async () => true,
      findGateway: async () => {
        throw new Error('no router from inside WSL NAT');
      },
      observedIp: async () => PUBLIC,
      windowsAddresses: async () => [PUBLIC],
      dial: (_host, _port) =>
        new Promise((resolve, reject) => {
          const s = net.connect(relay.port, '127.0.0.1', () => {
            s.end();
            resolve();
          });
          s.on('error', reject);
        }),
      issue: acmeIssuer({ dir, directoryUrl: acme.directoryUrl, backoffMs: 5 }),
      selfTest: async () => ({ ok: true, text: 'fake self-test' }),
      log: () => undefined,
    });
    close.push(() => direct?.close());
    const result = await direct.enable();
    expect(result.steps.filter((s) => !s.ok)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(acme.rec.validation).toEqual({
      sni: '7.113.0.203.in-addr.arpa',
      alpn: 'acme-tls/1',
      valid: true,
    });
    // the issued certificate is what comes out of the relay now
    const res = await httpsGet(relay.port, '/', { ca: ca.cert, checkAs: PUBLIC });
    expect(res.status).toBe(404);
  });

  it('a validation that fails (the outside cannot reach 443) is a ✖ with the reason, no certificate', async () => {
    let direct: DirectConnector | undefined;
    const acme = await fakeAcme({
      type: 'tls-alpn-01',
      identifier: { type: 'ip', value: PUBLIC },
      tlsPort: () => 1, // nothing listens there: like a router that never forwards
    });
    close.push(() => acme.server.close());
    const dir = tempDir();
    const router = fakeGateway(() => PUBLIC);
    direct = new DirectConnector({
      dir,
      lanIp: '127.0.0.1',
      port: 0,
      listenHost: '127.0.0.1',
      target: http.createServer(),
      hosts: new Set(),
      findGateway: async () => router.gateway,
      observedIp: async () => PUBLIC,
      issue: acmeIssuer({ dir, directoryUrl: acme.directoryUrl, backoffMs: 5 }),
      log: () => undefined,
    });
    close.push(() => direct?.close());
    const result = await direct.enable();
    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.text).join('\n')).toContain(
      "Let's Encrypt가 바깥에서 443번으로 이 PC를 확인하지 못했어요",
    );
    expect(direct.url()).toBeNull();
    expect(fs.existsSync(`${dir}/cert.pem`)).toBe(false);
    // nothing left open: the router's 443 and the listener are closed again
    expect(router.unmapped).toEqual([443]);
    expect(direct.listeningPort()).toBeNull();
  });

  it('a DuckDNS name: DNS-01 through its TXT API, cleared afterwards; the token is never in a log line', async () => {
    const txt: Array<string | null> = [];
    const fetchFn = (async (url: string | URL) => {
      const u = new URL(String(url));
      expect(u.hostname).toBe('www.duckdns.org');
      expect(u.searchParams.get('domains')).toBe('office');
      expect(u.searchParams.get('token')).toBe('secret-token');
      if (u.searchParams.has('txt'))
        txt.push(u.searchParams.get('clear') ? null : u.searchParams.get('txt'));
      return new Response('OK');
    }) as typeof fetch;
    const duck = duckDns('office.duckdns.org', 'secret-token', fetchFn);
    const acme = await fakeAcme({
      type: 'dns-01',
      identifier: { type: 'dns', value: 'office.duckdns.org' },
      dnsTxt: () => txt.at(-1) ?? undefined,
    });
    close.push(() => acme.server.close());
    const logs: string[] = [];
    const issue = acmeIssuer({
      dir: tempDir(),
      directoryUrl: acme.directoryUrl,
      duck,
      dnsWaitMs: 0,
      backoffMs: 5,
    });
    const certificate = await issue({
      name: 'office.duckdns.org',
      alpn: { set() {}, clear() {} },
      log: (l) => logs.push(l),
    });
    expect(certificate.identifier).toBe('office.duckdns.org');
    expect(acme.rec.order).toEqual({ identifiers: [{ type: 'dns', value: 'office.duckdns.org' }] });
    expect(acme.rec.csrNames).toEqual(['dns:office.duckdns.org']);
    expect(txt).toHaveLength(2);
    expect(txt[1]).toBeNull(); // cleared
    expect(logs.join('\n')).not.toContain('secret-token');
  });
});

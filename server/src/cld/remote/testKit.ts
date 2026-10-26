/**
 * Test helpers for cld remote (T-0024): certificates made locally, a fake
 * router, a fake issuer, an HTTPS client. Never used at runtime; nothing here
 * touches a real router, STUN server or certificate authority.
 */
// @peculiar/x509 2.x (the copy @simplewebauthn/server brought) needs this first.
import 'reflect-metadata';

import * as x509 from '@peculiar/x509';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';

import type { Certificate, IssueRequest } from './acme.js';
import type { Gateway, PortMapping } from './upnp.js';

x509.cryptoProvider.set(crypto.webcrypto as unknown as Crypto);

const subtle = crypto.webcrypto.subtle;
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };

function pem(label: string, der: ArrayBuffer): string {
  const body = Buffer.from(der).toString('base64').replace(/.{64}/g, '$&\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export interface TestCa {
  cert: string;
  /** A leaf for `identifier` (an IP or a name), signed by this CA. */
  issue(identifier: string, notBefore?: number, notAfter?: number): Promise<Certificate>;
  /** Sign this public key (from a CSR) for `identifier`. */
  sign(
    publicKey: x509.PublicKey,
    identifier: string,
    notBefore: number,
    notAfter: number,
  ): Promise<string>;
}

export async function testCa(): Promise<TestCa> {
  const keys = (await subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=cld-gui test CA',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 365 * 86_400_000),
    keys,
    signingAlgorithm: ALG,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
  });
  const sign = async (
    publicKey: x509.PublicKey,
    identifier: string,
    notBefore: number,
    notAfter: number,
  ) => {
    const ip = /^\d+\.\d+\.\d+\.\d+$/.test(identifier);
    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: crypto.randomBytes(8).toString('hex'),
      subject: 'CN=cld-gui test leaf',
      issuer: caCert.subject,
      notBefore: new Date(notBefore),
      notAfter: new Date(notAfter),
      publicKey,
      signingKey: keys.privateKey,
      signingAlgorithm: ALG,
      extensions: [
        new x509.SubjectAlternativeNameExtension([{ type: ip ? 'ip' : 'dns', value: identifier }]),
      ],
    });
    return leaf.toString('pem');
  };
  return {
    cert: caCert.toString('pem'),
    sign,
    async issue(
      identifier,
      notBefore = Date.now() - 60_000,
      notAfter = notBefore + 160 * 3_600_000,
    ) {
      const pair = (await subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
      const publicKey = await x509.PublicKey.create(pair.publicKey);
      return {
        key: pem('PRIVATE KEY', await subtle.exportKey('pkcs8', pair.privateKey)),
        cert: await sign(publicKey, identifier, notBefore, notAfter),
        notBefore,
        notAfter,
        identifier,
      };
    },
  };
}

/** A router that answers UPnP like a home router would, and records every mapping. */
export function fakeGateway(wanIp: () => string, options: { conflict?: string } = {}) {
  const mappings: PortMapping[] = [];
  const unmapped: number[] = [];
  const gateway: Gateway = {
    location: 'http://192.168.0.1:5000/rootDesc.xml',
    externalIp: async () => wanIp(),
    async map(m) {
      if (options.conflict)
        throw new Error(`외부 ${m.externalPort}번을 다른 기기(${options.conflict})가 쓰고 있어요`);
      mappings.push(m);
    },
    async unmap(m) {
      unmapped.push(m.externalPort);
    },
  };
  return { gateway, mappings, unmapped };
}

/** An issuer that signs with a test CA, and records what it was asked. */
export function fakeIssuer(ca: TestCa, options: { fail?: () => boolean; now?: () => number } = {}) {
  const requests: Array<{ ip?: string; name?: string }> = [];
  const issue = async (request: IssueRequest): Promise<Certificate> => {
    requests.push({ ip: request.ip, name: request.name });
    if (options.fail?.()) throw new Error('Connection refused (fake validation)');
    const now = options.now?.() ?? Date.now();
    return ca.issue(request.ip ?? request.name ?? '', now - 60_000, now - 60_000 + 160 * 3_600_000);
  };
  return { issue, requests };
}

/** A fresh tls dir under the OS temp dir (never ~/.config/agent-tycoon). */
export function tempDir(prefix = 'cld-remote-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface Fetched {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One HTTPS request to 127.0.0.1:port, trusting only `ca`. */
export function httpsGet(
  port: number,
  pathname: string,
  options: {
    ca: string;
    headers?: Record<string, string>;
    method?: string;
    body?: string;
    /** The address the certificate must name (the public IP; we connect to 127.0.0.1). */
    checkAs?: string;
    /** Our side's address (127.0.0.x): a different client to the per-address limits. */
    localAddress?: string;
  },
): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: options.method ?? 'GET',
        ca: options.ca,
        headers: options.headers,
        checkServerIdentity: (host, cert) => tls.checkServerIdentity(options.checkAs ?? host, cert),
        localAddress: options.localAddress,
        agent: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** `name=value` pairs from Set-Cookie headers, for the next request's Cookie header. */
export function cookies(setCookie: string | string[] | undefined): string {
  return (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [])
    .map((c) => c.split(';')[0])
    .join('; ');
}

/**
 * Windows portproxy (0.0.0.0:443 -> 127.0.0.1:18443) plus WSL's localhost
 * forwarding: a dumb TCP pipe whose far end connects from 127.0.0.1.
 */
export async function loopbackRelay(
  target: () => number,
): Promise<{ port: number; close(): void }> {
  const pipes = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target(), '127.0.0.1');
    for (const s of [client, upstream]) {
      pipes.add(s);
      s.on('error', () => undefined);
      s.on('close', () => pipes.delete(s));
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => {
      for (const s of pipes) s.destroy();
      server.close();
    },
  };
}

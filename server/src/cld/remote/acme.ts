/**
 * Let's Encrypt certificates for the direct connector (T-0024), through
 * acme-client 5.4.0 (pinned; RFC 8555; its last release is 2024-07, so the
 * two 2026 features below go through its generic paths):
 * - an IP-address certificate: the `ip` identifier (RFC 8738; acme-client's
 *   CSR and TLS-ALPN-01 certificate put an IP in the SAN via net.isIP) under
 *   the `shortlived` profile Let's Encrypt requires for IPs (160 h; passed
 *   straight through in newOrder), validated by TLS-ALPN-01 on 443 so port 80
 *   is never needed;
 * - or a DuckDNS name the user already has, by DNS-01 through its TXT API.
 * The account is anonymous (no contact). Keys are ECDSA P-256.
 */
import * as fs from 'fs';
import * as path from 'path';

import { koText } from '../../../../core/src/cld/serverText.js';
import { reverseDnsName } from './net.js';

export const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';
export const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

/**
 * The CA, from CLD_GUI_ACME_DIRECTORY: Let's Encrypt, or its staging CA for a
 * manual test (`staging`). Never any other URL: the CA decides what certificate
 * the public listener serves.
 */
export function acmeDirectory(env: string | undefined): string {
  return env === 'staging' || env === LETS_ENCRYPT_STAGING ? LETS_ENCRYPT_STAGING : LETS_ENCRYPT;
}

export interface Certificate {
  key: string;
  cert: string;
  notBefore: number;
  notAfter: number;
  /** The IP or name it is for. */
  identifier: string;
}

/** Where the TLS listener answers a TLS-ALPN-01 validation (keyed by SNI). */
export interface AlpnChallenges {
  set(servername: string, key: string, cert: string): void;
  clear(servername: string): void;
}

export interface IssueRequest {
  /** A public IPv4 address (TLS-ALPN-01), or ... */
  ip?: string;
  /** ... a DuckDNS name (DNS-01). */
  name?: string;
  alpn: AlpnChallenges;
  log: (line: string) => void;
}

export type Issuer = (request: IssueRequest) => Promise<Certificate>;

export interface DuckDns {
  /** Sets (or with null clears) the TXT record of the name and every name under it. */
  txt(value: string | null): Promise<void>;
  /** Points the name at this IP. */
  update(ip: string): Promise<void>;
}

/** DuckDNS's update API (duckdns.org/spec.jsp). The token is the user's, never logged. */
export function duckDns(name: string, token: string, fetchFn: typeof fetch = fetch): DuckDns {
  const domain = name.replace(/\.duckdns\.org\.?$/i, '');
  const call = async (query: string) => {
    const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(domain)}&token=${encodeURIComponent(token)}&${query}`;
    const body = (
      await (await fetchFn(url, { signal: AbortSignal.timeout(15_000) })).text()
    ).trim();
    if (!body.startsWith('OK'))
      throw new Error(koText('duckdns_refused', { why: body.split('\n')[0] || koText('no_answer') }));
  };
  return {
    txt: (value) => call(value === null ? 'txt=&clear=true' : `txt=${encodeURIComponent(value)}`),
    update: (ip) => call(`ip=${encodeURIComponent(ip)}`),
  };
}

async function readOrCreateKey(file: string, create: () => Promise<Buffer>): Promise<Buffer> {
  try {
    return await fs.promises.readFile(file);
  } catch {
    const key = await create();
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(file, key, { mode: 0o600 });
    return key;
  }
}

/**
 * The real issuer. `dir` holds the account key (tls/account.key). DNS-01
 * needs `duck` (a DuckDNS client for the name) and waits `dnsWaitMs` for its
 * nameservers before asking Let's Encrypt to look.
 */
export function acmeIssuer(options: {
  dir: string;
  directoryUrl?: string;
  duck?: DuckDns;
  dnsWaitMs?: number;
  /** Polling backoff (tests shorten it). */
  backoffMs?: number;
}): Issuer {
  return async ({ ip, name, alpn, log }) => {
    const acme = await import('acme-client');
    // axios waits forever by default; a stuck CA must not stall maintenance.
    acme.axios.defaults.timeout = 30_000;
    const accountKey = await readOrCreateKey(path.join(options.dir, 'account.key'), () =>
      acme.crypto.createPrivateEcdsaKey(),
    );
    const client = new acme.Client({
      directoryUrl: options.directoryUrl ?? LETS_ENCRYPT,
      accountKey,
      ...(options.backoffMs
        ? { backoffMin: options.backoffMs, backoffMax: options.backoffMs * 4 }
        : {}),
    });
    await client.createAccount({ termsOfServiceAgreed: true });
    const identifier = ip ? { type: 'ip', value: ip } : { type: 'dns', value: name ?? '' };
    // `profile` is newer than acme-client's types; newOrder passes it through as-is.
    const order = await client.createOrder({
      identifiers: [identifier],
      ...(ip ? { profile: 'shortlived' } : {}),
    } as Parameters<typeof client.createOrder>[0]);
    const [authz] = await client.getAuthorizations(order);
    const type = ip ? 'tls-alpn-01' : 'dns-01';
    const challenge = authz?.challenges.find((c) => c.type === type);
    if (!authz || !challenge) throw new Error(koText('acme_no_challenge', { type }));
    const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
    const sni = ip ? reverseDnsName(ip) : '';
    if (ip) {
      const [alpnKey, alpnCert] = await acme.crypto.createAlpnCertificate(
        authz,
        keyAuthorization,
        await acme.crypto.createPrivateEcdsaKey(),
      );
      alpn.set(sni, alpnKey.toString(), alpnCert.toString());
    } else {
      if (!options.duck) throw new Error(koText('duckdns_no_token'));
      await options.duck.txt(keyAuthorization);
      log(
        `… DuckDNS TXT 기록을 넣었어요. 퍼질 때까지 ${Math.round((options.dnsWaitMs ?? 30_000) / 1000)}초 기다려요`,
      );
      await new Promise((r) => setTimeout(r, options.dnsWaitMs ?? 30_000));
    }
    try {
      log(`… Let's Encrypt가 ${ip ? `${ip}:443` : name}을 확인하는 중`);
      await client.completeChallenge(challenge);
      await client.waitForValidStatus(challenge);
    } finally {
      if (ip) alpn.clear(sni);
      else await options.duck?.txt(null).catch(() => undefined);
    }
    const certKey = await acme.crypto.createPrivateEcdsaKey();
    const [, csr] = await acme.crypto.createCsr({ altNames: [identifier.value] }, certKey);
    const finalized = await client.finalizeOrder(order, csr);
    const cert = await client.getCertificate(finalized);
    const info = acme.crypto.readCertificateInfo(cert);
    return {
      key: certKey.toString(),
      cert,
      notBefore: info.notBefore.getTime(),
      notAfter: info.notAfter.getTime(),
      identifier: identifier.value,
    };
  };
}

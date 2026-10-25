/**
 * O6: the user's own HTTPS/VPN address. The daemon opens, proxies and
 * configures nothing for it: it records the address (custom-url.json, 0600),
 * tests it, and lets invitations prefer it once the test passed.
 *
 * The card is independent of the connector (the user's proxy reaches this PC
 * however it is set up) and its state survives a restart; only switching the
 * connector to `local` at run time ("remote off") turns it off (index.ts).
 */
import * as fs from 'fs';
import * as path from 'path';

import { normalizeHostname, timingSafeStringEqual } from '../../wsAuth.js';
import { issueChallenge } from './healthChallenge.js';
import { isCgnatIpv4, isPrivateIpv4 } from './net.js';

export const CUSTOM_URL_MAX = 200;
export const CUSTOM_TEST_MS = 5000;
/** The largest /api/health answer the self-test reads (ours is ~150 bytes). */
const CUSTOM_HEALTH_MAX = 4096;

export type CustomVerdict = 'ok' | 'wrongDaemon' | 'unreachable' | 'certificate';
export interface CustomTest {
  verdict: CustomVerdict;
  checkedAt: number;
}
/** `active`: the address is in use (host allowed, preferred once `test` passed). */
export interface CustomRecord {
  url: string;
  active: boolean;
  test: CustomTest | null;
}
export type CustomParse =
  | { ok: true; url: string; host: string; plainHttp: boolean }
  | { ok: false; error: 'empty' | 'tooLong' | 'invalid' | 'credentials' | 'httpsOnly' };

/** VPN and home-network literals only: a name can't be known to be private. */
function privateLiteral(hostname: string): boolean {
  if (isPrivateIpv4(hostname) || isCgnatIpv4(hostname)) return true;
  const v6 = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return v6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}

/** One address: https, or http for a private/VPN literal; no credentials, query or fragment. Ends in `/`. */
export function parseCustomUrl(raw: unknown): CustomParse {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, error: 'empty' };
  if (text.length > CUSTOM_URL_MAX) return { ok: false, error: 'tooLong' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'invalid' };
  if (url.username || url.password) return { ok: false, error: 'credentials' };
  if (url.search || url.hash || !url.hostname) return { ok: false, error: 'invalid' };
  const plainHttp = url.protocol === 'http:';
  if (plainHttp && !privateLiteral(url.hostname)) return { ok: false, error: 'httpsOnly' };
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  // A name the Host check can never match (`*`, `_`, ...) would be allowed in name only.
  if (normalizeHostname(bare) !== bare) return { ok: false, error: 'invalid' };
  return {
    ok: true,
    url: `${url.origin}${url.pathname.replace(/\/*$/, '/')}`,
    host: bare,
    plainHttp,
  };
}

type FetchLike = (url: string, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

/**
 * GET <url>api/health?cldNonce=N: ok only when the answer carries the reply R
 * this daemon made up for N (healthChallenge.ts); echoing N proves nothing. A redirect is not followed
 * (it would leave the address the user typed): whatever sits there is not us.
 */
export async function customSelfTest(
  url: string,
  fetchFn: FetchLike = fetch,
): Promise<CustomVerdict> {
  const { nonce, reply } = issueChallenge();
  try {
    const response = await fetchFn(new URL(`api/health?cldNonce=${nonce}`, url).href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(CUSTOM_TEST_MS),
    });
    if (response.status !== 200 || !response.body) return 'wrongDaemon';
    // Whatever answers there may stream without end: a health answer is tiny, so read 4 KB at most.
    const reader = response.body.getReader();
    let text = '';
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      text += Buffer.from(part.value).toString('latin1');
      if (text.length > CUSTOM_HEALTH_MAX) {
        void reader.cancel().catch(() => {});
        return 'wrongDaemon';
      }
    }
    let body: { cldReply?: unknown } | null = null;
    try {
      body = JSON.parse(text) as { cldReply?: unknown } | null;
    } catch {
      /* not JSON: not us */
    }
    const ours =
      typeof body?.cldReply === 'string' && timingSafeStringEqual(body.cldReply, reply);
    return ours ? 'ok' : 'wrongDaemon';
  } catch (error) {
    const { code, message } = ((error as Error).cause ?? error) as { code?: string; message?: string };
    return /CERT|TLS|SSL|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY/i.test(`${code} ${message}`)
      ? 'certificate'
      : 'unreachable';
  }
}

const customFile = (configDir: string) => path.join(configDir, 'custom-url.json');

export function readCustom(configDir: string): CustomRecord | null {
  try {
    const value = JSON.parse(fs.readFileSync(customFile(configDir), 'utf8')) as Partial<CustomRecord>;
    const parsed = parseCustomUrl(value.url);
    if (!parsed.ok) return null;
    const test = value.test;
    return {
      url: parsed.url,
      active: value.active === true,
      test:
        test && typeof test.checkedAt === 'number' && typeof test.verdict === 'string'
          ? { verdict: test.verdict, checkedAt: test.checkedAt }
          : null,
    };
  } catch {
    return null;
  }
}

/** Atomic, 0600; `null` removes the file. */
export function writeCustom(configDir: string, record: CustomRecord | null): void {
  const file = customFile(configDir);
  if (!record) return fs.rmSync(file, { force: true });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** In use for invitations: on and its last self-test passed. */
export const customPreferred = (record: CustomRecord | null): string | undefined =>
  record?.active && record.test?.verdict === 'ok' ? record.url : undefined;

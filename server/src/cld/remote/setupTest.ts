import * as dns from 'dns/promises';
import * as fs from 'fs';
import * as path from 'path';

import { koText } from '../../../../core/src/cld/serverText.js';

export interface RemoteTestResult {
  ok: boolean;
  url: string;
  checkedAt: number;
  /** `unknown`: not checkable from this PC (it passed, but say so). */
  steps: Array<{ ok: boolean; text: string; unknown?: boolean }>;
}

type FetchLike = (url: string) => Promise<{ status: number; text(): Promise<string> }>;
type WsProbe = (url: string) => Promise<boolean>;

/** A WebSocket with no Cookie must be closed as unauthorized, never accepted. */
export const anonymousWsRefused: WsProbe = (url) =>
  new Promise((resolve) => {
    const socket = new WebSocket(url);
    let opened = false;
    const timer = setTimeout(() => {
      socket.close();
      resolve(false);
    }, 8000);
    socket.addEventListener('open', () => { opened = true; socket.close(); resolve(false); });
    socket.addEventListener('close', (event) => {
      clearTimeout(timer);
      // Direct's secret-path gate destroys an unauthenticated upgrade before
      // a WebSocket close frame exists. Health and login above prove reachability.
      resolve(!opened || event.code === 4001 || event.code === 1008);
    });
    // A refused upgrade (non-101) errors before any open, and this runtime may never follow it
    // with a close event: waiting for one timed out and read as "not refused" (10-24).
    socket.addEventListener('error', () => {
      if (opened) return;
      clearTimeout(timer);
      resolve(true);
    });
  });

/** Exercise the advertised address from this PC with no login cookie. */
export async function outsideSelfTest(
  url: string,
  deps: {
    fetchFn?: FetchLike;
    dnsLookup?: (host: string) => Promise<unknown>;
    wsProbe?: WsProbe;
    now?: () => number;
    /**
     * Something else already proved the outside path (Let's Encrypt reached
     * direct; tailscale serve status shows our handler): an address this PC
     * cannot reach itself (no hairpin NAT, no MagicDNS inside WSL, ...) is
     * "unknown from here", not a failure. Certificate errors still fail.
     */
    setUpProven?: boolean;
  } = {},
): Promise<RemoteTestResult> {
  const address = new URL(url);
  const fetchFn = deps.fetchFn ?? ((target) => fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(8000) }));
  const steps: RemoteTestResult['steps'] = [];
  const result = () => ({ ok: steps.every((step) => step.ok), url, checkedAt: (deps.now ?? Date.now)(), steps });
  let answered = false;
  try {
    // An IPv6 literal's hostname keeps its brackets.
    await (deps.dnsLookup ?? dns.lookup)(address.hostname.replace(/^\[(.*)\]$/, '$1'));
    steps.push({ ok: true, text: koText('setup_found_address') });
    const base = url.endsWith('/') ? url : `${url}/`;
    const health = await fetchFn(new URL('api/health', base).href);
    answered = true;
    steps.push({ ok: health.status === 200, text: health.status === 200 ? koText('setup_health_ok') : koText('setup_health_failed', { status: health.status }) });
    if (health.status !== 200) return result();
    const page = await fetchFn(base);
    const body = await page.text();
    const login = (page.status === 200 || page.status === 401) && /로그인 코드|<form[^>]*action=["']login["']/i.test(body);
    steps.push({ ok: login, text: login ? koText('setup_login_ok') : koText('setup_login_failed', { status: page.status }) });
    if (!login) return result();
    const ws = new URL('ws', base);
    ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
    const refused = await (deps.wsProbe ?? anonymousWsRefused)(ws.href);
    steps.push({ ok: refused, text: refused ? koText('setup_ws_refused') : koText('setup_ws_open') });
  } catch (error) {
    const why = errorWhy(error);
    // Only "could not get there" is unknown: any other failure (every TLS/certificate error) is real.
    if (deps.setUpProven && !answered && UNREACHABLE.test(why) && !/cert|tls|ssl/i.test(why))
      steps.push({ ok: true, unknown: true, text: koText('setup_unknown_here', { why }) });
    else steps.push({ ok: false, text: koText('setup_outside_failed', { why }) });
  }
  return result();
}

const UNREACHABLE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|timeout/i;

/** fetch() says "fetch failed" and keeps the reason (ECONNREFUSED, CERT_HAS_EXPIRED, ...) in `cause`. */
function errorWhy(error: unknown): string {
  const { message, cause } = error as Error & { cause?: { code?: string; message?: string } };
  const inner = cause?.code ?? cause?.message;
  return inner ? `${message}: ${inner}` : message;
}

export function saveRemoteTest(configDir: string, result: RemoteTestResult): void {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const target = path.join(configDir, 'remote-test.json');
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function readRemoteTest(configDir: string): RemoteTestResult | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, 'remote-test.json'), 'utf8')) as RemoteTestResult;
  } catch {
    return null;
  }
}

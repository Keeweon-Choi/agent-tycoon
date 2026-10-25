/**
 * O5 (F-5) check: a registered phone page follows the host to its verified
 * outside address with no hands and no code typed. dist/cli.js with an
 * isolated HOME on a spare port, the network faked (CLD_GUI_TEST_REMOTE: no
 * Tailscale, router or DNS is asked), headless Chromium (--disable-gpu), two
 * origins of the one daemon:
 *
 * - home: https://lan.test, the address the phone registered at (an https home
 *   address such as an old Tailscale name or direct IP certificate: a plain-http
 *   LAN page has no WebCrypto, so no device key, and never moves by itself).
 * - outside: https://office.test.ts.net, the fake connector's address.
 * Both are `tailscale serve` in miniature: TLS on the second spare port,
 * forwarding with X-Forwarded-*, Chromium-only name mapping (no DNS).
 * "Verified" is remote-test.json, the record the host's outside check writes.
 *
 * 1. The phone logs in at home with a host code; its key registers there.
 * 2. No outside check, then a passed check for another address: a reload stays
 *    home (negative controls).
 * 3. The check passes for the outside address: a reload ends at the outside
 *    address, logged in as the same device, its key moved there, nothing typed;
 *    audit.jsonl has the automatic move and its use.
 * 4. The home address no longer logs in (its key and session went with the move).
 *
 * Screenshots: cld/artifacts/o5/. The real claude is never run.
 *
 *   npx tsx cld/test/run-o5.ts <port> <proxy port>   (18256-18259)
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import {
  assertPortFree,
  type Daemon,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort(2);
const proxyPort = sparePort(3);
const OUTSIDE_NAME = 'office.test.ts.net';
const HOME_NAME = 'lan.test';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/o5');
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__o5/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 240_000;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(probe: () => Promise<T>, what: string, ms = 15_000): Promise<T> {
  for (const deadline = Date.now() + ms; ; await sleep(200)) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
  }
}

/** TLS for the outside name on `proxyPort`, forwarding as tailscaled does, sockets too. */
async function startOutsideProxy(dir: string): Promise<https.Server> {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', `/CN=${OUTSIDE_NAME}`,
    '-addext', `subjectAltName=DNS:${OUTSIDE_NAME},DNS:${HOME_NAME}`,
  ], { stdio: 'ignore' });
  const headers = (req: http.IncomingMessage) => ({
    ...req.headers,
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '100.64.0.9',
  });
  const proxy = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const upstream = http.request(
      { host: '127.0.0.1', port, method: req.method, path: req.url, headers: headers(req) },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  proxy.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const up = net.connect(port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers(req)))
        for (const v of [value].flat()) if (v !== undefined) lines.push(`${name}: ${v}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  return proxy;
}

async function main() {
  if (port === proxyPort) throw new Error('ports must be two of 18256-18259');
  await assertPortFree(port, proxyPort);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'S-8', agentsJson: true });
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-o5-tls-'));
  const configDir = path.join(fake.home, '.config/cld-gui');
  // The fake network: nothing served by a real tailscale, nothing else asked.
  const factsFile = path.join(fake.home, 'remote-facts.json');
  fs.writeFileSync(factsFile, JSON.stringify({ tailscale: {} }));
  let daemon: Daemon | undefined;
  let proxy: https.Server | undefined;
  let browser: Browser | undefined;
  const killAll = () => {
    if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null) daemon.child.kill('SIGKILL');
    proxy?.closeAllConnections();
    proxy?.close();
    fs.rmSync(fake.home, { recursive: true, force: true });
    fs.rmSync(certDir, { recursive: true, force: true });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    killAll();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const home = `https://${HOME_NAME}`;
  const outside = `https://${OUTSIDE_NAME}`;
  const verify = (url: string, ok = true) =>
    fs.writeFileSync(
      path.join(configDir, 'remote-test.json'),
      JSON.stringify({ ok, url, checkedAt: Date.now(), steps: [] }),
    );
  const audit = () =>
    fs.readFileSync(path.join(configDir, 'audit.jsonl'), 'utf-8').trim().split('\n')
      .map((line) => JSON.parse(line) as { kind: string; detail?: string; device?: { id: string } });
  const devices = () =>
    (JSON.parse(fs.readFileSync(path.join(configDir, 'devices.json'), 'utf-8')) as {
      devices: Array<{ id: string; origin: string }>;
    }).devices;
  const font = fs.readFileSync(FONT);
  const shot = async (page: Page, name: string) => {
    await page.addStyleTag({ content: FONT_CSS }).catch(() => undefined);
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가')).catch(() => undefined);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  };
  const me = (page: Page) =>
    page.evaluate(async () => {
      const res = await fetch('/api/auth/me');
      return res.ok
        ? ((await res.json()) as { id: string; method: string; deviceId: string | null; autoMoveTo: string | null })
        : null;
    });

  try {
    proxy = await startOutsideProxy(certDir);
    daemon = startDaemon(
      fake,
      port,
      ['--no-terminal', '--connector', 'tailscale', '--allowed-host', OUTSIDE_NAME, '--allowed-host', HOME_NAME],
      { CLD_GUI_TEST_REMOTE: factsFile },
    );
    const link = (await daemon.loginUrl()).replace(`http://127.0.0.1:${port}`, home);
    // Both names reach the one proxy (Chromium-only mapping, no DNS): two origins, one daemon.
    browser = await launchBrowser({
      args: [
        `--host-resolver-rules=MAP ${OUTSIDE_NAME}:443 127.0.0.1:${proxyPort}, MAP ${HOME_NAME}:443 127.0.0.1:${proxyPort}`,
      ],
    });
    // bypassCSP: the injected screenshot font only. The outside name's certificate is self-signed.
    const ctx = await browser.newContext({ ...PHONE, bypassCSP: true, ignoreHTTPSErrors: true });
    await ctx.route('**/__o5/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
    const phone = await ctx.newPage();
    const typed: string[] = [];
    await ctx.exposeBinding('__o5typed', (_source, what: string) => void typed.push(what));
    await ctx.addInitScript(() =>
      document.addEventListener('input', (e) => (window as unknown as { __o5typed: (w: string) => void }).__o5typed(String((e.target as HTMLInputElement)?.name ?? 'input')), true),
    );

    // ── 1. Registered at home ──
    await phone.goto(link);
    await phone.waitForURL(`${home}/`);
    const deviceId = await until(async () => (await me(phone))?.deviceId, 'the phone registers its key at home');
    check(devices().find((d) => d.id === deviceId)?.origin === home, 'its key lives at the home address');
    check((await me(phone))?.autoMoveTo === null, 'no outside address is verified yet');

    // ── 2. Negative controls: nothing verified, then a passed check for an address not in use ──
    await phone.reload();
    await sleep(3000);
    check(phone.url().startsWith(home), 'with no outside check the page stays home');
    verify('https://elsewhere.test/');
    await phone.reload();
    await sleep(3000);
    check(phone.url().startsWith(home), 'a check passed for an address the connector does not serve: stays home');
    check((await me(phone))?.autoMoveTo === null, 'and the server names no address to move to');
    verify(`${outside}/`, false);
    await phone.reload();
    await sleep(3000);
    check(phone.url().startsWith(home), 'a failed outside check: stays home');
    check(!audit().some((l) => l.kind === 'moveCodeCreated'), 'no move code was made so far');
    await shot(phone, 'o5-home-before');

    // ── 3. The outside check passes: the next open moves by itself ──
    verify(`${outside}/`);
    await phone.reload();
    await phone.waitForURL(`${outside}/`, { timeout: 20_000 });
    const moved = await until(async () => {
      const m = await me(phone);
      return m?.method === 'move' ? m : null;
    }, 'logged in at the outside address');
    check(moved.id === deviceId, 'the same device at the outside address');
    await until(async () => devices().find((d) => d.id === deviceId)?.origin === outside, 'its key moves outside');
    check(devices().filter((d) => d.id === deviceId).length === 1, 'still one device row');
    check(typed.length === 0, 'nothing was typed');
    const lines = audit();
    check(
      lines.some((l) => l.kind === 'moveCodeCreated' && l.detail === 'auto' && l.device?.id === deviceId),
      'audit: the automatic move code',
    );
    check(
      lines.some((l) => l.kind === 'loginCodeUsed' && l.detail === 'move' && l.device?.id === deviceId),
      'audit: its use at the outside address',
    );
    check(
      lines.some((l) => l.kind === 'deviceRegistered' && l.detail === 'replaced' && l.device?.id === deviceId),
      'audit: the key replaced at the new address',
    );
    const record = fs.readFileSync(path.join(configDir, 'audit.jsonl'), 'utf-8');
    check(!/code=|cld_session/.test(record), 'audit.jsonl holds no code or cookie');
    // An iPhone Safari tab is offered the Home-Screen app code (S3, now after a move too).
    const handoff = phone.getByTestId('handoff-code');
    await handoff.waitFor({ timeout: 10_000 });
    check(/^\d{4} \d{4}$/.test((await handoff.textContent()) ?? ''), 'the Home-Screen app code is offered');
    await shot(phone, 'o5-outside-moved-phone');

    // ── 4. The home address went with the move ──
    const old = await ctx.newPage();
    await old.goto(`${home}/`);
    await sleep(2000);
    check((await me(old)) === null, 'the home address no longer has a session');
    await shot(old, 'o5-home-after');
    console.log('all checks passed');
  } finally {
    clearTimeout(deadline);
    await browser?.close().catch(() => undefined);
    await daemon?.stop().catch(() => undefined);
    killAll();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * T-0034 check: devices stay logged in. dist/cli.js with an isolated HOME
 * (the fake claude) on a spare port, headless Chromium, and a second
 * address: `tailscale serve` in miniature (TLS for office.test.ts.net on a
 * second spare port, forwarding with X-Forwarded-Proto/For, sockets too;
 * Chromium sends office.test.ts.net:443 there), which is the daemon's
 * --allowed-host and, with --connector tailscale, its canonical address, https://office.test.ts.net.
 *
 * 1. Device A logs in with a code. sessions.json (0600) keeps the hash of its
 *    cookie, never the cookie; devices.json gets A's public key.
 * 2. The daemon restarts (same HOME and port): A's open page reconnects by
 *    itself, and a reload is still in the app.
 * 3. A's cookie is deleted: the login page logs it back in with its device
 *    key, with no input.
 * 4. A's 기기 추가 shows the canonical address and a code; B opens that
 *    address, types the code, and A gets "새 기기 로그인".
 * 5. B removes A in 보안: A's page lands on the login page and stays there
 *    (its key is gone too).
 * 6. C logs in on localhost and moves to the canonical address: the same
 *    device id there, a "기기 열쇠가 바뀌었어요" notice (not a new device), and
 *    longer logs in.
 * 6b. O1, on C at the canonical address: 기기 추가 offers 초대 링크 복사
 *    (the clipboard holds the login link), 초대 취소, and 공유 only where the
 *    browser can share (stubbed here, Linux Chromium has none). D opens the
 *    copied link; C shows "Windows · Chrome 등록됨", D is named 노트북 and the
 *    device list says so. A second invitation is cancelled: its link no
 *    longer logs in. The daemon log never holds a code.
 * 4b. O3, at the same moment: A and B have each subscribed to Web Push (the
 *    endpoints are this runner's own HTTPS stub, never a real push service;
 *    B subscribed before its key registered, so its row is its session). The
 *    stub gets exactly one push, for A, with B's name and a link to the 보안
 *    panel; none for B. A's 보안 panel then shows the 보안 기록 with B's line.
 * 6c. O3, a phone (E) opens /?open=security, the link in that push: the 보안
 *    panel opens with the 보안 기록 (desktop and phone screenshots in
 *    cld/artifacts/o3/). audit.jsonl is 0600 and holds no code, cookie or
 *    token.
 * 7. B registers a passkey and, with a tap of it, turns on 패스키(생체 인증)
 *    필수 (greyed out before): without its cookie B is not let back
 *    in silently.
 *
 * Screenshots go to cld/artifacts/t0034/ (the o1-* ones to cld/artifacts/o1/). Hangul comes from malgun.ttf. The
 * real claude is never run. A hard deadline and SIGINT/SIGTERM/SIGHUP kill the
 * daemon and the proxy, which also stop when the check ends.
 *
 *   npx tsx cld/test/run-device-login.ts <port> <proxy port>   (18256-18259)
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { type ChildProcess, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import {
  assertPortFree,
  type FakeHome,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon as launchDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort(2);
const proxyPort = sparePort(3);
const SERVE_NAME = 'office.test.ts.net';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0034');
const OUT_O1 = path.join(REPO_ROOT, 'cld/artifacts/o1');
const OUT_O3 = path.join(REPO_ROOT, 'cld/artifacts/o3');
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0034/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 540_000;
const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const CHROME_WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `probe` until it is truthy (or fail after `ms`). */
async function until<T>(probe: () => Promise<T>, what: string, ms = 15_000): Promise<T> {
  for (const deadline = Date.now() + ms; ; await sleep(200)) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
  }
}

interface Daemon {
  /** A fresh login link, on localhost. */
  link: string;
  log: string[];
  process: ChildProcess;
}

const daemons: Daemon[] = [];

/** The daemon trusts the push stub's certificate (a self-signed one for localhost). */
let daemonEnv: Record<string, string> = {};

/** dist/cli.js on `port` with `fake`'s HOME; resolves once it answers. */
async function startDaemon(fake: FakeHome): Promise<Daemon> {
  // The canonical address comes from the connector (T-0024): tailscale, named by the first .ts.net --allowed-host.
  const d = launchDaemon(fake, port, [
    '--no-terminal',
    '--connector',
    'tailscale',
    '--allowed-host',
    SERVE_NAME,
  ], daemonEnv);
  const link = (await d.loginUrl()).replace('http://127.0.0.1:', 'http://localhost:');
  const daemon = { link, log: d.log, process: d.child };
  daemons.push(daemon);
  return daemon;
}

async function stopDaemon(daemon: Daemon, name: string): Promise<void> {
  const child = daemon.process;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(killer);
  }
  // Codes are used up, but keep them out of the artifacts.
  fs.writeFileSync(
    path.join(OUT, name),
    daemon.log.join('').replace(/([?&]code=)[\w-]+/g, '$1[redacted]'),
  );
}

/**
 * `tailscale serve` in miniature: TLS for office.test.ts.net on `proxyPort`,
 * forwarding to the daemon with the headers tailscaled sets (serve.go), the
 * Host kept, WebSocket upgrades piped.
 */
/** What the daemon POSTed to the push stub (paths /__push/<name>). */
const pushes: Array<{ path: string; body: Buffer }> = [];

async function startServeProxy(dir: string): Promise<https.Server> {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      `/CN=${SERVE_NAME}`,
      '-addext',
      `subjectAltName=DNS:${SERVE_NAME},DNS:localhost`,
    ],
    { stdio: 'ignore' },
  );
  const headers = (req: http.IncomingMessage) => ({
    ...req.headers,
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '100.64.0.9',
  });
  const proxy = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    (req, res) => {
      // O3: the push service, in miniature. The daemon posts here; nothing leaves this machine.
      if (req.url?.startsWith('/__push/')) {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          pushes.push({ path: req.url ?? '', body: Buffer.concat(chunks) });
          res.writeHead(201).end();
        });
        return;
      }
      const upstream = http.request(
        { host: '127.0.0.1', port, method: req.method, path: req.url, headers: headers(req) },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    },
  );
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
  fs.mkdirSync(OUT_O1, { recursive: true });
  fs.mkdirSync(OUT_O3, { recursive: true });
  const fake = makeFakeHome({ claude: 'S-8', agentsJson: true });
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-t0034-tls-'));
  daemonEnv = { NODE_EXTRA_CA_CERTS: path.join(certDir, 'cert.pem') };
  let proxy: https.Server | undefined;
  const killAll = () => {
    for (const d of daemons)
      if (d.process.exitCode === null && d.process.signalCode === null) d.process.kill('SIGKILL');
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

  const local = `http://localhost:${port}`;
  // Port 443, like tailscale serve: Chromium sends office.test.ts.net:443 to the proxy.
  const canonical = `https://${SERVE_NAME}`;
  const configDir = path.join(fake.home, '.config/cld-gui');
  const token = () =>
    fs.readFileSync(path.join(fake.home, '.pixel-agents/standalone-token'), 'utf-8').trim();
  /** A host code (cld-gui-login): a 60 s link code. */
  const hostLink = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/login-code`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}` },
    });
    return `${local}/login?code=${((await res.json()) as { code: string }).code}`;
  };
  let browser: Browser | undefined;
  const font = fs.readFileSync(FONT);
  const open = async (opts: BrowserContextOptions) => {
    // bypassCSP: the login page's CSP would refuse the injected test font.
    // The serve name's certificate is self-signed.
    const ctx = await browser!.newContext({ ...opts, bypassCSP: true, ignoreHTTPSErrors: true });
    await ctx.route('**/__t0034/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    return { ctx, page: await ctx.newPage() };
  };
  const shot = async (page: Page, name: string) => {
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    const dir = name.startsWith('o1-') ? OUT_O1 : name.startsWith('o3-') ? OUT_O3 : OUT;
    await page.screenshot({ path: path.join(dir, `${name}.png`) });
  };
  const inApp = (page: Page) =>
    page.getByRole('button', { name: '기기 추가', exact: true }).waitFor({ timeout: 15_000 });
  const closeModal = (page: Page) =>
    page.getByRole('button', { name: 'x', exact: true }).last().click();
  const me = (page: Page) =>
    page.evaluate(async () => {
      const res = await fetch('/api/auth/me');
      return res.ok
        ? ((await res.json()) as { id: string; method: string; deviceId: string | null })
        : null;
    });
  /** The login page is up and stays up (no silent way back in). */
  const staysOnLogin = async (page: Page, what: string) => {
    await page.locator('#code').waitFor({ timeout: 15_000 });
    await sleep(3_000);
    check(
      (await page.locator('#code').count()) === 1 && (await me(page)) === null,
      `${what} stays on the login page`,
    );
  };
  const savedDevices = () =>
    JSON.parse(fs.readFileSync(path.join(configDir, 'devices.json'), 'utf-8')) as {
      devices: Array<{ id: string; origin: string; publicKey: Record<string, string> }>;
    };

  /** A browser's Web Push subscription (its keys are ours, to read what was sent). */
  const subscriber = (name: string) => {
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    return { ua, auth, endpoint: `https://localhost:${proxyPort}/__push/${name}` };
  };
  /** The page subscribes over its own /ws, as the app does (headless Chromium has no push service). */
  const subscribe = (page: Page, sub: ReturnType<typeof subscriber>) =>
    page.evaluate(
      (msg) =>
        new Promise<boolean>((resolve) => {
          const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`);
          (window as unknown as { __pushWs?: WebSocket[] }).__pushWs = [
            ...((window as unknown as { __pushWs?: WebSocket[] }).__pushWs ?? []),
            ws,
          ];
          ws.onopen = () => ws.send(JSON.stringify(msg));
          ws.onmessage = (e) => {
            const m = JSON.parse(String(e.data)) as { type?: string; subscribed?: boolean };
            if (m.type === 'pushState' && m.subscribed) resolve(true);
          };
          setTimeout(() => resolve(false), 10_000);
        }),
      {
        type: 'pushSubscribe',
        endpoint: sub.endpoint,
        p256dh: sub.ua.getPublicKey().toString('base64url'),
        auth: sub.auth.toString('base64url'),
        kinds: ['turnEnd', 'attention', 'job'],
        subagents: false,
      },
    );
  /** RFC 8291, the receiving side. */
  const decryptPush = (body: Buffer, sub: ReturnType<typeof subscriber>) => {
    const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer | string, len: number) =>
      Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), len));
    const salt = body.subarray(0, 16);
    const asPublic = body.subarray(21, 21 + body[20]);
    const record = body.subarray(21 + body[20]);
    const ikm = hkdf(
      sub.ua.computeSecret(asPublic),
      sub.auth,
      Buffer.concat([Buffer.from('WebPush: info\0'), sub.ua.getPublicKey(), asPublic]),
      32,
    );
    const d = crypto.createDecipheriv(
      'aes-128-gcm',
      hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16),
      hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12),
    );
    d.setAuthTag(record.subarray(-16));
    const plain = Buffer.concat([d.update(record.subarray(0, -16)), d.final()]);
    return JSON.parse(plain.subarray(0, -1).toString()) as {
      title: string;
      body: string;
      url: string;
      at: number;
    };
  };

  try {
    proxy = await startServeProxy(certDir);
    browser = await launchBrowser({
      args: [`--host-resolver-rules=MAP ${SERVE_NAME}:443 127.0.0.1:${proxyPort}`],
    });
    let daemon = await startDaemon(fake);

    // ── 1. A logs in with a code ──
    const { ctx: aCtx, page: a } = await open(DESKTOP);
    await a.goto(daemon.link);
    await a.waitForURL(`${local}/`);
    await inApp(a);
    check(true, 'device A logged in with a code');
    const cookie = (await aCtx.cookies()).find((c) => c.name === 'cld_session')?.value ?? '';
    check(cookie.length === 43, 'A holds a session cookie');
    const file = path.join(configDir, 'sessions.json');
    const text = fs.readFileSync(file, 'utf-8');
    const hash = crypto.createHash('sha256').update(cookie).digest('base64url');
    check(
      (JSON.parse(text).sessions as Array<{ hash: string }>).some((s) => s.hash === hash),
      'sessions.json has the SHA-256 of A’s cookie',
    );
    check(!text.includes(cookie), 'sessions.json never has the cookie itself');
    check((fs.statSync(file).mode & 0o777) === 0o600, 'sessions.json is 0600');
    const aDevice = await until(async () => (await me(a))?.deviceId, 'A registers its device key');
    const aKey = savedDevices().devices.find((d) => d.id === aDevice);
    check(
      aKey?.origin === local && Object.keys(aKey.publicKey).sort().join() === 'crv,kty,x,y',
      'devices.json has A’s public key (no private part) for its address',
    );
    check(
      (fs.statSync(path.join(configDir, 'devices.json')).mode & 0o777) === 0o600,
      'devices.json is 0600',
    );
    await sleep(1_500);
    check(
      (await a.getByTestId('auth-toast').count()) === 0,
      'A gets no new-device notice about itself',
    );

    // ── 2. The daemon restarts ──
    await stopDaemon(daemon, 'server-before-restart.log');
    // A's open page lost its socket; the next one must be let in again.
    const reconnected = new Promise<void>((resolve) => {
      a.on('websocket', (ws) => {
        if (new URL(ws.url()).pathname === '/ws') ws.on('framereceived', () => resolve());
      });
    });
    daemon = await startDaemon(fake);
    await Promise.race([
      reconnected,
      new Promise((_r, reject) => setTimeout(() => reject(new Error('no reconnect')), 20_000)),
    ]);
    check(true, 'after the restart, A’s open page reconnected with its old cookie');
    const reload = await a.reload();
    check(reload?.status() === 200, `a reload after the restart is the app (${reload?.status()})`);
    await inApp(a);
    check(true, 'device A is still logged in after the daemon restart');
    await shot(a, 'restart-still-in-desktop');

    // ── 3. A's cookie is deleted: back in with its device key ──
    await aCtx.clearCookies();
    await a.goto(`${local}/`);
    await a.waitForURL(`${local}/`);
    await inApp(a);
    const back = await me(a);
    check(
      back?.method === 'device' && back.id === aDevice,
      'without its cookie, A was let back in silently by its device key, same device',
    );

    // ── 4. 기기 추가 on A; B opens the canonical address and types the code ──
    // O3: A is on Web Push (its row is its device key).
    const pushA = subscriber('a');
    check(await subscribe(a, pushA), 'O3: A subscribed to Web Push');
    await a.getByRole('button', { name: '기기 추가', exact: true }).click();
    const panel = a.getByTestId('add-device');
    const shown = (await a.getByTestId('device-code').textContent())?.trim() ?? '';
    check(
      ((await panel.textContent()) ?? '').includes(canonical),
      `기기 추가 shows the canonical address (${canonical})`,
    );
    check(
      (await panel.getByRole('button', { name: '주소 복사', exact: true }).count()) === 1,
      '기기 추가 has a copy button for the address',
    );
    await shot(a, 'add-device-desktop');
    await closeModal(a);
    const pair = await a.evaluate(async () => {
      const res = await fetch('/api/auth/device-code', { method: 'POST' });
      return (await res.json()) as { url: string; link: string };
    });
    check(
      pair.url === canonical && pair.link.startsWith(`${canonical}/login?code=`),
      'the QR holds the canonical address with the code',
    );

    const { ctx: bCtx, page: b } = await open({ ...DESKTOP, userAgent: WINDOWS_UA });
    // O3: B's key registers only after B has subscribed, under its session (it has no key yet).
    let releaseB: () => void = () => undefined;
    const bMayRegister = new Promise<void>((resolve) => (releaseB = resolve));
    await bCtx.route('**/api/auth/device', async (route) => {
      await bMayRegister;
      await route.continue();
    });
    const pushB = subscriber('b');
    /** newDeviceLogin messages that reached B. */
    const heardByB: Array<{ id: string; label: string }> = [];
    const heardAt = new Set<string>();
    b.on('websocket', (ws) =>
      ws.on('framereceived', (f) => {
        const text = String(f.payload);
        // O3: B has two sockets (the app's and the push subscription's): one notice, once.
        if (text.includes('"newDeviceLogin"') && !heardAt.has(text)) {
          heardAt.add(text);
          heardByB.push(JSON.parse(text) as { id: string; label: string });
        }
      }),
    );
    const anonymous = await b.goto(`${canonical}/`);
    check(anonymous?.status() === 401, 'B without a session gets the login page');
    await b.locator('#code').fill(shown);
    await b.getByRole('button', { name: '로그인', exact: true }).click();
    await b.waitForURL(`${canonical}/`);
    await inApp(b);
    // A code login over https offers a passkey: not now.
    await b
      .getByTestId('passkey-prompt')
      .waitFor({ timeout: 5_000 })
      .then(() => b.getByRole('button', { name: '나중에', exact: true }).click())
      .catch(() => undefined);
    check(
      await b.evaluate(() => window.isSecureContext && !!crypto.subtle),
      'the canonical address is a secure context (WebCrypto there)',
    );
    check(await subscribe(b, pushB), 'O3: B subscribed to Web Push before its key registered');
    releaseB();
    const bDevice = await until(async () => (await me(b))?.deviceId, 'B registers its key');
    check(
      savedDevices().devices.find((d) => d.id === bDevice)?.origin === canonical,
      'B’s key is bound to the canonical address',
    );
    const toast = a.getByTestId('auth-toast');
    await toast.waitFor({ timeout: 15_000 });
    check(
      /새 기기 로그인: Windows · Edge · /.test((await toast.textContent()) ?? '') &&
        (await toast.getByRole('button', { name: '기기 목록', exact: true }).count()) === 1,
      'A is told "새 기기 로그인: Windows · Edge · <time>" with a 기기 목록 button',
    );
    await shot(a, 'new-device-toast-desktop');
    await until(async () => pushes.length > 0, 'the push stub receives a push');
    await sleep(2_000);
    check(
      pushes.length === 1 && pushes[0].path === '/__push/a',
      `O3: exactly one push went out, for A and not for B (${pushes.map((p) => p.path).join(',')})`,
    );
    const note = decryptPush(pushes[0].body, pushA);
    check(
      note.title.includes('Windows · Edge') && note.body.includes('{time}') && note.url === '/?open=security',
      `O3: the push names the new device and opens the 보안 panel (${note.title} | ${note.body} | ${note.url})`,
    );
    check(
      !JSON.stringify(note).includes(shown) && !JSON.stringify(note).includes(token()),
      'O3: the push holds no code or token',
    );
    await toast.getByRole('button', { name: '기기 목록', exact: true }).click();
    const aList = a.getByTestId('security');
    await aList.getByTestId('session-row').nth(1).waitFor();
    check(
      (await aList.getByTestId('session-row').count()) === 2,
      '기기 목록 opens the device list: A and B',
    );
    const auditA = aList.getByTestId('audit');
    await auditA.getByTestId('audit-toggle').click(); // collapsed by default
    await auditA.getByTestId('audit-row').first().waitFor({ timeout: 10_000 });
    const auditText = (await auditA.textContent()) ?? '';
    check(
      auditText.includes('보안 기록') && auditText.includes('새 기기가 등록됐어요') && auditText.includes('Windows · Edge'),
      'O3: A’s 보안 panel shows B’s registration in the 보안 기록',
    );
    await auditA.scrollIntoViewIfNeeded();
    await shot(a, 'o3-audit-desktop');
    await closeModal(a);

    // ── 5. B removes A ──
    await b.getByRole('button', { name: '보안', exact: true }).click();
    const security = b.getByTestId('security');
    await security.getByTestId('session-row').nth(1).waitFor();
    const rowText = (await security.textContent()) ?? '';
    check(
      rowText.includes('자동 로그인') && rowText.includes(SERVE_NAME),
      'the device list shows device keys and their address',
    );
    await shot(b, 'security-devices-desktop');
    const aRow = security.getByTestId('session-row').filter({ hasNotText: '이 기기' });
    await aRow.getByRole('button', { name: '로그아웃', exact: true }).click();
    await b.getByText('로그아웃했어요').waitFor();
    await staysOnLogin(a, 'A, removed from B,');
    check(
      !savedDevices().devices.some((d) => d.id === aDevice),
      'A’s key was deleted with its session',
    );
    await shot(a, 'revoked-login-desktop');
    await closeModal(b);

    // ── 6. C logs in on localhost and moves to the canonical address ──
    const others = () => heardByB.filter((n) => n.id !== bDevice);
    check(others().length === 0, 'B heard of no device but itself so far');
    const { ctx: cCtx, page: c } = await open({ ...DESKTOP, userAgent: MAC_UA });
    await c.goto(await hostLink());
    await c.waitForURL(`${local}/`);
    await inApp(c);
    const cDevice = await until(async () => (await me(c))?.deviceId, 'C registers its key');
    await until(async () => others().length === 1, 'B hears about C');
    check(
      others()[0].id === cDevice && others()[0].label === 'Mac · Chrome',
      'B (on the other address) was told about C’s first login',
    );
    await c.getByRole('button', { name: '보안', exact: true }).click();
    const move = c.getByRole('button', { name: `${SERVE_NAME}로 이 기기 옮기기` });
    await move.waitFor();
    await shot(c, 'move-button-desktop');
    await move.click();
    await c.waitForURL(`${canonical}/`, { timeout: 15_000 });
    await inApp(c);
    const moved = await me(c);
    check(moved?.method === 'move' && moved.id === cDevice, 'C is the same device there');
    await until(
      async () => savedDevices().devices.find((d) => d.id === cDevice)?.origin === canonical,
      'C’s key moves to the canonical address',
    );
    check(
      savedDevices().devices.filter((d) => d.id === cDevice).length === 1,
      'C is still one device (one key)',
    );
    await until(async () => others().length === 2, 'B hears about the key change');
    check(
      others()[1].id === cDevice && others()[1].label === '기기 열쇠가 바뀌었어요: Mac · Chrome',
      'the move announced a key change, not a new device (T-0038)',
    );
    await c.getByRole('button', { name: '보안', exact: true }).click();
    await c.getByTestId('session-row').filter({ hasText: '이 기기' }).waitFor();
    await shot(c, 'moved-desktop');
    const old = await cCtx.newPage();
    await old.goto(`${local}/`);
    await staysOnLogin(old, 'C, back on the old address (its old key removed),');

    // ── 6b. O1: 기기 추가 on C — copy, share, result, nickname, cancel ──
    await closeModal(c);
    await cCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: canonical });
    const addDevice = c.getByRole('button', { name: '기기 추가', exact: true });
    await addDevice.click();
    const invitePanel = c.getByTestId('add-device');
    await invitePanel.getByTestId('device-code').waitFor();
    const typedCode = ((await invitePanel.getByTestId('device-code').textContent()) ?? '').replace(/\s/g, '');
    check(
      (await invitePanel.getByRole('button', { name: '공유', exact: true }).count()) === 0 &&
        (await c.evaluate(() => typeof navigator.share)) === 'undefined',
      '공유 is hidden where the browser has no share sheet',
    );
    await c.evaluate(() => {
      (window as unknown as { shared: unknown }).shared = null;
      (navigator as unknown as { share: (d: unknown) => Promise<void> }).share = (d) => {
        (window as unknown as { shared: unknown }).shared = d;
        return Promise.reject(new DOMException('closed', 'AbortError'));
      };
    });
    const shareButton = invitePanel.getByRole('button', { name: '공유', exact: true });
    await shareButton.waitFor();
    await shareButton.click();
    const shared = await until(
      () => c.evaluate(() => (window as unknown as { shared: { text: string; url: string } | null }).shared),
      'the share sheet is opened',
    );
    check(
      shared.text === '에이전트 타이쿤 기기 추가 — 5분 안에 열어 주세요' &&
        shared.url.startsWith(`${canonical}/login?code=`),
      '공유 hands the OS share sheet the link and the one-line text',
    );
    check(
      (await invitePanel.getByTestId('device-code').count()) === 1 && (await invitePanel.getByRole('alert').count()) === 0,
      'a dismissed share sheet is no error',
    );
    await invitePanel.getByRole('button', { name: '초대 링크 복사', exact: true }).click();
    await invitePanel.getByRole('button', { name: '초대 링크를 복사했어요', exact: true }).waitFor();
    const inviteLink = await c.evaluate(() => navigator.clipboard.readText());
    check(
      inviteLink === shared.url && inviteLink.startsWith(`${canonical}/login?code=`),
      '초대 링크 복사 puts the login link on the clipboard',
    );
    check(
      ((await invitePanel.textContent()) ?? '').includes('창을 닫아도 초대는 취소되지 않아요'),
      'the modal says closing does not cancel the invite',
    );
    await shot(c, 'o1-invite-active-desktop');

    const { ctx: dCtx, page: d } = await open({ ...DESKTOP, userAgent: CHROME_WINDOWS_UA });
    await d.goto(inviteLink);
    await d.waitForURL(`${canonical}/`);
    await inApp(d);
    await d
      .getByTestId('passkey-prompt')
      .waitFor({ timeout: 3_000 })
      .then(() => d.getByRole('button', { name: '나중에', exact: true }).click())
      .catch(() => undefined);
    const registeredLine = invitePanel.getByTestId('invite-registered');
    await registeredLine.waitFor({ timeout: 10_000 });
    check(
      ((await registeredLine.textContent()) ?? '').trim() === 'Windows · Chrome 등록됨',
      'C sees "Windows · Chrome 등록됨" once D opened the link',
    );
    const nameField = invitePanel.getByTestId('invite-nickname');
    check((await nameField.inputValue()) === 'Windows Chrome', 'the nickname is suggested as "Windows Chrome"');
    await shot(c, 'o1-invite-registered-desktop');
    await nameField.fill('노트북');
    await invitePanel.getByRole('button', { name: '저장', exact: true }).click();
    await invitePanel.getByText('이름을 저장했어요').waitFor();
    check(
      ((await registeredLine.textContent()) ?? '').trim() === '노트북(Windows · Chrome) 등록됨',
      'after 저장 the result reads "노트북(Windows · Chrome) 등록됨"',
    );
    await closeModal(c);
    await c.getByRole('button', { name: '보안', exact: true }).click();
    const named = c.getByTestId('session-row').filter({ hasText: '노트북' });
    await named.waitFor();
    check((await named.count()) === 1, 'the device list shows the nickname 노트북');
    await shot(c, 'o1-device-list-nickname-desktop');
    await closeModal(c);
    await d.getByRole('button', { name: '보안', exact: true }).click();
    await d.getByTestId('session-row').filter({ hasText: '노트북' }).waitFor();
    check(true, 'D’s own device list shows 노트북 too');
    await d.close();
    await dCtx.close();

    // A second invitation, cancelled: the link no longer logs in.
    await addDevice.click();
    await invitePanel.getByTestId('device-code').waitFor();
    const typedCode2 = ((await invitePanel.getByTestId('device-code').textContent()) ?? '').replace(/\s/g, '');
    await invitePanel.getByRole('button', { name: '초대 링크 복사', exact: true }).click();
    await invitePanel.getByRole('button', { name: '초대 링크를 복사했어요', exact: true }).waitFor();
    const inviteLink2 = await c.evaluate(() => navigator.clipboard.readText());
    await invitePanel.getByRole('button', { name: '초대 취소', exact: true }).click();
    await invitePanel.getByText('초대를 취소했어요').waitFor();
    check(
      (await invitePanel.getByRole('button', { name: '새 코드 만들기', exact: true }).count()) === 1,
      'after 초대 취소 the modal offers 새 코드 만들기',
    );
    await shot(c, 'o1-invite-cancelled-desktop');
    const { ctx: eCtx, page: e } = await open({ ...DESKTOP, userAgent: CHROME_WINDOWS_UA });
    const refused = await e.goto(inviteLink2);
    check(
      refused?.status() === 401 && (await e.locator('#code').count()) === 1,
      'the cancelled invitation’s link no longer logs in',
    );
    await e.locator('#code').fill(typedCode2);
    await e.getByRole('button', { name: '로그인', exact: true }).click();
    await e.locator('#code').waitFor();
    check((await me(e)) === null, 'nor does its typed code');
    await eCtx.close();
    const linkCodes = [inviteLink, inviteLink2].map((l) => new URL(l).searchParams.get('code')!);
    const logged = daemon.log.join('');
    check(
      ![typedCode, typedCode2, ...linkCodes].some((code) => logged.includes(code)),
      'the daemon log holds no invite code',
    );
    await closeModal(c);

    // ── 6c. O3: a phone opens the push's link and reads the 보안 기록 ──
    {
      const { ctx: eCtx, page: e } = await open(PHONE);
      await e.goto(await hostLink());
      await e.waitForURL(`${local}/`);
      await e.goto(`${local}/?open=security`);
      const panelE = e.getByTestId('security');
      await panelE.waitFor({ timeout: 20_000 });
      check(true, 'O3: /?open=security (the push’s link) opens the 보안 panel on a phone');
      const auditE = panelE.getByTestId('audit');
      await auditE.getByTestId('audit-toggle').click(); // collapsed by default
      await auditE.getByTestId('audit-row').first().waitFor({ timeout: 10_000 });
      const rowsE = (await auditE.textContent()) ?? '';
      check(
        rowsE.includes('새 기기가 등록됐어요') && rowsE.includes('기기를 로그아웃시켰어요') && rowsE.includes('초대'),
        'O3: the 보안 기록 has registrations, the sign-out of A and the invitations',
      );
      await auditE.scrollIntoViewIfNeeded();
      const width = await e.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      check(width, 'O3: no sideways scroll on the phone');
      await shot(e, 'o3-audit-phone');
      await eCtx.close();
    }
    const auditFile = path.join(configDir, 'audit.jsonl');
    const auditDisk = fs.readFileSync(auditFile, 'utf-8');
    check((fs.statSync(auditFile).mode & 0o777) === 0o600, 'O3: audit.jsonl is 0600');
    check(
      [shown, typedCode, typedCode2, token(), ...linkCodes, cookie].every((secret) => !auditDisk.includes(secret)) &&
        !/[?&](token|code)=/.test(auditDisk),
      'O3: audit.jsonl holds no code, cookie or token',
    );
    check(
      ['deviceRegistered', 'inviteCreated', 'inviteUsed', 'deviceRevoked', 'stepUpPassed'].every((kind) =>
        auditDisk.includes(`"kind":"${kind}"`),
      ),
      'O3: audit.jsonl has the registrations, invitations, sign-out and step-ups of this run',
    );

    // ── 7. 패스키(생체 인증) 필수 ──
    // Turning it on takes B's own passkey at this address, tapped (a cookie alone can't).
    const cdp = await bCtx.newCDPSession(b);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await b.getByRole('button', { name: '보안', exact: true }).click();
    const required = b.getByRole('button', { name: /패스키\(생체 인증\) 필수/ });
    check(await required.isDisabled(), 'B cannot turn on 패스키 필수 without a passkey of its own here');
    await b.getByRole('button', { name: '패스키 등록', exact: true }).click();
    await b.getByText('패스키를 등록했어요').first().waitFor();
    await required.click();
    await b.getByText('패스키나 코드로 다시 들어와요').first().waitFor();
    await bCtx.clearCookies();
    await b.goto(`${canonical}/`);
    check(
      (await b.locator('main').getAttribute('data-device')) === null,
      'with 패스키(생체 인증) 필수 on, the login page offers no silent re-login',
    );
    await staysOnLogin(b, 'B, without its cookie,');
    await shot(b, 'passkey-required-login-desktop');
    await stopDaemon(daemon, 'server-after-restart.log');
  } catch (err) {
    // What the daemon said last, with codes and tokens kept out of the console.
    for (const d of daemons)
      console.error(d.log.join('').slice(-4_000).replace(/([?&](code|token)=)[\w-]+/g, '$1[redacted]'));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    killAll();
  }
}

main().then(
  () => console.log('done'),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);

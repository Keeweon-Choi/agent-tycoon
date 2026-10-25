/**
 * T-0022 login check: dist/cli.js with an isolated HOME (the fake office and
 * claude) on a spare port, headless Chromium. Two daemons, one after the
 * other:
 *
 * 1. Default flags (approval requests off).
 *    - Short code: device A (logged in with a link minted with the host token) opens 기기 추가;
 *      phone B types the code and is in. A used and a wrong code are refused;
 *      the QR's link logs in a third device.
 *    - Passkey (CDP virtual authenticator): A registers one in 보안, signs
 *      itself out, and logs back in with "패스키로 로그인".
 *    - QR login (the host's 10-minute code) shows "Face ID로 다음부터 바로 들어오기".
 * 2. --allow-approval-requests: phone C asks; A must type C's code; a request
 *    from Funnel (simulated with the header) asks A once more.
 *
 * Screenshots (phone with iPhone insets, desktop) go to cld/artifacts/t0022/.
 * Hangul comes from malgun.ttf. The real office is never run. A hard deadline and
 * SIGINT/SIGTERM/SIGHUP kill the daemon, which also stops when the check ends.
 *
 *   npx tsx cld/test/run-login.ts <port 18256-18259>
 */
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import { type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon as launchDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0022');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0022/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
// iPhone 15/16 Home-Screen PWA (viewport-fit=cover), portrait.
const INSETS = { top: 59, bottom: 34 };
const PHONE: BrowserContextOptions = {
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};
const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

/** "1234 5678", as a person types it. */
const formatCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;

/** Nothing tappable or text-bearing inside an inset strip (T-0008's rule). */
function stripViolations(page: Page): Promise<string[]> {
  return page.evaluate((ins) => {
    const H = window.innerHeight;
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('[data-testid="agent-overlay"], [data-testid="ez-mood"], canvas')) continue;
      const tappable = el.matches('button, a[href], input, select, textarea');
      const texty = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
      if (!tappable && !texty) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > H) continue;
      // What is clipped away by a scroll or hidden-overflow ancestor is not on screen (the lobby
      // board's rows run on below its box).
      let [y0, y1] = [Math.max(r.top, 0), Math.min(r.bottom, H)];
      for (let a = el.parentElement; a; a = a.parentElement) {
        const st = getComputedStyle(a);
        if (st.overflowX === 'visible' && st.overflowY === 'visible') continue;
        const c = a.getBoundingClientRect();
        [y0, y1] = [Math.max(y0, c.top), Math.min(y1, c.bottom)];
      }
      if (y1 - y0 < 1) continue;
      if (y0 < ins.top || y1 > H - ins.bottom)
        out.push(`<${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 20)}"`);
    }
    return out;
  }, INSETS);
}

interface Daemon {
  /** The startup login link, on localhost (WebAuthn needs a host name). */
  firstLink: string;
  home: string;
  log: string[];
  process: ChildProcess;
}

const daemons: Daemon[] = [];
const fakeHomes: string[] = [];

async function startDaemon(extra: string[]): Promise<Daemon> {
  const fake = makeFakeHome({ claude: 'S-8', agentsJson: true });
  fakeHomes.push(fake.home);
  const d = launchDaemon(fake, port, ['--no-terminal', ...extra]);
  const firstLink = (await d.loginUrl()).replace('http://127.0.0.1:', 'http://localhost:');
  const daemon = { firstLink, home: fake.home, log: d.log, process: d.child };
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

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    for (const d of daemons)
      if (d.process.exitCode === null && d.process.signalCode === null) d.process.kill('SIGKILL');
    for (const home of fakeHomes) fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const base = `http://localhost:${port}`;
  let browser: Browser | undefined;
  const font = fs.readFileSync(FONT);
  const open = async (opts: BrowserContextOptions) => {
    // bypassCSP: the login page's CSP would refuse the injected test fonts.
    const ctx = await browser!.newContext({ ...opts, bypassCSP: true });
    await ctx.route('**/__t0022/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    return { ctx, page: await ctx.newPage() };
  };
  const hangul = async (page: Page, insets = false) => {
    await page.addStyleTag({ content: FONT_CSS });
    if (insets) {
      await page.addStyleTag({
        content: `:root { --cld-safe-top: ${INSETS.top}px !important; --cld-safe-bottom: ${INSETS.bottom}px !important; }
          .t0022-strip { position: fixed; left: 0; right: 0; z-index: 2147483647; pointer-events: none; background: color-mix(in srgb, var(--pixel-accent) 30%, transparent); }`,
      });
      await page.evaluate((ins) => {
        for (const [edge, px] of Object.entries(ins)) {
          const strip = document.createElement('div');
          strip.className = 't0022-strip';
          strip.style.cssText = `${edge}: 0; height: ${px}px;`;
          document.body.append(strip);
        }
      }, INSETS);
    }
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
  };
  const noStrips = async (page: Page, what: string) => {
    const out = await stripViolations(page);
    check(out.length === 0, `${what} clear of the iPhone insets ${out.join(', ')}`);
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const inApp = (page: Page) =>
    page.getByRole('button', { name: '기기 추가', exact: true }).waitFor({ timeout: 15_000 });
  /** A CDP virtual platform authenticator with user verification (Face ID's stand-in). */
  const virtualAuthenticator = async (ctx: BrowserContext, page: Page) => {
    const cdp = await ctx.newCDPSession(page);
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
  };

  try {
    browser = await launchBrowser();

    // ════ Daemon 1: default flags ════
    const one = await startDaemon([]);

    // ── Device A: logged in with the startup link ──
    const { ctx: aCtx, page: a } = await open(DESKTOP);
    await virtualAuthenticator(aCtx, a);
    await a.goto(one.firstLink);
    await a.waitForURL(`${base}/`);
    await inApp(a);
    check(true, 'device A logged in with the startup link');

    // ── 기기 추가 on A, typed on phone B ──
    await a.getByRole('button', { name: '기기 추가', exact: true }).click();
    const shown = (await a.getByTestId('device-code').textContent())?.trim() ?? '';
    check(/^\d{4} \d{4}$/.test(shown), `기기 추가 shows an 8-digit code as "1234 5678" (${shown})`);
    check(
      (await a.getByRole('img', { name: '로그인 QR 코드' }).count()) === 1,
      '기기 추가 shows a QR code',
    );
    check(
      /\d:\d\d 뒤 만료/.test((await a.getByTestId('add-device').textContent()) ?? ''),
      '기기 추가 shows a countdown',
    );
    await hangul(a);
    await shot(a, 'add-device-desktop');
    await a.getByRole('button', { name: 'x', exact: true }).click();

    const { page: b } = await open(PHONE);
    const anonymous = await b.goto(`${base}/`);
    check(anonymous?.status() === 401, 'a phone without a session gets the login page (401)');
    check(
      (await b.getByText('다른 기기에서 승인 요청').count()) === 0,
      'approval requests are not offered by default',
    );
    await hangul(b, true);
    await noStrips(b, 'login page');
    await shot(b, 'login-phone');
    check(
      (await b.locator('#code').getAttribute('inputmode')) === 'numeric',
      'the code field opens the numeric keypad',
    );
    await b.locator('#code').pressSequentially(shown.replace(' ', ''));
    check(
      (await b.locator('#code').inputValue()) === shown,
      'typing 8 digits shows them as "1234 5678"',
    );
    await b.getByRole('button', { name: '로그인', exact: true }).click();
    await b.waitForURL(`${base}/`);
    await inApp(b);
    check(true, 'phone B logged in with the code from 기기 추가');

    // ── Used and wrong codes ──
    const { page: c } = await open(DESKTOP);
    await c.goto(`${base}/`);
    check((await c.title()) === '에이전트 타이쿤 로그인', 'login page title names 에이전트 타이쿤');
    check(
      (await c.locator('h1').textContent())?.trim() === '에이전트 타이쿤',
      'login heading names 에이전트 타이쿤',
    );
    await hangul(c);
    await shot(c, 'login-desktop');
    await c.locator('#code').fill(shown);
    await c.getByRole('button', { name: '로그인', exact: true }).click();
    await c.getByText('코드가 맞지 않거나 만료됐어요').waitFor();
    check(true, 'the used code is refused');
    await c.locator('#code').fill('0000 0000');
    await c.getByRole('button', { name: '로그인', exact: true }).click();
    await c.getByText('코드가 맞지 않거나 만료됐어요').waitFor();
    await hangul(c);
    await shot(c, 'login-error-desktop');
    check(true, 'a wrong code is refused with the same message');

    // ── The QR's link logs in another device ──
    const pair = await a.evaluate(async () => {
      const res = await fetch('/api/auth/device-code', { method: 'POST' });
      return (await res.json()) as { code: string; link: string };
    });
    const { page: d } = await open(PHONE);
    await d.goto(pair.link);
    await d.waitForURL(`${base}/`);
    await inApp(d);
    check(true, 'the 기기 추가 QR link logs in a third device');
    // S3: one invitation, one use -- the QR used the 8 digits up too.
    // (From another client address: the per-address failure limit would otherwise block the later QR login.)
    const OTHER_CLIENT: BrowserContextOptions = {
      ...DESKTOP,
      extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.50' },
    };
    const lateTry = await (await open(OTHER_CLIENT)).page.goto(`${base}/login?code=${pair.code}`);
    check(lateTry?.status() === 401, 'the QR used the invitation up: its 8 digits are refused (S3)');
    // S3: the QR phone's Safari page offers a 2-minute single-use code for the Home-Screen app.
    const handoff = d.getByTestId('handoff-code');
    await handoff.waitFor({ timeout: 15_000 });
    const handoffCode = ((await handoff.textContent()) ?? '').replace(/\s/g, '');
    check(/^\d{8}$/.test(handoffCode), 'that Safari page shows an 8-digit handoff code');
    const { page: pwa } = await open(PHONE);
    await pwa.goto(`${base}/`);
    await pwa.locator('#code').fill(formatCode(handoffCode));
    await pwa.getByRole('button', { name: '로그인', exact: true }).click();
    await pwa.waitForURL(`${base}/`);
    await inApp(pwa);
    check(true, 'the Home-Screen app logs in with the handoff code');
    const reused = await (await open(OTHER_CLIENT)).page.goto(`${base}/login?code=${handoffCode}`);
    check(reused?.status() === 401, "and the handoff code can't be used twice");

    // ── Passkey: register on A, sign out, log back in ──
    await a.getByRole('button', { name: '보안', exact: true }).click();
    const security = a.getByTestId('security');
    await security.getByRole('button', { name: '패스키 등록', exact: true }).click();
    await security.getByTestId('passkey-row').first().waitFor({ timeout: 15_000 });
    check(
      (await security.getByTestId('passkey-row').first().textContent())?.includes('localhost'),
      'A registered a passkey for localhost (virtual authenticator)',
    );
    const rows = await security.getByTestId('session-row').count();
    // A, phone B, and the QR phone (its Home-Screen app is the same device since the O5 review).
    check(rows === 3, `보안 lists the logged-in devices (${rows})`);
    await hangul(a);
    await shot(a, 'security-desktop');
    const mine = security.getByTestId('session-row').filter({ hasText: '이 기기' });
    // S5: signing a device out revokes the passkeys tied to it, and says so first.
    let warning = '';
    a.once('dialog', (dialog) => {
      warning = dialog.message();
      void dialog.accept();
    });
    await mine.getByRole('button', { name: '로그아웃', exact: true }).click();
    await a.waitForLoadState('load');
    await a.locator('#code').waitFor();
    check(
      warning.includes('패스키 1개') && warning.includes('동기화'),
      'signing A out warns first that its passkey (and synced copies) stop working (S5)',
    );
    check(
      (await a.getByRole('button', { name: '패스키로 로그인', exact: true }).count()) === 0,
      "A's revoked passkey is gone: the login page no longer offers it",
    );
    await hangul(a);
    await shot(a, 'login-passkey-desktop');
    const tokenA = fs.readFileSync(path.join(one.home, '.pixel-agents/standalone-token'), 'utf-8');
    const back = (await (
      await fetch(`${base}/api/login-code`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenA.trim()}`, 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { code: string };
    await a.goto(`${base}/login?code=${back.code}`);
    await a.waitForURL(`${base}/`);
    await inApp(a);
    check(true, 'A logs back in with a host code');

    // ── Sign another device out: its socket closes ──
    await a.getByRole('button', { name: '보안', exact: true }).click();
    await a.getByTestId('session-row').filter({ hasText: '이 기기' }).waitFor();
    const others = await a.getByTestId('session-row').filter({ hasNotText: '이 기기' }).count();
    await a.getByRole('button', { name: '다른 기기 모두 로그아웃', exact: true }).click();
    await a.getByText('다른 기기를 모두 로그아웃했어요').waitFor();
    check(others >= 2, `다른 기기 모두 로그아웃 signed out ${others} devices`);
    // T-0034: a page whose session is gone goes to the login page by itself
    // (and its device key went with the session, so it stays there).
    await b.locator('#code').waitFor({ timeout: 15_000 });
    const afterOut = await b.reload();
    check(afterOut?.status() === 401, 'phone B is back on the login page after that');

    // ── QR login from the host: the passkey prompt ──
    const token = fs.readFileSync(path.join(one.home, '.pixel-agents/standalone-token'), 'utf-8');
    const qr = (await (
      await fetch(`${base}/api/login-code`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token.trim()}`, 'content-type': 'application/json' },
        body: '{"qr":true}',
      })
    ).json()) as { code: string; expiresIn: number };
    check(qr.expiresIn === 600, 'the host QR code lives 10 minutes');
    const { page: e } = await open(PHONE);
    await e.goto(`${base}/login?code=${qr.code}`);
    await e.waitForURL(`${base}/`);
    // S3: on an iPhone's Safari the handoff code comes first; the passkey offer follows it.
    await e.getByTestId('handoff').waitFor({ timeout: 15_000 });
    await e.getByRole('button', { name: 'x', exact: true }).click();
    const prompt = e.getByTestId('passkey-prompt');
    await prompt.waitFor({ timeout: 15_000 });
    check(
      (await prompt.textContent())?.includes('Face ID로 다음부터 바로 들어오기 → 패스키 등록'),
      'after a QR login the app offers "Face ID로 다음부터 바로 들어오기 → 패스키 등록"',
    );
    await hangul(e, true);
    await noStrips(e, 'passkey prompt');
    await shot(e, 'passkey-prompt-phone');
    await prompt.getByRole('button', { name: '나중에', exact: true }).click();
    await stopDaemon(one, 'server-default.log');

    // ════ Daemon 2: --allow-approval-requests ════
    const two = await startDaemon(['--allow-approval-requests']);
    const { page: a2 } = await open(DESKTOP);
    await a2.goto(two.firstLink);
    await a2.waitForURL(`${base}/`);
    await inApp(a2);

    const { page: p } = await open(PHONE);
    await p.goto(`${base}/`);
    await p.getByRole('button', { name: '다른 기기에서 승인 요청', exact: true }).click();
    await p.locator('#device-label').fill('내 아이폰');
    await p.getByRole('button', { name: '승인 요청 보내기', exact: true }).click();
    const askCode = ((await p.locator('#approval-code').textContent()) ?? '').replace(/\s/g, '');
    check(/^\d{6}$/.test(askCode), 'the new phone shows a 6-digit code');
    await hangul(p, true);
    await noStrips(p, 'approval request');
    await shot(p, 'approval-request-phone');

    const dialog = a2.getByTestId('approval-dialog');
    await dialog.waitFor({ timeout: 15_000 });
    const text = (await dialog.textContent()) ?? '';
    check(
      text.includes('직접 요청한 게 아니면 거절하세요') &&
        text.includes('내 아이폰') &&
        text.includes('iPhone · Safari') &&
        text.includes('127.0.0.1') &&
        !text.includes(askCode),
      'A sees the warning, name, device, address and time, but not the code',
    );
    const approve = dialog.getByRole('button', { name: '승인', exact: true });
    check(await approve.isDisabled(), 'approving needs the code typed first');
    await dialog.locator('#approval-code').fill(askCode === '000000' ? '111111' : '000000');
    await approve.click();
    await dialog.getByText('코드가 달라요').waitFor();
    check(true, 'a wrong code is refused and the request stays');
    await dialog.locator('#approval-code').fill(askCode);
    await hangul(a2);
    await shot(a2, 'approval-dialog-desktop');
    await approve.click();
    await p.waitForURL(`${base}/`, { timeout: 15_000 });
    await inApp(p);
    check(true, 'the phone is logged in after A typed its code');

    // A request through Funnel (the header tailscaled adds) needs one more yes.
    const { page: f } = await open({
      ...PHONE,
      extraHTTPHeaders: { 'Tailscale-Funnel-Request': '?1' },
    });
    await f.goto(`${base}/`);
    await f.getByRole('button', { name: '다른 기기에서 승인 요청', exact: true }).click();
    await f.getByRole('button', { name: '승인 요청 보내기', exact: true }).click();
    const funnelCode = ((await f.locator('#approval-code').textContent()) ?? '').replace(/\s/g, '');
    await dialog.waitFor({ timeout: 15_000 });
    check(
      ((await dialog.textContent()) ?? '').includes('인터넷 (Funnel)'),
      'a Funnel request is marked as coming from the internet',
    );
    await dialog.locator('#approval-code').fill(funnelCode);
    await dialog.getByRole('button', { name: '승인', exact: true }).click();
    await dialog.getByText('인터넷에서 온 요청이에요').waitFor();
    await hangul(a2);
    await shot(a2, 'approval-funnel-confirm-desktop');
    await dialog.getByRole('button', { name: '맞아요, 승인', exact: true }).click();
    await f.waitForURL(`${base}/`, { timeout: 15_000 });
    await inApp(f);
    check(true, 'the Funnel request is approved only after the extra confirm');
    await stopDaemon(two, 'server-approval.log');
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    for (const d of daemons)
      if (d.process.exitCode === null && d.process.signalCode === null) d.process.kill('SIGKILL');
    for (const home of fakeHomes) fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => console.log('done'),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);

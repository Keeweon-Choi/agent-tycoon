/**
 * O6 check: the 접속 방식 screen has a "직접 쓰는 주소 (HTTPS·VPN)" card. An
 * address is checked when saved (the daemon asks <address>/api/health and wants
 * its own identity proof back): this daemon -> ok and the registration/invite
 * address becomes it; another service, a closed port and a TLS mismatch each
 * say so in one line and are never preferred. The record survives a restart
 * and removing it brings the old address back. Screenshots: cld/artifacts/o6/.
 * No network beyond 127.0.0.1 is touched.
 *
 *   npx tsx cld/test/run-o6.ts <port>   (18256-18259)
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
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

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/o6');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__o6/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 180_000;
const PHONE: BrowserContextOptions = {
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};
const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 900 } };

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

/** Answers /api/health like a different service would: right shape, no proof. */
function listenElsewhere(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => res.end(JSON.stringify({ status: 'ok', service: 'cld-gui' })));
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
/** A port nobody listens on. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address() as { port: number };
      probe.close(() => resolve(free));
    });
  });
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'S-8', agentsJson: true });
  let daemon: Daemon | undefined;
  let browser: Browser | undefined;
  let other: http.Server | undefined;
  const cleanup = () => {
    daemon?.child.kill('SIGKILL');
    other?.close();
    fs.rmSync(fake.home, { recursive: true, force: true });
  };
  const deadline = setTimeout(() => {
    console.error(`aborted: deadline ${DEADLINE_MS / 1000} s`);
    cleanup();
    process.exit(1);
  }, DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(sig, () => {
      cleanup();
      process.exit(1);
    });

  const font = fs.readFileSync(FONT);
  const open = async (opts: BrowserContextOptions) => {
    const context = await browser!.newContext({ ...opts, bypassCSP: true });
    await context.route('**/__o6/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
    return context.newPage();
  };
  const shot = async (page: Page, name: string) => {
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  };
  const token = () => fs.readFileSync(path.join(fake.home, '.pixel-agents/standalone-token'), 'utf8').trim();
  const status = async () =>
    (await (await fetch(`http://127.0.0.1:${port}/api/cld/connector`, { headers: { authorization: `Bearer ${token()}` } })).json()) as {
      canonicalUrl: string;
      custom: { url: string; active: boolean; preferred: boolean } | null;
    };
  const loginLink = async () => (await daemon!.loginUrl()).replace('127.0.0.1', 'localhost');
  const openAccess = async (page: Page) => {
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('tab', { name: '접속', exact: true }).click();
    await page.getByTestId('access-option').getByRole('button', { name: '열기' }).click();
    await page.getByTestId('access-panel').getByTestId('access-current').waitFor();
    await page.getByTestId('access-card-custom').scrollIntoViewIfNeeded();
  };
  const save = async (page: Page, address: string) => {
    const card = page.getByTestId('access-card-custom');
    await card.getByTestId('custom-input').fill(address);
    await card.getByTestId('custom-save').click();
    return card;
  };

  try {
    daemon = startDaemon(fake, port, ['--no-terminal', '--allow-actions']);
    browser = await launchBrowser();
    other = await listenElsewhere();
    await daemon.loginUrl(); // listening
    const base = (await status()).canonicalUrl;

    // ── 1. The card is there; a bad address is refused in one line and stores nothing. ──
    const host = await open(DESKTOP);
    await host.goto(await loginLink());
    await host.getByRole('button', { name: '설정', exact: true }).waitFor({ timeout: 20_000 });
    // The device key registers on login; the step-up for the change is then silent.
    await host.waitForFunction(
      async () => !!((await (await fetch('/api/auth/me')).json()) as { deviceId: string | null }).deviceId,
      undefined,
      { timeout: 20_000 },
    );
    await openAccess(host);
    const card = host.getByTestId('access-card-custom');
    check((await card.textContent())?.includes('직접 쓰는 주소 (HTTPS·VPN)'), 'the custom address card is on the access screen');
    await shot(host, 'card-empty-desktop');
    await save(host, 'http://example.com');
    await card.getByTestId('custom-error').waitFor();
    check((await card.getByTestId('custom-error').textContent())?.includes('https 주소만'), 'a plain-http public address is refused with the reason');
    check((await status()).custom === null, 'nothing was stored');

    // ── 2. This daemon's own address: ok, and it becomes the registration address. ──
    const own = `http://127.0.0.1:${port}/`;
    await card.getByTestId('custom-input').fill(own);
    await card.getByTestId('custom-http-warning').waitFor();
    check(true, 'a plain-http address shows the same LAN warning');
    await card.getByTestId('custom-save').click();
    await card.getByTestId('custom-verdict').waitFor();
    check((await card.getByTestId('custom-verdict').textContent())?.includes('이 사무실이 답해요'), 'self-test: this daemon answers');
    check((await card.getByTestId('custom-state').textContent())?.includes('켜짐'), 'the card says it is on');
    let now = await status();
    check(now.custom?.preferred === true && now.canonicalUrl === own, `registration links use it (${now.canonicalUrl})`);
    await shot(host, 'ok-desktop');

    // ── 3. Another service, a closed port and a TLS mismatch: one line each, never preferred. ──
    const otherUrl = `http://127.0.0.1:${(other.address() as { port: number }).port}/`;
    await save(host, otherUrl);
    await host.getByText('다른 곳이 답해요').waitFor();
    now = await status();
    check(now.custom?.preferred === false && now.canonicalUrl === base, 'another service answering: "다른 곳이 답해요", old address back');
    await shot(host, 'wrong-daemon-desktop');
    await save(host, `http://127.0.0.1:${await closedPort()}/`);
    await host.getByText('닿지 않아요').waitFor();
    check((await status()).canonicalUrl === base, 'a closed port: "닿지 않아요"');
    await shot(host, 'unreachable-desktop');
    await save(host, `https://127.0.0.1:${port}/`); // the daemon speaks plain http: the TLS handshake fails
    await host.getByText('인증서에 문제가 있어요').waitFor();
    check((await status()).canonicalUrl === base, 'a TLS mismatch: "인증서에 문제가 있어요"');

    // ── 4. A passing address survives a restart; removing it brings the old address back. ──
    await save(host, own);
    await host.getByText('이 사무실이 답해요').waitFor();
    await daemon.stop();
    daemon = startDaemon(fake, port, ['--no-terminal', '--allow-actions']);
    await daemon.loginUrl();
    now = await status();
    check(now.custom?.preferred === true && now.canonicalUrl === own, 'the address is still preferred after a restart');
    const phone = await open(PHONE);
    await phone.goto(await loginLink());
    await phone.getByRole('button', { name: '설정', exact: true }).waitFor({ timeout: 20_000 });
    await openAccess(phone);
    await shot(phone, 'ok-phone');
    check((await phone.evaluate(() => document.documentElement.scrollWidth)) <= 393, 'no horizontal scroll on the phone');
    const phoneCard = phone.getByTestId('access-card-custom');
    await phoneCard.getByTestId('custom-remove').click();
    await phoneCard.getByText('설정 안 됨').waitFor();
    now = await status();
    check(now.custom === null && now.canonicalUrl === base, 'removed: the old address is back');
    await shot(phone, 'removed-phone');
    console.log('all checks passed');
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * T-0090b access-screen check: the first localhost visit offers every access
 * card, a choice explains why it cannot work, and a chosen local connection
 * is remembered across a daemon restart. It also checks that an outside
 * device cannot start setup on a read-only daemon, and (S6) that a page on
 * the LAN is asked before a switch cuts its own connection, and (S1) that a
 * cookie-only page trying to widen exposure gets the step-up prompt.
 *
 * The network is injected through CLD_GUI_TEST_REMOTE: no router, Tailscale,
 * cloudflared, or outside request is made. Screenshots go to
 * cld/artifacts/t0074/.
 *
 *   npx tsx cld/test/run-access.ts <port> <direct port>   (both 18256-18259)
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
const DIRECT_PORT = sparePort(3);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0074');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0074/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 240_000;
const PHONE: BrowserContextOptions = {
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};
const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 900 } };
const LOCAL_SWITCH = '원격 끄고 이 PC에서만 쓰기';
/** server/src/constants.ts CUT_GRACE_MS, plus slack. */
const CUT_WAIT_MS = 5_000 + 2_000;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

/** A logged-in device pretending to be an outside browser. */
function outsideSetup(cookie: string): Promise<number> {
  const payload = JSON.stringify({ choice: 'tailscale' });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/cld/connector/setup',
        headers: {
          host: 'outside.example',
          origin: 'http://outside.example',
          cookie,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.once('error', reject);
    request.end(payload);
  });
}

async function main() {
  await assertPortFree(port, DIRECT_PORT);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'S-8', accessChosen: false, agentsJson: true });
  const configDir = path.join(fake.home, '.config/cld-gui');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ lanIp: '127.0.0.2', directPort: DIRECT_PORT }),
  );
  const factsFile = path.join(fake.home, 'remote-facts.json');
  const facts = {
    wsl: null,
    observedIp: null,
    windows: null,
    relay: false,
    ssh: { open: true, banner: 'SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13' },
    tailscale: null as unknown,
    setup: {
      natKind: 'cgnat',
      upnp: false,
      wslMode: null,
      relayReady: false,
      tailscaleInstalled: false,
      tailscaleLoggedIn: false,
      cloudflaredInstalled: false,
      platform: 'linux',
    },
  };
  fs.writeFileSync(factsFile, JSON.stringify(facts));

  let daemon: Daemon | undefined;
  let browser: Browser | undefined;
  const cleanup = () => {
    daemon?.child.kill('SIGKILL');
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
    await context.route('**/__t0074/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    return context.newPage();
  };
  const shot = async (page: Page, name: string) => {
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  };
  const token = () =>
    fs.readFileSync(path.join(fake.home, '.pixel-agents/standalone-token'), 'utf8').trim();
  const api = async () =>
    (await (
      await fetch(`http://127.0.0.1:${port}/api/cld/connector`, {
        headers: { authorization: `Bearer ${token()}` },
      })
    ).json()) as { connector: string; start: boolean };
  const loginLink = async () => (await daemon!.loginUrl()).replace('127.0.0.1', 'localhost');
  const card = (page: Page, id: string) => page.getByTestId(`access-card-${id}`);
  const choose = (page: Page, id: string, title: string) =>
    card(page, id).getByRole('button', { name: `${title} — 이걸로 열기` });
  const openAccess = async (page: Page) => {
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('tab', { name: '접속', exact: true }).click();
    await page.getByTestId('access-option').getByRole('button', { name: '열기' }).click();
    await page.getByTestId('access-panel').getByTestId('access-current').waitFor();
  };

  try {
    daemon = startDaemon(fake, port, ['--no-terminal', '--allow-actions'], {
      CLD_GUI_TEST_REMOTE: factsFile,
    });
    browser = await launchBrowser();

    // ── 1. The T-0090b start screen offers every choice. ──
    const host = await open(DESKTOP);
    await host.goto(await loginLink());
    await host.getByText('접속 방식 고르기').waitFor({ timeout: 20_000 });
    const choices = [
      ['local', '로컬에서 기기 등록'],
      ['direct', '직접 열기'],
      ['ssh', 'SSH'],
      ['duckdns', 'DuckDNS'],
      ['tailscale', 'Tailscale Serve'],
      ['funnel', 'Tailscale Funnel'],
      ['tunnel', '임시 주소'],
      ['lan', '같은 와이파이'],
    ] as const;
    for (const [id, title] of choices) {
      await card(host, id).waitFor({ timeout: 10_000 });
      if (id === 'local') await card(host, id).getByRole('button', { name: LOCAL_SWITCH }).waitFor();
      else await choose(host, id, title).waitFor();
      check(true, `start screen: ${title} card and named opener`);
    }
    check(
      (await card(host, 'funnel').textContent())?.includes('인터넷 누구나 이 주소에 닿을 수 있어요'),
      'the Funnel card warns that anyone on the internet can reach it',
    );
    await shot(host, 'start-desktop');

    // ── 2. A refused card says why, and suggests the viable route. ──
    const direct = card(host, 'direct');
    await choose(host, 'direct', '직접 열기').click();
    await direct.getByText('통신사 CGNAT에서는 공유기 직결 주소로 들어올 수 없어요.').waitFor();
    check(
      (await direct.textContent())?.includes('다른 방식: Tailscale'),
      'a refused direct choice explains CGNAT and suggests Tailscale',
    );
    await shot(host, 'direct-refused-desktop');

    // ── 3. Local is a choice now, and its selection survives a restart. ──
    await card(host, 'local').getByRole('button', { name: LOCAL_SWITCH }).click();
    await card(host, 'local').getByText('이 PC에서만 열어요').waitFor();
    check(
      await api().then((status) => status.connector === 'local' && !status.start),
      'local choice is recorded',
    );
    await host.getByRole('button', { name: '나중에' }).click();
    await daemon.stop();
    daemon = startDaemon(fake, port, ['--no-terminal', '--allow-actions'], {
      CLD_GUI_TEST_REMOTE: factsFile,
    });
    await daemon.loginUrl(); // listening again before the page reloads
    await host.reload();
    await host.getByRole('button', { name: '설정', exact: true }).waitFor({ timeout: 20_000 });
    check(
      (await host.getByText('접속 방식 고르기').count()) === 0,
      'the remembered choice suppresses the start screen after restart',
    );
    await openAccess(host);
    check(
      (await host.getByTestId('access-current').textContent()) === '이 PC만',
      'the saved local connector is shown after restart',
    );

    // ── 4. A read-only daemon still refuses setup from an outside device. ──
    const cookie = (await host.context().cookies())
      .filter((item) => item.name === 'cld_session')
      .map((item) => `${item.name}=${item.value}`)
      .join('; ');
    check(cookie !== '', 'the local browser has a session for the read-only refusal check');
    await daemon.stop();
    daemon = startDaemon(fake, port, ['--no-terminal'], { CLD_GUI_TEST_REMOTE: factsFile });
    await daemon.loginUrl(); // listening again
    check(
      (await outsideSetup(cookie)) === 403,
      'an outside device is refused when setup is read-only',
    );

    // ── 5. The compact access panel still fits a phone. ──
    const phone = await open(PHONE);
    await phone.goto(await loginLink());
    await phone.getByRole('button', { name: '설정', exact: true }).waitFor({ timeout: 20_000 });
    await openAccess(phone);
    await card(phone, 'direct').scrollIntoViewIfNeeded();
    await shot(phone, 'access-phone');
    const width = await phone.evaluate(() => document.documentElement.scrollWidth);
    check(width <= 393, `no horizontal scroll on the phone (${width})`);

    // ── 6. S6: on the LAN, a switch that cuts this page asks first. ──
    await daemon.stop();
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ connector: 'lan', lanIp: '127.0.0.2', directPort: DIRECT_PORT, accessChosen: true }),
    );
    daemon = startDaemon(fake, port, ['--no-terminal', '--allow-actions'], {
      CLD_GUI_TEST_REMOTE: factsFile,
    });
    const lanLink = (await daemon.loginUrl()).replace('127.0.0.1', '127.0.0.2');
    const health = (host: string) =>
      fetch(`http://${host}:${port}/api/health`).then((r) => r.status, () => 0);
    for (let i = 0; i < 20 && (await health('127.0.0.2')) !== 200; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 250));
    check((await health('127.0.0.2')) === 200, 'the LAN listener answers on 127.0.0.2');
    const lan = await open(DESKTOP);
    await lan.goto(lanLink);
    await lan.getByRole('button', { name: '설정', exact: true }).waitFor({ timeout: 20_000 });
    await openAccess(lan);
    const connectorSeen = () =>
      lan.evaluate(async () => ((await (await fetch('/api/cld/connector')).json()) as { connector: string }).connector);
    await card(lan, 'local').getByRole('button', { name: LOCAL_SWITCH }).click();
    const dialog = lan.getByTestId('access-cut');
    await dialog.waitFor({ timeout: 10_000 });
    check(
      (await dialog.textContent())?.includes('지금 이 연결(같은 와이파이)로 들어와 있어요. 바꾸면 이 화면이 끊겨요.'),
      'the cut dialog names the connection this page came through',
    );
    await shot(lan, 'cut-confirm-desktop');
    await dialog.getByRole('button', { name: '그대로 두기' }).click();
    await dialog.waitFor({ state: 'detached' });
    check((await connectorSeen()) === 'lan' && (await health('127.0.0.2')) === 200, '"그대로 두기": still on the LAN, still connected');
    await card(lan, 'local').getByRole('button', { name: LOCAL_SWITCH }).click();
    // S4: no "new address" link to an unverified origin any more; the answer itself is the anchor.
    const statuses: number[] = [];
    lan.on('response', (r) => {
      if (r.url().endsWith('/api/cld/connector/setup')) statuses.push(r.status());
    });
    await dialog.getByRole('button', { name: '그래도 바꾸기' }).click();
    for (let i = 0; i < 60 && !statuses.includes(200); i += 1) await new Promise((resolve) => setTimeout(resolve, 250));
    check(statuses.includes(200), `the switch answer reached the LAN page before its connection closed (${statuses.join(', ')})`);
    await shot(lan, 'cut-moved-desktop');
    check((await health('127.0.0.2')) === 200, 'the LAN stays up for the grace, so the answer arrives');
    await new Promise((resolve) => setTimeout(resolve, CUT_WAIT_MS));
    check((await health('127.0.0.2')) === 0, '"그래도 바꾸기": the LAN listener closed after the grace');
    check((await health('localhost')) === 200, 'localhost still answers');
    check((await api()).connector === 'local', 'the connector is local now');
    check(
      daemon.log.join('').includes('[cld remote] connector lan → local (setup local; via lan)'),
      'the switch is one log line naming the way in',
    );

    // ── 7. S1: a cookie-only page that tries to widen exposure gets the step-up prompt. ──
    // "패스키 필수" turns the device key's silent proof off, so only a passkey tap proves.
    const strict = await open(DESKTOP);
    await strict.goto(await loginLink());
    await strict.getByRole('button', { name: '설정', exact: true }).waitFor({ timeout: 20_000 });
    const cdp = await strict.context().newCDPSession(strict);
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
    await strict.waitForFunction(
      async () => !!((await (await fetch('/api/auth/me')).json()) as { deviceId: string | null }).deviceId,
      undefined,
      { timeout: 20_000 },
    );
    // Registering the passkey is itself a dangerous action: the device key proves it by itself.
    await strict.getByRole('button', { name: '보안', exact: true }).click();
    const security = strict.getByTestId('security');
    await security.getByRole('button', { name: '패스키 등록', exact: true }).click();
    await security.getByTestId('passkey-row').first().waitFor({ timeout: 15_000 });
    check(true, 'a passkey was added after the device key proved itself silently (no prompt)');
    await strict.reload(); // closes the panel
    await strict.getByRole('button', { name: '설정', exact: true }).waitFor({ timeout: 20_000 });
    const required = await strict.evaluate(
      async () =>
        (
          await fetch('/api/auth/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ passkeyRequired: true }),
          })
        ).status,
    );
    check(required === 200, '"패스키 필수" is on');
    // The passkey step-up above is still fresh for 120 s; a restart forgets every proof (memory only).
    await daemon.stop();
    daemon = startDaemon(fake, port, ['--no-terminal', '--allow-actions'], {
      CLD_GUI_TEST_REMOTE: factsFile,
    });
    await daemon.loginUrl();
    await strict.reload();
    await strict.getByRole('button', { name: '설정', exact: true }).waitFor({ timeout: 20_000 });
    await openAccess(strict);
    const prompt = strict.getByTestId('stepup-prompt');
    await choose(strict, 'direct', '직접 열기').click();
    await prompt.waitFor({ timeout: 10_000 });
    check(true, 'a cookie-only page trying to open "직접 열기" gets the step-up prompt');
    await shot(strict, 'stepup-prompt-desktop');
    check((await api()).connector === 'local', 'nothing changed while the prompt is open');
    await prompt.getByRole('button', { name: '취소' }).click();
    await prompt.waitFor({ state: 'detached' });
    check((await api()).connector === 'local', 'cancelled: still the same connector');
    await choose(strict, 'direct', '직접 열기').click();
    await prompt.waitFor({ timeout: 10_000 });
    await prompt.getByRole('button', { name: 'Face ID로 확인' }).click();
    await prompt.waitFor({ state: 'detached', timeout: 10_000 });
    await card(strict, 'direct').getByText('통신사 CGNAT에서는 공유기 직결 주소로 들어올 수 없어요.').waitFor({ timeout: 15_000 });
    check(true, 'after the passkey tap the same request went through (it was then explained as before)');

    console.log('all checks passed');
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon?.stop();
    fs.writeFileSync(
      path.join(OUT, 'daemon.log'),
      (daemon?.log.join('') ?? '').replace(/([?&]code=)[\w-]+/g, '$1[redacted]'),
    );
    fs.rmSync(fake.home, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

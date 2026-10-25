/**
 * REMOTE-XPLAT: the access panel for a Linux daemon (ufw on) and a WSL NAT
 * daemon, on injected facts (CLD_GUI_TEST_REMOTE): "ways in that already
 * exist" first, then the platform's own firewall / Windows relay step.
 * Nothing real is asked (no router, firewall, Windows or Tailscale).
 * Screenshots: cld/artifacts/remote-xplat/.
 *
 *   npx tsx cld/test/run-remote-xplat.ts <port> <direct port>   (both 18256-18259)
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import * as fs from 'fs';
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
const directPort = sparePort(3);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/remote-xplat');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__xplat/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const PHONE: BrowserContextOptions = {
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
};
const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 900 } };
const USE_SSH = '노트북에서 아래 명령 한 줄로 붙어요. 새 포트를 열지 않는 가장 비공개인 길이에요';
const sshLine = (sshPort: number, host: string) =>
  `ssh -N -L ${port}:127.0.0.1:${port}${sshPort === 22 ? '' : ` -p ${sshPort}`} choi@${host}`;

const base = {
  natKind: 'open', upnp: true, relayReady: false, tailscaleInstalled: false,
  tailscaleLoggedIn: false, cloudflaredInstalled: false,
};
const LINUX = {
  wsl: null,
  setup: {
    ...base, wslMode: null, platform: 'linux',
    firewall: { kind: 'ufw', add: [`sudo ufw allow ${port}/tcp`, `sudo ufw allow ${directPort}/tcp`], ready: false, confirm: true },
  },
  existing: [
    { ok: true, text: 'SSH 서버가 이미 22번에서 답해요 (SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13)', fix: '지금 192.168.0.9에서 SSH로 접속해 있어요',
      guide: USE_SSH, actions: [{ kind: 'copy', text: sshLine(22, '192.168.0.5'), label: 'SSH 명령 복사' }], suggest: 'ssh' },
    { ok: true, text: 'Tailscale이 이미 로그인돼 있어요 (office.tail1.ts.net)',
      guide: 'Tailscale Serve 카드로 이 이름에 이 PC를 내 기기에만 열어요 (공유기 포트 없음)', suggest: 'tailscale' },
  ],
};
/** This PC's real shape (read once, read-only): sshd 2233 in WSL, Windows forwards 2233 and 443. */
const WSL = {
  wsl: 'nat',
  setup: {
    ...base, natKind: 'unknown', wslMode: 'nat', platform: 'wsl',
    wslInstructions: `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=443 connectaddress=127.0.0.1 connectport=${directPort}\nRemove-NetFirewallRule -Name cld-gui-443 -ErrorAction SilentlyContinue; New-NetFirewallRule -Name cld-gui-443 -DisplayName "cld-gui 443" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow`,
  },
  existing: [
    { ok: true, text: 'SSH 서버가 이미 2233번에서 답해요 (SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13)', fix: 'Windows가 2233번을 이 WSL의 SSH(2233번)로 넘기고 있어요',
      guide: USE_SSH, actions: [{ kind: 'copy', text: sshLine(2233, '192.168.0.12'), label: 'SSH 명령 복사' }], suggest: 'ssh' },
    { ok: true, text: 'Windows가 80번을 172.24.0.10:80로 넘기고 있어요', guide: '이 PC가 만든 전달이 아니에요. 건드리지 않아요' },
    { ok: true, text: 'Windows 방화벽 규칙이 이미 있어요: cld-gui-443', guide: '이 규칙이 있는 포트는 방화벽 단계를 다시 묻지 않아요' },
  ],
};

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port, directPort);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'S-8', accessChosen: false, agentsJson: true });
  const configDir = path.join(fake.home, '.config/cld-gui');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ lanIp: '127.0.0.2', directPort }));
  const factsFile = path.join(fake.home, 'remote-facts.json');
  const writeFacts = (facts: object) =>
    fs.writeFileSync(factsFile, JSON.stringify({ observedIp: null, windows: null, relay: false, ssh: { open: true, banner: 'SSH-2.0-OpenSSH_9.6p1' }, tailscale: null, ...facts }));
  writeFacts(LINUX);
  let daemon: Daemon | undefined;
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  const font = fs.readFileSync(FONT);
  try {
    daemon = startDaemon(fake, port, ['--no-terminal', '--allow-actions'], { CLD_GUI_TEST_REMOTE: factsFile });
    browser = await launchBrowser();
    const open = async (opts: BrowserContextOptions) => {
      const context = await browser!.newContext({ ...opts, bypassCSP: true });
      await context.route('**/__xplat/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
      const page = await context.newPage();
      await page.goto((await daemon!.loginUrl()).replace('127.0.0.1', 'localhost'));
      await page.getByText('접속 방식 고르기').waitFor({ timeout: 20_000 });
      return page;
    };
    const shot = async (page: Page, name: string, testId: string) => {
      await page.getByTestId(testId).first().scrollIntoViewIfNeeded();
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    };
    const scenario = async (name: string, platform: typeof LINUX | typeof WSL, expectStep: string, sshText: string) => {
      writeFacts(platform);
      for (const [form, opts] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
        const page = await open(opts);
        const existing = page.getByTestId('access-existing');
        await existing.waitFor({ timeout: 15_000 });
        check((await existing.textContent())?.includes(sshText), `${name} ${form}: the SSH already there, with its laptop line`);
        await shot(page, `${name}-existing-${form}`, 'access-existing');
        const direct = page.getByTestId('access-card-direct');
        await direct.getByRole('button', { name: '이걸로 열기' }).click();
        await direct.getByText(expectStep).waitFor({ timeout: 15_000 });
        check(true, `${name} ${form}: direct stops at "${expectStep}"`);
        // ufw cannot be read without root: the person says they ran it. Windows' relay re-checks by itself.
        if (name === 'linux') await direct.getByRole('button', { name: '실행했어요' }).waitFor();
        else await direct.getByRole('button', { name: '다시 확인' }).waitFor();
        await shot(page, `${name}-direct-${form}`, 'access-run-direct');
        await page.context().close();
      }
    };
    await scenario('linux', LINUX, 'ufw 방화벽이 켜져 있어 바깥에서 오는 연결을 막아요', sshLine(22, '192.168.0.5'));
    await scenario('wsl-nat', WSL, 'Windows가 이 PC로 연결을 넘겨야 해요', sshLine(2233, '192.168.0.12'));
  } finally {
    await browser?.close();
    daemon?.child.kill('SIGKILL');
    fs.rmSync(fake.home, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

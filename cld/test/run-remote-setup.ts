/** Selected remote setup on injected facts. */
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  type Daemon,
  launchBrowser,
  makeFakeHome,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const directPort = sparePort(3);
if (port === directPort) throw new Error('daemon and direct ports must differ');

async function main() {
  await assertPortFree(port, directPort);
  const fake = makeFakeHome({ claude: 'S-8', accessChosen: false, agentsJson: true });
  const configDir = path.join(fake.home, '.config/cld-gui');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ lanIp: '127.0.0.2', directPort }),
  );
  const factsFile = path.join(fake.home, 'remote-facts.json');
  const facts = {
    wsl: null,
    observedIp: null,
    windows: null,
    relay: false,
    ssh: { open: false, banner: '' },
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
  const writeFacts = () => fs.writeFileSync(factsFile, JSON.stringify(facts));
  writeFacts();
  let daemon: Daemon | undefined;
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    daemon = startDaemon(fake, port, ['--no-terminal', '--allow-actions'], {
      CLD_GUI_TEST_REMOTE: factsFile,
    });
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto((await daemon.loginUrl()).replace('127.0.0.1', 'localhost'));
    await page.getByText('접속 방식 고르기').waitFor({ timeout: 20_000 });
    await page.waitForFunction(
      async () => (await (await fetch('/api/auth/me')).json()).deviceId,
      undefined,
      { timeout: 10_000 },
    );
    const panel = page.getByTestId('access-panel');
    const cards = await panel
      .locator('[data-testid^="access-card-"]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid')));
    const expected = ['local', 'direct', 'ssh', 'duckdns', 'tailscale', 'funnel', 'tunnel', 'lan'].map(
      (id) => `access-card-${id}`,
    );
    if (JSON.stringify(cards) !== JSON.stringify(expected))
      throw new Error(`wrong card order: ${cards}`);

    await page.evaluate(() => {
      const w = window as Window & { __opened?: string[] };
      w.__opened = [];
      w.open = ((url?: string | URL) => {
        w.__opened?.push(String(url));
        return null;
      }) as typeof window.open;
    });
    const tail = panel.getByTestId('access-card-tailscale');
    await tail.getByRole('button', { name: '이걸로 열기' }).click();
    await tail.getByText('Tailscale을 설치하세요').first().waitFor();
    const tailText = await tail.textContent();
    if (!tailText?.includes('curl -fsSL https://tailscale.com/install.sh | sh'))
      throw new Error('missing Linux install copy text');
    await tail.getByRole('button', { name: 'Tailscale 설치 페이지 열기' }).click();
    const opened = await page.evaluate(() => (window as Window & { __opened?: string[] }).__opened);
    if (!opened?.includes('https://tailscale.com/download/linux'))
      throw new Error('wrong Tailscale download URL');

    const direct = panel.getByTestId('access-card-direct');
    await direct.getByRole('button', { name: '이걸로 열기' }).click();
    await direct.getByText('CGNAT', { exact: false }).waitFor();
    await direct.getByRole('button', { name: '다른 방식: Tailscale' }).click();
    if ((await tail.getAttribute('data-selected')) !== 'true')
      throw new Error('CGNAT suggestion did not select Tailscale');

    const ssh = panel.getByTestId('access-card-ssh');
    await ssh.getByRole('button', { name: '이걸로 열기' }).click();
    // The answer arrives after the click: wait for it instead of reading the card at once.
    await ssh
      .getByText(`ssh -N -L ${port}:127.0.0.1:${port}`, { exact: false })
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => {
        throw new Error('missing SSH tunnel line');
      });

    await tail.getByRole('button', { name: '이걸로 열기' }).click();
    await tail.getByRole('button', { name: '다시 확인' }).waitFor();
    facts.setup.tailscaleInstalled = true;
    facts.setup.tailscaleLoggedIn = true;
    facts.tailscale = {
      Web: {
        'office.test.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } },
      },
    };
    writeFacts();
    await tail.getByText('바깥 접속 확인됨', { exact: false }).waitFor({ timeout: 15_000 });
    const saved = JSON.parse(fs.readFileSync(path.join(configDir, 'remote-test.json'), 'utf8')) as {
      ok: boolean;
      url: string;
    };
    if (!saved.ok || saved.url !== 'https://office.test.ts.net/')
      throw new Error('self-test result was not saved');
    await panel.getByRole('button', { name: '바깥 주소로 옮기기' }).waitFor({ timeout: 10_000 });
    await panel
      .getByTestId('outside-device-invite')
      .getByRole('img', { name: '로그인 QR 코드' })
      .waitFor();
    console.log(
      'ok - selected cards, guides, suggestion, auto resume, self-test, and registered-device move',
    );
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

/**
 * R3: 설정's 켜짐·복구 section on a fake WSL install (CLD_GUI_TEST_START_POLICY: injected facts and a
 * fake manager that only records the call). Desktop: the facts, "항상 실행" asks for linger first,
 * "linger 없이" leaves the by-hand line, then linger is turned on after asking. Phone: the same section,
 * and 수동. Nothing real runs (no agty, schtasks, powershell, wsl, systemctl or loginctl).
 * Screenshots: cld/artifacts/r3/.
 *
 *   npx tsx cld/test/run-r3.ts <port>   (18256-18259)
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { registryPath, saveRegistry } from '../../server/src/cld/engine/registry.js';
import {
  assertPortFree,
  type Daemon,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/r3');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__r3/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const PHONE: BrowserContextOptions = {
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
};
const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 900 } };

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'S-8', agentsJson: true });
  const configDir = configDirectory(fake.home);
  // The first-run question is answered: this run is about 설정.
  fs.writeFileSync(path.join(configDir, 'new-agent-permission.json'), JSON.stringify({ mode: 'ask' }));
  const folder = path.join(fake.home, 'work', 'lead-a');
  fs.mkdirSync(folder, { recursive: true });
  saveRegistry(registryPath(fake.home), [
    { projectId: 'p_aaaaaaaaaa', name: 'lead-a', folder, wantRunning: false, alwaysOn: true },
  ]);
  const factsFile = path.join(fake.home, 'start-policy-facts.json');
  fs.writeFileSync(
    factsFile,
    JSON.stringify({
      platform: 'wsl',
      taskPresent: true,
      lingerOn: false,
      record: { startPolicy: 'on-demand', service: { name: 'agent-tycoon', kind: 'systemd' }, wslDistro: 'Ubuntu' },
    }),
  );
  const facts = () => JSON.parse(fs.readFileSync(factsFile, 'utf8')) as { calls?: string[][]; record: Record<string, unknown> };
  let daemon: Daemon | undefined;
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  const font = fs.readFileSync(FONT);
  try {
    daemon = startDaemon(fake, port, ['--no-terminal', '--allow-actions'], { CLD_GUI_TEST_START_POLICY: factsFile });
    browser = await launchBrowser();
    const open = async (opts: BrowserContextOptions) => {
      const context = await browser!.newContext({ ...opts, bypassCSP: true });
      await context.route('**/__r3/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
      const page = await context.newPage();
      await page.goto((await daemon!.loginUrl()).replace('127.0.0.1', 'localhost'));
      const settings = page.getByRole('button', { name: '설정', exact: true });
      await settings.waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1_500);
      await settings.click();
      await page.getByRole('tab', { name: '접속', exact: true }).click();
      const section = page.getByTestId('start-policy-option');
      await section.waitFor({ timeout: 15_000 });
      return { page, section };
    };
    const shot = async (page: Page, name: string, testId: string) => {
      await page.getByTestId(testId).first().scrollIntoViewIfNeeded();
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    };

    // ── Desktop ──
    {
      const { page, section } = await open(DESKTOP);
      const text = (await section.textContent()) ?? '';
      check(text.includes('WSL: Ubuntu 실행 중') && text.includes('사무실: 실행 중'), 'WSL and the daemon are shown separately');
      check(text.includes('서비스: agent-tycoon (systemd)') && text.includes('linger: 꺼짐'), 'the service and linger are shown');
      check(text.includes('항상 켜기') && text.includes('lead-a'), 'the always-on agent is listed under 복구');
      check((await section.locator('[data-policy="on-demand"][aria-pressed="true"]').count()) === 1, 'the current policy is on-demand');
      await shot(page, 'r3-settings-desktop', 'start-policy-option');

      await section.locator('[data-policy="always"]').click();
      await section.getByTestId('start-policy-linger-ask').waitFor();
      check(!facts().calls, 'choosing 항상 실행 asks about linger before calling the manager');
      await shot(page, 'r3-linger-ask-desktop', 'start-policy-linger-ask');

      await section.getByRole('button', { name: 'linger 없이' }).click();
      await section.getByTestId('start-policy-no-linger').waitFor();
      check(JSON.stringify(facts().calls) === JSON.stringify([['/fake/manager.mjs', 'start-policy', 'always', '--no-linger', '--root', '/fake/agent-tycoon']]),
        'without linger: the manager is called with --no-linger');
      check((await section.getByTestId('start-policy-no-linger').textContent())?.includes('sudo loginctl enable-linger owner'), 'the by-hand linger command is shown');
      check((await section.textContent())?.includes('agent-tycoon-wsl-Ubuntu 있음'), 'the logon task is registered');
      await shot(page, 'r3-always-no-linger-desktop', 'start-policy-no-linger');

      await section.getByTestId('start-policy-no-linger').getByRole('button', { name: 'linger 켜기' }).click();
      await section.getByTestId('start-policy-linger-ask').getByRole('button', { name: 'linger 켜기' }).click();
      await section.getByText('linger: 켜짐 (Agent Tycoon 이 켰어요)').waitFor({ timeout: 10_000 });
      check(facts().calls?.at(-1)?.includes('--linger'), 'after consent the manager gets --linger');
      await shot(page, 'r3-always-linger-desktop', 'start-policy-option');
      await page.context().close();
    }

    // ── Phone ──
    {
      const { page, section } = await open(PHONE);
      check((await section.locator('[data-policy="always"][aria-pressed="true"]').count()) === 1, 'phone: the policy set on the desktop shows');
      await shot(page, 'r3-settings-phone', 'start-policy-option');
      await section.locator('[data-policy="manual"]').click();
      await section.getByTestId('start-policy-note').waitFor({ timeout: 10_000 });
      check(facts().record.startPolicy === 'manual' && !facts().record.linger, 'phone: 수동 is applied (our linger is undone by the manager)');
      await shot(page, 'r3-manual-phone', 'start-policy-note');
      await page.context().close();
    }
    console.log('PASS');
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

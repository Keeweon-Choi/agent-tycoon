/**
 * O4 first-run onboarding check: a fresh HOME's first office open shows the
 * Intro's skip-permissions step (F-11); the choice (the permission mode NEW agents
 * start with) is saved once (~/.config/cld-gui/new-agent-permission.json) and seeds a
 * project added afterwards, never one that already existed; the old upstream
 * host-wide flag is not read;
 * the remote-first-then-phone step follows and links to the existing 접속 방식
 * and 기기 추가 screens; the next open shows nothing; Settings keeps the choice
 * changeable. Screenshots go to cld/artifacts/o4/.
 *
 *   npx tsx cld/test/run-o4.ts <port>   (18256-18259)
 */
import type { Browser, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { loadRegistry, registryPath, saveRegistry } from '../../server/src/cld/engine/registry.js';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/o4');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__o4/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 180_000;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'S-8', agentsJson: true, newAgentChoice: false });
  const choice = (): string | undefined => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(fake.home, '.config/cld-gui/new-agent-permission.json'), 'utf8'),
      ).mode;
    } catch {
      return undefined;
    }
  };
  // A project that exists before the answer: the answer must never change it.
  const before = path.join(fake.home, 'work', 'before');
  fs.mkdirSync(before, { recursive: true });
  saveRegistry(registryPath(fake.home), [
    { projectId: 'p_aaaaaaaaaa', name: 'before', folder: before, wantRunning: false },
  ]);
  const beforeMode = () =>
    loadRegistry(registryPath(fake.home)).projects.find((p) => p.name === 'before')?.permissionMode;
  // The old upstream host-wide flag (same ~/.pixel-agents file) must not count as an answer.
  fs.mkdirSync(path.join(fake.home, '.pixel-agents'), { recursive: true });
  fs.writeFileSync(
    path.join(fake.home, '.pixel-agents/config.json'),
    JSON.stringify({ standalone: { bypassPermissions: true, bypassAnswered: true } }),
  );
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
  const shot = async (page: Page, name: string) => {
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  };

  try {
    check(choice() === undefined, 'a fresh HOME has not answered the question');
    daemon = startDaemon(fake, port, ['--no-terminal', '--allow-actions']);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
    await context.route('**/__o4/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    const page = await context.newPage();
    const link = (await daemon.loginUrl()).replace('127.0.0.1', 'localhost');
    await page.goto(link);

    // ── 1. The first open asks. ──
    await page.getByTestId('bypass-what').waitFor({ timeout: 30_000 });
    check(true, 'the first open shows the skip-permissions step');
    check(
      (await page.getByTestId('bypass-risk').textContent())?.includes('되돌리지 못할 수도'),
      'the risk is said plainly, including that it may be irreversible',
    );
    check(
      (await page.getByRole('dialog').getByText('기본으로는 위험할 수 있는 일마다').count()) === 1,
      'it says what the default is',
    );
    check(choice() === undefined, 'nothing is stored before the owner chooses (an old upstream flag is no answer)');
    await page.waitForTimeout(1_500); // the greeter finishes materializing
    await shot(page, 'o4-bypass-step-desktop');

    // ── 2. The choice is stored once; the remote step follows. ──
    await page.getByTestId('bypass-allow').click();
    await page.getByText('밖에서 쓰려면: 원격 접속 먼저, 그다음 폰').first().waitFor({ timeout: 15_000 });
    check(choice() === 'bypass', 'the choice (new agents without asking) is saved');
    check(beforeMode() === undefined, 'a project that existed before the answer is not changed');
    check(true, 'the remote-first-then-phone step follows the saved choice');
    await shot(page, 'o4-remote-step-desktop');

    // ── 3. Its two buttons open the existing screens. ──
    const bubble = page.getByRole('dialog').filter({ hasText: '밖에서 쓰려면' });
    await bubble.getByRole('button', { name: '열기' }).click();
    await page.getByTestId('access-panel').waitFor({ timeout: 15_000 });
    check(true, 'the first button opens the existing 접속 방식 screen');
    await shot(page, 'o4-remote-access-opened');
    await page.keyboard.press('Escape');
    check(
      (await page.getByTestId('access-panel').count()) === 1 && (await bubble.count()) === 1,
      'Escape with a screen open does not abort the tour',
    );
    await page.getByRole('button', { name: 'x', exact: true }).last().click();
    await page.getByTestId('access-panel').waitFor({ state: 'detached', timeout: 5_000 });
    await bubble.getByRole('button', { name: '기기 추가' }).click();
    await page.getByText('8자리').first().waitFor({ timeout: 15_000 });
    check(true, 'the second button opens the existing 기기 추가 screen');
    await shot(page, 'o4-remote-add-device-opened');
    await page.getByRole('button', { name: 'x', exact: true }).last().click();
    await page.getByTestId('intro-finish').click();
    await page.getByTestId('intro-finish').waitFor({ state: 'detached', timeout: 5_000 });
    check(true, 'finishing closes the tour');

    // ── 4. Asked once: the next open shows nothing. ──
    await page.reload();
    await page.getByRole('button', { name: '설정', exact: true }).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(3_000);
    check((await page.getByTestId('bypass-what').count()) === 0, 'a reload does not ask again');
    await shot(page, 'o4-second-open-desktop');

    // ── 5. The choice stays changeable in 설정. ──
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('tab', { name: '보안', exact: true }).click();
    const option = page.getByTestId('bypass-option');
    await option.waitFor();
    check((await option.textContent())?.includes('켜짐'), '설정 shows the saved choice (켜짐)');
    await shot(page, 'o4-settings-row-desktop');
    await option.getByRole('button').click();
    await option.getByText('꺼짐').waitFor({ timeout: 10_000 });
    check(choice() === 'ask', 'turning it off in 설정 is saved');
    check(beforeMode() === undefined, 'and still no existing project changed');
    console.log('PASS');
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

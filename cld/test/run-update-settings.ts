/**
 * P3a: 설정 › 일반's version-and-updates row, with GET/POST /api/cld/update mocked in the page
 * (page.route): a managed install with an update, one up to date whose last check failed (and
 * 지금 확인 pressed), and a source install (no button). Nothing is downloaded or installed.
 * Screenshots: cld/artifacts/feat-update-github-releases/.
 *
 *   npx tsx cld/test/run-update-settings.ts <port>   (18256-18599)
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  type Daemon,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  topBarButton,
  topBarReady,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/feat-update-github-releases');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__upd/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const BASE = {
  signature: { canVerify: true, release: 'unknown', officialKey: false, osCodeSigning: false },
  facts: { sessions: 2, jobs: 0, worktrees: 1, merging: false },
  canInstall: true,
  terminalOnly: false,
  command: 'agty update --from https://github.com/Keeweon-Choi/agent-tycoon/releases/latest/download',
  install: null,
};
const REASON = 'download failed (HTTP 404): https://github.com/Keeweon-Choi/agent-tycoon/releases/latest/download/SHA256SUMS';

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'S-8', agentsJson: true });
  fs.writeFileSync(path.join(configDirectory(fake.home), 'new-agent-permission.json'), JSON.stringify({ mode: 'ask' }));
  let daemon: Daemon | undefined;
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  const font = fs.readFileSync(FONT);
  try {
    daemon = startDaemon(fake, port, ['--no-terminal']);
    browser = await launchBrowser();
    const open = async (get: object, post?: () => { status: number; body: object }) => {
      const context = await browser!.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
      await context.route('**/__upd/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
      await context.route('**/api/cld/update', (route) => route.fulfill({ json: get }));
      const posts: string[] = [];
      await context.route('**/api/cld/update/check', (route) => {
        posts.push(route.request().method());
        const r = post?.() ?? { status: 404, body: {} };
        return route.fulfill({ status: r.status, json: r.body });
      });
      const page = await context.newPage();
      await page.goto((await daemon!.loginUrl()).replace('127.0.0.1', 'localhost'));
      await topBarReady(page, 30_000);
      await page.waitForTimeout(1_500);
      const later = page.getByTestId('update-notice').getByRole('button', { name: '나중에' });
      if (await later.count()) await later.click();
      await topBarButton(page, '설정');
      const row = page.getByTestId('update-option');
      await row.waitFor({ timeout: 15_000 });
      return { page, row, posts };
    };
    const shot = async (page: Page, name: string) => {
      await page.getByTestId('update-option').scrollIntoViewIfNeeded();
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    };
    const ago = (minutes: number) => Date.now() - minutes * 60_000;

    {
      const { page, row } = await open({
        ...BASE,
        managed: true,
        current: '0.1.0',
        available: { version: '0.2.0', notes: '- 새 기능\n' },
        lastCheck: { at: ago(5), ok: true },
      });
      const text = (await row.textContent()) ?? '';
      check(text.includes('지금 버전 0.1.0') && text.includes('5분 전') && text.includes('확인됨'), 'managed: version, when, OK');
      check(text.includes('새 버전 0.2.0'), 'managed: the new version is named');
      check(await row.getByTestId('update-check-now').isVisible(), 'managed: 지금 확인 is there');
      await shot(page, 'update-managed-available');
      await page.context().close();
    }
    {
      let calls = 0;
      const failed = (at: number) => ({ ...BASE, managed: true, current: '0.2.0', available: null, lastCheck: { at, ok: false, reason: REASON } });
      const { page, row, posts } = await open(failed(ago(70)), () =>
        ++calls === 1 ? { status: 200, body: failed(Date.now()) } : { status: 429, body: { error: 'x', code: 'throttled' } },
      );
      check(((await row.textContent()) ?? '').includes('1시간 전 · 실패: download failed (HTTP 404)'), 'failed: when and why');
      await row.getByTestId('update-check-now').click();
      await row.getByText('방금 · 실패').waitFor({ timeout: 10_000 });
      check(posts.join() === 'POST', '지금 확인 posts once and shows the fresh result');
      await row.getByTestId('update-check-now').click();
      await row.getByTestId('update-check-error').waitFor({ timeout: 10_000 });
      check(((await row.textContent()) ?? '').includes('1분 뒤 다시'), 'a second press within a minute is told to wait');
      await shot(page, 'update-managed-failed-check');
      await page.context().close();
    }
    {
      const { page, row } = await open({ ...BASE, managed: false, current: null, available: null, canInstall: false, lastCheck: null });
      check(((await row.textContent()) ?? '').includes('소스 체크아웃'), 'source: says where updates come from');
      check((await row.getByTestId('update-check-now').count()) === 0, 'source: no button');
      await shot(page, 'update-source');
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

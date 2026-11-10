/**
 * BRANDING proof: in the tycoon office a phone (390x844) gets the "Updated to vX" notice once
 * after the version changes, tapping it opens the update log, its Discord button only says the
 * Discord is not open yet, and Settings > 업데이트 소식 opens the log again. dist/cli.js with an
 * isolated HOME on a spare port, headless Chromium without a GPU.
 *
 *   npx tsx agent-tycoon/test/run-branding.ts <port 18256-18259> [shot prefix]
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  warmUpOffice,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const PREFIX = process.argv[3] ?? 'phone';
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/branding');
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;

function check(ok: unknown, what: string): void {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const daemon = startDaemon(makeFakeHome({ claude: 'R-8', agentsJson: true }), port, [
    '--no-terminal',
  ]);
  try {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'ko-KR',
    });
    await ctx.addInitScript(INIT);
    await ctx.addInitScript(() => {
      try {
        if (localStorage.getItem('agty.title-scene') === null)
          localStorage.setItem('agty.title-scene', 'off');
      } catch {
        // about:blank
      }
    });
    await warmUpOffice(ctx, daemon);
    const page = await ctx.newPage();
    await page.goto(await daemon.loginUrl());
    await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
    const notice = page.getByTestId('update-notice');
    await notice.waitFor({ timeout: 15_000 });
    check(/v0\.1/.test((await notice.innerText()) ?? ''), 'the update notice names v0.1');
    await page.screenshot({ path: path.join(OUT, `${PREFIX}-office-notice.png`) });

    await notice.click();
    await page.getByText('GitHub 에서 보기').waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: '디스코드' }).click();
    const soon = page.getByTestId('changelog-discord-note');
    await soon.waitFor({ timeout: 5_000 });
    check(
      (await soon.innerText()).includes('디스코드는 아직 준비 중이에요'),
      'the Discord button shows the not-open note',
    );
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `${PREFIX}-office-log.png`) });

    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(2500);
    check(
      (await page.getByTestId('update-notice').count()) === 0,
      'after a reload the notice does not come back',
    );

    const settings = page.getByRole('button', { name: /^설정$/ }).first();
    await settings.click({ timeout: 10_000 });
    const row = page.getByTestId('changelog-option').first();
    await row.waitFor({ timeout: 10_000 });
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, `${PREFIX}-office-settings.png`) });
    await row.getByRole('button').click();
    await page.getByText('GitHub 에서 보기').waitFor({ timeout: 10_000 });
    check(true, 'Settings > 업데이트 소식 opens the log');
    await ctx.close();
  } finally {
    await browser.close();
    await daemon.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

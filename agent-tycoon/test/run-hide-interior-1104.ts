/**
 * HIDE-INTERIOR (owner 11-04): the interior editor is postponed, so nothing on screen leads to it
 * (the 꾸미기 window is open again: agent-tycoon/test/run-looks-tabs-1104.ts). dist/cli.js with an isolated HOME on a spare port, headless
 * Chromium (--disable-gpu), desktop 1282x832 and phone 393x852. One fake Claude session, no model.
 *
 * Both viewports (with window.__AGENT_TYCOON_LATER_FEATURES = 'off', the e2e harness' way to test the
 * hidden state): the elevator keeps its 편집 (층 편집기, not the interior); no 인테리어 / Layout button, no 배치 내보내기 / 가져오기 in 설정,
 * Run with `--on` (the harness default: features on) to see the 인테리어 checks fail (negative control).
 * Screenshots to agent-tycoon/artifacts/hide-interior-1104/.
 *
 *   npx tsx agent-tycoon/test/run-hide-interior-1104.ts <port 18510-18519> [--on]
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  topBarButton,
  topBarReady,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const ON = process.argv.includes('--on');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/hide-interior-1104');

let failed = 0;
function check(ok: unknown, what: string): void {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
}

function session(home: string, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c1104170-0000-4000-8000-000000000001';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: `${cwd}/README.md` } },
        ],
      },
    }) + '\n',
  );
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      cwd,
      startedAt: Date.now() - 600_000,
      procStart,
      version: '2.1.306',
      kind: 'interactive',
      name,
      status: 'busy',
    }),
  );
  return proc;
}

const count = (page: Page, name: string | RegExp) =>
  page
    .getByRole('button', { name })
    .count()
    .then(async (b) => b + (await page.getByRole('menuitem', { name }).count()));

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const lead = session(home, 'lead', '/work/alpha');
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal'], {});
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  try {
    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();

    for (const phone of [false, true]) {
      const tag = phone ? 'phone' : 'desktop';
      const ctx = await browser.newContext(
        phone
          ? {
              viewport: { width: 393, height: 852 },
              isMobile: true,
              hasTouch: true,
              deviceScaleFactor: 2,
            }
          : { viewport: { width: 1282, height: 832 } },
      );
      await ctx.addInitScript(
        `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;${ON ? '' : " window.__AGENT_TYCOON_LATER_FEATURES = 'off';"}`,
      );
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      await page.goto(`http://127.0.0.1:${port}/`);
      await topBarReady(page, 60_000);
      const card = page.locator('[data-testid="agent-card"]').first();
      await card.waitFor();
      const info = page.getByRole('button', { name: '정보 창 닫기' });
      if (await info.count()) await info.first().click();
      await page.locator('[data-testid="agent-overlay"]').first().waitFor();
      await page.waitForTimeout(800);
      const press = (l: ReturnType<Page['locator']>) => (phone ? l.tap() : l.click());
      const shot = (name: string) =>
        page.screenshot({ path: path.join(OUT, `${tag}${ON ? '-ON' : ''}-${name}.png`) });

      // The elevator (desktop): its list is open so 편집 / 인테리어 would show.
      if (!phone) {
        await page.evaluate(() => localStorage.setItem('agty.elevator-list-open', '1'));
        await page.reload();
        await topBarReady(page, 60_000);
        await page.locator('[data-testid="agent-card"]').first().waitFor();
        const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
        if (await closeInfo.count()) await closeInfo.first().click();
        await page.waitForTimeout(1500);
        await shot('office');
        check(
          (await count(page, '편집')) === 1,
          'desktop: the 층 편집 button stays (one floor too)',
        );
        check((await count(page, '인테리어')) === 0, 'desktop: no 인테리어 button');
        check((await count(page, 'Layout')) === 0, 'desktop: no Layout button');
        await page.getByRole('button', { name: '편집', exact: true }).click();
        await page.getByTestId('floor-editor').waitFor({ timeout: 5_000 });
        await shot('floor-editor');
        check(true, 'desktop: 편집 opens the floor editor');
        await page.getByRole('button', { name: '편집', exact: true }).click();
        await page.waitForTimeout(300);
      }

      // The character's menu (a card press selects it).
      await press(page.locator('[data-testid="agent-card"]').first());
      await page.locator('[data-testid="stat-open"]').first().waitFor({ timeout: 8_000 });
      await shot('character-menu');
      // The card's detail (상태).
      await press(page.locator('[data-testid="stat-open"]').first());
      await page.waitForTimeout(800);
      await shot('stat-card');
      await press(page.getByRole('dialog').getByRole('button', { name: 'x', exact: true }));
      await page.waitForTimeout(400);
      // 설정: 내 캐릭터 and the layout file items.
      await topBarButton(page, '설정');
      await page.waitForTimeout(800);
      await shot('settings');
      check(
        (await page.getByTestId('owner-character-option').count()) === 1,
        `${tag}: 설정 shows the 내 캐릭터 row`,
      );
      check((await count(page, '배치 내보내기')) === 0, `${tag}: no layout export`);
    }
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    console.log(failed ? `${failed} checks FAILED` : 'all checks passed');
  } finally {
    await browser.close();
    await daemon.stop();
    lead.kill();
    killFakeSessions(home);
  }
}

main().then(
  () => process.exit(failed ? 1 : 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

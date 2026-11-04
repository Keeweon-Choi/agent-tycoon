/**
 * UI-BUGS-1104 (owner's photos, 11-04 15:15) on the REAL API: dist/cli.js in a temp HOME (fake claude R-8, the
 * usage endpoint faked by testHome.fakeUsage), headless Chromium at the owner's 1282x832.
 *  1. A Claude plan with no 5-hour window (Ultra: the week only) still shows a gauge: under 1300 wide the
 *     strip keeps one window per provider, the week then, with its cells and its label (주).
 *  2. The elevator panel draws under the open windows (메신저, 현황판 > 개발 > 이슈): nowhere it shares
 *     with a window is the elevator the topmost element.
 * Every check runs (a failure is reported, the rest still run); exit 1 on any failure.
 * Screenshots in cld/artifacts/ui-bugs-1104/<tag>/.
 *
 *   npx tsx cld/test/run-ui-bugs-1104.ts <port 18330-18339> [tag]
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  fakeUsage,
  launchBrowser,
  makeFakeHome,
  openWorkbenchTab,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const PORTS = Array.from({ length: 10 }, (_, i) => 18330 + i);
const port = Number(process.argv[2]);
if (!PORTS.includes(port)) throw new Error('port must be 18330-18339');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/ui-bugs-1104', process.argv[3] ?? 'after');
const DEADLINE_MS = 180_000;

const failed: string[] = [];
const check = (ok: unknown, text: string) => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${text}`);
  if (!ok) failed.push(text);
};

/** Points in the parts of the elevator panel a window covers, and what is on top there. */
async function elevatorOnTop(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-hud-id="floors"]');
    if (!panel) return ['no elevator panel'];
    const hits: string[] = [];
    for (const win of document.querySelectorAll<HTMLElement>('[data-hud-window]')) {
      const w = win.getBoundingClientRect();
      for (const el of [panel, ...panel.querySelectorAll('*')]) {
        const b = el.getBoundingClientRect();
        const [l, t, r, btm] = [Math.max(b.left, w.left), Math.max(b.top, w.top), Math.min(b.right, w.right), Math.min(b.bottom, w.bottom)];
        if (r - l < 2 || btm - t < 2) continue;
        const top = document.elementFromPoint((l + r) / 2, (t + btm) / 2);
        if (top && panel.contains(top)) hits.push(`${win.dataset.hudWindow}: ${top.className || top.tagName} at ${Math.round((l + r) / 2)},${Math.round((t + btm) / 2)}`);
      }
    }
    return hits;
  });
}

/** Drag window `id` by its title bar to the room's left edge, over the elevator (the owner's windows sat there). */
async function toLeftEdge(page: Page, id: string): Promise<void> {
  const bar = (await page.getByTestId(`hud-title-${id}`).boundingBox())!;
  const from = { x: bar.x + 40, y: bar.y + bar.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 200, from.y + 20, { steps: 5 });
  await page.mouse.move(40 - (bar.x - from.x), from.y + 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  // Ultra: no five_hour window, the week at 52% used; Codex 2% · 30%.
  const usage = await fakeUsage(fake.home, { sevenDay: 52, fable: 10 }, { fiveHour: 2, sevenDay: 30 });
  const daemon = startDaemon(fake, port, ['--no-terminal'], usage.env);
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${fake.home}`);
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
    process.exit(2);
  }, DEADLINE_MS);
  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1282, height: 832 } });
    const page = await ctx.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const toast = await page.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 4_000 }).catch(() => null);
    const v = toast?.match(/v([\d.]+)/)?.[1];
    if (v) {
      await page.evaluate((x) => localStorage.setItem('cld.changelogSeen', x), v);
      await page.reload();
    }
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

    // ── 1. the Claude gauge with the week only ──
    const gauge = page.locator('[data-testid="usage-gauge"][data-provider="claude"]');
    await gauge.waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => /\d%/.test(document.querySelector('[data-testid="usage-gauge"][data-provider="codex"]')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.waitForTimeout(500);
    const claudeText = (await gauge.innerText()).replace(/\s+/g, ' ');
    check(/48%/.test(claudeText), `1282 wide: the Claude gauge shows the week's 48% left (${claudeText})`);
    check(await gauge.locator('.game-segbar').first().isVisible().catch(() => false), 'the Claude gauge has its cells');
    check(/주/.test(claudeText), 'its label says it is the week (주)');
    const codexText = (await page.locator('[data-testid="usage-gauge"][data-provider="codex"]').innerText()).replace(/\s+/g, ' ');
    check(/5h/.test(codexText) && /98%/.test(codexText), `Codex keeps its 5-hour gauge (${codexText})`);
    await page.locator('[data-testid="usage-folded"]').locator('xpath=ancestor::div[contains(@class,"pixel-panel")][1]').screenshot({ path: path.join(OUT, 'hud-1282.png') });

    // ── 2. the elevator under the windows ──
    await page.getByTestId('elevator-display').waitFor({ timeout: 30_000 });
    await shot('office');
    // 알림 (the messenger needs the chat on; any window draws in the same band).
    const notices = page.locator('[data-hud-id="icon:notices"] button');
    await notices.click();
    await page.locator('[data-hud-window="notices"]').waitFor();
    await toLeftEdge(page, 'notices');
    const underNotices = await elevatorOnTop(page);
    check(underNotices.length === 0, `알림 open: the elevator is under it (${underNotices.join('; ') || 'nowhere on top'})`);
    await shot('notices');
    await notices.click();
    await openWorkbenchTab(page, '이슈');
    await toLeftEdge(page, 'office');
    const underOffice = await elevatorOnTop(page);
    check(underOffice.length === 0, `현황판 > 개발 > 이슈 open: the elevator is under it (${underOffice.join('; ') || 'nowhere on top'})`);
    await shot('office-issues');
    // The window closed again: the panel is whole and usable.
    await page.locator('[data-hud-id="icon:office"] button').click();
    await page.waitForTimeout(300);
    check(await page.getByRole('button', { name: '편집' }).isVisible(), 'no window: the elevator panel shows whole (편집)');
    await shot('office-closed');
  } finally {
    clearTimeout(deadline);
    await browser.close().catch(() => undefined);
    await daemon.stop();
    removeTestHome(fake.home);
  }
  console.log(failed.length ? `\n${failed.length} failed` : '\nall checks ok');
  console.log(`screenshots in ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

/**
 * WINDOW-TOP-1104 (owner 11-04 16:51: the windows' title bars under the top bar, an odd band below them).
 * Cause: the office region was overflow:hidden, still a scroll container, and its overlays (the lobby board,
 * the card bar's head) run past its edges; a scrollIntoView or focus() inside a window scrolled the whole
 * region up. The checks, at 1282x800, 1282x832 and 1400x900 (the top bar is two lines there), after the
 * default windows, a drag up, a resize from the top edge, the app's own scrollIntoView({ block: 'center' })
 * and a focus() past the office edge, maximize, a reload and restore:
 *  - the HUD layer starts at the top bar's measured bottom and ends at the viewport's bottom (no band);
 *  - no window's box reaches above the top bar's bottom, and nothing outside the HUD layer covers its title;
 *  - a maximized window is exactly the HUD layer.
 * The phone: the same scrollIntoView in the office page leaves every box above it unscrolled.
 * The top bar's height is always measured, never assumed (HUD-1B/2B change it).
 * Every check runs (a failure is reported, the rest still run); exit 1 on any failure.
 *
 *   npx tsx cld/test/run-window-top-1104.ts <port 18470-18479> [tag: after|before]
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  fakeUsage,
  launchBrowser,
  makeFakeHome,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18470 && port <= 18479)) throw new Error('port must be 18470-18479');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/window-top-1104', process.argv[3] ?? 'after');
const DEADLINE_MS = 300_000;
const SIZES = [
  { width: 1282, height: 800 },
  { width: 1282, height: 832 },
  { width: 1400, height: 900 },
];
const IPHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 } };
})();

const failed: string[] = [];
const check = (ok: unknown, text: string) => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${text}`);
  if (!ok) failed.push(text);
};

/** Problems with the HUD geometry now, or [] when the bar, the layer and every open window line up. */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    // hud-v3: the PC has no top bar, so the layer starts at the top of the viewport; an older build's bar still counts.
    const bar = document.querySelector('[data-hud-id="usage"]')?.getBoundingClientRect() ?? { bottom: 0 };
    const layerEl = document.querySelector<HTMLElement>('[data-hud-layer]')!;
    const layer = layerEl.getBoundingClientRect();
    const near = (a: number, b: number) => Math.abs(a - b) <= 1;
    if (!near(layer.top, bar.bottom)) out.push(`the HUD layer starts at ${Math.round(layer.top)}, the top bar ends at ${Math.round(bar.bottom)}`);
    if (!near(layer.bottom, innerHeight)) out.push(`the HUD layer ends at ${Math.round(layer.bottom)}, the viewport at ${innerHeight}`);
    for (let el = layerEl.parentElement; el; el = el.parentElement)
      if (el.scrollTop || el.scrollLeft) out.push(`${el.tagName}.${String(el.className).slice(0, 30)} is scrolled ${el.scrollLeft},${el.scrollTop}`);
    for (const win of document.querySelectorAll<HTMLElement>('[data-hud-window]')) {
      if (!win.offsetParent) continue;
      const id = win.dataset.hudWindow;
      const r = win.getBoundingClientRect();
      if (r.top < bar.bottom - 0.5) out.push(`${id}: top ${Math.round(r.top)} above the top bar's bottom ${Math.round(bar.bottom)}`);
      if (r.bottom > innerHeight + 0.5) out.push(`${id}: bottom ${Math.round(r.bottom)} past the viewport ${innerHeight}`);
      const title = win.querySelector('strong')!.getBoundingClientRect();
      const hit = document.elementFromPoint(title.left + 4, title.top + title.height / 2);
      // Another window may lie over it (the front one wins); the top bar or anything outside the HUD layer may not.
      if (!hit?.closest('[data-hud-layer]')) out.push(`${id}: its title is covered by ${hit?.tagName}.${String(hit?.className).slice(0, 30)}`);
      if (win.querySelector('[aria-pressed="true"][aria-label="원래 크기"]') && !(near(r.left, layer.left) && near(r.top, layer.top) && near(r.width, layer.width) && near(r.height, layer.height)))
        out.push(`${id} maximized: ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}, layer ${Math.round(layer.left)},${Math.round(layer.top)} ${Math.round(layer.width)}x${Math.round(layer.height)}`);
    }
    return out;
  });

async function same(page: Page, tag: string, what: string) {
  const bad = await geometry(page);
  check(bad.length === 0, `${tag} ${what}${bad.length ? `: ${bad.join('; ')}` : ''}`);
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

async function desktop(page: Page, size: { width: number; height: number }, loginUrl: string) {
  const tag = `${size.width}x${size.height}`;
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`) });
  await page.setViewportSize(size);
  await page.goto(loginUrl);
  await page.waitForURL(`http://127.0.0.1:${port}/`);
  await page.evaluate(() => localStorage.removeItem('cld.hud.layout.v1'));
  await page.reload();
  await page.locator('[data-hud-id="icon:office"] button').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  for (const id of ['office', 'devroom']) {
    await page.locator(`[data-hud-id="icon:${id}"] button`).click();
    await page.waitForTimeout(400);
  }
  await same(page, tag, 'two windows at their default places');

  // A pointerdown on a window brings it to the front (WINMODEL), so the next drag reaches it.
  const front = (id: string) => page.locator(`[data-hud-window="${id}"]`).dispatchEvent('pointerdown');
  await front('devroom');
  const bar = (await page.getByTestId('hud-title-devroom').boundingBox())!;
  await drag(page, { x: bar.x + 60, y: bar.y + bar.height / 2 }, { x: bar.x + 60, y: -40 });
  await same(page, tag, 'a window dragged up past the top');

  await front('office');
  const n = (await page.locator('[data-hud-window="office"] [data-handle="n"]').boundingBox())!;
  await drag(page, { x: n.x + n.width / 2, y: n.y + 2 }, { x: n.x + n.width / 2, y: n.y - 300 });
  await same(page, tag, 'a window resized from its top edge past the top bar');

  // What the app does when it jumps to a row, a line or a notice (useHistoryJump, Preview, openTarget).
  await page.evaluate(() => {
    const all = document.querySelectorAll<HTMLElement>('[data-hud-window="office"] *');
    all[all.length - 1].scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(300);
  await same(page, tag, "scrollIntoView({ block: 'center' }) inside a window");
  await shot('scrolled');
  // The lobby board runs past the office's bottom at some sizes (the party's old 파티 button is gone, FEAT-PARTY-V2).
  const outside = page.locator('[data-testid="lobby-board"] button').last();
  if (await outside.count()) {
    await outside.evaluate((b: HTMLElement) => b.focus());
    await page.waitForTimeout(300);
    await same(page, tag, 'focus() on a button past the office edge');
  }

  await front('office');
  await page.getByTestId('hud-title-office').getByRole('button', { name: '최대화' }).click();
  await page.waitForTimeout(500);
  await same(page, tag, 'maximized');
  await shot('max');
  await page.reload();
  await page.locator('[data-hud-window="office"]').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await same(page, tag, 'after a reload (maximized restored)');
  await page.getByTestId('hud-title-office').getByRole('button', { name: '원래 크기' }).click();
  await page.waitForTimeout(500);
  await same(page, tag, 'restored');
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
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
    const ctx = await browser.newContext({ viewport: SIZES[0] });
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    const page = await ctx.newPage();
    for (const size of SIZES) await desktop(page, size, await daemon.loginUrl());
    await ctx.close();

    const phoneCtx = await browser.newContext(IPHONE);
    await phoneCtx.addInitScript('globalThis.__name = (fn) => fn;');
    const phone = await phoneCtx.newPage();
    await phone.goto(await daemon.loginUrl());
    await phone.getByTestId('mobile-dock').waitFor({ timeout: 60_000 });
    await phone.waitForTimeout(1500);
    const scrolled = await phone.evaluate(() => {
      const canvas = document.querySelector('canvas')!;
      const page = canvas.closest<HTMLElement>('.w-1\\/2')!;
      const all = page.querySelectorAll<HTMLElement>('*');
      all[all.length - 1].scrollIntoView({ block: 'center', inline: 'center' });
      const out: string[] = [];
      for (let el: HTMLElement | null = canvas.parentElement; el; el = el.parentElement)
        if (el.scrollTop || el.scrollLeft) out.push(`${el.tagName}.${String(el.className).slice(0, 30)} ${el.scrollLeft},${el.scrollTop}`);
      return out;
    });
    check(scrolled.length === 0, `phone 393: a scrollIntoView in the office page scrolls nothing around it${scrolled.length ? ` (${scrolled.join('; ')})` : ''}`);
    await phone.screenshot({ path: path.join(OUT, 'phone-393.png') });
    await phoneCtx.close();
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

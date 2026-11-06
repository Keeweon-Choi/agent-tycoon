/**
 * Pixel icons + WINDOW-LAYERS (owner 11-06 20:07, 20:57: what was pressed last is in front): dist/cli.js in a
 * temp HOME (the engine's fake `claude`), headless Chromium (--disable-gpu) at 1600x1000, in 픽셀 감성 and 모던.
 * Checks:
 *  - the control center's notification list draws its Material Symbols as glyphs (the face loaded, a span
 *    as wide as its font size, not the ligature word);
 *  - the 현황판 window, placed over the elevator column, the folded control center and the dock: after a press
 *    in the window it is over all three; after a press on each panel that panel is over the window; a press
 *    in the window puts it back on top;
 *  - the notification list opens on top (over the window), and a press in the window folds it.
 * A panel is pressed with a pointerdown on its own frame (where the window covers it the mouse would land
 * on the window). Photos in cld/artifacts/fix-pixel-icons-window-layers/.
 *
 *   npx tsx cld/test/run-pixel-icons-window-layers.ts [port 19240-19249]
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  type Daemon,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
  topBarReady,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]) || 19240;
const WIN = '[data-hud-window="office"]';
const PANELS = {
  elevator: '[data-hud-panel="elevator"] .cld-elevator',
  controlCenter: '[data-testid="cc-tile"]',
  dock: '[data-testid="hud-dock"]',
} as const;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/fix-pixel-icons-window-layers');
const DEADLINE_MS = 240_000;
let oks = 0;
const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};

/** The element drawn at the centre of `sel`'s box is inside `over`. */
const topAt = (page: Page, sel: string, over: string) =>
  page.evaluate(
    ([s, o]) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!hit?.closest(o);
    },
    [sel, over] as const,
  );

/** Which of `a` and `b` is drawn where their boxes overlap ('none' when they do not). */
const frontOf = (page: Page, a: string, b: string) =>
  page.evaluate(
    ([sa, sb]) => {
      const ra = document.querySelector(sa)!.getBoundingClientRect();
      const rb = document.querySelector(sb)!.getBoundingClientRect();
      const x0 = Math.max(ra.left, rb.left);
      const x1 = Math.min(ra.right, rb.right);
      const y0 = Math.max(ra.top, rb.top);
      const y1 = Math.min(ra.bottom, rb.bottom, innerHeight);
      if (x1 <= x0 || y1 <= y0) return 'none';
      const hit = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
      return hit?.closest(sa) ? 'a' : hit?.closest(sb) ? 'b' : `other ${hit?.className}`;
    },
    [a, b] as const,
  );

/** A press on a panel's own frame: the HUD layer's listener sees a pointerdown in it. */
const pressPanel = (page: Page, sel: string) =>
  page
    .locator(sel)
    .first()
    .dispatchEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 });

async function pass(page: Page, theme: 'pixel' | 'modern') {
  await topBarReady(page, 30_000);
  check(
    (await page.evaluate(() => document.documentElement.dataset.uiTheme)) === theme,
    `${theme}: the style is on`,
  );

  // 1. Icons in the notification list.
  await page.locator('[data-testid="cc-seg-notices"]').first().click();
  await page.locator('[data-testid="cc-notice-pop"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const icons = await page.evaluate(() => {
    const spans = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="cc-notice-pop"] .material-symbols-sharp',
      ),
    ];
    return {
      loaded: document.fonts.check('16px "Material Symbols Sharp"', 'home'),
      spans: spans.length,
      wordy: spans
        .filter(
          (s) => s.getBoundingClientRect().width > parseFloat(getComputedStyle(s).fontSize) * 1.5,
        )
        .map((s) => s.textContent),
      family: spans[0] ? getComputedStyle(spans[0]).fontFamily : '',
    };
  });
  console.log(`${theme} icons`, JSON.stringify(icons));
  if (theme === 'pixel') {
    check(icons.spans > 0, 'pixel: the notification list has Material Symbols icons');
    check(icons.loaded, 'pixel: the icon face is loaded (document.fonts)');
    check(
      icons.family.includes('Material Symbols Sharp'),
      'pixel: the icon spans use the icon face',
    );
  }
  check(icons.wordy.length === 0, `${theme}: no icon drawn as a word`);
  await page.screenshot({ path: path.join(OUT, `${theme}-1-notices-icons.png`) });
  await page.locator('[data-testid="cc-seg-notices"]').first().click(); // fold it

  // 2. The 현황판 over the elevator column, the control center and the dock: its left edge at x 30, its top at
  //    y 500, widened to reach the dock.
  await openOfficeWindow(page);
  const win = page.locator(WIN);
  const title = await page.locator('[data-testid="hud-title-office"]').boundingBox();
  const box = await win.boundingBox();
  if (!title || !box) throw new Error('no window box');
  const grab = { x: title.x + 60, y: title.y + title.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + (30 - box.x), grab.y + (500 - box.y), { steps: 8 });
  await page.mouse.up();
  const east = await win.locator('[data-handle="e"]').boundingBox();
  if (!east) throw new Error('no east handle');
  await page.mouse.move(east.x + east.width / 2, 700); // its middle may be below the screen
  await page.mouse.down();
  await page.mouse.move(east.x + 420, 700, { steps: 8 });
  await page.mouse.up();
  const b = (await win.boundingBox())!;
  const wb = { ...b, right: b.x + b.width };
  const pressWindow = () => page.mouse.click(wb.right - 60, wb.y + 120); // in its body, right of the notification list
  await pressWindow();
  await page.waitForTimeout(200);
  for (const [name, sel] of Object.entries(PANELS))
    check(
      (await frontOf(page, WIN, sel)) === 'a',
      `${theme}: after a press in the window it is over the ${name}`,
    );
  await page.screenshot({ path: path.join(OUT, `${theme}-2-window-pressed.png`) });

  // 3. A press on each panel brings it over the window.
  for (const [name, sel] of Object.entries(PANELS)) {
    await pressPanel(page, sel);
    await page.waitForTimeout(100);
    check(
      (await frontOf(page, WIN, sel)) === 'b',
      `${theme}: after a press on the ${name} it is over the window`,
    );
  }
  await page.screenshot({ path: path.join(OUT, `${theme}-3-panels-pressed.png`) });
  await pressWindow();
  await page.waitForTimeout(200);
  for (const [name, sel] of Object.entries(PANELS))
    check(
      (await frontOf(page, WIN, sel)) === 'a',
      `${theme}: a press in the window puts it back over the ${name}`,
    );

  // 4. The notification list opens on top, and a press in the window folds it.
  await page
    .locator('[data-testid="cc-seg-notices"]')
    .first()
    .evaluate((b: HTMLElement) => b.click()); // under the window now
  await page.locator('[data-testid="cc-notice-pop"]').waitFor();
  check(
    await topAt(page, '[data-testid="cc-notice-pop"]', '[data-testid="cc-notice-pop"]'),
    `${theme}: the notification list opens over the window`,
  );
  check(
    (await frontOf(page, WIN, PANELS.controlCenter)) === 'b',
    `${theme}: its control center comes up with it`,
  );
  await page.screenshot({ path: path.join(OUT, `${theme}-4-notices-on-top.png`) });
  await pressWindow();
  await page.locator('[data-testid="cc-notice-pop"]').waitFor({ state: 'detached', timeout: 5000 });
  check(true, `${theme}: a press in the window folds the notification list`);
  check(
    (await frontOf(page, WIN, PANELS.controlCenter)) === 'a',
    `${theme}: and the window is over the control center`,
  );
}

async function main() {
  if (port < 19240 || port > 19249) throw new Error('port 19240-19249');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, []);
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
    process.exit(1);
  }, DEADLINE_MS);
  const browser = await launchBrowser();
  try {
    for (const theme of ['pixel', 'modern'] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      await ctx.addInitScript((v) => {
        try {
          localStorage.setItem('cld.ui-theme', v);
        } catch {
          /* about:blank */
        }
      }, theme);
      const page = await ctx.newPage();
      await page.goto(await daemon.loginUrl());
      await pass(page, theme);
      await ctx.close();
    }
    console.log(`\n${oks} checks passed; photos in ${OUT}`);
  } finally {
    clearTimeout(deadline);
    await browser.close();
    await daemon.stop();
    killFakeSessions(home);
    removeTestHome(home);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * fix-window-drag-bottom (owner 11-06): a window the user drags may sink to the screen's bottom edge; only its
 * title bar (its measured height) must stay on screen. Every HudWindow shares the rule, so three different windows
 * (messenger, 현황판, 개발실) are dragged by their title bar to the bottom of a 1600x1000 and a 1920x1080 screen;
 * the window's top must land at screen height - the title bar's height (well below the old dock line at height - 120 - 40).
 * After that the 1920 page shrinks to 1600x1000: the window is pulled back onto the visible screen.
 * dist/cli.js in an isolated HOME on a spare port, headless Chromium without a GPU, no model.
 * UI_THEME=modern|pixel picks the style; OUT_DIR moves the pictures (default cld/artifacts/fix-window-drag-bottom).
 *
 *   UI_THEME=pixel PREFIX=pixel taskset -c 0,1 nice -n 10 npx tsx cld/test/run-window-drag-bottom.ts <port 19000-19009>
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeEngineHome,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { outDir, UI_THEME_INIT } from './uiTheme.js';

const port = Number(process.argv[2]);
if (!(port >= 19000 && port <= 19009)) throw new Error('port must be 19000-19009');
const PREFIX = process.env.PREFIX ?? 'after';
const OUT = outDir(path.resolve('cld/artifacts/fix-window-drag-bottom'));
const DOCK_RESERVE_PX = 120; // constants.ts HUD_DOCK_RESERVE_PX: the old line was height - this - the title bar
const STORE: Record<string, string> = { 'cld.title-scene': 'off', 'cld.office-iso': 'on', 'cld.floor': '1', 'cld.floor-view': 'one' };
const WINDOWS = ['messenger', 'office', 'devroom'] as const;

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal', '--allow-chat', '--engine', 'on', '--allow-actions']);
  const browser = await launchBrowser({ partyFrame: true });
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();

    for (const viewport of [{ width: 1600, height: 1000 }, { width: 1920, height: 1080 }]) {
      const ctx = await browser.newContext({ viewport });
      await ctx.addInitScript(`globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;` + UI_THEME_INIT);
      await ctx.addInitScript((pairs) => {
        for (const [k, v] of pairs)
          try { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch { /* about:blank */ }
      }, Object.entries(STORE));
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.getByTestId('office-canvas').waitFor({ timeout: 60_000 });
      await page.locator('[data-testid="hud-dock"]').waitFor({ timeout: 60_000 });
      await page.waitForTimeout(3_000);
      const tag = `${viewport.width}x${viewport.height}`;
      const H = viewport.height;

      for (const id of WINDOWS) {
        const label = `${tag} ${id}`;
        await page.locator(`[data-testid="hud-dock"] [data-hud-id="icon:${id}"] button`).click();
        const win = page.locator(`[data-hud-window="${id}"]`);
        await win.waitFor({ timeout: 15_000 });
        await page.waitForTimeout(600);
        const title = page.locator(`[data-testid="hud-title-${id}"]`);
        const t0 = (await title.boundingBox())!;
        const w0 = (await win.boundingBox())!;
        check(w0.y + w0.height <= H - DOCK_RESERVE_PX, `${label}: opens above the dock band (bottom ${Math.round(w0.y + w0.height)} <= ${H - DOCK_RESERVE_PX})`);
        const TB = Math.round(t0.y - w0.y + t0.height); // the bar's foot below the window's top in this style
        const sx = t0.x + 60;
        const sy = t0.y + t0.height / 2;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        await page.mouse.move(sx, sy + 200, { steps: 8 });
        await page.mouse.move(sx, H + 300, { steps: 20 }); // far past the bottom
        await page.mouse.up();
        await page.waitForTimeout(500);
        const w1 = (await win.boundingBox())!;
        const t1 = (await title.boundingBox())!;
        console.log(`     ${label}: top y ${Math.round(w1.y)}, bottom ${Math.round(w1.y + w1.height)}, title ${Math.round(t1.y)}..${Math.round(t1.y + t1.height)}, screen ${H}`);
        check(Math.abs(w1.y - (H - TB)) <= 2, `${label}: sinks until only the title-bar rule stops it (top ${Math.round(w1.y)} = ${H - TB})`);
        check(w1.y > H - DOCK_RESERVE_PX - TB, `${label}: below the old line (${H - DOCK_RESERVE_PX - TB})`);
        check(t1.y + t1.height <= H + 0.5 && t1.y >= 0, `${label}: the whole title bar is on screen`);
        await page.screenshot({ path: path.join(OUT, `${PREFIX}-${tag}-${id}.png`) });
        if (id === 'messenger' && viewport.height === 1080) {
          // The screen shrinks: the window is pulled back onto the visible screen.
          await page.setViewportSize({ width: 1600, height: 1000 });
          await page.waitForTimeout(800);
          const w2 = (await win.boundingBox())!;
          check(Math.abs(w2.y - (1000 - TB)) <= 1, `${label}: after shrinking to 1600x1000 it is re-clamped (top ${Math.round(w2.y)})`);
          await page.screenshot({ path: path.join(OUT, `${PREFIX}-1920-shrunk-to-1600x1000-${id}.png`) });
          await page.setViewportSize(viewport);
          await page.waitForTimeout(500);
        }
        // Back up for the next window: drag the title bar to the top, then close it.
        const t2 = (await title.boundingBox())!;
        await page.mouse.move(t2.x + 60, t2.y + t2.height / 2);
        await page.mouse.down();
        await page.mouse.move(t2.x + 60, 300, { steps: 12 });
        await page.mouse.up();
        await page.locator(`[data-testid="hud-title-${id}"] button`).last().click();
        await page.waitForTimeout(300);
      }
      await ctx.close();
    }
    if (failures.length) throw new Error(`${failures.length} check(s) failed:\n${failures.join('\n')}`);
  } finally {
    await browser.close();
    await daemon.stop();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

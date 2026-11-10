/**
 * DEVROOM-OPEN (owner 11-04 18:09): "the 개발실 comes back purple but does not open". After a reload
 * (a deploy) the 개발실 icon must never be lit while its window is out of sight: one press shows the
 * window inside the office area, whatever it was (minimized, dragged near an edge, stored far off),
 * and 설정's 화면 배치 초기화 (owner 18:12: "초기화해도 안 보여") shows a window stuck out of sight.
 * dist/cli.js in an isolated HOME, headless Chromium (--disable-gpu), desktop 1282x832.
 *
 *   npx tsx agent-tycoon/test/run-devroom-open-1104.ts <port 18560-18569>
 *
 * Screenshots: agent-tycoon/artifacts/devroom-open-1104/*.png
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
  topBarButton,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18560 && port <= 18569)) throw new Error('port must be 18560-18569');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/devroom-open-1104');
const DEADLINE_MS = 180_000;
const LAYOUT_KEY = 'agty.hud.layout.v1';
const SETTLE_MS = 2_500;

const failures: string[] = [];
function check(ok: unknown, what: string): void {
  if (ok) console.log(`ok - ${what}`);
  else {
    console.log(`FAIL - ${what}`);
    failures.push(what);
  }
}

/** The icon's state and the window as the screen has it: shown means a box inside the HUD layer. */
async function devroomState(page: Page) {
  return page.evaluate(() => {
    const icon = document.querySelector('button[data-window][title="개발실"]');
    const win = document.querySelector<HTMLElement>('[data-hud-window="devroom"]');
    const layer = document.querySelector('[data-hud-layer]')?.getBoundingClientRect();
    const box = win?.getBoundingClientRect();
    const css = win ? getComputedStyle(win) : null;
    const inside =
      !!box && !!layer && box.width > 0 && box.height > 0 &&
      box.left >= layer.left - 1 && box.top >= layer.top - 1 &&
      box.right <= layer.right + 1 && box.bottom <= layer.bottom + 1;
    return {
      icon: icon?.getAttribute('data-window') ?? null,
      pressed: icon?.getAttribute('aria-pressed') ?? null,
      mounted: !!win,
      display: css?.display ?? null,
      visibility: css?.visibility ?? null,
      box: box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null,
      shown: !!win && css?.display !== 'none' && css?.visibility !== 'hidden' && inside,
      saved: localStorage.getItem('agty.hud.layout.v1'),
    };
  });
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal']);
  const deadline = setTimeout(() => {
    console.error(`aborted: deadline ${DEADLINE_MS / 1000} s`);
    const c = daemon.child;
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  }, DEADLINE_MS);
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    const url = await daemon.loginUrl();
    browser = await launchBrowser();
    const page = await (await browser.newContext({ viewport: { width: 1282, height: 832 } })).newPage();
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    const icon = page.locator('button[data-window][title="개발실"]');
    await icon.waitFor({ timeout: 30_000 });
    // A big window may lie over the icon column: press the icon as its click does.
    const press = () => icon.dispatchEvent('click');
    const reload = async () => {
      await page.reload();
      await icon.waitFor({ timeout: 30_000 });
      await page.waitForTimeout(SETTLE_MS);
    };
    const scene = async (name: string, shot: string) => {
      const s = await devroomState(page);
      console.log(name, JSON.stringify({ ...s, saved: undefined }));
      await page.screenshot({ path: path.join(OUT, shot) });
      return s;
    };

    // A: open, minimize, reload, press the icon once.
    await press();
    await page.waitForTimeout(SETTLE_MS);
    const fresh = await scene('A open', 'a1-open.png');
    check(fresh.icon === 'front' && fresh.shown, `clean HOME: one press opens the 개발실 (shown ${fresh.shown})`);
    await press(); // front -> minimized
    await reload();
    const aReload = await scene('A after reload', 'a2-reload-minimized.png');
    check(aReload.icon === 'minimized' && !aReload.shown, `A: the minimized 개발실 stays minimized after a reload (${aReload.icon})`);
    await press();
    await page.waitForTimeout(SETTLE_MS);
    const aPress = await scene('A after one press', 'a3-pressed.png');
    check(aPress.icon === 'front' && aPress.shown, `A: one press shows the window (icon ${aPress.icon}, shown ${aPress.shown}, visibility ${aPress.visibility})`);

    // R: the owner's 18:12 try: minimized, reload, one press (lit, out of sight), 화면 배치 초기화.
    await press(); // front -> minimized
    await reload();
    await press();
    await page.waitForTimeout(SETTLE_MS);
    await topBarButton(page, '설정');
    await page.getByRole('tab', { name: '화면', exact: true }).click();
    await page.getByRole('button', { name: '화면 배치 초기화' }).click();
    await page.getByRole('button', { name: 'x', exact: true }).click(); // the dialog's close
    await page.waitForTimeout(SETTLE_MS);
    const rReset = await scene('R after 화면 배치 초기화', 'r1-after-reset.png');
    check(rReset.icon === 'front' && rReset.shown, `R: after 화면 배치 초기화 the 개발실 shows (icon ${rReset.icon}, shown ${rReset.shown}, visibility ${rReset.visibility})`);

    // B: drag the window by its title bar to near the bottom-right edge, reload.
    const title = page.getByTestId('hud-title-devroom');
    const tb = await title.boundingBox();
    if (!tb) throw new Error('no 개발실 title bar');
    await page.mouse.move(tb.x + 40, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + 2_000, tb.y + 2_000, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(SETTLE_MS);
    await scene('B dragged', 'b1-dragged.png');
    await reload();
    const bReload = await scene('B after reload', 'b2-reload.png');
    check(bReload.icon === 'front' && bReload.shown, `B: the dragged window shows after a reload (icon ${bReload.icon}, shown ${bReload.shown})`);

    // C: an older saved layout with a place far outside this screen, the window open.
    await page.evaluate((key) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          v: 1,
          items: { devroom: { place: { corner: 'tl', dx: 4000, dy: 3000, w: 1600, h: 1200 } } },
          open: { devroom: true },
        }),
      );
    }, LAYOUT_KEY);
    await reload();
    const cReload = await scene('C after reload', 'c1-far-place.png');
    check(cReload.icon === 'front' && cReload.shown, `C: a far stored place is pulled on screen (icon ${cReload.icon}, shown ${cReload.shown}, box ${JSON.stringify(cReload.box)})`);
    // C2: the same, saved minimized: one press brings it inside.
    await page.evaluate((key) => {
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...saved, minimized: { devroom: true } }));
    }, LAYOUT_KEY);
    await reload();
    await press();
    await page.waitForTimeout(SETTLE_MS);
    const c2 = await scene('C2 minimized far, one press', 'c2-far-minimized-pressed.png');
    check(c2.icon === 'front' && c2.shown, `C2: a far, minimized window shows after one press (icon ${c2.icon}, shown ${c2.shown})`);
    console.log('console errors', JSON.stringify(errors));
    fs.writeFileSync(path.join(OUT, 'console-errors.json'), JSON.stringify(errors, null, 2));
  } finally {
    await browser?.close();
    await daemon.stop();
    clearTimeout(deadline);
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (failures.length) throw new Error(`${failures.length} check(s) failed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

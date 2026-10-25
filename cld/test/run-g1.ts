/**
 * G1 input policy check (GUX-1..4): dist/cli.js with an isolated HOME on a spare port, headless
 * Chromium (no GPU), desktop 1280x800 and phone 393x852. One fake Claude session (a `sleep` with a
 * transcript), no model is ever called.
 *
 * Desktop: right-click on the canvas, a HUD icon and a card is defaultPrevented; right-click on a
 * character opens its menu (Esc and a click on the floor close it, the Menu key keeps it); a right
 * click on the floor still walks the selected character; in the editor a right-click still erases
 * a tile; a text field keeps the browser menu and its selection; Back closes the top panel and
 * leaves the office in place; a mouse side button does nothing on the canvas; a refresh keeps the
 * unsent text and the zoom. Phone: a long press on the character opens its menu, a long press on a
 * card selects nothing. Screenshots: cld/artifacts/g1/.
 *
 *   npx tsx cld/test/run-g1.ts <port 18256-18259>
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
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/g1');

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(
  what: string,
  fn: () => Promise<boolean> | boolean,
  ms = 15_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out: ${what}`);
}

function session(home: string, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c1024700-0000-4000-8000-000000000001';
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

/** Every contextmenu event as the page's last (bubbling) listener saw it. */
const RECORDER = `
  globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;
  window.__ctx = [];
  document.addEventListener('contextmenu', (e) => {
    const el = e.target;
    window.__ctx.push({ tag: el.tagName, id: el.getAttribute && el.getAttribute('data-testid'), prevented: e.defaultPrevented });
  });`;
type Ctx = { tag: string; id: string | null; prevented: boolean };
const lastCtx = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ctx: Ctx[] }).__ctx.at(-1) as Ctx);

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const lead = session(home, 'lead', '/work/alpha');
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal', '--allow-chat'], {});
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript(RECORDER);
    const page = await ctx.newPage();
    pages.push(page);
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const pages: Page[] = [];
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const menuOf = (page: Page) => page.getByRole('menu', { name: 'lead 메뉴' });
  /** Where to click the character: its label's top is 34 CSS px above its feet - 32 world px. */
  const charPoint = async (page: Page) => {
    const label = page.locator('[data-testid="agent-overlay"]').first();
    const box = (await label.boundingBox())!;
    const ez = await label.evaluate((el) => el.classList.contains('-translate-y-full'));
    const scale = await page.evaluate(() => {
      const h = (
        window as unknown as {
          __pixelAgentsTestHooks: { getTileCenter: (c: number, r: number) => { x: number } | null };
        }
      ).__pixelAgentsTestHooks;
      return (h.getTileCenter(1, 0)!.x - h.getTileCenter(0, 0)!.x) / 16;
    });
    return { x: box.x + box.width / 2, y: (ez ? box.y + box.height : box.y + 34) + 20 * scale };
  };
  const emptySpot = async (page: Page) => {
    const c = (await page.getByTestId('office-canvas').boundingBox())!;
    return { x: c.x + c.width * 0.12, y: c.y + c.height * 0.85 };
  };
  const start = async (page: Page, url: string) => {
    await page.goto(url);
    await page.getByTestId('agent-card').first().waitFor();
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(600);
  };

  try {
    const loginUrl = await started.loginUrl();
    const { ctx: desk, page } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await start(page, `http://127.0.0.1:${port}/`);

    // ── GUX-1: game areas never show the browser menu ──
    const spot = await emptySpot(page);
    await page.mouse.click(spot.x, spot.y, { button: 'right' });
    let ctx = await lastCtx(page);
    check(
      ctx.prevented && ctx.id === 'office-canvas',
      'desktop: right-click on the canvas is prevented',
    );
    const icon = page.getByRole('button', { name: /^메신저/ });
    await icon.click({ button: 'right' });
    check((await lastCtx(page)).prevented, 'desktop: right-click on a HUD icon is prevented');
    const card = page.getByTestId('agent-card').first();
    await card.dispatchEvent('contextmenu', { cancelable: true, bubbles: true, button: 2 });
    check((await lastCtx(page)).prevented, 'desktop: right-click on a card is prevented');
    await page.getByRole('button', { name: '꾸미기 닫기' }).click(); // the card's own menu opened it
    const rules = await page.evaluate(() => ({
      body: getComputedStyle(document.body).userSelect,
      canvas: getComputedStyle(document.querySelector('[data-testid="office-canvas"]')!).userSelect,
    }));
    check(rules.body === 'none' && rules.canvas === 'none', 'desktop: the page selects no text');

    // ── The character menu: right-click opens, Esc / a click on the floor close, Menu key keeps ──
    check((await menuOf(page).count()) === 0, 'desktop: no menu before any selection');
    let p = await charPoint(page);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await menuOf(page).waitFor({ timeout: 5_000 });
    ctx = await lastCtx(page);
    check(ctx.prevented, 'desktop: right-click on a character opens its menu, no browser menu');
    await shot(page, 'desktop-character-menu');
    await page.keyboard.press('ContextMenu');
    await page.waitForTimeout(200);
    check(
      (await lastCtx(page)).prevented && (await menuOf(page).count()) === 1,
      'desktop: the Menu key shows no browser menu and the character menu stays',
    );
    await page.keyboard.press('Escape');
    await until('Esc closes the menu', async () => (await menuOf(page).count()) === 0);
    check(true, 'desktop: Esc closes the character menu');
    p = await charPoint(page);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await menuOf(page).waitFor({ timeout: 5_000 });
    await page.mouse.click(spot.x, spot.y);
    await until(
      'a click on the floor closes the menu',
      async () => (await menuOf(page).count()) === 0,
    );
    check(true, 'desktop: a click outside closes the character menu');

    // ── GUX-2: right-click on the floor still walks the selected character ──
    p = await charPoint(page);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await menuOf(page).waitFor();
    const before = await charPoint(page);
    const c = (await page.getByTestId('office-canvas').boundingBox())!;
    let moved = false;
    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.4, 0.45],
      [0.6, 0.55],
      [0.3, 0.6],
      [0.7, 0.4],
    ]) {
      await page.mouse.click(c.x + c.width * fx, c.y + c.height * fy, { button: 'right' });
      await page.waitForTimeout(1200);
      const now = await charPoint(page);
      if (Math.abs(now.x - before.x) + Math.abs(now.y - before.y) > 4) {
        moved = true;
        break;
      }
    }
    check(moved, 'desktop: right-click on the floor still walks the selected character');
    await page.keyboard.press('Escape');

    // ── GUX-2: the editor's right-click still erases ──
    await page.getByRole('button', { name: '인테리어', exact: true }).click();
    await page.getByRole('button', { name: 'Erase', exact: true }).click();
    const target = await page.evaluate(() => {
      const h = (
        window as unknown as {
          __pixelAgentsTestHooks: {
            getTiles: () => { cols: number; rows: number; tiles: number[] };
            getTileCenter: (c: number, r: number) => { x: number; y: number } | null;
          };
        }
      ).__pixelAgentsTestHooks;
      const { cols, rows, tiles } = h.getTiles();
      const canvas = document
        .querySelector('[data-testid="office-canvas"]')!
        .getBoundingClientRect();
      for (let r = Math.floor(rows / 2); r < rows; r++)
        for (let col = Math.floor(cols / 2); col < cols; col++) {
          const t = tiles[r * cols + col];
          const at = h.getTileCenter(col, r);
          if (
            t >= 1 &&
            t <= 9 &&
            at &&
            at.x > 0 &&
            at.y > 0 &&
            at.x < canvas.width &&
            at.y < canvas.height - 60
          )
            return { col, row: r, x: canvas.left + at.x, y: canvas.top + at.y };
        }
      return null;
    });
    check(target, 'desktop: a floor tile to erase is on screen');
    await page.mouse.click(target!.x, target!.y, { button: 'right' });
    const tileAt = () =>
      page.evaluate(
        ([col, row]) => {
          const t = (
            window as unknown as {
              __pixelAgentsTestHooks: { getTiles: () => { cols: number; tiles: number[] } };
            }
          ).__pixelAgentsTestHooks.getTiles();
          return t.tiles[row * t.cols + col];
        },
        [target!.col, target!.row],
      );
    await until('the right-click erased the tile', async () => (await tileAt()) === 255);
    check(true, 'desktop: in the editor a right-click still erases the tile under it');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // ── GUX-3: the chat box keeps the browser's selection and menu ──
    p = await charPoint(page);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await menuOf(page).waitFor();
    await menuOf(page).getByRole('menuitem', { name: '대화' }).click();
    const messenger = page.locator('[data-hud-window="messenger"]');
    await messenger.waitFor();
    // The fake session is not engine-owned (no composer); the search box is the text field here.
    await messenger.getByRole('button', { name: '대화 검색' }).click();
    const box = messenger.getByRole('textbox', { name: '검색어' });
    await box.waitFor();
    await box.fill('보내지 않은 글 하나');
    await box.click({ button: 'right' });
    ctx = await lastCtx(page);
    check(
      ctx.tag === 'INPUT' && !ctx.prevented,
      'desktop: right-click in a text field keeps the browser menu',
    );
    await box.press('Control+a');
    const selected = await box.evaluate((el: HTMLInputElement) =>
      el.value.slice(el.selectionStart, el.selectionEnd),
    );
    check(selected === '보내지 않은 글 하나', 'desktop: text in a text field can be selected');
    const body = messenger.locator('[data-selectable]').first();
    check(
      (await body.evaluate((el) => getComputedStyle(el).userSelect)) === 'text',
      'desktop: a panel body selects text',
    );
    const title = page.getByTestId('hud-title-messenger');
    check(
      (await title.evaluate((el) => getComputedStyle(el).userSelect)) === 'none',
      'desktop: a panel title bar does not',
    );
    await title.click({ button: 'right' });
    check(
      (await lastCtx(page)).prevented,
      'desktop: right-click on a panel title bar is prevented',
    );
    await shot(page, 'desktop-text-field');

    // ── GUX-4: Back closes the top panel; the office stays ──
    await page.evaluate(() => ((window as unknown as { __alive: boolean }).__alive = true));
    const urlBefore = page.url();
    await page.getByRole('button', { name: /^현황판/ }).click();
    const office = page.locator('[data-hud-window="office"]');
    await office.waitFor();
    await page.goBack();
    await until('Back closes the 현황판 window', async () => (await office.count()) === 0);
    check(
      (await messenger.count()) === 1,
      'desktop: Back closes only the top panel (the messenger stays)',
    );
    await page.goBack();
    await until('Back closes the messenger', async () => (await messenger.count()) === 0);
    check(
      page.url() === urlBefore &&
        (await page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive === true)),
      'desktop: Back closed both panels and stayed on the office page',
    );
    const side = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="office-canvas"]')!;
      return ['mousedown', 'mouseup', 'auxclick'].map(
        (type) =>
          !canvas.dispatchEvent(
            new MouseEvent(type, { button: 3, bubbles: true, cancelable: true }),
          ),
      );
    });
    check(side.every(Boolean), 'desktop: the mouse side button is ignored on the canvas');

    // ── GUX-4: a refresh keeps the zoom and pan (the unsent chat text is MSG-HOLD2's, run-messenger.ts) ──
    await page.getByRole('button', { name: /^메신저/ }).click();
    await messenger.waitFor();
    await page.keyboard.press('Escape');
    const zoomOf = () =>
      page.evaluate(() => {
        const h = (
          window as unknown as {
            __pixelAgentsTestHooks: { getTileCenter: (c: number, r: number) => { x: number } };
          }
        ).__pixelAgentsTestHooks;
        return Math.round((h.getTileCenter(1, 0).x - h.getTileCenter(0, 0).x) * devicePixelRatio);
      });
    await page.mouse.move(spot.x, spot.y);
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await page.waitForTimeout(500);
    const zoomed = await zoomOf();
    await page.keyboard.down('d');
    await page.waitForTimeout(500);
    await page.keyboard.up('d');
    await page.waitForTimeout(600);
    const panned = await page.evaluate(() => {
      const h = (
        window as unknown as {
          __pixelAgentsTestHooks: {
            getTileCenter: (c: number, r: number) => { x: number; y: number };
          };
        }
      ).__pixelAgentsTestHooks;
      return h.getTileCenter(0, 0);
    });
    await page.reload();
    await start(page, `http://127.0.0.1:${port}/`);
    await page.waitForTimeout(800);
    const back = await page.evaluate(() => {
      const h = (
        window as unknown as {
          __pixelAgentsTestHooks: {
            getTileCenter: (c: number, r: number) => { x: number; y: number };
          };
        }
      ).__pixelAgentsTestHooks;
      return h.getTileCenter(0, 0);
    });
    check((await zoomOf()) === zoomed, `desktop: the zoom survives a refresh (${zoomed})`);
    check(
      Math.abs(back.x - panned.x) < 2 && Math.abs(back.y - panned.y) < 2,
      `desktop: the pan survives a refresh (${panned.x.toFixed(0)},${panned.y.toFixed(0)} -> ${back.x.toFixed(0)},${back.y.toFixed(0)})`,
    );
    await shot(page, 'desktop-after-refresh');
    // ── Phone: a long press opens the character menu; a long press on a card selects nothing ──
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await desk.cookies());
    await start(phone, `http://127.0.0.1:${port}/`);
    const cdp = await phoneCtx.newCDPSession(phone);
    const hold = async (x: number, y: number, ms: number) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await phone.waitForTimeout(ms);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    // Bring the character into view with its card, then deselect it by a tap on the floor.
    await phone.getByTestId('agent-card').first().tap();
    await menuOf(phone).waitFor({ timeout: 5_000 });
    await phone.waitForTimeout(1500);
    const pc = (await phone.getByTestId('office-canvas').boundingBox())!;
    await phone.touchscreen.tap(pc.x + pc.width * 0.5, pc.y + pc.height * 0.9);
    await until('the tap on the floor deselects', async () => (await menuOf(phone).count()) === 0);
    check((await menuOf(phone).count()) === 0, 'phone: no menu before the hold');
    const pp = await charPoint(phone);
    await hold(pp.x, pp.y, 800);
    await menuOf(phone).waitFor({ timeout: 5_000 });
    check(true, 'phone: a long press on the character opens its menu');
    await shot(phone, 'phone-character-menu');
    const phoneCard = phone.getByTestId('agent-card').first();
    const cb = (await phoneCard.boundingBox())!;
    await hold(cb.x + cb.width / 2, cb.y + cb.height / 2, 900);
    const sel = await phone.evaluate(() => String(window.getSelection() ?? ''));
    const phoneRules = await phone.evaluate(() => ({
      body: getComputedStyle(document.body).userSelect,
      callout: getComputedStyle(document.body).getPropertyValue('-webkit-touch-callout'),
    }));
    check(
      sel === '' && phoneRules.body === 'none',
      'phone: a long press on a card selects nothing',
    );
    await phoneCard.dispatchEvent('contextmenu', { cancelable: true, bubbles: true });
    check((await lastCtx(phone)).prevented, 'phone: the context menu on a card is prevented');
    await shot(phone, 'phone-card-hold');
    await phoneCtx.close();

    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    console.log('all checks passed');
  } catch (err) {
    for (const [i, pg] of pages.entries())
      await pg.screenshot({ path: path.join(OUT, `failure-${i}.png`) }).catch(() => undefined);
    throw err;
  } finally {
    await browser.close();
    started.child.kill();
    lead.kill();
    killFakeSessions(home);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

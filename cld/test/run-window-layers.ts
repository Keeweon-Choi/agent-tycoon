/**
 * WINDOW-LAYERS check (desktop 1280x800 and 1920x1080, the phone untouched): the windows get the
 * whole room under the top bar; the card bar (orchestrator panel), the icon dock and the elevator
 * draw over normal windows; a window dragged under the card bar is covered by it but its title
 * buttons stay visible (and are pushed clear when the title row is level with the panel); no
 * window reaches the top bar; maximize fills everything under the top bar in front of the panels
 * and restore returns; the card bar is centred under the top bar; with 12 orchestrators the card
 * list scrolls inside the panel (the tag and + stay) and the panel never runs past the room.
 *
 * dist/cli.js with --engine on --no-terminal in a temp HOME whose `claude` is the engine fake, on a
 * spare port; headless Chromium (--disable-gpu). Screenshots: cld/artifacts/window-layers/.
 *
 *   npx tsx cld/test/run-window-layers.ts <port 18256-18259>
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/window-layers');
const FONTS = { malgun: '/mnt/c/Windows/Fonts/malgun.ttf', emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf' };
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__bx/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__bx/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const DEADLINE_MS = 240_000;
const IPHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 } };
})();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
type Box = { x: number; y: number; w: number; h: number };
const fmt = (b: Box) => `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}`;

/** One daemon with `leads` orchestrators, a browser, and `body` run against them; all cleaned up after. */
async function withOffice(
  leads: string[],
  body: (open: (opts: BrowserContextOptions) => Promise<Page>, loginUrl: () => Promise<string>) => Promise<void>,
) {
  await assertPortFree(port);
  const { home, bin } = makeEngineHome();
  fs.writeFileSync(path.join(home, '.config/cld-gui/config.json'), JSON.stringify({ accessChosen: true, port }));
  const folders = Object.fromEntries(leads.map((n) => [n, path.join(home, 'work', n)]));
  for (const f of Object.values(folders)) fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/projects.json'),
    JSON.stringify(leads.map((name) => ({ name, folder: folders[name], room: '개발실', wantRunning: true }))),
  );
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--no-terminal', '--allow-actions'], {
    FAKE_TURN_MS: '600',
  });
  const cleanup = () => {
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}\n${daemon.log.join('').slice(-1500)}`);
    if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
    cleanup();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  try {
    const loginUrl = () => daemon.loginUrl();
    const open = async (opts: BrowserContextOptions) => {
      const ctx = await browser.newContext(opts);
      await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
      await ctx.route('**/__bx/*.ttf', (route) =>
        route.fulfill({
          body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun,
          contentType: 'font/ttf',
        }),
      );
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      return page;
    };
    await body(open, loginUrl);
    check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`);
  } catch (err) {
    console.error(daemon.log.join('').slice(-1500));
    await browser.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(OUT, 'debug.png') }).catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser.close();
    if (daemon.child.exitCode === null) {
      const gone = new Promise((r) => daemon.child.once('exit', r));
      daemon.child.kill('SIGTERM');
      await Promise.race([gone, sleep(5_000)]);
    }
    cleanup();
  }
}

const ready = async (page: Page, url: string, cards: number) => {
  await page.goto(url);
  await page.waitForURL(`http://127.0.0.1:${port}/`);
  await page.addStyleTag({ content: FONT_CSS });
  await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="agent-card"]').length >= n,
    cards,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(2_000);
  const notice = page.getByRole('button', { name: '계속 물어보기' });
  if (await notice.count()) await notice.click();
};
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const box = async (loc: ReturnType<Page['locator']>): Promise<Box> => {
  const b = (await loc.boundingBox())!;
  return { x: b.x, y: b.y, w: b.width, h: b.height };
};
/** The top bar's bottom edge. */
const barBottom = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-hud-id="usage"]')!.getBoundingClientRect().bottom);
/** The element at the middle of `selector` belongs to (is inside) `owner`. */
const topAt = (page: Page, selector: string, ownerSelector: string) =>
  page.evaluate(
    ([sel, own]) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit?.closest(own);
    },
    [selector, ownerSelector],
  );
/** Every title button of window `id` is what a click at its middle hits. */
const buttonsVisible = (page: Page, id: string) =>
  page.evaluate((win) => {
    const buttons = [...document.querySelectorAll(`[data-testid="hud-title-${win}"] button`)];
    if (buttons.length < 3) return `only ${buttons.length} buttons`;
    for (const b of buttons) {
      const r = b.getBoundingClientRect();
      if (r.left < 0 || r.right > innerWidth) return `${b.getAttribute('aria-label')} off screen`;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit?.closest('button') !== b) return `${b.getAttribute('aria-label')} is covered by ${hit?.tagName} ${hit?.className}`;
    }
    return null;
  }, id);
/** How wide a stretch of window `id`'s title bar is really on top (what a click would hit), px. */
const grabbableTitle = (page: Page, id: string) =>
  page.evaluate((win) => {
    const bar = document.querySelector(`[data-testid="hud-title-${win}"]`)!;
    const r = bar.getBoundingClientRect();
    let best = 0;
    let run = 0;
    for (let x = Math.max(0, Math.ceil(r.left)); x < Math.min(innerWidth, r.right); x += 4) {
      const hit = document.elementFromPoint(x, r.top + r.height / 2);
      run = hit && bar.contains(hit) ? run + 4 : 0;
      best = Math.max(best, run);
    }
    return best;
  }, id);
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

const CONTAINER = '[data-testid="card-container"]';
const WIN = '[data-hud-window="notices"]';
const TITLE = '[data-testid="hud-title-notices"]';

/** The desktop checks at one size, with few cards (a short panel in the middle). */
async function desktop(page: Page, size: { width: number; height: number }) {
  const tag = `desktop ${size.width}`;
  await page.setViewportSize(size);
  await page.waitForTimeout(700);
  const bar = await barBottom(page);

  // The card bar is centred in the room under the top bar, like the elevator.
  const card = await box(page.locator(CONTAINER));
  const roomMid = (bar + size.height) / 2;
  check(Math.abs(card.y + card.h / 2 - roomMid) <= 6, `${tag}: the card bar is centred under the top bar (centre ${Math.round(card.y + card.h / 2)}, room middle ${Math.round(roomMid)})`);
  check(card.y >= bar && card.y + card.h <= size.height, `${tag}: the card bar stays inside the room (${fmt(card)})`);
  const dock = await page.evaluate(() => {
    const r = [...document.querySelectorAll('[data-hud-panels] [data-hud-id^="icon:"]')].map((e) => e.getBoundingClientRect());
    return { top: Math.min(...r.map((b) => b.top)), bottom: Math.max(...r.map((b) => b.bottom)), n: r.length };
  });
  check(dock.n >= 4 && Math.abs((dock.top + dock.bottom) / 2 - roomMid) <= 6, `${tag}: the icon dock (${dock.n} icons) is a column centred beside the card bar`);

  // Open a window; its default place keeps clear of the panels.
  await page.locator('[data-hud-id="icon:notices"] button').click();
  await page.waitForTimeout(500);
  await shot(page, `${tag.replace(' ', '-')}-1-default`);

  // A short window (the default one is as tall as the room), so it can be put level with the card bar.
  let h0 = await box(page.locator(WIN));
  const handle = await box(page.locator(`${WIN} [data-handle="s"]`));
  await drag(page, { x: handle.x + handle.w / 2, y: handle.y + handle.h / 2 }, { x: handle.x + handle.w / 2, y: h0.y + 260 });
  h0 = await box(page.locator(WIN));
  check(h0.h < 320, `${tag}: the window was made short (${fmt(h0)})`);

  // 1. The whole width: dragged flush right (title row above the card bar), its right edge is the screen's.
  const titleY = bar + 20;
  let w = await box(page.locator(WIN));
  await drag(page, { x: w.x + 60, y: w.y + 16 }, { x: size.width - 40, y: titleY });
  w = await box(page.locator(WIN));
  check(Math.abs(w.x + w.w - size.width) <= 12, `${tag}: a window can reach the right screen edge, under the panels (right edge ${Math.round(w.x + w.w)} of ${size.width})`);
  check(w.y >= bar - 0.5, `${tag}: it did not go under the top bar (top ${Math.round(w.y)}, bar bottom ${Math.round(bar)})`);
  check(card.y > w.y + 50, `${tag}: its title row is above the card bar`);
  check(await topAt(page, CONTAINER, CONTAINER), `${tag}: the card bar draws over the window (its middle hits the card bar)`);
  check(!(await topAt(page, '[data-hud-id="icon:office"]', '[data-hud-window]')), `${tag}: the icon dock draws over the window`);
  check((await buttonsVisible(page, 'notices')) === null, `${tag}: its minimize, maximize and close buttons are visible (${await buttonsVisible(page, 'notices')})`);
  await shot(page, `${tag.replace(' ', '-')}-2-under-panels`);

  // 2. Dragged to the left screen edge: the elevator draws over it, the buttons are visible.
  await drag(page, { x: w.x + 60, y: w.y + 16 }, { x: 5, y: titleY });
  w = await box(page.locator(WIN));
  check(w.x <= 12, `${tag}: a window can reach the left screen edge (${Math.round(w.x)})`);
  check((await buttonsVisible(page, 'notices')) === null, `${tag}: left, its buttons are visible`);

  // 3. Pulled up past the top bar: it stops at the bar.
  await drag(page, { x: w.x + 60, y: w.y + 16 }, { x: w.x + 60, y: -50 });
  w = await box(page.locator(WIN));
  check(w.y >= bar - 0.5, `${tag}: dragged up it stops under the top bar (top ${Math.round(w.y)}, bar ${Math.round(bar)})`);

  // 4. A short window, title row level with the card bar, dragged to the right edge: it goes under
  // the card bar (it is not stopped at its edge); part of its title bar stays on top.
  const level = card.y + card.h / 2;
  await drag(page, { x: w.x + 60, y: w.y + 16 }, { x: size.width - 30, y: level });
  w = await box(page.locator(WIN));
  check(w.x + w.w >= size.width - 12, `${tag}: a window shorter than the card bar goes under it, to the screen edge (right ${Math.round(w.x + w.w)} of ${size.width}, card bar at ${Math.round(card.x)})`);
  check((await topAt(page, CONTAINER, CONTAINER)) && w.y < card.y + card.h && w.y + 40 > card.y, `${tag}: its title row is level with the card bar, which draws over it`);
  const grab = await grabbableTitle(page, 'notices');
  check(grab >= 48, `${tag}: ${grab}px of its title bar stays grabbable`);
  await shot(page, `${tag.replace(' ', '-')}-3-under-card-bar`);

  // 5. A viewport resize keeps the title grabbable and the window under the bar.
  const smaller = { width: size.width - 240, height: size.height - 160 };
  await page.setViewportSize(smaller);
  await page.waitForTimeout(600);
  w = await box(page.locator(WIN));
  check((await grabbableTitle(page, 'notices')) >= 48 && w.y >= (await barBottom(page)) - 0.5, `${tag}: after a smaller viewport the title bar is grabbable and the window is under the top bar`);
  await page.setViewportSize(size);
  await page.waitForTimeout(600);
  await drag(page, { x: (await box(page.locator(WIN))).x + 60, y: (await box(page.locator(WIN))).y + 16 }, { x: size.width / 2, y: titleY + 40 });

  // 6. Maximize: everything under the top bar, in front of the panels; restore returns.
  const before = await box(page.locator(WIN));
  await page.locator(`${TITLE} [aria-label="최대화"]`).click();
  await page.waitForTimeout(500);
  const max = await box(page.locator(WIN));
  const barNow = await barBottom(page);
  check(
    Math.abs(max.x) <= 1 && Math.abs(max.y - barNow) <= 1 && Math.abs(max.w - size.width) <= 1 && Math.abs(max.y + max.h - size.height) <= 1,
    `${tag}: maximize fills everything under the top bar (${fmt(max)} in ${size.width}x${size.height}, bar ${Math.round(barNow)})`,
  );
  check(await topAt(page, CONTAINER, WIN), `${tag}: the maximized window is in front of the card bar`);
  check(await topAt(page, '[data-hud-id="icon:office"]', WIN), `${tag}: ... and in front of the icon dock`);
  check((await buttonsVisible(page, 'notices')) === null, `${tag}: maximized, its buttons are visible`);
  await shot(page, `${tag.replace(' ', '-')}-4-maximized`);
  await page.locator(`${TITLE} [aria-label="원래 크기"]`).click();
  await page.waitForTimeout(500);
  const back = await box(page.locator(WIN));
  check(Math.abs(back.x - before.x) <= 1 && Math.abs(back.y - before.y) <= 1 && Math.abs(back.w - before.w) <= 1 && Math.abs(back.h - before.h) <= 1, `${tag}: restore puts it back at ${fmt(before)} (${fmt(back)})`);
  check(await topAt(page, CONTAINER, CONTAINER), `${tag}: restored, the card bar is over it again`);
  await page.locator(`${TITLE} [aria-label="알림 닫기"]`).evaluate((b: HTMLElement) => b.click());
  await page.waitForTimeout(300);
}

/** What one drag of window `id` costs: Chromium's trace (layout, style, paint, raster) over a drag, against the same pointer path with no button down. */
async function dragProfile(page: Page, id: string, label: string, dir: 1 | -1) {
  const win = `[data-hud-window="${id}"]`;
  const close = async () => {
    if (await page.locator(win).isVisible()) await page.locator(`[data-hud-id="icon:${id}"] button`).click();
    await page.waitForTimeout(200);
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(500);
  await page.locator(`[data-hud-id="icon:${id}"] button`).click();
  await page.waitForTimeout(600);
  await page.evaluate((sel) => {
    const w = window as unknown as Record<string, number>;
    if (w.__patched) return;
    w.__patched = 1;
    w.__reads = 0;
    w.__writes = 0;
    w.__frames = 0;
    const tick = () => {
      w.__frames++;
      requestAnimationFrame(tick);
    };
    tick();
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      w.__reads++;
      return orig.call(this);
    };
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
      if (k === 'cld.hud.layout.v1') w.__writes++;
      return set.call(this, k, v);
    };
    void sel;
  }, win);
  // Style writes on this window (React or direct), counted from the page.
  await page.evaluate((sel) => {
    const w = window as unknown as Record<string, number>;
    w.__styles = 0;
    new MutationObserver((m) => (w.__styles += m.length)).observe(document.querySelector(sel)!, { attributes: true, attributeFilter: ['style'] });
  }, win);
  const browser = page.context().browser()!;
  const w0 = await box(page.locator(win));
  const STEPS = 120;
  const from = { x: dir === 1 ? w0.x + 80 : w0.x + w0.w - 200, y: w0.y + 16 };
  const run = async (press: boolean) => {
    await page.mouse.move(from.x, from.y);
    const a = await page.evaluate(() => { const x = window as unknown as Record<string, number>; return { reads: x.__reads, writes: x.__writes, styles: x.__styles, frames: x.__frames }; });
    await browser.startTracing(page, { categories: ['devtools.timeline'] });
    if (press) await page.mouse.down();
    for (let i = 1; i <= STEPS; i++) await page.mouse.move(from.x + dir * i * 3, from.y + dir * i * 2.5);
    if (press) await page.mouse.up();
    await page.waitForTimeout(300);
    const trace = JSON.parse((await browser.stopTracing()).toString()) as { traceEvents: { name: string; dur?: number; ph: string }[] };
    const b = await page.evaluate(() => { const x = window as unknown as Record<string, number>; return { reads: x.__reads, writes: x.__writes, styles: x.__styles, frames: x.__frames }; });
    const sum = (re: RegExp) => {
      const hit = trace.traceEvents.filter((e) => e.ph === 'X' && re.test(e.name));
      return { n: hit.length, ms: Math.round(hit.reduce((t, e) => t + (e.dur ?? 0), 0) / 100) / 10 };
    };
    return {
      layout: sum(/^Layout$/), style: sum(/^UpdateLayoutTree$/), paint: sum(/^Paint$/), raster: sum(/^RasterTask$/), fire: sum(/^FunctionCall$|^EventDispatch$/),
      rectReads: b.reads - a.reads, storeWrites: b.writes - a.writes, styleWrites: b.styles - a.styles, frames: b.frames - a.frames,
    };
  };
  const idle = await run(false);
  const drag = await run(true);
  const f = (k: 'layout' | 'style' | 'paint' | 'raster' | 'fire') => `${drag[k].n}x ${drag[k].ms} ms (idle ${idle[k].n}x ${idle[k].ms} ms)`;
  console.log(`PROFILE ${label}: ${STEPS} pointer moves. layout ${f('layout')}; style ${f('style')}; paint ${f('paint')}; raster ${f('raster')}; script events ${f('fire')}; rect reads ${drag.rectReads} (idle ${idle.rectReads}); store writes ${drag.storeWrites}; window style writes ${drag.styleWrites} in ${drag.frames} frames`);
  await close();
  return { idle, drag };
}

/** The 아래 가로 preset: the icons in a row along the bottom edge. A window may go under it, and nothing at the bottom is reserved. */
async function bottomDock(page: Page) {
  const size = { width: 1280, height: 800 };
  await page.setViewportSize(size);
  const ICON = 40;
  const GAP = 8;
  const icons = ['office', 'workbench', 'notices', 'files'];
  await page.evaluate(
    ([ids, startX]) => {
      const items: Record<string, unknown> = {};
      (ids as string[]).forEach((id, i) => (items[`icon:${id}`] = { place: { corner: 'bl', dx: (startX as number) + i * 48, dy: 4 } }));
      localStorage.setItem('cld.hud.layout.v1', JSON.stringify({ v: 1, items, preset: 'bottom' }));
    },
    [icons, 548],
  );
  await page.reload();
  await page.locator('[data-hud-panels] [data-hud-id="icon:notices"]').waitFor();
  await page.waitForTimeout(1500);
  const notice = page.getByRole('button', { name: '계속 물어보기' });
  if (await notice.count()) await notice.click();
  const dock = await box(page.locator('[data-hud-id="icon:office"]'));
  check(dock.y > size.height - 60 && dock.x > 400, `bottom dock: the icons are a row along the bottom edge (${fmt(dock)})`);
  await page.locator('[data-hud-id="icon:notices"] button').click();
  await page.waitForTimeout(500);
  let w = await box(page.locator(WIN));
  // Short, then to the bottom edge, over the dock.
  const handle = await box(page.locator(`${WIN} [data-handle="s"]`));
  await drag(page, { x: handle.x + handle.w / 2, y: handle.y + handle.h / 2 }, { x: handle.x + handle.w / 2, y: w.y + 240 });
  w = await box(page.locator(WIN));
  await drag(page, { x: w.x + 60, y: w.y + 16 }, { x: dock.x + 40, y: size.height + 60 });
  w = await box(page.locator(WIN));
  check(Math.abs(w.y + w.h - size.height) <= 12, `bottom dock: a window reaches the bottom edge, nothing reserved (bottom ${Math.round(w.y + w.h)} of ${size.height})`);
  check(w.x < dock.x + dock.w && w.x + w.w > dock.x && w.y + w.h > dock.y + dock.h - 1, `bottom dock: the window is under the dock row (${fmt(w)} against ${fmt(dock)})`);
  check(!(await topAt(page, '[data-hud-id="icon:office"]', '[data-hud-window]')), 'bottom dock: the dock draws over the window');
  check((await buttonsVisible(page, 'notices')) === null, 'bottom dock: the window\'s buttons are visible');
  await shot(page, 'desktop-1280-5-under-bottom-dock');
  await page.evaluate(() => localStorage.removeItem('cld.hud.layout.v1'));
  await page.reload();
  await page.waitForTimeout(1500);
  const notice2 = page.getByRole('button', { name: '계속 물어보기' });
  if (await notice2.count()) await notice2.click();
}

/** The cost of a drag: one store write, no layout reads of ours, a composited move. */
async function perf(page: Page) {
  const a = await dragProfile(page, 'notices', 'notices', 1);
  const b = await dragProfile(page, 'office', 'office', -1);
  for (const [name, r] of [['notices', a], ['office', b]] as const) {
    check(r.drag.storeWrites <= 1, `drag ${name}: at most one store write for the whole drag (${r.drag.storeWrites})`);
    check(r.drag.rectReads - r.idle.rectReads <= 6, `drag ${name}: no layout reads per pointer move (${r.drag.rectReads - r.idle.rectReads} more than the same path with no button, 120 moves)`);
    check(r.drag.styleWrites <= r.drag.frames + 2, `drag ${name}: the window's style is written once per frame at most (${r.drag.styleWrites} writes in ${r.drag.frames} frames, 120 pointer moves)`);
    check(r.drag.layout.n <= r.idle.layout.n + 4 && r.drag.paint.n <= r.idle.paint.n + 30, `drag ${name}: no layout per move and a composited move (layouts ${r.drag.layout.n}, paints ${r.drag.paint.n}; with no button ${r.idle.layout.n}, ${r.idle.paint.n})`);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (process.env.PROFILE_ONLY) {
    await withOffice(['alpha', 'beta', 'gamma'], async (open, loginUrl) => {
      const page = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
      await ready(page, await loginUrl(), 3);
      for (const id of ['notices', 'office'])
        for (let i = 0; i < 2; i++) await dragProfile(page, id, `${id} run ${i + 1}`, i % 2 === 0 ? 1 : -1);
    });
    return;
  }

  // Phase A: three orchestrators, desktop at two sizes, the phone untouched.
  await withOffice(['alpha', 'beta', 'gamma'], async (open, loginUrl) => {
    const page = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await ready(page, await loginUrl(), 3);
    await desktop(page, { width: 1280, height: 800 });
    await desktop(page, { width: 1920, height: 1080 });
    await bottomDock(page);
    await perf(page);
    const phone = await open(IPHONE);
    await ready(phone, await loginUrl(), 3);
    await phone.getByTestId('mobile-agent-bar').waitFor();
    check((await phone.locator('[data-hud-panels]').count()) === 0 && (await phone.locator(CONTAINER).count()) === 0, 'phone 393: no HUD layer, no desktop card bar');
    check((await phone.getByTestId('mobile-dock').isVisible()) && (await phone.locator('[data-testid="agent-card"]').count()) >= 3, 'phone 393: the Dock and the card bar are as before');
    await shot(phone, 'phone-393');
  });

  // Phase B: twelve orchestrators: the list scrolls in the panel.
  await withOffice(Array.from({ length: 12 }, (_, i) => `lead${String(i + 1).padStart(2, '0')}`), async (open, loginUrl) => {
    const page = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await ready(page, await loginUrl(), 12);
    for (const size of [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }]) {
      const tag = `12 cards, ${size.width}`;
      await page.setViewportSize(size);
      await page.waitForTimeout(700);
      const bar = await barBottom(page);
      const card = await box(page.locator(CONTAINER));
      check(card.y >= bar - 0.5 && card.y + card.h <= size.height + 0.5, `${tag}: the panel stays below the top bar and inside the room (${fmt(card)}, bar ${Math.round(bar)})`);
      const list = await page.evaluate(() => {
        const l = document.querySelector('[data-testid="card-container"] > div') as HTMLElement;
        const cards = [...l.querySelectorAll('[data-agent-id]')] as HTMLElement[];
        return { scroll: l.scrollHeight, client: l.clientHeight, n: cards.length, ch: cards[0].offsetHeight };
      });
      check(list.n === 12 && list.scroll > list.client, `${tag}: the card list scrolls inside the panel (${list.n} cards, ${list.scroll}px in ${list.client}px)`);
      check(list.client <= 10 * (list.ch + 12) + 40, `${tag}: it shows about ten cards at most (${list.client}px, card ${list.ch}px)`);
      const addBox = await box(page.getByTestId('card-add'));
      check(addBox.y + addBox.h <= card.y + card.h + 0.5 && (await topAt(page, '[data-testid="card-add"]', '[data-testid="card-add"]')), `${tag}: the + button stays in view and clickable`);
      await page.locator(`${CONTAINER} > div`).evaluate((el) => (el.scrollTop = el.scrollHeight));
      await page.waitForTimeout(300);
      const tagBox = await box(page.getByTestId('card-group').first());
      const listBox = await box(page.locator(`${CONTAINER} > div`));
      check(tagBox.y >= listBox.y - 0.5 && tagBox.y < listBox.y + 40, `${tag}: scrolled to the end, the 오케스트레이터 tag stays at the top of the list`);
      await shot(page, `cards12-${size.width}`);
      // A window at the top right: buttons visible next to the tall panel.
      await page.locator('[data-hud-id="icon:notices"] button').click();
      await page.waitForTimeout(500);
      const w = await box(page.locator(WIN));
      await drag(page, { x: w.x + 60, y: w.y + 16 }, { x: size.width - 40, y: bar + 40 });
      const under = await box(page.locator(WIN));
      check(under.x + under.w >= size.width - 12, `${tag}: a window dragged to the right edge goes under the tall panel too (right ${Math.round(under.x + under.w)})`);
      check((await grabbableTitle(page, 'notices')) >= 48, `${tag}: ${await grabbableTitle(page, 'notices')}px of its title bar stays grabbable`);
      await shot(page, `cards12-${size.width}-window`);
      await page.locator(`${TITLE} [aria-label="알림 닫기"]`).evaluate((b: HTMLElement) => b.click());
      await page.waitForTimeout(300);
    }
  });
  console.log(`screenshots in ${OUT}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

/**
 * T-0025 check (game feel): dist/cli.js with an isolated HOME (fake Claude
 * sessions, R-8) on a spare port, in headless Chromium WITH real scrollbars
 * (Playwright hides them by default, which would pass any scrollbar check).
 * Desktop 1280×800 and phone 393×852 (iPhone, DPR 3). The real claude
 * is never run.
 *
 * Desktop: no page scroll and no browser scrollbar (computed style + gutter,
 * with a probe proving the check catches one); a click on a character still
 * selects; left-drag pans (also from a character, without selecting it);
 * the wheel zooms about the cursor in whole steps (zoom and pan land in the
 * same task), Ctrl+wheel too and never zooms the page; WASD/arrows pan with
 * nothing focused and not while typing; +/-/0; double-click focuses and
 * follows; Esc stops following; edge-scroll is off by default, on from the
 * settings, and only in fullscreen; the canvas has no text selection or
 * context menu; Tab shows the pixel focus ring; ≤60 fps on a 120 Hz screen
 * and no frames while hidden. Phone: the same camera moves (touch drag,
 * pinch, wheel, keys), tap selects, no page scroll, no double-tap zoom.
 * Foreground (the coordinator's addition): a page hidden and shown again
 * tells the daemon (viewerVisibility) and, when its socket is closed or left
 * open but dead (frames dropped, as iOS does), reconnects at once and
 * re-requests the state without duplicates.
 * Screenshots go to cld/artifacts/t0025/.
 *
 *   npx tsx cld/test/run-game-feel.ts <port 18256-18259> [--only-select]
 *
 * --only-select stops after the click-selects check (the negative control).
 *
 * Known instability, fixed: the office's camera opens on a different part of the map from run to
 * run, and the character a select() aims at can sit under the elevator panel (a click at 58,364),
 * the 사무실 정보 window or a card. The click then goes to that element, not the canvas, and no
 * retry at the same point can change it ("a dblclick on theta selects and follows it" after 24 ok,
 * or "a click on alpha ..." after 1). select() now asks elementFromPoint and pans the character to
 * the middle first, like it already did for one out of view.
 * Seen once and NOT reproduced in about 45 runs (also not with the CPU loaded): "double-clicking the
 * already-selected character keeps it selected and followed" failing after 25 ok, on a run that
 * shared cores 6-11 with another runner. Its failure now says where it clicked, what was there and
 * what the camera and menu did, so the next occurrence classifies itself.
 */
import type { BrowserContextOptions, Page, WebSocketRoute } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const ONLY_SELECT = process.argv.includes('--only-select');
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0025');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
// Hangul from Malgun Gothic (read only), everything else the pixel font.
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0025/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
/** An iPhone's notch and home indicator, as T-0008's vars carry them. */
const SAFE_AREA = ':root { --cld-safe-top: 47px; --cld-safe-bottom: 34px; }';
const DESKTOP: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
};
const PHONE: BrowserContextOptions = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: devices['iPhone 13'].userAgent,
};

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
const near = (a: number, b: number, tol = 1.5) => Math.abs(a - b) <= tol;

async function until(what: string, fn: () => Promise<boolean>, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
}

interface Cam {
  /** Page CSS px of tile (0,0)'s centre (world point 8,8). */
  x: number;
  y: number;
  /** CSS px per world px (zoom / dpr). */
  scale: number;
  zoom: number;
  follow: number | null;
}
type Hooks = {
  getTileCenter: (c: number, r: number) => { x: number; y: number } | null;
  getCameraFollowId: () => number | null;
};

const cam = (page: Page): Promise<Cam> =>
  page.evaluate(() => {
    const h = (window as unknown as { __pixelAgentsTestHooks: Hooks }).__pixelAgentsTestHooks;
    const c = document.querySelector('[data-testid="office-canvas"]')!.getBoundingClientRect();
    const a = h.getTileCenter(0, 0)!;
    const b = h.getTileCenter(1, 0)!;
    const scale = (b.x - a.x) / 16;
    return {
      x: c.left + a.x,
      y: c.top + a.y,
      scale,
      zoom: Math.round(scale * devicePixelRatio * 1e6) / 1e6, // CSS px at DPR 3 are thirds
      follow: h.getCameraFollowId(),
    };
  });
/** The world point (sprite px) under page point p. */
const worldAt = (c: Cam, p: { x: number; y: number }) => ({
  x: 8 + (p.x - c.x) / c.scale,
  y: 8 + (p.y - c.y) / c.scale,
});

/** Every element that scrolls, or reserves a scrollbar gutter, must use the
 *  pixel bar (::-webkit-scrollbar 6px, or none) and no gutter wider than it. */
const scrollbarAudit = (page: Page) =>
  page.evaluate(() => {
    const bad: string[] = [];
    let scrollers = 0;
    for (const el of document.querySelectorAll('*')) {
      if (!(el instanceof HTMLElement)) continue;
      const cs = getComputedStyle(el);
      // Only a scroll container (overflow auto/scroll) can draw a scrollbar.
      if (!/auto|scroll/.test(cs.overflowX + cs.overflowY)) continue;
      const b = (s: string) => parseFloat(s) || 0;
      const gutterV =
        el.offsetWidth - el.clientWidth - b(cs.borderLeftWidth) - b(cs.borderRightWidth);
      const gutterH =
        el.offsetHeight - el.clientHeight - b(cs.borderTopWidth) - b(cs.borderBottomWidth);
      const scrolls =
        (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) ||
        (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth);
      if (!scrolls && gutterV <= 0 && gutterH <= 0) continue;
      scrollers++;
      const bar = getComputedStyle(el, '::-webkit-scrollbar');
      const pixel = bar.width === '6px' || bar.display === 'none' || cs.scrollbarWidth === 'none';
      if (!pixel || gutterV > 6 || gutterH > 6) {
        const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].slice(0, 3).join('.')}`;
        bad.push(`${name} (bar ${bar.width}, gutter ${gutterV}×${gutterH})`);
      }
    }
    return { scrollers, bad };
  });

const pageScroll = (page: Page) =>
  page.evaluate(() => ({
    scrolled:
      window.scrollX +
      window.scrollY +
      document.documentElement.scrollTop +
      document.body.scrollTop,
    overflow: Math.max(
      document.documentElement.scrollHeight - window.innerHeight,
      document.documentElement.scrollWidth - window.innerWidth,
    ),
  }));

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  // The 알림 list needs events to be told twice: two lines of the engine's event file.
  fs.mkdirSync(path.join(fake.home, '.config/cld-gui'), { recursive: true });
  fs.writeFileSync(
    path.join(fake.home, '.config/cld-gui/events.jsonl'),
    [
      { v: 1, ts: '2026-10-22T09:00:00+09:00', type: 'turn_end', source: 'engine', name: 'alpha' },
      { v: 1, ts: '2026-10-22T09:05:00+09:00', type: 'orch_start', source: 'engine', name: 'beta' },
    ]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join(''),
  );
  const received: Array<Record<string, unknown>> = [];
  const pageErrors: string[] = [];
  const font = fs.readFileSync(FONT);
  // Real scrollbars: without this every gutter is 0 and the audit proves nothing.
  const browser = await launchBrowser({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  const open = async (opts: BrowserContextOptions, init?: () => void) => {
    const ctx = await browser.newContext(opts);
    // T-0029: the 현황판 folds rooms and orchestrators; these checks press
    // buttons inside the cards, so a fresh profile starts with all open (모두 펼치기).
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('cld.status-tree'))
        localStorage.setItem('cld.status-tree', '{"rooms":true,"orchs":true}');
    });
    await ctx.route('**/__t0025/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    // Upstream's e2e flag: canvas geometry (getTileCenter) and the followed
    // character, nothing that drives the app. Plus a count of office frames.
    await ctx.addInitScript(() => {
      const w = window as unknown as {
        __PIXEL_AGENTS_E2E: boolean;
        __officeFrames: number;
        __name: (f: unknown) => unknown;
      };
      // tsx keeps function names with an __name() helper the page lacks.
      w.__name = (f) => f;
      w.__PIXEL_AGENTS_E2E = true;
      w.__officeFrames = 0;
      const clear = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function (x, y, cw, ch) {
        if (this.canvas.dataset?.testid === 'office-canvas' && x === 0 && y === 0) {
          w.__officeFrames++;
        }
        return clear.call(this, x, y, cw, ch);
      };
    });
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    page.on('websocket', (ws) =>
      ws.on('framereceived', (f) => {
        try {
          received.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
        } catch {
          /* binary */
        }
      }),
    );
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  /** Log in with a one-time code minted with the daemon's token (T-0022). */
  const login = async (page: Page) => {
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(BASE);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(1500); // spawn effects, characters reach their seats
  };
  const agentId = async (name: string) => {
    let id: number | undefined;
    await until(`${name}'s agent id`, async () => {
      const office = [...received].reverse().find((m) => m.type === 'officeSnapshot') as
        { orchestrators: Array<{ name: string; agentId: number | null }> } | undefined;
      id = office?.orchestrators.find((o) => o.name === name)?.agentId ?? undefined;
      return id !== undefined;
    });
    return id!;
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const menuOf = (page: Page, name: string) => page.getByRole('menu', { name: `${name} 메뉴` });
  /** Where to click a character: 12 world px over its feet (inside its hit box seated or not),
   *  from its own position. ACCEPT-4: not from its label: ACCEPT-3's seat puts a character near
   *  the top of the canvas, where the label is held down on screen (clampPlate) and the click
   *  landed under the hit box. */
  const charPoint = async (page: Page, id: number) => {
    const { x, y, scale } = await cam(page);
    const pos = await page.evaluate(
      (i) =>
        (
          window as unknown as {
            __pixelAgentsTestHooks: {
              getCharacterPosition: (i: number) => { x: number; y: number };
            };
          }
        ).__pixelAgentsTestHooks.getCharacterPosition(i),
      id,
    );
    return { x: x + (pos.x - 8) * scale, y: y + (pos.y - 8 - 12) * scale };
  };
  /** Click (or tap) a character until the office follows it (it walks). */
  const select = async (page: Page, name: string, how: 'click' | 'tap' | 'dblclick') => {
    const id = await agentId(name);
    for (let i = 0; i < 14; i++) {
      if ((await cam(page)).follow === id && (await menuOf(page, name).count()) === 1) return id;
      const p = await charPoint(page, id);
      // The office does not always open with the character in view: pan it in (a left-drag on
      // empty floor pans 1:1).
      const view = (await page.getByTestId('office-canvas').boundingBox())!;
      // Or out from under a HUD panel, window or card: the office's camera starts on a different
      // part of the map from run to run, and a character seated beneath the elevator panel or the
      // 사무실 정보 window is a click that never reaches the canvas (elementFromPoint says what
      // the browser would hit; dozens of retries at the same point cannot change that).
      const covered = await page.evaluate(
        ([x, y]) => !document.elementFromPoint(x, y)?.matches('[data-testid="office-canvas"]'),
        [p.x, p.y],
      );
      if (
        how !== 'tap' &&
        (covered ||
          p.x < view.x + 30 ||
          p.x > view.x + view.width - 30 ||
          p.y < view.y + 30 ||
          p.y > view.y + view.height - 30)
      ) {
        const clamp = (v: number) => Math.max(-150, Math.min(150, v));
        await drag(
          page,
          await emptySpot(page),
          clamp(view.x + view.width / 2 - p.x),
          clamp(view.y + view.height / 2 - p.y),
        );
        await page.waitForTimeout(300);
        continue;
      }
      if (how === 'tap') await page.touchscreen.tap(p.x, p.y);
      else if (how === 'dblclick') await page.mouse.dblclick(p.x, p.y);
      else await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(400);
    }
    throw new Error(`check failed: a ${how} on ${name} selects and follows it`);
  };
  /** A character whose click point is well inside the office canvas (a
   *  phone shows only part of the map). */
  const onScreen = async (page: Page) => {
    const office = [...received].reverse().find((m) => m.type === 'officeSnapshot') as {
      orchestrators: Array<{ name: string; agentId: number | null }>;
    };
    const box = (await page.getByTestId('office-canvas').boundingBox())!;
    const inside = (p: { x: number; y: number }) =>
      p.x > box.x + 30 &&
      p.x < box.x + box.width - 30 &&
      p.y > box.y + 30 &&
      p.y < box.y + box.height - 30;
    const look = async () => {
      for (const o of office.orchestrators) {
        if (o.agentId === null) continue;
        const label = page.locator(`[data-testid="agent-overlay"][data-agent-id="${o.agentId}"]`);
        if ((await label.count()) && inside(await charPoint(page, o.agentId))) return o.name;
      }
      return null;
    };
    const found = await look();
    if (found) return found;
    // The office opens on part of the map: a card brings its character to the middle.
    const first = office.orchestrators.find((o) => o.agentId !== null)!;
    await page
      .locator(`[data-testid="agent-card"][data-agent-id="${first.agentId}"]`)
      .first()
      .tap();
    await page.waitForTimeout(1_500);
    const after = await look();
    if (after) return after;
    throw new Error('no character on screen');
  };
  /** A point where the canvas itself is hit (no label or menu over it). */
  const canvasPoint = (page: Page) =>
    page.evaluate(() => {
      const c = document.querySelector('[data-testid="office-canvas"]')!;
      const r = c.getBoundingClientRect();
      for (const [fx, fy] of [
        [0.5, 0.5],
        [0.25, 0.5],
        [0.75, 0.5],
        [0.5, 0.25],
        [0.5, 0.75],
        [0.25, 0.25],
        [0.75, 0.75],
      ]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (document.elementFromPoint(x, y) === c) return { x, y };
      }
      return null;
    });
  /** A spot on the office with no character: the canvas's lower-left area. */
  const emptySpot = async (page: Page) => {
    const c = (await page.getByTestId('office-canvas').boundingBox())!;
    return { x: c.x + c.width * 0.12, y: c.y + c.height * 0.85 };
  };
  const drag = async (page: Page, from: { x: number; y: number }, dx: number, dy: number) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
    await page.mouse.up();
  };
  /** Hold a key with nothing focused; returns how far the map moved. */
  const holdKey = async (page: Page, key: string, ms: number) => {
    const before = await cam(page);
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
    await page.waitForTimeout(500); // eased stop
    const after = await cam(page);
    return { dx: after.x - before.x, dy: after.y - before.y };
  };
  const noFocus = (page: Page) =>
    page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      return document.activeElement === document.body;
    });
  /** Touch drag (one finger) or pinch (two) through CDP, in CSS px. */
  const touch = async (
    page: Page,
    fingers: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>,
  ) => {
    const cdp = await page.context().newCDPSession(page);
    const at = (t: number) =>
      fingers.map((f, id) => ({
        x: f.from.x + (f.to.x - f.from.x) * t,
        y: f.from.y + (f.to.y - f.from.y) * t,
        id,
      }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(i / 12) });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  };

  const daemon = startDaemon(fake, port, ['--no-terminal']);
  try {
    // ════ Desktop 1280×800 ════
    const { ctx: desk, page } = await open(DESKTOP);
    await login(page);
    await openOfficeWindow(page); // T-0108: a desktop starts with icons only
    const home = await cam(page);
    check(
      Number.isInteger(home.zoom) && home.follow === null,
      `desktop: the office opens at integer zoom ${home.zoom}, following nobody`,
    );

    // A click on a character still selects (the negative control breaks this).
    const alpha = await select(page, 'alpha', 'click');
    check(true, `desktop: a click on alpha (agent ${alpha}) selects it and the camera follows`);
    if (ONLY_SELECT) return;
    await page.waitForTimeout(1200); // the follow settles
    await shot(page, 'desktop-office');

    // No page scroll, no browser scrollbar.
    let scroll = await pageScroll(page);
    check(
      scroll.scrolled === 0 && scroll.overflow <= 0,
      'desktop: the page itself neither scrolls nor overflows',
    );
    const audit = await scrollbarAudit(page);
    check(
      audit.scrollers > 0 && audit.bad.length === 0,
      `desktop: ${audit.scrollers} scroll area(s), every one with the 6 px pixel bar and no browser scrollbar${audit.bad.length ? `: ${audit.bad.join(', ')}` : ''}`,
    );
    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.id = 't25-probe';
      probe.style.cssText =
        'position:fixed;left:0;bottom:0;width:80px;height:40px;overflow:auto;scrollbar-color:red blue';
      probe.innerHTML = '<div style="height:200px"></div>';
      document.body.append(probe);
    });
    const probed = await scrollbarAudit(page);
    await page.evaluate(() => document.getElementById('t25-probe')?.remove());
    check(
      probed.bad.length === 1 && probed.bad[0].startsWith('div#t25-probe'),
      `desktop: the audit does catch a browser scrollbar (probe: ${probed.bad.join(', ')})`,
    );
    // The office drawer's list scrolls with the wheel and shows the pixel bar.
    const drawer = page.getByRole('complementary', { name: '사무실 정보' });
    const list = drawer.locator('.overflow-y-auto');
    const listBox = (await list.boundingBox())!;
    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(300);
    const listTop = await list.evaluate((el) => el.scrollTop);
    scroll = await pageScroll(page);
    check(
      listTop > 0 && scroll.scrolled === 0,
      `desktop: the wheel over the office list scrolls the list (${listTop} px), not the page`,
    );
    await shot(page, 'desktop-office-scrollbar');

    // Left-drag on empty floor pans 1:1 and breaks the follow; no selection change.
    let c0 = await cam(page);
    await drag(page, await emptySpot(page), 150, -90);
    let c1 = await cam(page);
    check(
      near(c1.x - c0.x, 150) && near(c1.y - c0.y, -90) && c1.follow === null,
      `desktop: left-drag pans the map with the cursor (${(c1.x - c0.x).toFixed(1)}, ${(c1.y - c0.y).toFixed(1)}) and stops the follow`,
    );
    check(
      (await menuOf(page, 'alpha').count()) === 1,
      'desktop: the drag left the selection alone',
    );
    // A drag that starts on a character is that character's (T-0015 moves an
    // editable orchestrator; this office is read-only): no pan, no selection.
    const beta = await agentId('beta');
    const bp = await charPoint(page, beta);
    c0 = await cam(page);
    await drag(page, bp, -120, 40);
    c1 = await cam(page);
    check(
      c1.x === c0.x && c1.y === c0.y && (await menuOf(page, 'beta').count()) === 0,
      'desktop: a drag that starts on a character does not pan and does not select it',
    );

    // The wheel zooms about the cursor in whole steps.
    const spot = await emptySpot(page);
    const p = { x: spot.x + 300, y: spot.y - 250 };
    await page.mouse.move(p.x, p.y);
    c0 = await cam(page);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(200);
    c1 = await cam(page);
    let w0 = worldAt(c0, p);
    let w1 = worldAt(c1, p);
    check(
      c1.zoom === c0.zoom + 1 &&
        Number.isInteger(c1.zoom) &&
        near(w0.x, w1.x, 1) &&
        near(w0.y, w1.y, 1),
      `desktop: wheel up zooms ${c0.zoom} → ${c1.zoom} about the cursor (world point (${w0.x.toFixed(1)}, ${w0.y.toFixed(1)}) stays under it: (${w1.x.toFixed(1)}, ${w1.y.toFixed(1)}))`,
    );
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(200);
    check((await cam(page)).zoom === c0.zoom, 'desktop: wheel down zooms back out one step');
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await page.waitForTimeout(200);
    check(
      (await cam(page)).zoom === c0.zoom + 1,
      'desktop: Ctrl+wheel (a pinch) zooms the same way',
    );
    // Zoom and pan commit together: right after the event, in the same task,
    // the projection already has the new zoom with the pan made for it.
    const sameTask = await page.evaluate(
      ({ x, y }) => {
        const h = (window as unknown as { __pixelAgentsTestHooks: Hooks }).__pixelAgentsTestHooks;
        const canvas = document.querySelector('[data-testid="office-canvas"]')!;
        const r = canvas.getBoundingClientRect();
        const world = () => {
          const a = h.getTileCenter(0, 0)!;
          const b = h.getTileCenter(1, 0)!;
          const s = (b.x - a.x) / 16;
          return { s, x: 8 + (x - r.left - a.x) / s, y: 8 + (y - r.top - a.y) / s };
        };
        const before = world();
        canvas.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: -100,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
        return { before, after: world() };
      },
      { x: p.x, y: p.y },
    );
    check(
      sameTask.after.s > sameTask.before.s &&
        near(sameTask.after.x, sameTask.before.x, 1) &&
        near(sameTask.after.y, sameTask.before.y, 1),
      'desktop: zoom and its pan land in the same task (no frame draws one without the other)',
    );
    const prevented = await page.evaluate(() => {
      const bar = document.querySelector('[aria-pressed]')!.closest('.pixel-panel')!;
      const fire = (ctrlKey: boolean) =>
        !bar.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -100, ctrlKey, bubbles: true, cancelable: true }),
        );
      return { ctrl: fire(true), plain: fire(false) };
    });
    check(
      prevented.ctrl && !prevented.plain,
      'desktop: Ctrl+wheel over the HUD never zooms the page; a plain wheel there still scrolls',
    );
    await shot(page, 'desktop-zoomed');

    // Keys with nothing focused: WASD / arrows pan (eased), +/- zoom, 0 resets.
    check(await noFocus(page), 'desktop: nothing focused (keys go to the body)');
    // T-0048: WASD and the arrows walk the selected character; with nobody selected they pan.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    let moved = await holdKey(page, 'd', 500);
    check(
      moved.dx < -100 && near(moved.dy, 0),
      `desktop: holding D pans right (map moved ${moved.dx.toFixed(0)} px)`,
    );
    const settled = await cam(page);
    await page.waitForTimeout(300);
    check(
      (await cam(page)).x === settled.x,
      'desktop: the camera eases to a stop after the key is let go',
    );
    moved = await holdKey(page, 'ArrowUp', 400);
    check(
      moved.dy > 80 && near(moved.dx, 0),
      `desktop: holding ↑ pans up (${moved.dy.toFixed(0)} px)`,
    );
    moved = await holdKey(page, 'a', 300);
    check(moved.dx > 50, `desktop: A pans left (${moved.dx.toFixed(0)} px)`);
    moved = await holdKey(page, 's', 300);
    check(moved.dy < -50, `desktop: S pans down (${moved.dy.toFixed(0)} px)`);
    c0 = await cam(page);
    await page.keyboard.press('Equal');
    await page.waitForTimeout(150);
    check((await cam(page)).zoom === c0.zoom + 1, 'desktop: + zooms in one step');
    await page.keyboard.press('Minus');
    await page.keyboard.press('Minus');
    await page.waitForTimeout(150);
    check((await cam(page)).zoom === c0.zoom - 1, 'desktop: - zooms out one step at a time');
    await page.keyboard.press('Digit0');
    await page.waitForTimeout(150);
    c1 = await cam(page);
    check(
      c1.zoom === home.zoom && near(c1.x, home.x, 1) && near(c1.y, home.y, 1),
      'desktop: 0 resets zoom and pan to how the office opened',
    );
    // Typing is never a camera key.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 't25-input';
      input.style.cssText = 'position:fixed;left:8px;bottom:8px';
      document.body.append(input);
      input.focus();
    });
    moved = await holdKey(page, 'd', 300);
    const typed = await page.evaluate(() => {
      const input = document.getElementById('t25-input') as HTMLInputElement;
      const value = input.value;
      input.remove();
      return value;
    });
    check(
      moved.dx === 0 && moved.dy === 0 && typed.length > 0,
      `desktop: D typed into a text field ("${typed.slice(0, 6)}…") does not pan`,
    );

    // Double-click focuses and follows, even on the selected character; Esc stops following.
    const theta = await select(page, 'theta', 'dblclick');
    check(true, `desktop: double-click on theta (agent ${theta}) focuses and follows it`);
    const gp = await charPoint(page, theta);
    const gpHit = await page.evaluate(
      ([x, y]) => {
        const e = document.elementFromPoint(x, y);
        return e ? `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)}` : 'nothing';
      },
      [gp.x, gp.y],
    );
    const gc0 = await cam(page);
    await page.mouse.dblclick(gp.x, gp.y);
    await page.waitForTimeout(400);
    const gc1 = await cam(page);
    const gMenus = await menuOf(page, 'theta').count();
    if (gc1.follow !== theta || gMenus !== 1) await shot(page, 'game-feel-second-dblclick-failed');
    if (gc1.follow !== theta || gMenus !== 1)
      throw new Error(
        'check failed: desktop: double-clicking the already-selected character keeps it selected ' +
          `and followed (clicked ${gp.x.toFixed(0)},${gp.y.toFixed(0)} on ${gpHit}; ` +
          `camera ${gc0.x.toFixed(1)},${gc0.y.toFixed(1)} follow ${gc0.follow} -> ` +
          `${gc1.x.toFixed(1)},${gc1.y.toFixed(1)} follow ${gc1.follow}; ${gMenus} menus)`,
      );
    check(
      true,
      'desktop: double-clicking the already-selected character keeps it selected and followed',
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    c0 = await cam(page);
    await page.waitForTimeout(400);
    c1 = await cam(page);
    check(
      c1.follow === null && c1.x === c0.x && c1.y === c0.y,
      'desktop: Esc stops following (the camera stays put)',
    );

    // The canvas: no text selection, no context menu, nothing to drag out.
    const canvasRules = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]')!;
      const menu = !canvas.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      return {
        select: getComputedStyle(canvas).userSelect,
        menu,
        draggable: canvas.draggable,
        touch: getComputedStyle(canvas).touchAction,
      };
    });
    check(
      canvasRules.select === 'none' && canvasRules.menu && !canvasRules.draggable,
      `desktop: the canvas has no text selection (${canvasRules.select}), no context menu and is not draggable`,
    );
    c0 = await cam(page);
    await drag(page, await emptySpot(page), 60, 0);
    const selection = await page.evaluate(() => String(window.getSelection() ?? ''));
    // A drag leaves a collapsed-looking range between two labels ("\n"): no text in it is what counts.
    check(selection.trim() === '', 'desktop: a drag across the office selects no text');

    // Edge-scroll: off by default, on from the settings, in fullscreen only.
    const screenIsWindow = await page.evaluate(
      () => screen.width === innerWidth && screen.height === innerHeight,
    );
    check(screenIsWindow, 'desktop: the test window fills its screen (counts as fullscreen)');
    await page.mouse.move(640, 400);
    c0 = await cam(page);
    await page.mouse.move(1279, 400);
    await page.waitForTimeout(600);
    c1 = await cam(page);
    check(c1.x === c0.x && c1.y === c0.y, 'desktop: edge-scroll is off by default');
    await page.mouse.move(640, 400);
    await page.getByRole('button', { name: '설정' }).click();
    // SETTINGS-TABS: the edge-scroll row is in the 화면 tab.
    await page.getByRole('tab', { name: '화면', exact: true }).click();
    const toggle = page.getByRole('button', { name: '가장자리 스크롤' });
    check((await toggle.getAttribute('aria-pressed')) === 'false', 'desktop: settings show it off');
    await toggle.click();
    check(
      (await toggle.getAttribute('aria-pressed')) === 'true',
      'desktop: the toggle turns it on',
    );
    await shot(page, 'desktop-settings');
    await page.getByRole('button', { name: 'x', exact: true }).click();
    c0 = await cam(page);
    await page.mouse.move(1279, 400);
    await page.waitForTimeout(600);
    c1 = await cam(page);
    await page.mouse.move(640, 400);
    await page.waitForTimeout(500);
    const c2 = await cam(page);
    await page.waitForTimeout(300);
    const c3 = await cam(page);
    check(
      c1.x < c0.x - 50 && near(c1.y, c0.y) && c3.x === c2.x,
      `desktop: at the right edge the camera scrolls right (${(c1.x - c0.x).toFixed(0)} px) and stops off the edge`,
    );
    await page.mouse.move(640, 0);
    c0 = await cam(page);
    await page.waitForTimeout(400);
    c1 = await cam(page);
    await page.mouse.move(640, 400);
    check(c1.y > c0.y + 30, `desktop: the top edge scrolls up (${(c1.y - c0.y).toFixed(0)} px)`);

    // Tab focus is a visible pixel ring.
    await noFocus(page);
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName,
        label: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 12),
        style: cs.outlineStyle,
        width: cs.outlineWidth,
        color: cs.outlineColor,
      };
    });
    check(
      // c25fbfb3: the accent got more contrast (--color-accent-bright #6b5cff).
      ring.style === 'solid' && ring.width === '2px' && ring.color === 'rgb(107, 92, 255)',
      `desktop: Tab focus (${ring.tag} "${ring.label}") shows the 2 px square accent ring (${ring.style} ${ring.width} ${ring.color})`,
    );
    await shot(page, 'desktop-focus-ring');
    scroll = await pageScroll(page);
    check(scroll.scrolled === 0, 'desktop: after all of it the page has not scrolled');
    await desk.close();

    // Not fullscreen (the screen is bigger than the window): no edge-scroll even when on.
    const { ctx: windowed, page: wpage } = await open(
      { ...DESKTOP, screen: { width: 1920, height: 1080 } },
      () => localStorage.setItem('cld.edge-scroll', 'on'),
    );
    await login(wpage);
    await openOfficeWindow(wpage); // T-0108: a desktop starts with icons only
    await wpage.mouse.move(640, 400);
    c0 = await cam(wpage);
    await wpage.mouse.move(1279, 400);
    await wpage.waitForTimeout(600);
    c1 = await cam(wpage);
    check(c1.x === c0.x, 'desktop, windowed: edge-scroll stays still outside fullscreen');
    await windowed.close();

    // Frame pacing: a fast screen (rAF emulated at 240 Hz, one stamp per frame for
    // every callback; software rendering delivers well under that) still gets ≤60 office
    // frames a second, and none hidden. The office is kept awake with pointer moves on
    // it: an idle one draws at OFFICE_IDLE_FPS (T-0075, run-overlay-cost.ts).
    const { ctx: fast, page: fpage } = await open(DESKTOP, () => {
      const queue: Array<[number, FrameRequestCallback]> = [];
      const cancelled = new Set<number>();
      let id = 0;
      const w = window as unknown as { __vsyncs: number };
      w.__vsyncs = 0;
      setInterval(() => {
        w.__vsyncs++;
        const t = performance.now();
        for (const [i, cb] of queue.splice(0)) if (!cancelled.has(i)) cb(t);
      }, 1000 / 240);
      window.requestAnimationFrame = (cb) => {
        queue.push([++id, cb]);
        return id;
      };
      window.cancelAnimationFrame = (i) => void cancelled.add(i);
    });
    await login(fpage);
    await openOfficeWindow(fpage); // T-0108: a desktop starts with icons only
    const rate = () =>
      fpage.evaluate(async () => {
        const w = window as unknown as { __officeFrames: number; __vsyncs: number };
        const [f0, v0] = [w.__officeFrames, w.__vsyncs];
        const canvas = document.querySelector('[data-testid="office-canvas"]')!;
        const awake = setInterval(
          () => canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })),
          100,
        );
        await new Promise((r) => setTimeout(r, 2000));
        clearInterval(awake);
        return { frames: (w.__officeFrames - f0) / 2, vsyncs: (w.__vsyncs - v0) / 2 };
      });
    // Under load the emulated timer runs slow: sample again (up to 5 times) for a clean 90+,
    // and in any case demand a rAF clearly above 60 so the cap is what holds the frames down.
    let visible = await rate();
    for (let i = 0; i < 4 && visible.vsyncs <= 90; i++) visible = await rate();
    check(
      visible.vsyncs > 70 && visible.frames <= 61 && visible.frames >= 40,
      `pacing: ${visible.frames} office frames/s on a ${visible.vsyncs}/s rAF (fast rAF emulated)`,
    );
    await fpage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hidden = await rate();
    await fpage.evaluate(() => {
      delete (document as unknown as { hidden?: boolean }).hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const back = await rate();
    check(
      hidden.frames === 0 && back.frames >= 40,
      `pacing: hidden → ${hidden.frames} office frames/s; shown again → ${back.frames}/s`,
    );
    await fast.close();

    // ════ Back in the foreground (iOS drops a background app's network) ════
    // Every /ws goes through a route that can play dead: frames dropped both
    // ways while the page still sees an OPEN socket.
    const { ctx: fg, page: fpg } = await open(DESKTOP);
    const routes: WebSocketRoute[] = [];
    const dead = new Set<WebSocketRoute>();
    const frames: string[] = [];
    await fpg.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      routes.push(ws);
      ws.onMessage((m) => {
        frames.push(String(m));
        if (!dead.has(ws)) server.send(m);
      });
      server.onMessage((m) => {
        if (!dead.has(ws)) ws.send(m);
      });
    });
    await login(fpg);
    await openOfficeWindow(fpg); // T-0108: a desktop starts with icons only
    const logFrom = daemon.log.join('').length;
    const newLog = () => daemon.log.join('').slice(logFrom);
    const setPage = (hidden: boolean) =>
      fpg.evaluate((h) => {
        if (h) Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        else delete (document as unknown as { hidden?: boolean }).hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);
    const sent = (type: string) => frames.filter((f) => f.includes(`"type":"${type}"`));
    const characters = () => fpg.locator('[data-testid="agent-overlay"]').count();
    const drawerFg = fpg.getByRole('complementary', { name: '사무실 정보' });
    // T-0070: the feed's events are lines of the 알림 list (the bell's page).
    const feedItems = async () => {
      await fpg.getByTestId('notice-bell').click();
      const n = await fpg.locator('[data-testid="notice-list"] > li').count();
      await fpg.getByRole('button', { name: '알림 닫기' }).click();
      return n;
    };
    const before = { characters: await characters(), feed: await feedItems() };
    check(
      routes.length === 1 && sent('viewerVisibility').length === 1,
      'foreground: a new socket says it is visible (counted from the first frame)',
    );
    await setPage(true);
    await until('the daemon hears the page went away', async () =>
      newLog().includes('[cld] viewer hidden (0 watching)'),
    );
    check(true, 'foreground: hidden → the daemon counts 0 watching and sleeps');
    for (const r of routes) dead.add(r); // the network goes, the socket stays "open"
    await fpg.waitForTimeout(500);
    let t0 = Date.now();
    await setPage(false);
    await until('a new socket after the silent one', async () => routes.length === 2, 10_000);
    const replaced = Date.now() - t0;
    await until('the new socket re-requests the state', async () =>
      newLog().includes('[cld] viewer connected (1 watching)'),
    );
    await fpg.waitForTimeout(1500); // the resync settles
    const after = { characters: await characters(), feed: await feedItems() };
    check(
      replaced >= 2500 && replaced < 6000 && sent('webviewReady').length === 2,
      `foreground: an open but dead socket is replaced after ${replaced} ms of silence (heartbeat 3 s) and the new one re-sends webviewReady`,
    );
    check(
      after.characters === before.characters && after.feed === before.feed && before.feed > 0,
      `foreground: the resync leaves ${after.characters} characters and ${after.feed} feed items, no duplicates`,
    );
    // Closed while hidden: no timers meanwhile, and at once when shown.
    await setPage(true);
    await routes[1].close();
    await fpg.waitForTimeout(5000);
    check(
      routes.length === 2,
      'foreground: a socket closed while hidden is not retried while hidden',
    );
    t0 = Date.now();
    await setPage(false);
    await until('reconnect at once', async () => routes.length === 3, 5_000);
    const atOnce = Date.now() - t0;
    check(
      atOnce < 1000,
      `foreground: shown again it reconnects at once (${atOnce} ms, no backoff)`,
    );
    await until(
      'the daemon counts it',
      async () =>
        (newLog().match(/\[cld\] viewer (connected|back) \(1 watching\)/g) ?? []).length >= 2,
    );
    check(
      (await fpg.evaluate(
        () => document.querySelectorAll('[data-testid="agent-overlay"]').length,
      )) === before.characters,
      'foreground: the office is whole after the second reconnect',
    );
    await fg.close();

    // ════ Phone 393×852 (iPhone, DPR 3) ════
    const { page: phone } = await open(PHONE);
    await login(phone);
    const ph = await cam(phone);
    const html = await phone.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        touch: cs.touchAction,
        tap: cs.getPropertyValue('-webkit-tap-highlight-color'),
        gear: !!document.querySelector('[aria-label="설정"]')?.getClientRects().length,
      };
    });
    // T-0041: the settings button is on the phone too (office hours); only the mouse-only
    // edge-scroll row is left out of it.
    await phone.getByRole('button', { name: '설정', exact: true }).first().tap();
    await phone.getByRole('tab', { name: '화면', exact: true }).tap(); // SETTINGS-TABS: where the row would be
    const edgeRow = await phone.getByText('가장자리 스크롤').isVisible();
    await phone.getByRole('button', { name: 'x', exact: true }).last().tap();
    check(
      html.touch === 'manipulation' && html.tap === 'rgba(0, 0, 0, 0)' && html.gear && !edgeRow,
      `phone: no double-tap zoom (touch-action ${html.touch}), no tap flash, settings without the mouse-only edge-scroll (${edgeRow})`,
    );
    const tapped = await onScreen(phone);
    await select(phone, tapped, 'tap');
    check(true, `phone: a tap on ${tapped} selects it and the camera follows`);
    await phone.waitForTimeout(1200);
    await shot(phone, 'phone-office');
    const canvasBox = (await phone.getByTestId('office-canvas').boundingBox())!;
    const mid = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };
    c0 = await cam(phone);
    await touch(phone, [{ from: mid, to: { x: mid.x - 100, y: mid.y + 60 } }]);
    c1 = await cam(phone);
    check(
      near(c1.x - c0.x, -100, 3) && near(c1.y - c0.y, 60, 3) && c1.follow === null,
      `phone: a one-finger drag pans (${(c1.x - c0.x).toFixed(0)}, ${(c1.y - c0.y).toFixed(0)})`,
    );
    c0 = await cam(phone);
    await touch(phone, [
      { from: { x: mid.x - 30, y: mid.y }, to: { x: mid.x - 120, y: mid.y } },
      { from: { x: mid.x + 30, y: mid.y }, to: { x: mid.x + 120, y: mid.y } },
    ]);
    c1 = await cam(phone);
    check(
      c1.zoom > c0.zoom && Number.isInteger(c1.zoom),
      `phone: pinch zooms ${c0.zoom} → ${c1.zoom}`,
    );
    c0 = await cam(phone);
    const free = (await canvasPoint(phone))!; // not under the character's menu
    await phone.mouse.move(free.x, free.y);
    // Mobile emulation reports a notch as 100 / DPR = 33 CSS px; the zoom
    // step needs 50 (a desktop notch is 100), so two notches make one step.
    await phone.mouse.wheel(0, 100);
    await phone.mouse.wheel(0, 100);
    await phone.waitForTimeout(200);
    c1 = await cam(phone);
    check(c1.zoom === c0.zoom - 1, `phone: the wheel zooms too (${c0.zoom} → ${c1.zoom})`);
    await noFocus(phone);
    await phone.keyboard.press('Escape'); // T-0048: with a character selected the arrows walk it
    await phone.waitForTimeout(200);
    moved = await holdKey(phone, 'ArrowLeft', 400);
    check(moved.dx > 50, `phone: a keyboard's ← pans (${moved.dx.toFixed(0)} px)`);
    // Swipes on the HUD never scroll the page.
    const topBar = (await phone.getByTestId('mobile-top-bar').boundingBox())!;
    await touch(phone, [{ from: { x: 60, y: topBar.y + 10 }, to: { x: 60, y: topBar.y + 300 } }]);
    await phone
      .locator('[data-hud-id^="icon:"]')
      .getByRole('button', { name: '현황판', exact: true })
      .click(); // a tap right after the CDP swipe above is swallowed; the click is the same handler
    const phoneList = phone.locator('[aria-label="현황판 화면"] .overflow-y-auto');
    await phoneList.waitFor();
    const lb = (await phoneList.boundingBox())!;
    await touch(phone, [
      {
        from: { x: lb.x + lb.width / 2, y: lb.y + lb.height - 40 },
        to: { x: lb.x + lb.width / 2, y: lb.y + 60 },
      },
    ]);
    await phone.waitForTimeout(400);
    scroll = await pageScroll(phone);
    const phoneAudit = await scrollbarAudit(phone);
    check(
      scroll.scrolled === 0 && scroll.overflow <= 0,
      'phone: swipes on the top bar and the office list never scroll the page',
    );
    check(
      phoneAudit.scrollers > 0 && phoneAudit.bad.length === 0,
      `phone: ${phoneAudit.scrollers} scroll area(s), all with the pixel bar${phoneAudit.bad.length ? `: ${phoneAudit.bad.join(', ')}` : ''}`,
    );
    await shot(phone, 'phone-office');
    await phone.getByRole('button', { name: '사무실' }).first().tap();
    await phone.addStyleTag({ content: SAFE_AREA });
    await phone.waitForTimeout(300);
    // 10-24: the phone's top bar keeps only the floor and 설정, padded safe-top + 4 px.
    const pad = await phone.evaluate(() =>
      parseFloat(
        getComputedStyle(document.querySelector('[data-testid="mobile-top-bar"]')!).paddingTop,
      ),
    );
    check(pad === 51, `phone: the top bar still clears the notch (--cld-safe-top: ${pad} px)`);
    await shot(phone, 'phone-safe-area');
    check(ph.zoom >= 1, `phone: opened at integer zoom ${ph.zoom}`);
    check(
      pageErrors.length === 0,
      `no page errors${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`,
    );
  } finally {
    await browser.close();
    await daemon.stop();
    fs.rmSync(fake.home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  },
);

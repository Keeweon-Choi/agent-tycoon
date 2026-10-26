/**
 * TOPBAR-CARDS check: the host clock in the exact centre of the top bar and large (desktop 1280
 * and 1920, phone 393), the usage bar's refresh icon (busy while checking), the desktop card
 * container (bigger text, same face, a drag moves a card to another slot and the order survives a
 * reload, a drag does not select, + opens 오케스트레이터 추가) and the phone's card bar as before.
 *
 * dist/cli.js with --engine on --allow-actions --no-terminal in a temp HOME whose `claude` is the
 * engine fake, a fake claude-dashboard usage script, on a spare port; headless Chromium
 * (--disable-gpu). Screenshots: cld/artifacts/topbar-cards/.
 *
 *   npx tsx cld/test/run-topbar-cards.ts <port 18256-18259>
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
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/topbar-cards');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__bx/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__bx/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const DEADLINE_MS = 280_000;
const LEADS = ['alpha', 'beta', 'gamma'];
const IPHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 } };
})();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long the page holds the server's reply to the usage check, to see the busy state. */
const HOLD_MS = 2_000;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

type Box = { x: number; y: number; w: number; h: number };

/** The bar's clock against the bar: its centre, its size, and every other thing in the bar. */
async function clockReport(page: Page, barSelector: string) {
  return page.evaluate((sel) => {
    const bar = document.querySelector<HTMLElement>(sel)!;
    const clock = bar.querySelector<HTMLElement>('[data-testid="host-clock"]')!;
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const c = rect(clock);
    const b = rect(bar);
    const hits: string[] = [];
    for (const el of bar.querySelectorAll<HTMLElement>('*')) {
      if (clock.contains(el) || el.contains(clock)) continue;
      const leaf =
        el.matches('button, svg, canvas') || (!el.children.length && el.textContent?.trim());
      if (!leaf) continue;
      const r = rect(el);
      if (r.w === 0 || r.h === 0) continue;
      const apart =
        r.x + r.w <= c.x + 0.5 ||
        c.x + c.w <= r.x + 0.5 ||
        r.y + r.h <= c.y + 0.5 ||
        c.y + c.h <= r.y + 0.5;
      if (!apart)
        hits.push(
          `${el.tagName.toLowerCase()} ${el.getAttribute('aria-label') ?? el.textContent?.slice(0, 12)}`,
        );
    }
    return {
      clock: c,
      bar: b,
      viewportW: window.innerWidth,
      fontPx: parseFloat(getComputedStyle(clock).fontSize),
      text: clock.innerText,
      hits,
      scrollX: document.documentElement.scrollWidth > window.innerWidth,
    };
  }, barSelector);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.writeFileSync(
    path.join(configDirectory(home), 'config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
  const folders = Object.fromEntries(LEADS.map((n) => [n, path.join(home, 'work', n)]));
  for (const f of Object.values(folders)) fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      LEADS.map((name) => ({ name, folder: folders[name], room: '개발실', wantRunning: true })),
    ),
  );
  // The claude-dashboard plugin: the usage strip (with the refresh icon) needs a reading.
  const plugin = path.join(
    home,
    '.claude/plugins/cache/claude-dashboard/claude-dashboard/9.9.9/dist/check-usage.js',
  );
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.writeFileSync(
    plugin,
    `const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
console.log(JSON.stringify({
  claude: { fiveHourPercent: 42, sevenDayPercent: 16, fiveHourReset: at(2), sevenDayReset: at(60) },
  codex: { fiveHourPercent: 35, sevenDayPercent: 6, fiveHourReset: at(3), sevenDayReset: at(100) },
}));\n`,
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--no-terminal', '--allow-actions'],
    { FAKE_TURN_MS: '600' },
  );
  const serverLog = daemon.log;
  const cleanup = () => {
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}\n${serverLog.join('').slice(-1500)}`);
    if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
    cleanup();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const sent: string[] = [];
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
    // The usage check's reply is held back, so the busy state can be seen.
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        if (String(m).includes('codexUsageCheck')) sent.push(String(m));
        server.send(m);
      });
      server.onMessage((m) => {
        if (String(m).includes('codexUsageCheckResult')) setTimeout(() => ws.send(m), HOLD_MS);
        else ws.send(m);
      });
    });
    return { ctx, page };
  };
  const ready = async (page: Page, url: string) => {
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const cardNames = (page: Page) =>
    page.locator('[data-testid="card-container"] [data-testid="card-name"]').allInnerTexts();
  const box = async (loc: ReturnType<Page['locator']>): Promise<Box> => {
    const b = (await loc.boundingBox())!;
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  };

  try {
    const loginUrl = await daemon.loginUrl();
    const { ctx: deskCtx, page: desk } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await ready(desk, loginUrl);
    await desk.locator('[data-testid="agent-card"]').first().waitFor({ timeout: 60_000 });
    await desk.waitForFunction(
      (n) =>
        document.querySelectorAll('[data-testid="card-container"] [data-testid="agent-card"]')
          .length >= n,
      LEADS.length,
      { timeout: 60_000 },
    );
    await desk.waitForTimeout(2_000);
    // The first-run notice would cover the office in every shot.
    const notice = desk.getByRole('button', { name: '계속 물어보기' });
    if (await notice.count()) await notice.click();

    // ── 1. the clock, desktop 1280 and 1920 ──
    for (const width of [1280, 1920]) {
      await desk.setViewportSize({ width, height: width === 1280 ? 800 : 1000 });
      await desk.waitForTimeout(600);
      const r = await clockReport(desk, '[data-hud-id="usage"]');
      const centre = r.clock.x + r.clock.w / 2;
      check(
        Math.abs(centre - r.viewportW / 2) <= 1.5 &&
          Math.abs(r.bar.x + r.bar.w / 2 - r.viewportW / 2) <= 1.5,
        `desktop ${width}: the clock's centre ${centre.toFixed(1)} is the bar's and the window's centre ${r.viewportW / 2}`,
      );
      check(r.fontPx >= 30, `desktop ${width}: the clock is large (${r.fontPx}px, "${r.text}")`);
      check(
        r.hits.length === 0,
        `desktop ${width}: nothing in the bar overlaps the clock${r.hits.length ? ` (${r.hits.join(', ')})` : ''}`,
      );
      check(!r.scrollX, `desktop ${width}: no sideways page scroll`);
      check(
        r.clock.h <= r.bar.h,
        `desktop ${width}: the clock (${r.clock.h}px) fits the bar (${r.bar.h}px)`,
      );
      await shot(desk, `desktop-${width}`);
    }
    await desk.setViewportSize({ width: 1280, height: 800 });
    await desk.waitForTimeout(600);

    // ── 2. the refresh icon ──
    const refresh = desk.getByTestId('usage-refresh');
    await refresh.waitFor();
    check(
      (await refresh.innerText()).trim() === '' &&
        (await refresh.getAttribute('aria-label')) === '지금 확인' &&
        (await refresh.getAttribute('title'))?.includes('Codex'),
      'refresh: an icon with no text, the accessible label 지금 확인 and the old tooltip',
    );
    await shot(desk, 'desktop-refresh-idle');
    await refresh.click();
    await desk.waitForFunction(
      () =>
        document.querySelector('[data-testid="usage-refresh"]')?.getAttribute('aria-busy') ===
        'true',
    );
    check(
      (await refresh.isDisabled()) && (await refresh.getAttribute('aria-label')) === '확인 중…',
      'refresh: busy while checking (disabled, aria-busy, spinning, label 확인 중…)',
    );
    await shot(desk, 'desktop-refresh-busy');
    await desk.waitForFunction(
      () =>
        document.querySelector('[data-testid="usage-refresh"]')?.getAttribute('aria-busy') ===
        'false',
      undefined,
      { timeout: 20_000 },
    );
    check(
      sent.some((m) => m.includes('"codexUsageCheck"')),
      'refresh: the click sent codexUsageCheck',
    );

    // ── 3. the card container: text, face, one container ──
    const container = desk.getByTestId('card-container');
    check((await container.count()) === 1, 'cards: one container');
    check(
      (await container.getByTestId('card-group').first().innerText()) === '오케스트레이터',
      'cards: the 오케스트레이터 tag is inside the container',
    );
    const names = await cardNames(desk);
    check(
      LEADS.every((n) => names.includes(n)) && names.length === LEADS.length,
      `cards: ${names.join(', ')} in the container`,
    );
    const fonts2 = await desk.evaluate(() => {
      const px = (sel: string) => {
        const el = document.querySelector<HTMLElement>(sel);
        return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
      };
      return {
        name: px('[data-testid="card-container"] [data-testid="card-name"]'),
        tag: px('[data-testid="card-group"]'),
        face: (() => {
          const c = document.querySelector<HTMLCanvasElement>('[data-testid="agent-card"] canvas');
          const r = c?.getBoundingClientRect();
          return r ? [r.width, r.height] : [];
        })(),
      };
    });
    check(
      fonts2.name >= 14 && fonts2.tag >= 14,
      `cards: name ${fonts2.name}px and tag ${fonts2.tag}px (were 10 and 9)`,
    );
    check(
      fonts2.face[0] === 40 && fonts2.face[1] === 40,
      `cards: the face is still ${fonts2.face.join('x')}`,
    );
    const slotsBefore = await Promise.all(
      (await desk.locator('[data-testid="card-container"] [data-testid="agent-card"]').all()).map(
        box,
      ),
    );
    check(
      slotsBefore.every((s) => s.w === slotsBefore[0].w && s.h === slotsBefore[0].h),
      `cards: every card is ${slotsBefore[0].w}x${slotsBefore[0].h}`,
    );
    await shot(desk, 'desktop-cards');

    // A plain click selects.
    const cardOf = (name: string) =>
      desk
        .locator('[data-testid="agent-card"]')
        .filter({ has: desk.getByText(name, { exact: true }) });
    const selected = async (name: string) =>
      (await cardOf(name).first().getAttribute('class'))?.includes('bg-active-bg') === true;
    await cardOf(names[1]).first().click();
    await desk.waitForTimeout(400);
    check(await selected(names[1]), `cards: a click selects ${names[1]}`);

    // ── 4. a drag moves a card to another slot ──
    const first = names[0];
    const last = names[names.length - 1];
    const from = await box(cardOf(first).first());
    const to = await box(cardOf(last).first());
    await desk.mouse.move(from.x + from.w / 2, from.y + from.h / 2);
    await desk.mouse.down();
    await desk.mouse.move(from.x + from.w / 2, from.y + from.h / 2 + 12, { steps: 3 });
    await desk.mouse.move(to.x + to.w / 2, to.y + to.h - 4, { steps: 12 });
    await shot(desk, 'desktop-drag-mid');
    await desk.mouse.up();
    await desk.waitForTimeout(500);
    const after = await cardNames(desk);
    check(
      after[after.length - 1] === first && after[0] === names[1],
      `drag: ${first} moved to the last slot (${after.join(', ')}), the others shifted up`,
    );
    const slotsAfter = await Promise.all(
      (await desk.locator('[data-testid="card-container"] [data-testid="agent-card"]').all()).map(
        box,
      ),
    );
    check(
      slotsAfter.every(
        (s, i) =>
          s.w === slotsBefore[i].w &&
          s.h === slotsBefore[i].h &&
          Math.abs(s.y - slotsBefore[i].y) <= 1,
      ),
      'drag: same card size, same slots (positions)',
    );
    check(
      !(await selected(first)) && (await selected(names[1])),
      'drag: the dragged card was not selected by the drop (the earlier selection stands)',
    );
    await shot(desk, 'desktop-drag-after');
    await desk.reload();
    await desk.addStyleTag({ content: FONT_CSS });
    await desk.waitForFunction(
      (n) =>
        document.querySelectorAll('[data-testid="card-container"] [data-testid="agent-card"]')
          .length >= n,
      LEADS.length,
      { timeout: 60_000 },
    );
    check(
      (await cardNames(desk)).join(',') === after.join(','),
      'drag: the order survives a reload',
    );

    // ── 5. + opens 오케스트레이터 추가 ──
    const add = desk.getByTestId('card-add');
    const addBox = await box(add);
    const contBox = await box(desk.getByTestId('card-container'));
    check(
      addBox.y + addBox.h <= contBox.y + contBox.h && addBox.y > contBox.y + contBox.h / 2,
      '+: at the bottom of the container',
    );
    await add.click();
    await desk.getByRole('form', { name: '오케스트레이터 추가' }).waitFor();
    check(true, '+: opens the add-orchestrator form');
    await shot(desk, 'desktop-add-form');
    await desk.keyboard.press('Escape');

    // ── 6. the phone ──
    const { ctx: phoneCtx, page: phone } = await open(IPHONE);
    await phoneCtx.addCookies(await deskCtx.cookies());
    await ready(phone, `http://127.0.0.1:${port}/`);
    await phone.getByTestId('mobile-top-bar').waitFor();
    await phone.getByTestId('mobile-agent-bar').waitFor();
    await phone.waitForTimeout(2_500);
    const phoneNotice = phone.getByRole('button', { name: '계속 물어보기' });
    if (await phoneNotice.count()) await phoneNotice.tap();
    await phone.waitForTimeout(500);
    const p = await clockReport(phone, '[data-testid="mobile-top-bar"]');
    const pc = p.clock.x + p.clock.w / 2;
    check(
      Math.abs(pc - p.viewportW / 2) <= 1.5,
      `phone 393: the clock's centre ${pc.toFixed(1)} is the window's centre ${p.viewportW / 2}`,
    );
    check(p.fontPx >= 20, `phone 393: the clock is ${p.fontPx}px ("${p.text}")`);
    check(
      p.hits.length === 0 && !p.scrollX,
      `phone 393: nothing overlaps the clock${p.hits.length ? ` (${p.hits.join(', ')})` : ''}, no sideways scroll`,
    );
    const sideRoom = (p.viewportW - p.clock.w) / 2 - 8 - 8;
    check(
      sideRoom >= 90,
      `phone 393: ${sideRoom.toFixed(0)}px each side of the clock for the floor picker and 설정`,
    );
    check(p.bar.h <= 60, `phone 393: one row, the top bar is ${p.bar.h}px tall`);
    const phoneCards = await phone
      .locator('[data-testid="mobile-agent-bar"] [data-testid="agent-card"]')
      .count();
    check(phoneCards >= LEADS.length, `phone 393: the card bar still shows ${phoneCards} cards`);
    await shot(phone, 'phone-393');

    check(
      pageErrors.length === 0,
      `no page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`,
    );
    console.log(`screenshots in ${OUT}`);
  } catch (err) {
    console.error(serverLog.join('').slice(-1500));
    await browser
      .contexts()[0]
      ?.pages()[0]
      ?.screenshot({ path: path.join(OUT, 'debug.png') })
      .catch(() => undefined);
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

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

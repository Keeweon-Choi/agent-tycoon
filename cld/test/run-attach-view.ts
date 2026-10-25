/**
 * T-0083 check: attachments open in the app's own viewer and always come back.
 * dist/cli.js with --engine on in an isolated HOME whose `claude` is the engine
 * fake, on a spare port, headless Chromium (--disable-gpu, through the shared
 * harness). One lead (alpha) whose transcript holds an earlier message with a
 * text attachment and a later one with two images, each saved in the project's
 * .cld-inbox as the upload does.
 *
 * Desktop 1280x800 and phone 393x852 (touch):
 * - tapping an image opens the viewer and the page URL is unchanged, also with
 *   window.open refused (a home-screen app), the case that used to navigate away;
 * - a click or tap anywhere toggles fitted ↔ 2× fit (the image point stays
 *   under an image click); wheel and +/- still zoom; a drag pans when zoomed
 *   in; a pinch on the phone (CDP touch events) zooms; a fitted swipe goes next;
 * - prev/next walk the conversation's four attachments, wrapping, "n / 4";
 * - Esc, the close button and back close it; a tap on the dark zooms instead,
 *   keeping the viewer and URL unchanged;
 * - the text attachment shows 내려받기 (a download) and 새 창에서 열기 (a popup,
 *   or a note when the browser refuses), never changing the page URL.
 * Screenshots go to cld/artifacts/t0083/.
 *
 * T0083_EXPECT_OLD=1 is the negative control: it only taps an image with
 * window.open refused and expects the page to have navigated away (the old
 * open()); run it against a build of the old code.
 *
 *   npx tsx cld/test/run-attach-view.ts <port 18256-18259>
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
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
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0083');
const DEADLINE_MS = 240_000;
const EXPECT_OLD = process.env.T0083_EXPECT_OLD === '1';
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0083/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const IPHONE13 = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();
type Pt = { x: number; y: number };

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
async function until(what: string, fn: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
}

/** A picture with a grid, so a zoomed or panned view is visibly different. */
function picture(w: number, h: number, base: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const line = x % 100 === 0 || y % 100 === 0;
      for (let c = 0; c < 3; c++)
        png.data[i + c] = line ? 255 : Math.round((base[c] * (x + y)) / (w + h));
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}

/** Touches through CDP (Playwright only taps). Each step moves every finger. */
async function touches(page: Page, steps: Pt[][]) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: steps[0] });
  for (const s of steps.slice(1))
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: s });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const lerp = (a: Pt, b: Pt, k: number): Pt => ({
  x: a.x + (b.x - a.x) * k,
  y: a.y + (b.y - a.y) * k,
});
const drag = (page: Page, from: Pt, to: Pt) =>
  touches(
    page,
    Array.from({ length: 13 }, (_, k) => [lerp(from, to, k / 12)]),
  );
const pinch = (page: Page, a0: Pt, b0: Pt, a1: Pt, b1: Pt) =>
  touches(
    page,
    Array.from({ length: 13 }, (_, k) => [lerp(a0, a1, k / 12), lerp(b0, b1, k / 12)]),
  );

async function main(): Promise<void> {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  const inbox = path.join(folder, '.cld-inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(path.join(home, '.config/cld-gui'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/projects.json'),
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const deadline = setTimeout(() => {
    console.error(`deadline ${DEADLINE_MS / 1000} s`);
    void daemon.stop().then(() => {
      killFakeSessions(home);
      process.exit(2);
    });
  }, DEADLINE_MS);
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    // The attachments exactly as an upload leaves them, named in the transcript as the messenger sends them.
    const files = [
      ['20261022-140000-notes.txt', 'text/plain', Buffer.from('메모 notes\n두 번째 줄\n')],
      ['20261022-140000-doc.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n')],
      ['20261022-140001-a.png', 'image/png', picture(1200, 800, [255, 90, 60])],
      ['20261022-140002-b.png', 'image/png', picture(800, 1200, [60, 200, 120])],
    ] as const;
    for (const [name, , data] of files) fs.writeFileSync(path.join(inbox, name), data);
    const line = ([name, type, data]: (typeof files)[number]) =>
      `[첨부] ${path.join(inbox, name)} (${type}, ${Math.max(1, Math.ceil(data.length / 1024))} KB)`;

    await daemon.loginUrl(); // the daemon is up
    let session: { cwd: string; sessionId: string } | undefined;
    for (const end = Date.now() + 40_000; !session;) {
      if (Date.now() > end) throw new Error('the engine did not revive alpha');
      for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : [])
        try {
          const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8'));
          if (s.name === 'alpha') session = s;
        } catch {
          /* being written */
        }
      await new Promise((r) => setTimeout(r, 300));
    }
    const transcript = transcriptPath(session.cwd, session.sessionId, home);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    const record = (i: number, role: 'user' | 'assistant', text: string) =>
      `${JSON.stringify(
        role === 'user'
          ? {
              type: 'user',
              uuid: `${i.toString(16).padStart(8, '0')}-8300-4000-8000-000000000000`,
              timestamp: new Date(Date.now() - 60_000 + i * 1000).toISOString(),
              message: { role, content: text },
            }
          : {
              type: 'assistant',
              uuid: `${i.toString(16).padStart(8, '0')}-8300-4000-8000-000000000000`,
              timestamp: new Date(Date.now() - 60_000 + i * 1000).toISOString(),
              message: { role, content: [{ type: 'text', text }] },
            },
      )}\n`;
    fs.appendFileSync(
      transcript,
      record(1, 'user', `메모 보낼게요\n${line(files[0])}\n${line(files[1])}`) +
        record(2, 'assistant', '메모 받았어요') +
        record(3, 'user', `사진 두 장\n${line(files[2])}\n${line(files[3])}`) +
        record(4, 'assistant', '사진 받았어요'),
    );

    browser = await launchBrowser();
    const font = fs.existsSync(FONT) ? fs.readFileSync(FONT) : null;
    const pageErrors: string[] = [];
    // Each page's socket passes through us, so the last office/engine state can be delivered again:
    // the server sends one whenever any agent starts or ends a turn.
    const redeliver = new Map<Page, () => void>();
    const open = async (opts: BrowserContextOptions) => {
      const ctx = await browser!.newContext({ ...opts, acceptDownloads: true });
      if (font)
        await ctx.route('**/__t0083/malgun.ttf', (r) =>
          r.fulfill({ body: font, contentType: 'font/ttf' }),
        );
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
        const server = ws.connectToServer();
        const last = new Map<string, string | Buffer>();
        ws.onMessage((m) => server.send(m));
        server.onMessage((m) => {
          const type = /"type":"(officeState|engineState)"/.exec(String(m))?.[1];
          if (type) last.set(type, m);
          ws.send(m);
        });
        redeliver.set(page, () => last.forEach((m) => ws.send(m)));
      });
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(BASE);
      if (font) {
        await page.addStyleTag({ content: FONT_CSS });
        await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
      }
      return { ctx, page };
    };
    const openConversation = async (page: Page, touch: boolean) => {
      const hud = page.getByRole('button', { name: /^메신저/ });
      await hud.waitFor();
      await (touch ? hud.tap() : hud.click());
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      const alpha = messenger.getByRole('list', { name: '연락처' }).getByRole('button', {
        name: /^alpha/,
      });
      await (touch ? alpha.tap() : alpha.click());
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      await conv.getByText('사진 받았어요').waitFor({ timeout: 20_000 });
      return conv;
    };
    const tapOn = (l: Locator, touch: boolean) => (touch ? l.tap() : l.click());
    const viewerOf = (page: Page) => page.locator('[data-testid="attach-viewer"]');
    const level = async (page: Page) =>
      parseInt((await page.locator('[data-testid="attach-zoom"]').textContent()) ?? '0', 10);
    const transform = (page: Page) =>
      page.locator('[data-testid="attach-img"]').evaluate((el) => {
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
        return { scale: m.a, x: m.e, y: m.f, box: el.getBoundingClientRect().toJSON() };
      });
    const counter = (page: Page) => page.locator('.attach-title-meta').textContent();
    const shot = (page: Page, name: string) =>
      page.screenshot({ path: path.join(OUT, `${name}.png`) });

    // ── The old open(): a refused window.open used to take the whole app to the image ──
    {
      const { ctx, page } = await open({ viewport: { width: 1280, height: 800 } });
      const conv = await openConversation(page, false);
      await page.evaluate(() => (window.open = () => null)); // a home-screen app
      await conv.locator('[title$="a.png"]').click();
      await page.waitForTimeout(1_500);
      if (EXPECT_OLD) {
        check(
          page.url() !== BASE,
          `negative control: with window.open refused the old code left the app for ${page.url().slice(0, 60)}…`,
        );
        await ctx.close();
        return;
      }
      check(
        page.url() === BASE && (await viewerOf(page).count()) === 1,
        'window.open refused (a home-screen app): the viewer opens and the page URL is unchanged',
      );
      await ctx.close();
    }
    if (EXPECT_OLD) throw new Error('unreachable');

    // ════ Desktop ════
    const desk = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = desk.page;
    const conv = await openConversation(page, false);
    const viewer = viewerOf(page);
    const imageA = conv.locator('[title$="a.png"]');
    await imageA.locator('img').waitFor();
    check((await viewer.count()) === 0, 'desktop: no viewer before a tap');

    await imageA.click();
    await viewer.waitFor();
    await page.locator('[data-testid="attach-img"]').waitFor();
    await until('fitted', async () => (await transform(page)).scale > 0);
    check(page.url() === BASE, 'desktop: tapping an image opens the viewer, URL unchanged');
    check(
      (await counter(page))?.startsWith('3 / 4 · ') === true,
      `desktop: "${await counter(page)}"`,
    );
    const headerFont = await page
      .locator('.attach-title')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const bodyFont = await conv
      .getByText('사진 받았어요')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    check(
      headerFont >= bodyFont,
      `desktop: readable file name is ${headerFont}px (messenger body ${bodyFont}px)`,
    );
    const fit = await transform(page);
    check(
      Math.abs(fit.scale - (800 - 16) / 800) < 0.01 &&
        (await level(page)) === Math.round(fit.scale * 100) &&
        fit.box.height <= 800,
      `desktop: opens fitted to the screen (${await level(page)}%, transform scale ${fit.scale.toFixed(3)})`,
    );
    await shot(page, 'desktop-fit');

    // A click on the image doubles fit around its exact image point, then returns to fit.
    const pointer = {
      x: fit.box.left + fit.box.width * 0.25,
      y: fit.box.top + fit.box.height * 0.3,
    };
    const frac = (t: Awaited<ReturnType<typeof transform>>) => ({
      x: (pointer.x - t.box.left) / t.box.width,
      y: (pointer.y - t.box.top) / t.box.height,
    });
    const before = frac(fit);
    await page.mouse.click(pointer.x, pointer.y);
    await until('image click zoom', async () => (await transform(page)).scale > fit.scale * 1.9);
    const imageClicked = await transform(page);
    const imageAfter = frac(imageClicked);
    check(
      (await level(page)) === Math.round(imageClicked.scale * 100) &&
        Math.abs(before.x - imageAfter.x) < 0.01 &&
        Math.abs(before.y - imageAfter.y) < 0.01,
      `desktop: an image click zooms around its point (${await level(page)}%)`,
    );
    await page.mouse.click(pointer.x, pointer.y);
    await until(
      'second image click fits',
      async () => Math.abs((await transform(page)).scale - fit.scale) < 0.01,
    );
    // The fitted margin has the same toggle contract and never closes the viewer.
    await page.mouse.click(8, 200);
    await until('dark click zoom', async () => (await transform(page)).scale > fit.scale * 1.9);
    check(
      (await viewer.count()) === 1 && page.url() === BASE,
      'desktop: a click outside the image zooms and keeps the viewer open (new-rule negative control)',
    );
    await page.mouse.click(8, 200);
    await until(
      'second dark click fits',
      async () => Math.abs((await transform(page)).scale - fit.scale) < 0.01,
    );

    // Wheel zooms around the pointer: the image point under it stays put.
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.wheel(0, -300);
    await until('wheel zoom', async () => (await transform(page)).scale > fit.scale * 1.2);
    const wheeled = await transform(page);
    const after = frac(wheeled);
    check(
      (await level(page)) === Math.round(wheeled.scale * 100) &&
        Math.abs(before.x - after.x) < 0.01 &&
        Math.abs(before.y - after.y) < 0.01,
      `desktop: the wheel zooms around the pointer (${await level(page)}%, point under it moved ${(
        Math.abs(before.x - after.x) + Math.abs(before.y - after.y)
      ).toFixed(4)} of the image)`,
    );
    await shot(page, 'desktop-wheel');
    const plus = page.locator('[data-testid="attach-zoom-in"]');
    const minus = page.locator('[data-testid="attach-zoom-out"]');
    await plus.click();
    const plused = await transform(page);
    check(
      Math.abs(plused.scale / wheeled.scale - 1.25) < 0.01,
      `desktop: + zooms in by a step (${await level(page)}%)`,
    );
    await minus.click();
    await minus.click();
    const minused = await transform(page);
    check(
      Math.abs(minused.scale / plused.scale - 1 / 1.25 / 1.25) < 0.01,
      `desktop: − zooms out (${await level(page)}%)`,
    );
    // Pan: a mouse drag moves a zoomed image.
    await plus.click();
    await plus.click();
    await plus.click();
    const zoomed = await transform(page);
    const stage = await page.locator('[data-testid="attach-stage"]').boundingBox();
    const mid = { x: stage!.x + stage!.width / 2, y: stage!.y + stage!.height / 2 };
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down();
    await page.mouse.move(mid.x - 120, mid.y - 60, { steps: 8 });
    await page.mouse.up();
    const panned = await transform(page);
    check(
      zoomed.scale === panned.scale && panned.x < zoomed.x - 50 && panned.y < zoomed.y - 20,
      `desktop: a drag pans a zoomed image (x ${zoomed.x.toFixed(0)} to ${panned.x.toFixed(0)})`,
    );
    await shot(page, 'desktop-zoomed');
    // An agent's turn elsewhere (office/engine state again) must not reset the zoom or fetch the image anew.
    const files0 = (await page.evaluate(
      () => performance.getEntriesByType('resource').length,
    )) as number;
    redeliver.get(page)!();
    await page.waitForTimeout(1_000);
    const kept = await transform(page);
    check(
      kept.scale === panned.scale &&
        kept.x === panned.x &&
        (await page.evaluate(() => performance.getEntriesByType('resource').length)) === files0,
      `desktop: a office/engine state update keeps the zoom and pan (${await level(page)}%)`,
    );
    // A double click is simply two clicks: zoomed → fit → 2× fit, then one click fits.
    await page.mouse.dblclick(mid.x, mid.y);
    await until(
      'double click settles at two times fit',
      async () => Math.abs((await transform(page)).scale - fit.scale * 2) < 0.01,
    );
    await page.mouse.click(mid.x, mid.y);
    await until(
      'click after double click to fit',
      async () => Math.abs((await transform(page)).scale - fit.scale) < 0.01,
    );
    check(true, 'desktop: double click follows the same click zoom toggle');

    // Prev / next through the conversation's four attachments.
    await page.locator('[data-testid="attach-next"]').click();
    await until('4 / 4', async () => ((await counter(page)) ?? '').startsWith('4 / 4 · '));
    await page.locator('[data-testid="attach-img"]').waitFor();
    await until(
      'b fitted',
      async () => Math.abs((await transform(page)).scale - 784 / 1200) < 0.01,
    );
    check(true, 'desktop: next shows the second image, fitted again (4 / 4)');
    await shot(page, 'desktop-second');
    await page.keyboard.press('ArrowRight');
    await page.locator('[data-testid="attach-file"]').waitFor();
    check(
      ((await counter(page)) ?? '').startsWith('1 / 4 · ') &&
        (await page.locator('[data-testid="attach-file"]').textContent())!.includes('notes.txt') &&
        (await page.locator('[data-testid="attach-file"]').textContent())!.includes('text/plain'),
      'desktop: ArrowRight wraps to the first attachment, the text file, with its name and type',
    );
    await shot(page, 'desktop-file');

    // The text file: a download, and a popup (or a note), never leaving the app.
    const download = page.waitForEvent('download');
    await page.locator('[data-testid="attach-download"]').click();
    const got = await download;
    check(
      got.suggestedFilename().endsWith('notes.txt') && page.url() === BASE,
      `desktop: 내려받기 downloads ${got.suggestedFilename()}, URL unchanged`,
    );
    check(
      (await page.locator('[data-testid="attach-open"]').count()) === 0,
      'desktop: a text file offers no 새 창에서 열기 (the server previews images, PDF and HTML only)',
    );
    // The PDF: a new tab when the browser allows one, a note when it does not.
    await page.keyboard.press('ArrowRight');
    await until('pdf card', async () => ((await counter(page)) ?? '').startsWith('2 / 4 · '));
    const popup = desk.ctx.waitForEvent('page');
    const fileRequest = desk.ctx.waitForEvent('request', (r) =>
      r.url().includes('/api/cld/files/content/'),
    );
    await page.locator('[data-testid="attach-open"]').click();
    const tab = await popup;
    // Headless Chromium has no PDF viewer: the tab's navigation becomes a download, so the proof is its request.
    const asked = await fileRequest;
    check(asked.frame().page() === tab, 'the new tab itself asked for the file');
    check(page.url() === BASE, '새 창에서 열기 opens the PDF in a new tab and the app stays');
    await tab.close().catch(() => undefined);
    await page.evaluate(() => (window.open = () => null));
    await page.locator('[data-testid="attach-open"]').click();
    await page.locator('[data-testid="attach-note"]').waitFor();
    check(
      page.url() === BASE,
      `desktop: with the popup refused it says so ("${await page.locator('[data-testid="attach-note"]').textContent()}") and the URL is unchanged`,
    );
    await shot(page, 'desktop-popup-refused');

    // Closing: Esc, the button, back, a tap on the dark.
    const appIsHere = async () =>
      (await viewer.count()) === 0 &&
      page.url() === BASE &&
      (await conv.getByText('사진 받았어요').isVisible());
    await page.keyboard.press('Escape');
    await until('Esc closes', async () => (await viewer.count()) === 0);
    check(await appIsHere(), 'desktop: Esc closes the viewer, the app is still there');
    await imageA.click();
    await viewer.waitFor();
    await page.locator('[data-testid="attach-close"]').click();
    await until('close button closes', async () => (await viewer.count()) === 0);
    check(await appIsHere(), 'desktop: the close button closes it');
    await imageA.click();
    await viewer.waitFor();
    await page.goBack();
    await until('back closes', async () => (await viewer.count()) === 0);
    check(await appIsHere(), 'desktop: the browser back closes it and stays in the app');
    await imageA.click();
    await viewer.waitFor();
    await page.locator('[data-testid="attach-img"]').waitFor();
    await until('fitted again', async () => (await transform(page)).scale > 0);
    // Fitted, a click on the dark outside the image zooms and leaves history alone.
    await page.mouse.click(8, 200);
    await until(
      'dark click zooms again',
      async () => (await transform(page)).scale > fit.scale * 1.9,
    );
    check(
      (await viewer.count()) === 1 && page.url() === BASE,
      'desktop: a click on the dark outside the image never closes the viewer',
    );
    await page.locator('[data-testid="attach-close"]').click();
    await until('close after dark click', async () => (await viewer.count()) === 0);
    check(await appIsHere(), 'desktop: the close button still closes after a dark click');
    check(
      (await imageA.locator('img').count()) === 1,
      'desktop: the bubble still shows its thumbnail',
    );
    await desk.ctx.close();

    // ════ Phone ════
    const ph = await open({ ...IPHONE13, viewport: { width: 393, height: 852 } });
    const phone = ph.page;
    const pconv = await openConversation(phone, true);
    const pviewer = viewerOf(phone);
    const pimageA = pconv.locator('[title$="a.png"]');
    await pimageA.locator('img').waitFor();
    await pimageA.tap();
    await pviewer.waitFor();
    await until('phone fitted', async () => (await transform(phone)).scale > 0);
    const pfit = await transform(phone);
    check(
      phone.url() === BASE && Math.abs(pfit.scale - (393 - 16) / 1200) < 0.01,
      `phone: a tap opens the viewer fitted (${await level(phone)}%), URL unchanged`,
    );
    await shot(phone, 'phone-fit');
    await phone.touchscreen.tap(196, 426);
    await until('phone tap zoom', async () => (await transform(phone)).scale > pfit.scale * 1.9);
    check(
      (await pviewer.count()) === 1 && phone.url() === BASE,
      `phone: a tap zooms to ${await level(phone)}% without closing`,
    );
    await phone.touchscreen.tap(196, 426);
    await until(
      'second phone tap fits',
      async () => Math.abs((await transform(phone)).scale - pfit.scale) < 0.01,
    );
    await pinch(
      phone,
      { x: 150, y: 426 },
      { x: 240, y: 426 },
      { x: 70, y: 426 },
      { x: 320, y: 426 },
    );
    await until('pinch zoomed', async () => (await transform(phone)).scale > pfit.scale * 1.5);
    const pinched = await transform(phone);
    check(
      (await level(phone)) === Math.round(pinched.scale * 100),
      `phone: a two-finger pinch zooms (${Math.round(pfit.scale * 100)}% to ${await level(phone)}%)`,
    );
    await shot(phone, 'phone-pinch');
    await drag(phone, { x: 300, y: 400 }, { x: 150, y: 400 });
    const ppanned = await transform(phone);
    check(
      ppanned.x < pinched.x - 30,
      `phone: one finger pans the zoomed image (x ${pinched.x.toFixed(0)} to ${ppanned.x.toFixed(0)})`,
    );
    // One tap after a pan returns to fit, so the next gesture is a fitted swipe.
    await phone.touchscreen.tap(196, 426);
    await until(
      'tap after pan to fit',
      async () => Math.abs((await transform(phone)).scale - pfit.scale) < 0.01,
    );
    // A swipe, fitted: next.
    await drag(phone, { x: 330, y: 700 }, { x: 60, y: 700 });
    await until('swipe to next', async () => ((await counter(phone)) ?? '').startsWith('4 / 4 · '));
    check(true, 'phone: a swipe goes to the next attachment (4 / 4)');
    // Chromium drops a tap that comes within a few hundred ms of a touch drag (more under
    // load): tap again only while the counter still says 4 / 4, so a landed tap is never doubled.
    for (let k = 0; k < 5; k++) {
      await phone.waitForTimeout(500);
      if (!((await counter(phone)) ?? '').startsWith('4 / 4 · ')) break;
      await phone.locator('[data-testid="attach-next"]').tap();
    }
    await phone.locator('[data-testid="attach-file"]').waitFor();
    await shot(phone, 'phone-file');
    const pdownload = phone.waitForEvent('download');
    await phone.locator('[data-testid="attach-download"]').tap();
    check(
      (await pdownload).suggestedFilename().endsWith('notes.txt') && phone.url() === BASE,
      'phone: 내려받기 downloads the text file, URL unchanged',
    );
    const pHere = async () =>
      (await pviewer.count()) === 0 &&
      phone.url() === BASE &&
      (await pconv.getByText('사진 받았어요').isVisible());
    await phone.locator('[data-testid="attach-close"]').tap();
    await until('phone close button', async () => (await pviewer.count()) === 0);
    check(await pHere(), 'phone: the close button closes it, the app is still there');
    await pimageA.tap();
    await pviewer.waitFor();
    await phone.goBack();
    await until('phone back', async () => (await pviewer.count()) === 0);
    check(await pHere(), 'phone: back closes it and stays in the app');
    await pimageA.tap();
    await pviewer.waitFor();
    await until('phone fitted again', async () => (await transform(phone)).scale > 0);
    await phone.touchscreen.tap(196, 120);
    await until(
      'phone dark tap zoom',
      async () => (await transform(phone)).scale > pfit.scale * 1.9,
    );
    check(
      (await pviewer.count()) === 1 && phone.url() === BASE,
      'phone: a tap on the dark outside the image never closes the viewer',
    );
    await phone.locator('[data-testid="attach-close"]').tap();
    await until('phone close after dark tap', async () => (await pviewer.count()) === 0);
    check(await pHere(), 'phone: the close button still closes after a dark tap');
    await ph.ctx.close();

    check(
      pageErrors.length === 0,
      `no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`,
    );
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

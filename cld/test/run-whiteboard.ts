/**
 * T-0065 check: a whiteboard memo in every office room. dist/cli.js with an
 * isolated HOME (three Claude sessions, W-3: rooms alpha, beta, gamma) on a spare port, headless Chromium (--disable-gpu, through
 * the shared harness), desktop 1280x800 and a phone 393x852.
 * - every work room has its whiteboard, and before anything is saved no memo
 *   overlay exists (the negative control: the overlay locator is empty, then
 *   it holds exactly the saved board's text);
 * - a click on a board opens the memo modal; a two-line Korean+English memo
 *   saved with 저장 is drawn on THAT board (text content, inside the board,
 *   tycoon font, marker colour, three lines);
 * - a second browser context sees it, a reload keeps it, memos.json holds it (0600);
 * - zoomed in, the memo grows with the board; a long memo is clipped to the face;
 * - a client the office shows read-only (its officeAccess says so) reads the memo
 *   and has no 저장; in the layout editor a tap opens no modal; empty text erases;
 * - the phone taps a board, types, saves, and the modal stays inside the screen.
 * Screenshots go to cld/artifacts/t0065/.
 *
 * The daemon trusts every logged-in client with writes (privileged = true), so the
 * server-side refusal of a read-only client is covered by server/src/cld/memos.test.ts.
 *
 *   npx tsx cld/test/run-whiteboard.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  warmUpOffice,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0065');
const DEADLINE_MS = 240_000;
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MEMO = '배포 점검: 오전 10시\nship it by Friday';
// WHITEBOARD_INK in constants.ts, as the browser reports it.
// eslint-disable-next-line pixel-agents/no-inline-colors
const INK = 'rgb(28, 44, 88)';

type Furniture = { uid: string; type: string; col: number; row: number };
type Pt = { x: number; y: number };
const board = (room: string) => `whiteboard:${room}`;
const overlays = (page: Page, uid?: string) =>
  page.locator(`[data-testid="whiteboard-memo"]${uid ? `[data-uid="${uid}"]` : ''}`);

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
async function until(what: string, fn: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out: ${what}`);
}

/** One finger dragged across the office (CDP touch events: Playwright only taps). */
async function touchDrag(page: Page, from: Pt, to: Pt) {
  const cdp = await page.context().newCDPSession(page);
  const at = (k: number) => [
    { x: from.x + ((to.x - from.x) * k) / 12, y: from.y + ((to.y - from.y) * k) / 12 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  for (let k = 1; k <= 12; k++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(k) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** The board's footprint on the page, from the renderer's own projection (getTileCenter). */
async function footprint(page: Page, b: Furniture) {
  const canvas = (await page.locator('[data-testid="office-canvas"]').boundingBox())!;
  const t = await page.evaluate(
    ({ col, row }) => {
      const h = (
        window as unknown as {
          __pixelAgentsTestHooks: {
            getTileCenter: (c: number, r: number) => { x: number; y: number };
          };
        }
      ).__pixelAgentsTestHooks;
      return [h.getTileCenter(col, row), h.getTileCenter(col + 1, row + 1)];
    },
    { col: b.col, row: b.row },
  );
  const tile = t[1].x - t[0].x;
  return {
    canvas,
    tile,
    left: canvas.x + t[0].x - tile / 2,
    top: canvas.y + t[0].y - tile / 2,
    width: tile * 2,
    height: tile * 2,
    center: { x: canvas.x + (t[0].x + t[1].x) / 2, y: canvas.y + (t[0].y + t[1].y) / 2 },
  };
}

/** Pan (a mouse drag, or a finger on the phone) until the board sits at `want`. */
async function bringIntoView(page: Page, b: Furniture, want: Pt, touch: boolean) {
  for (let k = 0; k < 8; k++) {
    const f = await footprint(page, b);
    const dx = want.x - f.center.x;
    const dy = want.y - f.center.y;
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    const clamp = (d: number) => Math.max(-250, Math.min(250, d));
    const from = { x: f.canvas.x + f.canvas.width / 2, y: f.canvas.y + f.canvas.height * 0.62 };
    const to = { x: from.x + clamp(dx), y: from.y + clamp(dy) };
    if (touch) await touchDrag(page, from, to);
    else {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await page.mouse.up();
    }
    await page.waitForTimeout(350);
  }
  // Panning stops at the camera's limits: near the wanted point is enough to hit the board.
  const f = await footprint(page, b);
  if (Math.hypot(want.x - f.center.x, want.y - f.center.y) > 150)
    throw new Error(`could not bring ${b.uid} into view`);
}

async function main(): Promise<void> {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'W-3', agentsJson: true });
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  const deadline = setTimeout(() => {
    console.error('deadline: stopping');
    void daemon.stop().then(() => process.exit(2));
  }, DEADLINE_MS);
  const browser = await launchBrowser();
  // The sessions load when the first viewer arrives: open one page first so the real ones start from the loaded office.
  const warm = await browser.newContext();
  await warmUpOffice(warm, daemon);
  await warm.close();
  const pageErrors: string[] = [];
  const memosFile = path.join(configDirectory(fake.home), 'memos.json');
  const onDisk = () =>
    JSON.parse(fs.readFileSync(memosFile, 'utf-8')).memos as Record<
      string,
      { text: string; by: string; updatedAt: number }
    >;
  try {
    const open = async (
      opts: Parameters<typeof browser.newContext>[0],
      before?: (page: Page) => Promise<void>,
    ) => {
      const ctx = await browser.newContext(opts);
      await ctx.addInitScript(() => {
        (window as unknown as Record<string, unknown>).__name = (f: unknown) => f;
        (window as unknown as Record<string, unknown>).__PIXEL_AGENTS_E2E = true;
        localStorage.setItem('cld.office-hours', '{"on":false}');
      });
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      const layouts: Array<{ furniture: Furniture[] }> = [];
      page.on('websocket', (ws) =>
        ws.on('framereceived', (f) => {
          try {
            const m = JSON.parse(String(f.payload)) as { type: string; layout?: never };
            if (m.type === 'layoutLoaded') layouts.push(m.layout!);
          } catch {
            /* binary */
          }
        }),
      );
      await before?.(page);
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(BASE);
      await page.locator('[data-testid="office-canvas"]').waitFor();
      await page.locator('[data-testid="agent-overlay"]').first().waitFor();
      await until('the office layout', async () => layouts.length > 0);
      const boards = () =>
        layouts.at(-1)!.furniture.filter((f) => f.type === 'WHITEBOARD') as Furniture[];
      // The first viewer wakes the office: its sessions arrive after the first layout.
      await until('the rooms are in the layout', async () => boards().length >= 3);
      return { ctx, page, boards };
    };
    const shot = (
      page: Page,
      name: string,
      clip?: { x: number; y: number; width: number; height: number },
    ) => page.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip && { clip }) });
    const clipAround = (f: Awaited<ReturnType<typeof footprint>>, pad: number) => ({
      x: Math.max(0, f.left - pad),
      y: Math.max(0, f.top - pad),
      width: f.width + 2 * pad,
      height: f.height + 2 * pad,
    });
    const modal = (page: Page) => page.locator('[data-testid="whiteboard-input"]');

    // ── Desktop ──
    const desk = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    const page = desk.page;
    const alpha = desk.boards().find((b) => b.uid === board('alpha'))!;
    check(
      JSON.stringify(
        desk
          .boards()
          .map((b) => b.uid)
          .sort(),
      ) === JSON.stringify(['alpha', 'beta', 'gamma'].map(board).sort()),
      `every work room has its whiteboard: ${desk
        .boards()
        .map((b) => b.uid)
        .join(', ')}`,
    );

    // Negative control: nothing saved yet, so no memo overlay anywhere (and none for alpha).
    await bringIntoView(page, alpha, { x: 640, y: 330 }, false);
    check((await overlays(page).count()) === 0, 'before saving, no memo overlay exists');
    check((await overlays(page, alpha.uid).count()) === 0, 'before saving, alpha has no overlay');
    await shot(page, 'desktop-before');

    // A click away from every board opens nothing.
    const f0 = await footprint(page, alpha);
    await page.mouse.click(f0.center.x + f0.tile * 6, f0.center.y + f0.tile * 4);
    await page.waitForTimeout(400);
    check((await modal(page).count()) === 0, 'a click away from a whiteboard opens no modal');

    // A click on the board opens the modal; type and save.
    await page.mouse.click(f0.center.x, f0.center.y);
    await modal(page).waitFor({ timeout: 3_000 });
    check((await modal(page).inputValue()) === '', 'the modal opens empty on a board with no memo');
    await shot(page, 'desktop-modal');
    await modal(page).fill(`  ${MEMO}  `);
    check(
      (await page.locator('[data-testid="whiteboard-count"]').textContent())!.startsWith(
        `${MEMO.length + 4}/600`,
      ),
      'the counter shows the length out of 600',
    );
    // Esc closes without saving.
    await page.keyboard.press('Escape');
    await until('Esc closes the modal', async () => (await modal(page).count()) === 0, 2_000);
    check((await overlays(page).count()) === 0, 'Esc saved nothing');
    await page.mouse.click(f0.center.x, f0.center.y);
    await modal(page).waitFor();
    await modal(page).fill(`  ${MEMO}  `);
    await page.locator('[data-testid="whiteboard-save"]').click();
    const memoOf = (p: Page) => overlays(p, alpha.uid);
    await memoOf(page).waitFor({ timeout: 5_000 });
    check((await modal(page).count()) === 0, '저장 closes the modal');
    check((await overlays(page).count()) === 1, 'exactly one board shows a memo');
    check((await memoOf(page).textContent()) === MEMO, 'the overlay shows the memo text (trimmed)');
    const ink = await memoOf(page).evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        font: s.fontFamily,
        color: s.color,
        size: parseFloat(s.fontSize),
        line: parseFloat(s.lineHeight),
        clamp: s.webkitLineClamp,
        pointer: s.pointerEvents,
      };
    });
    check(
      /FS Pixel Sans/.test(ink.font) && ink.color === INK,
      `tycoon font and marker colour (${ink.font}, ${ink.color})`,
    );
    check(
      ink.clamp === '3' && ink.pointer === 'none',
      'three lines at most, the pointer passes through',
    );
    const box = (await memoOf(page).boundingBox())!;
    const f1 = await footprint(page, alpha);
    check(
      box.x >= f1.left &&
        box.y >= f1.top &&
        box.x + box.width <= f1.left + f1.width &&
        box.y + box.height <= f1.top + f1.height,
      'the memo sits inside its board',
    );
    check(
      Math.abs(box.height - ink.line * 3) < 1.5,
      `its height is three lines (${box.height.toFixed(1)} px)`,
    );
    await page.mouse.move(5, 5);
    await shot(page, 'desktop-office');
    await shot(page, 'desktop-memo-closeup', clipAround(f1, 70));

    // The server holds it: 0600, the device label, text.
    const stored = onDisk()[alpha.uid];
    check(stored.text === MEMO && stored.by === 'linux', `memos.json holds it (by ${stored.by})`);
    check((fs.statSync(memosFile).mode & 0o777) === 0o600, 'memos.json is 0600');

    // Zoomed in, the memo grows with the board and stays inside it.
    const before = { w: box.width, size: ink.size };
    await page.mouse.move(f1.center.x, f1.center.y);
    for (let k = 0; k < 3; k++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(150);
    }
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    const big = (await memoOf(page).boundingBox())!;
    const bigSize = await memoOf(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    check(
      big.width > before.w * 1.4 && bigSize > before.size * 1.4,
      `zoomed in the memo grows (${before.w}px/${before.size}px -> ${big.width}px/${bigSize}px)`,
    );
    const f2 = await footprint(page, alpha);
    check(
      big.x >= f2.left &&
        big.x + big.width <= f2.left + f2.width &&
        big.y >= f2.top &&
        big.y + big.height <= f2.top + f2.height,
      'zoomed in, the memo still sits inside its board',
    );
    await shot(page, 'desktop-zoomed-in', clipAround(f2, 40));
    for (let k = 0; k < 3; k++) {
      await page.mouse.move(f2.center.x, f2.center.y);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(150);
    }

    // A long memo (600 characters) is clipped to the face, on another board.
    const gamma = desk.boards().find((b) => b.uid === board('gamma'))!;
    await bringIntoView(page, gamma, { x: 640, y: 330 }, false);
    const fg = await footprint(page, gamma);
    await page.mouse.click(fg.center.x, fg.center.y);
    await modal(page).waitFor();
    await modal(page).click();
    await page.keyboard.insertText('가나다라마바사 abcdefg '.repeat(40)); // 640 characters
    const typed = await modal(page).inputValue();
    check(typed.length === 600, `the textarea stops at 600 characters (${typed.length})`);
    check(
      (await page.locator('[data-testid="whiteboard-count"]').textContent()) === '600/600',
      'the counter reads 600/600',
    );
    await page.locator('[data-testid="whiteboard-save"]').click();
    await overlays(page, gamma.uid).waitFor();
    const longBox = (await overlays(page, gamma.uid).boundingBox())!;
    const longLine = await overlays(page, gamma.uid).evaluate((el) =>
      parseFloat(getComputedStyle(el).lineHeight),
    );
    check(
      Math.abs(longBox.height - longLine * 3) < 1.5,
      `a long memo is clipped to three lines (${longBox.height.toFixed(1)} px of ${(longLine * 3).toFixed(1)})`,
    );
    await shot(page, 'desktop-long-memo', clipAround(await footprint(page, gamma), 50));

    // A second browser context sees the memo.
    const second = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await bringIntoView(second.page, alpha, { x: 640, y: 330 }, false);
    await memoOf(second.page).waitFor({ timeout: 5_000 });
    check(
      (await memoOf(second.page).textContent()) === MEMO,
      'a second browser context sees the memo',
    );
    await second.page.mouse.move(5, 5);
    await shot(second.page, 'second-context', clipAround(await footprint(second.page, alpha), 90));
    await second.ctx.close();

    // A reload keeps it.
    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await bringIntoView(page, alpha, { x: 640, y: 330 }, false);
    await memoOf(page).waitFor({ timeout: 5_000 });
    check((await memoOf(page).textContent()) === MEMO, 'a reload keeps the memo');

    // An empty text erases it; the overlay goes (the control's other half).
    await bringIntoView(page, gamma, { x: 640, y: 330 }, false);
    const fg2 = await footprint(page, gamma);
    await page.mouse.click(fg2.center.x, fg2.center.y);
    await modal(page).waitFor();
    check(
      (await modal(page).inputValue()).trim() === typed.trim(),
      'the modal opens with the stored memo',
    );
    await modal(page).fill('   ');
    await page.locator('[data-testid="whiteboard-save"]').click();
    await until(
      'the erased memo leaves the board',
      async () => (await overlays(page, gamma.uid).count()) === 0,
      5_000,
    );
    check(
      !(gamma.uid in onDisk()) && alpha.uid in onDisk(),
      'empty text erased that memo and only that',
    );

    // The layout editor keeps the tap: no modal.
    await bringIntoView(page, alpha, { x: 640, y: 330 }, false);
    await page.locator('.cld-elevator-decorate').click();
    await page.waitForTimeout(400);
    const fe = await footprint(page, alpha);
    await page.mouse.click(fe.center.x, fe.center.y);
    await page.waitForTimeout(500);
    check(
      (await modal(page).count()) === 0,
      'in the layout editor a click on a whiteboard opens no modal',
    );
    await page.locator('.cld-elevator-decorate').click();
    await page.waitForTimeout(400);
    await page.mouse.click(fe.center.x, fe.center.y);
    await modal(page).waitFor({ timeout: 3_000 });
    check(true, 'out of the editor the same click opens it again');
    await page.keyboard.press('Escape');

    // A client the office shows read-only reads the memo and cannot save.
    const ro = await open(
      { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 },
      async (p) => {
        await p.routeWebSocket(/\/ws(\?|$)/, (ws) => {
          const server = ws.connectToServer();
          server.onMessage((m) => {
            try {
              const j = JSON.parse(String(m)) as { type: string; readOnly?: boolean };
              if (j.type === 'officeAccess') j.readOnly = true;
              ws.send(JSON.stringify(j));
            } catch {
              ws.send(m);
            }
          });
          ws.onMessage((m) => server.send(m));
        });
      },
    );
    await bringIntoView(ro.page, alpha, { x: 640, y: 330 }, false);
    await memoOf(ro.page).waitFor({ timeout: 5_000 });
    check((await memoOf(ro.page).textContent()) === MEMO, 'the read-only client sees the memo');
    const fr = await footprint(ro.page, alpha);
    await ro.page.mouse.click(fr.center.x, fr.center.y);
    await modal(ro.page).waitFor();
    check(
      (await modal(ro.page).inputValue()) === MEMO &&
        (await modal(ro.page).getAttribute('readonly')) !== null,
      'the read-only client reads the memo in a read-only textarea',
    );
    check(
      (await ro.page.locator('[data-testid="whiteboard-save"]').count()) === 0 &&
        (await ro.page.locator('[data-testid="whiteboard-cancel"]').textContent()) === '닫기',
      'the read-only client has no 저장',
    );
    await shot(ro.page, 'readonly-modal');
    await ro.page.keyboard.press('Escape');
    await ro.ctx.close();
    check(onDisk()[alpha.uid].text === MEMO, 'the read-only client changed nothing');
    await desk.ctx.close();

    // ── Phone ──
    const ph = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
      userAgent: IPHONE,
    });
    const phone = ph.page;
    await phone.waitForTimeout(1200);
    const beta = ph.boards().find((b) => b.uid === board('beta'))!;
    await bringIntoView(phone, beta, { x: 196, y: 330 }, true);
    check(
      (await overlays(phone, beta.uid).count()) === 0,
      'phone: before saving, beta has no overlay',
    );
    await shot(phone, 'phone-before');
    const pf = await footprint(phone, beta);
    await phone.touchscreen.tap(pf.center.x, pf.center.y);
    await modal(phone).waitFor({ timeout: 3_000 });
    const mb = (await phone.locator('.pointer-events-auto').last().boundingBox())!;
    check(
      mb.x >= 0 && mb.x + mb.width <= 393 && mb.y >= 0 && mb.y + mb.height <= 852,
      `phone: the modal is inside the screen (${Math.round(mb.x)},${Math.round(mb.y)} ${Math.round(mb.width)}x${Math.round(mb.height)})`,
    );
    await modal(phone).fill('폰에서 적은 메모\nwritten on a phone');
    await shot(phone, 'phone-modal');
    await phone.locator('[data-testid="whiteboard-save"]').tap();
    await overlays(phone, beta.uid).waitFor({ timeout: 5_000 });
    check(
      (await overlays(phone, beta.uid).textContent()) === '폰에서 적은 메모\nwritten on a phone',
      'phone: the overlay shows the memo on that board',
    );
    check(onDisk()[beta.uid].by === 'ios', `phone: the memo is by ${onDisk()[beta.uid].by}`);
    await phone.mouse.move(5, 5);
    await shot(phone, 'phone-office');
    await shot(phone, 'phone-memo-closeup', clipAround(await footprint(phone, beta), 60));

    check(pageErrors.length === 0, `no page errors ${JSON.stringify(pageErrors)}`);
    await ph.ctx.close();
  } catch (err) {
    console.error(daemon.log.join('').slice(-3000));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser.close();
    await daemon.stop();
  }
}

main().then(
  () => {
    console.log('all checks passed');
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

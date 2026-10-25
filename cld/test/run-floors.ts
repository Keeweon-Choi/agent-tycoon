/**
 * T-0027 check (floors): dist/cli.js with an isolated HOME (fake office and
 * claude, S-8) on a spare port, logged in, in headless Chromium. The real
 * claude and office are never run, and no office action is allowed (no
 * --allow-actions: floor changes are cosmetic and still work).
 *
 * T-0049 adds the default stacked cross-section: higher floors above floor 1,
 * translucent other floors with bubbles, click/tap switching without doors,
 * one-floor persistence, and 4× throttled phone render measurements.
 *
 * Desktop 1280×800: the elevator panel with one floor; 편집 → 층 추가; a room
 * dragged onto the new floor's button moves there (its characters leave
 * floor 1); 층 이름; the 2 key and the panel switch floors behind the doors
 * (under 300 ms), drawing, labelling and hit-testing only the floor shown; a
 * turn that ends on another floor puts the waiting bubble on its button and
 * a permission the permission bubble; a character dragged off the canvas onto
 * a floor button rides there alone, a visit of this browser's (ELEVATOR: nothing
 * is sent, office is never asked); the building survives a
 * daemon restart; 층 삭제 brings the rooms back to floor 1. Phone 393×852:
 * the floor picker in the top bar (list, swipe up and down, the badge dot),
 * inside the safe area. Screenshots go to cld/artifacts/t0027/.
 *
 *   npx tsx cld/test/run-floors.ts <port 18256-18259>
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  loggedCommands,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  warmUpOffice,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0027');
const OUT49 = path.join(REPO_ROOT, 'cld/artifacts/t0049');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
// Hangul from Malgun Gothic (read only), everything else the pixel font.
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0027/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
/** An iPhone's notch and home indicator, as T-0008's vars carry them. */
const SAFE_AREA =
  ':root { --cld-safe-top: 47px; --cld-safe-bottom: 34px; --cld-safe-right: 20px; }';
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

async function until(what: string, fn: () => Promise<boolean>, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
}

type Floor = { id: string; name: string; rooms: string[]; characters: string[] };
type Building = { floors: Floor[]; perProject: boolean };
type Hooks = {
  getTileCenter: (c: number, r: number) => { x: number; y: number } | null;
  getOtherFloorStats: () => { renders: number; ms: number };
};
type Rect = { id: string; row: number; rows: number; cols: number };
const otherAlpha = (a: number) => a > 40 && a < 160;
/** Expected display displacement, independently from the webview's stackShifts. */
const shiftRows = (r1: Rect, r2: Rect) => {
  const gap = r2.row - r1.row - r1.rows;
  return r1.row - r2.row - (r2.rows + gap);
};

async function tilePoint(page: Page, col: number, row: number) {
  return page.evaluate(
    ({ col, row }) =>
      (window as unknown as { __pixelAgentsTestHooks: Hooks }).__pixelAgentsTestHooks.getTileCenter(
        col,
        row,
      ),
    { col, row },
  );
}

async function probe(page: Page, rows: number[], cols: number[]) {
  // An office nobody touches draws at OFFICE_IDLE_FPS (T-0075): a pointer move on
  // it and two frames make sure the pixels read show the state just set.
  await page.evaluate(async () => {
    const canvas = document.querySelector('[data-testid="office-canvas"]')!;
    canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r));
  });
  return page.evaluate(
    ({ rows, cols }) => {
      const h = (window as unknown as { __pixelAgentsTestHooks: Hooks }).__pixelAgentsTestHooks;
      const canvas = document.querySelector('[data-testid="office-canvas"]') as HTMLCanvasElement;
      const r = canvas.getBoundingClientRect();
      const ctx = canvas.getContext('2d')!;
      const out: number[] = [];
      for (const row of rows) {
        for (const col of cols) {
          const p = h.getTileCenter(col, row)!;
          if (p.x < 0 || p.y < 0 || p.x >= r.width || p.y >= r.height) continue;
          const d = devicePixelRatio;
          out.push(ctx.getImageData(Math.floor(p.x * d), Math.floor(p.y * d), 1, 1).data[3]);
        }
      }
      return out;
    },
    { rows, cols },
  );
}

async function zoomOutForProbes(page: Page, rows: number[], cols: number[]) {
  // Zoom out (about the canvas centre) while that still changes the zoom; a tall
  // stack can still overflow the canvas at the smallest zoom (and a phone does not
  // wheel-zoom), so then pan with the arrow keys towards the probes' middle.
  let zoomed = true;
  for (let i = 0; i < 30; i++) {
    if ((await probe(page, rows, cols)).length === rows.length * cols.length) return;
    const box = (await page.getByTestId('office-canvas').boundingBox())!;
    if (zoomed) {
      const before = await tilePoint(page, 0, 0);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, 120);
      await page.keyboard.up('Control');
      await page.waitForTimeout(600);
      const after = await tilePoint(page, 0, 0);
      zoomed = JSON.stringify(before) !== JSON.stringify(after);
      continue;
    }
    const pts = await Promise.all(
      rows.flatMap((r) => cols.map(async (c) => (await tilePoint(page, c, r))!)),
    );
    const mid = (v: number[]) => (Math.min(...v) + Math.max(...v)) / 2;
    const dx = mid(pts.map((p) => p.x)) - box.width / 2;
    const dy = mid(pts.map((p) => p.y)) - box.height / 2;
    const key =
      Math.abs(dy) >= Math.abs(dx)
        ? dy < 0
          ? 'ArrowUp'
          : 'ArrowDown'
        : dx < 0
          ? 'ArrowLeft'
          : 'ArrowRight';
    await page.keyboard.down(key);
    await page.waitForTimeout(150);
    await page.keyboard.up(key);
    await page.waitForTimeout(400);
  }
  check(false, `probe tiles ${rows} x ${cols} fit the canvas after zooming out / panning`);
}

/** 설정 has no Escape handler (the shared Modal): close it with its own x button. */
async function closeOptions(page: Page) {
  await page.getByRole('dialog').last().getByRole('button', { name: 'x', exact: true }).click();
  await page.getByTestId('floor-view-option').waitFor({ state: 'detached' });
}

async function countRaf(page: Page, ms: number) {
  return page.evaluate(
    (duration) =>
      new Promise<number>((resolve) => {
        const start = performance.now();
        let frames = 0;
        const tick = () => {
          if (performance.now() - start >= duration) resolve(frames);
          else {
            frames++;
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(OUT49, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const launch = () => startDaemon(fake, port, ['--no-terminal']);
  const etaFile = path.join(
    fake.home,
    '.claude/projects/-work-orch-gamma/a0000007-0000-4000-8000-000000000007.jsonl',
  );
  const buildingFile = path.join(fake.home, '.config/cld-gui/building.json');
  const received: Array<Record<string, unknown>> = [];
  const pageErrors: string[] = [];
  const font = fs.readFileSync(FONT);
  const browser = await launchBrowser();

  const open = async (opts: BrowserContextOptions, view?: 'one') => {
    const ctx = await browser.newContext(opts);
    await ctx.route('**/__t0027/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    // Upstream's e2e flag: canvas geometry (getTileCenter), nothing that drives the app.
    await ctx.addInitScript(() => {
      const w = window as unknown as {
        __PIXEL_AGENTS_E2E: boolean;
        __name: (f: unknown) => unknown;
      };
      w.__name = (f) => f; // tsx keeps function names with an __name() helper the page lacks
      w.__PIXEL_AGENTS_E2E = true;
    });
    if (view === 'one')
      await ctx.addInitScript(() => {
        if (!localStorage.getItem('cld.floor-view')) localStorage.setItem('cld.floor-view', 'one');
      });
    await warmUpOffice(ctx, daemon);
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
  const login = async (page: Page) => {
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(BASE);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(1500); // spawn effects, characters reach their seats
  };
  const building = () =>
    [...received].reverse().find((m) => m.type === 'buildingState') as unknown as Building;
  const agentId = (name: string) => {
    const office = [...received].reverse().find((m) => m.type === 'officeSnapshot') as {
      orchestrators: Array<{ name: string; agentId: number | null }>;
    };
    return office.orchestrators.find((o) => o.name === name)!.agentId!;
  };
  const shot49 = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT49, `${name}.png`) });
  const shot = (page: Page, name: string, animations: 'allow' | 'disabled' = 'allow') =>
    page.screenshot({ path: path.join(OUT, `${name}.png`), animations });
  const label = (page: Page, name: string) =>
    page.locator(`[data-testid="agent-overlay"][data-agent-id="${agentId(name)}"]`);
  const shows = async (page: Page, name: string) => (await label(page, name).count()) > 0;
  const floorButton = (page: Page, id: string) =>
    page.locator(`.cld-elevator [data-floor-id="${id}"]`);
  const current = (page: Page) =>
    page.locator('.cld-elevator [aria-current="true"]').getAttribute('data-floor-id');
  const append = (...records: unknown[]) =>
    fs.appendFileSync(etaFile, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  let toolSeq = 0;
  /** eta (on the other floor) works a moment, then ends its turn. */
  const etaTurn = async () => {
    const id = `tu-floor-${++toolSeq}`;
    append({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/work/eta/a.py' } }],
      },
    });
    await new Promise((r) => setTimeout(r, 1500));
    append(
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      },
      { type: 'system', subtype: 'turn_duration', durationMs: 1500 },
    );
  };
  const doorsGone = (page: Page) =>
    page.waitForFunction(() => !document.querySelector('[data-testid="elevator-doors"]'));

  let daemon = launch();
  try {
    // ════ Desktop 1280×800 ════
    const { ctx: desk, page } = await open(DESKTOP, 'one');
    await login(page);
    check(building()?.floors.length === 1, 'desktop: one floor without building.json');
    check(!fs.existsSync(buildingFile), 'desktop: nothing written before a floor change');
    await page.locator('.cld-elevator').waitFor();
    check(
      !(await floorButton(page, '1').isVisible()) &&
        (await page.getByTestId('elevator-display').innerText()).includes('1F') &&
        (await page.locator('.cld-elevator-edit').isVisible()),
      'desktop: with one floor the elevator panel is just "1F" and 편집 (no button to press)',
    );
    await shot(page, 'desktop-one-floor');

    // 편집 → 층 추가.
    await page.locator('.cld-elevator-edit').click();
    await page.getByTestId('floor-editor').waitFor();
    await page.getByRole('button', { name: '층 추가' }).click();
    await until('a second floor', async () => building().floors.length === 2);
    const f2 = building().floors[1].id;
    check(
      JSON.parse(fs.readFileSync(buildingFile, 'utf-8')).floors.length === 2,
      `desktop: 층 추가 makes floor 2 ("${building().floors[1].name}"), written to building.json`,
    );

    // A room dragged onto floor 2's button moves there with its characters.
    check(
      (await shows(page, 'eta')) && (await shows(page, 'alpha')),
      'desktop: before the move eta (orch-gamma) and alpha are both on floor 1',
    );
    const chip = page.locator('[data-testid="floor-editor"] .cld-chip', { hasText: 'orch-gamma' });
    await chip.dragTo(floorButton(page, f2));
    await until('orch-gamma on floor 2', async () =>
      building().floors[1].rooms.includes('orch-gamma'),
    );
    await page.waitForTimeout(400);
    check(
      !building().floors[0].rooms.includes('orch-gamma'),
      'desktop: a room chip dragged onto the floor 2 button puts orch-gamma on floor 2',
    );
    // ELEVATOR step 2: the room's characters walk to the elevator and ride up, so they leave
    // floor 1's view after the ride, not at once.
    await until(
      'eta and theta ride up',
      async () => !(await shows(page, 'eta')) && !(await shows(page, 'theta')),
      30_000,
    );
    check(
      await shows(page, 'alpha'),
      'desktop: eta and theta left floor 1 (no labels drawn there, after their ride); alpha stayed',
    );

    // 층 이름.
    await page.locator(`[data-floor-row="${f2}"]`).getByRole('button', { name: '층 이름' }).click();
    const nameInput = page.locator(`[data-floor-row="${f2}"] input`);
    await nameInput.fill('연구동');
    await nameInput.press('Enter');
    await until('renamed', async () => building().floors[1].name === '연구동');
    check(true, 'desktop: 층 이름 renames floor 2 to 연구동');
    await page.mouse.move(640, 400);
    await page.waitForTimeout(300);
    await shot(page, 'desktop-editor');

    // The 2 key: doors, then floor 2, in under 300 ms.
    await page.locator('.cld-elevator-edit').click(); // editor closed
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // Each ride: from the key press to the doors gone, in the page's own clock.
    await page.evaluate(() => {
      const w = window as unknown as { __t0: number; __rides: number[] };
      w.__rides = [];
      window.addEventListener('keydown', () => (w.__t0 = performance.now()), { capture: true });
      new MutationObserver(() => {
        if (w.__t0 && !document.querySelector('[data-testid="elevator-doors"]')) {
          w.__rides.push(performance.now() - w.__t0);
          w.__t0 = 0;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.keyboard.press('2');
    await page.waitForTimeout(40);
    await shot(page, 'desktop-doors', 'disabled'); // the closing doors fast-forwarded: shut
    await doorsGone(page);
    // Two more rides without a screenshot in them; a busy machine only adds
    // to a ride, so the shortest one is the elevator's own time.
    for (const key of ['1', '2']) {
      await page.waitForTimeout(300);
      await page.keyboard.press(key);
      await doorsGone(page);
    }
    const rides = await page.evaluate(() => (window as unknown as { __rides: number[] }).__rides);
    const took = Math.min(...rides);
    check(
      rides.length === 3 && took > 200 && took < 300,
      `desktop: the number keys ride the elevator in ${took.toFixed(0)} ms (< 300; rides ${rides.map((r) => r.toFixed(0)).join(', ')} ms)`,
    );
    await page.waitForTimeout(300);
    check(
      (await current(page)) === f2 &&
        (await page.getByTestId('elevator-display').innerText()).includes('2F'),
      'desktop: floor 2 is lit, "2F" on the display',
    );
    check(
      (await shows(page, 'eta')) && !(await shows(page, 'alpha')),
      'desktop: on floor 2 eta is drawn and labelled, alpha (floor 1) is not',
    );
    // The canvas draws only floor 2: floor 1's bottom rows, just above it in
    // the stacked map and in view, stay blank; floor 2's own tiles are drawn.
    const layout = [...received].reverse().find((m) => m.type === 'layoutLoaded') as {
      layout: { cldFloors: Array<{ id: string; row: number; rows: number; cols: number }> };
    };
    let [r1, r2] = layout.layout.cldFloors;
    const cols = [2, 5, 8];
    // The camera may sit so that floor 1's rows are out of view: zoom out (Ctrl+wheel) until they are.
    let above = await probe(page, [r1.rows - 3, r1.rows - 2], cols);
    for (let i = 0; i < 4 && !above.length; i++) {
      const box = (await page.getByTestId('office-canvas').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, 120);
      await page.keyboard.up('Control');
      await page.waitForTimeout(600);
      above = await probe(page, [r1.rows - 3, r1.rows - 2], cols);
    }
    const own = await probe(page, [r2.row + 3, r2.row + 4], cols);
    check(
      above.length > 0 && above.every((a) => a === 0) && own.length > 0 && own.every((a) => a > 0),
      `desktop: floor 1's tiles in view are not drawn while floor 2 shows (${above.length} probes blank), floor 2's are (${own.length})`,
    );
    await shot(page, 'desktop-floor-2');

    // The panel button back to floor 1.
    await floorButton(page, '1').click();
    await doorsGone(page);
    await page.waitForTimeout(300);
    check(
      (await current(page)) === '1' && (await shows(page, 'alpha')) && !(await shows(page, 'eta')),
      'desktop: the floor 1 button rides back down; alpha shows, eta does not',
    );

    // A turn that ends on floor 2: the waiting bubble on its button.
    await etaTurn();
    await until(
      'the waiting badge',
      async () => (await floorButton(page, f2).locator('[data-badge="waiting"]').count()) === 1,
    );
    check(true, 'desktop: eta ends its turn on floor 2 -> the waiting bubble on the 2 button');
    check(
      (await floorButton(page, '1').locator('[data-badge]').count()) === 0,
      'desktop: the floor shown has no badge',
    );
    await shot(page, 'desktop-waiting-badge');
    // A permission there wins (the 7 s permission rule on an unanswered Bash).
    append({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu-perm', name: 'Bash', input: { command: 'make deploy' } },
        ],
      },
    });
    await until(
      'the permission badge',
      async () => (await floorButton(page, f2).locator('[data-badge="permission"]').count()) === 1,
      15_000,
    );
    check(true, 'desktop: a permission wait on floor 2 -> the permission bubble on the 2 button');
    await shot(page, 'desktop-permission-badge');
    // Looking at floor 2 answers the badge.
    await page.keyboard.press('2');
    await doorsGone(page);
    await page.waitForTimeout(500);
    check(
      (await page.locator('.cld-elevator [data-badge]').count()) === 0,
      'desktop: on floor 2 no button has a badge (its bubbles are on screen)',
    );
    await page.keyboard.press('1');
    await doorsGone(page);
    append({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-perm', content: 'ok' }] },
    });
    await page.waitForTimeout(1500);
    check(
      (await floorButton(page, f2).locator('[data-badge]').count()) === 0,
      'desktop: answered and seen, floor 2 has no badge any more',
    );

    // A character dragged off the canvas onto a floor button rides there alone (ELEVATOR: a
    // visit of this browser's; the building does not change).
    // Its label's top is 34 CSS px above (feet - 32 world px); the hit box
    // is the 24 world px above the feet.
    const box = (await label(page, 'alpha').first().boundingBox())!;
    const scale = await page.evaluate(() => {
      const h = (window as unknown as { __pixelAgentsTestHooks: Hooks }).__pixelAgentsTestHooks;
      return (h.getTileCenter(1, 0)!.x - h.getTileCenter(0, 0)!.x) / 16;
    });
    const from = { x: box.x + box.width / 2, y: box.y + 34 + 20 * scale };
    const to = (await floorButton(page, f2).boundingBox())!;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 30, from.y + 10, { steps: 6 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.waitForTimeout(100);
    await shot(page, 'desktop-drag-character');
    await page.mouse.up();
    await until('alpha rode to floor 2', async () => !(await shows(page, 'alpha')), 20_000);
    check(
      !(await shows(page, 'alpha')) &&
        (await shows(page, 'beta')) &&
        !building().floors[1].characters.includes('alpha'),
      'desktop: alpha dragged onto the 2 button rode up alone (beta, its roommate, stayed; the building is unchanged)',
    );
    check(
      loggedCommands(fake.officeLog).every((c) => c !== 'edit' && c !== 'tab'),
      'desktop: office was never asked to move anything (no `office edit`, no `office tab`)',
    );

    // The building survives a daemon restart; this browser remembers the floor.
    await page.keyboard.press('2');
    await doorsGone(page);
    await daemon.stop();
    daemon = launch();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(BASE);
    await page.addStyleTag({ content: FONT_CSS });
    await page.locator('.cld-elevator [aria-current="true"]').waitFor();
    await page.waitForTimeout(1500);
    const kept = building();
    check(
      kept.floors[1].name === '연구동' && kept.floors[1].rooms.includes('orch-gamma'),
      'desktop: after a daemon restart floor 2 is still 연구동 with orch-gamma',
    );
    // The characters come back a moment after the page does: this roster is read
    // through `claude agents --json`, at most every 30 s (a loaded machine took 45 s).
    await until('eta is drawn again', async () => await shows(page, 'eta'), 60_000).catch(
      () => undefined,
    );
    const reloaded = {
      floor: await current(page),
      alpha: await shows(page, 'alpha'),
      eta: await shows(page, 'eta'),
    };
    console.log(
      `after the restart: ${JSON.stringify(reloaded)} (floor 2 is ${f2}); eta: ${JSON.stringify(
        await page.evaluate(`window.__pixelAgentsTestHooks.getCharacterTile(${agentId('eta')})`),
      )}; floors ${JSON.stringify(([...received].reverse().find((m) => m.type === 'layoutLoaded') as { layout: { cldFloors?: unknown } } | undefined)?.layout.cldFloors)}`,
    );
    check(
      reloaded.floor === f2 && !reloaded.alpha && reloaded.eta,
      "desktop: a reload opens on the floor this browser was on (2), eta there (alpha's visit ended with the page)",
    );
    await shot(page, 'desktop-floor-2-after-restart');

    // ════ T-0049 stacked desktop, fresh browser setting ════
    const { ctx: stackCtx, page: stackPage } = await open(DESKTOP);
    await login(stackPage);
    // The office may have changed since r1/r2 were read: use the latest layout.
    [r1, r2] = (
      [...received].reverse().find((m) => m.type === 'layoutLoaded') as typeof layout
    ).layout.cldFloors;
    console.log(`T-0049 floors: ${JSON.stringify([r1, r2])}`);
    await stackPage.getByRole('button', { name: '설정' }).click();
    await stackPage.getByRole('tab', { name: '화면', exact: true }).click();
    const option = stackPage.getByTestId('floor-view-option');
    check(
      (await option.getByRole('button', { name: '모든 층 보기' }).getAttribute('aria-pressed')) ===
        'true',
      'desktop stacked: every floor is the default setting',
    );
    await closeOptions(stackPage);
    await stackPage.evaluate(() => {
      const w = window as unknown as { __doorAdds: number };
      w.__doorAdds = 0;
      new MutationObserver((changes) => {
        for (const change of changes)
          for (const node of change.addedNodes)
            if (
              node instanceof Element &&
              (node.matches('[data-testid="elevator-doors"]') ||
                node.querySelector('[data-testid="elevator-doors"]'))
            )
              w.__doorAdds++;
      }).observe(document.body, { childList: true, subtree: true });
    });
    await stackPage.keyboard.press('1');
    await until('stacked floor 1 chosen', async () => (await current(stackPage)) === '1', 100);
    check(
      (await stackPage.evaluate(() => (window as unknown as { __doorAdds: number }).__doorAdds)) ===
        0,
      'desktop stacked: key 1 selects immediately with no doors',
    );
    const lifted = shiftRows(r1, r2);
    const topRows = [r2.row + 3 + lifted, r2.row + 4 + lifted];
    const bottomRows = [r1.row + 3, r1.row + 4];
    await zoomOutForProbes(stackPage, [...topRows, ...bottomRows], cols);
    const topPixels = await probe(stackPage, topRows, cols);
    const bottomPixels = await probe(stackPage, bottomRows, cols);
    check(
      topPixels.length === 6 &&
        topPixels.every(otherAlpha) &&
        bottomPixels.length === 6 &&
        bottomPixels.every((a) => a === 255) &&
        bottomPixels.every((a) => !otherAlpha(a)),
      `desktop stacked: upper floor translucent (${topPixels}), floor 1 opaque (${bottomPixels})`,
    );
    const topPoint = (await tilePoint(stackPage, 5, topRows[0]))!;
    const bottomPoint = (await tilePoint(stackPage, 5, bottomRows[0]))!;
    check(topPoint.y < bottomPoint.y, 'desktop stacked: floor 2 is above floor 1');
    await shot49(stackPage, 'desktop-stacked');
    check(!(await shows(stackPage, 'eta')), 'desktop stacked: other-floor eta has no label');
    append({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu-perm-49', name: 'Bash', input: { command: 'make deploy' } },
        ],
      },
    });
    const bubble = stackPage.locator(
      `[data-testid="agent-bubble"][data-agent-id="${agentId('eta')}"][data-other-floor][data-bubble="permission"]`,
    );
    await bubble.waitFor({ timeout: 15_000 });
    const bubbleBox = (await bubble.boundingBox())!;
    const floorOneTop = (await tilePoint(stackPage, 5, r1.row))!;
    const canvasTop = (await stackPage.getByTestId('office-canvas').boundingBox())!.y;
    check(
      (await bubble.isVisible()) &&
        (await bubble.evaluate((el) => getComputedStyle(el).opacity)) === '1' &&
        bubbleBox.y + bubbleBox.height < canvasTop + floorOneTop.y,
      'desktop stacked: other-floor permission bubble is opaque and above floor 1',
    );
    await shot49(stackPage, 'desktop-stacked-permission');

    // Sample the first and following frames to detect a jump, a glide, and settling.
    await stackPage.evaluate(
      ({ floorId, row }) => {
        const w = window as unknown as { __glide: number[] };
        w.__glide = [];
        const start = performance.now();
        const tick = () => {
          if (
            document.querySelector(
              `.cld-elevator [data-floor-id="${floorId}"][aria-current="true"]`,
            )
          ) {
            const h = (window as unknown as { __pixelAgentsTestHooks: Hooks })
              .__pixelAgentsTestHooks;
            w.__glide.push(h.getTileCenter(5, row)!.y);
          }
          if (performance.now() - start < 1000) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { floorId: f2, row: r2.row + 3 },
    );
    const y0 = topPoint.y;
    const canvasBox = (await stackPage.getByTestId('office-canvas').boundingBox())!;
    await stackPage.mouse.click(canvasBox.x + topPoint.x, canvasBox.y + topPoint.y);
    await until('clicked floor 2', async () => (await current(stackPage)) === f2);
    await stackPage.waitForTimeout(1050);
    const glide = await stackPage.evaluate(
      () => (window as unknown as { __glide: number[] }).__glide,
    );
    const final = glide.at(-1)!;
    check(
      glide.length >= 5 &&
        Math.abs(glide[0] - y0) < 0.6 * Math.abs(final - y0) &&
        new Set(glide).size >= 3 &&
        glide.slice(-5).every((y) => y === final),
      `desktop stacked: click keeps the picture in place then glides and settles (${glide.length} samples)`,
    );
    const floorCenter = (await tilePoint(
      stackPage,
      Math.floor(r2.cols / 2),
      r2.row + Math.floor(r2.rows / 2),
    ))!;
    const oneTile =
      (await tilePoint(stackPage, 1, r2.row))!.x - (await tilePoint(stackPage, 0, r2.row))!.x;
    check(
      Math.abs(floorCenter.x - canvasBox.width / 2) <= oneTile &&
        Math.abs(floorCenter.y - canvasBox.height / 2) <= oneTile,
      `desktop stacked: the camera centres the selected floor (centre ${floorCenter.x},${floorCenter.y}; canvas ${canvasBox.width}x${canvasBox.height}; tile ${oneTile}; glide ${glide[0]}..${final}, y0 ${y0})`,
    );
    const lowerLifted = bottomRows.map((row) => row - lifted);
    const lowerPixels = await probe(stackPage, lowerLifted, cols);
    check(
      lowerPixels.length === 6 && lowerPixels.every(otherAlpha),
      'desktop stacked: floor 1 becomes translucent after the click',
    );
    check(
      (await stackPage.evaluate(() => (window as unknown as { __doorAdds: number }).__doorAdds)) ===
        0,
      'desktop stacked: clicking the translucent floor made no doors',
    );
    await shot49(stackPage, 'desktop-stacked-floor-2');
    await floorButton(stackPage, '1').click();
    await until('stacked panel floor 1', async () => (await current(stackPage)) === '1');
    await stackPage.keyboard.press('2');
    await until('stacked key floor 2', async () => (await current(stackPage)) === f2);
    check(
      (await stackPage.evaluate(() => (window as unknown as { __doorAdds: number }).__doorAdds)) ===
        0,
      'desktop stacked: panel and number key switch without doors',
    );
    append({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-perm-49', content: 'ok' }] },
    });
    await stackPage.waitForTimeout(1500);
    await stackPage.getByRole('button', { name: '설정' }).click();
    await option.getByRole('button', { name: '한 층만' }).click();
    await closeOptions(stackPage);
    const hiddenPixels = await probe(stackPage, lowerLifted, cols);
    check(
      hiddenPixels.length === 6 && hiddenPixels.every((a) => a === 0),
      `desktop one floor: hidden floor pixels are blank (${hiddenPixels})`,
    );
    await stackPage.reload();
    await stackPage.addStyleTag({ content: FONT_CSS });
    await stackPage.locator('[data-testid="agent-overlay"]').first().waitFor();
    await stackPage.getByRole('button', { name: '설정' }).click();
    check(
      (await option.getByRole('button', { name: '한 층만' }).getAttribute('aria-pressed')) ===
        'true',
      'desktop one floor: setting survived reload',
    );
    await closeOptions(stackPage);
    await zoomOutForProbes(stackPage, lowerLifted, cols); // a reload resets the zoom
    const hiddenReloaded = await probe(stackPage, lowerLifted, cols);
    check(
      hiddenReloaded.length === 6 && hiddenReloaded.every((a) => a === 0),
      `desktop one floor: hidden floor stays blank after reload (${hiddenReloaded})`,
    );
    await stackCtx.close();

    // ════ Phone 393×852 ════
    const { ctx: phoneCtx, page: phone } = await open(PHONE);
    await login(phone);
    const picker = phone.getByTestId('floor-picker');
    check(
      (await picker.isVisible()) && (await picker.innerText()).includes('1F'),
      'phone: the floor picker in the top bar says 1F',
    );
    check((await phone.locator('.cld-elevator').count()) === 0, 'phone: no desktop elevator panel');
    await phone.addStyleTag({ content: SAFE_AREA });
    await phone.waitForTimeout(200);
    // The phone canvas cannot hold both probe rows at once: look at each floor in turn.
    await zoomOutForProbes(phone, topRows, cols);
    const phoneTop = await probe(phone, topRows, cols);
    await zoomOutForProbes(phone, bottomRows, cols);
    const phoneBottom = await probe(phone, bottomRows, cols);
    check(
      phoneTop.length === 6 &&
        phoneTop.every(otherAlpha) &&
        phoneBottom.length === 6 &&
        phoneBottom.every((a) => a === 255),
      `phone stacked: upper floor translucent (${phoneTop}), floor 1 opaque (${phoneBottom})`,
    );
    // The boundary in view for the picture: floor 2's lowest row over floor 1's top rows.
    await zoomOutForProbes(phone, [r2.row + r2.rows - 1 + lifted, r1.row + 3], [5]);
    await shot49(phone, 'phone-stacked');
    const phoneCanvas = (await phone.getByTestId('office-canvas').boundingBox())!;
    await zoomOutForProbes(phone, [topRows[0]], [5]);
    const phoneUpper = (await tilePoint(phone, 5, topRows[0]))!;
    await phone.touchscreen.tap(phoneCanvas.x + phoneUpper.x, phoneCanvas.y + phoneUpper.y);
    await until('phone tap floor 2', async () => (await picker.innerText()).includes('2F'));
    await phone.waitForTimeout(800);
    await zoomOutForProbes(phone, [bottomRows[0] - lifted], [5]);
    const phoneLower = (await tilePoint(phone, 5, bottomRows[0] - lifted))!;
    await phone.touchscreen.tap(phoneCanvas.x + phoneLower.x, phoneCanvas.y + phoneLower.y);
    await until('phone tap floor 1', async () => (await picker.innerText()).includes('1F'));
    await phone.waitForTimeout(800);

    const cdpPerf = await phone.context().newCDPSession(phone);
    await cdpPerf.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await phone.waitForTimeout(1000);
    const stats = () =>
      phone.evaluate(() =>
        (
          window as unknown as { __pixelAgentsTestHooks: Hooks }
        ).__pixelAgentsTestHooks.getOtherFloorStats(),
      );
    const beforePerf = await stats();
    const fpsAll = await countRaf(phone, 3000);
    const afterAll = await stats();
    const rendersPer3s = afterAll.renders - beforePerf.renders;
    const msPerRender = rendersPer3s ? (afterAll.ms - beforePerf.ms) / rendersPer3s : 0;
    check(
      rendersPer3s >= 3 && rendersPer3s <= 9,
      `phone perf: ${rendersPer3s} other-floor redraws in 3 s`,
    );
    await phone.getByRole('button', { name: '설정' }).click();
    await phone.getByRole('tab', { name: '화면', exact: true }).click();
    const phoneOption = phone.getByTestId('floor-view-option');
    await phoneOption.getByRole('button', { name: '한 층만' }).click();
    await closeOptions(phone);
    await phone.waitForTimeout(1000);
    const beforeOne = await stats();
    const fpsOne = await countRaf(phone, 3000);
    const afterOne = await stats();
    check(
      afterOne.renders === beforeOne.renders,
      'phone perf: one-floor mode draws no other floors',
    );
    check(
      fpsAll >= 0.75 * fpsOne,
      `phone perf: rAF count ${fpsAll} stacked vs ${fpsOne} one-floor`,
    );
    const perf = { rendersPer3s, msPerRender, fpsAll, fpsOne, throttle: 4 };
    fs.writeFileSync(path.join(OUT49, 'perf.json'), `${JSON.stringify(perf, null, 2)}\n`);
    console.log(`T-0049 phone perf: ${JSON.stringify(perf)}`);
    await phone.getByRole('button', { name: '설정' }).click();
    await phoneOption.getByRole('button', { name: '모든 층 보기' }).click();
    await closeOptions(phone);
    await cdpPerf.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdpPerf.detach();
    await picker.tap();
    const list = phone.locator('.cld-floor-list');
    await list.waitFor();
    check(
      (await list.locator('button').count()) === 2 &&
        (await list.locator('button').first().innerText()).includes('연구동'),
      'phone: a tap lists the floors, top floor first',
    );
    const bar = await phone.evaluate(() => {
      const pick = document.querySelector('[data-testid="floor-picker"]')!;
      const top = pick.closest('.pixel-panel')!;
      const l = document.querySelector('.cld-floor-list')!.getBoundingClientRect();
      return {
        pad: parseFloat(getComputedStyle(top).paddingTop),
        pickTop: pick.getBoundingClientRect().top,
        pickBottom: pick.getBoundingClientRect().bottom,
        list: { left: l.left, right: l.right, top: l.top },
        width: innerWidth,
      };
    });
    check(
      bar.pad === 55 && bar.pickTop >= 47,
      `phone: the top bar clears the notch (padding ${bar.pad} px; the picker at ${bar.pickTop.toFixed(0)} px)`,
    );
    check(
      bar.list.left >= 0 && bar.list.right <= bar.width - 20 && bar.list.top >= bar.pickBottom,
      `phone: the floor list opens under the picker inside the safe area (x ${bar.list.left.toFixed(0)}-${bar.list.right.toFixed(0)} of ${bar.width}, safe right 20)`,
    );
    await shot(phone, 'phone-floor-list');
    await list.locator(`[data-floor-id="${f2}"]`).tap();
    await doorsGone(phone);
    await phone.waitForTimeout(400);
    check((await picker.innerText()).includes('2F'), 'phone: tapping floor 2 rides there (2F)');
    // Swipes on the picker: down = a floor down, up = a floor up.
    const swipe = async (dy: number) => {
      const b = (await picker.boundingBox())!;
      const cdp = await phone.context().newCDPSession(phone);
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 1 }],
      });
      for (let i = 1; i <= 8; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: y + (dy * i) / 8, id: 1 }],
        });
        await phone.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
      await doorsGone(phone);
      await phone.waitForTimeout(300);
    };
    await swipe(60);
    check(
      (await picker.innerText()).includes('1F'),
      'phone: a swipe down on the picker goes to floor 1',
    );
    await swipe(-60);
    check((await picker.innerText()).includes('2F'), 'phone: a swipe up goes back to floor 2');
    check(
      (await phone.locator('.cld-floor-list').count()) === 0,
      'phone: a swipe is no tap (the list stays shut)',
    );
    await shot(phone, 'phone-floor-2');
    await swipe(60); // floor 1, then eta (floor 2) ends a turn: the dot
    await etaTurn();
    await until(
      'the phone badge dot',
      async () => (await picker.locator('.cld-dot').count()) === 1,
    );
    check(true, 'phone: a turn ending on floor 2 lights the dot on the picker');
    await picker.tap();
    await list.waitFor();
    check(
      (await list.locator(`[data-floor-id="${f2}"] [data-badge="waiting"]`).count()) === 1,
      'phone: the list shows the waiting bubble on floor 2',
    );
    await shot(phone, 'phone-badge');
    await picker.tap();
    await phoneCtx.close();

    // 층 삭제 (desktop): its rooms back to floor 1, after a confirmation.
    await page.locator('.cld-elevator-edit').click();
    const removeButton = page
      .locator(`[data-floor-row="${f2}"]`)
      .getByRole('button', { name: '층 삭제' });
    await removeButton.click();
    const question = page.getByText('‘연구동’ 층을 지울까요?');
    await question.waitFor();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check(
      (await question.count()) === 0 && building().floors.length === 2,
      'desktop: Esc cancels 층 삭제 (nothing removed)',
    );
    await removeButton.click();
    await question.waitFor();
    const dialog = await question.evaluate((el) => {
      const panel = el.closest('.shadow-pixel')!.getBoundingClientRect();
      return { x: panel.x + panel.width / 2, y: panel.y + panel.height / 2 };
    });
    check(
      Math.abs(dialog.x - 640) < 4 && Math.abs(dialog.y - 400) < 4,
      `desktop: the 층 삭제 question sits in the middle of the window (${dialog.x.toFixed(0)}, ${dialog.y.toFixed(0)})`,
    );
    await shot(page, 'desktop-remove-confirm');
    await page.getByRole('button', { name: '삭제', exact: true }).click();
    await until('one floor again', async () => building().floors.length === 1);
    await doorsGone(page);
    await page.waitForTimeout(800);
    check(
      building().floors[0].rooms.includes('orch-gamma') &&
        building().floors[0].characters.length === 0,
      'desktop: 층 삭제 brings orch-gamma (and alpha) back to floor 1',
    );
    check(
      (await shows(page, 'alpha')) && (await shows(page, 'eta')) && (await shows(page, 'beta')),
      'desktop: alpha, beta and eta are all on the one floor again',
    );
    await shot(page, 'desktop-removed');

    // 프로젝트마다 층: every room not placed yet gets a floor of its own.
    await page.getByRole('button', { name: '프로젝트마다 층' }).click();
    await until(
      'a floor per room',
      async () => building().perProject && building().floors.length > 2,
    );
    const perRoom = building().floors;
    check(
      perRoom.slice(1).every((f) => f.rooms.length === 1 && f.name === f.rooms[0]) &&
        perRoom[0].rooms.includes('orch-gamma'),
      `desktop: 프로젝트마다 층 gives each unplaced room its own floor (${perRoom.map((f) => `${f.name}: ${f.rooms.join(', ')}`).join(' | ')})`,
    );
    await page.locator('.cld-elevator-edit').click(); // editor closed
    await page.keyboard.press(String(perRoom.length));
    await doorsGone(page);
    await page.waitForTimeout(600);
    check(
      (await current(page)) === perRoom.at(-1)!.id &&
        (await page.locator('.cld-elevator .cld-floor-button').count()) === perRoom.length,
      `desktop: ${perRoom.length} floor buttons; the ${perRoom.length} key reaches the top floor (${perRoom.at(-1)!.name})`,
    );
    await shot(page, 'desktop-per-project');
    await desk.close();
    check(
      pageErrors.length === 0,
      `no page errors${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`,
    );
  } catch (err) {
    console.error(daemon.log.join('').slice(-3000));
    throw err;
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

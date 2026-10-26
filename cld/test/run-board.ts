/**
 * T-0046 check: dist/cli.js with an isolated HOME on a spare port, in headless
 * Chromium (desktop 1280x800, phone 393x852). Nine engine projects (two rooms)
 * and a running job of pofol's; a fake Claude session `lead` makes ten projects.
 * Before the daemon starts, the engine's events.jsonl gets a GPU history: pofol
 * holds the lease, three tickets wait (beta's exclusive), smartglass was moved to
 * the front, gamma timed out, delta's job ended. The HW graphs are the daemon's
 * own sampler (the runner loads the CPU on purpose).
 * - the lobby is drawn with its big board, readable at the default zoom;
 * - the pages turn by themselves (~20 s), hold under the mouse, and each tab shows its page;
 * - the CPU line moves when the CPU load changes;
 * - the queue characters match the queue, and follow a live gpu_cancel;
 * - a click opens the full view; Esc and back close it; the phone works.
 * Screenshots go to cld/artifacts/t0046/.
 *
 *   npx tsx cld/test/run-board.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  writeEngineProjects,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0046');
const DEADLINE_MS = 330_000;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const gpu = (type: string, id: string, at: number, more: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    type,
    ts: ago(at),
    source: 'cli',
    id: `g-1022-${id}`,
    project: id,
    ...more,
  });
/** The GPU history the daemon primes from (HIF §6, §9). */
const GPU_HISTORY = [
  gpu('gpu_queue', 'delta', 40 * MIN, { vram_gib: 2, exclusive: false, label: '평가' }),
  gpu('gpu_lease', 'delta', 39 * MIN, { vram_gib: 2, exclusive: false, waited_s: 60 }),
  gpu('gpu_queue', 'pofol', 25 * MIN, { vram_gib: 6, exclusive: true, label: 'semseg 학습' }),
  gpu('gpu_queue', 'aixon', 12 * MIN, { vram_gib: 2, exclusive: false, label: '추론 시험' }),
  gpu('gpu_queue', 'beta', 9 * MIN, { exclusive: false, label: '전체 평가' }),
  gpu('gpu_queue', 'smartglass', 6 * MIN, { vram_gib: 1, exclusive: false, label: '시험' }),
  gpu('gpu_queue', 'gamma', 5 * MIN, { vram_gib: 1, exclusive: false }),
  gpu('gpu_move', 'smartglass', 4 * MIN, { position: 2 }),
  gpu('gpu_release', 'delta', 0.9 * MIN, { exit: 0 }),
  gpu('gpu_lease', 'pofol', 0.85 * MIN, { vram_gib: 6, exclusive: true, waited_s: 1350 }),
  gpu('gpu_cancel', 'gamma', 0.8 * MIN, { reason: 'wait' }),
];
/** The line after that history, front first: pofol leased, smartglass moved up, gamma gone. */
const LINE = ['smartglass', 'aixon', 'beta'];

/** A Claude Code session `lead` (a `sleep` stands in for its process). */
function startLead(home: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c0460000-0000-4000-8000-000000000001';
  const cwd = '/work/lead';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '');
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
      name: 'lead',
      status: 'busy',
    }),
  );
  return proc;
}

/**
 * CPU load on demand: busy loops of `yes` (the daemon's sampler reads the OS counters).
 * `prlimit --cpu` ends each after 180 CPU-seconds, so a runner killed before `off()` leaves
 * no burner behind (10-22: four ran on for 24 minutes after a timeout).
 */
function burner() {
  const procs: ChildProcess[] = [];
  return {
    on: () => {
      for (let k = 0; k < 4; k++)
        procs.push(spawn('prlimit', ['--cpu=180', 'yes'], { stdio: 'ignore' }));
    },
    off: () => procs.splice(0).forEach((p) => p.kill('SIGKILL')),
  };
}

/** A pofol training job, live: a `sleep` stands in for the process (a record of the engine's job store). */
function startJob(home: string): ChildProcess {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const dir = path.join(home, '.local/state/cld-gui/jobs');
  fs.mkdirSync(dir, { recursive: true });
  const id = '1022-025000-pofol';
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      pid,
      pstart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
      boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim(),
      project: 'pofol',
      cmd: 'python train.py',
      desc: '학습',
      dir: '/work/pofol',
      tab: null,
      tty: false,
      log: path.join(home, 'none.log'),
      started: new Date(Date.now() - 30 * MIN).toISOString(),
      ended: null,
      exit: null,
      source: 'cli',
    }),
  );
  return proc;
}

/** One finger dragged across the office (CDP touch events: Playwright only taps). */
async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
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

const queuers = (page: Page) =>
  page.$$eval('[data-testid="lobby-board"] [data-testid="board-queuer"]', (nodes) =>
    nodes.map((n) => ({
      project: n.getAttribute('data-project'),
      ticket: Number(n.getAttribute('data-ticket')),
      exclusive: n.getAttribute('data-exclusive') === 'true',
    })),
  );

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({});
  const events = path.join(configDirectory(fake.home), 'events.jsonl');
  // T-0063: two rooms of five, and the lead's: wide enough that centring the office
  // puts the lobby board's left end under the elevator panel's column.
  const names = [
    'alpha',
    'pofol',
    'smartglass',
    'aixon',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'zeta',
  ];
  writeEngineProjects(
    fake.home,
    names.map((name, k) => ({
      name,
      folder: path.join(fake.home, 'work', name),
      room: `orch-${k < 5 ? 1 : 2}`,
    })),
  );
  fs.mkdirSync(path.dirname(events), { recursive: true });
  fs.appendFileSync(events, GPU_HISTORY.join('\n') + '\n');
  fs.appendFileSync(
    events,
    JSON.stringify({
      v: 1,
      type: 'job_end',
      ts: ago(3 * MIN),
      source: 'job',
      pid: 4500,
      project: 'alpha',
      exit: 0,
    }) + '\n',
  );
  const lead = startLead(fake.home);
  const load = burner();
  const job = startJob(fake.home);
  const started = startDaemon(fake, port, ['--no-terminal']);
  const daemon = started.child;
  const deadline = setTimeout(() => {
    console.error('deadline: stopping');
    daemon.kill('SIGTERM');
    process.exit(2);
  }, DEADLINE_MS);
  const log = started.log;
  const pageErrors: string[] = [];
  const browser = await launchBrowser();
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    // T-0041: office hours off, so nobody goes home when this runs at night.
    await ctx.addInitScript(() => localStorage.setItem('cld.office-hours', '{"on":false}'));
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const board = (page: Page) => page.locator('[data-testid="lobby-board"]');
  const pageOf = (page: Page) =>
    board(page).locator('[data-testid="board-page"]').getAttribute('data-page');

  try {
    const loginUrl = await started.loginUrl();

    // ── Desktop ──
    const { ctx: desk, page } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await until('the lobby board is on screen', async () => (await board(page).count()) === 1);
    await until(
      'ten projects reached the board',
      async () =>
        (await board(page).locator('[data-testid="board-project"]').count()) === 8 &&
        (await board(page).locator('[data-testid="board-more"]').textContent()) === '외 2',
    );
    check(true, 'the lobby renders with its board; 프로젝트 shows 8 rows and "외 2"');
    const loadedAt = Date.now();

    // T-0063: at the default view (1280x800) the board is clear of the elevator panel:
    // its left end starts to the right of everything the panel draws.
    const boardBox = (await board(page).boundingBox())!;
    const panelBox = (await page.locator('.cld-elevator-panel').boundingBox())!;
    await shot(page, 'desktop-default-view');
    check(
      boardBox.x >= panelBox.x + panelBox.width,
      `at the default view the board (left ${Math.round(boardBox.x)}) clears the elevator panel (right ${Math.round(panelBox.x + panelBox.width)})`,
    );

    // At the default zoom, drag the office so the board is in the middle.
    const canvas = (await page.locator('[data-testid="office-canvas"]').boundingBox())!;
    for (let k = 0; k < 3; k++) {
      const b = (await board(page).boundingBox())!;
      const dx = canvas.x + canvas.width / 2 - (b.x + b.width / 2);
      const dy = canvas.y + canvas.height / 2 - (b.y + b.height / 2);
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) break;
      const from = { x: canvas.x + 300, y: canvas.y + 300 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(300);
    }
    await page.mouse.move(canvas.x + 4, canvas.y + 4);
    const emPx = await board(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    check(
      emPx >= 16 && (await board(page).getAttribute('data-live')) === 'true',
      `at the default zoom the board is live and its text readable (${emPx.toFixed(1)} px)`,
    );
    const wide = (await board(page).boundingBox())!;
    check(
      wide.width >= 800,
      `the board is about two rooms wide (${Math.round(wide.width)} CSS px)`,
    );
    await shot(page, 'desktop-office');
    await shot(page, 'desktop-board-projects');
    const pofol = board(page).locator('[data-testid="board-project"]', { hasText: 'pofol' });
    check(
      /학습 · 실행 중/.test((await pofol.textContent()) ?? ''),
      'pofol shows what its running job is (T-0068: name and outcome, no count)',
    );

    // The pages turn by themselves, every ~20 s.
    await until(
      'the board turns to H/W by itself',
      async () => (await pageOf(page)) === 'hw',
      30_000,
    );
    const turnedAfter = (Date.now() - loadedAt) / 1000;
    check(
      turnedAfter >= 12 && turnedAfter <= 26,
      `the first page turned by itself after ~20 s (${turnedAfter.toFixed(1)} s after load)`,
    );
    // A mouse over the board holds the page.
    await page.mouse.move(wide.x + wide.width / 2, wide.y + wide.height * 0.6);
    await page.waitForTimeout(22_000);
    check((await pageOf(page)) === 'hw', 'a mouse over the board holds its page (22 s)');
    await page.mouse.move(canvas.x + 4, canvas.y + 4);

    // All three pages, by tab.
    for (const p of ['gpu', 'projects', 'hw'] as const) {
      await board(page).locator(`[data-testid="board-tab-${p}"]`).click();
      await until(`the ${p} tab shows its page`, async () => (await pageOf(page)) === p, 3_000);
      if (p !== 'projects') await shot(page, `desktop-board-${p}`);
    }
    check(true, 'each tab shows its page');
    check(
      (await page.locator('[data-testid="board-full"]').count()) === 0,
      'a tab click does not open the full view',
    );

    // The CPU line moves with the CPU load.
    const graph = board(page).locator('[data-testid="board-graph-cpu"]');
    const before = await graph.getAttribute('data-last');
    const pixels0 = await graph.locator('canvas').screenshot();
    load.on();
    await until(
      'a new CPU sample reaches the graph',
      async () => (await graph.getAttribute('data-last')) !== before,
      8_000,
    );
    await page.waitForTimeout(2_500);
    const pixels1 = await graph.locator('canvas').screenshot();
    check(!pixels0.equals(pixels1), 'the CPU line moved when the CPU load changed');
    await shot(page, 'desktop-board-hw-moved');

    // The queue characters match the line.
    await board(page).locator('[data-testid="board-tab-gpu"]').click();
    const q0 = await queuers(page);
    check(
      JSON.stringify(q0.map((q) => q.project)) === JSON.stringify(LINE),
      `the queue characters stand in line order (${q0.map((q) => q.project).join(', ')})`,
    );
    check(
      q0.find((q) => q.project === 'beta')?.exclusive && !q0[0].exclusive,
      'beta (no --vram) wears the 혼자 badge',
    );
    check(
      JSON.stringify(q0.map((q) => q.ticket)) === JSON.stringify([5, 3, 4]),
      'tickets keep their numbers across the move',
    );
    const holder = board(page).locator('[data-testid="board-holder"]');
    check(/pofol/.test((await holder.textContent()) ?? ''), 'pofol holds the lease');
    const ends = await board(page).locator('[data-testid="board-end"]').allTextContents();
    check(
      ends.some((e) => /gamma.*시간 초과/.test(e)) && ends.some((e) => /delta.*끝/.test(e)),
      `recent endings in words (${ends.join(' / ')})`,
    );
    // A live event: aixon gives up (SIGTERM while waiting).
    fs.appendFileSync(events, gpu('gpu_cancel', 'aixon', 0, { reason: 'stop' }) + '\n');
    await board(page).locator('[data-testid="board-tab-gpu"]').click();
    await until(
      'the line follows a live gpu_cancel',
      async () =>
        JSON.stringify((await queuers(page)).map((q) => q.project)) ===
        JSON.stringify(['smartglass', 'beta']),
      8_000,
    );
    await board(page).locator('[data-testid="board-tab-gpu"]').click();
    check(
      (await board(page).locator('[data-testid="board-end"]').allTextContents()).some((e) =>
        /aixon.*멈춤/.test(e),
      ),
      'a live gpu_cancel(stop) leaves the line and reads 멈춤',
    );
    await shot(page, 'desktop-board-gpu-live');

    // A click on the board opens the full view; Esc closes it; back closes it.
    const b2 = (await board(page).boundingBox())!;
    await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height * 0.7);
    const full = page.locator('[data-testid="board-full"]');
    await full.waitFor({ timeout: 3_000 });
    for (const p of ['projects', 'hw', 'gpu'] as const) {
      await full.locator(`[data-testid="board-tab-${p}"]`).click();
      await page.waitForTimeout(300);
      await shot(page, `desktop-full-${p}`);
    }
    await page.keyboard.press('Escape');
    await until('Esc closes the full view', async () => (await full.count()) === 0, 3_000);
    await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height * 0.7);
    await full.waitFor({ timeout: 3_000 });
    await page.goBack();
    await until('back closes the full view', async () => (await full.count()) === 0, 3_000);
    // A click on the board itself keeps it open; one on the dark around it closes it.
    await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height * 0.7);
    await full.waitFor({ timeout: 3_000 });
    const fb = (await full.locator('.led-full').boundingBox())!;
    await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.waitForTimeout(300);
    check((await full.count()) === 1, 'a click on the full board keeps it open');
    await page.mouse.click(fb.x / 2, fb.y + fb.height / 2);
    await until(
      'a click outside closes the full view',
      async () => (await full.count()) === 0,
      3_000,
    );
    check(page.url() === `http://127.0.0.1:${port}/`, 'the office stays on its page after back');
    check(true, 'a click opens the full view; Esc, back and a click outside close it');

    // Zoomed out, the board is too small to read: a static frame that never turns.
    const b3 = (await board(page).boundingBox())!;
    await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2);
    for (let k = 0; k < 4; k++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(150);
    }
    await page.mouse.move(5, 400);
    await until(
      'zoomed out, the board freezes',
      async () =>
        (await board(page).count()) === 0 ||
        (await board(page).getAttribute('data-live')) === 'false',
      3_000,
    );
    if (await board(page).count()) {
      const frozenPage = await pageOf(page);
      const frozenText = await board(page).textContent();
      await page.waitForTimeout(9_000);
      check(
        (await pageOf(page)) === frozenPage && (await board(page).textContent()) === frozenText,
        'zoomed out, the board keeps a static frame (no page turn, no redraw)',
      );
      await shot(page, 'desktop-zoomed-out');
    } else check(true, 'zoomed out, the board is off the view and not drawn');

    // ── Phone ──
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await desk.cookies());
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.locator('[data-testid="office-canvas"]').waitFor();
    await phone.waitForTimeout(1500);
    // The lobby is the office's last room (bottom right): pan there with a finger.
    const boxOf = async () => ((await board(phone).count()) ? board(phone).boundingBox() : null);
    // The board is wider than a phone: enough of it on screen to tap.
    const whole = async () => {
      const b = await boxOf();
      if (!b) return false;
      return Math.abs(b.x - 8) <= 24 && Math.abs(b.y - 260) <= 60;
    };
    for (let k = 0; k < 10 && !(await whole()); k++) {
      const b = await boxOf();
      // Its left end at the screen's left edge, its top a third of the way down.
      const clamp = (d: number) => Math.max(-250, Math.min(250, d));
      const to = b ? { x: 196 + clamp(8 - b.x), y: 380 + clamp(260 - b.y) } : { x: 120, y: 200 };
      await touchDrag(phone, { x: 196, y: 380 }, to);
      await phone.waitForTimeout(400);
    }
    check(await whole(), 'the phone pans to the lobby board');
    await shot(phone, 'phone-office');
    const pb = (await board(phone).boundingBox())!;
    const tapX = (Math.max(0, pb.x) + Math.min(393, pb.x + pb.width)) / 2;
    const tapY = (Math.max(80, pb.y + pb.height * 0.3) + Math.min(700, pb.y + pb.height)) / 2;
    await phone.touchscreen.tap(tapX, tapY);
    const pfull = phone.locator('[data-testid="board-full"]');
    await pfull.waitFor({ timeout: 3_000 });
    for (const p of ['projects', 'hw', 'gpu'] as const) {
      await pfull.locator(`[data-testid="board-tab-${p}"]`).tap();
      await phone.waitForTimeout(300);
      await shot(phone, `phone-full-${p}`);
    }
    const fit = await pfull.evaluate((el) => {
      const b = el.querySelector('.led-full')!.getBoundingClientRect();
      return b.left >= 0 && b.right <= window.innerWidth && document.body.scrollWidth <= 393;
    });
    check(fit, 'the phone full view fits the screen, no sideways scroll');
    await pfull.locator('[data-testid="board-close"]').tap();
    await until('✕ closes it on the phone', async () => (await pfull.count()) === 0, 3_000);
    check(true, 'the phone opens the board with a tap and closes it');

    check(pageErrors.length === 0, `no page errors ${JSON.stringify(pageErrors)}`);
    await phoneCtx.close();
    await desk.close();
  } catch (err) {
    console.error(log.join('').slice(-3000));
    throw err;
  } finally {
    clearTimeout(deadline);
    load.off();
    job.kill('SIGKILL');
    await browser.close();
    daemon.kill('SIGTERM');
    lead.kill('SIGTERM');
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

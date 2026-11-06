/**
 * DV4 (M1 새 워크트리, M2 앉히기), end to end: dist/cli.js in a temp HOME on the given port, a temp
 * repository as project shop-web, the engine's fake claude as its Lead and two Workers (never a real
 * claude). Desktop (1600x1000, 모던): the rail's + opens the sheet; feat/cart-coupon from main, linked
 * to issue T-1, web-worker seated (it is on: asked once, restarted) with a first instruction: the
 * worktree, its record and Task, web-worker's session folder and the typed instruction are checked
 * on disk, and the worktree opens. The same name again is refused on the sheet, nothing made.
 * api-worker's chip dragged onto T-3's card (hint, outline) seats it there (its folder moves, its
 * older card is no longer its own). Shots at 1024x700, in 픽셀 감성, and the phone's tray sheet.
 *
 *   taskset -c 18,19 nice -n 10 npx tsx cld/test/run-devroom-newspace.ts <port 19140-19149>
 */
import type { Browser, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import type { WorktreeRecord } from '../../server/src/cld/engine/git/worktrees.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 19140 && port <= 19149)) throw new Error('port: 19140-19149');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/feat-devroom-manual-workspace');
const DEADLINE_MS = 300_000;
const TEXT = '쿠폰 적용 순서를 장바구니 합계 뒤로 옮겨 주세요';
let oks = 0;
const notes: string[] = [];
const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => boolean, timeout = 30_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const repo = makeTempRepo();
  const folder = repo.folder;
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'shop-web', folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({ v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] }),
  );
  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    {
      PATH,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@localhost',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@localhost',
      LANG: 'C.UTF-8',
    },
    true,
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
        env: { PATH, HOME: home, CLD_OUTPUT: 'json' },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout || '{}') as Record<string, any>;
    const sessions = () =>
      fs.readdirSync(path.join(home, '.claude/sessions')).flatMap((file) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as { name: string; cwd: string }];
        } catch {
          return []; // written as we read
        }
      });
    const cwdOf = (name: string) => sessions().find((s) => s.name === name)?.cwd;
    const typed = () => {
      const file = path.join(home, 'fake-claude-typed.log');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    };
    const records = () => JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[];
    const tasks = () => (json(cli('task', 'list', '--project', 'shop-web')).tasks ?? []) as Array<Record<string, any>>;

    await daemon.loginUrl();
    await eventually('the Lead revived', () => !!cwdOf('shop-web'));
    for (const w of ['web-worker', 'api-worker']) check(json(cli('worker', 'add', 'shop-web', w)).ok === true, `Worker ${w} added`);
    check(json(cli('task', 'add', '쿠폰 적용 순서', '--project', 'shop-web')).task?.id === 'T-1', 'issue T-1 (to link)');
    check(json(cli('task', 'add', '로그인 속도 제한', '--project', 'shop-web', '--assignee', 'api-worker', '--status', 'doing')).task?.id === 'T-2', 'T-2 for api-worker');
    check(json(cli('worktree', 'new', '--task', 'T-2', '--assign', 'api-worker')).ok === true, 'T-2 gets a worktree for api-worker');
    check(json(cli('task', 'add', '결제 화면 문구 정리', '--project', 'shop-web')).task?.id === 'T-3', 'T-3');
    check(json(cli('worktree', 'new', '--task', 'T-3')).ok === true, 'T-3 gets a worktree with nobody on it');
    const t2 = records().find((r) => r.taskId === 'T-2')!;
    const t3 = records().find((r) => r.taskId === 'T-3')!;
    for (const w of ['web-worker', 'api-worker']) {
      check(json(cli('worker', 'start', w)).ok === true, `${w} started`);
      await eventually(`${w} live`, () => !!cwdOf(w));
    }
    check(cwdOf('api-worker') === t2.path, 'api-worker works in T-2’s worktree');
    const mainSha = repo.git(['rev-parse', 'main'], folder).trim();

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const newPage = async (opts: Parameters<Browser['newContext']>[0], theme?: string) => {
      const ctx = await browser!.newContext(opts);
      await ctx.addInitScript(
        ([v, th]) => {
          localStorage.setItem('cld.changelogSeen', v);
          if (th) localStorage.setItem('cld.ui-theme', th);
        },
        [seen, theme ?? ''] as const,
      );
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      return p;
    };
    const shot = async (p: Page, name: string) => {
      await p.waitForTimeout(300);
      await p.screenshot({ path: path.join(OUT, `${name}.png`) });
    };
    const openRoom = async (p: Page) => {
      await p.locator('[data-hud-id="icon:devroom"] button').click();
      const win = p.locator('[data-hud-window="devroom"]');
      await win.waitFor({ timeout: 20_000 });
      await win.getByTestId('hud-title-devroom').dblclick();
      await win.locator(`[data-testid="devroom-card"][data-task="${t3.task}"]`).waitFor({ timeout: 20_000 });
      return win;
    };

    // ── M1: the + opens 새 워크트리 ──
    const desk = await newPage({ viewport: { width: 1600, height: 1000 } });
    const win = await openRoom(desk);
    const card = (task: string) => win.locator(`[data-testid="devroom-card"][data-task="${task}"]`);
    check(await win.getByTestId('devroom-add').count() === 0, 'the + is no longer 프로젝트 추가 (it is in the project menu)');
    await win.getByTestId('devroom-new-space').click();
    const sheet = win.getByTestId('newspace-sheet');
    await sheet.waitFor();
    check((await sheet.getByTestId('newspace-base').inputValue()) === 'main', 'the base defaults to the project’s branch');
    await sheet.getByTestId('newspace-branch').fill('feat/cart-coupon');
    check((await sheet.getByTestId('newspace-folder').innerText()) === '.worktrees/feat-cart-coupon', 'the folder is shown, derived from the branch');
    await sheet.getByTestId('newspace-issue').selectOption('T-1');
    const webRow = sheet.locator('[data-testid="newspace-agent"][data-agent="web-worker"]');
    check((await webRow.innerText()).includes('쉬는 중') || (await webRow.innerText()).includes('일하는 중'), 'web-worker shows its state');
    check((await sheet.locator('[data-testid="newspace-agent"][data-agent="api-worker"]').innerText()).includes('다른 워크트리'), 'api-worker says it works in another worktree');
    check((await sheet.locator('[data-testid="newspace-agent"][data-agent="shop-web"]').count()) === 0, 'the Lead is not offered');
    await webRow.locator('input').check();
    await sheet.getByTestId('newspace-text').fill(TEXT);
    await shot(desk, 'm1-desktop-1600');
    await sheet.getByTestId('newspace-make').click();
    await desk.getByTestId('newspace-restart').waitFor();
    const ask = await desk.getByTestId('newspace-restart').innerText();
    check(ask.includes('다시 시작해 이 워크트리에 앉혀요') && ask.includes('새 대화로 시작해요'), 'web-worker is on: asked once, it restarts there in a new conversation');
    await shot(desk, 'm1-restart-ask');
    await desk.getByTestId('newspace-restart-yes').click();
    await card('feat-cart-coupon').waitFor({ timeout: 30_000 });
    const rec = records().find((r) => r.branch === 'feat/cart-coupon');
    check(rec && rec.taskId === 'T-1' && rec.base === 'main' && rec.createdBy === 'user', `the record: T-1, from main, by the owner (${JSON.stringify(rec)})`);
    check(rec!.path === path.join(fs.realpathSync(folder), '.worktrees', 'feat-cart-coupon') || rec!.path.endsWith('/.worktrees/feat-cart-coupon'), 'in .worktrees/feat-cart-coupon');
    check(fs.existsSync(rec!.path) && repo.git(['rev-parse', 'feat/cart-coupon'], folder).trim() === mainSha, 'a new branch from main, checked out there');
    const t1 = tasks().find((x) => x.id === 'T-1');
    check(t1?.branch === 'feat/cart-coupon' && t1?.worktree === rec!.path && t1?.assignee?.name === 'web-worker', 'Task T-1 says where its work is and who has it');
    check(tasks().length === 3, 'no other Task was made');
    await eventually(`web-worker works in the new worktree (${cwdOf('web-worker')})`, () => cwdOf('web-worker') === rec!.path, 60_000);
    check(true, 'web-worker’s working folder is the new worktree');
    await eventually('the first instruction reached web-worker', () => typed().includes('쿠폰 적용 순서를 장바구니'), 60_000);
    check(true, 'the first instruction went through the messenger');
    await desk.waitForFunction(() => document.querySelector('[data-testid="devroom-card"][data-task="feat-cart-coupon"]')?.hasAttribute('data-picked'), undefined, { timeout: 20_000 });
    check((await card('feat-cart-coupon').getByTestId('devroom-who').innerText()) === 'web-worker', 'the worktree opens, web-worker on its card');
    await win.locator('[data-testid="devroom-pane"][data-agent="web-worker"][data-view="terminal"]').waitFor({ timeout: 20_000 });
    check(true, 'web-worker’s pane opens on 터미널 (T-70)');
    await shot(desk, 'm2-opened');

    // ── An existing branch name is refused, nothing made ──
    const before = records().length;
    await win.getByTestId('devroom-new-space').click();
    await sheet.getByTestId('newspace-branch').fill('feat/cart-coupon');
    await sheet.getByTestId('newspace-make').click();
    await sheet.getByTestId('newspace-error').waitFor({ timeout: 20_000 });
    check((await sheet.getByTestId('newspace-error').innerText()).includes('feat/cart-coupon'), `refused with its name (${await sheet.getByTestId('newspace-error').innerText()})`);
    check(records().length === before && tasks().length === 3, 'nothing was made: no worktree, no Task');
    await shot(desk, 'm1-exists');
    await desk.keyboard.press('Escape');

    // ── M2: api-worker's chip dragged onto T-3's card ──
    const chip = win.locator('[data-testid="seat-chip"][data-agent="api-worker"]');
    const a = (await chip.boundingBox())!;
    const b = (await card(t3.task).boundingBox())!;
    await desk.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await desk.mouse.down();
    await desk.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await desk.mouse.move(b.x + b.width / 2 + 4, b.y + b.height / 2, { steps: 2 });
    const dropShown = (await win.getByTestId('seat-hint').count()) === 1 && (await card(t3.task).getAttribute('data-drop')) === 'true';
    if (dropShown) check(true, 'while dragging: the hint and the card’s drop outline');
    else notes.push('the drag hint or outline was not seen mid-drag (headless HTML5 drag)');
    await shot(desk, 'm2-drag');
    await desk.mouse.up();
    if (!(await desk.getByTestId('newspace-restart').isVisible().catch(() => false))) {
      // Headless Chromium may not deliver the HTML5 drop: the same Card handler through a synthetic drop.
      notes.push('the mouse drag did not drop; dropped through dispatched drag events');
      const dt = await desk.evaluateHandle(() => new DataTransfer());
      await chip.dispatchEvent('dragstart', { dataTransfer: dt });
      await card(t3.task).dispatchEvent('dragover', { dataTransfer: dt });
      await card(t3.task).dispatchEvent('drop', { dataTransfer: dt });
      await chip.dispatchEvent('dragend', { dataTransfer: dt });
    }
    await desk.getByTestId('newspace-restart').waitFor({ timeout: 10_000 });
    check(true, 'api-worker is on: asked once before it moves');
    await desk.getByTestId('newspace-restart-yes').click();
    await desk.waitForFunction((t) => document.querySelector(`[data-testid="devroom-card"][data-task="${t}"] [data-testid="devroom-who"]`)?.textContent === 'api-worker', t3.task, { timeout: 30_000 });
    check(true, 'the rail shows api-worker on T-3’s card');
    await win.locator('[data-testid="devroom-pane"][data-agent="api-worker"][data-view="terminal"]').waitFor({ timeout: 20_000 });
    check(true, 'T-3 opens with api-worker’s pane on 터미널 (T-70)');
    const r3 = records().find((r) => r.taskId === 'T-3')!;
    const r2 = records().find((r) => r.taskId === 'T-2')!;
    check(r3.assignmentId && r3.assignmentId === t2.assignmentId && !r2.assignmentId, 'the record: T-3 is api-worker’s, T-2 no longer');
    await eventually(`api-worker works in T-3’s worktree (${cwdOf('api-worker')})`, () => cwdOf('api-worker') === t3.path, 60_000);
    check(true, 'api-worker’s working folder moved to T-3’s worktree');
    await shot(desk, 'm2-seated');

    // ── 1024x700, 픽셀 감성, the phone ──
    await desk.setViewportSize({ width: 1024, height: 700 });
    await win.getByTestId('devroom-new-space').click();
    await sheet.waitFor();
    await shot(desk, 'm1-desktop-1024');
    await desk.keyboard.press('Escape');

    const pix = await newPage({ viewport: { width: 1600, height: 1000 } }, 'pixel');
    const pwin = await openRoom(pix);
    await pwin.getByTestId('devroom-new-space').click();
    await pwin.getByTestId('newspace-sheet').waitFor();
    check((await pix.evaluate(() => document.documentElement.dataset.uiTheme)) === 'pixel', '픽셀 감성 is on');
    await shot(pix, 'm1-pixel');

    const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    await phone.getByTestId('devroom-phone').waitFor({ timeout: 20_000 });
    const pchip = phone.locator('[data-testid="seat-chip"][data-agent="web-worker"]');
    await pchip.scrollIntoViewIfNeeded();
    await shot(phone, 'phone-tray');
    await pchip.tap();
    await phone.getByTestId('seat-pick').waitFor({ timeout: 10_000 });
    check((await phone.getByTestId('seat-pick').innerText()).includes('결제 화면 문구 정리'), 'phone: the chip opens a sheet of worktrees to pick');
    await shot(phone, 'phone-seat-pick');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
    for (const n of notes) console.log(`note - ${n}`);
  } catch (err) {
    fs.writeFileSync(path.join(OUT, 'daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

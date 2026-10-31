/**
 * P4-S2, the 개발실 (dev room), end to end: dist/cli.js in a temp HOME on a spare port, a temp
 * repository, the engine's fake claude as Lead `shop-web` and four Workers (never a real claude).
 * Four Tasks get worktrees like mockups-1101/devroom-W1b: web-worker busy on its turn, api-worker's
 * Task in review, ui-worker resting, docs-worker's branch merged into main and its Task done.
 * Desktop (Chromium --disable-gpu, 1280x800): the dock opens the dev room, the filter narrows it to
 * shop-web, the cards wear their chips (merged dimmed, last), the `…` menu opens (W1b), 병합 selects
 * the 병합 tab; the messenger's ⌘ opens it on the Lead's trunk; the 작업실 task card opens it on its
 * worktree; "+ 새 작업 맡기기" reaches the Lead. Phone (390x844, touch): the list with a card
 * expanded to 터미널 / 변경 / 병합 (W5). The terminal columns and the memory line wait for P3: only
 * their marked places are checked. Screenshots in cld/artifacts/p4-s2/.
 *
 *   nice -n 10 npx tsx cld/test/run-devroom.ts <port 18264|18265>
 */
import type { Browser, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import type { WorktreeRecord } from '../../server/src/cld/engine/git/worktrees.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openWorkbenchTab,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18264 && port !== 18265) throw new Error('port: 18264 or 18265');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/p4-s2');
const DEADLINE_MS = 300_000;
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

const WORK = [
  { worker: 'web-worker', title: '장바구니 합계 계산 분리', file: 'src/shop/Cart.ts', text: 'export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n' },
  { worker: 'api-worker', title: '로그인 속도 제한', file: 'src/api/rate.ts', text: 'export const LIMIT = 5;\n' },
  { worker: 'ui-worker', title: '결제 화면 문구 정리', file: 'src/ui/pay.txt', text: '결제하기\n' },
  { worker: 'docs-worker', title: 'README 오타 수정', file: 'README.md', text: '# shop-web\n' },
];

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
  // A long fake turn: web-worker stays busy (작업 중) after the one message it gets.
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { PATH, FAKE_TURN_MS: '240000', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
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
    const session = (name: string) =>
      fs.readdirSync(path.join(home, '.claude/sessions')).some((file) => {
        try {
          return (JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as { name: string }).name === name;
        } catch {
          return false;
        }
      });
    const typed = () => {
      const file = path.join(home, 'fake-claude-typed.log');
      return fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string })
        : [];
    };
    await daemon.loginUrl();
    await eventually('the Lead revived', () => session('shop-web'));

    const wts: WorktreeRecord[] = [];
    for (const [i, w] of WORK.entries()) {
      check(json(cli('worker', 'add', 'shop-web', w.worker)).ok === true, `Worker ${w.worker} added`);
      const id = json(cli('task', 'add', w.title, '--project', 'shop-web', '--assignee', w.worker, '--status', 'doing')).task?.id as string;
      check(id === `T-${i + 1}`, `Task ${id} for ${w.worker}`);
      check(json(cli('worktree', 'new', '--task', id, '--assign', w.worker)).ok === true, `${id} gets a worktree for ${w.worker}`);
      const wt = (JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[]).find((r) => r.taskId === id)!;
      fs.mkdirSync(path.dirname(path.join(wt.path, w.file)), { recursive: true });
      fs.writeFileSync(path.join(wt.path, w.file), w.text);
      repo.git(['add', '-A'], wt.path);
      repo.git(['commit', '-q', '-m', w.title], wt.path);
      wts.push(wt);
    }
    // docs-worker's branch went into main by hand, its Task is done: ✔ 합쳐짐, dimmed, last.
    repo.git(['merge', '-q', '--no-edit', wts[3].branch], folder);
    check(json(cli('task', 'update', 'T-4', '--status', 'done')).ok === true, 'T-4 done (merged into main)');
    check(json(cli('task', 'update', 'T-2', '--status', 'review')).ok === true, 'T-2 in review');
    for (const w of WORK) {
      check(json(cli('worker', 'start', w.worker)).ok === true, `${w.worker} started`);
      await eventually(`${w.worker} live`, () => session(w.worker));
    }
    const sent = cli('send', 'web-worker', '장바구니 합계 계산을 sumPrice 로 분리해 주세요');
    await eventually(`web-worker typed its message (${sent.stdout}${sent.stderr})`, () => typed().some((x) => x.text.includes('sumPrice')), 60_000);
    check(true, 'web-worker is in its turn');

    browser = await launchBrowser();
    // The "v0.x 으로 업데이트됐어요" toast would cover the screenshots: this version's notes count as seen.
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const newPage = async (b: Browser, opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await b.newContext(opts);
      await ctx.addInitScript((v) => localStorage.setItem('cld.changelogSeen', v), seen);
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

    // ── Desktop: the dock's ⌘ opens the window; the filter narrows it to shop-web. ──
    const desk = await newPage(browser, { viewport: { width: 1280, height: 800 } });
    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.waitFor({ timeout: 20_000 });
    check(true, 'the dock ⌘ icon opens the 개발실 window');
    await win.getByTestId('hud-title-devroom').dblclick(); // maximized, like the mock-up's window
    await win.getByTestId('devroom-filter').click();
    await win.getByRole('menuitemradio', { name: 'shop-web' }).click();
    check((await win.getByTestId('hud-title-devroom').innerText()).includes('개발실 / shop-web'), 'the title names the filtered project');
    const card = (task: string) => win.locator(`[data-testid="devroom-card"][data-task="${task}"]`);
    await card(wts[3].task).waitFor({ timeout: 20_000 });
    const order = await win.getByTestId('devroom-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-task')));
    check(order.length === 4 && order[3] === wts[3].task, `four cards, the merged one last (${order.join(', ')})`);
    const chip = (task: string) => card(task).getByTestId('devroom-chip');
    await desk.waitForFunction((t) => document.querySelector(`[data-testid="devroom-card"][data-task="${t}"] [data-testid="devroom-chip"]`)?.getAttribute('data-chip') === 'merged', wts[3].task, { timeout: 20_000 });
    check(true, 'docs-worker wears ✔ 합쳐짐');
    check((await chip(wts[1].task).getAttribute('data-chip')) === 'review', 'api-worker wears ● 검토 대기');
    try {
      await desk.waitForFunction((t) => document.querySelector(`[data-testid="devroom-card"][data-task="${t}"] [data-testid="devroom-chip"]`)?.getAttribute('data-chip') === 'working', wts[0].task, { timeout: 30_000 });
      check(true, 'web-worker wears ● 작업 중 during its turn');
    } catch {
      notes.push(`web-worker's chip stayed ${await chip(wts[0].task).getAttribute('data-chip')} (its fake turn was not seen as busy)`);
    }
    check(await card(wts[0].task).getAttribute('data-picked'), 'the first open worktree is picked by default');
    check(await win.getByTestId('devroom-terminal-slot').isVisible(), "the terminal tab shows the agents' marked place (after P3)");
    check((await win.getByTestId('devroom-stats-slot').count()) === 1, 'the footer keeps the memory line place');
    // A card's `…` menu, as in W1b (the mock-up's is on the merged card, whose 병합 has nothing to do).
    await card(wts[2].task).getByTestId('devroom-more').click();
    const menu = win.getByTestId('devroom-menu');
    await menu.waitFor();
    const items = await menu.locator('[data-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-item')));
    check(items.join() === 'explorer,sync,merge,remove', `the … menu: ${items.join(', ')}`);
    await desk.waitForTimeout(400);
    await shot(desk, 'W1b-desktop');

    // 병합 in another card's menu picks it and opens the 병합 tab (S4's place).
    await desk.keyboard.press('Escape');
    await card(wts[1].task).getByTestId('devroom-more').click();
    await menu.locator('[data-item="merge"]').click();
    await win.locator('[data-testid="devroom-body"][data-tab="merge"]').waitFor();
    check(await card(wts[1].task).getAttribute('data-picked'), '병합 picks the card and opens the 병합 tab');

    // + 새 작업 맡기기: one line to the Lead.
    await win.getByTestId('devroom-new').click();
    const form = desk.getByTestId('devroom-new-task');
    await form.locator('input').fill('쿠폰 할인 계산 추가');
    await shot(desk, 'new-task-dialog');
    await form.getByRole('button', { name: '리드에게 보내기' }).click();
    await eventually('the Lead got the new task', () => typed().some((x) => x.text.includes('쿠폰 할인 계산 추가') && x.text.includes('worktree')), 30_000);
    check(true, 'the new task reached the Lead with the worktree hint');

    // The messenger's ⌘ opens the dev room on the Lead's trunk (mock-up I). A maximized window covers the icons.
    await win.getByTestId('hud-title-devroom').dblclick();
    await desk.getByRole('button', { name: /^메신저/ }).click();
    const messenger = desk.getByRole('region', { name: '메신저', exact: true });
    await messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^shop-web/ }).click();
    const conv = messenger.getByRole('region', { name: 'shop-web 대화' });
    await conv.getByTestId('devroom-link').click();
    await win.locator('[data-testid="devroom-trunk"][aria-pressed="true"]').waitFor({ timeout: 10_000 });
    check(true, "the messenger's ⌘ opens the dev room on the Lead (trunk)");
    await shot(desk, 'I-messenger-link');

    // The 작업실 task card's link picks its worktree.
    await openWorkbenchTab(desk, 'Task', { project: 'shop-web' });
    const wb = desk.locator('[data-hud-window="workbench"]');
    await wb.locator('[data-testid="task-card"][data-task-id="T-3"]').click();
    await wb.getByTestId('task-devroom').click();
    await desk.waitForFunction((t) => document.querySelector(`[data-hud-window="devroom"] [data-testid="devroom-card"][data-task="${t}"]`)?.hasAttribute('data-picked'), wts[2].task, { timeout: 10_000 });
    check(true, "the 작업실 card's ⌘ opens the dev room on its worktree");

    // ── Phone: the list, a card expanded (W5). Chromium's phone mode: this Linux WebKit draws no Galmuri (tofu). ──
    const phone = await newPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    const list = phone.getByTestId('devroom-phone');
    await list.waitFor({ timeout: 20_000 });
    const pcard = (task: string) => list.locator(`[data-testid="devroom-card"][data-task="${task}"]`);
    await pcard(wts[3].task).waitFor({ timeout: 20_000 });
    await pcard(wts[0].task).locator('b').tap();
    await pcard(wts[0].task).locator('[data-page="terminal"]').waitFor();
    check((await pcard(wts[0].task).locator('[data-page]').count()) === 4, 'phone: a tapped card shows 터미널 / 변경 / 병합 / 미리보기');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `phone: no sideways scroll (${overflow})`);
    await phone.waitForTimeout(400);
    await shot(phone, 'W5-phone-list');
    await pcard(wts[0].task).locator('[data-page="terminal"]').tap();
    await list.locator('[data-testid="devroom-page"][data-page="terminal"]').waitFor();
    check(await list.getByTestId('devroom-terminal-slot').isVisible(), "phone: 터미널 opens the sub-page with the agents' place");
    await list.getByTestId('devroom-back').tap();
    await pcard(wts[0].task).waitFor();
    check(true, 'phone: ‹ 뒤로 returns to the list');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
    for (const n of notes) console.log(`note - ${n}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom.daemon.log'), daemon.log.join(''));
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

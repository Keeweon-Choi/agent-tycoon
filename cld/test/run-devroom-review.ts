/**
 * P4-S3, the 변경 tab and the review loop (mockups-1101/review-loop-R1..R4), end to end: dist/cli.js
 * in a temp HOME on a spare port, a temp repository, the engine's fake claude as Lead `shop-web` and
 * Worker `web-worker` (never a real claude). Task T-1 has a worktree with two changed files and is
 * in review. Desktop (Chromium --disable-gpu, 1280x800): the dev room's 변경 tab shows both files with
 * the owner's two notes and a third being written (R1); the phone (390x844) opens a line's sheet
 * (R3); 의견 2개 보내기 reaches the Worker (one formatted message), the notes say 보냄, 병합 is
 * locked, the Lead's room shows the line (R2); the Worker's edit makes one note 고침 and 다시 보기
 * shows the six steps, the sent notes and only what changed since the send (R4); the Task back in
 * review unlocks 병합; the 작업실's 검토 shows the same review. Screenshots in cld/artifacts/p4-s3/.
 *
 *   nice -n 10 npx tsx cld/test/run-devroom-review.ts <port 18264|18265>
 */
import type { Browser, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import type { WorktreeRecord } from '../../server/src/cld/engine/git/worktrees.js';
import { tasksPath } from '../../server/src/cld/engine/tasks.js';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/p4-s3');
const DEADLINE_MS = 300_000;
let oks = 0;

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

const USER_BASE = ["import { api } from './api'", '', 'export function getUser(id) {', '}', ''].join('\n');
const USER_NEW = [
  "import { api } from './api'",
  '',
  'export async function getUserData(id: string) {',
  '  const res = await api.get(`/users/${id}`)',
  '  return res.data',
  '}',
  '',
].join('\n');
const USER_FIXED = USER_NEW.replace('getUserData', 'loadUser');
const filler = Array.from({ length: 9 }, (_, i) => `// cart ${i + 1}`);
const CART_BASE = [...filler, 'export function Cart() {', '  const { items } = useCart()', '  const total = items.reduce((a, b) => a + b.price, 0)', '  return <CartView total={total} />', '}', ''].join('\n');
const CART_NEW = [...filler, 'export function Cart() {', '  const { items } = useCart()', '  const total = sumPrice(items)', '  const label = formatWon(total)', '  return <CartView total={label} />', '}', ''].join('\n');

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const repo = makeTempRepo();
  const folder = repo.folder;
  repo.write('src/shop/user.ts', USER_BASE);
  repo.write('src/shop/view/Cart.tsx', CART_BASE);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'shop base']);
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'shop-web', folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({ v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] }),
  );
  fs.writeFileSync(path.join(cfg, 'groups.json'), JSON.stringify({ v: 1, groups: [{ id: 'r0review0room', name: '장바구니', members: ['shop-web', 'web-worker'] }] }));
  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { PATH, FAKE_TURN_MS: '400', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
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
    const taskStatus = () =>
      (JSON.parse(fs.readFileSync(tasksPath(home), 'utf8')) as { tasks: Array<{ id: string; status: string }> }).tasks.find((x) => x.id === 'T-1')?.status;
    await daemon.loginUrl();
    await eventually('the Lead revived', () => session('shop-web'));

    check(json(cli('worker', 'add', 'shop-web', 'web-worker')).ok === true, 'Worker web-worker added');
    check(json(cli('task', 'add', '장바구니 합계 계산 분리', '--project', 'shop-web', '--assignee', 'web-worker', '--status', 'doing')).task?.id === 'T-1', 'Task T-1 for web-worker');
    check(json(cli('worktree', 'new', '--task', 'T-1', '--assign', 'web-worker')).ok === true, 'T-1 gets a worktree');
    const wt = (JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[])[0];
    fs.mkdirSync(path.join(wt.path, 'src/shop/view'), { recursive: true });
    fs.writeFileSync(path.join(wt.path, 'src/shop/user.ts'), USER_NEW);
    fs.writeFileSync(path.join(wt.path, 'src/shop/view/Cart.tsx'), CART_NEW);
    repo.git(['add', '-A'], wt.path);
    repo.git(['commit', '-q', '-m', 'cart total'], wt.path);
    check(json(cli('worker', 'start', 'web-worker')).ok === true, 'web-worker started');
    await eventually('web-worker live', () => session('web-worker'));
    check(json(cli('task', 'update', 'T-1', '--status', 'review')).ok === true, 'T-1 reported review');

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    const newPage = async (opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await browser!.newContext(opts);
      await ctx.addInitScript((v) => localStorage.setItem('cld.changelogSeen', v), seen);
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      return p;
    };
    // Toasts (an update note, a second device's login, our own send) would cover the screenshots.
    const shot = async (p: Page, name: string) => {
      await p.evaluate(() => {
        for (const b of document.querySelectorAll('button')) {
          const text = b.parentElement?.textContent ?? '';
          if (b.textContent?.trim() === '×' && /업데이트됐어요|새 기기 로그인|검토 의견|검토를 기다려요/.test(text)) b.click();
        }
      });
      await p.screenshot({ path: path.join(OUT, `${name}.png`) });
    };

    // ── Desktop: the dev room's 변경 tab (R1) ──
    const desk = await newPage({ viewport: { width: 1280, height: 800 } });
    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.waitFor({ timeout: 20_000 });
    await win.getByTestId('hud-title-devroom').dblclick();
    const card = win.locator(`[data-testid="devroom-card"][data-task="${wt.task}"]`);
    await card.waitFor({ timeout: 20_000 });
    await card.click();
    await win.locator('[role="tab"][data-tab="changes"]').click();
    const review = win.getByTestId('task-review');
    await review.waitFor({ timeout: 20_000 });
    const line = (file: string, n: number) => review.locator(`[data-testid="review-file"][data-file="${file}"] [data-testid="review-row"][data-new="${n}"]`);
    await line('src/shop/user.ts', 3).waitFor({ timeout: 20_000 });
    await line('src/shop/view/Cart.tsx', 12).waitFor({ timeout: 20_000 });
    check((await review.getByTestId('review-title').innerText()) === '장바구니 합계 계산 분리', 'the header names the Task');
    check((await review.getByTestId('review-chip').getAttribute('data-kind')) === 'review', 'the chip says 검토 중');
    check((await review.getByTestId('review-file-item').count()) === 2, 'the left list has the two changed files');
    check((await review.getByTestId('review-steps').count()) === 0, 'no step strip in the first look (R1 has none)');

    await line('src/shop/user.ts', 3).click();
    await review.getByTestId('review-input').fill('이 함수 이름을 loadUser 로 바꿔 주세요');
    await review.getByTestId('review-add').click();
    await line('src/shop/user.ts', 4).click();
    await review.getByTestId('review-input').fill('여기 실패했을 때 처리가 빠졌어요');
    await review.getByTestId('review-add').click();
    await desk.waitForFunction(() => document.querySelectorAll('[data-testid="review-note"]').length === 2, null, { timeout: 10_000 });
    await line('src/shop/user.ts', 5).click();
    await review.getByTestId('review-input').fill('반환 타입도 적어 주세요');
    check((await review.getByTestId('review-send').innerText()).includes('의견 2개 보내기'), 'the send button counts 의견 2개 보내기');
    check((await review.getByTestId('review-footer').innerText()).includes('지금 쓰는 1개는'), 'the footer says the open note needs 「의견 추가」');
    await review.getByTestId('review-composer').scrollIntoViewIfNeeded();
    await desk.waitForTimeout(300);
    await shot(desk, 'R1-review-notes');
    await review.getByRole('button', { name: '취소', exact: true }).click();

    // ── Phone: a line's sheet (R3), before the send ──
    const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    const list = phone.getByTestId('devroom-phone');
    const pcard = list.locator(`[data-testid="devroom-card"][data-task="${wt.task}"]`);
    await pcard.waitFor({ timeout: 20_000 });
    await pcard.locator('b').tap();
    await pcard.locator('[data-page="changes"]').tap();
    const preview = list.getByTestId('task-review');
    await preview.waitFor({ timeout: 20_000 });
    await preview.getByTestId('review-file-tab').filter({ hasText: 'Cart.tsx' }).tap();
    const prow = preview.locator('[data-testid="review-row"][data-new="12"]');
    await prow.waitFor({ timeout: 20_000 });
    await prow.tap();
    const sheet = phone.getByTestId('review-sheet');
    await sheet.waitFor({ timeout: 10_000 });
    await sheet.getByTestId('review-input').fill('합계 계산은 좋아요. 쿠폰 할인도 여기서 빼 주세요');
    const box = await sheet.boundingBox();
    check(box && box.y + box.height <= 844 + 1 && box.width >= 389, 'phone: the sheet sits at the bottom, full width');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `phone: no sideways scroll (${overflow})`);
    await phone.waitForTimeout(300);
    await shot(phone, 'R3-phone-sheet');
    await sheet.getByRole('button', { name: '취소', exact: true }).last().tap();

    // ── Send (R2) ──
    await review.getByTestId('review-send').click();
    await desk.waitForFunction(() => [...document.querySelectorAll('[data-testid="review-note"]')].every((n) => n.getAttribute('data-sent') === 'yes'), null, { timeout: 20_000 });
    check((await review.getByTestId('review-note').first().innerText()).includes('보냄'), 'the notes say 보냄 · time');
    await eventually('the Worker received the notes', () => typed().some((x) => x.text.includes('User comment: "이 함수 이름을')), 30_000);
    const msg = typed().find((x) => x.text.includes('User comment: "이 함수 이름을'))!.text.replace(/\r/g, '\n');
    check(msg.includes('[검토 의견]') && msg.includes('Task T-1') && msg.includes('File: src/shop/user.ts'), "web-worker's session got the formatted notes");
    await eventually('T-1 doing', () => taskStatus() === 'doing', 10_000);
    const merge = review.getByTestId('review-merge');
    await desk.waitForFunction(() => document.querySelector('[data-testid="review-merge"]')?.getAttribute('data-locked') === 'yes', null, { timeout: 20_000 });
    check(await merge.isDisabled(), '병합 is locked while the Worker fixes');
    check((await review.getByTestId('review-footer').innerText()).includes('병합은 잠겨요'), 'the footer says why');
    check((await review.getByTestId('review-chip').getAttribute('data-kind')) === 'fixing', 'the chip says 고치는 중');
    await review.getByTestId('review-lead-room').waitFor();
    check((await review.getByTestId('review-lead-line').innerText()).includes('web-worker 에게 검토 의견 2개를 보냈어요'), "the Lead's room line");
    await review.getByTestId('review-lead-input').fill('쿠폰 할인은 따로 티켓으로 잡아 주세요');
    await review.getByTestId('review-lead-input').press('Enter');
    await eventually('the Lead got the line', () => typed().some((x) => x.text.includes('쿠폰 할인은 따로')), 30_000);
    check(true, 'the one-line input reached the Lead');
    await desk.waitForTimeout(400);
    await shot(desk, 'R2-sent-locked');

    // ── The Worker edits line 3 (note 1 fixed), 다시 보기 (R4) ──
    fs.writeFileSync(path.join(wt.path, 'src/shop/user.ts'), USER_FIXED);
    await desk.waitForFunction(() => document.querySelector('[data-testid="review-note"][data-fixed="yes"]'), null, { timeout: 40_000 });
    check(true, 'the note on the edited line says ✔ 고침');
    await review.getByTestId('review-again').click();
    const steps = review.getByTestId('review-steps');
    await steps.waitFor();
    check((await steps.getAttribute('data-step')) === '4', 'the strip is at step 4 (에이전트가 고침)');
    const items = review.getByTestId('review-sent-item');
    await items.first().waitFor();
    const states = await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-fixed')));
    check(states.join() === 'yes,no', `sent notes: ${states.join(', ')}`);
    await review.locator('[data-testid="review-file"][data-file="src/shop/user.ts"]').waitFor({ timeout: 20_000 });
    await review.locator('[data-testid="review-file"][data-file="src/shop/view/Cart.tsx"]').waitFor({ state: 'detached', timeout: 20_000 });
    await review.getByTestId('review-main').getByText('loadUser').first().waitFor({ timeout: 20_000 });
    const since = await review.getByTestId('review-main').innerText();
    check(since.includes('loadUser') && !since.includes('Cart.tsx'), 'only what changed since the send is shown');
    await desk.waitForTimeout(400);
    await shot(desk, 'R4-again-strip');

    // ── The Worker reports review again: step 5, 병합 unlocks ──
    check(json(cli('task', 'update', 'T-1', '--status', 'review')).ok === true, 'T-1 reported review again');
    await desk.waitForFunction(() => document.querySelector('[data-testid="task-review"]')?.getAttribute('data-step') === '5', null, { timeout: 20_000 });
    check(!(await merge.isDisabled()), 'the Task is back in review: 병합 is open (the owner clicks it)');
    await desk.waitForTimeout(300);
    await shot(desk, 'R4-step5-merge-open');

    // ── The 작업실's 검토 shows the same review ──
    await win.getByTestId('hud-title-devroom').dblclick();
    await openWorkbenchTab(desk, 'Task', { project: 'shop-web' });
    const wb = desk.locator('[data-hud-window="workbench"]');
    await wb.locator('[data-testid="task-card"][data-task-id="T-1"]').click();
    await wb.getByTestId('task-review-open').click();
    await desk.locator('[data-hud-window="workbench"] [data-testid="task-review"][data-task]').waitFor({ timeout: 20_000 });
    check((await desk.locator('[data-hud-window="workbench"]').innerText()).includes('작업실 / shop-web · 검토'), 'the 작업실 window is titled 작업실 / shop-web · 검토');
    await desk.locator('[data-hud-window="workbench"]').getByTestId('review-back').click();
    check((await desk.locator('[data-hud-window="workbench"] [data-testid="task-review"][data-task]').count()) === 0, '‹ 뒤로 returns to the tabs');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom-review.daemon.log'), daemon.log.join(''));
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

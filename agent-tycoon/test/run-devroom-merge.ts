/**
 * P4-S4, the 개발실's 머지 tab and 워크트리 정리, end to end: dist/cli.js in a temp HOME on a spare
 * port, a temp repository, the engine's fake claude as Lead `shop-web` and three Workers (never a
 * real claude). Seven Tasks: T-1 clean (and behind main), T-2 in conflict with main on two files
 * (three blocks), T-3..T-5 merged by hand, T-6 and T-7 unmerged and idle for days.
 *
 *   T-1: pre-check (behind) -> 따라잡기 -> K's card -> 머지 -> the card leaves the rail (auto-cleanup)
 *   T-2: W2 banner -> 에이전트에게 맡기기 (the Worker gets one message) -> 직접 풀기: pick every block
 *        of both files -> 해결됨으로 표시 (no marker left in the files) -> K's card -> 머지
 *   W3:  the list (3 merged checked, 2 unmerged not), the auto-cleanup toggle persisted, 정리 removes
 *        the merged ones; an unmerged one goes too and its work stays on its branch.
 * Desktop only (Chromium --disable-gpu, 1280x800). Screenshots in agent-tycoon/artifacts/p4-s4/.
 *
 *   nice -n 10 npx tsx agent-tycoon/test/run-devroom-merge.ts <port 18262|18263>
 */
import type { Browser, Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import type { WorktreeRecord } from '../../server/src/agent-tycoon/engine/git/worktrees.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18262 && port !== 18263) throw new Error('port: 18262 or 18263');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/p4-s4');
const DEADLINE_MS = 420_000;
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

/** Lines 2 and 12 of Label.tsx differ in the branch and in main (two blocks, far apart); copy.ts has one. */
const LABEL = (a: string, b: string) =>
  ['import { formatWon } from "./won";', a, ...Array.from({ length: 9 }, (_, i) => `// filler ${i + 1}`), b, 'export const done = true;', ''].join('\n');
const COPY = (a: string) => `export const copy = {\n${a}\n};\n`;

const TASKS = [
  { id: 'T-1', worker: 'web-worker', title: '장바구니 합계 계산 분리', status: 'review' },
  { id: 'T-2', worker: 'ui-worker', title: '결제 화면 문구 정리', status: 'doing' },
  { id: 'T-3', worker: 'docs-worker', title: 'README 오타 수정', status: 'done' },
  { id: 'T-4', worker: 'docs-worker', title: '푸터 링크 정리', status: 'done' },
  { id: 'T-5', worker: 'docs-worker', title: '로그인 속도 제한', status: 'done' },
  { id: 'T-6', worker: 'web-worker', title: '검색창 실험', status: 'doing' },
  { id: 'T-7', worker: 'ui-worker', title: '캐시 시험', status: 'doing' },
];

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const repo = makeTempRepo();
  const folder = repo.folder;
  const gitEnv = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@localhost',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@localhost',
  };
  /** A commit made on a past date (the idle folders of W3). */
  const commitAt = (cwd: string, message: string, when: string) =>
    execFileSync('git', ['commit', '-q', '-m', message], { cwd, env: { ...gitEnv, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } });
  repo.write('src/pay/Label.tsx', LABEL('export const TITLE = "pay";', 'export const DESC = "order";'));
  repo.write('src/pay/copy.ts', COPY('  title: "pay",'));
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'pay screen']);
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
    { ...gitEnv, PATH, FAKE_TURN_MS: '3000', LANG: 'C.UTF-8' },
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
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'agent-tycoon/bin/agty'), ...args], {
        env: { PATH, HOME: home, AGTY_OUTPUT: 'json' },
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

    // ── Setup: seven worktrees from the same main, then main moves on. ──
    const wts: Record<string, WorktreeRecord> = {};
    for (const w of ['web-worker', 'ui-worker', 'docs-worker']) check(json(cli('worker', 'add', 'shop-web', w)).ok === true, `Worker ${w} added`);
    for (const tk of TASKS) {
      const id = json(cli('task', 'add', tk.title, '--project', 'shop-web', '--assignee', tk.worker, '--status', 'doing')).task?.id as string;
      check(id === tk.id, `Task ${id}`);
      check(json(cli('worktree', 'new', '--task', id, '--assign', tk.worker)).ok === true, `${id} gets a worktree`);
      wts[id] = (JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[]).find((r) => r.taskId === id)!;
    }
    const work = (id: string, files: Record<string, string>, message: string, when?: string) => {
      const wt = wts[id];
      for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(wt.path, rel)), { recursive: true });
        fs.writeFileSync(path.join(wt.path, rel), text);
      }
      repo.git(['add', '-A'], wt.path);
      if (when) commitAt(wt.path, message, when);
      else repo.git(['commit', '-q', '-m', message], wt.path);
    };
    work('T-1', { 'src/shop/Cart.ts': 'export const sumPrice = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n' }, 'feat(shop): sumPrice');
    work('T-2', { 'src/pay/Label.tsx': LABEL('export const TITLE = "결제하기";', 'export const DESC = "주문 내용을 확인해 주세요";'), 'src/pay/copy.ts': COPY('  title: "결제하기",') }, 'fix(pay): 문구 정리');
    work('T-3', { 'README.md': '# shop-web\n' }, 'docs: readme');
    work('T-4', { 'src/ui/Footer.tsx': 'export const Footer = () => null;\n' }, 'feat(ui): footer links');
    work('T-5', { 'src/api/rate.ts': 'export const LIMIT = 5;\n' }, 'feat(api): rate limit');
    const OLD = '2026-10-27T09:00:00';
    work('T-6', Object.fromEntries(['a', 'b', 'c', 'd'].map((n) => [`exp/${n}.ts`, `export const ${n} = 1;\n`])), 'wip: search box', OLD);
    work('T-7', Object.fromEntries(['a', 'b'].map((n) => [`exp/cache-${n}.ts`, `export const ${n} = 2;\n`])), 'wip: cache', '2026-10-25T09:00:00');
    for (const id of ['T-3', 'T-4', 'T-5']) repo.git(['merge', '-q', '--no-edit', wts[id].branch], folder);
    // main moves on the same lines of the pay screen: T-2 now conflicts with it.
    repo.write('src/pay/Label.tsx', LABEL('export const TITLE = "결제";', 'export const DESC = "주문을 확인하고 결제해요";'));
    repo.write('src/pay/copy.ts', COPY('  title: "결제",'));
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'pay: shorter copy']);
    for (const tk of TASKS) check(json(cli('task', 'update', tk.id, '--status', tk.status)).ok === true, `${tk.id} is ${tk.status}`);
    for (const w of ['web-worker', 'ui-worker', 'docs-worker']) {
      check(json(cli('worker', 'start', w)).ok === true, `${w} started`);
      await eventually(`${w} live`, () => session(w), 60_000);
    }

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript((v) => localStorage.setItem('agty.changelogSeen', v), seen);
    const desk: Page = await ctx.newPage();
    await desk.goto(await daemon.loginUrl());
    await desk.waitForURL(`http://127.0.0.1:${port}/`);
    // The result toast (4 s) would cover the lower part of the shot.
  const shot = async (name: string) => {
    await desk.waitForTimeout(4500);
    await desk.screenshot({ path: path.join(OUT, `${name}.png`) });
  };

    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.waitFor({ timeout: 20_000 });
    await win.getByTestId('hud-title-devroom').dblclick();
    await win.getByTestId('devroom-filter').click();
    await win.getByRole('menuitemradio', { name: 'shop-web' }).click();
    const card = (task: string) => win.locator(`[data-testid="devroom-card"][data-task="${task}"]`);
    await card(wts['T-2'].task).waitFor({ timeout: 20_000 });
    await desk.waitForFunction(
      (t) => document.querySelector(`[data-testid="devroom-card"][data-task="${t}"] [data-testid="devroom-chip"]`)?.getAttribute('data-chip') === 'conflict',
      wts['T-2'].task,
      { timeout: 60_000 },
    );
    check(true, 'T-2 wears ! 충돌 2파일 (the daemon pre-checked it)');
    const mergeTab = () => win.locator('button[data-tab="merge"]').click();

    // ── T-1: the clean task. ──
    await card(wts['T-1'].task).click();
    await mergeTab();
    await win.getByTestId('merge-clean').waitFor({ timeout: 30_000 });
    const item = (id: string) => win.locator(`[data-testid="merge-check"][data-check="${id}"]`);
    check((await item('behind').getAttribute('data-ok')) === 'false', 'pre-check: T-1 is behind main');
    check((await item('dirty').getAttribute('data-ok')) === 'true', 'pre-check: nothing uncommitted');
    await desk.waitForTimeout(500);
    await shot('K-precheck');
    await win.getByTestId('merge-catchup').click();
    await desk.waitForFunction(() => document.querySelector('[data-testid="merge-check"][data-check="behind"]')?.getAttribute('data-ok') === 'true', undefined, { timeout: 30_000 });
    check(true, '따라잡기 brought main into T-1 (the pre-check turns green)');
    const subject = await win.getByTestId('merge-subject').innerText();
    check(subject.includes('앞으로 감기') && subject.includes('web-worker'), `K's card previews the commit (${subject.replace(/\n/g, ' / ')})`);
    await desk.waitForTimeout(400);
    await shot('K-card');
    await win.getByTestId('merge-go').click();
    await card(wts['T-1'].task).waitFor({ state: 'detached', timeout: 30_000 });
    check(!fs.existsSync(wts['T-1'].path), 'T-1 merged: its card left the rail and its folder is gone (auto-cleanup)');
    check(repo.git(['log', '--oneline', 'main']).includes('sumPrice'), 'T-1 is in main');
    await desk.waitForTimeout(400);
    await shot('rail-after-merge');

    // ── T-2: the conflict. ──
    await card(wts['T-2'].task).click();
    await mergeTab();
    await win.getByTestId('merge-conflict').waitFor({ timeout: 30_000 });
    check((await win.getByTestId('merge-conflict').innerText()).includes('2개 파일'), 'W2: the banner counts 2 conflicting files');
    await desk.waitForTimeout(400);
    await shot('W2-banner');
    await win.getByTestId('merge-handoff').click();
    await eventually('the Worker got the handoff', () => typed().some((x) => x.text.includes('T-2') && x.text.includes('main')), 30_000);
    check(true, '에이전트에게 맡기기: ui-worker received one message');
    await wait(7_000); // its fake turn (3 s) ends: 직접 풀기 is refused while it works
    await win.getByTestId('merge-manual').click();
    await win.getByTestId('merge-resolve').waitFor({ timeout: 30_000 });
    await win.getByTestId('merge-file').first().waitFor();
    check((await win.getByTestId('merge-file').count()) === 2, '직접 풀기: both files listed');
    const pickInFile = async (file: string, choice: string) => {
      await win.getByTestId('merge-file').filter({ hasText: file }).click();
      await win.getByTestId(`merge-pick-${choice}`).first().click();
    };
    await pickInFile('Label.tsx', 'ours');
    check((await win.getByTestId('merge-progress').innerText()).includes('1 / 2'), 'block 1 / 2 resolved');
    check((await win.getByTestId('merge-block-done').count()) === 1, 'the resolved block folds into a green line');
    check(await win.getByTestId('merge-mark').isDisabled(), '해결됨으로 표시 waits for every block');
    await desk.waitForTimeout(400);
    await shot('W2-resolve');
    await pickInFile('Label.tsx', 'theirs');
    await pickInFile('copy.ts', 'both');
    check(await win.getByTestId('merge-mark').isEnabled(), 'every block picked: 해결됨으로 표시 is enabled');
    await win.getByTestId('merge-mark').click();
    await win.getByTestId('merge-clean').waitFor({ timeout: 40_000 });
    const label = fs.readFileSync(path.join(wts['T-2'].path, 'src/pay/Label.tsx'), 'utf8');
    const copy = fs.readFileSync(path.join(wts['T-2'].path, 'src/pay/copy.ts'), 'utf8');
    check(!/^(<<<<<<<|=======|>>>>>>>)/m.test(label + copy), 'no conflict marker is left in the files');
    check(label.includes('결제하기') && label.includes('주문을 확인하고 결제해요'), "Label.tsx: block 1 is the Worker's, block 2 is main's");
    check(copy.includes('결제하기') && copy.includes('"결제"'), 'copy.ts: both sides kept');
    check(repo.git(['status', '--porcelain'], wts['T-2'].path).trim() === '', 'the sync merge is committed');
    await desk.waitForTimeout(400);
    await shot('K-card-after-resolve');
    await win.getByTestId('merge-go').click();
    await card(wts['T-2'].task).waitFor({ state: 'detached', timeout: 30_000 });
    check(repo.git(['show', 'main:src/pay/Label.tsx']).includes('결제하기'), 'T-2 is in main with the owner’s picks');

    // ── W3: 워크트리 정리. ──
    await win.getByTestId('devroom-cleanup').click();
    const rows = win.getByTestId('merge-row');
    await rows.nth(4).waitFor({ timeout: 30_000 });
    check((await rows.count()) === 5, `W3: 5 task folders listed (${await rows.count()})`);
    const checkedOf = (id: string) => win.locator(`[data-testid="merge-row"][data-task="${wts[id].task}"] [role="checkbox"]`).getAttribute('aria-checked');
    check((await Promise.all(['T-3', 'T-4', 'T-5'].map(checkedOf))).every((v) => v === 'true'), 'the 3 merged folders are checked');
    check((await Promise.all(['T-6', 'T-7'].map(checkedOf))).every((v) => v === 'false'), 'the 2 unmerged folders are not');
    check((await win.getByTestId('merge-table').innerText()).includes('브랜치에 보관돼요'), 'the unmerged rows say their work is kept on the branch');
    check((await win.getByTestId('merge-auto').getAttribute('aria-checked')) === 'true', 'auto-cleanup is on by default');
    await desk.waitForTimeout(400);
    await shot('W3-cleanup');
    await win.getByTestId('merge-auto').click();
    const devroomJson = path.join(cfg, 'devroom.json');
    await eventually('devroom.json says off', () => fs.existsSync(devroomJson) && JSON.parse(fs.readFileSync(devroomJson, 'utf8')).autoCleanupAfterMerge === false);
    check(true, 'the toggle is saved by the daemon (devroom.json: off)');
    await desk.waitForTimeout(300);
    await shot('W3-cleanup-auto-off');
    await win.getByTestId('merge-cleanup-run').click();
    await rows.nth(2).waitFor({ state: 'detached', timeout: 60_000 });
    await eventually('the merged folders are gone', () => ['T-3', 'T-4', 'T-5'].every((id) => !fs.existsSync(wts[id].path)), 30_000);
    check(['T-6', 'T-7'].every((id) => fs.existsSync(wts[id].path)), '정리 removed the 3 merged folders and left the unmerged ones');
    check(!repo.git(['branch', '--list', wts['T-3'].branch]).trim(), 'a merged folder’s branch is deleted too');

    // An unmerged one: removed, its work stays on the branch.
    await win.locator(`[data-testid="merge-row"][data-task="${wts['T-6'].task}"] [role="checkbox"]`).click();
    const note = await win.getByTestId('merge-confirm').innerText();
    check(note.includes('브랜치에 보관'), 'the yellow note says the unmerged work is kept on its branch');
    await desk.waitForTimeout(300);
    await shot('W3-cleanup-keep-note');
    await win.getByTestId('merge-cleanup-run').click();
    await eventually('T-6 folder gone', () => !fs.existsSync(wts['T-6'].path), 30_000);
    check(repo.git(['branch', '--list', wts['T-6'].branch]).includes(wts['T-6'].branch), 'T-6’s branch is kept');
    check(repo.git(['ls-tree', '-r', '--name-only', wts['T-6'].branch]).includes('exp/a.ts'), 'T-6’s work is still on its branch');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
    for (const n of notes) console.log(`note - ${n}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom-merge.daemon.log'), daemon.log.join(''));
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

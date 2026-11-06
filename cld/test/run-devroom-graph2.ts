/**
 * DEVROOM-GRAPH2 (owner 11-03 11:51): the worktree graph folds like a tree. dist/cli.js in a temp
 * HOME on a spare port, a temp repository shaped like the owner's: main <- integ/1024-1815 (a
 * worktree made by hand) <- a Codex run made inside it (with a run made from it in turn) and a
 * Task's worktree based on integ; an old run off main; two resting runs. The engine's fake claude
 * is Lead `shop-web` (never a real claude).
 *
 *   PC 1920x1080: every node with cards under it has a `▾ n` toggle; Enter folds integ (the picked
 *   card stays drawn), Space folds main; a reload keeps both; the 작업실 card's link picks the Task
 *   inside them and unfolds the way to it; the whole graph folds to its header.
 *   Phone 390x844: the same toggles; folding integ hides its cards; the fold is remembered.
 * Chromium --disable-gpu. Screenshots in cld/artifacts/devroom-graph2/.
 *
 *   nice -n 10 npx tsx cld/test/run-devroom-graph2.ts <port 18264|18265>
 */
import type { Browser, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/devroom-graph2');
const DEADLINE_MS = 300_000;
const INTEG = 'integ/1024-1815';
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
  const commit = (cwd: string, message: string, when?: string) => {
    repo.git(['add', '-A'], cwd);
    execFileSync('git', ['commit', '-q', '-m', message], { cwd, env: { ...gitEnv, ...(when && { GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when }) } });
  };
  const put = (dir: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put(folder, 'src/pay/copy.ts', 'export const title = "pay";\n');
  commit(folder, 'shop');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'shop-web', folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({ v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] }),
  );

  const wtRoot = path.join(folder, '.worktrees');
  fs.appendFileSync(path.join(folder, '.git/info/exclude'), '/.worktrees/\n');
  const integ = path.join(wtRoot, 'integ');
  repo.git(['worktree', 'add', '-q', integ, '-b', INTEG]);
  const records: WorktreeRecord[] = [];
  const add = (task: string, inside: string, base: string, files: Record<string, string>, when?: string) => {
    const at = path.join(inside, '.worktrees', task);
    repo.git(['worktree', 'add', '-q', at, '-b', `task/${task}`, base], inside);
    for (const [rel, text] of Object.entries(files)) put(at, rel, text);
    commit(at, `codex ${task}`, when);
    records.push({ project: 'shop-web', task, path: at, branch: `task/${task}`, base, created: when ? new Date(when).toISOString() : new Date().toISOString(), status: 'active' });
    return at;
  };
  const OLD = '2026-10-27T09:00:00';
  const run = add('codex-1101-091929', integ, INTEG, { 'src/pay/copy.ts': 'export const title = "결제하기";\n' });
  add('codex-1103-090000', run, 'task/codex-1101-091929', { 'src/pay/note.ts': 'export const note = 1;\n' });
  add('codex-1101-095708', integ, INTEG, { 'exp/a.ts': 'export const a = 1;\n' }, OLD);
  add('codex-1022-195011', folder, 'main', { 'exp/old.ts': 'export const old = 1;\n' }, '2026-10-22T19:50:11');
  add('codex-1023-212023', folder, 'main', { 'exp/b.ts': 'export const b = 1;\n' }, '2026-10-23T21:20:23');
  // integ moves on the same line: the first run conflicts with it (it needs the owner: picked first).
  put(integ, 'src/pay/copy.ts', 'export const title = "결제";\n');
  commit(integ, 'integ: shorter copy');
  fs.writeFileSync(path.join(cfg, 'worktrees.json'), JSON.stringify(records, null, 2));

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
    const session = (name: string) =>
      fs.readdirSync(path.join(home, '.claude/sessions')).some((file) => {
        try {
          return (JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as { name: string }).name === name;
        } catch {
          return false;
        }
      });
    await daemon.loginUrl();
    await eventually('the Lead revived', () => session('shop-web'), 60_000);
    const cli = (...args: string[]) =>
      JSON.parse(
        execFileSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], { env: { PATH, HOME: home, CLD_OUTPUT: 'json' }, encoding: 'utf8', timeout: 60_000 }) || '{}',
      ) as Record<string, any>;
    const taskId = cli('task', 'add', '결제 문구 정리', '--project', 'shop-web', '--status', 'doing').task?.id as string;
    check(cli('worktree', 'new', '--task', taskId, '--base', INTEG).ok === true, `${taskId} gets a worktree based on ${INTEG}`);
    const taskWt = (JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[]).find((r) => r.taskId === taskId)!.task;

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const newPage = async (opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await browser!.newContext(opts);
      await ctx.addInitScript((v) => localStorage.setItem('cld.changelogSeen', v), seen);
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      return p;
    };
    const shot = async (p: Page, name: string) => {
      await p.waitForTimeout(400);
      await p.screenshot({ path: path.join(OUT, `${name}.png`) });
    };

    // ── PC 1920x1080 ──
    const desk = await newPage({ viewport: { width: 1920, height: 1080 } });
    const openRoom = async () => {
      await desk.locator('[data-hud-id="icon:devroom"] button').click();
      const w = desk.locator('[data-hud-window="devroom"]');
      await w.waitFor({ timeout: 20_000 });
      return w;
    };
    let win = await openRoom();
    await win.getByTestId('hud-title-devroom').dblclick();
    const card = (task: string) => win.locator(`[data-testid="devroom-card"][data-task="${task}"]`);
    const fold = (node: string) => win.locator(`[data-testid="devroom-fold"][data-node="${node}"]`);
    await card(taskWt).waitFor({ timeout: 30_000 });
    await desk.waitForFunction(
      () => document.querySelector('[data-testid="devroom-card"][data-task="codex-1101-091929"] [data-testid="devroom-chip"]')?.getAttribute('data-chip') === 'conflict',
      undefined,
      { timeout: 60_000 },
    );
    await desk.waitForFunction(() => !!document.querySelector('[data-testid="devroom-card"][data-picked]'), undefined, { timeout: 20_000 });
    const picked = await win.locator('[data-testid="devroom-card"][data-picked]').getAttribute('data-task');
    check(picked === 'codex-1101-091929', `the conflicting run is picked first (${picked})`);
    const text = async (node: string) => (await fold(node).innerText()).replace(/\s+/g, '');
    check((await text('main')) === '▾6', `main: ▾ 6, every card of the project (${await text('main')})`);
    check((await text(INTEG)) === '▾3', `${INTEG}: ▾ 3 (${await text(INTEG)})`);
    check((await text('task/codex-1101-091929')) === '▾1', 'the run with a run made from it: ▾ 1');
    check((await fold('워크트리').count()) === 1, 'the graph header has its own toggle');
    await shot(desk, 'pc-unfolded');

    await fold(INTEG).focus();
    await desk.keyboard.press('Enter');
    check((await fold(INTEG).getAttribute('aria-expanded')) === 'false', `Enter folds ${INTEG}`);
    check((await card(taskWt).count()) === 0, `the Task card under ${INTEG} is hidden`);
    check(await card('codex-1101-091929').isVisible(), 'the picked card stays drawn under the folded branch');
    await fold('main').focus();
    await desk.keyboard.press('Space');
    check((await fold('main').getAttribute('aria-expanded')) === 'false', 'Space folds main');
    check((await card('codex-1103-090000').count()) === 0 && (await win.getByTestId('devroom-resting').count()) === 0, 'main folded: the other cards and the resting row are hidden');
    check(await card('codex-1101-091929').isVisible(), 'the picked card is still in sight');
    await shot(desk, 'pc-folded');

    await desk.reload();
    await desk.waitForURL(`http://127.0.0.1:${port}/`);
    win = desk.locator('[data-hud-window="devroom"]');
    // The window comes back open after a reload (its icon pressed); only a closed one is opened.
    await desk.locator('[data-hud-id="icon:devroom"] button').waitFor({ timeout: 20_000 });
    await desk.waitForTimeout(1_500);
    if ((await desk.locator('[data-hud-id="icon:devroom"] button').getAttribute('aria-pressed')) !== 'true') win = await openRoom();
    else await win.waitFor({ timeout: 20_000 });
    await fold('main').waitFor({ timeout: 30_000 });
    check(
      (await fold('main').getAttribute('aria-expanded')) === 'false' && (await fold(INTEG).getAttribute('aria-expanded')) === 'false',
      'a reload keeps both folds (per project, in this browser)',
    );

    // The 작업실 card's link picks the Task inside both folds: the way to it unfolds.
    // The maximized dev room covers the dock: minimized first (the 작업실 link brings it back).
    await win.getByTestId('hud-title-devroom').locator('..').getByRole('button', { name: '최소화' }).first().click();
    await openWorkbenchTab(desk, '이슈', { project: 'shop-web' });
    const wb = desk.locator('[data-hud-window="office"]');
    await wb.locator(`[data-testid="task-card"][data-task-id="${taskId}"]`).click();
    await wb.getByTestId('task-devroom').click();
    win = desk.locator('[data-hud-window="devroom"]');
    await desk.waitForFunction((t) => document.querySelector(`[data-hud-window="devroom"] [data-testid="devroom-card"][data-task="${t}"]`)?.hasAttribute('data-picked'), taskWt, { timeout: 15_000 });
    check(
      (await fold('main').getAttribute('aria-expanded')) === 'true' && (await fold(INTEG).getAttribute('aria-expanded')) === 'true',
      'picking the Task from the 작업실 unfolded main and integ',
    );
    await shot(desk, 'pc-picked-unfolds');
    await fold('워크트리').click();
    check((await win.getByTestId('devroom-graph').count()) === 0 && (await win.getByTestId('devroom-trunk').count()) === 0, 'the whole graph folds to its header');
    await shot(desk, 'pc-graph-folded');
    await fold('워크트리').click();

    // ── Phone 390x844 ──
    const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    const list = phone.getByTestId('devroom-phone');
    await list.waitFor({ timeout: 20_000 });
    const pfold = (node: string) => list.locator(`[data-testid="devroom-fold"][data-node="${node}"]`);
    const pcard = (task: string) => list.locator(`[data-testid="devroom-card"][data-task="${task}"]`);
    await pcard(taskWt).waitFor({ timeout: 30_000 });
    check((await pfold('main').count()) === 1 && (await pfold(INTEG).count()) === 1, 'phone: main and integ have toggles');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `phone: no sideways scroll (${overflow})`);
    await shot(phone, 'phone-unfolded');
    await pfold(INTEG).tap();
    check((await pfold(INTEG).getAttribute('aria-expanded')) === 'false', `phone: a tap folds ${INTEG}`);
    check((await pcard(taskWt).count()) === 0 && (await pcard('codex-1101-091929').count()) === 0, `phone: the cards under ${INTEG} are hidden`);
    await shot(phone, 'phone-folded');
    await phone.reload();
    await phone.waitForTimeout(1_500);
    if (!(await list.isVisible())) await phone.locator('[data-dock="devroom"]').tap();
    await pfold(INTEG).waitFor({ timeout: 30_000 });
    check((await pfold(INTEG).getAttribute('aria-expanded')) === 'false', 'phone: the fold is remembered');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom-graph2.daemon.log'), daemon.log.join(''));
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

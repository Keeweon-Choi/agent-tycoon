/**
 * DEVROOM-FIX (owner 11-03 10:38), end to end: dist/cli.js in a temp HOME on a spare port, a temp
 * repository shaped like the owner's: main <- integ/1024-1815 (a worktree made by hand, no record)
 * <- Codex runs made from inside it (.worktrees/integ/.worktrees/codex-*, recorded with base integ,
 * no Task, nobody on them), an old Codex run off main whose folder was deleted (branch kept), a
 * Task with a long title and a merged folder. The engine's fake claude is Lead `shop-web` (never a
 * real claude).
 *
 *   graph:    integ/1024-1815 is a branch line between main and its Codex cards
 *   conflict: the nested run's card is checked against integ; 에이전트에게 맡기기 is enabled and
 *             reaches the Lead with the folder's path; 직접 풀기 on the deleted run checks it out
 *             again and lists its conflict
 *   cleanup:  the rows answer at once, then their sizes (> 0 B); no row overlaps the next
 * Desktop 1920x1080 and 1280x800, phone 390x844 (Chromium --disable-gpu). Screenshots in
 * cld/artifacts/devroom-fix/.
 *
 *   nice -n 10 npx tsx cld/test/run-devroom-fix.ts <port 18264|18265>
 */
import type { Browser, Locator, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import type { WorktreeRecord } from '../../server/src/cld/engine/git/worktrees.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18264 && port !== 18265) throw new Error('port: 18264 or 18265');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/devroom-fix');
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

/** No row's box reaches into the next one's. */
async function noOverlap(rows: Locator): Promise<string | null> {
  const boxes = await rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom, h: r.height })));
  for (let i = 1; i < boxes.length; i++) if (boxes[i].top < boxes[i - 1].bottom - 1) return `row ${i} starts at ${boxes[i].top}, row ${i - 1} ends at ${boxes[i - 1].bottom}`;
  // And nothing inside a row spills out of it.
  const spill = await rows.evaluateAll((els) =>
    els.flatMap((row, i) => {
      const r = row.getBoundingClientRect();
      return [...row.querySelectorAll('span')].some((s) => s.getBoundingClientRect().bottom > r.bottom + 1) ? [i] : [];
    }),
  );
  return spill.length ? `rows ${spill.join(',')} spill` : null;
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
  for (let i = 0; i < 40; i++) put(folder, `src/mod${i}.ts`, `export const m${i} = ${'1'.repeat(200)};\n`);
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

  // ── The owner's shape. integ: a worktree made by hand (no record). ──
  const wtRoot = path.join(folder, '.worktrees');
  fs.appendFileSync(path.join(folder, '.git/info/exclude'), '/.worktrees/\n');
  const integ = path.join(wtRoot, 'integ');
  repo.git(['worktree', 'add', '-q', integ, '-b', INTEG]);
  const records: WorktreeRecord[] = [];
  const record = (task: string, at: string, base: string) =>
    records.push({ project: 'shop-web', task, path: at, branch: `task/${task}`, base, created: '2026-10-22T10:00:00.000Z', status: 'active' });
  const OLD = '2026-10-27T09:00:00';
  const nested = (task: string, files: Record<string, string>, when?: string) => {
    const at = path.join(integ, '.worktrees', task);
    repo.git(['worktree', 'add', '-q', at, '-b', `task/${task}`, INTEG], integ);
    for (const [rel, text] of Object.entries(files)) put(at, rel, text);
    commit(at, `codex ${task}`, when);
    record(task, at, INTEG);
    return at;
  };
  const conflicted = nested('codex-1101-091929', { 'src/pay/copy.ts': 'export const title = "결제하기";\n' });
  nested('codex-1101-095708', { 'exp/a.ts': 'export const a = 1;\n', 'exp/b.ts': 'export const b = 1;\n' }, OLD);
  nested('codex-1102-020131', { 'exp/c.ts': 'export const c = 1;\n' }, OLD);
  // integ moves on the same line: the first nested run now conflicts with integ.
  put(integ, 'src/pay/copy.ts', 'export const title = "결제";\n');
  commit(integ, 'integ: shorter copy');
  // An old run off main, its folder deleted later (branch kept), conflicting with main.
  const old = path.join(wtRoot, 'codex-1022-195011');
  repo.git(['worktree', 'add', '-q', old, '-b', 'task/codex-1022-195011']);
  put(old, 'src/pay/copy.ts', 'export const title = "주문";\n');
  commit(old, 'codex old', '2026-10-22T19:50:11');
  record('codex-1022-195011', old, 'main');
  // A merged one off main (its folder kept).
  const merged = path.join(wtRoot, 'codex-1023-212023');
  repo.git(['worktree', 'add', '-q', merged, '-b', 'task/codex-1023-212023']);
  put(merged, 'docs/readme.md', '# shop\n');
  commit(merged, 'docs', '2026-10-23T21:20:23');
  record('codex-1023-212023', merged, 'main');
  repo.git(['merge', '-q', '--no-edit', 'task/codex-1023-212023']);
  // main moves: the integ line goes into main too (integ is ahead, as the owner's often is).
  put(folder, 'src/pay/copy.ts', 'export const title = "결제";\n');
  commit(folder, 'main: shorter copy');
  fs.rmSync(old, { recursive: true });
  repo.git(['worktree', 'prune']);
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
    const typed = () => {
      const file = path.join(home, 'fake-claude-typed.log');
      return fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string })
        : [];
    };
    await daemon.loginUrl();
    await eventually('the Lead revived', () => session('shop-web'), 60_000);
    // A Task with a long title on its own worktree (the owner's overlapping row).
    const cli = (...args: string[]) =>
      JSON.parse(
        execFileSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], { env: { PATH, HOME: home, CLD_OUTPUT: 'json' }, encoding: 'utf8', timeout: 60_000 }) || '{}',
      ) as Record<string, any>;
    const LONG = 'UI 글자 크기 3단계 설정(작게/보통/크게), 폰/PC 구분 없이 전체 UI 와 이름표 글자 크기를 사용자가 조절, 브라우저별 저장 – 사장 16:07';
    const taskId = cli('task', 'add', LONG, '--project', 'shop-web', '--status', 'doing').task?.id as string;
    check(cli('worktree', 'new', '--task', taskId).ok === true, `${taskId} (a long title) gets a worktree`);

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

    // ── Desktop 1920x1080: the graph. ──
    const desk = await newPage({ viewport: { width: 1920, height: 1080 } });
    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.waitFor({ timeout: 20_000 });
    await win.getByTestId('hud-title-devroom').dblclick();
    const card = (task: string) => win.locator(`[data-testid="devroom-card"][data-task="${task}"]`);
    await card('codex-1101-091929').waitFor({ timeout: 30_000 });
    const branch = win.locator(`[data-testid="devroom-branch"][data-branch="${INTEG}"]`);
    check(await branch.isVisible(), `the graph shows ${INTEG} as a branch line`);
    check((await card('codex-1101-091929').getAttribute('data-depth')) === '1', 'its Codex run hangs one step in, under it');
    check((await card('codex-1022-195011').getAttribute('data-depth')) === '0', 'the old run off main hangs off the trunk');
    await desk.waitForFunction(
      () => document.querySelector('[data-testid="devroom-card"][data-task="codex-1101-091929"] [data-testid="devroom-chip"]')?.getAttribute('data-chip') === 'conflict',
      undefined,
      { timeout: 60_000 },
    );
    check(true, 'the nested run wears ! 충돌 (pre-checked against integ, in its real folder)');
    await shot(desk, 'pc-graph');

    // ── Its conflict card: checked against integ, handed to the Lead. ──
    await card('codex-1101-091929').click();
    await win.locator('button[data-tab="merge"]').click();
    const conflict = win.getByTestId('merge-conflict');
    await conflict.waitFor({ timeout: 30_000 });
    check((await conflict.innerText()).includes(INTEG), `the card says it overlaps ${INTEG}, not main`);
    const handoff = win.getByTestId('merge-handoff');
    check(await handoff.isEnabled(), '에이전트에게 맡기기 is enabled with nobody on the worktree');
    check((await handoff.innerText()).includes('shop-web'), `it names the Lead (${(await handoff.innerText()).replace(/\n/g, ' / ')})`);
    await shot(desk, 'pc-conflict-card');
    await handoff.click();
    await eventually('the Lead got the handoff', () => typed().some((x) => x.text.includes(conflicted) && x.text.includes(INTEG)), 30_000);
    check(true, 'the Lead received the conflict with the folder path');

    // ── The deleted old run: 직접 풀기 checks it out again. ──
    await card('codex-1022-195011').click();
    await conflict.waitFor({ timeout: 30_000 });
    await win.getByTestId('merge-manual').click();
    await win.getByTestId('merge-resolve').waitFor({ timeout: 30_000 });
    check(fs.existsSync(path.join(old, 'src/pay/copy.ts')), '직접 풀기: the deleted folder is back on its branch');
    check((await win.getByTestId('merge-file').count()) === 1, '직접 풀기: its conflicting file is listed');
    await shot(desk, 'pc-resolve-old-run');
    await win.getByTestId('merge-abort').click();
    await desk.waitForTimeout(1_000);

    // ── 워크트리 정리: answered at once, sized after, no overlap. ──
    await win.getByTestId('devroom-cleanup').click();
    const rows = win.getByTestId('merge-row');
    await rows.first().waitFor({ timeout: 30_000 });
    await desk.waitForFunction(() => !document.querySelector('[data-testid="merge-table"]')?.textContent?.includes('재는 중'), undefined, { timeout: 60_000 });
    const sizes = await rows.evaluateAll((els) => els.map((e) => e.lastElementChild?.textContent ?? ''));
    check(sizes.length >= 3 && sizes.every((s) => /^[1-9][\d.]* [KMG]?B\+?$/.test(s)), `every listed folder has a size (${sizes.join(', ')})`);
    const bad = await noOverlap(rows);
    check(!bad, `1920: no cleanup row overlaps the next (${bad ?? 'ok'})`);
    await shot(desk, 'pc-cleanup');

    // ── The smaller window. ──
    await desk.setViewportSize({ width: 1280, height: 800 });
    await desk.waitForTimeout(600);
    const bad2 = await noOverlap(rows);
    check(!bad2, `1280: no cleanup row overlaps the next (${bad2 ?? 'ok'})`);
    await shot(desk, 'pc-1280-cleanup');
    await win.getByTestId('devroom-cleanup').click();
    await card('codex-1101-091929').click();
    await win.locator('button[data-tab="merge"]').click();
    await conflict.waitFor({ timeout: 30_000 });
    await shot(desk, 'pc-1280-conflict-card');
    const over = await desk.evaluate(() =>
      [...document.querySelectorAll('[data-testid="devroom-card"] b, [data-testid="devroom-branch"] span, [data-testid="merge-conflict"] p')]
        .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis')
        .map((e) => e.textContent),
    );
    check(over.length === 0, `1280: no clipped text without an ellipsis (${over.join(' | ')})`);

    // ── Phone 390x844: the graph and the conflict page. ──
    const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    const list = phone.getByTestId('devroom-phone');
    await list.waitFor({ timeout: 20_000 });
    const pcard = (task: string) => list.locator(`[data-testid="devroom-card"][data-task="${task}"]`);
    await pcard('codex-1101-091929').waitFor({ timeout: 30_000 });
    check(await list.locator(`[data-testid="devroom-branch"][data-branch="${INTEG}"]`).isVisible(), `phone: ${INTEG} is a branch line too`);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `phone: no sideways scroll (${overflow})`);
    await shot(phone, 'phone-graph');
    await pcard('codex-1101-091929').locator('b').tap();
    await pcard('codex-1101-091929').locator('[data-page="merge"]').tap();
    await phone.getByTestId('merge-conflict').waitFor({ timeout: 30_000 });
    await shot(phone, 'phone-conflict-card');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom-fix.daemon.log'), daemon.log.join(''));
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

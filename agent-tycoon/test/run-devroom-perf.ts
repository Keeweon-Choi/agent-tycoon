/**
 * DEVROOM-PERF (owner 11-03 10:38: "변경 불러오는 게 너무 느려"), end to end: dist/cli.js in a temp HOME on
 * a spare port, two temp repositories (shop-web, api-server), the engine's fake claude as their Leads
 * (never a real claude). shop-web has 25 resting worktrees (like the owner's agty) and two Tasks'
 * worktrees: T-1 with 33 changed files (committed, uncommitted, untracked), T-2 with 3.
 * Desktop (Chromium --disable-gpu, 1280x800): the dev room's loading screen while the repositories are
 * held back (0/2, then 1/2); the 변경 tab of T-1 and T-2, timed from the click until every file's diff
 * is drawn; an edit on disk of a file already changed, and a new file, timed until they show; the
 * daemon's RSS before, with the dev room open and after it closed. Screenshots and timings.json in
 * agent-tycoon/artifacts/devroom-perf/.
 *
 *   nice -n 10 npx tsx agent-tycoon/test/run-devroom-perf.ts <port 18262|18263>
 */
import type { Browser, WebSocketRoute } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import type { WorktreeRecord } from '../../server/src/agent-tycoon/engine/git/worktrees.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18262 && port !== 18263) throw new Error('port: 18262 or 18263');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/devroom-perf');
const DEADLINE_MS = 300_000;
const RESTING = 25;
const COMMITTED = 30;
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
const rssMib = (pid: number) => Math.round(Number(/^VmRSS:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) / 1024);

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const repo = makeTempRepo();
  const repo2 = makeTempRepo();
  const folder = repo.folder;
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [
      { projectId: 'p_aaaaaaaaaa', name: 'shop-web', folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' },
      { projectId: 'p_bbbbbbbbbb', name: 'api-server', folder: repo2.folder, room: '개발실', leadAssignmentId: 'a_bbbbbbbbbb' },
    ] }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({ v: 1, assignments: [
      { assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true },
      { assignmentId: 'a_bbbbbbbbbb', projectId: 'p_bbbbbbbbbb', role: 'lead', provider: 'claude', wantRunning: true },
    ] }),
  );
  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    {
      PATH,
      FAKE_TURN_MS: '400',
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
  const pid = daemon.child.pid!;
  console.log(`daemon pid ${pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  const timings: Record<string, number> = {};
  try {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'agent-tycoon/bin/agty'), ...args], {
        env: { PATH, HOME: home, AGTY_OUTPUT: 'json' },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout || '{}') as Record<string, any>;
    await daemon.loginUrl();

    const wts: WorktreeRecord[] = [];
    for (const [i, title] of ['장바구니 화면 정리', '주소 검색 고침'].entries()) {
      const id = json(cli('task', 'add', title, '--project', 'shop-web', '--status', 'review')).task?.id as string;
      check(id === `T-${i + 1}`, `Task ${id}`);
      check(json(cli('worktree', 'new', '--task', id)).ok === true, `${id} gets a worktree`);
      wts.push((JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[]).find((r) => r.taskId === id)!);
    }
    const [t1, t2] = wts;
    const put = (wt: WorktreeRecord, rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(wt.path, rel)), { recursive: true });
      fs.writeFileSync(path.join(wt.path, rel), text);
    };
    const body = (n: number) => Array.from({ length: 40 }, (_, k) => `export const v${n}_${k} = ${k} * ${n};`).join('\n') + '\n';
    for (let n = 0; n < COMMITTED; n++) put(t1, `src/shop/part${n}.ts`, body(n));
    repo.git(['add', '-A'], t1.path);
    repo.git(['commit', '-q', '-m', 'shop parts'], t1.path);
    put(t1, 'a.txt', 'one\nedited, not committed\n');
    put(t1, 'todo.md', '# todo\n');
    put(t1, 'plan.md', '# plan\n');
    const T1_FILES = COMMITTED + 3;
    for (const n of [0, 1, 2]) put(t2, `src/addr/find${n}.ts`, body(100 + n));
    repo.git(['add', '-A'], t2.path);
    repo.git(['commit', '-q', '-m', 'address'], t2.path);
    // Resting worktrees (no Task, one old commit), as the owner's project has: list() walks them all.
    const records = JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[];
    for (let i = 0; i < RESTING; i++) {
      const task = `codex-1022-13${String(i).padStart(2, '0')}11`;
      const wtPath = path.join(path.dirname(t1.path), task);
      repo.git(['worktree', 'add', '-q', '-b', `codex/${task}`, wtPath, 'main'], folder);
      repo.git(['commit', '-q', '--allow-empty', '-m', 'codex run'], wtPath);
      records.push({ project: 'shop-web', task, path: wtPath, branch: `codex/${task}`, base: t1.base, created: '2026-10-22T13:00:00.000Z', status: 'active', createdBy: 'agent:codex' });
    }
    fs.writeFileSync(path.join(cfg, 'worktrees.json'), JSON.stringify(records, null, 2));
    check(true, `${RESTING} resting worktrees recorded`);

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript((v) => localStorage.setItem('agty.changelogSeen', v), seen);
    // The repositories' states are held back until let go, so the loading screen can be looked at.
    const held: Array<{ project: string; go: () => void }> = [];
    /** When the review's asks left the page and their answers came back (runner clock). */
    const wire: Array<[number, string]> = [];
    const holding = new Set(['shop-web', 'api-server']);
    await ctx.routeWebSocket(/\/ws/, (ws: WebSocketRoute) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        if (typeof m === 'string' && /^\{"type":"(repoWorktreeRequest|repoDiffRequest)"/.test(m)) wire.push([performance.now(), m.slice(9, 25)]);
        server.send(m);
      });
      server.onMessage((m) => {
        if (typeof m === 'string' && /^\{"type":"(repoWorktreeDetail|repoDiff)"/.test(m)) wire.push([performance.now(), m.slice(9, 25)]);
        const project = typeof m === 'string' && m.startsWith('{"type":"repoState"') ? (JSON.parse(m) as { project: string }).project : null;
        if (project && holding.has(project)) held.push({ project, go: () => ws.send(m) });
        else ws.send(m);
      });
    });
    const letGo = (project: string) => {
      holding.delete(project);
      for (const h of held.filter((x) => x.project === project)) h.go();
    };
    const desk = await ctx.newPage();
    await desk.goto(await daemon.loginUrl());
    await desk.waitForURL(`http://127.0.0.1:${port}/`);
    await desk.waitForTimeout(3000);
    const rssBefore = rssMib(pid);

    // ── The loading screen ──
    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.waitFor({ timeout: 20_000 });
    await win.getByTestId('hud-title-devroom').dblclick();
    const loading = win.getByTestId('devroom-loading');
    await loading.waitFor({ timeout: 10_000 });
    check((await loading.innerText()).includes('0/2'), 'the loading screen counts 0/2 repositories');
    await desk.waitForTimeout(300);
    await desk.screenshot({ path: path.join(OUT, 'loading-0of2.png') });
    letGo('api-server');
    await desk.waitForFunction(() => document.querySelector('[data-testid="devroom-loading"]')?.textContent?.includes('1/2'), null, { timeout: 10_000 });
    check(true, 'one repository in: 1/2');
    await desk.screenshot({ path: path.join(OUT, 'loading-1of2.png') });
    letGo('shop-web');
    await loading.waitFor({ state: 'detached', timeout: 10_000 });
    check(true, 'both in: the loading screen goes');

    // ── 변경, timed from the click until every file's diff is drawn ──
    const card = (task: string) => win.locator(`[data-testid="devroom-card"][data-task="${task}"]`);
    const drawn = (n: number) =>
      desk.waitForFunction(
        (n) => {
          const files = [...document.querySelectorAll('[data-testid="review-file"]')];
          return files.length === n && files.every((f) => f.querySelector('[data-testid="review-row"]'));
        },
        n,
        { polling: 'raf', timeout: 20_000 },
      );
    const timed = async (label: string, act: () => Promise<unknown>, until: () => Promise<unknown>) => {
      wire.length = 0;
      const t0 = performance.now();
      await act();
      const clicked = performance.now() - t0;
      await until();
      timings[label] = Math.round(performance.now() - t0);
      const at = (kind: string, last = false) => {
        const hit = last ? wire.findLast(([, k]) => k.startsWith(kind)) : wire.find(([, k]) => k.startsWith(kind));
        return hit ? Math.round(hit[0] - t0) : '-';
      };
      console.log(
        `  ${label}: ${timings[label]} ms (click returned ${Math.round(clicked)}, list asked ${at('repoWorktreeR')}, answered ${at('repoWorktreeD')}, ` +
          `first diff asked ${at('repoDiffR')}, last diff answered ${at('repoDiff"', true)})`,
      );
    };
    await card(t2.task).waitFor({ timeout: 20_000 });
    await card(t2.task).click();
    await timed('T-2 변경 tab (3 files)', () => win.locator('[role="tab"][data-tab="changes"]').click(), () => drawn(3));
    await timed(`T-1 card, 변경 (${T1_FILES} files)`, () => card(t1.task).click(), () => drawn(T1_FILES));
    await timed('T-2 card again', () => card(t2.task).click(), () => drawn(3));
    await timed('T-1 card again', () => card(t1.task).click(), () => drawn(T1_FILES));
    check(timings['T-1 card again'] < 1000, `T-1's ${T1_FILES} diffs drawn within a second of the click (${timings['T-1 card again']} ms)`);
    await desk.waitForTimeout(300);
    await desk.screenshot({ path: path.join(OUT, 'changes-tab.png') });

    // ── Edits on disk show up while it is open ──
    const shows = (text: string) =>
      desk.waitForFunction((x) => (document.querySelector('[data-testid="task-review"]') as HTMLElement | null)?.innerText.includes(x), text, { polling: 100, timeout: 10_000 });
    await timed('edit of a file already changed shows', async () => fs.appendFileSync(path.join(t1.path, 'a.txt'), 'LIVE-EDIT-ONE\n'), () => shows('LIVE-EDIT-ONE'));
    await timed('a new file shows', async () => put(t1, 'src/live-new.ts', 'export const live = "LIVE-NEW-FILE";\n'), () => drawn(T1_FILES + 1));
    await timed('a commit on the branch shows', async () => {
      put(t1, 'src/shop/part0.ts', `${body(0)}// LIVE-COMMIT\n`);
      repo.git(['commit', '-q', '-am', 'live commit'], t1.path);
    }, () => shows('LIVE-COMMIT'));
    check(timings['edit of a file already changed shows'] < 2500, 'an edit that keeps the counts equal shows within ~1 s (one poll)');
    await desk.waitForTimeout(300);
    await desk.screenshot({ path: path.join(OUT, 'changes-live-edit.png') });
    const rssOpen = rssMib(pid);

    // ── Closed: no more asks, the kept lists drop ──
    await win.getByRole('button', { name: '개발실 닫기' }).click();
    await win.waitFor({ state: 'detached', timeout: 10_000 });
    await desk.waitForTimeout(15_000);
    const rssClosed = rssMib(pid);
    const memory = { rssBeforeMib: rssBefore, rssDevroomOpenMib: rssOpen, rssClosed15sMib: rssClosed };
    console.log(`  daemon RSS: ${JSON.stringify(memory)}`);
    check(rssOpen < 300, `the daemon stays small with the dev room open (${rssOpen} MiB)`);
    fs.writeFileSync(path.join(OUT, 'timings.json'), `${JSON.stringify({ timings, memory }, null, 2)}\n`);
    console.log(`\n${oks} checks passed; screenshots and timings.json in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom-perf.daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    repo.cleanup();
    repo2.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

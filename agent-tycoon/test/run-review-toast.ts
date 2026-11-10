/**
 * T-73, the 검토 대기 notice: dist/cli.js in a temp HOME on a spare port, a temp repository, the
 * engine's fake claude as Lead `shop-web` and Worker `web-worker` (never a real claude). While the
 * office is open: a Worker's Task with a worktree (T-1) goes to review -> the toast shows an 열기
 * button, pressing it opens the 개발실 on that worktree's 변경 tab; a Worker's Task without a worktree (T-2) ->
 * pressing opens the 현황판's issue board with T-2's card open; the Lead's own Task (T-3) -> no toast.
 * Screenshots in agent-tycoon/artifacts/fix-review-toast-target/.
 *
 *   nice -n 10 npx tsx agent-tycoon/test/run-review-toast.ts <port 18264|18265>
 */
import type { Browser } from '@playwright/test';
import { spawnSync } from 'child_process';
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
if (port !== 18264 && port !== 18265) throw new Error('port: 18264 or 18265');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/fix-review-toast-target');
const DEADLINE_MS = 240_000;
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
  repo.write('src/shop/user.ts', 'export const a = 1;\n');
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
  // No groups.json seeded with web-worker: `worker add` refuses a name with data left under it (PROJECT-DATA).
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
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'agent-tycoon/bin/agty'), ...args], {
        env: { PATH, HOME: home, AGTY_OUTPUT: 'json' },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const json = (r: ReturnType<typeof cli>) => {
      const out = JSON.parse(r.stdout || '{}') as Record<string, any>;
      // A refused call says why in the log (its stdout/stderr), not only "check failed".
      if (out.ok === false || r.status !== 0) console.error(`cli exit ${r.status}: ${r.stdout}${r.stderr}${r.error ? String(r.error) : ''}`);
      return out;
    };
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
    for (const [title, who] of [['one', 'web-worker'], ['two', 'web-worker'], ['three', 'shop-web']] as const)
      check(json(cli('task', 'add', `Task ${title}`, '--project', 'shop-web', '--assignee', who, '--status', 'doing')).ok === true, `Task ${title} for ${who}`);
    check(json(cli('worktree', 'new', '--task', 'T-1', '--assign', 'web-worker')).ok === true, 'T-1 gets a worktree');
    const wt = (JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[])[0];
    fs.writeFileSync(path.join(wt.path, 'src-new.ts'), 'export const b = 2;\n');
    repo.git(['add', '-A'], wt.path);
    repo.git(['commit', '-q', '-m', 'work'], wt.path);

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript((v) => localStorage.setItem('agty.changelogSeen', v), seen);
    const page = await ctx.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.waitForTimeout(3000); // the first board of a load is not a transition
    const toast = page.locator('.agty-toast-slot [data-testid="toast-open"]');

    // ── T-1: a Worker's Task with a worktree -> the 개발실's 변경 tab on it ──
    check(json(cli('task', 'update', 'T-1', '--status', 'review')).ok === true, 'T-1 reported review');
    await toast.waitFor({ timeout: 20_000 });
    check((await page.locator('.agty-toast-slot').innerText()).includes('T-1'), 'the toast names T-1');
    await page.screenshot({ path: path.join(OUT, '01-toast-with-open.png') });
    await toast.click();
    const room = page.locator('[data-hud-window="devroom"]');
    await room.getByTestId('task-review').waitFor({ timeout: 20_000 });
    check((await room.locator('[role="tab"][data-tab="changes"]').getAttribute('aria-selected')) === 'true', 'the 개발실 is on the 변경 tab');
    check((await room.getByTestId('review-title').innerText()) === 'Task one', "the review is T-1's");
    check((await toast.count()) === 0, 'pressing closes the toast');
    await page.screenshot({ path: path.join(OUT, '02-opened-review.png') });

    // ── T-3: the Lead's own Task -> no toast ──
    check(json(cli('task', 'update', 'T-3', '--status', 'review')).ok === true, 'T-3 (the Lead) reported review');
    await page.waitForTimeout(3000);
    check((await page.locator('.agty-toast-slot [data-testid="toast-open"]').count()) === 0, 'no toast for the Lead\'s own Task');
    await page.screenshot({ path: path.join(OUT, '03-no-toast-for-lead.png') });

    // ── T-2: a Worker's Task without a worktree -> the issue board on its card ──
    check(json(cli('task', 'update', 'T-2', '--status', 'review')).ok === true, 'T-2 reported review');
    await toast.waitFor({ timeout: 20_000 });
    check((await page.locator('.agty-toast-slot').innerText()).includes('T-2'), 'the toast names T-2');
    await toast.click();
    const card = page.locator('[data-testid="task-card"][data-task-id="T-2"]');
    await card.waitFor({ timeout: 20_000 });
    await page.waitForTimeout(600);
    check((await card.getAttribute('data-selected')) !== null, "T-2's card is open on the issue board");
    await page.screenshot({ path: path.join(OUT, '04-issue-board-t2.png') });

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom-review.daemon.log'), daemon.log.join(''));
    console.error(err); // a failing cleanup below must not hide it
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); // fake sessions may still be writing
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

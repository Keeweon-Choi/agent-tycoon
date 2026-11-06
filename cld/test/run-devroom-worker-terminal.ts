/**
 * T-70, end to end: a Worker made or assigned directly in the 개발실 starts in our terminal host in
 * that worktree, and the centre pane opens on it with 터미널 active (like Orca). dist/cli.js in a
 * temp HOME on a spare port, a temp repository as project shop-web, the engine's fake claude (its
 * PTY mode, cld/test/fake-claude/pty-tui.cjs) as the Lead and two Workers (never a real claude),
 * headless Chromium without GPU.
 *   1. 모던: the rail's + makes feat/cart-coupon with web-worker (off): it starts in the new worktree
 *      (its session's cwd) and the pane shows its terminal (the fake's screen, its name);
 *   2. 픽셀 감성: api-worker (on, in the project folder) dropped on T-3's card: asked once, restarted
 *      there, its pane opens on 터미널 with the fake's screen.
 * Shots: cld/artifacts/feat-devroom-worker-terminal/.
 *
 *   nice -n 10 taskset -c 12-19 npx tsx cld/test/run-devroom-worker-terminal.ts <port 18256-18599>
 */
import type { Browser, Locator, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import type { WorktreeRecord } from '../../server/src/cld/engine/git/worktrees.js';
import { ptyhostPaths } from '../../server/src/cld/ptyhost/protocol.js';
import { assertPortFree, isFakeOf, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, sparePort, startDaemon } from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/feat-devroom-worker-terminal');
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
  const hostLog = ptyhostPaths(home).log;
  const hostPid = () => {
    const m = fs.existsSync(hostLog) ? [...fs.readFileSync(hostLog, 'utf8').matchAll(/listening, pid (\d+)/g)].at(-1) : null;
    return m ? Number(m[1]) : 0;
  };
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
    const records = () => JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[];

    await daemon.loginUrl();
    await eventually('the Lead revived', () => !!cwdOf('shop-web'));
    for (const w of ['web-worker', 'api-worker']) check(json(cli('worker', 'add', 'shop-web', w)).ok === true, `Worker ${w} added`);
    check(json(cli('task', 'add', '결제 화면 문구 정리', '--project', 'shop-web')).task?.id === 'T-1', 'T-1');
    check(json(cli('worktree', 'new', '--task', 'T-1')).ok === true, 'T-1 gets a worktree with nobody on it');
    const t1 = records().find((r) => r.taskId === 'T-1')!;
    check(json(cli('worker', 'start', 'api-worker')).ok === true, 'api-worker started (in the project folder)');
    await eventually('api-worker live', () => !!cwdOf('api-worker'));
    check(!cwdOf('web-worker'), 'web-worker is off');

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const newPage = async (theme?: string) => {
      const ctx = await browser!.newContext({ viewport: { width: 1600, height: 1000 } });
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
      await p.waitForTimeout(400);
      await p.screenshot({ path: path.join(OUT, `${name}.png`) });
    };
    const openRoom = async (p: Page) => {
      await p.locator('[data-hud-id="icon:devroom"] button').click();
      const win = p.locator('[data-hud-window="devroom"]');
      await win.waitFor({ timeout: 20_000 });
      await win.getByTestId('hud-title-devroom').dblclick();
      await win.locator(`[data-testid="devroom-card"][data-task="${t1.task}"]`).waitFor({ timeout: 20_000 });
      return win;
    };
    /** `name`'s pane is on 터미널 and shows the fake's screen for it. */
    const terminalShows = async (p: Page, win: Locator, name: string) => {
      await win.locator(`[data-testid="devroom-pane"][data-agent="${name}"][data-view="terminal"]`).waitFor({ timeout: 30_000 });
      check(true, `${name}'s pane opened on 터미널`);
      await p.waitForFunction(
        (n) => document.querySelector(`[data-testid="devroom-pane"][data-agent="${n}"] .xterm-rows`)?.textContent?.includes(`fake Claude Code (pty) · ${n}`),
        name,
        { timeout: 30_000 },
      );
      check(true, `${name}'s terminal shows its fake session`);
    };

    // ── 1. 모던: a new worktree with web-worker (off) ──
    const desk = await newPage();
    const win = await openRoom(desk);
    await win.getByTestId('devroom-new-space').click();
    const sheet = win.getByTestId('newspace-sheet');
    await sheet.waitFor();
    await sheet.getByTestId('newspace-branch').fill('feat/cart-coupon');
    await sheet.locator('[data-testid="newspace-agent"][data-agent="web-worker"] input').check();
    await shot(desk, 'pc-modern-new-worktree');
    await sheet.getByTestId('newspace-make').click();
    check((await desk.getByTestId('newspace-restart').count()) === 0, 'web-worker is off: no restart question');
    await win.locator('[data-testid="devroom-card"][data-task="feat-cart-coupon"]').waitFor({ timeout: 30_000 });
    const rec = records().find((r) => r.branch === 'feat/cart-coupon')!;
    await eventually(`web-worker works in the new worktree (${cwdOf('web-worker')})`, () => cwdOf('web-worker') === rec.path, 60_000);
    check(true, 'web-worker started in our terminal host, in the new worktree');
    await terminalShows(desk, win, 'web-worker');
    await shot(desk, 'pc-modern-terminal');

    // ── 2. 픽셀 감성: api-worker (on elsewhere) dropped on T-1's card ──
    const pix = await newPage('pixel');
    const pwin = await openRoom(pix);
    check((await pix.evaluate(() => document.documentElement.dataset.uiTheme)) === 'pixel', '픽셀 감성 is on');
    const chip = pwin.locator('[data-testid="seat-chip"][data-agent="api-worker"]');
    const card = pwin.locator(`[data-testid="devroom-card"][data-task="${t1.task}"]`);
    // Headless Chromium does not deliver the HTML5 drop from a mouse drag: the card's own handlers.
    const dt = await pix.evaluateHandle(() => new DataTransfer());
    await chip.dispatchEvent('dragstart', { dataTransfer: dt });
    await card.dispatchEvent('dragover', { dataTransfer: dt });
    await card.dispatchEvent('drop', { dataTransfer: dt });
    await chip.dispatchEvent('dragend', { dataTransfer: dt });
    await pix.getByTestId('newspace-restart').waitFor({ timeout: 10_000 });
    check(true, 'api-worker is on: asked once before it restarts there');
    await shot(pix, 'pc-pixel-restart-ask');
    await pix.getByTestId('newspace-restart-yes').click();
    await eventually(`api-worker works in T-1's worktree (${cwdOf('api-worker')})`, () => cwdOf('api-worker') === t1.path, 60_000);
    check(true, 'api-worker restarted in T-1’s worktree');
    await terminalShows(pix, pwin, 'api-worker');
    await shot(pix, 'pc-pixel-terminal');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(OUT, 'daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    const host = hostPid();
    if (host && isFakeOf(host, home)) process.kill(host, 'SIGKILL');
    killFakeSessions(home);
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

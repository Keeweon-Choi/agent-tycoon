/**
 * U-48 phase 1 check: dist/cli.js in an isolated HOME on a spare port, headless
 * Chromium with --disable-gpu. The HOME holds one engine project, three live
 * sessions (two inside the project folder, one outside), a Claude task list for
 * the busy one (a line naming the Task T-7, a blocked one, a finished one and one
 * file in a shape nobody knows), a Codex worktree with a CODEX_PROGRESS.md for a
 * running Codex task, and two Tasks. The 작업 tab's 업무 board must:
 * - show the busy session as a card under 진행 with the observed badge, its list folded
 *   under it with the agent's own words reported and the blocked line inferred, and the
 *   unreadable file as one "읽지 못함" line;
 * - show the resting session under 검토, and nothing for the session outside the project;
 * - put the line that names T-7 under the Task T-7 card (and out of the session's fold);
 * - show the Codex checklist under the run's card ([x] reported, the open box inferred);
 * - keep the MVP summary at the Tasks (1/2) and say the agent items are counted apart;
 * - follow a change of the list and of the session's rest live, and drop everything
 *   when the page is closed (the daemon's RSS is recorded in each phase);
 * - fit a phone screen (393x852).
 * Screenshots go to cld/artifacts/tracking/.
 *
 *   npx tsx cld/test/run-tracking.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  openWorkbenchTab,
  REPO_ROOT,
  seedCodexTask,
  sparePort,
  startDaemon,
  writeEngineProjects,
} from '../../server/src/cld/testHome.js';

const OUT = path.join(REPO_ROOT, 'cld/artifacts/tracking');
const CLI = path.join(REPO_ROOT, 'cld/bin/cld-gui');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__fonts/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__fonts/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const DEADLINE_MS = 150_000;
const PROJECT = 'trackdemo';
const CODEX_ID = '1024-101010-trackdemo';
const SID = { busy: 'tr000001-0000-4000-8000-000000000001', rest: 'tr000002-0000-4000-8000-000000000002', out: 'tr000003-0000-4000-8000-000000000003' };

let checks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  checks += 1;
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

const rssKb = (pid: number): number => {
  const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf-8'));
  return m ? Number(m[1]) : 0;
};
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const port = sparePort();
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({});
  const home = fake.home;
  const folder = path.join(home, 'work', PROJECT);
  const worktree = path.join(home, 'work', `${PROJECT}-codex`);
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  writeEngineProjects(home, [{ name: PROJECT, folder, room: 'orch-track' }]);

  // Three live sessions: each backed by a `sleep` whose start time is its procStart (what Claude Code writes).
  const sleepers: Array<ReturnType<typeof spawn>> = [];
  const sessionFiles = new Map<string, { file: string; body: Record<string, unknown> }>();
  const startSession = (sessionId: string, name: string, cwd: string, status: string) => {
    const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
    sleepers.push(proc);
    const stat = fs.readFileSync(`/proc/${proc.pid}/stat`, 'utf-8');
    const body = {
      pid: proc.pid,
      sessionId,
      cwd,
      startedAt: Date.now() - 600_000,
      procStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
      version: '2.1.306',
      kind: 'interactive',
      name,
      status,
    };
    fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
    const file = path.join(home, '.claude/sessions', `${proc.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(body));
    sessionFiles.set(sessionId, { file, body });
  };
  startSession(SID.busy, 'feature work', path.join(folder, 'src'), 'busy');
  startSession(SID.rest, 'review helper', folder, 'idle');
  startSession(SID.out, 'elsewhere', path.join(home, 'work', 'other'), 'busy');

  // The agents' own lists (invented text, the shape Claude Code keeps).
  const taskFile = (sid: string, id: string, f: Record<string, unknown>) => {
    const dir = path.join(home, '.claude/tasks', sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, description: 'body that must never show', blocks: [], blockedBy: [], ...f }));
  };
  taskFile(SID.busy, '1', { subject: 'Write the parser for T-7', status: 'in_progress' });
  taskFile(SID.busy, '2', { subject: 'Add unit tests', status: 'pending' });
  taskFile(SID.busy, '3', { subject: 'Read the spec', status: 'completed' });
  taskFile(SID.busy, '4', { subject: 'Ship it', status: 'pending', blockedBy: ['2'] });
  fs.writeFileSync(path.join(home, '.claude/tasks', SID.busy, '5.json'), JSON.stringify({ todos: [{ content: 'old shape' }] }));
  fs.writeFileSync(path.join(home, '.claude/tasks', SID.busy, '.lock'), '');
  taskFile(SID.out, '1', { subject: 'Outside the project', status: 'pending' });
  fs.writeFileSync(path.join(worktree, 'CODEX_PROGRESS.md'), '- [x] scaffold the module\n- [ ] wire the endpoint\n- [ ] write the docs\n');
  const sleeper = spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
  sleeper.unref();
  seedCodexTask(home, {
    id: CODEX_ID,
    project: PROJECT,
    state: 'running',
    started: new Date(Date.now() - 5 * 60_000).toISOString(),
    pid: sleeper.pid!,
    model: 'm1',
    title: 'Endpoint work',
    dir: worktree,
  });
  const seed = path.join(home, 'seed.json');
  fs.writeFileSync(
    seed,
    JSON.stringify({
      v: 1,
      tasks: [
        { id: 'T-7', project: PROJECT, title: 'Parser rewrite', status: 'doing', goal: 'Security', source: 'reported', updatedAt: new Date().toISOString() },
        { id: 'T-8', project: PROJECT, title: 'Docs pass', status: 'done', goal: 'Security', source: 'reported', updatedAt: new Date().toISOString() },
      ],
    }),
  );

  const started = startDaemon(fake, port, ['--no-terminal']);
  const daemon = started.child;
  const cleanup = () => {
    for (const p of [...sleepers, sleeper]) p.kill('SIGKILL');
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  };
  const deadline = setTimeout(() => {
    console.error(`aborted: deadline ${DEADLINE_MS / 1000} s\n${started.log.join('')}`);
    cleanup();
    process.exit(1);
  }, DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(sig, () => {
      cleanup();
      process.exit(1);
    });
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: home }, cwd: home, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`cld-gui ${args.join(' ')}: ${r.status} ${r.stderr}`);
    return r.stdout;
  };

  const fonts = fs.existsSync(FONTS.malgun)
    ? { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) }
    : null;
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const received: Array<Record<string, unknown>> = [];
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    if (fonts)
      await ctx.route('**/__fonts/*.ttf', (route) =>
        route.fulfill({ body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun, contentType: 'font/ttf' }),
      );
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('websocket', (ws) =>
      ws.on('framereceived', (f) => {
        try {
          received.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
        } catch {
          /* binary */
        }
      }),
    );
    return { ctx, page };
  };
  const ready = async (page: Page, url: string) => {
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    if (fonts) {
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
    }
  };
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const card = (page: Page, sid: string) => page.locator(`[data-testid="task-card"][data-tracked="session:${sid}"]`);
  const status = async (page: Page, sid: string) => card(page, sid).first().getAttribute('data-task-status');
  const line = (scope: ReturnType<Page['locator']>, text: string) =>
    scope.locator('[data-testid="tracked-line"]').filter({ hasText: text });

  try {
    const loginUrl = await started.loginUrl();
    cli('task', 'import', seed);
    await settle(3_000);
    const rssNoViewer = rssKb(daemon.pid!);
    console.log(`daemon RSS, no viewer: ${rssNoViewer} kB`);
    check(!received.some((m) => m.type === 'trackedItems'), 'no tracked items were sent while nobody viewed');

    // ── desktop ──
    const { ctx: deskCtx, page: desk } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await ready(desk, loginUrl);
    await openWorkbenchTab(desk, 'Task', { project: PROJECT }); // UI-C1: the board is the 작업실's Task tab
    await desk.getByTestId('task-board').waitFor();
    await until('desktop: the busy session card appears', async () => (await card(desk, SID.busy).count()) === 1);
    const busy = card(desk, SID.busy).first();
    check((await status(desk, SID.busy)) === 'doing', 'desktop: the busy session is under 진행 (doing)');
    check((await busy.getByTestId('tracked-source').first().innerText()) === '관측', 'desktop: the session card carries the 관측 badge');
    check((await status(desk, SID.rest)) === 'review', 'desktop: the resting session is under 검토');
    check((await card(desk, SID.out).count()) === 0, 'desktop: the session outside the project folder has no card');
    check(
      (await desk.locator('[data-testid="tracked-line"]', { hasText: 'Outside the project' }).count()) === 0,
      'desktop: nothing of the outside session’s list shows',
    );

    const listLine = (title: string) => line(busy, title);
    check((await listLine('Add unit tests').getAttribute('data-tracked-source')) === 'reported', 'desktop: an agent’s own status is 보고');
    check((await listLine('Add unit tests').getAttribute('data-tracked-status')) === 'todo', 'desktop: pending is 할 일');
    check((await listLine('Read the spec').getAttribute('data-tracked-status')) === 'done', 'desktop: completed is 끝남');
    check(
      (await listLine('Ship it').getAttribute('data-tracked-status')) === 'blocked' &&
        (await listLine('Ship it').getAttribute('data-tracked-source')) === 'inferred',
      'desktop: a task waiting on an unfinished one is 막힘, 추정',
    );
    check((await busy.getByTestId('tracked-unreadable').innerText()) === '읽지 못함', 'desktop: the unknown file is one 읽지 못함 line');
    check((await busy.locator('[data-testid="tracked-line"]', { hasText: 'Write the parser' }).count()) === 0, 'desktop: the line naming T-7 is not in the session fold');
    const t7 = desk.locator('[data-testid="task-card"][data-task-id="T-7"]');
    check((await line(t7, 'Write the parser for T-7').count()) === 1, 'desktop: it is under the Task T-7 card');
    check(!(await desk.getByTestId('task-board').innerText()).includes('body that must never show'), 'desktop: no description reaches the screen');

    const run = desk.locator(`[data-testid="task-card"][data-task-id="${CODEX_ID}"]`);
    await until('desktop: the Codex checklist shows', async () => (await run.locator('[data-testid="tracked-line"]').count()) === 3);
    check((await line(run, 'scaffold the module').getAttribute('data-tracked-source')) === 'reported', 'desktop: Codex [x] is 보고');
    check(
      (await line(run, 'wire the endpoint').getAttribute('data-tracked-status')) === 'doing' &&
        (await line(run, 'wire the endpoint').getAttribute('data-tracked-source')) === 'inferred',
      'desktop: the first open box of a running Codex task is 진행 중, 추정',
    );

    const mvp = await desk.getByTestId('mvp-progress').innerText();
    check(/1\/2/.test(mvp), `desktop: the MVP summary counts the Tasks only (${mvp.replace(/\n/g, ' | ')})`);
    const apart = await desk.getByTestId('tracked-apart').innerText();
    check(/추적 항목\(에이전트 목록·문서\) \d+개는 따로 셈/.test(apart), `desktop: ${apart}`);
    check(!/%.*(에이전트|세션)/.test(mvp), 'desktop: no percentage on tracked items');
    const rssViewing = rssKb(daemon.pid!);
    console.log(`daemon RSS, viewing with tracked items: ${rssViewing} kB`);
    await shot(desk, 'desktop-board');
    await busy.scrollIntoViewIfNeeded();
    await shot(desk, 'desktop-cards');

    // A change of the list and of the session's rest arrives live.
    taskFile(SID.busy, '2', { subject: 'Add unit tests', status: 'completed' });
    const s = sessionFiles.get(SID.busy)!;
    fs.writeFileSync(s.file, JSON.stringify({ ...s.body, status: 'idle' }));
    await until('desktop: the busy session rests (검토) and its blocked line is released', async () => (await status(desk, SID.busy)) === 'review');
    await until(
      'desktop: Ship it is no longer blocked',
      async () => (await listLine('Ship it').getAttribute('data-tracked-status')) === 'todo',
    );
    check((await listLine('Add unit tests').getAttribute('data-tracked-status')) === 'done', 'desktop: a list change shows without a reload');
    await shot(desk, 'desktop-board-after');

    // ── phone ──
    const { ctx: phoneCtx, page: phone } = await open({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await phoneCtx.addCookies(await deskCtx.cookies());
    await ready(phone, `http://127.0.0.1:${port}/`);
    await openWorkbenchTab(phone, 'Task', { project: PROJECT, tap: true });
    await phone.getByTestId('task-board').waitFor();
    await until('phone: the session cards show', async () => (await card(phone, SID.rest).count()) === 1);
    const widths = await phone.evaluate(() => {
      const board = document.querySelector('[data-testid="task-board"]') as HTMLElement;
      const wide = [...board.querySelectorAll<HTMLElement>('*')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1);
      return { doc: document.documentElement.scrollWidth, view: window.innerWidth, wide: wide.length };
    });
    check(widths.doc <= widths.view && widths.wide === 0, `phone: nothing wider than the screen (${JSON.stringify(widths)})`);
    await shot(phone, 'phone-board');
    await card(phone, SID.busy).first().scrollIntoViewIfNeeded();
    await shot(phone, 'phone-cards');

    // Everyone leaves: the daemon drops the index and stops reading.
    await phone.close();
    await desk.close();
    await settle(3_000);
    const rssAfter = rssKb(daemon.pid!);
    console.log(`daemon RSS, after the last viewer left: ${rssAfter} kB`);
    console.log(`RSS kB: no viewer ${rssNoViewer} -> viewing ${rssViewing} -> left ${rssAfter}`);

    check(pageErrors.length === 0, `no page errors${pageErrors.map((e) => `\n  ${e}`).join('')}`);
    console.log(`all ${checks} checks passed`);
  } finally {
    clearTimeout(deadline);
    await browser.close();
    cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

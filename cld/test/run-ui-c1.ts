/**
 * UI-C1 check: the 현황판 window keeps 현황판 and HW; jobs and Codex runs live in the 작업실.
 * dist/cli.js with an isolated HOME on a spare port, headless Chromium (--disable-gpu fixed by
 * launchBrowser), fake claude/codex only. Desktop 1280x800 and phone 393x852:
 * - the 현황판 window has two tabs (현황판, HW); the folder icon opens the explorer as 파일
 *   (no tab strip, titled 파일) and the 현황판 icon leads back to the board;
 * - the 작업실 에이전트 tab lists the Lead, then the project's Codex runs as cards (live ones
 *   first, the newest 3 finished ones after, the rest behind one fold);
 * - the Task tab's 실행 view lists the project's jobs; a job's readable log opens;
 * - a job notice and a Codex notice (one behind the fold) each land on their card;
 * - 프로젝트 없음 appears while a Task, job or run has no project, with only those items (Tasks too); notices for
 *   them land there; the entry is gone once nothing is left that way.
 * Hangul and emoji from the Windows fonts (read only). Screenshots go to cld/artifacts/ui-c1/.
 *
 *   npx tsx cld/test/run-ui-c1.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import type { ChildProcess } from 'child_process';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  openOfficeWindow,
  openWorkbenchTab,
  REPO_ROOT,
  seedCodexTask,
  seedJob,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const OUT = path.join(REPO_ROOT, 'cld/artifacts/ui-c1');
/** The 작업실 picker's entry for items of no project (webview-ui/src/cld/workbench/workbench.ts NO_PROJECT). */
const NO_PROJECT = '?none';
const P = 'alpha-orchestrator';
/** A second project: a notice's 5-minute cooldown is per character and kind, so each notice of this walk goes to its own. */
const B = 'beta-orchestrator';
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__uic1/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__uic1/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const DEADLINE_MS = 240_000;

let checks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  checks += 1;
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function main() {
  const port = sparePort();
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'S-8', agentsJson: true });
  const sleepers: ChildProcess[] = [0, 1, 2].map(() =>
    spawn('sleep', ['600'], { stdio: 'ignore', detached: true }),
  );
  sleepers.forEach((s) => s.unref());
  const [pidRun, pidLimit, pidJob] = sleepers.map((s) => s.pid!);

  // The project's Codex runs: two live, five finished (the oldest behind the fold), and one
  // run (with a job) of a project nobody owns.
  const codex = (o: Parameters<typeof seedCodexTask>[1]) => seedCodexTask(fake.home, o);
  codex({ id: '1024-100001-run', project: P, state: 'running', started: ago(12), pid: pidRun, model: 'gpt-5-codex', commits: 2, title: 'Rename the settings module' });
  codex({ id: '1024-100002-limit', project: P, state: 'limit', started: ago(30), pid: pidLimit, model: 'gpt-5-codex', title: 'Port the importer' });
  const finished = ['1024-100011-f1', '1024-100012-f2', '1024-100013-f3', '1024-100014-f4', '1024-100015-old'];
  finished.forEach((id, i) =>
    codex({
      id,
      project: P,
      state: i === 1 ? 'failed' : 'done',
      started: ago(120 + i * 30),
      ended: ago(100 + i * 30),
      exit: i === 1 ? 1 : 0,
      commits: i,
      title: `Finished run ${i + 1}`,
    }),
  );
  codex({ id: '1024-100020-ghost', project: 'ghost', state: 'done', started: ago(90), ended: ago(80), exit: 0, title: 'Run of no project' });

  // The project's jobs: one running (with a readable log), one ended (its notice follows);
  // and two of no project.
  const jobsDir = path.join(fake.home, '.local/state/cld-gui/jobs');
  const runId = seedJob(fake.home, { id: '1024-100030-train', pid: pidJob, project: P, cmd: 'bash train.sh', started: ago(8) });
  fs.writeFileSync(path.join(jobsDir, `${runId}.log`), 'loading data\nepoch 1/3 done\nhello from the job\n');
  const endedId = seedJob(fake.home, { id: '1024-100031-eval', pid: 6001, project: B, cmd: 'bash eval.sh', started: ago(20), ended: ago(10), exit: 0 });
  seedJob(fake.home, { id: '1024-100033-early', pid: 6003, project: P, cmd: 'bash early.sh', started: ago(40), ended: ago(30), exit: 0 });
  const ghostJob = seedJob(fake.home, { id: '1024-100032-outside', pid: 6002, project: null, cmd: 'bash outside.sh', started: ago(20), ended: ago(15), exit: 0 });

  const started = startDaemon(fake, port, ['--no-terminal']);
  const daemon = started.child;
  /** `cld-gui …` as an agent would run it, against this HOME's daemon. */
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
      env: { PATH: process.env.PATH, HOME: fake.home },
      cwd: fake.home,
      encoding: 'utf-8',
    });
    if (r.status !== 0) throw new Error(`cld-gui ${args.join(' ')}: ${r.status} ${r.stderr}`);
  };
  const events = path.join(fake.home, '.config/cld-gui/events.jsonl');
  const cleanup = () => {
    for (const s of sleepers) s.kill('SIGKILL');
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    fs.rmSync(fake.home, { recursive: true, force: true });
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

  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    await ctx.route('**/__uic1/*.ttf', (route) =>
      route.fulfill({
        body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun,
        contentType: 'font/ttf',
      }),
    );
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const ready = async (page: Page, url: string) => {
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
  };
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const append = (line: Record<string, unknown>) =>
    fs.appendFileSync(events, JSON.stringify({ ts: new Date().toISOString(), ...line }) + '\n');

  /** One viewport's whole walk. `tap`: the phone. */
  async function walk(page: Page, view: string, tap: boolean) {
    const click = (l: ReturnType<Page['locator']>) => (tap ? l.tap() : l.click());
    const win = page.locator('[data-hud-window="workbench"], [aria-label="작업실 화면"]');
    const picker = win.getByRole('combobox', { name: '작업실 프로젝트' });
    const noHorizontalScroll = async (what: string) =>
      check(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${view}: no horizontal scroll (${what})`,
      );

    // ── 1. The 현황판 window: two tabs; the folder icon is its 파일 mode ──
    if (tap) await click(page.locator('[data-hud-id="icon:office"] button').first());
    else await openOfficeWindow(page);
    const nav = page.getByRole('navigation', { name: tap ? '작업 메뉴' : '사무실 메뉴' });
    await nav.waitFor();
    const tabs = (await nav.getByRole('button').allInnerTexts()).map((x) => x.trim());
    check(JSON.stringify(tabs) === JSON.stringify(['현황판', 'HW']), `${view}: the 현황판 has the tabs ${tabs.join(' | ')}`);
    await shot(page, `${view}-board-two-tabs`);
    await click(page.locator('[data-hud-id="icon:files"] button'));
    const explorer = page.locator('section[aria-label="파일 탐색"]');
    await explorer.waitFor();
    check(
      (await nav.count()) === 0 &&
        (await page.getByText('파일', { exact: true }).first().isVisible()),
      `${view}: the folder icon opens the explorer as 파일, without a tab strip`,
    );
    await noHorizontalScroll('explorer');
    await shot(page, `${view}-files`);
    // The board icon leads back to the tabs.
    await click(page.locator('[data-hud-id="icon:office"] button').first());
    await nav.waitFor();
    check(true, `${view}: the 현황판 icon leaves the explorer for the board tabs`);
    if (!tap) await click(page.locator('[data-hud-id="icon:office"] button').first()); // close it
    else await click(page.locator('[data-hud-id="icon:office"] button').first());

    // ── 2. 작업실 에이전트: the Lead, then the Codex runs ──
    await openWorkbenchTab(page, '에이전트', { project: P, tap });
    await win.getByTestId('workbench-codex').first().waitFor();
    const cards = await win.getByTestId('workbench-codex').evaluateAll((els) =>
      els.map((el) => ({
        ref: el.getAttribute('data-codex-ref'),
        text: (el as HTMLElement).innerText,
      })),
    );
    const live = cards.filter((c) => /실행 중|한도 대기/.test(c.text.split('\n').slice(0, 4).join(' ')));
    check(
      cards.map((c) => c.ref).join() === '1024-100001-run,1024-100002-limit,1024-100011-f1,1024-100012-f2,1024-100013-f3' ||
        cards.map((c) => c.ref).join() === '1024-100002-limit,1024-100001-run,1024-100011-f1,1024-100012-f2,1024-100013-f3',
      `${view}: live runs first, then the newest 3 finished (${cards.map((c) => c.ref).join(', ')})`,
    );
    check(live.length === 2, `${view}: two live cards`);
    check(
      cards.every((c) => c.text.includes('Codex')) && cards[0].text.includes('gpt-5-codex'),
      `${view}: a Codex badge and the model on the cards`,
    );
    const fold = win.locator('[data-codex-refs]');
    check(
      (await fold.count()) === 1 && ((await fold.innerText()).includes('끝난 Codex 2개 더')),
      `${view}: the older finished runs sit behind one fold ("${await fold.innerText()}")`,
    );
    check(
      (await win.getByTestId('workbench-agent').count()) === 1,
      `${view}: the Lead card comes first (and no ghost run here)`,
    );
    await noHorizontalScroll('agents');
    await shot(page, `${view}-workbench-agents`);
    await click(fold);
    await win.locator('[data-codex-ref="1024-100015-old"]').waitFor();
    await win.locator('[data-codex-ref="1024-100015-old"]').scrollIntoViewIfNeeded();
    await shot(page, `${view}-workbench-agents-fold-open`);
    await click(fold); // folded again

    // ── 3. Task tab, 실행: the project's jobs and a readable log ──
    await openWorkbenchTab(page, 'Task', { project: P, tap });
    await click(win.getByRole('group', { name: '작업 보기' }).getByRole('button', { name: '실행', exact: true }));
    const runCard = win.locator(`[data-job-ref="${runId}"]`);
    await runCard.waitFor();
    check(
      (await win.getByTestId('job-card').count()) === 2 && (await win.locator(`[data-job-ref="${ghostJob}"]`).count()) === 0,
      `${view}: the project's two jobs only (the job of no project is not here)`,
    );
    await click(runCard.getByRole('button', { name: /로그/ }));
    await runCard.getByTestId('job-digest').filter({ hasText: 'hello from the job' }).waitFor({ timeout: 10_000 });
    check(true, `${view}: the job's readable log opens`);
    await noHorizontalScroll('jobs');
    await runCard.scrollIntoViewIfNeeded();
    await shot(page, `${view}-workbench-tasks-log`);

    // ── 4. Notices land on their card ──
    append({ type: 'job_end', project: B, id: endedId, pid: 6001, exit: 0 });
    const toast = page.locator('[data-testid="notice-toast"]');
    await toast.waitFor({ timeout: 15_000 });
    // Look away first: another project, another tab.
    await openWorkbenchTab(page, '에이전트', { project: P, tap });
    await click(toast);
    const jobCard = win.locator(`[data-job-ref="${endedId}"]`);
    await jobCard.waitFor();
    await until(`${view}: the job card is marked`, async () => (await jobCard.getAttribute('data-focused')) === 'true');
    check(
      (await picker.inputValue()) === B &&
        (await win.getByRole('button', { name: 'Task', exact: true }).getAttribute('aria-pressed')) === 'true',
      `${view}: the job notice opens the 작업실 on ${B}, Task tab, at its card`,
    );
    await shot(page, `${view}-notice-job`);

    append({ type: 'codex_end', project: P, id: '1024-100015-old', state: 'done', exit: 0, title: 'Finished run 5' });
    await until(`${view}: the Codex toast`, async () => (await toast.count()) > 0 && ((await toast.textContent()) ?? '').includes('Finished run 5'), 15_000);
    await click(toast);
    const oldCard = win.locator('[data-codex-ref="1024-100015-old"]');
    await oldCard.waitFor();
    await until(`${view}: the Codex card is marked`, async () => (await oldCard.getAttribute('data-focused')) === 'true');
    check(
      (await picker.inputValue()) === P &&
        (await win.getByRole('button', { name: '에이전트', exact: true }).getAttribute('aria-pressed')) === 'true',
      `${view}: the Codex notice opens the 에이전트 tab at a card behind the fold (the fold opened)`,
    );
    await shot(page, `${view}-notice-codex`);

    // ── 5. 프로젝트 없음 ──
    const options = await picker.locator('option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));
    check(options.at(-1) === NO_PROJECT && options.filter((o) => o === NO_PROJECT).length === 1, `${view}: 프로젝트 없음 is the picker's last entry`);
    await openWorkbenchTab(page, '에이전트', { project: NO_PROJECT, tap });
    await win.locator('[data-codex-ref="1024-100020-ghost"]').waitFor();
    check(
      (await win.getByTestId('workbench-codex').count()) === 1 && (await win.getByTestId('workbench-agent').count()) === 0,
      `${view}: 프로젝트 없음 lists only its Codex run, no Lead card`,
    );
    check(
      (await win.getByRole('button', { name: /Worker/ }).count()) === 0 && (await win.getByRole('button', { name: /Lead 로/ }).count()) === 0,
      `${view}: no Worker or Lead actions there`,
    );
    await shot(page, `${view}-no-project-agents`);
    await click(win.getByRole('button', { name: 'Task', exact: true }));
    await win.locator(`[data-job-ref="${ghostJob}"]`).waitFor();
    check(
      (await win.getByTestId('job-card').count()) === 1 && (await win.getByRole('button', { name: 'worktree', exact: true }).count()) === 0,
      `${view}: its Task tab lists only the job of no project in 실행 (and has no worktree tab)`,
    );
    // The 업무 half: a Task under an unknown project is not invisible, it is here.
    await click(win.getByRole('group', { name: '작업 보기' }).getByRole('button', { name: '업무', exact: true }));
    await win.locator('[data-testid="task-card"]', { hasText: 'Task of no project' }).first().waitFor();
    check(
      (await win.locator('[data-testid="task-card"]', { hasText: 'Task of an owned project' }).count()) === 0,
      `${view}: a Task under an unknown project shows on the 업무 board of 프로젝트 없음, an owned one does not`,
    );
    await shot(page, `${view}-no-project-board`);
    await click(win.getByRole('group', { name: '작업 보기' }).getByRole('button', { name: '실행', exact: true }));
    await shot(page, `${view}-no-project-tasks`);
    // Notices of items nobody owns land here, from another project.
    await openWorkbenchTab(page, '에이전트', { project: P, tap });
    append({ type: 'job_end', project: null, id: ghostJob, pid: 6002, exit: 0 });
    await toast.waitFor({ timeout: 15_000 });
    await click(toast);
    await win.locator(`[data-job-ref="${ghostJob}"]`).waitFor();
    check((await picker.inputValue()) === NO_PROJECT, `${view}: the notice of a job with no project opens 프로젝트 없음`);
  }

  try {
    const loginUrl = await started.loginUrl();
    cli('task', 'add', 'Task of no project', '--project', 'ghost');
    cli('task', 'add', 'Task of an owned project', '--project', P);
    const { ctx: deskCtx, page: desk } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await ready(desk, loginUrl);
    await walk(desk, 'desktop', false);

    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await deskCtx.cookies());
    await ready(phone, `http://127.0.0.1:${port}/`);
    await walk(phone, 'phone', true);

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

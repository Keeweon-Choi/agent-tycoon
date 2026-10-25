/**
 * T-0047/T-0068 check: dist/cli.js with an isolated HOME on a spare port, headless
 * Chromium with --disable-gpu. The engine's job records hold 3 running jobs (one
 * whose log has a tqdm bar) and 25 ended ones (2 failed; 20 of them older than
 * an hour; one recent is the installer, whose log prints a first-device login
 * URL). The 작업실's Task tab (UI-C1: under 프로젝트 없음), on desktop (1280x800) and phone (393x852), must:
 * - name each job by what it is (a name derived from its command: 학습, 배포,
 *   bash 작업…), never the command itself, a pid or an exit code;
 * - give every running job a bar: tqdm's %, speed and remaining time; the last
 *   runs' median ("지난번 10분 · 약 N분 남음"); or an indeterminate first run;
 * - say outcomes in words ("끝남(성공) · N분 걸림", "실패 · N분 걸림"), never 실행 중;
 * - keep the command and pid in the folded 자세히 row;
 * - show the installer's log as a step digest with the login code masked, the
 *   raw log one click away and masked too;
 * - list the 3 running first, the 5 recent ended after, and fold the 20 older
 *   ones into one line that expands.
 * Hangul and emoji from the Windows fonts (read only). Screenshots go to
 * cld/artifacts/t0068/.
 *
 *   npx tsx cld/test/run-jobs-tab.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { maskSecrets } from '../../server/src/cld/engine/jobs.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  openOfficeWindow,
  openWorkbenchTab,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0068');
/** The 작업실 picker's entry for jobs of no project (webview-ui/src/cld/workbench/workbench.ts NO_PROJECT). */
const NO_PROJECT = '?none';
/** U-03 / U-04 screenshots. */
const OUT_U = path.join(REPO_ROOT, 'cld/artifacts/u03-u04');
const INSTALL_LOG = path.join(REPO_ROOT, 'server/src/cld/fixtures/install-dry-run.txt');
const LOGIN_CODE = 'K7Q2M9XZ';
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0047/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0047/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const SECRET = 'SECRET-TOKEN-123';
const DEADLINE_MS = 260_000;

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

const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

/** 3 running (alpha: tqdm log, eta: no history, beta: plain log) + 25 ended (2 failed). */
function seedJobs(home: string, alive: number[]): void {
  const dir = path.join(home, '.local/state/cld-gui/jobs');
  const logs = dir;
  fs.mkdirSync(dir, { recursive: true });
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
  const pstart = (pid: number) =>
    fs.readFileSync(`/proc/${pid}/stat`, 'utf-8').split(') ').pop()!.split(' ')[19];
  // A tqdm bar for alpha (46%), a plain log for beta; eta has none.
  fs.writeFileSync(
    path.join(logs, '1021-150500-alpha.log'),
    'loading data\nepoch 3/10\ntrain:  46%|████▌     | 460/1000 [01:23<01:40,  5.41it/s]',
  );
  // The last runs of `bash 작업` took 10 minutes: eta's bar is "지난번 10분 · …".
  fs.mkdirSync(path.join(home, '.config/cld-gui'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/job-history.json'),
    JSON.stringify({ 'bash 작업': [600_000, 600_000, 600_000] }),
  );
  fs.writeFileSync(path.join(logs, '1022-010000-beta.log'), 'loading data\nepoch 3/10\n');
  fs.writeFileSync(path.join(logs, '1022-011000-eta.log'), 'evaluating\n');
  // The installer's real dry-run output, with a login code that must never be readable.
  fs.writeFileSync(
    path.join(logs, '1022-000000-step0.log'),
    fs.readFileSync(INSTALL_LOG, 'utf-8').replaceAll('DRY_RUN_CODE', LOGIN_CODE),
  );
  const job = (o: Record<string, unknown>) => {
    const pid = o.pid as number;
    const live = alive.includes(pid);
    return {
      id: `1022-${String(pid).padStart(6, '0')}-job`,
      pstart: live ? pstart(pid) : null,
      boot,
      dir: '/work',
      tab: null,
      tty: false,
      source: 'cli',
      ended: null,
      exit: null,
      desc: null,
      ...o,
      // The engine stores the command line masked, as `cld-gui job` does.
      cmd: maskSecrets(String(o.cmd)),
    };
  };
  const jobs = [
    job({
      pid: alive[0],
      project: 'alpha',
      cmd: `python train.py --api-key ${SECRET}`,
      log: `${logs}/1021-150500-alpha.log`,
      started: iso(12),
    }),
    job({
      pid: alive[1],
      project: 'eta',
      cmd: `bash eval.sh ${SECRET}`,
      log: `${logs}/1022-011000-eta.log`,
      started: iso(5),
    }),
    job({
      pid: alive[2],
      project: 'beta',
      cmd: `npm test -- --token=${SECRET}`,
      log: `${logs}/1022-010000-beta.log`,
      started: iso(25),
    }),
  ];
  // 5 recent (4 done, 1 failed) and 20 older than an hour (19 done, 1 failed).
  for (let i = 0; i < 5; i++)
    jobs.push(
      job({
        pid: 6000 + i,
        project: 'alpha',
        cmd: i === 0 ? 'node cld/install/install.mjs' : `bash step${i}.sh ${SECRET}`,
        log: `${logs}/1022-0${i}0000-step${i}.log`,
        started: iso(50 + i * 3),
        ended: iso(40 + i * 3),
        exit: i === 2 ? 1 : 0,
      }),
    );
  for (let i = 0; i < 20; i++)
    jobs.push(
      job({
        pid: 7000 + i,
        project: 'pofol',
        cmd: `python train.py --api-key ${SECRET}`,
        log: `${logs}/1021-1${String(i).padStart(2, '0')}000-run${i}.log`,
        started: iso(200 + i * 10),
        ended: iso(120 + i * 10),
        exit: i === 7 ? 2 : 0,
      }),
    );
  for (const j of jobs) fs.writeFileSync(path.join(dir, `${j.id}.json`), `${JSON.stringify(j)}\n`);
}

/** A live job record for `project` (a `sleep` stands in for the process); `gpu` = a GPU job. */
function addLiveJob(
  home: string,
  tag: string,
  o: { project: string; gpu?: boolean; minAgo?: number; log?: string },
): { id: string; proc: ChildProcess } {
  const proc = spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
  proc.unref();
  const pid = proc.pid!;
  const dir = path.join(home, '.local/state/cld-gui/jobs');
  const id = `1023-${String(pid).padStart(6, '0')}-${tag}`;
  const log = path.join(dir, `${id}.log`);
  fs.writeFileSync(log, o.log ?? 'working\n');
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      pid,
      pstart: fs.readFileSync(`/proc/${pid}/stat`, 'utf-8').split(') ').pop()!.split(' ')[19],
      boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim(),
      project: o.project,
      cmd: `bash ${tag}.sh`,
      desc: tag,
      dir: '/work',
      tab: null,
      tty: false,
      log,
      started: iso(o.minAgo ?? 3),
      ended: null,
      exit: null,
      source: 'cli',
      ...(o.gpu && { gpu: true }),
    }) + '\n',
  );
  return { id, proc };
}

async function main() {
  const port = sparePort();
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(OUT_U, { recursive: true });
  const fake = makeFakeHome({ claude: 'S-8', agentsJson: true });
  // Three live processes stand for the running jobs.
  const sleepers = [0, 1, 2].map(() =>
    spawn('sleep', ['600'], { stdio: 'ignore', detached: true }),
  );
  sleepers.forEach((s) => s.unref());
  const pids = sleepers.map((s) => s.pid!);
  seedJobs(fake.home, pids);
  const extra: ChildProcess[] = [];
  const started = startDaemon(fake, port, ['--no-terminal']);
  const daemon = started.child;
  const log = started.log;
  const cleanup = () => {
    for (const s of [...sleepers, ...extra]) s.kill('SIGKILL');
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    fs.rmSync(fake.home, { recursive: true, force: true });
  };
  const deadline = setTimeout(() => {
    console.error(`aborted: deadline ${DEADLINE_MS / 1000} s\n${log.join('')}`);
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
    await ctx.route('**/__t0047/*.ttf', (route) =>
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
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const shotU = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT_U, `${name}.png`) });

  /** The assertions, on one viewport's open 작업 tab. */
  async function verify(page: Page, view: string) {
    const panel = page.getByTestId('jobs-panel');
    await until(
      `${view}: 8 job cards`,
      async () => (await panel.getByTestId('job-card').count()) === 8,
    );
    const cards = await panel.getByTestId('job-card').evaluateAll((els) =>
      els.map((el) => ({
        kind: el.getAttribute('data-job-kind'),
        what: el.querySelector('[data-testid="job-what"]')?.textContent ?? '',
        status: el.querySelector('[data-testid="job-status"]')?.textContent ?? '',
        progress: el.querySelector('[data-testid="job-progress"]')?.textContent ?? null,
        bars: el.querySelectorAll('[role="progressbar"]').length,
        // What a person sees: the folded 자세히 row's content is not rendered.
        text: (el as HTMLElement).innerText,
      })),
    );
    const running = cards.filter((c) => c.kind === 'running');
    check(
      running.length === 3 && cards.slice(0, 3).every((c) => c.kind === 'running'),
      `${view}: the 3 running jobs come first`,
    );
    check(
      running.every((c) => /^실행 중 · \d+분째$/.test(c.status)),
      `${view}: running jobs say 실행 중 and how long: ${running.map((c) => c.status).join(' | ')}`,
    );
    check(
      running.every((c) => c.bars === 1) && cards.filter((c) => c.bars > 0).length === 3,
      `${view}: every running job has a bar, no ended one does`,
    );
    const bars = running.map((c) => c.progress ?? '');
    check(
      bars.some((p) => /^46% · 5\.41it\/s · 남은 시간 01:40$/.test(p)) &&
        bars.some((p) => /^지난번 10분 · 약 \d+분 남음$/.test(p)) &&
        bars.some((p) => /^첫 실행 · \d+분째$/.test(p)),
      `${view}: tqdm, last-run and first-run bars: ${bars.join(' | ')}`,
    );
    const ended = cards.filter((c) => c.kind !== 'running');
    check(ended.length === 5, `${view}: the 5 recent ended jobs are cards`);
    check(
      ended.every((c) => !c.text.includes('실행 중') && !c.text.includes('째')),
      `${view}: an ended job never says 실행 중`,
    );
    check(
      ended.filter((c) => /^끝남\(성공\) · \d+분 걸림$/.test(c.status)).length === 4 &&
        ended.filter((c) => /^실패 · \d+분 걸림$/.test(c.status)).length === 1,
      `${view}: outcomes in words: ${ended.map((c) => c.status).join(' | ')}`,
    );
    const whats = cards.map((c) => c.what);
    check(
      ['학습', 'bash 작업', 'npm 작업', '배포'].every((name) => whats.includes(name)),
      `${view}: each card is named by what it is (${whats.join(' | ')})`,
    );
    // Negative control: the raw commands exist (in 자세히), just never on the main line.
    check(
      whats.every((w) => !/train\.py|eval\.sh|install\.mjs|step\d|--/.test(w)),
      `${view}: no raw command on a card's main line`,
    );
    check(
      cards.every((c) => !/#\d|종료 코드|exit|PID|600\d/.test(c.text)),
      `${view}: no pid or exit code in any card's visible text`,
    );
    check(
      !(await page.content()).includes(SECRET),
      `${view}: no secret from a command reaches the page`,
    );

    // 자세히 unfolds the command and the pid.
    const alpha = panel.getByTestId('job-card').filter({ hasText: '학습' }).first();
    const details = alpha.getByTestId('job-details');
    await details.locator('summary').click();
    await until(`${view}: 자세히 unfolds`, async () =>
      /명령 python train\.py/.test(await details.innerText()),
    );
    const unfolded = await details.innerText();
    check(
      unfolded.includes(`PID ${pids[0]}`) &&
        unfolded.includes('python train.py') &&
        !unfolded.includes(SECRET),
      `${view}: 자세히 holds the command (its secret masked) and the pid: ${unfolded.split('\n')[0]}`,
    );
    await details.locator('summary').click();

    // The installer: a step digest, the login code masked in it and in the raw log.
    const install = panel.getByTestId('job-card').filter({ hasText: '배포' }).first();
    await install.getByRole('button', { name: /로그/ }).click();
    const digest = install.getByTestId('job-digest');
    await until(`${view}: the installer digest`, async () =>
      (await digest.innerText()).includes('✓ 빌드'),
    );
    const digestText = await digest.innerText();
    check(
      ['프로토콜 생성', '빌드', '화면 빌드', '설정', '서비스 다시 켜기', '끝'].every((s) =>
        digestText.includes(`✓ ${s}`),
      ) &&
        digestText.includes('/login?code=***') &&
        !digestText.includes(LOGIN_CODE),
      `${view}: the installer digests to its steps, the login URL masked`,
    );
    await install.scrollIntoViewIfNeeded();
    await shot(page, `${view}-install-digest`);
    await install.getByRole('button', { name: '원본 로그' }).click();
    const raw = install.getByTestId('job-raw');
    await until(`${view}: the raw log`, async () => (await raw.innerText()).includes('code=***'));
    check(
      !(await raw.innerText()).includes(LOGIN_CODE) && !(await page.content()).includes(LOGIN_CODE),
      `${view}: the raw log masks the login code too`,
    );
    await install.getByRole('button', { name: '읽기 쉬운 로그' }).click();
    await install.getByRole('button', { name: /로그 ▲/ }).click();
    await panel.getByTestId('job-card').first().scrollIntoViewIfNeeded();

    const fold = page.getByTestId('job-fold');
    check((await fold.count()) === 1, `${view}: one fold line`);
    check(
      ((await fold.textContent()) ?? '').trim() === 'pofol 끝난 작업 20개 · 실패 1',
      `${view}: the fold says "${(await fold.textContent())?.trim()}"`,
    );
    await shot(page, `${view}-jobs`);
    await fold.getByRole('button').first().click();
    await until(
      `${view}: the fold expands`,
      async () => (await panel.getByTestId('job-card').count()) === 28,
    );
    check(
      (await fold
        .getByTestId('job-status')
        .filter({ hasText: /^실패 · .+ 걸림$/ })
        .count()) === 1,
      `${view}: the expanded fold holds its 20 cards, the failed one in words`,
    );
    await fold.scrollIntoViewIfNeeded();
    await shot(page, `${view}-jobs-expanded`);
    await fold.getByRole('button').first().click();
    await until(
      `${view}: the fold collapses`,
      async () => (await panel.getByTestId('job-card').count()) === 8,
    );
  }

  try {
    const loginUrl = await started.loginUrl();

    const { ctx: deskCtx, page: desk } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await ready(desk, loginUrl);
    // UI-C1: the job list is the 작업실's Task tab (실행); the seeded jobs' projects are no
    // orchestrator here, so they sit under 프로젝트 없음.
    await openWorkbenchTab(desk, 'Task', { project: NO_PROJECT });
    await verify(desk, 'desktop');

    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await deskCtx.cookies());
    await ready(phone, `http://127.0.0.1:${port}/`);
    await openWorkbenchTab(phone, 'Task', { project: NO_PROJECT, tap: true });
    await verify(phone, 'phone');

    // ── U-03: a job held in the GPU queue is a wait of its own, not 실행 중 ──
    // (the daemon republishes the jobs every 10 s while one runs; a lease is a file the wrapper writes)
    const jobsDir = path.join(fake.home, '.local/state/cld-gui/jobs');
    const WHO = 'beta-orchestrator';
    const gpuJob = addLiveJob(fake.home, 'gpuwait', { project: WHO, gpu: true, minAgo: 4 });
    extra.push(gpuJob.proc);
    await openWorkbenchTab(desk, 'Task', { project: WHO });
    await desk
      .getByRole('group', { name: '작업 보기' })
      .getByRole('button', { name: '실행', exact: true })
      .click();
    const card = desk.locator(`[data-testid="job-card"][data-job-ref="${gpuJob.id}"]`);
    const readCard = async () => ({
      kind: await card.getAttribute('data-job-kind'),
      status: (await card.getByTestId('job-status').textContent()) ?? '',
      times: (await card.getByTestId('job-times').textContent()) ?? '',
      bars: await card.locator('[role="progressbar"]').count(),
      badge: (await card.getByTestId('job-gpu').count())
        ? ((await card.getByTestId('job-gpu').textContent()) ?? '').trim()
        : '',
    });
    await until('the GPU-queued job has a card', async () => (await card.count()) === 1, 25_000);
    let c = await readCard();
    check(
      c.kind === 'gpuWait' && /^GPU 대기 · \d+분째$/.test(c.status) && !/진행 중|실행 중/.test(c.status),
      `U-03: a job in the GPU queue reads "${c.status}", not 진행 중 or 실행 중`,
    );
    check(c.bars === 0, 'U-03: no bar or percent is drawn for a job that has not started');
    check(
      /^생성 \d+분 전 · 시작 전$/.test(c.times),
      `U-03: created and start are apart; before the lease: "${c.times}"`,
    );
    // The lobby's board says the same word in its 작업 column (the 프로젝트 page, whichever page it turned to).
    const boardRow = desk.locator('[data-testid="lobby-board"] [data-testid="board-project"]', {
      hasText: WHO,
    });
    await desk
      .locator('[data-testid="lobby-board"] [data-testid="board-tab-projects"]')
      .evaluate((el) => (el as HTMLElement).click());
    await until(
      'the lobby board shows the wait',
      async () => /GPU 대기/.test((await boardRow.textContent().catch(() => '')) ?? ''),
      15_000,
    );
    check(true, 'U-03: the lobby board row reads GPU 대기 too: same word as the 작업 tab');
    await card.scrollIntoViewIfNeeded();
    await shotU(desk, 'u03-gpu-wait');
    fs.writeFileSync(path.join(jobsDir, `${gpuJob.id}.gpu`), 'gpu0\n');
    await until(
      'the leased job runs',
      async () => (await card.getAttribute('data-job-kind')) === 'running',
      25_000,
    );
    c = await readCard();
    check(
      /^실행 중 · \d+초째$/.test(c.status) &&
        /^생성 \d+분 전 · 시작 (방금|\d+분 전)$/.test(c.times) &&
        c.badge.includes('GPU 예약'),
      `U-03: once leased it runs, counted from its real start: "${c.status}", "${c.times}", ${c.badge}`,
    );
    await card.scrollIntoViewIfNeeded();
    await shotU(desk, 'u03-gpu-leased');

    // ── U-04: the 현황판 hourglass count follows jobs starting and ending, with no reload ──
    await openOfficeWindow(desk);
    await desk
      .getByRole('navigation', { name: '사무실 메뉴' })
      .getByRole('button', { name: '현황판', exact: true })
      .click();
    const row = desk.locator('article', { has: desk.locator('h3', { hasText: WHO }) });
    await row.locator('button[aria-expanded]').first().click();
    const summary = row.getByTestId('job-summary');
    const summaryIs = (text: string | null) => async () =>
      text === null
        ? (await summary.count()) === 0
        : (await summary.count()) > 0 && ((await summary.textContent()) ?? '').trim() === text;
    await until('one running job is counted', summaryIs('⏳ 작업 중 1'), 25_000);
    check(true, 'U-04: the running job is counted: ⏳ 작업 중 1');
    const second = addLiveJob(fake.home, 'second', { project: WHO, gpu: true, minAgo: 1 });
    extra.push(second.proc);
    await until('a second job queues for the GPU', summaryIs('⏳ 작업 중 1 · ⌛ GPU 대기 1'), 25_000);
    check(true, 'U-04: a job that starts waiting adds its own line: ⏳ 작업 중 1 · ⌛ GPU 대기 1');
    fs.writeFileSync(path.join(jobsDir, `${second.id}.gpu`), 'gpu1\n');
    await until('the second job runs', summaryIs('⏳ 작업 중 2'), 25_000);
    check(true, 'U-04: leasing moves it from the wait to the count: ⏳ 작업 중 2');
    await shotU(desk, 'u04-hourglass-2');
    gpuJob.proc.kill('SIGKILL');
    await until('one job ends', summaryIs('⏳ 작업 중 1'), 25_000);
    check(true, 'U-04: a job ending lowers the count: ⏳ 작업 중 1');
    second.proc.kill('SIGKILL');
    await until('the last job ends', summaryIs(null), 25_000);
    check(true, 'U-04: with no job left the count is gone');
    await shotU(desk, 'u04-hourglass-0');

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

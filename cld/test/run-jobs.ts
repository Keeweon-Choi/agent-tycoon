/**
 * T-0019 visual check: dist/cli.js with --engine on --allow-actions
 * in an isolated HOME (the engine fake as `claude`), on a spare port. The
 * `cld-gui` CLI starts jobs from a project folder over the daemon's local
 * socket; the job panel shows them like office's (progress bar, 엔진), reads a
 * log and stops one after its confirmation; the feed shows the engine's
 * events; a send to a project that is off lands in its inbox. Phone too, with
 * T-0008's inset-strip rule. Records the daemon's RSS.
 *
 *   npx tsx cld/test/run-jobs.ts <port 18256-18259>
 */
import type { Browser, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  openWorkbenchTab,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0019');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0019/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 180_000;
/** T-0068: a job started with -d is named by it; one without, by its command. */
const DESC = '모델 학습(흉내)';
const INSETS = { top: 59, bottom: 34 };

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

const rssMb = (pid: number, field = 'VmRSS'): number => {
  const m = new RegExp(`${field}:\\s+(\\d+) kB`).exec(
    fs.readFileSync(`/proc/${pid}/status`, 'utf-8'),
  );
  return m ? Math.round(Number(m[1]) / 1024) : -1;
};

/** T-0008's rule: nothing tappable or text-bearing in an inset strip. */
async function noStrips(page: Page, view: string): Promise<void> {
  const out = await page.evaluate((ins) => {
    const H = window.innerHeight;
    const bad: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('[data-testid="agent-overlay"], [data-testid="ez-mood"], canvas')) continue;
      const tappable = el.matches('button, a[href], input, [role="button"], [role="tab"]');
      const texty = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
      if (!tappable && !texty) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') continue;
      const r = el.getBoundingClientRect();
      let [y0, y1] = [Math.max(r.top, 0), Math.min(r.bottom, H)];
      for (let a = el.parentElement; a; a = a.parentElement) {
        const st = getComputedStyle(a);
        if (st.overflowX === 'visible' && st.overflowY === 'visible') continue;
        const c = a.getBoundingClientRect();
        [y0, y1] = [Math.max(y0, c.top), Math.min(y1, c.bottom)];
      }
      if (y1 - y0 < 1 || r.width < 1) continue;
      if (y0 < ins.top || y1 > H - ins.bottom)
        bad.push(`<${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 24)}"`);
    }
    return bad;
  }, INSETS);
  check(out.length === 0, `inset strips empty (${view})${out.map((l) => `\n  ${l}`).join('')}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const folder = path.join(home, 'projects', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(path.join(home, '.config/cld-gui'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/projects.json'),
    JSON.stringify([{ name: 'alpha', folder, wantRunning: false }]),
  );
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, [
    '--engine',
    'on',
    '--no-terminal',
    '--allow-actions',
  ]);
  const { child: server, log: serverLog } = daemon;
  const loginUrl = daemon.loginUrl();
  const cleanupHome = () => {
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    cleanupHome();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));
  /** The CLI as an orchestrator in that project folder runs it. */
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
      cwd: folder,
      env: { PATH: process.env.PATH, HOME: home, CLD_OUTPUT: 'json' },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { code: r.status, out: JSON.parse(r.stdout || '{}') as Record<string, unknown> };
  };
  const rss: Record<string, number> = {};
  let browser: Browser | undefined;
  const font = fs.readFileSync(FONT);
  const open = async (opts: Parameters<Browser['newContext']>[0]) => {
    const ctx = await browser!.newContext(opts);
    await ctx.route('**/__t0019/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    return { ctx, page: await ctx.newPage() };
  };
  const hangul = async (page: Page, insets?: typeof INSETS) => {
    await page.addStyleTag({ content: FONT_CSS });
    if (insets)
      await page.addStyleTag({
        content: `:root { --cld-safe-top: ${insets.top}px !important; --cld-safe-bottom: ${insets.bottom}px !important; }`,
      });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });

  try {
    await loginUrl;
    await new Promise((r) => setTimeout(r, 3_000));
    rss.noViewer = rssMb(server.pid!);
    check(
      fs.statSync(path.join(home, '.config/cld-gui/engine.sock')).isSocket(),
      'the daemon listens on ~/.config/cld-gui/engine.sock',
    );

    // Jobs from the project folder, over the local socket.
    const long = cli([
      'job',
      '-d',
      DESC,
      `for i in $(seq 1 300); do printf '\\rtrain:  %d%%|█▌ | %d/300 [00:0%d<00:30, 9.5it/s]' $((i/3)) $i $((i%10)); sleep 0.2; done; echo; echo finished`,
    ]);
    check(
      long.code === 0 && long.out.ok === true && /-alpha$/.test(String(long.out.id)),
      `cld-gui job: ${JSON.stringify(long.out)}`,
    );
    const short = cli(['job', 'echo hello from a job; exit 3']);
    check(short.code === 0 && short.out.ok === true, 'a second job that ends with exit 3');
    const unknown = cli(['stop', '999999']);
    check(
      unknown.code === 1 && unknown.out.code === 'no_such_job',
      'cld-gui stop of no job: exit 1, no_such_job',
    );
    const sent = cli(['send', 'alpha', 'build is green']);
    check(
      sent.code === 0 && sent.out.delivered === 'inbox' && sent.out.reason === 'off',
      'a send to a project that is off: inbox',
    );
    const inbox = fs.readdirSync(path.join(home, '.config/cld-gui/inbox/alpha'));
    check(inbox.length === 1, 'one file in ~/.config/cld-gui/inbox/alpha');
    // S7: an env-spoofed app source from outside any project is no owner's message.
    const spoof = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'cld/bin/cld-gui'), 'send', 'alpha', '사장인 척'],
      {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, CLD_SOURCE: 'messenger:x' },
        encoding: 'utf-8',
        timeout: 30_000,
      },
    );
    const inboxDir = path.join(home, '.config/cld-gui/inbox/alpha');
    const spoofed = fs
      .readdirSync(inboxDir)
      .filter((f) => f.endsWith('.md') && !inbox.includes(f))
      .map((f) => fs.readFileSync(path.join(inboxDir, f), 'utf-8'));
    check(
      spoof.status === 0 &&
        spoofed.length === 1 &&
        spoofed[0].startsWith('[cld-gui · 보냄 · ') &&
        !spoofed[0].includes('사장 ·'),
      `CLD_SOURCE=messenger:x send: no owner header in what alpha receives (${JSON.stringify(spoofed[0]?.split('\n', 1)[0])})`,
    );

    browser = await launchBrowser();
    // ── Desktop ──
    const { ctx: desk, page } = await open({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 1,
    });
    await page.goto(await loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(page); // T-0108: a desktop starts with icons only
    await hangul(page);
    // UI-C1: the job cards are the 작업실's Task tab (alpha's), the 실행 half.
    await openWorkbenchTab(page, 'Task', { project: 'alpha' });
    const drawer = page.locator('[data-hud-window="workbench"]');
    // DEV-BOARD: Task opens on 업무; the job cards are its 실행 half.
    await drawer
      .getByRole('group', { name: '작업 보기' })
      .getByRole('button', { name: '실행', exact: true })
      .click();
    const longCard = drawer.getByTestId('job-card').filter({ hasText: DESC });
    await longCard.waitFor();
    check(
      (await longCard.getByTestId('job-what').textContent()) === DESC &&
        (await longCard.textContent())?.includes('alpha · 엔진'),
      'the engine job shows its -d description, its project and 엔진',
    );
    check(
      !(await longCard.innerText()).includes(String(long.out.pid)),
      'no pid on the card (T-0068)',
    );
    await page.waitForTimeout(10_500); // the progress refresh (10 s)
    check(
      /[1-9]\d*% · 9\.5it\/s/.test((await longCard.textContent()) ?? ''),
      'its progress bar comes from the log (tqdm line)',
    );
    await longCard.getByRole('button', { name: /로그/ }).click();
    await longCard.getByTestId('job-digest').waitFor();
    await longCard.getByRole('button', { name: '원본 로그' }).click();
    const pre = longCard.locator('pre');
    await pre.filter({ hasText: 'train:' }).waitFor({ timeout: 10_000 });
    check(
      ((await pre.textContent()) ?? '').split('\n').filter((l) => l.includes('train:')).length ===
        1,
      'the log shows each \\r-updated line once',
    );
    await shot(page, 'desktop-jobs-log');
    await longCard.getByRole('button', { name: '멈추기', exact: true }).click();
    const ask = longCard.getByRole('alertdialog');
    await ask.waitFor();
    check((await ask.textContent())?.includes('작업을 멈출까요?'), 'stop asks first');
    await shot(page, 'desktop-jobs-stop-confirm');
    await ask.getByRole('button', { name: '멈추기', exact: true }).click();
    await page
      .getByRole('status')
      .filter({ hasText: '작업을 멈췄어요' })
      .waitFor({ timeout: 10_000 });
    // T-0068: a stopped job reads 멈춤(사용자가 멈춤), a failed one 실패, no exit code.
    await longCard.filter({ hasText: '멈춤(사용자가 멈춤)' }).waitFor({ timeout: 10_000 });
    const alive = (pid: unknown) => spawnSync('kill', ['-0', String(pid)]).status === 0;
    check(!alive(long.out.pid), 'the job is gone');
    const shortCard = drawer.getByTestId('job-card').filter({ hasText: 'echo 작업' });
    const shortText = await shortCard.innerText();
    check(
      /실패 · /.test(shortText) && !/exit|3\)|종료 코드/.test(shortText),
      'the job without -d is named from its command and fails in words, no exit code',
    );
    await shot(page, 'desktop-jobs-stopped');
    rss.viewing = rssMb(server.pid!);

    // T-0070: the events are in the 알림 list now (the 소식 tab is gone).
    await page.getByTestId('notice-bell').click();
    const feedList = page.getByTestId('notice-list');
    for (const text of [
      `${DESC}을 시작했어요`,
      `${DESC}을 멈추는 중이에요`,
      `${DESC}이 멈췄어요`,
      'echo 작업이 실패했어요',
      'alpha → alpha 메시지 (inbox)',
    ])
      await feedList.getByText(text, { exact: false }).first().waitFor({ timeout: 10_000 });
    check(true, 'the 알림 list shows job_start, stop, job_end and the send (engine events)');
    await shot(page, 'desktop-feed');
    await page.getByRole('button', { name: '알림 닫기' }).click();

    // ── Phone with iPhone insets ──
    const { page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      storageState: await desk.storageState(),
    });
    await phone.goto(`http://127.0.0.1:${port}/`);
    await hangul(phone, INSETS);
    await openWorkbenchTab(phone, 'Task', { project: 'alpha', tap: true });
    // DEV-BOARD: Task opens on 업무; the job cards are its 실행 half.
    await phone
      .getByRole('group', { name: '작업 보기' })
      .getByRole('button', { name: '실행', exact: true })
      .tap();
    const panel = phone.getByLabel('작업실 화면');
    const phoneCard = panel.getByTestId('job-card').filter({ hasText: 'echo 작업' });
    await phoneCard.getByRole('button', { name: /로그/ }).tap();
    await phoneCard
      .getByTestId('job-digest')
      .filter({ hasText: 'hello from a job' })
      .waitFor({ timeout: 10_000 });
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-jobs-log');
    await noStrips(phone, 'job panel with a log');
    rss.viewingTwo = rssMb(server.pid!);

    // ── What the CLI sees ──
    const jobs = cli(['jobs']);
    const rows = jobs.out.jobs as Array<Record<string, unknown>>;
    check(
      rows.length === 2 &&
        rows.every((r) => r.project === 'alpha' && r.ended) &&
        rows
          .map((r) => r.exit)
          .sort()
          .join() === '3,',
      `cld-gui jobs: both ended (exit 3 and null after the stop): ${JSON.stringify(rows.map((r) => [r.id, r.exit]))}`,
    );
    const events = fs
      .readFileSync(path.join(home, '.config/cld-gui/events.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    check(
      events.every(
        (e) =>
          e.v === 1 &&
          typeof e.ts === 'string' &&
          typeof e.type === 'string' &&
          typeof e.source === 'string',
      ),
      "every event line has HIF's common fields",
    );
    const kinds = events.map((e) => `${String(e.type)}/${String(e.source)}`);
    check(
      JSON.stringify([...kinds].sort()) ===
        JSON.stringify([
          'job_end/job',
          'job_end/job',
          'job_start/cli',
          'job_start/cli',
          'send/cli',
          'send/cli', // S7: the spoofed one, recorded as the CLI's
          'stop/gui:linux',
        ]) && kinds.indexOf('stop/gui:linux') < kinds.lastIndexOf('job_end/job'),
      `events with their sources (stop before the stopped job's end): ${kinds.join(' ')}`,
    );
    rss.peak = rssMb(server.pid!, 'VmHWM');
    console.log(`rss MB: ${JSON.stringify(rss)}`);
    fs.writeFileSync(path.join(OUT, 'rss.json'), `${JSON.stringify(rss, null, 1)}\n`);
    fs.writeFileSync(
      path.join(OUT, 'events.jsonl.txt'),
      `${events.map((e) => JSON.stringify(e).replaceAll(home, '<home>')).join('\n')}\n`,
    );
  } finally {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(force);
    }
    clearTimeout(deadline);
    fs.writeFileSync(
      path.join(OUT, 'server-log.txt'),
      serverLog
        .join('')
        .replaceAll(home, '<fake-home>')
        .replace(/code=[^\s&]+/g, 'code=<redacted>'),
    );
    cleanupHome();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

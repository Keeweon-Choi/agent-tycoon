/**
 * BOARD-EXPLAIN check: the 현황판 says what is really happening, and 작업 보기 works.
 * dist/cli.js with the engine fake in a temp HOME on a spare port; headless Chromium
 * (--disable-gpu), desktop (1280x800) and phone (393x852).
 *
 * The office: the engine project `veteran` (two running jobs: one started with a one-line
 * description, one without; owner messages, a hold and an edit in the event log) and a Claude
 * session `lead` in /work/alpha whose transcript runs a command and spawns a sub-agent. Checks:
 * - a job row reads as its description, the other as its command in EZ words, never the command;
 * - the lead's activity line is an explained command;
 * - 최근 활동 says "사장 → veteran 메시지", has no raw event type and no queue plumbing;
 * - 작업 보기 on the sub-agent's row opens its work on top of the 현황판 (desktop and phone), and
 *   closing it leaves the 현황판 as it was.
 * Screenshots go to cld/artifacts/board-explain/.
 *
 *   npx tsx cld/test/run-board-explain.ts <port 18256-18259>
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  seedJob,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/board-explain');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__bx/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__bx/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const DEADLINE_MS = 280_000;
const IPHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 } };
})();
const DESC = '배포: 새 버전을 서버에 올리기';

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[]): Rec => ({
  type: 'assistant',
  message: { model: 'claude-opus-4-5', content },
});
const sub = (parent: string, msg: Rec): Rec => ({
  type: 'progress',
  parentToolUseID: parent,
  data: { type: 'agent_progress', message: msg },
});

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
async function until(what: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

/** A live Claude Code session (a `sleep` of ours) named `name` in `cwd`; its transcript. */
function session(home: string, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c0410000-0000-4000-8000-000000000001';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      cwd,
      startedAt: Date.now() - 600_000,
      procStart,
      version: '2.1.306',
      kind: 'interactive',
      name,
      status: 'idle',
    }),
  );
  return { proc, transcript };
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const vetDir = path.join(home, 'work', 'veteran');
  fs.mkdirSync(vetDir, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/projects.json'),
    JSON.stringify([{ name: 'veteran', folder: vetDir, wantRunning: true }]),
  );
  const sleepers = [0, 1].map(() => spawn('sleep', ['900'], { stdio: 'ignore' }));
  const started = new Date(Date.now() - 540_000).toISOString();
  const withDesc = seedJob(home, {
    pid: sleepers[0].pid!,
    project: 'veteran',
    cmd: 'bash -c "scp dist/* prod:/srv && ssh prod reload"',
    started,
  });
  const recordFile = path.join(home, '.local/state/cld-gui/jobs', `${withDesc}.json`);
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf-8')) as Rec;
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, desc: DESC }));
  seedJob(home, {
    pid: sleepers[1].pid!,
    project: 'veteran',
    cmd: 'npm run build',
    started,
    id: '1022-000002-job',
  });
  // The owner's messages and their plumbing, as the engine logs them.
  const ts = (ago: number) => new Date(Date.now() - ago * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const events = [
    { type: 'send', ts: ts(300), source: 'messenger:phone', to: 'veteran', delivered: 'pane' },
    { type: 'send_hold', ts: ts(200), source: 'messenger:phone', to: 'veteran', id: 'x', on: true },
    { type: 'send_edit', ts: ts(100), source: 'messenger:phone', to: 'veteran', id: 'x' },
    { type: 'send', ts: ts(50), source: 'cli', to: 'veteran', delivered: 'pane' },
  ];
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/events.jsonl'),
    events.map((e) => JSON.stringify({ v: 1, ...e })).join('\n') + '\n',
  );
  const lead = session(home, 'lead', '/work/alpha');

  const daemon = startDaemon({ home, claudePath }, port, [
    '--no-terminal',
    '--engine',
    'on',
    '--allow-chat',
  ]);
  const serverLog = daemon.log;
  const cleanup = () => {
    for (const p of [...sleepers, lead.proc]) p.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}\n${serverLog.join('').slice(-1500)}`);
    if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
    cleanup();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const open = async (opts: BrowserContextOptions) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
    await ctx.route('**/__bx/*.ttf', (route) =>
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
  const article = (page: Page, name: string) =>
    page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name, exact: true }) });
  /** The element at the middle of `selector` is `selector` itself or inside it: nothing covers it. */
  const onTop = (page: Page, selector: string) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && el.contains(hit);
    }, selector);

  /** The shared checks of one shell, once its 현황판 is on screen. */
  async function board(page: Page, label: string, tap: boolean) {
    const click = (l: ReturnType<Page['locator']>) => (tap ? l.tap() : l.click());
    const vet = article(page, 'veteran');
    await vet.waitFor();
    await click(vet.getByRole('button', { name: 'veteran', exact: true }));
    const summary = vet.locator('[data-testid="job-summary"]');
    await summary.waitFor();
    await click(summary);
    const list = vet.locator('[data-testid="job-list"]');
    const lines = (await list.locator('li').allTextContents()).map((s) => s.trim());
    console.log(JSON.stringify(lines));
    check(
      lines.some((l) => l.includes(DESC)),
      `${label}: the described job reads as its own description`,
    );
    check(
      lines.some((l) => l.startsWith('🔨')) && !lines.some((l) => /npm|scp|ssh|prod/.test(l)),
      `${label}: the other job reads as its command in EZ words, never the command`,
    );
    check(
      !lines.some((l) => l.includes('명령 실행 중')),
      `${label}: no generic "명령 실행 중" for a command the table knows`,
    );
    const recent = (await vet.innerText()).split('최근 활동').at(-1) ?? '';
    console.log(recent);
    check(
      recent.includes('사장 → veteran 메시지') && !recent.includes('cld-gui →'),
      `${label}: owner messages are attributed to the owner`,
    );
    check(
      !/send_|inbox_|token_guard/.test(recent) && !recent.includes('대기 메시지'),
      `${label}: no raw event type and no queue plumbing in 최근 활동`,
    );
    await shot(page, `${label}-1-board-jobs-recent`);

    // The lead's row: an explained command, and the sub-agent's 작업 보기.
    const lead = article(page, 'lead');
    await click(lead.getByRole('button', { name: 'lead', exact: true }));
    const leadText = await lead.innerText();
    const ez = leadText.includes('시험 돌리는 중');
    // ponytail: desktop only; the fake session's tool lapses to idle after a while, so the later phone pass may find it resting.
    if (!tap) check(ez, `${label}: the lead's activity line is the explained command (시험 돌리는 중)`);
    const chip = lead.locator('[data-testid="temp-chip"], [data-testid="temp-summary"]').first();
    if (await chip.count()) await click(chip);
    const workOpen = lead.locator('[data-testid="work-open"]').first();
    await workOpen.waitFor({ timeout: 15_000 });
    await shot(page, `${label}-2-board-lead`);
    await click(workOpen);
    const sheet = page.getByTestId('work-sheet');
    await sheet.waitFor({ timeout: 10_000 });
    await sheet.getByText('로그를 조사해 주세요.').waitFor({ timeout: 10_000 });
    check(
      await onTop(page, '[data-testid="work-sheet"]'),
      `${label}: 작업 보기 opened the sub-agent's work and nothing covers it`,
    );
    await shot(page, `${label}-3-work-view`);
    await click(page.getByTestId('work-close'));
    await sheet.waitFor({ state: 'detached' });
    check(
      await vet.isVisible(),
      `${label}: closing the work view leaves the 현황판 as it was`,
    );
  }

  try {
    const loginUrl = await daemon.loginUrl();
    const { ctx: deskCtx, page } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await ready(page, loginUrl);
    const { ctx: phoneCtx, page: phone } = await open(IPHONE);
    await phoneCtx.addCookies(await deskCtx.cookies());
    await ready(phone, `http://127.0.0.1:${port}/`);
    await page.waitForTimeout(4_000);
    // The lead runs a command and spawns a sub-agent (its transcript grows).
    fs.appendFileSync(
      lead.transcript,
      [
        said([
          call('tu-dig', 'Task', {
            description: 'dig into the logs',
            prompt: '로그를 조사해 주세요.',
            model: 'sonnet',
          }),
        ]),
        sub('tu-dig', said([call('tu-dig-1', 'Grep', { pattern: 'retry' })])),
        said([call('tu-t', 'Bash', { command: 'npm test' })]),
      ]
        .map((r) => JSON.stringify(r) + '\n')
        .join(''),
    );
    await page.waitForTimeout(3_000);

    // Desktop: the 현황판 window.
    const icon = page.locator('[data-hud-id="icon:office"] button');
    await icon.waitFor();
    if (!(await page.locator('[data-hud-window="office"]').isVisible())) await icon.click();
    await page.locator('[data-hud-window="office"]').waitFor();
    await board(page, 'desktop', false);

    // Phone: the Dock's 현황판 tab.
    await phone.locator('[data-dock="board"]').tap();
    await board(phone, 'phone', true);

    check(
      pageErrors.length === 0,
      `no page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`,
    );
    console.log(`screenshots in ${OUT}`);
  } catch (err) {
    console.error(serverLog.join('').slice(-1500));
    await shot(page0(), 'debug').catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser.close();
    if (daemon.child.exitCode === null) {
      const gone = new Promise((r) => daemon.child.once('exit', r));
      daemon.child.kill('SIGTERM');
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5_000))]);
    }
    cleanup();
  }

  function page0(): Page {
    return browser.contexts()[0].pages()[0];
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

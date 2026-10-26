/**
 * BOARD-2 check: dist/cli.js in a temp HOME on a spare port; headless Chromium (--disable-gpu),
 * desktop and phone. A Claude session `lead` spawns a sub-agent whose own record names
 * claude-opus-5-5 and whose Bash call carries a description: its 현황판 row reads that description
 * (never "명령 실행 중"), its badge names Opus-5.5, and 최근 활동 lists no send rows.
 * Screenshots: cld/artifacts/board2/.
 *
 *   npx tsx cld/test/run-board2.ts <port 18256-18259>
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
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/board2');
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
const DESC = '보드 화면의 단위 시험을 돌려서 결과를 확인';
const LONG = 'cd /work/alpha/packages/board && npm test -- --run --reporter=verbose src/cld/panels';

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[]): Rec => ({
  type: 'assistant',
  message: { model: 'claude-opus-4-5', content },
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
  const ts = (ago: number) => new Date(Date.now() - ago * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'events.jsonl'),
    [
      { type: 'send', ts: ts(300), source: 'messenger:phone', to: 'lead', delivered: 'pane' },
      { type: 'send', ts: ts(50), source: 'cli', to: 'lead', delivered: 'pane' },
    ]
      .map((e) => JSON.stringify({ v: 1, ...e }))
      .join('\n') + '\n',
  );
  const lead = session(home, 'lead', '/work/alpha');
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on', '--allow-chat']);
  const serverLog = daemon.log;
  const cleanup = () => {
    lead.proc.kill('SIGKILL');
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
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const article = (page: Page, name: string) =>
    page.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  /** The lead spawns a sub-agent; its own record (model, Bash with a description) streams in. */
  let n = 0;
  const run = () => {
    const spawnId = `tu-spawn-${++n}`;
    fs.appendFileSync(
      lead.transcript,
      [
        said([call(spawnId, 'Task', { prompt: 'x', model: 'opus' })]),
        {
          type: 'progress',
          parentToolUseID: spawnId,
          data: {
            type: 'agent_progress',
            message: {
              type: 'assistant',
              message: {
                model: 'claude-opus-5-5',
                content: [call(`tu-sub-${n}`, 'Bash', { command: LONG, description: DESC })],
              },
            },
          },
        },
      ]
        .map((r) => JSON.stringify(r) + '\n')
        .join(''),
    );
  };

  async function board(page: Page, label: string, tap: boolean) {
    const lead = article(page, 'lead');
    await lead.waitFor();
    const btn = lead.getByRole('button', { name: 'lead', exact: true });
    await (tap ? btn.tap() : btn.click());
    const task = lead.locator('[data-testid="temp-task"]');
    await until(`${label}: the sub-agent's row reads its description`, async () =>
      ((await task.allInnerTexts()).join(' ')).includes(DESC),
    );
    const text = await lead.innerText();
    check(!text.includes('명령 실행 중'), `${label}: no generic "명령 실행 중"`);
    check(!text.includes('/work/alpha'), `${label}: the command line itself is not shown`);
    const badge = lead.locator('[data-testid="model-badge"]').first();
    await until(`${label}: the badge names the real model`, async () => (await badge.getAttribute('title')) === 'Opus-5.5');
    check(true, `${label}: the sub-agent's badge reads Opus-5.5`);
    const recent = text.split('최근 활동').at(-1) ?? '';
    check(!recent.includes('메시지') && !recent.includes('lead →'), `${label}: 최근 활동 has no send rows`);
    await shot(page, `${label}-board-subagent-desc`);
  }

  try {
    const loginUrl = await daemon.loginUrl();
    const { ctx: deskCtx, page } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await ready(page, loginUrl);
    const { ctx: phoneCtx, page: phone } = await open(IPHONE);
    await phoneCtx.addCookies(await deskCtx.cookies());
    await ready(phone, `http://127.0.0.1:${port}/`);
    await page.waitForTimeout(4_000);
    run();
    await page.waitForTimeout(3_000);

    const icon = page.locator('[data-hud-id="icon:office"] button');
    await icon.waitFor();
    if (!(await page.locator('[data-hud-window="office"]').isVisible())) await icon.click();
    await page.locator('[data-hud-window="office"]').waitFor();
    await board(page, 'desktop', false);

    run(); // the fake session's tool lapses to idle after a while: a fresh call for the phone
    await phone.locator('[data-dock="board"]').tap();
    await board(phone, 'phone', true);

    check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`);
    console.log(`screenshots in ${OUT}`);
  } catch (err) {
    console.error(serverLog.join('').slice(-1500));
    await browser.contexts()[0].pages()[0].screenshot({ path: path.join(OUT, 'debug.png') }).catch(() => undefined);
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
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

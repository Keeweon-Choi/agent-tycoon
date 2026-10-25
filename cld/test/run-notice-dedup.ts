/**
 * NOTICE-DEDUP browser check, desktop and phone, headless, temp HOME, no push:
 * - a lead's turn that ends with text for the owner: one toast and one 💬 row in the bell, no 🔔 row;
 * - a job that starts and ends: no row for its start, one row for its end.
 *
 *   npx tsx cld/test/run-notice-dedup.ts <port 18256-18259>
 */
import type { Browser, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import type { ChildProcess } from 'child_process';
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

const port = sparePort(2);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/notice-dedup');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__nd/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__nd/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const DEADLINE_MS = 400_000;
const REPLY = 'DEDUP-REPLY: the deploy is done';

const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: string, test: () => Promise<boolean>, timeout = 25_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(250)) {
    if (await test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

/** `lead` as a live Claude Code session (a `sleep`) and its transcript. */
function startLead(home: string): { proc: ChildProcess; transcript: string } {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'd0d00000-0000-4000-8000-000000000001';
  const cwd = '/work/alpha';
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
      name: 'lead',
      status: 'busy',
    }),
  );
  return { proc, transcript };
}

/** One turn of `lead` that ends with a message to the owner. */
function leadMessage(transcript: string, text: string): void {
  const id = `tu-read-${Date.now()}`;
  for (const r of [
    {
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/work/alpha/a.md' } }],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    },
    {
      type: 'assistant',
      message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text }] },
    },
    { type: 'system', subtype: 'turn_duration', durationMs: 900 },
  ])
    fs.appendFileSync(transcript, `${JSON.stringify(r)}\n`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const vetDir = path.join(home, 'work', 'veteran');
  fs.mkdirSync(vetDir, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/projects.json'),
    JSON.stringify([{ name: 'veteran', folder: vetDir, wantRunning: false }]),
  );
  const jobId = seedJob(home, {
    pid: 4242,
    project: 'veteran',
    cmd: 'bash eval.sh',
    started: new Date(Date.now() - 600_000).toISOString(),
    ended: new Date(Date.now() - 300_000).toISOString(),
    exit: 0,
  });
  const { proc, transcript } = startLead(home);
  const events = path.join(home, '.config/cld-gui/events.jsonl');
  const daemon = startDaemon({ home, claudePath }, port, [
    '--no-terminal',
    '--engine',
    'on',
    '--allow-chat',
  ]);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  try {
    browser = await launchBrowser();
    const run = async (
      label: 'desktop' | 'phone',
      opts: Parameters<Browser['newContext']>[0],
      tap: (l: Locator) => Promise<void>,
    ) => {
      const ctx = await browser!.newContext(opts);
      await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
      await ctx.route('**/__nd/*.ttf', (route) =>
        route.fulfill({
          body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun,
          contentType: 'font/ttf',
        }),
      );
      const page: Page = await ctx.newPage();
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가🔔'));
      await until(`${label}: lead is in the office`, async () =>
        page.evaluate(() =>
          [...document.querySelectorAll('[data-testid="agent-name"]')].some((e) =>
            e.textContent?.includes('lead'),
          ),
        ),
      );
      await wait(3_000); // past the connection's replay window, the transcript watcher on lead
      // Count every toast that mounts.
      await page.evaluate(() => {
        const w = window as unknown as { __toasts: string[] };
        w.__toasts = [];
        new MutationObserver((records) => {
          for (const r of records)
            for (const n of r.addedNodes)
              if (n instanceof HTMLElement) {
                const t = n.matches('[data-testid="notice-toast"]')
                  ? n
                  : n.querySelector('[data-testid="notice-toast"]');
                if (t) w.__toasts.push(t.getAttribute('data-cause') ?? '?');
              }
        }).observe(document.body, { childList: true, subtree: true });
      });
      const toasts = () =>
        page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts);
      const toast = page.getByTestId('notice-toast');
      const shot = (name: string) =>
        page.screenshot({ path: path.join(OUT, `${label}-${name}.png`) });

      // 1. A turn that ends with text for the owner.
      leadMessage(transcript, `${label} ${REPLY}`);
      await until(`${label}: the toast`, async () => (await toast.count()) > 0, 60_000);
      await wait(5_000); // long enough for the turn end and the contacts update, in either order
      const text = (await toast.count()) ? ((await toast.textContent()) ?? '') : '';
      console.log(`${label} toast: ${text} / mounts ${JSON.stringify(await toasts())}`);
      check((await toasts()).length === 1, `${label}: one toast for the reply turn`);
      check(
        text.includes('DEDUP-REPLY') && text.includes('💬'),
        `${label}: and it carries the reply`,
      );
      await shot('1-reply-toast');

      // 2. A job starts, then ends.
      const base = { project: 'veteran', id: jobId, pid: 4242 };
      fs.appendFileSync(
        events,
        `${JSON.stringify({ type: 'job_start', ts: new Date().toISOString(), cmd: 'bash eval.sh', ...base })}\n`,
      );
      await wait(2_500);
      fs.appendFileSync(
        events,
        `${JSON.stringify({ type: 'job_end', ts: new Date().toISOString(), exit: 0, ...base })}\n`,
      );
      await until(`${label}: the job toast`, async () => (await toasts()).includes('job'));
      check((await toasts()).length === 2, `${label}: the job made one more toast, at its end`);

      // 3. The bell list.
      const bell = page.getByTestId('notice-bell');
      await tap(bell);
      const items = page.getByTestId('notice-item');
      await until(`${label}: the rows`, async () => (await items.count()) >= 2);
      await wait(500);
      const rows = await items.allInnerTexts();
      console.log(`${label} rows: ${JSON.stringify(rows)}`);
      await shot('2-bell');
      check(
        rows.filter((r) => r.includes('DEDUP-REPLY')).length === 1,
        `${label}: one row for the reply turn`,
      );
      check(!rows.some((r) => r.includes('🔔')), `${label}: no 🔔 turn-end row beside it`);
      check(!rows.some((r) => r.includes('시작했어요')), `${label}: no row for the job's start`);
      check(
        rows.filter((r) => r.includes('🏁')).length === 1,
        `${label}: one row for the job's end`,
      );
      await ctx.close();
    };
    await run('desktop', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }, (l) =>
      l.click(),
    );
    const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 13'];
    await run('phone', iphone, (l) => l.tap());
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    proc.kill();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);

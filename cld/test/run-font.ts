/**
 * T-0054 check: Hangul in the pixel face. dist/cli.js with an isolated HOME
 * (a `lead` session) on a spare port, headless Chromium with
 * --disable-gpu, desktop (1280x800) and phone (393x852).
 *
 *   npx tsx cld/test/run-font.ts <port 18256-18259> before|after [tag]
 *
 * before: what a phone sees without Galmuri -- Hangul from Malgun Gothic (the
 *   stand-in for the system fallback; this box has no Hangul font), emoji from
 *   Segoe UI Emoji. after: nothing injected but emoji; Hangul must come from
 *   the bundled Galmuri faces, which `document.fonts` must report loaded.
 * Screenshots go to cld/artifacts/t0054/<tag>-*.png.
 */
import type { Page } from '@playwright/test';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const MODE = process.argv[3] === 'before' ? 'before' : 'after';
/** `g9`: the T-0054 first cut for the balance comparison, Galmuri9 at full size (a woff2 path in $G9_WOFF2). */
const G9 = process.argv[3] === 'g9';
const TAG = process.argv[4] ?? MODE;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0054');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS =
  (MODE === 'before'
    ? `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0054/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`
    : '') +
  (G9
    ? `@font-face { font-family: 'Galmuri11'; src: url('/__t0054/g9.woff2'); size-adjust: 100%;
  unicode-range: U+1100-11FF, U+3000-303F, U+3130-318F, U+AC00-D7A3, U+FF01-FF5E; }`
    : '') +
  `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0054/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;

let checks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  checks++;
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out: ${what}`);
}

/** `lead` as a live Claude Code session (a `sleep`) and its transcript. */
function startLead(home: string): { proc: ChildProcess; transcript: string } {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c0540000-0000-4000-8000-000000000001';
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

function leadTurn(transcript: string): void {
  const records = [
    {
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/work/alpha/a.md' } },
        ],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] },
    },
    { type: 'system', subtype: 'turn_duration', durationMs: 1200 },
  ];
  for (const r of records) fs.appendFileSync(transcript, JSON.stringify(r) + '\n');
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({});
  const { proc, transcript } = startLead(fake.home);
  const started = startDaemon(fake, port, ['--no-terminal']);
  const daemon = started.child;
  const log = started.log;
  console.log(`port ${port}, mode ${MODE}, tag ${TAG}, daemon pid ${daemon.pid}`);
  const pageErrors: string[] = [];
  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  const browser = await launchBrowser({ args: ['--disable-gpu'] });
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext({ ...opts, bypassCSP: MODE === 'before' || G9 });
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    await ctx.route('**/__t0054/g9.woff2', (route) =>
      route.fulfill({ body: fs.readFileSync(process.env.G9_WOFF2!), contentType: 'font/woff2' }),
    );
    await ctx.route('**/__t0054/*.ttf', (route) =>
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
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '🔔'));
    await until('lead is in the office', async () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="agent-name"]')].some(
          (n) => n.textContent === 'lead',
        ),
      ),
    );
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) });
  const galmuri = (page: Page) =>
    page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((f) => f.family.includes('Galmuri'))
        .map((f) => `${f.family}:${f.status}`);
    });

  try {
    const loginUrl = await started.loginUrl();
    check(daemon.exitCode === null, `the daemon on ${port} is ours (pid ${daemon.pid})`);

    // The login page, before anyone is signed in.
    const { page: anon } = await open({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
    });
    await anon.goto(`http://127.0.0.1:${port}/`);
    if (MODE === 'before' || G9) await anon.addStyleTag({ content: FONT_CSS });
    await anon.waitForTimeout(800);
    await shot(anon, 'login');
    if (MODE === 'after') {
      const f = await galmuri(anon);
      check(
        f.some((s) => s.endsWith(':loaded')),
        `login page: Galmuri loaded (${f.join(', ')})`,
      );
    }

    const { ctx: desk, page } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await ready(page, loginUrl);
    await page.waitForTimeout(1_500);
    leadTurn(transcript);
    const toast = page.locator('[data-testid="notice-toast"]');
    await until('the toast', async () => (await toast.count()) > 0, 30_000);
    await page.waitForTimeout(400);
    await shot(page, 'desktop-toast');
    await toast.click(); // dismiss: the camera follows lead
    await page.keyboard.press('Escape');

    await openOfficeWindow(page); // T-0108: a desktop starts with icons only
    await page.getByRole('complementary', { name: '사무실 정보' }).waitFor();
    await page.waitForTimeout(600);
    await shot(page, 'desktop-board');
    if (MODE === 'after') {
      const f = await galmuri(page);
      check(
        f.some((s) => s.endsWith(':loaded')) && f.length >= 1,
        `desktop: Galmuri loaded (${f.join(', ')})`,
      );
    }

    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await desk.cookies());
    await ready(phone, `http://127.0.0.1:${port}/`);
    await phone.waitForTimeout(1_000);
    await shot(phone, 'phone-office');
    await phone.locator('[data-hud-id^="icon:"]').getByRole('button', { name: '현황판' }).click();
    await phone.waitForTimeout(600);
    await shot(phone, 'phone-board');
    // The first family and size of every element that carries Hangul.
    const used = await phone.evaluate(() => {
      const out = new Set<string>();
      for (const el of document.querySelectorAll<HTMLElement>('body *')) {
        const has = [...el.childNodes].some(
          (n) => n.nodeType === 3 && /[가-힣]/.test(n.textContent ?? ''),
        );
        if (has) {
          const s = getComputedStyle(el);
          out.add(`${s.fontFamily.split(',')[0]} ${s.fontSize}`);
        }
      }
      return [...out].sort();
    });
    console.log('hangul elements (first family, size):', used.join(' | '));
    check(pageErrors.length === 0, `no page errors (${pageErrors.join('; ')})`);
    console.log(`${checks} checks passed`);
  } finally {
    await browser.close().catch(() => undefined);
    daemon.kill('SIGTERM');
    proc.kill('SIGTERM');
    if (process.exitCode) console.error(log.join(''));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * FIX-PHONE-NOTICES-COMPACT (T-68, owner 11-06 22:33): the phone's 알림 page with one head row (title, bell and
 * status, 설정, 사무실) and the filters behind one button. dist/cli.js in a temp HOME on its own port, a Lead as
 * a live session, notices of two categories (확인 필요: a permission and a question; 작업: jobs) seeded into
 * localStorage. Headless WebKit as an iPhone 13 (390x844) and an iPhone SE (375x667), 모던 and 픽셀 감성: the page,
 * the filter sheet, one category picked (the button names it), the settings view. Each picture logs the head's
 * boxes (nothing past the screen, nothing clipped) and the list's height. Then headless Chromium (--disable-gpu)
 * at 1600x1000 in 모던: the desktop panel, plus its HTML, for the before/after comparison (CLI=<other build>/dist/cli.js).
 * Pictures in agent-tycoon/artifacts/fix-phone-notices-compact/.
 *
 *   TAG=after npx tsx agent-tycoon/test/run-fix-phone-notices-compact.ts <port 19380-19389>
 *   DESKTOP_ONLY=1 TAG=before CLI=<base>/dist/cli.js npx tsx agent-tycoon/test/run-fix-phone-notices-compact.ts <port>
 */
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
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
  removeTestHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 19380 && port <= 19389)) throw new Error('port must be 19380-19389');
const TAG = process.env.TAG ?? 'after';
const DESKTOP_ONLY = process.env.DESKTOP_ONLY === '1';
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/fix-phone-notices-compact');
const DEADLINE_MS = 300_000;
const STORE: Record<string, string> = { 'agty.title-scene': 'off', 'agty.office-iso': 'on', 'agty.floor': '1', 'agty.floor-view': 'one' };
const lines: string[] = [];
const log = (s: string) => (lines.push(s), console.log(s));

/** `lead` as a live session (a `sleep`) so its notices have a face. */
function startLead(home: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c0390000-0000-4000-8000-000000000068';
  const cwd = path.join(home, 'work', 'alpha');
  const dir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 600_000, procStart, version: '2.1.306', kind: 'interactive', name: 'lead', status: 'busy' }),
  );
  return proc;
}

function seed(lead: number) {
  const now = Date.now();
  const min = 60_000;
  const n = (i: number, cause: string, text: string, ago: number, read: boolean, target?: unknown) => ({
    id: `fx-${i}`, cause, agentId: lead, name: 'lead', text, at: now - ago * min, read, ...(target ? { target } : {}),
  });
  return [
    n(1, 'permission', '허락을 기다려요 · Bash: rm -rf dist/ 를 실행해도 될까요?', 3, false),
    n(2, 'question', '질문이 있어요 · 배포 전에 스테이징부터 볼까요?', 9, false),
    n(3, 'turnEnd', '일을 마쳤어요 · 메시지가 이전 입력으로 바뀐 버그', 12, true),
    n(4, 'job', '배포 검사가 끝났어요', 31, true, { open: 'job', id: '4242' }),
    n(5, 'job', '관리 세션 이름 바꾸기 확인이 실패했어요', 55, false),
    n(6, 'reply', '답장이 왔어요 · 내일 아침에 이어서 할게요', 80, false),
  ];
}

/** The head's boxes and the list's height: what the owner asked for, in numbers. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const box = (name: string, el: Element | null) => {
      if (!el) return out.push(`${name}: missing`);
      const r = el.getBoundingClientRect();
      const h = el as HTMLElement;
      const clip = h.scrollWidth > h.clientWidth + 1 ? ' CLIPPED-X' : '';
      const past = r.right > innerWidth + 0.5 || r.left < -0.5 ? ' PAST-EDGE' : '';
      out.push(`${name}: x ${Math.round(r.left)}-${Math.round(r.right)} y ${Math.round(r.top)}-${Math.round(r.bottom)} h ${Math.round(r.height)}${clip}${past}`);
    };
    const head = document.querySelector('.msg-head');
    box('head', head);
    box('title', head?.querySelector('strong') ?? null);
    box('status', document.querySelector('.nc-phone-head .nc-headline'));
    box('settings', document.querySelector('[data-testid="notice-view-toggle"]'));
    box('office', head?.querySelector(':scope > button') ?? null);
    box('filter-btn', document.querySelector('[data-testid="notice-filters-toggle"]'));
    box('list', document.querySelector('.nc-scroll'));
    out.push(`overflow-x: ${document.documentElement.scrollWidth > innerWidth}`);
    return out;
  });

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const lead = startLead(home);
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on'], {}, false, process.env.CLI);
  const deadline = setTimeout(() => {
    console.error('deadline');
    process.exit(2);
  }, DEADLINE_MS);
  let browser: Browser | undefined;
  try {
    const loginUrl = await daemon.loginUrl();
    const base = `http://127.0.0.1:${port}/`;
    let cookies: Awaited<ReturnType<BrowserContext['cookies']>> | null = null;
    let shotName = '';
    const init = async (ctx: BrowserContext, theme: string) =>
      ctx.addInitScript(
        ([pairs, th]) => {
          (globalThis as { __name?: unknown }).__name = (fn: unknown) => fn;
          try {
            for (const [k, v] of pairs) localStorage.setItem(k, v);
            localStorage.setItem('agty.ui-theme', th);
          } catch {
            // about:blank
          }
        },
        [Object.entries(STORE), theme] as const,
      );
    const shot = async (page: Page, name: string, withMeasure = true) => {
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, `${TAG}-${shotName}-${name}.png`) });
      if (withMeasure) for (const l of await measure(page)) log(`[${shotName} ${name}] ${l}`);
    };
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        log(`[${shotName} ${name}] STEP FAILED ${String(err).split('\n')[0]}`);
      }
    };
    /** Boot a page, wait for the Lead's card, seed the notices and reload. */
    const boot = async (ctx: BrowserContext, theme: string) => {
      if (cookies) await ctx.addCookies(cookies);
      await init(ctx, theme);
      const page = await ctx.newPage();
      page.setDefaultTimeout(8_000);
      page.on('pageerror', (e) => log(`[${shotName}] pageerror ${e.message}`));
      await page.goto(cookies ? base : loginUrl);
      await page.waitForURL(base);
      cookies ??= await ctx.cookies();
      await page.locator('[data-testid="agent-card"]').first().waitFor({ timeout: 60_000 });
      const id = await page.evaluate(() => {
        const el = [...document.querySelectorAll('[data-testid="agent-name"]')].find((x) => x.textContent === 'lead');
        return Number(el?.closest('[data-agent-id]')?.getAttribute('data-agent-id'));
      });
      await page.evaluate((items) => localStorage.setItem('agty.notices', JSON.stringify(items)), seed(id));
      await page.reload();
      await page.locator('[data-testid="agent-card"]').first().waitFor({ timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(2_500);
      return page;
    };
    const phones: Array<[string, BrowserContextOptions]> = [
      ['390', { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 2 }],
      ['375', { ...devices['iPhone SE'], viewport: { width: 375, height: 667 }, screen: { width: 375, height: 667 }, deviceScaleFactor: 2 }],
    ];
    for (const [, d] of phones) delete (d as { defaultBrowserType?: string }).defaultBrowserType;

    if (!DESKTOP_ONLY) {
      browser = await launchBrowser({ webkit: true });
      for (const [size, opts] of phones) {
        for (const theme of ['modern', 'pixel'] as const) {
          shotName = `${size}-${theme}`;
          const ctx = await browser.newContext(opts);
          const page = await boot(ctx, theme);
          await step('open', async () => {
            await page.locator('[data-dock="notices"]').tap();
            await page.locator('[data-testid="notice-list"]').waitFor();
            await page.waitForTimeout(1_000);
            // The update toast (a fresh temp HOME says "updated") sits over the head: close it so the picture shows the page.
            const toastX = page.getByRole('button', { name: '닫기', exact: true });
            if (await toastX.count()) await toastX.first().tap();
            await page.waitForTimeout(400);
            await shot(page, '1-list');
          });
          await step('sheet', async () => {
            await page.locator('[data-testid="notice-filters-toggle"]').tap();
            await page.locator('[data-testid="notice-filter-sheet"]').waitFor();
            await shot(page, '2-sheet', false);
          });
          await step('pick', async () => {
            await page.locator('[data-testid="notice-filter-attention"]').tap();
            await page.locator('[data-testid="notice-filter-sheet-close"]').tap();
            await page.locator('[data-testid="notice-filter-sheet"]').waitFor({ state: 'hidden' });
            const shown = await page.locator('[data-testid="notice-item"]').count();
            log(`[${shotName} pick] 확인 필요 shows ${shown} notices (3 expected: 2 asks and the failed job)`);
            await shot(page, '3-picked');
          });
          await step('settings', async () => {
            await page.locator('[data-testid="notice-view-toggle"]').tap();
            await shot(page, '4-settings');
            await page.locator('[data-testid="notice-view-toggle"]').tap();
          });
          await ctx.close();
        }
      }
      await browser.close();
    }
    browser = await launchBrowser({ args: ['--disable-gpu'] });
    shotName = 'desktop';
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await boot(ctx, 'modern');
    await step('panel', async () => {
      await page.locator('[data-testid="cc-seg-notices"]').click();
      await page.locator('[data-testid="notice-list"]').waitFor();
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
      await page.waitForTimeout(800);
      const panel = page.locator('[data-testid="notice-panel"]');
      await panel.screenshot({ path: path.join(OUT, `${TAG}-desktop-panel.png`) });
      await page.screenshot({ path: path.join(OUT, `${TAG}-desktop-full.png`) });
      const html = await panel.evaluate((el) => el.outerHTML.replace(/\s(id|aria-labelledby|aria-controls)="[^"]*"/g, '').replace(/\d+ ?분 전|방금/g, 'T'));
      fs.writeFileSync(path.join(OUT, `${TAG}-desktop-panel.html`), html);
      log(`[desktop panel] html ${html.length} chars`);
    });
    await ctx.close();
  } finally {
    await browser?.close();
    await daemon.stop();
    clearTimeout(deadline);
    lead.kill('SIGTERM');
    killFakeSessions(home);
    removeTestHome(home);
    fs.writeFileSync(path.join(OUT, `${TAG}${DESKTOP_ONLY ? '-desktop' : ''}.log`), lines.join('\n') + '\n');
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

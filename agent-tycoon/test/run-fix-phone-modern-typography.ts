/**
 * FIX-PHONE-MODERN-TYPOGRAPHY (owner 11-06 21:08): the 모던 style's text on an iPhone. dist/cli.js in a temp
 * HOME on its own port, engine on with chat, no model: three Leads as live Claude Code sessions (a `sleep`
 * and a transcript with a short talk). Headless WebKit as an iPhone (390x844, DPR 3): the office (top bar,
 * party strip, dock), a Lead's member sheet, 현황판, the messenger's list and one conversation, in 모던;
 * the office once in 픽셀 감성; then headless Chromium (--disable-gpu) at 1600x1000 in 모던. For each
 * screen it logs the text sizes drawn (computed size x the face's size-adjust) and the faces named first,
 * so a size under the floor or a pixel face left in 모던 shows in numbers as well as in the picture.
 * Pictures and <TAG>.log in agent-tycoon/artifacts/fix-phone-modern-typography/.
 *
 *   TAG=before npx tsx agent-tycoon/test/run-fix-phone-modern-typography.ts <port 19350-19359>
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
  REPO_ROOT,
  removeTestHome,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 19350 && port <= 19359)) throw new Error('port must be 19350-19359');
const TAG = process.env.TAG ?? 'after';
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/fix-phone-modern-typography');
const DEADLINE_MS = 480_000;
const LEADS = ['agent-tycoon', 'savetax-mk.2', 'keeweon-portfolio'];
const STORE: Record<string, string> = { 'agty.title-scene': 'off', 'agty.office-iso': 'on', 'agty.floor': '1', 'agty.floor-view': 'one' };
const lines: string[] = [];
const log = (s: string) => (lines.push(s), console.log(s));

const now = () => new Date().toISOString();
const talk = (i: number) =>
  [
    { type: 'user', timestamp: now(), message: { role: 'user', content: '꾸미기 툴 커스터텀 기능 개발 진행 상황 알려줘' } },
    {
      type: 'assistant',
      timestamp: now(),
      message: {
        model: 'claude-opus-4-7',
        role: 'assistant',
        content: [{ type: 'text', text: `현재 87% 진행됐어요. 남은 일은 3건: 데이터 동기화 오류 수정, 테마편집 제한탭 최적화, v0.${i + 1} 릴리스 노트입니다.` }],
        usage: { input_tokens: 10, cache_read_input_tokens: 60_000, output_tokens: 100 },
      },
    },
  ]
    .map((r, k) => JSON.stringify({ uuid: `${String(i)}${k}000000-0000-4000-8000-000000000000`, ...r }))
    .join('\n') + '\n';

function startLead(home: string, name: string, i: number) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `f7f0f000-0000-4000-8000-00000000000${i}`;
  const cwd = `/work/${name}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), talk(i));
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 600_000, procStart, version: '2.1.306', kind: 'interactive', name, status: 'busy' }),
  );
  return proc;
}

/** The text sizes the screen draws: every element with its own text, its computed size times the face's size-adjust. */
const typeReport = (page: Page) =>
  page.evaluate(() => {
    const adjust: Record<string, number> = {};
    for (const f of document.fonts) {
      const a = parseFloat((f as FontFace & { sizeAdjust?: string }).sizeAdjust ?? '100%') / 100;
      adjust[f.family.replace(/["']/g, '')] = a || 1;
    }
    const sizes: Record<string, number> = {};
    const faces: Record<string, number> = {};
    const small: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('canvas,svg') || !el.getClientRects().length) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
      if (!own) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const first = cs.fontFamily.split(',')[0].trim().replace(/["']/g, '');
      const px = Math.round(parseFloat(cs.fontSize) * (adjust[first] ?? 1) * 10) / 10;
      sizes[px] = (sizes[px] ?? 0) + 1;
      const key = `${first} ${cs.fontWeight} ls=${cs.letterSpacing}`;
      faces[key] = (faces[key] ?? 0) + 1;
      if (px < 12) small.push(`${px}px "${el.textContent!.trim().slice(0, 16)}"`);
    }
    return { sizes, faces, small: small.slice(0, 12) };
  });

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const leads = LEADS.map((n, i) => startLead(home, n, i));
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal', '--allow-chat', '--engine', 'on']);
  const deadline = setTimeout(() => {
    console.error('deadline');
    process.exit(2);
  }, DEADLINE_MS);
  let browser: Browser | undefined;
  try {
    const loginUrl = await daemon.loginUrl();
    const base = `http://127.0.0.1:${port}/`;
    // The login code is good once: later contexts take the first one's session cookie.
    let cookies: Awaited<ReturnType<BrowserContext['cookies']>> | null = null;
    const open = async (b: Browser, opts: BrowserContextOptions, theme: 'modern' | 'pixel') => {
      const ctx = await b.newContext(opts);
      if (cookies) await ctx.addCookies(cookies);
      await ctx.addInitScript(
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
      const page = await ctx.newPage();
      await page.goto(cookies ? base : loginUrl);
      await page.waitForURL(base);
      cookies ??= await ctx.cookies();
      await page.locator('[data-testid="agent-card"]').first().waitFor({ timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(3_000);
      return { ctx, page };
    };
    const shot = async (page: Page, name: string) => {
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) });
      const r = await typeReport(page);
      const sizes = Object.entries(r.sizes)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([px, n]) => `${px}:${n}`)
        .join(' ');
      log(`[${name}] drawn px:count ${sizes}`);
      log(`[${name}] faces ${Object.entries(r.faces).map(([f, n]) => `${f} x${n}`).join(' | ')}`);
      if (r.small.length) log(`[${name}] under 12 px: ${r.small.join(', ')}`);
    };
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        log(`[${name}] STEP FAILED ${String(err).split('\n')[0]}`);
      }
    };
    const phone: BrowserContextOptions = (() => {
      const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
      delete d.defaultBrowserType;
      return { ...d, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3 };
    })();

    browser = await launchBrowser({ webkit: true });
    {
      const { ctx, page } = await open(browser, phone, 'modern');
      const dock = (s: string) => page.locator(`[data-dock="${s}"]`).tap();
      await step('phone-office', () => shot(page, 'phone-office'));
      await step('phone-member', async () => {
        // A tap while the page still settles can be lost: tap again until the sheet is up.
        for (let i = 0; i < 5 && !(await page.getByTestId('inspector').isVisible()); i++) {
          await page.locator('[data-testid="agent-card"]').first().tap();
          await page.waitForTimeout(1_000);
        }
        await page.getByTestId('inspector').waitFor({ timeout: 5_000 });
        await shot(page, 'phone-member');
        await page.getByTestId('inspector-close').tap();
        await page.getByTestId('inspector').waitFor({ state: 'hidden', timeout: 10_000 });
      });
      await step('phone-board', async () => {
        await dock('board');
        await page.locator('[aria-label="현황판 화면"]').waitFor({ timeout: 10_000 });
        await shot(page, 'phone-board');
      });
      const pm = page.getByRole('region', { name: '메신저', exact: true });
      await step('phone-messenger', async () => {
        await dock('messenger');
        await pm.getByRole('list', { name: '연락처' }).waitFor({ timeout: 10_000 });
        await shot(page, 'phone-messenger');
      });
      await step('phone-chat', async () => {
        await pm.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^agent-tycoon/ }).tap();
        await pm.getByRole('region', { name: 'agent-tycoon 대화' }).waitFor({ timeout: 10_000 });
        await shot(page, 'phone-chat');
      });
      await ctx.close();
    }
    {
      const { ctx, page } = await open(browser, phone, 'pixel');
      await step('phone-pixel-theme', () => shot(page, 'phone-pixel-theme'));
      await ctx.close();
    }
    await browser.close();
    browser = await launchBrowser({ args: ['--disable-gpu'] });
    {
      const { ctx, page } = await open(browser, { viewport: { width: 1600, height: 1000 } }, 'modern');
      await step('desktop-office', () => shot(page, 'desktop-office'));
      await ctx.close();
    }
  } finally {
    await browser?.close();
    await daemon.stop();
    clearTimeout(deadline);
    for (const l of leads) l.kill('SIGTERM');
    killFakeSessions(home);
    removeTestHome(home);
    fs.writeFileSync(path.join(OUT, `${TAG}.log`), lines.join('\n') + '\n');
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

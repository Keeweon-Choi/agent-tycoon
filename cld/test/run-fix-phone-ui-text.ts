/**
 * FIX-PHONE-UI-TEXT (owner 11-06 21:50, a real iPhone): the text of every phone screen in both screen
 * styles. dist/cli.js in a temp HOME on its own port, engine on with chat, no model: three Leads as live
 * Claude Code sessions (a `sleep` and a transcript with a long talk), usage readings for Claude and Codex.
 * Headless WebKit as an iPhone 13 (390x844, DPR 3) and an iPhone SE (375x667, DPR 2), 모던 and 픽셀 감성:
 * boot, login, office, party menu, member sheet, usage sheet, 현황판 and its tabs, messenger list, a
 * conversation (and a long draft), 파일, 알림, 개발실, 터미널, 설정 and each of its tabs. Each picture
 * logs the text it finds clipped by its box, multi-line text set looser than 1.75 of its drawn size, and
 * text past the screen's edge. Then headless Chromium (--disable-gpu) at 1600x1000 in 모던, the canvas
 * hidden: office, 현황판, 메신저, 파일, for the pixel-wise desktop comparison (desktop-diff.mts).
 * Pictures and <TAG>.log in cld/artifacts/fix-phone-ui-text/.
 *
 *   TAG=before npx tsx cld/test/run-fix-phone-ui-text.ts <port 19380-19389>
 *
 * DESKTOP_ONLY=1 takes the desktop pictures alone, with the transcripts' and the page's clock fixed and the
 * name plates hidden (characters walk): run it on two builds (CLI=<other build>/dist/cli.js) for a fair pair.
 */
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  fakeUsage,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 19380 && port <= 19389)) throw new Error('port must be 19380-19389');
const TAG = process.env.TAG ?? 'after';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/fix-phone-ui-text');
const DEADLINE_MS = 900_000;
const LEADS = ['cld-gui', 'savetax-mk.2', 'keeweon-portfolio'];
const STORE: Record<string, string> = { 'cld.title-scene': 'off', 'cld.office-iso': 'on', 'cld.floor': '1', 'cld.floor-view': 'one' };
const lines: string[] = [];
const log = (s: string) => (lines.push(s), console.log(s));

const DESKTOP_ONLY = process.env.DESKTOP_ONLY === '1';
const FIXED = new Date('2026-11-06T13:00:00Z');
const now = () => (DESKTOP_ONLY ? FIXED : new Date()).toISOString();
const LONG_KO =
  '모바일 UI 고칠 때 메신저에서 검색 등 네 개 버튼을 위쪽으로 올려서 크기 살짝 줄인 다음에 오케스트레이터 이름이랑 같은 행에 둬. 컴퓨터 화면은 그대로 두고, 지금 프로필 카드가 어색하니까 같이 봐 줘.';
const LONG_EN =
  'Merged into integ: the office keeps three parts together: the elevator column, the top-right corner, the party, the control center and the dock.';
const talk = (i: number) =>
  [
    { type: 'user', timestamp: now(), message: { role: 'user', content: LONG_KO } },
    {
      type: 'assistant',
      timestamp: now(),
      message: {
        model: 'claude-opus-4-7',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `${LONG_EN}\n\n현재 87% 진행됐어요. 남은 일은 3건:\n\n- 데이터 동기화 오류 수정\n- 테마편집 제한탭 최적화\n- v0.${i + 1} 릴리스 노트\n\n| 항목 | 상태 |\n| --- | --- |\n| 캐릭터 이름표 | 진행 중 |`,
          },
        ],
        usage: { input_tokens: 10, cache_read_input_tokens: 60_000, output_tokens: 100 },
      },
    },
  ]
    .map((r, k) => JSON.stringify({ uuid: `${String(i)}${k}000000-0000-4000-8000-000000000000`, ...r }))
    .join('\n') + '\n';

function startLead(home: string, name: string, i: number) {
  const proc = spawn('sleep', ['1200'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `f7f0f000-0000-4000-8000-00000000001${i}`;
  const cwd = path.join(home, 'work', name);
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'README.md'), `# ${name}\n\n${LONG_KO}\n`);
  fs.writeFileSync(path.join(cwd, 'src', '아주-긴-이름의-설정-파일-예시.json'), '{}\n');
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

/** Text the screen draws wrong in numbers: clipped by its box, set loose over several lines, or past the edge. */
const textReport = (page: Page) =>
  page.evaluate(() => {
    const adjust: Record<string, number> = {};
    for (const f of document.fonts) {
      const a = parseFloat((f as FontFace & { sizeAdjust?: string }).sizeAdjust ?? '100%') / 100;
      adjust[f.family.replace(/["']/g, '')] = a || 1;
    }
    const found: string[] = [];
    const ratios: Record<string, number> = {};
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('canvas,svg,.xterm') || !el.getClientRects().length) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
      if (!own) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth || !r.width) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const what = `"${el.textContent!.trim().replace(/\s+/g, ' ').slice(0, 24)}"`;
      const first = cs.fontFamily.split(',')[0].trim().replace(/["']/g, '');
      const drawn = parseFloat(cs.fontSize) * (adjust[first] ?? 1);
      const lh = cs.lineHeight === 'normal' ? NaN : parseFloat(cs.lineHeight);
      const ratio = Math.round((lh / drawn) * 10) / 10;
      if (Number.isFinite(ratio)) ratios[ratio] = (ratios[ratio] ?? 0) + 1;
      if (Number.isFinite(lh) && r.height > lh * 1.6 && lh / drawn > 1.75) found.push(`loose ${ratio}x ${what}`);
      const clipX = cs.overflowX !== 'visible' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1;
      const clipY = (cs.overflowY === 'hidden' || cs.overflowY === 'clip') && el.scrollHeight > el.clientHeight + 1;
      if (clipX || clipY) found.push(`clipped${clipX ? '-x' : ''}${clipY ? '-y' : ''} ${what}`);
      if (r.right > innerWidth + 1 && !el.closest('[class*="overflow-x"], .overflow-auto')) found.push(`past-edge ${what}`);
    }
    return { found: [...new Set(found)].slice(0, 20), ratios };
  });

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const leads = LEADS.map((n, i) => startLead(home, n, i));
  // One project the engine runs (the fake claude): its conversation has the composer.
  const alpha = path.join(home, 'work', 'alpha');
  fs.mkdirSync(alpha, { recursive: true });
  fs.writeFileSync(path.join(configDirectory(home), 'projects.json'), JSON.stringify([{ name: 'alpha', folder: alpha, room: '개발실', wantRunning: true }]));
  const usage = await fakeUsage(home, { fiveHour: 15, sevenDay: 4, fable: 0 }, { fiveHour: 0, sevenDay: 21 });
  const daemon = startDaemon({ home, claudePath }, port, ['--allow-chat', '--engine', 'on'], usage.env, false, process.env.CLI);
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
            localStorage.setItem('cld.ui-theme', th);
          } catch {
            // about:blank
          }
        },
        [Object.entries(STORE), theme] as const,
      );
    const shot = async (page: Page, name: string) => {
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUT, `${TAG}-${shotName}-${name}.png`) });
      const r = await textReport(page);
      const ratios = Object.entries(r.ratios)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([k, n]) => `${k}:${n}`)
        .join(' ');
      log(`[${shotName} ${name}] line-height/drawn ${ratios}`);
      for (const f of r.found) log(`[${shotName} ${name}]   ${f}`);
    };
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        log(`[${shotName} ${name}] STEP FAILED ${String(err).split('\n')[0]}`);
      }
    };
    const phones: Array<[string, BrowserContextOptions]> = [
      ['390', { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3 }],
      ['375', { ...devices['iPhone SE'], viewport: { width: 375, height: 667 }, screen: { width: 375, height: 667 }, deviceScaleFactor: 2 }],
    ];
    for (const [, d] of phones) delete (d as { defaultBrowserType?: string }).defaultBrowserType;

    browser = await launchBrowser({ webkit: true });
    for (const [size, opts] of DESKTOP_ONLY ? [] : phones) {
      for (const theme of ['modern', 'pixel'] as const) {
        shotName = `${size}-${theme}`;
        // Login: a context with no session.
        if (cookies) {
          const ctx = await browser.newContext(opts);
          await init(ctx, theme);
          const page = await ctx.newPage();
          await step('login', async () => {
            await page.goto(base);
            await page.waitForLoadState('load');
            await page.evaluate(() => document.fonts.ready);
            await shot(page, 'login');
          });
          await ctx.close();
        }
        const ctx = await browser.newContext(opts);
        if (cookies) await ctx.addCookies(cookies);
        await init(ctx, theme);
        const page = await ctx.newPage();
        page.setDefaultTimeout(8_000);
        page.on('pageerror', (e) => log(`[${shotName}] pageerror ${e.message}`));
        await page.goto(cookies ? base : loginUrl);
        await page.waitForURL(base);
        cookies ??= await ctx.cookies();
        await step('boot', async () => {
          await page.waitForTimeout(250);
          await page.screenshot({ path: path.join(OUT, `${TAG}-${shotName}-boot.png`) });
        });
        await page.locator('[data-testid="agent-card"]').first().waitFor({ timeout: 60_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(3_000);
        const dock = (s: string) => page.locator(`[data-dock="${s}"]`).tap();
        const tabs = async (scope: Locator, prefix: string) => {
          const all = scope.locator('[role="tab"]');
          const n = Math.min(await all.count(), 8);
          for (let i = 1; i < n; i++) {
            await all.nth(i).tap();
            await shot(page, `${prefix}-tab${i}`);
          }
          if (n) await all.first().tap();
        };
        await step('office', () => shot(page, 'office'));
        await step('party-menu', async () => {
          await page.getByTestId('party-strip-head').getByRole('button').first().tap({ timeout: 5_000 });
          await shot(page, 'party-menu');
          await page.keyboard.press('Escape');
          await page.mouse.click(5, 300);
        });
        await step('member', async () => {
          for (let i = 0; i < 5 && !(await page.getByTestId('inspector').isVisible()); i++) {
            await page.locator('[data-testid="agent-card"]').first().tap();
            await page.waitForTimeout(1_000);
          }
          await page.getByTestId('inspector').waitFor({ timeout: 5_000 });
          await shot(page, 'member');
          await page.getByTestId('inspector-close').tap();
          await page.getByTestId('inspector').waitFor({ state: 'hidden', timeout: 10_000 });
        });
        await step('usage', async () => {
          await page.getByTestId('cc-seg-usage').tap();
          await page.getByTestId('cc-usage-sheet').waitFor({ timeout: 5_000 });
          await shot(page, 'usage');
          await page.getByTestId('cc-usage-sheet-close').tap();
        });
        await step('board', async () => {
          await dock('board');
          const b = page.locator('[aria-label="현황판 화면"]');
          await b.waitFor({ timeout: 10_000 });
          await shot(page, 'board');
          await tabs(b, 'board');
        });
        const pm = page.getByRole('region', { name: '메신저', exact: true });
        await step('messenger', async () => {
          await dock('messenger');
          await pm.getByRole('list', { name: '연락처' }).waitFor({ timeout: 10_000 });
          await shot(page, 'messenger');
        });
        await step('chat', async () => {
          await pm.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^cld-gui/ }).tap();
          await pm.getByRole('region', { name: 'cld-gui 대화' }).waitFor({ timeout: 10_000 });
          await page.waitForTimeout(800);
          await shot(page, 'chat');
        });
        await step('chat-draft', async () => {
          await pm.getByRole('button', { name: /목록/ }).first().tap();
          await pm.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }).tap();
          const box = pm.getByRole('region', { name: 'alpha 대화' }).getByRole('textbox', { name: '보낼 글' });
          await box.fill(LONG_KO);
          await shot(page, 'chat-draft');
          await box.fill('');
        });
        for (const s of ['notices', 'devroom', 'terminal'])
          await step(s, async () => {
            if (!(await page.locator(`[data-dock="${s}"]`).count())) return log(`[${shotName} ${s}] no such tab`);
            await dock(s);
            await page.waitForTimeout(1_200);
            await shot(page, s);
          });
        await step('settings', async () => {
          await dock('office');
          await page.getByTestId('mobile-top-bar').getByRole('button', { name: '설정' }).tap();
          const st = page.getByTestId('settings-tabs');
          await st.waitFor({ timeout: 5_000 });
          await shot(page, 'settings');
          const all = st.getByRole('tab');
          const n = await all.count();
          for (let i = 1; i < n; i++) {
            await all.nth(i).tap();
            await shot(page, `settings-tab${i}`);
          }
        });
        // Last: Playwright's WebKit (Linux) crashes the page on 파일 in 픽셀 감성, before this task's changes too.
        await step('files', async () => {
          await page.getByRole('button', { name: /^x$/i }).last().tap({ timeout: 2_000 }).catch(() => undefined);
          await dock('files');
          await page.waitForTimeout(1_200);
          await shot(page, 'files');
        });
        await ctx.close();
      }
    }
    await browser.close();
    browser = await launchBrowser({ args: ['--disable-gpu'] });
    {
      shotName = 'desktop';
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      if (cookies) await ctx.addCookies(cookies);
      await init(ctx, 'modern');
      const page = await ctx.newPage();
      if (DESKTOP_ONLY) await page.clock.setFixedTime(FIXED);
      if (!cookies) {
        await page.goto(loginUrl);
        await page.waitForURL(base);
      }
      await page.goto(base);
      await page.locator('[data-testid="agent-card"]').first().waitFor({ timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(3_000);
      // The canvas and every motion stop, so before and after differ only where the DOM's text does (and the clock).
      await page.addStyleTag({ content: (DESKTOP_ONLY ? '[data-testid="agent-overlay"]{visibility:hidden!important}' : '') + 'canvas{visibility:hidden!important}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
      await step('office', () => shot(page, 'office'));
      for (const id of ['office', 'messenger', 'files'])
        await step(id, async () => {
          await page.locator(`[data-hud-id="icon:${id}"] button`).first().click();
          await page.waitForTimeout(1_500);
          await shot(page, id === 'office' ? 'board' : id);
        });
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

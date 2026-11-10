/**
 * FIX-PHONE-MESSENGER-HEADER (owner 11-06 21:42): the phone messenger's conversation head (the four buttons in the
 * name's row, 40 px, the state line under it) and the usage strip's "남음". dist/cli.js in a temp HOME on its own
 * port, engine on with chat, three Leads as live Claude Code sessions. Headless WebKit as an iPhone (390x844,
 * DPR 3) in 모던 and 픽셀 감성: the conversation of a short and of a long name, with the head measured (button
 * boxes, the name and the state line, the usage strip on one line); then Chromium (--disable-gpu) at 1600x1000:
 * the desktop messenger, whole page and the messenger window alone (compared pixel-wise before/after).
 * Pictures and <TAG>.log in agent-tycoon/artifacts/fix-phone-messenger-header/.
 *
 *   TAG=before npx tsx agent-tycoon/test/run-fix-phone-messenger-header.ts <port 19350-19359>
 */
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import {
  assertPortFree,
  fakeUsage,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 19350 && port <= 19359)) throw new Error('port must be 19350-19359');
const TAG = process.env.TAG ?? 'after';
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/fix-phone-messenger-header');
const DEADLINE_MS = 480_000;
const LEADS = ['agent-tycoon', 'keeweon-portfolio-long-name'];
const STORE: Record<string, string> = { 'agty.title-scene': 'off', 'agty.office-iso': 'on', 'agty.floor': '1', 'agty.floor-view': 'one' };
const lines: string[] = [];
const log = (s: string) => (lines.push(s), console.log(s));

/** The head's boxes and the usage strip's line, in CSS px. */
const headReport = (page: Page) =>
  page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const head = document.querySelector('header.msg-head');
    const name = head?.querySelector('strong');
    const buttons = [...(head?.querySelectorAll('.msg-head-tools button') ?? [])].map((b) => ({ label: b.getAttribute('aria-label'), ...box(b) }));
    const row = document.querySelector('.cc-phone-row');
    return {
      head: box(head ?? null),
      name: box(name ?? null),
      nameTruncated: name ? name.scrollWidth > name.clientWidth : null,
      state: box(head?.querySelector('.msg-head-state') ?? null),
      buttons,
      viewport: innerWidth,
      strip: row ? { text: row.textContent, ...box(row), scrollW: row.scrollWidth, clientW: row.clientWidth } : null,
    };
  });

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(path.join(configDirectory(home), 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const folderOf = (name: string) => path.join(home, 'work', name);
  for (const name of LEADS) fs.mkdirSync(folderOf(name), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(LEADS.map((name) => ({ name, folder: folderOf(name), room: '개발실', wantRunning: true }))),
  );
  // Claude: 94% of the week left (6 used), Codex 79% (21 used): the owner's photo.
  const usage = await fakeUsage(home, { sevenDay: 6 }, { fiveHour: 5, sevenDay: 21 });
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--no-terminal'], usage.env);
  const deadline = setTimeout(() => {
    console.error('deadline');
    process.exit(2);
  }, DEADLINE_MS);
  let browser: Browser | undefined;
  try {
    const loginUrl = await daemon.loginUrl();
    const base = `http://127.0.0.1:${port}/`;
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
      await (opts.isMobile ? page.getByTestId('party-strip') : page.getByRole('button', { name: /^메신저/ })).waitFor({ timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(3_000);
      return { ctx, page };
    };
    const shot = async (page: Page, name: string) => {
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) });
      log(`[${name}] ${JSON.stringify(await headReport(page))}`);
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
    for (const theme of ['modern', 'pixel'] as const) {
      const { ctx, page } = await open(browser, phone, theme);
      const pm = page.getByRole('region', { name: '메신저', exact: true });
      await step(`${theme}-open`, async () => {
        await page.locator('[data-dock="messenger"]').tap();
        await pm.getByRole('list', { name: '연락처' }).waitFor({ timeout: 10_000 });
      });
      for (const [i, lead] of LEADS.entries()) {
        await step(`phone-${theme}-chat-${i}`, async () => {
          if (i) await pm.getByRole('button', { name: /목록/ }).tap();
          await pm.getByRole('list', { name: '연락처' }).getByRole('button', { name: new RegExp(`^${lead}`) }).tap();
          await pm.getByRole('region', { name: `${lead} 대화` }).waitFor({ timeout: 10_000 });
          await shot(page, `phone-${theme}-chat-${i}`);
        });
      }
      await ctx.close();
    }
    await browser.close();
    browser = await launchBrowser({ args: ['--disable-gpu'] });
    {
      const { ctx, page } = await open(browser, { viewport: { width: 1600, height: 1000 } }, 'modern');
      await step('desktop-chat', async () => {
        const messenger = page.getByRole('region', { name: '메신저', exact: true });
        await page.getByRole('button', { name: /^메신저($| \()/ }).click();
        const list = messenger.getByRole('list', { name: '연락처' });
        await list.getByRole('button', { name: /^agent-tycoon/ }).click();
        await messenger.getByRole('region', { name: 'agent-tycoon 대화' }).waitFor({ timeout: 10_000 });
        await page.waitForTimeout(1_500);
        await messenger.screenshot({ path: path.join(OUT, `${TAG}-desktop-messenger.png`) });
        await shot(page, 'desktop-chat');
      });
      await ctx.close();
    }
  } finally {
    await browser?.close();
    await daemon.stop();
    clearTimeout(deadline);
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

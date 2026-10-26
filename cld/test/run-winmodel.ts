/**
 * WINMODEL: one window/tab model, the owner's four bugs of 10-24 and the PC taskbar icons.
 * Phone (393x852, the Dock is a tab bar):
 *  - a notice tapped in the 알림 tab opens the messenger on its conversation, and it stays;
 *  - switching tabs keeps every tab (conversation, draft, scroll; the 작업실's project and tab);
 *  - the shown tab pressed again goes to its root (conversation -> list), the pages have no `_`;
 *  - Back steps inside the tab (conversation -> list), then home, closing nothing.
 * Desktop (1280x800, the icons are a Windows taskbar):
 *  - gray opens in front (filled), another window puts it behind (outline), its icon brings it
 *    back to front; the front one's icon minimizes and the next press restores the same
 *    conversation, draft and scroll; a notice opening the messenger keeps it open; no history
 *    entry is pushed for windows (the browser's Back is not taken).
 *
 * dist/cli.js with --engine on --allow-chat --no-terminal in a temp HOME whose `claude` is the
 * engine fake, on a spare port; headless Chromium (--disable-gpu). Screenshots in
 * cld/artifacts/winmodel/.
 *
 *   npx tsx cld/test/run-winmodel.ts <port 18256-18259>
 */
import type { Browser, BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/winmodel');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__wm/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
const IPHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 } };
})();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const repo = makeTempRepo();
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({
      v: 2,
      projects: [
        { projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({
      v: 1,
      assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }],
    }),
  );
  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { PATH, FAKE_TURN_MS: '400', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
    true,
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    type Sess = { cwd: string; sessionId: string; name: string };
    const session = (name: string): Sess | null => {
      for (const f of fs.readdirSync(sessions)) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf8')) as Sess;
          if (s.name === name) return s;
        } catch {
          /* being written */
        }
      }
      return null;
    };
    await daemon.loginUrl();
    for (const end = Date.now() + 40_000; !session('alpha'); await wait(300))
      if (Date.now() > end) throw new Error('the Lead did not revive');

    let n = 0;
    const line = (rec: Record<string, unknown>) => {
      const s = session('alpha')!;
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const uuid = `${(++n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
      fs.appendFileSync(file, `${JSON.stringify({ uuid, timestamp: new Date().toISOString(), ...rec })}\n`);
    };
    const say = (role: 'user' | 'assistant', text: string) =>
      line({ type: role, message: { role, content: role === 'user' ? text : [{ type: 'text', text }] } });
    for (let i = 1; i <= 30; i++) say(i % 2 ? 'user' : 'assistant', `대화 ${i}번째 메시지 오늘 할 일 정리`);
    say('assistant', 'REPLY-TARGET 작업을 마쳤어요');
    await wait(1100);
    /** A turn end of alpha: one notice that opens its conversation. */
    const turnEnd = () => line({ type: 'system', subtype: 'turn_duration', durationMs: 900 });

    browser = await launchBrowser();
    const open = async (opts: BrowserContextOptions) => {
      const ctx = await browser!.newContext(opts);
      if (fs.existsSync(FONT))
        await ctx.route('**/__wm/malgun.ttf', (r) => r.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      await ctx.addInitScript('window.__name = (f) => f');
      const page = await ctx.newPage();
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      await page.locator('[data-testid="agent-overlay"]').first().waitFor();
      await page.waitForTimeout(1500);
      return { ctx, page };
    };
    const contacts = (scope: Locator) => scope.getByRole('list', { name: '연락처' });
    const pickAlpha = async (scope: Locator, conv: Locator) => {
      await contacts(scope).waitFor({ timeout: 8000 });
      await contacts(scope).getByRole('button', { name: /^alpha/ }).first().click();
      await conv.getByText('REPLY-TARGET').waitFor({ timeout: 15_000 });
    };
    /** Type a draft and scroll the conversation up; returns the scroll it was left at. */
    const draftAndScroll = async (page: Page, conv: Locator): Promise<number> => {
      await conv.getByRole('textbox', { name: '보낼 글' }).fill('초안 그대로');
      const list = conv.locator('[data-testid="chat-scroll"]');
      await list.evaluate((el) => (el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 200)));
      await page.waitForTimeout(400);
      return list.evaluate((el) => el.scrollTop);
    };
    const sameAsLeft = async (conv: Locator, top: number) =>
      (await conv.getByRole('textbox', { name: '보낼 글' }).inputValue()) === '초안 그대로' &&
      Math.abs((await conv.locator('[data-testid="chat-scroll"]').evaluate((el) => el.scrollTop)) - top) <= 2;

    // ───────────── Phone ─────────────
    {
      const { ctx, page } = await open(IPHONE);
      const shot = (name: string) => page.screenshot({ path: path.join(OUT, `phone-${name}.png`) });
      const tap = (tab: string) => page.locator(`[data-dock="${tab}"]`).tap();
      const active = () => page.getByTestId('mobile-dock').locator('[aria-current="page"]').getAttribute('data-dock');
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      const workbench = page.locator('[aria-label="작업실 화면"]');

      // 1. A notice opens the messenger, and it stays (10-24: it closed at once).
      turnEnd();
      await tap('notices');
      const item = page.locator('[data-testid="notice-item"]:not([disabled])').first();
      await item.waitFor({ timeout: 15_000 });
      await shot('1-notices');
      await item.tap();
      await page.waitForTimeout(1500);
      check((await active()) === 'messenger' && (await conv.isVisible()), `phone 1: the notice opens the messenger on its conversation and it stays (tab ${await active()})`);
      await shot('1-notice-to-messenger');

      // 2. Switching tabs keeps every tab.
      const top = await draftAndScroll(page, conv);
      await tap('workbench');
      await workbench.getByRole('combobox', { name: '작업실 프로젝트' }).selectOption('alpha');
      await workbench.getByRole('button', { name: 'Task', exact: true }).tap();
      await page.waitForTimeout(500);
      await shot('2-workbench');
      for (const tab of ['board', 'notices', 'messenger']) {
        await tap(tab);
        await page.waitForTimeout(500);
      }
      check((await active()) === 'messenger' && (await sameAsLeft(conv, top)), `phone 2: back on the messenger, the same conversation, draft and scroll (${top})`);
      await shot('2-messenger-kept');
      await tap('workbench');
      await page.waitForTimeout(500);
      check(
        (await workbench.getByRole('combobox', { name: '작업실 프로젝트' }).inputValue()) === 'alpha' &&
          (await workbench.getByRole('button', { name: 'Task', exact: true }).getAttribute('aria-pressed')) === 'true',
        'phone 2: the 작업실 kept its project and tab',
      );

      // 3. The shown tab again: its root; no minimize on the phone.
      await tap('messenger');
      await page.waitForTimeout(400);
      check((await page.getByRole('button', { name: '최소화' }).count()) === 0, 'phone 3: no minimize button on the pages');
      await tap('messenger');
      await page.waitForTimeout(500);
      check((await active()) === 'messenger' && (await contacts(messenger).isVisible()) && !(await conv.isVisible()), 'phone 3: the messenger tab pressed while shown goes to its list');
      await shot('3-tab-root');

      // 4. Back steps inside the tab, then home, closing nothing.
      await pickAlpha(messenger, conv);
      await page.evaluate(() => history.back());
      await page.waitForTimeout(700);
      check((await active()) === 'messenger' && (await contacts(messenger).isVisible()), `phone 4: Back from the conversation shows the list (tab ${await active()})`);
      await shot('4-back-list');
      await page.evaluate(() => history.back());
      await page.waitForTimeout(700);
      check((await active()) === 'office' && page.url() === `http://127.0.0.1:${port}/`, `phone 4: Back again goes to the office home (tab ${await active()})`);
      await shot('4-back-home');
      await tap('workbench');
      await page.waitForTimeout(500);
      check(
        (await workbench.getByRole('combobox', { name: '작업실 프로젝트' }).inputValue()) === 'alpha',
        'phone 4: Back closed nothing (the 작업실 is still on alpha)',
      );
      await ctx.close();
    }

    // ───────────── Desktop ─────────────
    {
      const { ctx, page } = await open({ viewport: { width: 1280, height: 800 } });
      const shot = (name: string) => page.screenshot({ path: path.join(OUT, `desktop-${name}.png`) });
      const icon = (id: string) => page.locator(`[data-hud-id="icon:${id}"] button`);
      const state = (id: string) => icon(id).getAttribute('data-window');
      const win = (id: string) => page.locator(`[data-hud-window="${id}"]`);
      const conv = win('messenger').getByRole('region', { name: 'alpha 대화' });
      const entries = await page.evaluate(() => history.length);

      check((await state('messenger')) === 'closed' && (await state('notices')) === 'closed', 'desktop: icons start gray (closed)');
      await icon('messenger').click();
      await page.waitForTimeout(500);
      check((await state('messenger')) === 'front' && (await win('messenger').isVisible()), 'desktop: gray messenger icon opens it in front (filled)');
      await pickAlpha(win('messenger'), conv);
      const top = await draftAndScroll(page, conv);
      await icon('notices').click();
      await page.waitForTimeout(500);
      check(
        (await state('notices')) === 'front' && (await state('messenger')) === 'behind' && (await win('messenger').isVisible()),
        'desktop: opening the notices keeps the messenger open, behind (outline)',
      );
      await shot('1-icons-front-behind');
      await icon('messenger').click();
      await page.waitForTimeout(400);
      check((await state('messenger')) === 'front' && (await state('notices')) === 'behind', 'desktop: the outline icon brings the messenger to front, the notices stay open');
      await icon('messenger').click();
      await page.waitForTimeout(400);
      check((await state('messenger')) === 'minimized' && !(await win('messenger').isVisible()), 'desktop: the filled icon minimizes the messenger');
      await shot('2-minimized');
      await icon('messenger').click();
      await page.waitForTimeout(500);
      check((await state('messenger')) === 'front' && (await sameAsLeft(conv, top)), `desktop: the next press restores the same conversation, draft and scroll (${top})`);

      // NOTICE-STACK (10-25): a notice opening the messenger leaves the notice window open, behind it.
      await win('messenger').getByRole('button', { name: '메신저 닫기' }).click(); // only the x closes
      await page.waitForTimeout(300);
      check((await state('messenger')) === 'closed', 'desktop: the x closes the messenger (gray)');
      turnEnd();
      check((await state('notices')) === 'front', 'desktop: with the messenger closed, the notices behind it are in front');
      await page.waitForTimeout(400);
      const item = win('notices').locator('[data-testid="notice-item"]:not([disabled])').first();
      await item.waitFor({ timeout: 15_000 });
      await item.click();
      await page.waitForTimeout(1500);
      check(
        (await state('messenger')) === 'front' && (await win('messenger').isVisible()) && (await state('notices')) === 'behind' && (await win('notices').isVisible()),
        `desktop: a notice opens the messenger on top and the notice window stays open (messenger ${await state('messenger')}, notices ${await state('notices')})`,
      );
      await shot('3-notice-to-messenger');
      check((await page.evaluate(() => history.length)) === entries, 'desktop: no history entry pushed for windows (Back is not taken)');
      await ctx.close();
    }
    console.log('\nall checks passed');
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

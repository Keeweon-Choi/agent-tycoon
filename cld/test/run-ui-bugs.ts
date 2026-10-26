/**
 * UI-BUGS-1024: four bugs the owner hit on the phone, reproduced (--before) and shown fixed.
 *  1. with the messenger open, another Dock window (or the messenger from another window)
 *     closed everything (panelHistory's history.back() raced the next panel's pushState);
 *  2. a notice jump put the highlight on a tool/result line after the message;
 *  3. a Dock button of an open window minimizes it, and pressing again brings it back as it was;
 *  4. the 작업실 Task tab's worktree chip ran past the card on the right.
 *
 * dist/cli.js with --engine on --allow-chat --no-terminal in a temp HOME whose `claude` is the
 * engine fake, on a spare port; headless Chromium (--disable-gpu); iPhone viewport 393x852.
 * In --before the checks only report ("bug reproduced"); otherwise a failed check throws.
 * Screenshots in cld/artifacts/ui-bugs-1024/.
 *
 *   npx tsx cld/test/run-ui-bugs.ts <port 18256-18259> [--before]
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { spawnSync } from 'child_process';
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
const BEFORE = process.argv.includes('--before');
const STAGE = BEFORE ? 'before' : 'after';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/ui-bugs-1024');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__ub/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
const IPHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 } };
})();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

/** After: a failed check throws. Before: it reports whether the bug shows. */
function expectFixed(ok: boolean, what: string): void {
  if (BEFORE) {
    console.log(`${ok ? 'absent    ' : 'REPRODUCED'} - ${what}`);
    if (!ok) failed++;
    return;
  }
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
  console.log(`[${STAGE}] daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
        env: { PATH, HOME: home, CLD_OUTPUT: 'json' },
        encoding: 'utf8',
        timeout: 60_000,
      });
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

    // The conversation: a reply, then a tool call and its result AFTER it (what a notice names).
    let n = 0;
    const line = (rec: Record<string, unknown>) => {
      const s = session('alpha')!;
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const uuid = `${(++n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
      fs.appendFileSync(file, `${JSON.stringify({ uuid, timestamp: new Date().toISOString(), ...rec })}\n`);
    };
    const say = (role: 'user' | 'assistant', text: string) =>
      line({
        type: role,
        message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
      });
    for (let i = 1; i <= 16; i++) say(i % 2 ? 'user' : 'assistant', `대화 ${i}번째 메시지 오늘 할 일 정리`);
    say('assistant', 'REPLY-TARGET 작업을 마쳤어요');
    await wait(1100);
    line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls -la', description: 'TOOL-LINE 목록 확인' } }] },
    });
    line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'RESULT-LINE total 8' }] },
    });
    await wait(1100);
    const noticeAt = Date.now();

    // Tasks: many (the Task tab scrolls), one with a long worktree name.
    for (let i = 1; i <= 14; i++) cli('task', 'add', `Filler task number ${i} for scrolling`, '--project', 'alpha');
    cli('task', 'add', 'Safe remote S 10 LAN websocket S 11 LAN session socket cleanup', '--project', 'alpha');
    const long = cli('task', 'list', '--project', 'alpha');
    const longId = (JSON.parse(long.stdout || '{}').tasks as Array<{ id: string; title: string }> | undefined)?.find((t) =>
      t.title.startsWith('Safe remote'),
    )?.id;
    console.log(`long task ${longId}: worktree ${cli('worktree', 'new', '--task', String(longId)).stdout.slice(0, 160)}`);

    browser = await launchBrowser();
    const ctx = await browser.newContext(IPHONE);
    if (fs.existsSync(FONT))
      await ctx.route('**/__ub/malgun.ttf', (r) => r.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    await ctx.addInitScript('window.__name = (f) => f');
    const phone = await ctx.newPage();
    const url = await daemon.loginUrl();
    await phone.goto(url);
    await phone.waitForURL(`http://127.0.0.1:${port}/`);
    await phone.addStyleTag({ content: FONT_CSS });
    await phone.locator('[data-testid="agent-overlay"]').first().waitFor();
    await phone.waitForTimeout(1500);
    const shot = (name: string) => phone.screenshot({ path: path.join(OUT, `${STAGE}-${name}.png`) });
    const tap = (screen: string) => phone.locator(`[data-dock="${screen}"]`).tap();
    const active = () => phone.getByTestId('mobile-dock').locator('[aria-current="page"]').getAttribute('data-dock');
    const messenger = phone.getByRole('region', { name: '메신저', exact: true });
    const conv = messenger.getByRole('region', { name: 'alpha 대화' });
    const workbench = phone.locator('[aria-label="작업실 화면"]');
    const openConversation = async () => {
      await tap('messenger');
      await messenger.getByRole('list', { name: '연락처' }).waitFor({ timeout: 5000 }).catch(() => undefined);
      const contact = messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ });
      if (await contact.count()) await contact.tap();
      await conv.getByText('REPLY-TARGET').waitFor({ timeout: 15_000 });
    };

    // ── 1. Another window with the messenger conversation open ──
    await openConversation();
    await shot('1-messenger');
    await tap('workbench');
    await phone.waitForTimeout(1000);
    expectFixed((await active()) === 'workbench' && (await workbench.isVisible()), `1: messenger open, Dock 작업실 -> 작업실 shows (dock says ${await active()})`);
    await shot('1-workbench-over-messenger');
    await tap('messenger');
    await phone.waitForTimeout(1000);
    expectFixed((await active()) === 'messenger' && (await conv.isVisible()), `1: from the 작업실, Dock 메신저 -> the conversation shows (dock says ${await active()})`);
    await tap('board');
    await phone.waitForTimeout(1000);
    expectFixed((await active()) === 'board', `1: messenger -> 현황판 shows (dock says ${await active()})`);
    await tap('notices');
    await phone.waitForTimeout(1000);
    expectFixed((await active()) === 'notices', `1: 현황판 -> 알림 shows (dock says ${await active()})`);
    await tap('messenger');
    await phone.waitForTimeout(1000);
    expectFixed((await active()) === 'messenger' && (await conv.isVisible()), `1: 알림 -> 메신저, still the conversation (dock says ${await active()})`);
    await tap('office');
    await phone.waitForTimeout(600);

    // 3: after a switch, the button of the window showing still minimizes (never closes) it.
    await tap('messenger');
    await phone.waitForTimeout(400);
    await tap('board');
    await phone.waitForTimeout(800);
    await tap('board');
    await phone.waitForTimeout(800);
    // WINMODEL (owner 10-24): the shown tab pressed again goes to its root; 사무실 goes home.
    expectFixed((await active()) === 'board', `3: messenger -> 현황판, then 현황판 again: its root, still on it (dock says ${await active()})`);
    await tap('office');
    await phone.waitForTimeout(800);
    expectFixed((await active()) === 'office', `3: 사무실 goes home (dock says ${await active()})`);
    await tap('messenger');
    await phone.waitForTimeout(800);
    expectFixed((await active()) === 'messenger' && (await conv.isVisible()), `3: and the messenger comes back (dock says ${await active()})`);
    await tap('office');
    await phone.waitForTimeout(600);

    // ── 3. Minimize and restore as it was ──
    await tap('messenger');
    await conv.waitFor();
    const box = conv.getByRole('textbox', { name: '보낼 글' });
    await box.fill('초안 그대로');
    const list = conv.locator('[data-testid="chat-scroll"]');
    await list.evaluate((el) => (el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 200)));
    await phone.waitForTimeout(400);
    const scrolled = await list.evaluate((el) => el.scrollTop);
    await tap('office'); // home (WINMODEL: the shown tab's own button goes to its root instead)
    await phone.waitForTimeout(500);
    expectFixed((await active()) === 'office' && !(await conv.isVisible()), 'minimize: 사무실 sends the open messenger home (office)');
    await tap('messenger');
    await conv.waitFor();
    await phone.waitForTimeout(500);
    expectFixed(
      (await box.inputValue()) === '초안 그대로' && Math.abs((await list.evaluate((el) => el.scrollTop)) - scrolled) <= 2,
      `minimize: restored with the same conversation, draft and scroll (${scrolled})`,
    );
    // A fresh page: no other window open, so the 작업실 opens even while bug 1 is unfixed.
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.addStyleTag({ content: FONT_CSS });
    await phone.locator('[data-testid="agent-overlay"]').first().waitFor();
    await phone.waitForTimeout(800);
    await tap('workbench');
    await workbench.getByRole('combobox', { name: '작업실 프로젝트' }).selectOption('alpha');
    await workbench.getByRole('button', { name: 'Task', exact: true }).tap();
    await workbench.locator('[data-testid="task-card"]').first().waitFor({ timeout: 20_000 });
    const scroller = () =>
      workbench.locator('[data-testid="task-card"]').first().evaluateHandle((el) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowY;
          if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
        }
        return document.scrollingElement as Element;
      });
    const wbScroll = await scroller();
    await wbScroll.evaluate((el) => ((el as HTMLElement).scrollTop = 220));
    await phone.waitForTimeout(300);
    const wbTop = await wbScroll.evaluate((el) => (el as HTMLElement).scrollTop);
    await tap('office'); // home
    await phone.waitForTimeout(500);
    expectFixed((await active()) === 'office', 'minimize: 사무실 sends the open 작업실 home (office)');
    await tap('workbench');
    await phone.waitForTimeout(600);
    const wbTop2 = await (await scroller()).evaluate((el) => (el as HTMLElement).scrollTop);
    expectFixed(
      (await workbench.getByRole('combobox', { name: '작업실 프로젝트' }).inputValue()) === 'alpha' &&
        (await workbench.locator('[data-testid="task-card"]').count()) > 5 &&
        Math.abs(wbTop2 - wbTop) <= 2 &&
        wbTop > 0,
      `minimize: the 작업실 restored on the same project, Task tab and scroll (${wbTop} -> ${wbTop2})`,
    );

    // ── 4. The Task tab's right edge ──
    await workbench.getByTestId('task-worktree').first().scrollIntoViewIfNeeded();
    await phone.waitForTimeout(300);
    const edge = await phone.evaluate(() => {
      const W = window.innerWidth;
      const chip = document.querySelector<HTMLElement>('[data-testid="task-worktree"]');
      const card = chip?.closest<HTMLElement>('[data-testid="task-card"]');
      const cr = chip?.getBoundingClientRect();
      const kr = card?.getBoundingClientRect();
      let widest = 0;
      for (const el of document.querySelectorAll<HTMLElement>('[aria-label="작업실 화면"] *'))
        widest = Math.max(widest, el.getBoundingClientRect().right);
      return {
        W,
        chipRight: cr ? Math.round(cr.right) : null,
        cardRight: kr ? Math.round(kr.right) : null,
        widest: Math.round(widest),
        page: document.documentElement.scrollWidth,
        text: chip?.innerText ?? '',
      };
    });
    console.log(`task edge: ${JSON.stringify(edge)}`);
    await shot('4-task-tab');
    expectFixed(
      edge.chipRight !== null && edge.cardRight !== null && edge.chipRight <= edge.cardRight && edge.widest <= edge.W && edge.page <= edge.W,
      `4: the worktree chip stays inside its card and the screen (chip right ${edge.chipRight}, card right ${edge.cardRight}, widest ${edge.widest}, screen ${edge.W})`,
    );
    await tap('office');

    // ── 2. A notice jump lands on the message ──
    await phone.goto(`http://127.0.0.1:${port}/?open=chat&lead=alpha&at=${noticeAt}`);
    await phone.addStyleTag({ content: FONT_CSS });
    await phone.locator('[data-testid="agent-overlay"]').first().waitFor();
    await conv.waitFor({ timeout: 20_000 });
    await phone.waitForTimeout(1200);
    const focused = await conv.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>('[data-focused="true"]')].map((e) => e.innerText.slice(0, 60)),
    );
    console.log(`highlighted rows: ${JSON.stringify(focused)}`);
    await shot('2-notice-jump');
    expectFixed(focused.length === 1 && focused[0].includes('REPLY-TARGET'), `2: the notice highlights the message, not a tool line (${JSON.stringify(focused)})`);
    await ctx.close();
    console.log(BEFORE ? `\n${failed} bug(s) reproduced` : '\nall checks passed');
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

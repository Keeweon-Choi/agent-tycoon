/**
 * T-0014 visual check (TC-154..156 and the 20:4x in-app chat view): dist/cli.js
 * with an isolated HOME and the fake claude (its `attach` is an echoing prompt),
 * on a spare port. The real claude is never run: HOME is a temp dir and the
 * fake comes first.
 *
 * A. --allow-chat, Claude sessions only (S-chat): 대화 opens the office
 *    messenger (T-0043); the terminal-bound alpha-orchestrator's conversation
 *    is read-only; the background beta-task's 터미널로 보기 opens its terminal
 *    as a tab of the terminal workspace (T-0078), two phone profiles join that
 *    attach, gamma-review's tab is refused by the cap (1) until 이 터미널로
 *    바꾸기 swaps it in, the 설정 cap (2) lets both attach, x on a tab ends its
 *    attach, and old-job (a row without a pid: killed by a reboot) is refused.
 * (Sending from the chat view is the engine messenger's: run-messenger.ts.)
 * C. without --allow-chat: nothing of it is there.
 *
 *   npx tsx cld/test/run-chat.ts <port 18256-18259>
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocket } from 'ws';

import type { FakeHome } from '../../server/src/cld/testHome.js';
import {
  assertPortFree,
  type Daemon,
  FAKE_CLAUDE,
  launchBrowser,
  makeFakeHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0014');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
// Hangul from Malgun Gothic in the UI (pixel font) and in xterm (Menlo is in
// its font stack but absent here): for its range, the @font-face wins.
const HANGUL = 'unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3;';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0014/malgun.ttf'); ${HANGUL} }
@font-face { font-family: 'Menlo'; src: url('/__t0014/malgun.ttf'); ${HANGUL} }`;
// T-0056: the no-send line starts so and names the reason after it (webview-ui/src/cld/chat.ts).
const READ_ONLY = '이 대화는 앱에서 보낼 수 없어요';
const OUTSIDE_TERMINAL = '(엔진 밖 터미널에서 열려 있음)';
/** An iPhone's notch and home indicator, as T-0008's vars carry them. */
const SAFE_AREA = ':root { --cld-safe-top: 47px; --cld-safe-bottom: 34px; }';
const DESKTOP: BrowserContextOptions = {
  viewport: { width: 1400, height: 900 },
  deviceScaleFactor: 1,
};
const IPHONE13 = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();

type Hooks = {
  getTileCenter?: (c: number, r: number) => { x: number; y: number } | null;
  getCameraFollowId?: () => number | null;
};

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

/** Session ids of the running fake `claude attach` processes (their argv:
 *  the fake execs `attach.cjs <id>` for `claude attach <id>`). */
const attachIds = () =>
  (spawnSync('pgrep', ['-af', `${FAKE_CLAUDE}/attach.cjs`]).stdout ?? '')
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' ').at(-1));

/** Text of the visible terminal pane. */
const termText = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.xterm-rows')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => el.innerText)
      .join('\n'),
  );

const visibleRows = (page: Page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll<HTMLElement>('.xterm-rows')].find(
        (el) => el.offsetParent !== null,
      )?.children.length ?? 0,
  );

/** Wait until the PTY has caught up with the pane: the fake attach prints \`[size CxR]\` on every
 *  resize, and the last one must have as many rows as the pane shows. Typing earlier races the
 *  keyboard's resize (the text lands above the redrawn prompt) under load. */
const ptySettled = (page: Page) =>
  page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLElement>('.xterm-rows')]
        .filter((el) => el.offsetParent !== null)
        .some((el) => {
          const sizes = [...el.innerText.matchAll(/\[size \d+x(\d+)\]/g)];
          return sizes.length > 0 && Number(sizes.at(-1)![1]) === el.children.length;
        }),
    undefined,
    { timeout: 20_000, polling: 'raf' },
  );

/** Wait until the visible pane shows `text`; returns how long it took (ms). */
async function waitForTerm(page: Page, text: string): Promise<number> {
  const t0 = Date.now();
  await page.waitForFunction(
    (t) =>
      [...document.querySelectorAll<HTMLElement>('.xterm-rows')].some(
        (el) => el.offsetParent !== null && el.innerText.includes(t),
      ),
    text,
    { timeout: 10_000, polling: 'raf' },
  );
  return Date.now() - t0;
}

const hooks = (page: Page) =>
  page.evaluate(() => {
    const h = (window as unknown as { __pixelAgentsTestHooks: Hooks }).__pixelAgentsTestHooks;
    const a = h.getTileCenter?.(0, 0);
    const b = h.getTileCenter?.(1, 0);
    return { scale: a && b ? (b.x - a.x) / 16 : 2, followed: h.getCameraFollowId?.() ?? null };
  });

const label = (page: Page, name: string) =>
  page
    .locator('[data-testid="agent-overlay"]')
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();

/** Click (or tap) a character until the office follows it; returns its menu
 *  (T-0017's character menu, where 대화 lives). The label's top is 34 CSS px
 *  above screenY = feet - 32 world px; the hit box is the 24 world px above
 *  the feet. */
async function select(page: Page, name: string, tap: boolean): Promise<Locator> {
  for (let i = 0; i < 24; i++) {
    // A click that lands on the lobby's board opens it full screen (T-0046): close it.
    if (await page.getByTestId('board-full').count()) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    // The messenger, if still open, covers the office: close it before clicking in it.
    const closeMessenger = page.getByRole('button', { name: '메신저 닫기' });
    if (await closeMessenger.count()) {
      await closeMessenger.first().click();
      await page.waitForTimeout(400);
    }
    // T-0077: the 현황판 window floats over the office and may cover the label: close it
    // (the icon opens it again where a step needs it).
    const closeOffice = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeOffice.count()) await closeOffice.first().click();
    const l = label(page, name);
    await l.waitFor();
    const id = Number(await l.getAttribute('data-agent-id'));
    const { scale, followed } = await hooks(page);
    const menu = page.getByRole('menu', { name: `${name} 메뉴` });
    if (followed === id && (await menu.count()) === 1) return menu;
    const box = (await l.boundingBox())!;
    // The camera does not start on every character (a phone sees part of the map): its card
    // brings it into view.
    const view = (await page.getByTestId('office-canvas').boundingBox())!;
    if (
      box.x < view.x ||
      box.x + box.width > view.x + view.width ||
      box.y < view.y ||
      box.y + box.height + 40 * scale > view.y + view.height
    ) {
      const card = page.locator(`[data-testid="agent-card"][data-agent-id="${id}"]`).first();
      if (await card.count()) {
        if (tap) await card.tap();
        else await card.click();
      } else {
        // No card for it: zoom the office out a step (Ctrl+wheel, not a key: the terminal may hold focus).
        await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, 120);
        await page.keyboard.up('Control');
      }
      await page.waitForTimeout(1_500);
      continue;
    }
    // EZ labels grow upward from that point (their bottom is it); plain ones hang 34 px below their top.
    const ez = await l.evaluate((el) => el.classList.contains('-translate-y-full'));
    const [x, y] = [box.x + box.width / 2, (ez ? box.y + box.height : box.y + 34) + 20 * scale];
    if (tap) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
    await page.waitForTimeout(400);
  }
  throw new Error(`could not select ${name}`);
}

const widthFits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** A conversation through the messenger's contact list (the office is too narrow to click a
 *  character while the terminal panel is wide). */
const openConversation = async (page: Page, name: string) => {
  const messenger = page.getByRole('region', { name: '메신저', exact: true });
  // T-0077: the 메신저 icon toggles its window, so it is pressed only while the window is closed.
  if (!(await messenger.count()))
    await page.locator('[data-hud-id="icon:messenger"]').getByRole('button').click();
  await messenger
    .getByRole('list', { name: '연락처' })
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click();
};

const rec = (r: Record<string, unknown>) => `${JSON.stringify(r)}\n`;
const say = (role: 'user' | 'assistant', text: string) =>
  role === 'user'
    ? rec({ type: 'user', message: { role, content: text } })
    : rec({ type: 'assistant', message: { role, content: [{ type: 'text', text }] } });
const tool = (name: string, input: Record<string, unknown>) =>
  rec({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

/** A conversation for the chat views (the transcript the office reads). */
function writeConversation(file: string): void {
  fs.writeFileSync(
    file,
    say('user', '오늘 할 일 정리해 줘') +
      say('assistant', '할 일을 정리할게요.') +
      tool('Read', { file_path: '/work/alpha/TODO.md' }) +
      tool('Bash', { command: 'git log --oneline -5' }) +
      say('assistant', '세 가지가 남았어요: 배포 확인, 문서 정리, 테스트 보강.'),
  );
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const serverLog: string[] = [];
  const homes: FakeHome[] = [];
  let daemon: Daemon | null = null;
  const start = (fake: FakeHome, args: string[]) => {
    daemon = startDaemon(fake, port, ['--no-terminal', ...args]);
    return daemon.loginUrl();
  };
  const stop = async () => {
    const d = daemon;
    daemon = null;
    if (d) {
      await d.stop();
      serverLog.push(...d.log);
    }
  };

  const font = fs.readFileSync(FONT);
  const browser = await launchBrowser();
  const open = async (opts: BrowserContextOptions) => {
    const ctx = await browser.newContext(opts);
    // T-0029: the 현황판 folds rooms and orchestrators; these checks press
    // buttons inside the cards, so a fresh profile starts with all open (모두 펼치기).
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('cld.status-tree'))
        localStorage.setItem('cld.status-tree', '{"rooms":true,"orchs":true}');
    });
    await ctx.route('**/__t0014/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    // Upstream's e2e flag: exposes canvas geometry (getTileCenter) and the
    // followed character, nothing that drives the app.
    await ctx.addInitScript(() => {
      (window as unknown as { __PIXEL_AGENTS_E2E: boolean }).__PIXEL_AGENTS_E2E = true;
    });
    const page = await ctx.newPage();
    // A click on the character that lands on the lobby's board opens it full screen (T-0046) and it
    // would block the next action: close it whenever it does.
    await page.addLocatorHandler(page.locator('[data-testid="board-full"]'), async () => {
      await page.keyboard.press('Escape');
    });
    return { ctx, page };
  };
  const ready = async (page: Page, someone: string) => {
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    await label(page, someone).waitFor();
    await page.waitForTimeout(1500); // spawn effects, characters reach their seats
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const card = (page: Page, scope: Locator, name: string) =>
    scope.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });

  try {
    // ════ A. --allow-chat, claude only ════
    const a = makeFakeHome({ claude: 'S-chat', agentsJson: true });
    homes.push(a);
    writeConversation(
      path.join(a.home, '.claude/projects/-work-alpha/a0000001-0000-4000-8000-000000000001.jsonl'),
    );
    const { ctx: desk, page } = await open(DESKTOP);
    await page.goto(await start(a, ['--allow-chat']));
    await page.waitForURL(BASE);
    await openOfficeWindow(page); // T-0108: a desktop starts with icons only
    await ready(page, 'beta-task');
    const drawer = page.getByRole('complementary', { name: '사무실 정보' });
    check(
      (await card(page, drawer, 'beta-task').getByRole('button', { name: '대화 열기' }).count()) ===
        1 &&
        (await card(page, drawer, 'alpha-orchestrator')
          .getByRole('button', { name: '대화 열기' })
          .count()) === 1 &&
        (await page.locator('a[href*="claude.ai"]').count()) === 0,
      'TC-154/156: 대화 열기 on both cards, no claude.ai link',
    );

    // A terminal-bound session: a read-only chat view without office.
    const alphaMenu = await select(page, 'alpha-orchestrator', false);
    await alphaMenu.getByRole('menuitem', { name: '대화' }).click();
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    const alphaView = messenger.getByRole('region', { name: 'alpha-orchestrator 대화' });
    await alphaView.getByText('세 가지가 남았어요: 배포 확인, 문서 정리, 테스트 보강.').waitFor();
    // A plain Claude session says it is open in a terminal outside the engine.
    check(
      (await alphaView.getByText(OUTSIDE_TERMINAL).count()) === 1,
      'chat view of a plain session: the no-send line names the terminal outside the engine as the reason',
    );
    check(
      (await alphaView.getByText('오늘 할 일 정리해 줘').count()) === 1 &&
        (await alphaView.getByText('📖 자료 읽는 중').count()) === 1 &&
        (await alphaView.getByText('🌿 기록 확인').count()) === 1 &&
        (await alphaView.getByText(READ_ONLY).count()) === 1 &&
        (await alphaView.getByRole('textbox').count()) === 0,
      'chat view of a plain session: the transcript with EZ tool lines, read-only with the hint',
    );
    await shot(page, 'desktop-chatview-readonly');
    await page.getByRole('button', { name: '메신저 닫기' }).click();

    // A background session: its terminal in the drawer.
    const betaMenu = await select(page, 'beta-task', false);
    const chat = betaMenu.getByRole('menuitem', { name: '대화' });
    await chat.waitFor();
    check(true, 'TC-154: clicking the character shows 대화 in its menu');
    await shot(page, 'desktop-menu');
    await chat.click();
    await messenger
      .getByRole('region', { name: 'beta-task 대화' })
      .getByRole('button', { name: '터미널로 보기' })
      .click();
    await page.getByRole('button', { name: '메신저 닫기' }).click();
    await waitForTerm(page, 'fake claude attach a0000016');
    // The click that closed the messenger took the focus; a person clicks into the terminal.
    await page.locator('.xterm-helper-textarea').first().focus();
    check(true, 'TC-154: the terminal workspace opened on the attach of beta-task (a0000016)');
    const latencies: number[] = [];
    let typed = '';
    for (const ch of 'hello') {
      typed += ch;
      await page.keyboard.type(ch);
      latencies.push(await waitForTerm(page, `> ${typed}`));
    }
    check(true, `TC-154: typed text echoes (key -> echo on screen: ${latencies.join(', ')} ms)`);
    await page.keyboard.press('Enter');
    await waitForTerm(page, 'you said: hello');
    check(true, 'Enter reaches the session and its answer streams back');
    await page
      .locator('[data-hud-id^="icon:"]')
      .getByRole('button', { name: '현황판', exact: true })
      .click();
    await drawer.waitFor();
    check(
      (await drawer.getByRole('button', { name: 'HW', exact: true }).count()) === 1 &&
        (await page
          .locator('[data-hud-window="terminal"]')
          .getByRole('tab', { name: /beta-task/ })
          .count()) === 1,
      'TC-154: the 현황판 window keeps its tabs, the 터미널 window the tab of beta-task',
    );
    await page.waitForTimeout(300);
    await shot(page, 'desktop-chat');

    // Phones join the same attach.
    const phones: Array<{ name: string; opts: BrowserContextOptions; safeArea: boolean }> = [
      {
        name: 'phone-360',
        opts: {
          viewport: { width: 360, height: 640 },
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 2,
          userAgent: devices['Pixel 5'].userAgent,
        },
        safeArea: false,
      },
      { name: 'iphone13', opts: IPHONE13, safeArea: true },
    ];
    for (const p of phones) {
      const { page: phone } = await open({ ...p.opts, storageState: await desk.storageState() });
      await phone.goto(BASE);
      await ready(phone, 'beta-task');
      if (p.safeArea) await phone.addStyleTag({ content: SAFE_AREA });
      check(await widthFits(phone), `TC-155 ${p.name}: the office fits the width`);
      const button = (await select(phone, 'beta-task', true)).getByRole('menuitem', {
        name: '대화',
      });
      await button.waitFor();
      await shot(phone, `${p.name}-menu`);
      await button.tap();
      await phone
        .getByRole('region', { name: 'beta-task 대화' })
        .getByRole('button', { name: '터미널로 보기' })
        .tap();
      await waitForTerm(phone, 'you said: hello');
      check(
        true,
        `TC-155 ${p.name}: 터미널로 보기 opens the terminal panel; the replay shows the chat`,
      );
      const back = phone.getByRole('button', { name: '사무실', exact: true }).first();
      await back.waitFor();
      await phone.locator('.xterm-screen').first().tap();
      const vp = p.opts.viewport!;
      const rowsBefore = await visibleRows(phone);
      await phone.setViewportSize({ width: vp.width, height: vp.height - 300 }); // the keyboard
      // Key bar 10-24: Shift, Tab and paste are gone from the bar (Esc, Ctrl, End are on it).
      for (const key of ['Esc 키', '컨트롤 키', 'End 키']) {
        await phone.getByRole('button', { name: key, exact: true }).waitFor();
      }
      check(true, `TC-155 ${p.name}: the key bar (Esc, Ctrl, End) is up`);
      // The pane shrinks first, then the PTY follows: wait for both before typing.
      await phone.waitForFunction(
        (n) =>
          [...document.querySelectorAll<HTMLElement>('.xterm-rows')].find(
            (el) => el.offsetParent !== null,
          )?.children.length !== n,
        rowsBefore,
        { timeout: 20_000, polling: 'raf' },
      );
      await ptySettled(phone);
      await phone.keyboard.type(p.name);
      await waitForTerm(phone, `> ${p.name}`);
      await waitForTerm(page, `> ${p.name}`);
      check(true, `TC-155 ${p.name}: input echoes, also on the desktop (one shared PTY)`);
      check(await widthFits(phone), `TC-155 ${p.name}: the terminal page fits the width`);
      await phone.waitForTimeout(300);
      await shot(phone, `${p.name}-chat`);
      for (let i = 0; i < p.name.length; i++) await phone.keyboard.press('Backspace');
      await phone.setViewportSize(vp);
      await back.tap();
      await label(phone, 'beta-task').waitFor();
      check(true, `TC-155 ${p.name}: 사무실 goes back to the office`);
      await phone.close();
    }
    check(
      JSON.stringify(attachIds()) === JSON.stringify(['a0000016']),
      'one `claude attach a0000016` process for all three viewers',
    );
    fs.writeFileSync(path.join(OUT, 'desktop-terminal.txt'), `${await termText(page)}\n`);
    // T-0078: another background session's terminal is a second tab. The cap (1) keeps it from
    // attaching; its pane offers 이 터미널로 바꾸기, which lets beta-task go and attaches this one.
    await openConversation(page, 'gamma-review');
    await messenger
      .getByRole('region', { name: 'gamma-review 대화' })
      .getByRole('button', { name: '터미널로 보기' })
      .click();
    await page.getByRole('button', { name: '메신저 닫기' }).click();
    const swap = page.getByRole('button', { name: '이 터미널로 바꾸기' });
    await swap.waitFor();
    check(
      (await page.getByTestId('terminal-overlay').getByText('gamma-review').count()) === 1 &&
        JSON.stringify(attachIds()) === JSON.stringify(['a0000016']),
      'cap 1: the second tab names gamma-review and offers 이 터미널로 바꾸기; beta-task keeps its attach',
    );
    await shot(page, 'desktop-cap-reached');
    await swap.click();
    await waitForTerm(page, 'fake claude attach a0000017');
    await page.waitForTimeout(1000);
    check(
      JSON.stringify(attachIds()) === JSON.stringify(['a0000017']),
      'swapping: gamma-review attaches, beta-task lets go: still one attach process',
    );
    // 설정: the number of agent terminals at once (default = --chat-attaches, here 1).
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('tab', { name: '고급', exact: true }).click(); // SETTINGS-TABS: the cap is in the 고급 tab
    const capGroup = page.getByRole('group', { name: '동시에 붙일 에이전트 터미널' });
    await capGroup.waitFor();
    check(
      (await capGroup.getByRole('button', { pressed: true }).innerText()) === '1' &&
        (await capGroup.getByRole('button').count()) === 4 &&
        (await page.getByText('하나에 약 150MB').count()) === 1,
      '설정: 1 to 4, now 1, with the cost "하나에 약 150MB"',
    );
    await capGroup.getByRole('button', { name: '2', exact: true }).click();
    await page.waitForTimeout(500);
    const kept = JSON.parse(
      fs.readFileSync(path.join(a.home, '.config/cld-gui/terminal.json'), 'utf8'),
    ) as { chatAttaches: number };
    check(kept.chatAttaches === 2, '설정: the daemon kept the cap (terminal.json)');
    await shot(page, 'desktop-settings-cap');
    await page.mouse.click(5, 450); // the backdrop closes the dialog
    // Applied live: beta-task's tab (let go) now fits next to gamma-review's without a swap.
    await page.getByRole('tab', { name: /beta-task/ }).click();
    await page.getByRole('button', { name: '이 터미널로 바꾸기' }).click();
    await waitForTerm(page, 'fake claude attach a0000016');
    await page.waitForTimeout(1000);
    check(
      JSON.stringify(attachIds().sort()) === JSON.stringify(['a0000016', 'a0000017']),
      'cap 2 applied without a restart: both agent terminals attached (one process each)',
    );
    // x only detaches: the attach of that tab ends, the session was never ours to stop.
    await page.getByRole('button', { name: /gamma-review 터미널 닫기/ }).click();
    await page.waitForTimeout(1000);
    check(
      JSON.stringify(attachIds()) === JSON.stringify(['a0000016']),
      'x on a tab ends only its attach (a0000017); the other stays',
    );
    await page.getByRole('button', { name: /beta-task 터미널 닫기/ }).click();
    await page.locator('.xterm-rows').waitFor({ state: 'detached' });
    await page.waitForTimeout(1000);
    check(attachIds().length === 0, 'TC-154: closing the last tab ends the attach process');
    // A background row without a pid (killed by a reboot): attach would resume it.
    await openConversation(page, 'old-job');
    await messenger
      .getByRole('region', { name: 'old-job 대화' })
      .getByRole('button', { name: '터미널로 보기' })
      .click();
    await page.getByRole('button', { name: '메신저 닫기' }).click();
    await waitForTerm(page, '지금 열 수 있는 백그라운드 세션이 아니에요');
    check(
      attachIds().length === 0,
      'old-job (no pid) is refused in Korean and no attach runs for it',
    );
    await shot(page, 'desktop-refused-no-pid');
    await page.getByRole('button', { name: /old-job 터미널 닫기/ }).click();
    await desk.close();
    await stop();
    const chatLog = serverLog.join('').match(/\[cld\] chat: .*/g) ?? [];
    check(
      chatLog.filter((l) => l.includes(' attach "')).length === 5 &&
        chatLog.filter((l) => l.includes(' detach "')).length === 5 &&
        chatLog.filter((l) => l.includes('refused')).length === 2 &&
        chatLog.some((l) => l.includes('refused "a0000017"')) && // the cap
        chatLog.some((l) => l.includes('refused "a0000018"')) &&
        chatLog.some((l) => l.includes('gui:ios')) &&
        chatLog.some((l) => l.includes('gui:android')),
      'one log line per attach/detach with gui:<device> and the time',
    );
    check(
      !serverLog.join('').includes('hello') && !serverLog.join('').includes('iphone13'),
      'the log has no terminal content',
    );
    fs.writeFileSync(path.join(OUT, 'chat-log.txt'), `${chatLog.join('\n')}\n`);

    // ════ C. without --allow-chat ════
    const { ctx: offCtx, page: off } = await open(DESKTOP);
    await off.goto(await start(a, []));
    await off.waitForURL(BASE);
    await ready(off, 'beta-task');
    await select(off, 'beta-task', false);
    check(
      (await off.getByRole('menuitem', { name: '대화' }).count()) === 0 &&
        (await off.getByRole('button', { name: '대화 열기' }).count()) === 0 &&
        (await off.locator('a[href*="claude.ai"]').count()) === 0,
      'TC-154: without --allow-chat there is no 대화, no 대화 열기 and no claude.ai link',
    );
    await shot(off, 'desktop-chat-off');
    const cookie = (await offCtx.cookies()).find((c) => c.name === 'cld_session');
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/cld/attach/a0000016`, {
        headers: { cookie: `cld_session=${cookie?.value ?? ''}` },
      });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('open', () => resolve(101));
      ws.once('error', () => undefined);
    });
    check(status === 404, `TC-151: the attach route answers ${status} when chat is off`);
    await offCtx.close();
  } finally {
    await browser.close();
    await stop();
    let log = serverLog.join('').replace(/code=[^\s&]+/g, 'code=<redacted>');
    for (const h of homes) {
      log = log.replaceAll(h.home, '<fake-home>');
      fs.rmSync(h.home, { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(OUT, 'server.log'), log);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

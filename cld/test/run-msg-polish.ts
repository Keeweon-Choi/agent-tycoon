/**
 * MSG-POLISH (owner 11-01 02:55): (1) tapping the reply chip above the text box shows the
 * original message as a peek over the composer, on a phone with its keyboard up and on desktop,
 * without losing the draft or the keyboard; (2) messages from before a handoff read as the
 * previous session, apart from job notices and system lines.
 *
 * The phone is WebKit with an iPhone 13 profile (Home-Screen app, 390x797 of 844); its software
 * keyboard is emulated the way run-phone-clip.ts does (a visualViewport that shrinks while the
 * layout viewport stays, iOS's pan drawn as a shift, a grey box for the keys).
 *
 *   npx tsx cld/test/run-msg-polish.ts <port 18262|18263> [--stage before|after]
 *
 * Screenshots go to cld/artifacts/msg-polish/<stage>-*.png. Exits 1 when a check failed (the
 * `before` stage is expected to fail the peek checks: that is what it documents).
 */
import type { Browser, BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
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

const port = sparePort();
const stageArg = process.argv.indexOf('--stage');
const STAGE = stageArg > 0 ? process.argv[stageArg + 1] : 'after';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/msg-polish');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const HANGUL = 'unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3;';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__polish/malgun.ttf'); ${HANGUL} }`;
const DEADLINE_MS = 300_000;
const IOS_KEYBOARD_PX = 367;
const DRAFT = '이 부분은 이렇게 고쳐 줘';
const TARGET_LAST_LINE = '14번째 줄: 계획의 마지막 항목';
const TARGET_FIRST = '계획서 초안입니다';
const TARGET = `${TARGET_FIRST}\n${Array.from({ length: 14 }, (_, i) => `${i + 1}번째 줄: 계획의 ${i === 13 ? '마지막 항목' : '항목'}`).join('\n')}`;
const CLOCK = 3_600_000;

let failed = 0;
function check(ok: unknown, what: string): void {
  if (!ok) {
    failed++;
    console.log(`FAIL - ${what}`);
  } else console.log(`ok - ${what}`);
}

const iphone = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();

const notice = (summary: string, result?: string) =>
  `<task-notification>\n<task-id>b${summary.length}</task-id>\n<tool-use-id>toolu_${summary.length}</tool-use-id>\n<status>completed</status>\n<summary>${summary}</summary>${result ? `\n<result>${result}</result>` : ''}\n</task-notification>`;

/** Messages of the conversation; the first group is the previous session (an earlier transcript). */
function seed(file: string, dir: string): void {
  const rec = (i: number, role: 'user' | 'assistant', text: string, at: number) =>
    `${JSON.stringify({
      type: role,
      uuid: `${i.toString(16).padStart(8, '0')}-7000-4000-8000-000000000000`,
      timestamp: new Date(at).toISOString(),
      message:
        role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
    })}\n`;
  const E0 = Date.now() - 26 * CLOCK;
  const earlier: Array<['user' | 'assistant', string]> = [
    ['user', '어제 배포 계획을 세워 줘'],
    ['assistant', '배포 계획: 빌드, 시험, 올리기 순서로 갈게요.'],
    ['user', notice('Background command "npm run build" completed (exit code 0)')],
    ['assistant', '빌드가 끝났어요. 시험을 돌릴게요.'],
    ['user', '[agty 자동 복구] 세션을 다시 이었어요'],
    ['assistant', '인수인계 전 마지막 보고: 시험이 모두 통과했어요.'],
  ];
  fs.writeFileSync(
    path.join(dir, '0e0e0e0e-0000-4000-8000-000000000000.jsonl'),
    earlier.map(([role, text], i) => rec(0x9000 + i, role, text, E0 + i * 60_000)).join(''),
  );
  const T0 = Date.now() - 2 * CLOCK;
  const now: Array<['user' | 'assistant', string]> = [
    ['user', '이어서 문서를 정리해 줘'],
    ['assistant', '네, 이어서 정리할게요.'],
    ['user', notice('Agent "문서 점검" completed', '문서 12개를 확인했고 고칠 곳은 없어요.')],
    ['user', notice('Background command "npm test" completed (exit code 0)')],
    ['user', '[agty 자동 복구] 세션을 다시 이었어요'],
    ['user', `${TARGET}\n[\ucca8\ubd80] /tmp/20261101-090000-plan.png (image/png, 2 KB)`],
    ...Array.from({ length: 10 }, (_, i): ['user' | 'assistant', string] => [
      'assistant',
      `정리 ${i + 1}번째: 문서를 하나씩 확인하고 있어요.`,
    ]),
  ];
  fs.appendFileSync(
    file,
    now.map(([role, text], i) => rec(0xa000 + i, role, text, T0 + i * 60_000)).join(''),
  );
}

/** The iOS keyboard (see run-phone-clip.ts): both getters shrink, only visualViewport fires. */
async function keyboardUp(page: Page, screenH: number): Promise<number> {
  const keysTop = screenH - IOS_KEYBOARD_PX;
  await page.evaluate((h) => {
    const vv = window.visualViewport!;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => h });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => h });
    vv.dispatchEvent(new Event('resize'));
  }, keysTop);
  await page.waitForTimeout(600);
  return keysTop;
}
async function iosPan(page: Page, fieldBottom: number, keysTop: number): Promise<number> {
  const layoutBottom = await page.evaluate(() => document.documentElement.clientHeight);
  const pan = Math.max(0, Math.min(fieldBottom - keysTop, layoutBottom - keysTop));
  await page.evaluate(
    ({ pan, keysTop }) => {
      document.getElementById('root')!.style.transform = `translateY(${-pan}px)`;
      const k = document.createElement('div');
      k.style.cssText = `position:fixed;left:0;right:0;top:${keysTop}px;bottom:0;background:var(--color-text-muted);opacity:.85;z-index:2147483647;pointer-events:none`;
      document.body.appendChild(k);
    },
    { pan, keysTop },
  );
  return pan;
}

const row = (conv: Locator, text: string) =>
  conv.locator('[data-chat-id]').filter({ hasText: text }).first();

/** What a tap on the reply chip leads to, and the checks of the peek (after). */
async function peekChecks(
  page: Page,
  conv: Locator,
  label: string,
  tap: (l: Locator) => Promise<void>,
  keysTop?: number,
): Promise<void> {
  const chip = conv.getByTestId('reply-chip');
  const box = conv.getByRole('textbox', { name: '보낼 글' });
  const peek = page.getByTestId('quote-peek');
  const draftKept = async () => (await box.inputValue()) === DRAFT && (await chip.count()) === 1;
  const focused = () => box.evaluate((el) => el === document.activeElement);
  const target = row(conv, TARGET_FIRST);
  const scrollBefore = await conv.getByTestId('chat-scroll').evaluate((el) => el.scrollTop);

  await tap(chip.locator('button').first());
  await page.waitForTimeout(500);
  const shown = (await peek.count()) === 1;
  await page.screenshot({ path: path.join(OUT, `${STAGE}-${label}-chip-tapped.png`) });
  const scrollAfter = await conv.getByTestId('chat-scroll').evaluate((el) => el.scrollTop);
  console.log(
    `info - ${label}: tapping the chip ${shown ? 'opens a peek' : `shows no peek (list scrolled ${scrollAfter - scrollBefore} px)`}`,
  );
  check(shown, `${label}: tapping the reply chip opens the peek`);
  if (!shown) return;
  const text = await peek.innerText();
  check(
    text.includes(TARGET_LAST_LINE) && text.includes('plan.png') && /\d\d:\d\d/.test(text),
    `${label}: the peek holds the whole text (14th line), the file name and the time`,
  );
  check(
    await peek.getByTestId('quote-peek-text').evaluate((el) => el.scrollHeight >= el.clientHeight),
    `${label}: the peek's text area scrolls inside itself`,
  );
  check(await draftKept(), `${label}: the draft and the reply survive opening the peek`);
  check(await focused(), `${label}: the text box keeps the focus (the keyboard stays up)`);
  if (keysTop !== undefined) {
    const b = (await peek.boundingBox())!;
    const f = (await conv.getByTestId('reply-chip').boundingBox())!;
    check(
      b.y >= 0 && b.y + b.height <= f.y + 1 && f.y + f.height <= keysTop + 1,
      `${label}: the peek (${Math.round(b.y)}-${Math.round(b.y + b.height)}) lies on screen above the chip and the keys (${keysTop})`,
    );
  }
  await page.screenshot({ path: path.join(OUT, `${STAGE}-${label}-peek.png`) });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(
    (await peek.count()) === 0 && (await draftKept()),
    `${label}: Esc closes the peek, the draft stays`,
  );

  await tap(chip.locator('button').first());
  await peek.waitFor();
  // Beside the peek (its 12 px margin), inside the pane.
  const ob = (await peek.boundingBox())!;
  const out = { x: ob.x - 6, y: ob.y + ob.height / 2 };
  if (keysTop !== undefined) await page.touchscreen.tap(out.x, out.y);
  else await page.mouse.click(out.x, out.y);
  await page.waitForTimeout(300);
  check(
    (await peek.count()) === 0 && (await draftKept()),
    `${label}: a tap outside closes the peek, the draft stays`,
  );

  await tap(chip.locator('button').first());
  await peek.waitFor();
  await tap(peek.getByRole('button', { name: '원래 위치로' }));
  await page.waitForTimeout(1_500);
  const inView = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const list = el.closest('[data-testid="chat-scroll"]')!.getBoundingClientRect();
    return r.bottom > list.top && r.top < list.bottom;
  });
  check(
    (await peek.count()) === 0 && inView && (await draftKept()),
    `${label}: 원래 위치로 closes the peek and brings the original into view, the draft stays`,
  );
  await page.screenshot({ path: path.join(OUT, `${STAGE}-${label}-jumped.png`) });
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.writeFileSync(
    path.join(configDirectory(home), 'config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    {
      FAKE_TURN_MS: '600',
      SHELL: '/bin/sh',
    },
  );
  const server = daemon.child;
  const cleanup = () => {
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    cleanup();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { pid: number; sessionId: string; cwd: string; name: string };
  const sessionOf = (): Sess | null => {
    for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (s.name === 'alpha') return s;
      } catch {
        /* being written */
      }
    }
    return null;
  };

  const browsers: Browser[] = [];
  try {
    const font = fs.readFileSync(FONT);
    const url = await daemon.loginUrl();
    for (const end = Date.now() + 40_000; !sessionOf();) {
      if (Date.now() > end) throw new Error('the engine did not revive the session');
      await new Promise((r) => setTimeout(r, 300));
    }
    const s = sessionOf()!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    seed(file, path.dirname(file));
    await new Promise((r) => setTimeout(r, 4_000));

    let storage: BrowserContextOptions['storageState'];
    const open = async (
      ctxOpts: BrowserContextOptions,
      b: Browser,
      phone: boolean,
      top?: number,
    ) => {
      const ctx = await b.newContext({ ...ctxOpts, storageState: storage });
      await ctx.route('**/__polish/malgun.ttf', (route) =>
        route.fulfill({ body: font, contentType: 'font/ttf' }),
      );
      await ctx.addInitScript('window.__name = (f) => f; window.__AGENT_TYCOON_E2E = true;');
      if (phone)
        await ctx.addInitScript(
          "Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });",
        );
      const page = await ctx.newPage();
      await page.goto(storage ? `http://127.0.0.1:${port}/` : url);
      if (!storage) await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      if (phone)
        await page.addStyleTag({
          content: `:root { --cld-safe-top: ${top}px; --cld-safe-bottom: 34px; }`,
        });
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await page.locator('[data-testid="agent-overlay"]').first().waitFor();
      await page.waitForTimeout(1_500);
      storage ??= await ctx.storageState();
      const toast = page.getByTestId('update-notice');
      if (await toast.count()) await toast.getByRole('button').last().click();
      const info = page.getByRole('button', { name: '정보 창 닫기' });
      if (await info.count()) await info.click();
      return page;
    };
    const openConversation = async (page: Page, phone: boolean) => {
      const tap = (l: Locator) => (phone ? l.tap() : l.click());
      if (phone) await tap(page.locator('[data-dock="messenger"]'));
      else await tap(page.getByRole('button', { name: /^메신저/ }));
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      await tap(
        messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }),
      );
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      await conv.getByText('정리 10번째').waitFor();
      return conv;
    };
    /** The previous session next to the job notices, in one picture. */
    const sessionShot = async (page: Page, conv: Locator, label: string) => {
      const scroll = conv.getByTestId('chat-scroll');
      // The earlier session is an older page: scroll up until the conversation holds it.
      for (let i = 0; i < 20 && !(await conv.getByText('어제 배포 계획').count()); i++) {
        await scroll.evaluate((el) => (el.scrollTop = 0));
        await page.waitForTimeout(400);
      }
      await scroll.evaluate((el) => (el.scrollTop = 0));
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, `${STAGE}-${label}-previous-session-top.png`) });
      await conv.getByTestId('session-divider').scrollIntoViewIfNeeded();
      await scroll.evaluate((el) => (el.scrollTop -= el.clientHeight / 4));
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `${STAGE}-${label}-previous-session-end.png`) });
    };
    const replyOnDesktop = async (page: Page, conv: Locator) => {
      const r = row(conv, TARGET_FIRST);
      await r.scrollIntoViewIfNeeded();
      await r.hover();
      await r.getByTestId('message-actions').first().getByRole('button', { name: '답글' }).click();
      await conv.getByTestId('reply-chip').waitFor();
      await conv.getByRole('textbox', { name: '보낼 글' }).fill(DRAFT);
    };

    // ════ Desktop ════
    const cr = await launchBrowser();
    browsers.push(cr);
    const desk = await open({ viewport: { width: 1400, height: 1000 } }, cr, false);
    const dconv = await openConversation(desk, false);
    await sessionShot(desk, dconv, 'desktop');
    if (STAGE !== 'before') {
      const start = dconv.getByTestId('session-start');
      const end = dconv.getByTestId('session-divider');
      check(
        (await start.count()) === 1 && (await end.count()) === 1,
        'desktop: the previous session has a band at its start and one at its end',
      );
      const [sb, eb] = await Promise.all([start.boundingBox(), end.boundingBox()]);
      const first = await row(dconv, '어제 배포 계획').boundingBox();
      const last = await row(dconv, '인수인계 전 마지막').boundingBox();
      const now = await row(dconv, '이어서 문서를 정리해 줘').boundingBox();
      check(
        sb &&
          eb &&
          first &&
          last &&
          now &&
          sb.y >= first.y &&
          sb.y < first.y + first.height &&
          eb.y > last.y &&
          eb.y + eb.height <= last.y + last.height + 1 &&
          last.y + last.height <= now.y,
        'desktop: start band, the earlier messages, end band, then the current session, in that order',
      );
      // Colours: the band, a previous-session message and every other system line kind, side by side.
      const tint = await dconv.evaluate(() => {
        const bg = (el: Element | null) => (el ? getComputedStyle(el).backgroundColor : '');
        const bd = (el: Element | null) => (el ? getComputedStyle(el).borderLeftColor : '');
        const prev = document.querySelector('[data-previous-session="true"]');
        const sys = document.querySelector('[data-from="system"]:not([data-previous-session] *)');
        const peer = document.querySelector(
          '[data-from="peer"]:not([data-previous-session] *) > div, [data-from="peer"]:not([data-previous-session] *)',
        );
        const job = document.querySelector(
          '[data-testid="shell-done"]:not([data-previous-session] *)',
        );
        return {
          prev: bg(prev) + '|' + bd(prev),
          band: bg(document.querySelector('[data-testid="session-start"]')),
          system: bg(sys) + '|' + (sys ? getComputedStyle(sys).color : ''),
          peer: bg(peer),
          job: job ? getComputedStyle(job).color : '',
        };
      });
      console.log(`info - desktop colours ${JSON.stringify(tint)}`);
      check(
        tint.band !== '' &&
          tint.band !== tint.peer &&
          tint.band !== tint.system.split('|')[0] &&
          tint.prev !== tint.system,
        'desktop: the previous-session band and tint differ from the job notice, the shell line and the system line',
      );
    }
    await replyOnDesktop(desk, dconv);
    await peekChecks(desk, dconv, 'desktop', (l) => l.click());
    await desk.context().close();

    // ════ Phone (WebKit, Home-Screen app, software keyboard) ════
    const wk = await launchBrowser({ webkit: true });
    browsers.push(wk);
    const SCREEN_H = 844;
    const phone = await open(
      {
        ...iphone,
        viewport: { width: 390, height: 797 },
        screen: { width: 390, height: SCREEN_H },
      },
      wk,
      true,
      47,
    );
    const pconv = await openConversation(phone, true);
    await sessionShot(phone, pconv, 'phone');
    // 답글 on a phone is the hold's sheet; the hidden desktop button runs the same action (WebKit has no CDP touch).
    const target = row(pconv, TARGET_FIRST);
    await target.scrollIntoViewIfNeeded();
    await target
      .locator('[data-testid="message-actions"] button', { hasText: '답글' })
      .first()
      .dispatchEvent('click');
    await pconv.getByTestId('reply-chip').waitFor();
    const pbox = pconv.getByRole('textbox', { name: '보낼 글' });
    await pbox.fill(DRAFT);
    await pbox.tap();
    const keysTop = await keyboardUp(phone, SCREEN_H);
    const fieldBottom = await pbox.evaluate((el) => el.getBoundingClientRect().bottom);
    await iosPan(phone, fieldBottom, keysTop);
    await phone.waitForTimeout(300);
    await peekChecks(phone, pconv, 'phone', (l) => l.tap(), keysTop);
    await phone.context().close();
  } finally {
    clearTimeout(deadline);
    for (const b of browsers) await b.close();
    await daemon.stop();
    cleanup();
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

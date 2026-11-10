/**
 * MSGQ (owner 11-04 23:51), end to end on the REAL API: dist/cli.js --engine on --allow-chat in a temp HOME
 * whose `claude` is the engine fake, headless Chromium (--disable-gpu), a 390x844 touch phone and a 1280x800
 * desktop. delta has a 300-item transcript the runner writes: a question ending in a question tag early on,
 * the same tag said again near the end, and a live one-line repeat.
 *  1. the contact list's last line has no tag text
 *  2. the repeat's chip jumps to the first ask (an older page that loads by itself) and outlines it
 *  3. the first ask's own chip only outlines it (the list does not scroll)
 * Screenshots in agent-tycoon/artifacts/feat-messenger-question-tags/.
 *
 *   npx tsx agent-tycoon/test/run-question-tags.ts <port 18650-18659>
 */
import type { Browser, BrowserContextOptions } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { transcriptPath } from '../../server/src/agent-tycoon/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (port < 18650 || port > 18659) throw new Error('port must be 18650-18659');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/feat-messenger-question-tags');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__nav/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const SAFE_AREA = ':root { --agty-safe-top: 47px !important; --agty-safe-bottom: 34px !important; }';
const DEADLINE_MS = 300_000;
const IPHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();
const TAG = '⟨q:deploy-order⟩';
const HISTORY = 300;
const FIRST = 40;
const REPEAT = 280;
const ASK = '배포 순서를 정해 주실래요?';

let oks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  oks++;
  console.log(`ok - ${what}`);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.writeFileSync(path.join(configDirectory(home), 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'delta');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'delta', folder, room: '개발실', wantRunning: true }]),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
    false,
  );
  const { child: server } = daemon;
  let browser: Browser | undefined;
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL'); // our own daemon only
    void browser?.close();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { pid: number; sessionId: string; cwd: string; name: string };
  const sessionFile = (): Sess | null => {
    for (const f of fs.readdirSync(sessions)) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (s.name === 'delta') return s;
      } catch {
        /* being written */
      }
    }
    return null;
  };
  const transcript = () => {
    const s = sessionFile()!;
    return transcriptPath(s.cwd, s.sessionId, home);
  };
  const rec = (i: number, role: 'user' | 'assistant', text: string, at: number) =>
    `${JSON.stringify(
      role === 'user'
        ? {
            type: 'user',
            uuid: `${i.toString(16).padStart(8, '0')}-6000-4000-8000-000000000000`,
            timestamp: new Date(at).toISOString(),
            message: { role, content: text },
          }
        : {
            type: 'assistant',
            uuid: `${i.toString(16).padStart(8, '0')}-6000-4000-8000-000000000000`,
            timestamp: new Date(at).toISOString(),
            message: { role, content: [{ type: 'text', text }] },
          },
    )}\n`;
  let live = 0;
  const say = (role: 'user' | 'assistant', text: string) =>
    fs.appendFileSync(transcript(), rec(0x70000 + ++live, role, text, Date.now()));

  try {
    const font = fs.readFileSync(FONT);
    for (const end = Date.now() + 40_000; !sessionFile(); ) {
      if (Date.now() > end) throw new Error('the engine did not revive the session');
      await wait(300);
    }
    const H0 = Date.now() - 2 * 3600_000;
    const text = (i: number) =>
      i === FIRST
        ? `배포 전에 정해야 할 게 있어요. ${ASK} ${TAG}`
        : i === REPEAT
          ? `다시 여쭤요: 배포 순서 ${TAG}`
          : `기록 ${i}번째 메시지`;
    {
      const file = transcript();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const liveText = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
      const lines = Array.from({ length: HISTORY }, (_, i) =>
        rec(i, i === FIRST || i === REPEAT || i % 2 ? 'assistant' : 'user', text(i), H0 + i * 10_000),
      );
      fs.writeFileSync(`${file}.tmp`, lines.join('') + liveText);
      fs.renameSync(`${file}.tmp`, file);
    }
    say('user', 'delta: 오늘 할 일 정리해 줘');
    say('assistant', 'delta 할 일을 정리할게요.');
    await wait(1_500);
    say('assistant', `한 줄로 다시: 배포 순서 ${TAG}`);
    await wait(4_000);

    browser = await launchBrowser();
    for (const [label, opts] of [
      ['phone', { ...IPHONE, viewport: { width: 390, height: 844 } }],
      ['desktop', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }],
    ] as const) {
      const touch = label === 'phone';
      const ctx = await browser.newContext(opts);
      await ctx.route('**/__nav/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
      const page = await ctx.newPage();
      const snap = (name: string) => page.screenshot({ path: path.join(OUT, `${label}-${name}.png`) });
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS + (touch ? SAFE_AREA : '') });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      const conv = messenger.getByRole('region', { name: 'delta 대화' });
      const scroller = conv.getByTestId('chat-scroll');
      const tapOn = (l: ReturnType<typeof conv.locator>) => (touch ? l.tap() : l.click());
      await tapOn(page.getByRole('button', { name: /^메신저($| \()/ }));
      const list = messenger.getByRole('list', { name: '연락처' });
      const delta = list.getByRole('button', { name: /^delta/ });
      await delta.waitFor();
      const listed = (await list.innerText()) + (await delta.getAttribute('aria-label') ?? '');
      check(listed.includes('배포 순서') && !listed.includes('q:'), `${label}: the contact's last line reads the summary without the tag`);
      await tapOn(delta);
      await conv.getByText('delta 할 일을 정리할게요.').waitFor();

      /** The row whose text holds the words, and whether it is outlined and inside the list. */
      const rowState = (words: string) =>
        scroller.evaluate((el, w) => {
          const row = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find((r) => r.textContent?.includes(w));
          if (!row) return null;
          const a = row.getBoundingClientRect();
          const b = el.getBoundingClientRect();
          return { focused: row.dataset.focused === 'true', inView: a.bottom > b.top && a.top < b.bottom, scrollTop: el.scrollTop };
        }, words);

      // 2. the live one-line repeat's chip goes to the first ask (not loaded yet)
      check((await rowState(ASK)) === null, `${label}: the first ask is not on the page before the tap`);
      const chips = conv.getByTestId('question-tag');
      check((await chips.count()) >= 1, `${label}: the repeat shows a chip, not the tag text`);
      check(!(await scroller.innerText()).includes('q:deploy-order'), `${label}: no tag text is drawn in the list`);
      await snap('1-repeat-chip');
      await tapOn(chips.last());
      let state = await rowState(ASK);
      for (const end = Date.now() + 15_000; !(state?.inView && state.focused); state = await rowState(ASK)) {
        if (Date.now() > end) {
          await snap('debug-no-jump');
          throw new Error(`no jump to the first ask ${JSON.stringify(state)}`);
        }
        await wait(150);
      }
      check(true, `${label}: the chip loaded the older page and went to the first ask, outlined`);
      await snap('2-at-first-ask');

      // 3. the first ask's own chip only outlines it
      await wait(4_500); // the outline ends
      const before = (await rowState(ASK))!;
      check(!before.focused, `${label}: the outline ended`);
      const own = scroller.locator('[data-chat-id]', { hasText: ASK }).getByTestId('question-tag');
      await tapOn(own);
      let after = await rowState(ASK);
      for (const end = Date.now() + 10_000; !after?.focused; after = await rowState(ASK)) {
        if (Date.now() > end) throw new Error('its own chip did not outline it');
        await wait(100);
      }
      check(Math.abs(after.scrollTop - before.scrollTop) <= 2, `${label}: its own chip outlined it without scrolling (${before.scrollTop} to ${after.scrollTop})`);
      await snap('3-own-chip');
      await ctx.close();
    }
    console.log(`${oks} checks passed`);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); // our own daemon only
    killFakeSessions(home);
    await wait(500);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

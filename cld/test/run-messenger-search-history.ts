/**
 * T-69, end to end on the REAL API: the messenger list's search also finds past conversation text.
 * dist/cli.js --engine on --allow-chat in a temp HOME whose `claude` is the engine fake, headless Chromium
 * (--disable-gpu) at 1600x1000 and Playwright's WebKit at the iPhone's 390x844. Two projects, alpha and delta,
 * hold the word: alpha twice (one old line past the first history page), delta (the newer match) more often than one conversation
 * lists, so the results show both the groups and the "more" note.
 *  1. typing the word (after a pause) shows a "대화 내용" group: one group per conversation, newest first (delta, then alpha),
 *     the snippet with the word marked
 *  2. clicking the old alpha hit opens alpha at that line: its own search bar holds the word, the marked
 *     word is on screen near the middle
 * Screenshots in cld/artifacts/feat-messenger-search-history/.
 *
 *   npx tsx cld/test/run-messenger-search-history.ts <port 18560-18569>
 */
import type { Browser, BrowserContextOptions } from '@playwright/test';
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
if (port < 18560 || port > 18569) throw new Error('port must be 18560-18569');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/feat-messenger-search-history');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__nav/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const SAFE_AREA = ':root { --cld-safe-top: 47px !important; --cld-safe-bottom: 34px !important; }';
const DEADLINE_MS = 300_000;
const TERM = '자두나무';
const HISTORY = 600;
const OLD = 40; // alpha's old line: far past the first history page
const NAMES = ['alpha', 'delta'] as const;
const IPHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();

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
  const folders = NAMES.map((name) => {
    const folder = path.join(home, 'work', name);
    fs.mkdirSync(folder, { recursive: true });
    return { name, folder, room: '개발실', wantRunning: true };
  });
  fs.writeFileSync(path.join(configDirectory(home), 'projects.json'), JSON.stringify(folders));
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const { child: server } = daemon;
  let browser: Browser | undefined;
  let webkitBrowser: Browser | undefined;
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL'); // our own daemon only
    void browser?.close();
    void webkitBrowser?.close();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { pid: number; sessionId: string; cwd: string; name: string };
  const sessionFile = (name: string): Sess | null => {
    for (const f of fs.readdirSync(sessions)) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (s.name === name) return s;
      } catch {
        /* being written */
      }
    }
    return null;
  };
  const transcript = (name: string) => {
    const s = sessionFile(name)!;
    return transcriptPath(s.cwd, s.sessionId, home);
  };
  const rec = (i: number, role: 'user' | 'assistant', text: string, at: number) =>
    `${JSON.stringify({
      type: role,
      uuid: `${i.toString(16).padStart(8, '0')}-6000-4000-8000-000000000000`,
      timestamp: new Date(at).toISOString(),
      message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
    })}\n`;

  try {
    const font = fs.readFileSync(FONT);
    for (const name of NAMES)
      for (const end = Date.now() + 40_000; !sessionFile(name); ) {
        if (Date.now() > end) throw new Error(`the engine did not revive ${name}`);
        await wait(300);
      }
    // History written before anything live (older times first), a rename so an open tail restarts.
    const H0 = Date.now() - 6 * 3600_000;
    const text = (name: string, i: number) => {
      if (name === 'alpha' && i === OLD) return `알파 ${i}번째: 예전에 ${TERM} 심기로 정했어요`;
      if (name === 'alpha' && i === HISTORY - 20) return `알파 ${i}번째: 오늘 ${TERM} 물을 줬어요`;
      if (name === 'delta' && i >= HISTORY - 60 && i % 10 === 0) return `델타 ${i}번째 ${TERM} 보고서 ${'가나다라마바사 '.repeat(8)}`;
      return `${name} 기록 ${i}번째 메시지`;
    };
    for (const name of NAMES) {
      const file = transcript(name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const live = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
      const lines = Array.from({ length: HISTORY }, (_, i) => rec(i, i % 2 ? 'assistant' : 'user', text(name, i), H0 + i * 20_000));
      fs.writeFileSync(`${file}.tmp`, lines.join('') + live);
      fs.renameSync(`${file}.tmp`, file);
    }
    fs.appendFileSync(transcript('alpha'), rec(0x70001, 'user', 'alpha: 오늘 할 일 정리해 줘', Date.now()));
    fs.appendFileSync(transcript('alpha'), rec(0x70002, 'assistant', 'alpha 할 일을 정리할게요.', Date.now()));
    await wait(4_000);

    browser = await launchBrowser();
    webkitBrowser = await launchBrowser({ webkit: true });
    for (const [label, engine, opts] of [
      ['pc', browser, { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 }],
      ['phone', webkitBrowser, { ...IPHONE, viewport: { width: 390, height: 844 } }],
    ] as const) {
      const touch = label === 'phone';
      const ctx = await engine.newContext(opts);
      await ctx.route('**/__nav/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
      const page = await ctx.newPage();
      const snap = (name: string) => page.screenshot({ path: path.join(OUT, `${label}-${name}.png`) });
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS + (touch ? SAFE_AREA : '') });
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      const tapOn = (l: ReturnType<typeof page.locator>) => (touch ? l.tap() : l.click());
      await tapOn(page.getByRole('button', { name: /^메신저($| \()/ }));
      await messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }).waitFor();

      // ════ 1. the list's search finds conversation text ════
      const find = messenger.getByRole('searchbox', { name: '대화 목록에서 찾기' });
      await find.fill(TERM);
      const all = messenger.getByTestId('search-all');
      await all.getByText('대화 내용', { exact: true }).waitFor();
      await all.getByRole('list').first().waitFor({ timeout: 15_000 });
      const groups = all.locator('[data-testid^="search-all-lead:"]');
      check((await groups.count()) === 2, `${label}: two conversations hold the word (${await groups.count()})`);
      const names = await groups.locator('strong').allTextContents();
      check(names.join() === 'delta,alpha', `${label}: newest match first: ${names.join()}`);
      const marked = await all.locator('mark').allTextContents();
      check(marked.length >= 3 && marked.every((m) => m === TERM), `${label}: the word is marked in ${marked.length} snippets`);
      check((await all.getByText('이 대화에 더 있어요').count()) === 1, `${label}: delta says it holds more than listed`);
      check((await all.getByTestId('search-all-cut').count()) === 1, `${label}: the cut note shows`);
      await snap('1-results');

      // ════ 2. a hit opens its conversation at that line ════
      const oldHit = groups.filter({ has: page.locator('strong', { hasText: /^alpha$/ }) }).getByRole('button').filter({ hasText: '예전에' });
      await tapOn(oldHit);
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      const scroller = conv.getByTestId('chat-scroll');
      await conv.getByRole('textbox', { name: '검색어' }).waitFor({ timeout: 15_000 });
      check((await conv.getByRole('textbox', { name: '검색어' }).inputValue()) === TERM, `${label}: the conversation's search bar holds the word`);
      for (const end = Date.now() + 20_000; ; await wait(150)) {
        const s = await scroller.evaluate((el) => {
          const mark = el.querySelector<HTMLElement>('mark.bg-search-current');
          if (!mark) return null;
          const list = el.getBoundingClientRect();
          const box = mark.getBoundingClientRect();
          return { inView: box.top >= list.top && box.bottom <= list.bottom, off: Math.abs(box.top + box.height / 2 - (list.top + list.height / 2)) / list.height, row: mark.closest('[data-chat-id]')?.textContent ?? '' };
        });
        if (s?.inView && s.off < 0.3 && s.row.includes('예전에')) {
          check(true, `${label}: the old line is marked and on screen (middle offset ${s.off.toFixed(2)})`);
          break;
        }
        if (Date.now() > end) {
          await snap('debug-no-jump');
          throw new Error(`check failed: ${label}: no jump ${JSON.stringify(s)}`);
        }
      }
      await snap('2-jump');
      await ctx.close();
    }
    console.log(`${oks} checks passed`);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await webkitBrowser?.close();
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

/**
 * CHAT-NAV (owner 11-04 19:54), end to end on the REAL API: dist/cli.js --engine on --allow-chat in a temp HOME
 * whose `claude` is the engine fake, headless Chromium (--disable-gpu), a 390x844 touch phone and a 1280x800
 * desktop. delta has a 320-item transcript (and an earlier session) the runner writes.
 *  1. loading older messages keeps the reader's row where it was (a few px), by script and by a touch swipe
 *  2. search ▲/▼ puts the marked word on screen, opens a folded long reply, shows a typing reply whole, and loads
 *     older pages first when the hit is not loaded
 *  3. the attachment viewer: one tap hides the title and buttons, the next shows them, a double tap still zooms
 * Screenshots in cld/artifacts/chat-nav-1104/.
 *
 *   npx tsx cld/test/run-chat-nav.ts <port 18530-18539>
 * Env: CHAT_NAV_CLI=<another build's cli.js> (negative control), CHAT_NAV_ONLY=prepend|search|viewer.
 */
import type { Browser, BrowserContextOptions, Locator } from '@playwright/test';
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
if (port < 18530 || port > 18539) throw new Error('port must be 18530-18539');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/chat-nav-1104');
const ONLY = process.env.CHAT_NAV_ONLY;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__nav/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const SAFE_AREA = ':root { --cld-safe-top: 47px !important; --cld-safe-bottom: 34px !important; }';
const DEADLINE_MS = 420_000;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=',
  'base64',
);
const IPHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();
const TERM = '자두나무';
const FOLDED = 100; // a long reply whose 12th sentence holds the word
const HISTORY = 1200;

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
    process.env.CHAT_NAV_CLI,
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

  type Sess = { pid: number; sessionId: string; cwd: string; name: string; jobId: string };
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
  const sentences = (n: number, extra: Record<number, string> = {}) =>
    Array.from({ length: n }, (_, i) => extra[i] ?? `${i + 1}번째 문장이에요.`).join(' ');
  let live = 0;
  const say = (role: 'user' | 'assistant', text: string) =>
    fs.appendFileSync(transcript(), rec(0x70000 + ++live, role, text, Date.now()));

  // The fake session echoes whatever the messenger types into it, like run-messenger.
  const typedLog = path.join(home, 'fake-claude-typed.log');
  let answered = 0;
  const replier = setInterval(() => {
    if (!fs.existsSync(typedLog) || !sessionFile()) return;
    const all = fs.readFileSync(typedLog, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { text: string });
    for (const t of all.slice(answered)) {
      const text = t.text.replaceAll('\r', '\n');
      say('user', text);
      say('assistant', `알겠어요: ${text.split('\n').slice(1).join(' ').slice(0, 40)}`);
    }
    answered = all.length;
  }, 300);

  try {
    const font = fs.readFileSync(FONT);
    for (const end = Date.now() + 40_000; !sessionFile(); ) {
      if (Date.now() > end) throw new Error('the engine did not revive the session');
      await wait(300);
    }
    // Written before anything live (older times first), a rename so an open tail restarts.
    const H0 = Date.now() - 2 * 3600_000;
    const text = (i: number) =>
      i === FOLDED
        ? `기록 ${i}번째 긴 답. ${sentences(12, { 11: `열두 번째 문장에 ${TERM} 이야기가 있어요.` })}`
        : [150, 220, 300].includes(i)
          ? `기록 ${i}번째: ${TERM} 진행 상황`
          : `기록 ${i}번째 메시지`;
    {
      const file = transcript();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const liveText = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
      const lines = Array.from({ length: HISTORY }, (_, i) =>
        rec(i, i === FOLDED || i % 2 ? 'assistant' : 'user', text(i), H0 + i * 10_000),
      );
      fs.writeFileSync(`${file}.tmp`, lines.join('') + liveText);
      fs.renameSync(`${file}.tmp`, file);
      fs.writeFileSync(
        path.join(path.dirname(file), '0e0e0e0e-0000-4000-8000-000000000000.jsonl'),
        Array.from({ length: 12 }, (_, i) =>
          rec(0x9000 + i, i % 2 ? 'assistant' : 'user', i === 3 ? `어제 ${TERM} 심은 이야기` : `어제 대화 ${i}`, H0 - 86_400_000 + i * 60_000),
        ).join(''),
      );
    }
    say('user', 'delta: 오늘 할 일 정리해 줘');
    say('assistant', 'delta 할 일을 정리할게요.');
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
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      const conv = messenger.getByRole('region', { name: 'delta 대화' });
      const scroller = conv.getByTestId('chat-scroll');
      const tapOn = (l: Locator) => (touch ? l.tap() : l.click());
      const openDelta = async () => {
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.addStyleTag({ content: FONT_CSS + (touch ? SAFE_AREA : '') });
        await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
        await tapOn(page.getByRole('button', { name: /^메신저($| \()/ }));
        await tapOn(messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^delta/ }));
        await conv.getByText('delta 할 일을 정리할게요.').waitFor();
      };
      /** The first row under the list's top edge and where it sits. */
      const firstRow = () =>
        scroller.evaluate((el) => {
          const top = el.getBoundingClientRect().top;
          const row = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find((r) => r.getBoundingClientRect().bottom > top + 1);
          return { id: row?.dataset.chatId ?? '', offset: row ? row.getBoundingClientRect().top - top : NaN, rows: el.querySelectorAll('[data-chat-id]').length, scrollTop: el.scrollTop };
        });
      const offsetOf = (id: string) =>
        scroller.evaluate((el, rowId) => {
          const row = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find((r) => r.dataset.chatId === rowId);
          return row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : NaN;
        }, id);
      const settle = async (rowsBefore: number) => {
        for (const end = Date.now() + 15_000; (await firstRow()).rows <= rowsBefore; ) {
          if (Date.now() > end) {
            await snap('debug-no-page');
            throw new Error(`no older page arrived ${JSON.stringify(await firstRow())}`);
          }
          await wait(100);
        }
        await wait(700);
      };

      // ════ 1. older messages keep the reader's place ════
      if (!ONLY || ONLY === 'prepend') {
        await openDelta();
        for (const how of ['script', 'script', 'swipe', 'swipe'] as const) {
          if (how === 'script') {
            // Read in the same task as the jump, before any page can land.
            const before = await scroller.evaluate((el) => {
              el.scrollTop = 0;
              const top = el.getBoundingClientRect().top;
              const row = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find((r) => r.getBoundingClientRect().bottom > top + 1);
              return { id: row?.dataset.chatId ?? '', offset: row ? row.getBoundingClientRect().top - top : NaN, rows: el.querySelectorAll('[data-chat-id]').length, scrollTop: el.scrollTop };
            });
            await settle(before.rows);
            const after = await offsetOf(before.id);
            check(
              Math.abs(after - before.offset) <= 4,
              `${label}: loading older messages keeps row ${before.id.slice(0, 8)} in place (${Math.round(before.offset)} px before, ${Math.round(after)} px after)`,
            );
          } else if (touch) {
            // A touch swipe down the list to its very top: the page lands while the finger just lifted.
            const box = (await scroller.boundingBox())!;
            const cdp = await ctx.newCDPSession(page);
            await wait(1_000); // no page still on its way
            await scroller.evaluate((el) => (el.scrollTop = 900));
            await wait(500);
            const mid = await firstRow();
            // The finger drags down in steps (the list scrolls up) and lifts: Chromium's own fling follows.
            const x = box.x + box.width / 2;
            let y = box.y + 80;
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            for (let moved = 0; moved < mid.scrollTop + 40; moved += 30) {
              y += 30;
              if (y > box.y + box.height - 20) {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                y = box.y + 80;
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
              }
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
              await wait(12);
            }
            // The finger stays down at the top while the page lands (as a reader waiting), jiggling a little.
            for (let i = 0; i < 40; i++) {
              y += i % 2 ? 2 : -2;
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
              await wait(30);
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await settle(mid.rows);
            const after = await offsetOf(mid.id);
            const now = await firstRow();
            check(
              now.scrollTop > 0 && Number.isFinite(after),
              `${label}: swipe to the top, the page lands, the reader is not thrown to the top (scrollTop ${Math.round(now.scrollTop)}, row ${mid.id.slice(0, 8)} at ${Math.round(after)} px)`,
            );
            await cdp.detach();
          }
        }
        await snap('1-older');
      }

      // ════ 2. search ▲/▼ goes straight to the marked word ════
      if (!ONLY || ONLY === 'search') {
        await openDelta();
        await tapOn(conv.getByRole('button', { name: '대화 검색' }));
        const field = conv.getByRole('textbox', { name: '검색어' });
        await field.fill(TERM);
        await field.press('Enter');
        await conv.getByText(/^1 \/ \d+$/).waitFor({ timeout: 15_000 });
        /** The marked word is on screen, near the middle of the list. */
        const markState = () =>
          scroller.evaluate((el) => {
            const mark = el.querySelector<HTMLElement>('mark.bg-search-current');
            if (!mark) return null;
            const list = el.getBoundingClientRect();
            const box = mark.getBoundingClientRect();
            const row = mark.closest('[data-chat-id]');
            return {
              inView: box.top >= list.top && box.bottom <= list.bottom,
              fromMiddle: Math.abs(box.top + box.height / 2 - (list.top + list.height / 2)) / list.height,
              open: row?.querySelector('[data-testid="fold-toggle"]')?.getAttribute('aria-expanded') ?? 'none',
            };
          });
        // `slack`: the newest line cannot be centred, the list ends under it.
        const onMark = async (what: string, slack = 0.3) => {
          for (const end = Date.now() + 15_000; ; await wait(150)) {
            const s = await markState();
            if (s?.inView && s.fromMiddle < slack) return check(true, `${label}: ${what} (middle offset ${s.fromMiddle.toFixed(2)})`);
            if (Date.now() > end) throw new Error(`check failed: ${label}: ${what} ${JSON.stringify(s)}`);
          }
        };
        await onMark('the newest hit is marked and on screen');
        const older = conv.getByRole('button', { name: '이전 검색 결과' });
        for (const n of [2, 3]) {
          await tapOn(older);
          await conv.getByText(new RegExp(`^${n} / \\d+$`)).waitFor({ timeout: 15_000 });
          await onMark(`step ${n} (not loaded before) puts the marked word on screen`);
        }
        await tapOn(older);
        await conv.getByText(/^4 \/ \d+$/).waitFor({ timeout: 15_000 });
        await onMark('the hit in a folded long reply is on screen');
        const folded = await markState();
        check(folded?.open === 'true', `${label}: that reply opened itself (aria-expanded ${folded?.open})`);
        await snap('2-folded-opened');
        await tapOn(conv.getByRole('button', { name: '다음 검색 결과' }));
        await conv.getByText(/^3 \/ \d+$/).waitFor({ timeout: 15_000 });
        await onMark('▼ goes back to the newer hit');
        await page.keyboard.press('Escape');

        // A live reply that is still typing in, its word beyond the fold: search shows it whole.
        const LIVE = `${label === 'phone' ? '마지막' : '끝자락'}두루미`;
        say('assistant', sentences(12, { 11: `열두 번째 문장에 ${LIVE} 가 있어요.` }));
        await conv.locator('[data-testid="dlg-typing"]').first().waitFor({ timeout: 10_000 });
        await tapOn(conv.getByRole('button', { name: '대화 검색' }));
        await field.fill(LIVE);
        await field.press('Enter');
        await conv.getByText(/^1 \/ 1$/).waitFor({ timeout: 15_000 });
        await onMark('a typing reply is shown whole and its word is on screen', 0.5);
        const typing = await conv.locator('[data-testid="dlg-typing"]').count();
        check(typing === 0, `${label}: nothing of that reply is still typing in (${typing})`);
        await snap('2-typing-whole');
        await page.keyboard.press('Escape');
      }

      // ════ 3. the viewer: one tap hides the bars, a double tap zooms ════
      if (!ONLY || ONLY === 'viewer') {
        await openDelta();
        const chooser = page.waitForEvent('filechooser');
        await tapOn(conv.getByRole('button', { name: '첨부', exact: true }));
        await (await chooser).setFiles({ name: `${label}.png`, mimeType: 'image/png', buffer: PNG });
        await conv.getByRole('textbox', { name: '보낼 글' }).fill('보기 시험');
        await tapOn(conv.getByRole('button', { name: '보내기', exact: true }));
        const thumb = conv.locator(`[title$="${label}.png"]`).first();
        await thumb.locator('img').waitFor({ timeout: 20_000 });
        await tapOn(thumb);
        const viewer = page.getByTestId('attach-viewer');
        await viewer.waitFor();
        const img = page.getByTestId('attach-img');
        await page.waitForFunction(() => (document.querySelector('[data-testid="attach-img"]') as HTMLElement | null)?.style.width !== '');
        const bars = page.locator('.attach-top');
        const shown = () => bars.evaluate((el) => getComputedStyle(el).visibility === 'visible');
        const scale = async () => Number(await img.getAttribute('data-scale'));
        const stage = (await page.getByTestId('attach-stage').boundingBox())!;
        const at = { x: stage.x + stage.width / 2, y: stage.y + stage.height * 0.35 };
        const tap = async (n: 1 | 2) => {
          for (let i = 0; i < n; i++) {
            if (touch) await page.touchscreen.tap(at.x, at.y);
            else await page.mouse.click(at.x, at.y);
            if (i + 1 < n) await wait(80);
          }
        };
        const fit = await scale();
        check(await shown(), `${label}: the viewer opens with its title and buttons`);
        await tap(1);
        await wait(700);
        check(!(await shown()) && (await scale()) === fit, `${label}: one tap hides the title and buttons and does not zoom`);
        await snap('3-bars-hidden');
        await tap(1);
        await wait(700);
        check(await shown(), `${label}: the next tap shows them again`);
        await tap(2);
        await wait(700);
        check((await scale()) > fit * 1.5 && (await shown()), `${label}: a double tap still zooms (${fit.toFixed(2)} to ${(await scale()).toFixed(2)}) and leaves the bars as they were`);
        await snap('3-zoomed');
        await page.getByTestId('attach-close').click();
      }
      await ctx.close();
    }
    console.log(`${oks} checks passed`);
  } finally {
    clearInterval(replier);
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

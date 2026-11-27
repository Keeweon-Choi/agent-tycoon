/**
 * T-108 (owner 11-11): the conversation of an agent that is off (Claude retired it for idleness)
 * is opened, a message is sent, and the engine resumes the session. End to end on the REAL API:
 * dist/cli.js --engine on --allow-chat in a temp HOME whose `claude` is the engine fake, headless
 * Chromium (--disable-gpu), a 390x844 touch phone and a 1280x800 desktop. delta has a long
 * transcript (a few tall replies in it) and `idleRetired`, so it is down until a message wakes it.
 *  1. opened off: the view is at the bottom and no 돌아가기 shows
 *  2. a message is sent, the session starts and its transcript flows in: still at the bottom
 *     (the newest line in view) and no 돌아가기, sampled every 50 ms the whole time
 *  3. a reader who scrolled up on purpose is not pulled down by new lines
 *  4. a search jump still offers 돌아가기, and it brings the reader back
 * Screenshots in agent-tycoon/artifacts/t0108/.
 *
 *   npx tsx agent-tycoon/test/run-fix-messenger-open-scroll-return.ts <port 19440-19449> [desktop|phone]
 * Env: T0108_CLI=<another build's cli.js> (negative control: a build of the base, kept under dist/ so
 *        it finds node_modules),
 *      T0108_ENTRY=notice (open by a notification's link naming an older reply, as push.ts does; the
 *        default opens from the contact list),
 *      T0108_FAST=1 (send 300 ms after opening, not 1.5 s; the notice entry is always fast),
 *      T0108_FORK=1 (the resumed session writes a file of its own).
 */
import type { Browser, BrowserContextOptions, Locator, Page } from '@playwright/test';
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
if (!(port >= 19440 && port <= 19449)) throw new Error('port must be 19440-19449');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/t0108');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0108/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const SAFE_AREA = ':root { --agty-safe-top: 47px !important; --agty-safe-bottom: 34px !important; }';
const DEADLINE_MS = 420_000;
const HISTORY = 400;
const TALL = [120, 250, 380]; // replies of twelve sentences: they fold, and their height settles late
const SESSION = 'a1b2c3d4-0000-4000-8000-00000000d108';
const FORK = 'f0f0f0f0-0000-4000-8000-00000000d108'; // T0108_FORK=1: the resumed session writes a file of its own
const NOTICE_ROW = 361; // T0108_ENTRY=notice: the reply a notification names (inside the first 80 rows the tail holds)
const SLACK = 48; // the list's own "at the bottom" (scrollJump.ts BOTTOM_SLACK_PX)
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

interface Sample {
  t: number;
  gap: number;
  scrollTop: number;
  scrollHeight: number;
  rows: number;
  back: boolean;
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.writeFileSync(path.join(configDirectory(home), 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'delta');
  fs.mkdirSync(folder, { recursive: true });
  const file = transcriptPath(folder, SESSION, home);
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
  const sentences = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}번째 문장이에요.`).join(' ');
  // Retired for idleness hours ago: the records are older than now.
  const H0 = Date.now() - 9 * 3600_000;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    Array.from({ length: HISTORY }, (_, i) =>
      rec(
        i,
        i % 2 ? 'assistant' : 'user',
        TALL.includes(i) ? `기록 ${i}번째 긴 답. ${sentences(12)}` : `기록 ${i}번째 메시지`,
        H0 + i * 10_000,
      ),
    ).join(''),
  );
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'delta', folder, room: '개발실', wantRunning: true, idleRetired: true, sessionId: SESSION }]),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
    false,
    process.env.T0108_CLI,
  );
  const { child: server } = daemon;
  let browser: Browser | undefined;
  let replier: NodeJS.Timeout | undefined;
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    clearInterval(replier);
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
  // The fake session echoes whatever the messenger types into it, like run-chat-nav.
  const typedLog = path.join(home, 'fake-claude-typed.log');
  let answered = 0;
  let live = 0;
  let liveFile = file;
  const say = (role: 'user' | 'assistant', text: string) =>
    fs.appendFileSync(liveFile, rec(0x70000 + ++live, role, text, Date.now()));
  const forkSession = () => {
    if (!process.env.T0108_FORK || liveFile !== file) return;
    for (const f of fs.readdirSync(sessions)) {
      const at = path.join(sessions, f);
      try {
        const s = JSON.parse(fs.readFileSync(at, 'utf-8')) as Sess;
        if (s.name !== 'delta') continue;
        liveFile = transcriptPath(folder, FORK, home);
        fs.writeFileSync(liveFile, ''); // the resumed session writes a file of its own; the history stays in the earlier one
        fs.writeFileSync(at, JSON.stringify({ ...s, sessionId: FORK }));
      } catch {
        /* being written */
      }
    }
  };
  replier = setInterval(() => {
    if (!fs.existsSync(typedLog) || !sessionFile()) return;
    forkSession();
    const all = fs.readFileSync(typedLog, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { text: string });
    for (const t of all.slice(answered)) {
      const text = t.text.replaceAll('\r', '\n');
      say('user', text);
      say("assistant", `알겠어요: ${text.split("\n").slice(1).join(" ").slice(0, 40)} ${sentences(12)}`);
    }
    answered = all.length;
  }, 300);

  try {
    const font = fs.readFileSync(FONT);
    browser = await launchBrowser();
    // One viewport per run: the session is awake after the first (argv[3]: desktop | phone).
    for (const [label, opts] of (
      [
        ['desktop', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }],
        ['phone', { ...IPHONE, viewport: { width: 390, height: 844 } }],
      ] as const
    ).filter(([l]) => l === (process.argv[3] ?? 'desktop'))) {
      const touch = label === 'phone';
      const ctx = await browser.newContext(opts);
      await ctx.route('**/__t0108/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
      const page = await ctx.newPage();
      const snap = (name: string) => page.screenshot({ path: path.join(OUT, `${process.env.T0108_ENTRY ?? 'list'}-${label}-${name}.png`) });
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      const conv = messenger.getByRole('region', { name: 'delta 대화' });
      const scroller = conv.getByTestId('chat-scroll');
      const tapOn = (l: Locator) => (touch ? l.tap() : l.click());
      await page.addStyleTag({ content: FONT_CSS + (touch ? SAFE_AREA : '') });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
      if (process.env.T0108_ENTRY === 'notice') {
        // A notification's link (push / toast) opens the conversation at the time of its event.
        // An older reply of the conversation (its id as the daemon makes it: `<ms>-<uuid8>-<n>`).
        const at = H0 + NOTICE_ROW * 10_000;
        const id = `${at}-${NOTICE_ROW.toString(16).padStart(8, '0')}-0`;
        await page.goto(`http://127.0.0.1:${port}/?open=chat&lead=delta&at=${at}&id=${id}`);
        await page.addStyleTag({ content: FONT_CSS + (touch ? SAFE_AREA : '') });
      } else {
        await tapOn(page.getByRole('button', { name: /^메신저($| \()/ }));
        await tapOn(messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^delta/ }));
      }
      await scroller.waitFor();
      await installSampler(page);
      await wait(process.env.T0108_ENTRY === 'notice' || process.env.T0108_FAST ? 300 : 1500);
      const state = () => stateOf(page);

      // ════ 1. opened while off ════
      const opened = await state();
      console.log(`${label} opened off: ${JSON.stringify(opened)}`);
      await snap('1-opened-off');
      check(!sessionFile(), `${label}: delta is off when its conversation is opened`);
      check(!opened.back, `${label}: opened off: no 돌아가기`);
      check(opened.gap <= SLACK, `${label}: opened off: at the bottom (${Math.round(opened.gap)} px from it)`);

      // ════ 2. a message, the session starts, its transcript flows in ════
      const box = conv.getByRole('textbox', { name: '보낼 글' });
      await box.fill(`일어나서 이것 좀 봐줘 ${label}`);
      if (touch) await tapOn(conv.getByRole('button', { name: '보내기', exact: true }));
      else await box.press('Enter');
      const sent = await state();
      console.log(`${label} just sent: ${JSON.stringify(sent)}`);
      for (const end = Date.now() + 40_000; !sessionFile(); ) {
        if (Date.now() > end) throw new Error('the engine did not wake the session');
        await wait(200);
      }
      await conv.locator("p").filter({ hasText: /알겠어요: .*일어나서/ }).first().waitFor({ timeout: 30_000 });
      await wait(3_000);
      const after = await state();
      console.log(`${label} after the session came up: ${JSON.stringify(after)}`);
      await snap('2-after-wake');
      const timeline: Sample[] = await page.evaluate(() => (window as unknown as { __t0108: Sample[] }).__t0108);
      let last = '';
      for (const s of timeline) {
        const key = `${s.rows}/${Math.round(s.gap)}/${s.back}`;
        if (key !== last) console.log(`  t=${s.t} rows=${s.rows} gap=${Math.round(s.gap)} scrollTop=${Math.round(s.scrollTop)} back=${s.back}`);
        last = key;
      }
      const worst = Math.max(...timeline.filter((s) => s.rows > 0).map((s) => s.gap));
      const back = timeline.filter((s) => s.back).length;
      console.log(`${label} timeline: ${timeline.length} samples, worst gap ${Math.round(worst)} px, 돌아가기 in ${back}`);
      check(back === 0, `${label}: no 돌아가기 at any sample from open to the session coming up`);
      check(after.gap <= SLACK, `${label}: at the bottom once the session is up (${Math.round(after.gap)} px from it)`);
      check(await newestInView(scroller), `${label}: the newest line is in view`);
      check(worst <= SLACK, `${label}: never more than ${SLACK} px from the bottom while it came up (worst ${Math.round(worst)})`);

      // ════ 2b. the session keeps writing: the view still follows ════
      for (let i = 0; i < 4; i++) {
        say('assistant', `계속 오는 줄 ${i}`);
        await wait(400);
      }
      await wait(1_000);
      const flowing = await state();
      check(
        flowing.gap <= SLACK && !flowing.back,
        `${label}: lines that keep coming are followed (${Math.round(flowing.gap)} px from the bottom)`,
      );

      // ════ 3. a reader who scrolled up on purpose stays ════
      // The row at the top of the view and where it sits: older pages may still land (they keep it in place).
      const firstRow = () =>
        scroller.evaluate((el) => {
          const top = el.getBoundingClientRect().top;
          const row = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find((r) => r.getBoundingClientRect().bottom > top + 1);
          return { id: row?.dataset.chatId ?? '', offset: row ? row.getBoundingClientRect().top - top : NaN };
        });
      const offsetOf = (id: string) =>
        scroller.evaluate((el, rowId) => {
          const row = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find((r) => r.dataset.chatId === rowId);
          return row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : NaN;
        }, id);
      await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
      await wait(2_000);
      const reading = await firstRow();
      say('assistant', '읽는 중에 온 새 줄');
      await wait(1500);
      const still = await offsetOf(reading.id);
      check(
        Math.abs(still - reading.offset) <= 4 && !(await state()).back,
        `${label}: a new line does not pull a reader who scrolled up (row ${reading.id.slice(-16)} ${Math.round(reading.offset)} -> ${Math.round(still)} px)`,
      );
      // ════ 4. a jump still offers the way back ════
      await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await wait(800);
      check(!(await state()).back && (await state()).gap <= SLACK, `${label}: back at the bottom, no 돌아가기, before the jump`);
      await tapOn(conv.getByRole('button', { name: '대화 검색' }));
      await conv.getByRole('textbox', { name: '검색어' }).fill('기록 300번째');
      const backButton = conv.getByTestId('jump-return');
      await backButton.waitFor({ timeout: 15_000 });
      await wait(800);
      const jumped = await state();
      await snap('4-jumped');
      check(jumped.gap > SLACK, `${label}: the search hit took the view off the bottom (${Math.round(jumped.gap)} px from it)`);
      await tapOn(backButton);
      await wait(1_500);
      const returned = await state();
      await snap('5-returned');
      check(!returned.back && returned.gap <= SLACK, `${label}: 돌아가기 brings the reader back to the bottom and goes (${Math.round(returned.gap)} px from it)`);
      await ctx.close();
    }
    console.log(`all ${oks} checks passed`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    clearInterval(replier);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Samples the list every 50 ms into window.__t0108, so a moment between two checks is not missed. */
async function installSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __t0108: Sample[] };
    w.__t0108 = [];
    const t0 = performance.now();
    window.setInterval(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="chat-scroll"]');
      if (!el) return;
      w.__t0108.push({
        t: Math.round(performance.now() - t0),
        gap: el.scrollHeight - el.scrollTop - el.clientHeight,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        rows: el.querySelectorAll('[data-chat-id]').length,
        back: !!document.querySelector('[data-testid="jump-return"]'),
      });
    }, 50);
  });
}

function stateOf(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="chat-scroll"]')!;
    return {
      t: 0,
      gap: el.scrollHeight - el.scrollTop - el.clientHeight,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      rows: el.querySelectorAll('[data-chat-id]').length,
      back: !!document.querySelector('[data-testid="jump-return"]'),
    };
  });
}

async function newestInView(scroller: Locator): Promise<boolean> {
  return scroller.evaluate((el) => {
    const last = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].at(-1);
    if (!last) return false;
    const box = el.getBoundingClientRect();
    const r = last.getBoundingClientRect();
    return r.bottom <= box.bottom + 1 && r.top < box.bottom;
  });
}

void main();

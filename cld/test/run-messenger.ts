/**
 * T-0043 visual check: the office messenger. dist/cli.js with --engine on
 * --allow-chat in an isolated HOME whose `claude` is the engine fake
 * (cld/test/fake-claude/engine.cjs; its attach is session-tui.cjs, the input
 * line the engine messenger types into), on a spare port. This runner plays
 * Claude: every message typed into a session (fake-claude-typed.log) becomes a
 * prompt and a reply in that session's transcript, which grows like a real one.
 *
 * Desktop: the contacts, three conversations as tabs, a send to an idle lead
 * (보냄, then 받음 and the reply), a send to a busy one (생각 중…, 보냄(대기
 * 중), still listed after a reload, then 지금 보내기 types it in while busy),
 * Ctrl+Enter (즉시 보내기) into a busy one, unread counts for a reply in a closed
 * conversation, drafts that survive closing, switching and a reload, and
 * 터미널로 보기. Phone (iPhone insets): the list, a conversation, the chips.
 * Records the daemon's RSS: idle, 4 conversations open, one terminal open.
 *
 * T-0060 (cld/artifacts/t0060, desktop 1280×800 and phone 393×852): delta has
 * a long current transcript (320 items before the live ones) and an earlier
 * session in the same folder. Scrolling to the top keeps loading older pages
 * down to the 이전 대화 divider; a search spans current pages and an earlier
 * session, highlights and steps through them; `/?open=chat&lead=delta&at=<old
 * time>` opens with that item in view and marked, and without `at` it stays
 * out of view.
 *
 *   npx tsx cld/test/run-messenger.ts <port 18256-18259>
 */
import type { Browser, BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0043');
const OUT_T0060 = path.join(REPO_ROOT, 'cld/artifacts/t0060');
const OUT_T0067 = path.join(REPO_ROOT, 'cld/artifacts/t0067');
const OUT_T0087 = path.join(REPO_ROOT, 'cld/artifacts/t0087');
const OUT_UIA = path.join(REPO_ROOT, 'cld/artifacts/ui-a');
const OUT_B1 = path.join(REPO_ROOT, 'cld/artifacts/ui-b1');
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=',
  'base64',
);
/** Full Chromium for the service worker (as in run-notices.ts). */
const FULL_CHROME =
  process.env.T0039_CHROME ??
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0043/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const SAFE_AREA = ':root { --cld-safe-top: 47px !important; --cld-safe-bottom: 34px !important; }';
const DEADLINE_MS = 480_000;
const LEADS = ['alpha', 'beta', 'gamma', 'delta'];
const IPHONE13 = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

const rssMb = (pid: number): number => {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf-8'));
    return m ? Math.round(Number(m[1]) / 1024) : 0;
  } catch {
    return 0;
  }
};
/** The daemon and every process under it (attach PTYs), MB. */
function treeRss(pid: number): { daemon: number; children: number } {
  const kids = (p: number): number[] =>
    (spawnSync('pgrep', ['-P', String(p)]).stdout ?? '')
      .toString()
      .split('\n')
      .filter(Boolean)
      .map(Number)
      .flatMap((k) => [k, ...kids(k)]);
  return { daemon: rssMb(pid), children: kids(pid).reduce((n, k) => n + rssMb(k), 0) };
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(OUT_T0060, { recursive: true });
  fs.mkdirSync(OUT_T0067, { recursive: true });
  fs.mkdirSync(OUT_T0087, { recursive: true });
  const { home, bin } = makeEngineHome();
  // Our own temp HOME: its daemon's port is the spare one, never the live daemon's.
  fs.writeFileSync(
    path.join(configDirectory(home), 'config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true }); // as on any machine Claude Code ran on: the engine watches it
  const folders = Object.fromEntries(LEADS.map((n) => [n, path.join(home, 'work', n)]));
  for (const f of Object.values(folders)) fs.mkdirSync(f, { recursive: true });
  // T-0037: an open engine conversation exposes project commands alongside built-ins.
  fs.mkdirSync(path.join(folders.alpha, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(folders.alpha, '.claude', 'commands', 'release.md'),
    '---\ndescription: 배포 전 확인해요\nargument-hint: <태그>\n---\n',
  );
  // Four engine projects that were on: the engine revives them at start.
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      LEADS.map((name, i) => ({
        name,
        folder: folders[name],
        room: i < 2 ? '개발실' : '연구실',
        wantRunning: true,
      })),
    ),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const { child: server, log: serverLog } = daemon;
  const loginUrl = daemon.loginUrl();
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  // ── Claude, played: sessions, transcripts, replies ──
  type Sess = { pid: number; sessionId: string; cwd: string; name: string; jobId: string };
  const sessionFile = (name: string): [string, Sess] | null => {
    for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (s.name === name) return [path.join(sessions, f), s];
      } catch {
        /* being written */
      }
    }
    return null;
  };
  const transcript = (name: string) => {
    const s = sessionFile(name)![1];
    return transcriptPath(s.cwd, s.sessionId, home);
  };
  const setStatus = (name: string, status: 'busy' | 'idle') => {
    const [file, s] = sessionFile(name)!;
    fs.writeFileSync(file, JSON.stringify({ ...s, status, statusUpdatedAt: Date.now() }));
  };
  let uuid = 0;
  const say = (name: string, role: 'user' | 'assistant', text: string) => {
    const file = transcript(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const timestamp = new Date().toISOString();
    fs.appendFileSync(
      file,
      `${JSON.stringify(
        role === 'user'
          ? { type: 'user', uuid: id, timestamp, message: { role, content: text } }
          : {
              type: 'assistant',
              uuid: id,
              timestamp,
              message: { role, content: [{ type: 'text', text }] },
            },
      )}\n`,
    );
  };
  const tool = (name: string, toolName: string, input: Record<string, unknown>) => {
    const id = `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    fs.appendFileSync(
      transcript(name),
      `${JSON.stringify({
        type: 'assistant',
        uuid: id,
        timestamp: new Date().toISOString(),
        message: { content: [{ type: 'tool_use', name: toolName, input }] },
      })}\n`,
    );
  };
  const typedLog = path.join(home, 'fake-claude-typed.log');
  const typed = () =>
    fs.existsSync(typedLog)
      ? fs
          .readFileSync(typedLog, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { id: string; text: string })
      : [];
  let answered = 0;
  const nameOfJob = (jobId: string) => LEADS.find((n) => sessionFile(n)?.[1].jobId === jobId);
  const replier = setInterval(() => {
    const all = typed();
    for (const t of all.slice(answered)) {
      const name = nameOfJob(t.id);
      if (!name) continue;
      const text = t.text.replaceAll('\r', '\n');
      say(name, 'user', text);
      const body = text.split('\n').slice(1).join(' ') || text;
      say(name, 'assistant', `알겠어요: ${body.slice(0, 40)}`);
    }
    answered = all.length;
  }, 300);

  let browser: Browser | undefined;
  let pushBrowser: Browser | undefined;
  const rss: Record<string, unknown> = {};
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  try {
    const font = fs.readFileSync(FONT);
    const url = await loginUrl;
    // The revive starts the four sessions 2 s apart.
    for (const end = Date.now() + 40_000; LEADS.some((n) => !sessionFile(n));) {
      if (Date.now() > end) throw new Error('the engine did not revive the sessions');
      await new Promise((r) => setTimeout(r, 300));
    }
    // T-0060: delta's long history (written before anything live, older times
    // first; a rename, so a tail already open restarts) and an earlier session.
    const H0 = Date.now() - 2 * 3600_000;
    const HISTORY = 320;
    const OLD_MARK = 20; // the item a notice url points at
    const histText = (i: number) =>
      i === OLD_MARK
        ? `기록 ${i}번째: 등대지기 이야기`
        : [150, 220, 300].includes(i)
          ? `기록 ${i}번째: 자두나무 진행 상황`
          : `기록 ${i}번째 메시지`;
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
    {
      const file = transcript('delta');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const live = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
      const lines = Array.from({ length: HISTORY }, (_, i) =>
        rec(i, i % 2 ? 'assistant' : 'user', histText(i), H0 + i * 10_000),
      );
      fs.writeFileSync(`${file}.tmp`, lines.join('') + live);
      fs.renameSync(`${file}.tmp`, file);
      const E0 = H0 - 24 * 3600_000;
      fs.writeFileSync(
        path.join(path.dirname(file), '0e0e0e0e-0000-4000-8000-000000000000.jsonl'),
        Array.from({ length: 12 }, (_, i) =>
          rec(
            0x9000 + i,
            i % 2 ? 'assistant' : 'user',
            i === 3 ? '어제 자두나무 심은 이야기' : `어제 대화 ${i}`,
            E0 + i * 60_000,
          ),
        ).join(''),
      );
    }
    const OLD_AT = H0 + OLD_MARK * 10_000;

    // A conversation so far, for each lead.
    for (const n of LEADS) {
      say(n, 'user', `${n}: 오늘 할 일 정리해 줘`);
      say(n, 'assistant', `${n} 할 일을 정리할게요.`);
      tool(n, 'Bash', {
        command: 'npm run build',
        ...(n === 'alpha' ? { description: '전체 빌드 결과 확인' } : {}),
      });
      tool(n, 'Read', { file_path: `/work/${n}/TODO.md` });
      say(
        n,
        'assistant',
        n === 'alpha'
          ? Array.from({ length: 20 }, (_, i) => `${i + 1}. 긴 답의 ${i + 1}번째 줄`).join('\n')
          : `${n}: 세 가지가 남았어요.`,
      );
    }
    await new Promise((r) => setTimeout(r, 6_000)); // the revive notices typed in and answered
    rss.idleNoViewer = treeRss(server.pid!);

    browser = await launchBrowser();
    const open = async (opts: BrowserContextOptions) => {
      const ctx = await browser!.newContext(opts);
      await ctx.route('**/__t0043/malgun.ttf', (route) =>
        route.fulfill({ body: font, contentType: 'font/ttf' }),
      );
      const page = await ctx.newPage();
      return { ctx, page };
    };
    const hangul = async (page: Page) => {
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    };

    // ════ Desktop ════
    const { ctx: desk, page } = await open({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 1,
    });
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await hangul(page);
    const hudButton = page.getByRole('button', { name: /^메신저/ });
    await hudButton.waitFor();
    await page.waitForTimeout(2_000);
    rss.viewerMessengerClosed = treeRss(server.pid!);
    await hudButton.click();
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    const contacts = messenger.getByRole('list', { name: '연락처' });
    for (const n of LEADS) await contacts.getByRole('button', { name: n }).waitFor();
    await contacts.getByText('beta: 세 가지가 남았어요.').waitFor();
    check(
      (await contacts.locator('li > button:first-child').count()) === 4 &&
        (await contacts.locator('[data-testid="lead-state"]').count()) === 4,
      'contacts: four leads with a state dot, the last message and its time',
    );
    await shot(page, 'desktop-contacts');

    // U-36: personal chats and group rooms are two sections with their own heading.
    {
      fs.mkdirSync(OUT_B1, { recursive: true });
      const direct = messenger.getByRole('heading', { name: '개인톡', exact: true });
      const groups = messenger.getByRole('region', { name: '단톡방', exact: true });
      const headings = await messenger.locator('h2').allTextContents();
      const order =
        headings.includes('개인톡') && headings.includes('단톡방')
          ? headings.indexOf('개인톡') < headings.indexOf('단톡방')
            ? 'direct first'
            : 'groups first'
          : 'missing';
      check(
        (await direct.count()) === 1 &&
          (await groups.getByRole('heading', { name: '단톡방' }).count()) === 1 &&
          (await groups.getByTestId('group-room-row-all').count()) === 1 &&
          (await groups
            .getByRole('button', { name: new RegExp(`^(${LEADS.join('|')})`) })
            .count()) === 0 &&
          (await contacts.locator('li > button:first-child').count()) === 4 &&
          order !== 'missing',
        `U-36: 개인톡 and 단톡방 are two sections (${order}); the four leads are in the first, the 전체 room in the second`,
      );
      await page.screenshot({ path: path.join(OUT_B1, 'u36-after-two-sections.png') });
    }

    // U-30: a pin keeps a conversation on top, newest first below it, and the daemon holds it.
    fs.mkdirSync(OUT_UIA, { recursive: true });
    const rows = () =>
      contacts
        .locator('li > button:first-child')
        .evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') ?? '').split(' ')[0]));
    const before30 = await rows();
    await page.screenshot({ path: path.join(OUT_UIA, 'u30-contacts-unpinned.png') });
    const lastRow = before30[before30.length - 1];
    await contacts
      .getByRole('button', { name: '즐겨찾기', exact: true })
      .last()
      .click({ timeout: 5_000 });
    await page.waitForTimeout(800);
    check(
      (await rows())[0] === lastRow &&
        (await rows()).slice(1).join() === before30.slice(0, -1).join(),
      `U-30: pinning the last conversation (${lastRow}) puts it on top, the rest keep their order`,
    );
    await page.screenshot({ path: path.join(OUT_UIA, 'u30-contacts-pinned.png') });
    await page.reload();
    await hudButton.waitFor();
    await hudButton.click();
    await contacts.getByRole('button', { name: new RegExp(`^${lastRow}`) }).waitFor();
    await page.waitForTimeout(800);
    check((await rows())[0] === lastRow, 'U-30: the pin survives a reload (the daemon keeps it)');
    await contacts.getByRole('button', { name: '즐겨찾기 해제', exact: true }).click();
    await page.waitForTimeout(800);
    check(
      (await rows()).join() === before30.join(),
      'U-30: unpinning puts it back in newest-first order',
    );

    const contact = (n: string) => contacts.getByRole('button', { name: new RegExp(`^${n}`) });
    const conv = (n: string) => messenger.getByRole('region', { name: `${n} 대화` });
    const tabs = messenger.getByRole('navigation', { name: '열린 대화' });
    for (const n of ['alpha', 'beta', 'gamma']) {
      await contact(n).click();
      await conv(n).getByText(`${n} 할 일을 정리할게요.`).waitFor();
    }
    check((await tabs.getByRole('tab').count()) === 3, 'three conversations open as tabs');
    await tabs.getByRole('tab', { name: /^alpha/ }).click();
    const alpha = conv('alpha');
    check(
      (await alpha.getByText('🔨 전체 빌드 결과 확인').count()) === 1 &&
        (await alpha.getByRole('button', { name: '더 보기' }).count()) === 1 &&
        !(await alpha.getByText('긴 답의 20번째 줄').isVisible()),
      'a conversation: the Bash description labels its tool line, and a long reply folds',
    );
    await alpha.locator('summary', { hasText: '전체 빌드 결과 확인' }).click();
    await alpha.getByText('Running: npm run build').first().waitFor();
    await alpha.getByRole('button', { name: '더 보기' }).click();
    await alpha.getByText('긴 답의 20번째 줄').waitFor();
    check(true, 'a tool line expands to its status; 더 보기 unfolds the long reply');
    await shot(page, 'desktop-conversation');

    // T-0115: even a small scroll away from the bottom freezes the reader's
    // view. The 96 px gap is deliberately less than a screen: the old
    // one-screen rule would follow the first new message and fail this check.
    // Start from the bottom, as a reader who has caught up (an earlier step may have left the view away from it).
    await alpha.getByTestId('chat-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll'));
    });
    for (let i = 1; i <= 12; i++) say('alpha', 'assistant', `alpha: 스크롤 여백 ${i}`);
    await alpha.getByText('alpha: 스크롤 여백 12', { exact: true }).waitFor({ timeout: 10_000 });
    const alphaScroller = alpha.getByTestId('chat-scroll');
    const scrollBefore = await alphaScroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight - el.clientHeight - 96;
      el.dispatchEvent(new Event('scroll'));
      return el.scrollTop;
    });
    const gapBefore = await alphaScroller.evaluate(
      (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
    );
    check(
      gapBefore > 48 && gapBefore < (await alphaScroller.evaluate((el) => el.clientHeight)),
      `jump control: the reader is ${Math.round(gapBefore)} px up, less than one screen`,
    );
    say('alpha', 'assistant', 'alpha: 새 메시지 하나');
    say('alpha', 'assistant', 'alpha: 새 메시지 둘');
    await alpha.getByText('alpha: 새 메시지 둘').waitFor({ timeout: 10_000 });
    const scrollAfter = await alphaScroller.evaluate((el) => el.scrollTop);
    const jumpNewest = alpha.getByTestId('jump-newest');
    check(
      Math.abs(scrollAfter - scrollBefore) < 1 &&
        (await jumpNewest.innerText()) === '새 메시지 2 ↓',
      'new messages leave a sub-screen scroll unchanged and show 새 메시지 2 ↓ (the old one-screen rule fails this)',
    );
    await jumpNewest.click();
    await jumpNewest.waitFor({ state: 'detached' });
    const reachedNewest = await alphaScroller.evaluate(async (el) => {
      for (let i = 0; i < 20; i++) {
        if (el.scrollHeight - el.clientHeight - el.scrollTop <= 48) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    });
    check(reachedNewest, 'the newest button reaches the bottom and clears the count');
    say('alpha', 'assistant', 'alpha: 바닥에서는 따라와요');
    await alpha.getByText('alpha: 바닥에서는 따라와요').waitFor({ timeout: 10_000 });
    check(
      (await alphaScroller.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop <= 48,
      )) && (await alpha.getByTestId('jump-newest').count()) === 0,
      'a new message at the bottom is followed',
    );

    // Send to an idle lead: typed in at once (보냄), then the transcript has it (받음).
    const box = alpha.getByRole('textbox', { name: '보낼 글' });
    // T-0111: the message box starts at one line, grows to 8 lines, scrolls past that, and shrinks after sending.
    {
      const height = async () => (await box.boundingBox())!.height;
      const lines = (n: number) => Array.from({ length: n }, (_, i) => `줄 ${i + 1}`).join('\n');
      const h1 = await height();
      await box.fill(lines(2));
      const h2 = await height();
      await box.fill(lines(8));
      const h8 = await height();
      await box.fill(lines(14));
      const h14 = await height();
      const lh = h2 - h1;
      check(
        lh > 8 && Math.abs(h8 - h1 - 7 * lh) <= 3 && Math.abs(h14 - h8) <= 1,
        `desktop: the message box is one line (${h1}), 8 lines at most (${h8}), and stays there at 14 (${h14})`,
      );
      check(
        await box.evaluate(
          (el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto',
        ),
        'desktop: past 8 lines the message box scrolls inside',
      );
      await shot(page, 't0111-composer-8');
      await box.fill('입력창 높이 확인');
      await box.press('Enter');
      await page.waitForTimeout(300);
      check(
        (await box.inputValue()) === '' && Math.abs((await height()) - h1) <= 1,
        `desktop: sending shrinks the message box back to one line (${await height()})`,
      );
      // The lead answers before the next send, so that one is not queued behind this turn.
      await alpha.getByText('알겠어요: 입력창 높이 확인').waitFor({ timeout: 20_000 });
    }

    // C2: the same words twice within one minute: each reply sits under its own message
    // (both carry that message's id), and the header of each ends with its own mark.
    {
      const SAME = '같은 분에 같은 글';
      if (new Date().getSeconds() > 40)
        await page.waitForTimeout((61 - new Date().getSeconds()) * 1000);
      const from = typed().length;
      for (let i = 1; i <= 2; i++) {
        await box.fill(SAME);
        await box.press('Enter');
        await alpha
          .locator('[data-chat-id]', { hasText: `알겠어요: ${SAME}` })
          .nth(i - 1)
          .waitFor({ timeout: 20_000 });
      }
      const sent = typed()
        .slice(from)
        .filter((t) => t.text.endsWith(`\r${SAME}`))
        .map((t) => /^\[사장 · 메신저 · ([^\]]+)\] ⟨m:([a-z2-7]{8})⟩\r/.exec(t.text));
      const rows = await alpha
        .locator('[data-chat-id]')
        .filter({ hasText: SAME })
        .evaluateAll((els) =>
          els.map((e) => [
            e.textContent?.includes('알겠어요') ? 'reply' : 'message',
            e.getAttribute('data-message-id'),
          ]),
        );
      const [a, b] = sent.map((m) => m?.[2]);
      check(
        sent.length === 2 &&
          sent.every(Boolean) &&
          sent[0]![1] === sent[1]![1] &&
          !!a &&
          !!b &&
          a !== b &&
          JSON.stringify(rows) ===
            JSON.stringify([
              ['message', a],
              ['reply', a],
              ['message', b],
              ['reply', b],
            ]) &&
          (await alpha.locator('[data-testid="pending"]').count()) === 0,
        `C2: two identical messages at ${sent[0]?.[1]} (marks ${a}, ${b}): each reply carries its own message's id (${JSON.stringify(rows)}), both 받음`,
      );
    }

    // U-37: a long message goes in as itself (Claude Code folds it into a paste placeholder, which
    // the typist takes for our paste); only above 20,000 characters the composer attaches it.
    {
      const LONG_END = '끝-마커-U37';
      const longText = `긴 글 시작 ${'가나다라마바사아자차카타파하 '.repeat(400)}${LONG_END}`;
      await box.fill(longText);
      await page.waitForTimeout(200);
      check(
        longText.length > 5_000 &&
          (await alpha.getByText('긴 글은 파일로 첨부해서 보내요').count()) === 0,
        `U-37: ${longText.length} characters in the composer show no attachment note`,
      );
      await page.screenshot({ path: path.join(OUT_B1, 'u37-after-long-message-composer.png') });
      const typedBefore = typed().length;
      await box.press('Enter');
      // The bubble folds a long text (더 보기), so find it by its start; the end is checked in the typed log.
      await alpha
        .locator('[data-chat-id]', { hasText: '긴 글 시작' })
        .first()
        .waitFor({ timeout: 30_000 });
      await alpha.getByText('받음').last().waitFor({ timeout: 30_000 });
      const sentLong = typed()
        .slice(typedBefore)
        .find((t) => t.text.includes(LONG_END));
      check(
        !!sentLong &&
          sentLong.text.length >= longText.length &&
          sentLong.text.includes('긴 글 시작'),
        `U-37: the whole ${longText.length} characters reached the session in one paste (${sentLong?.text.length ?? 0} typed)`,
      );
      check(
        (await alpha.getByText('전문은 첨부 파일').count()) === 0,
        'U-37: no preview-with-attachment message was made',
      );
      await page.screenshot({ path: path.join(OUT_B1, 'u37-after-long-message-sent.png') });
      await alpha.getByText('알겠어요: ').last().waitFor({ timeout: 30_000 });
      await box.fill('가'.repeat(20_050));
      await alpha.getByText('긴 글은 파일로 첨부해서 보내요 (20050자)').waitFor({ timeout: 5_000 });
      check(true, 'U-37: above 20,000 characters the composer still says it attaches the text');
      await box.fill('');
    }
    await alphaScroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight - el.clientHeight - 96;
      el.dispatchEvent(new Event('scroll'));
    });
    // T-0037: `/` asks the engine catalogue, Enter completes, then raw delivery
    // has no messenger header. `/clear` always asks before sending.
    await box.fill('/');
    const slashMenu = alpha.getByRole('listbox', { name: '/ 명령' });
    await slashMenu.getByText('/compact', { exact: true }).waitFor({ timeout: 10_000 });
    check(
      (await slashMenu.getByText('/release', { exact: true }).count()) === 1,
      '/ opens the menu with built-ins and the fixture project command',
    );
    await box.fill('/co');
    await slashMenu.getByText('/compact', { exact: true }).waitFor();
    await box.press('Enter');
    check((await box.inputValue()) === '/compact ', 'Enter inserts the selected slash command');
    await box.fill('/compact');
    const typedBeforeSlash = typed().length;
    await box.press('Enter');
    await alpha.getByText('알겠어요: /compact').waitFor({ timeout: 20_000 });
    const rawCompact = typed()
      .slice(typedBeforeSlash)
      .find((t) => t.text === '/compact');
    check(!!rawCompact, '/compact reaches the fake session without a header');
    await box.fill('/clear');
    await box.press('Enter');
    await alpha.getByRole('dialog', { name: '대화 비우기 확인' }).waitFor();
    check(
      typed().filter((t) => t.text === '/clear').length === 0,
      '/clear asks before it can reach the fake session',
    );
    await alpha.getByRole('button', { name: '취소' }).click();
    await box.fill('');
    // Nothing in the menu matches: Enter still sends, and the daemon says why it is no command.
    await box.fill('/zzz');
    await box.press('Enter');
    await alpha.getByText('모르는 명령이에요').first().waitFor({ timeout: 10_000 });
    check(
      typed().every((t) => t.text !== '/zzz'),
      'an unknown / command is refused with its reason and never typed',
    );
    await alpha.getByRole('button', { name: '지우기' }).click();
    await box.fill('');
    await box.fill('배포 상태 알려줘');
    await box.press('Enter');
    await alpha.locator('[data-chat-id]', { hasText: '배포 상태 알려줘' }).first().waitFor();
    check(
      await alphaScroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop <= 48),
      'sending always scrolls to the bottom',
    );
    await alpha.getByText('알겠어요: 배포 상태 알려줘').waitFor({ timeout: 20_000 });
    await alpha.getByText('받음').last().waitFor();
    const toAlpha = typed().find((t) => t.text.endsWith('배포 상태 알려줘'));
    check(
      /^\[사장 · 메신저 · \d\d-\d\d \d\d:\d\d\] ⟨m:[a-z2-7]{8}⟩\r배포 상태 알려줘$/.test(
        toAlpha?.text ?? '',
      ),
      `idle lead: typed in with the header "${toAlpha?.text.split('\r')[0]}", 받음, the reply follows`,
    );
    check(
      (await alpha.locator('[data-testid="pending"]').count()) === 0 &&
        (await alpha.getByText('[사장 · 메신저').count()) === 0,
      "the boss's bubble shows the text without the header",
    );
    await shot(page, 'desktop-sent-idle');

    // T-0067: button selection, clipboard image, the existing send queue and previews.
    const chooser = page.waitForEvent('filechooser');
    await alpha.getByRole('button', { name: '첨부', exact: true }).click();
    await (
      await chooser
    ).setFiles([
      { name: 'first.png', mimeType: 'image/png', buffer: PNG_BYTES },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('runner note') },
    ]);
    await box.evaluate((el, bytes) => {
      const data = new DataTransfer();
      data.items.add(
        new File([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], 'image.png', {
          type: 'image/png',
        }),
      );
      el.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
      );
    }, PNG_BYTES.toString('base64'));
    check(
      (await alpha
        .locator('[aria-label="첨부 파일"]')
        .locator('[data-state="pending"]')
        .count()) === 3,
      'button and paste create three pending chips',
    );
    await box.fill('첨부 테스트');
    await page.screenshot({ path: path.join(OUT_T0067, 'desktop-chips.png') });
    await alpha.getByRole('button', { name: '보내기' }).click();
    for (const end = Date.now() + 20_000; !typed().some((t) => t.text.includes('첨부 테스트'));) {
      if (Date.now() > end) throw new Error('attachment send did not reach fake session');
      await page.waitForTimeout(200);
    }
    const sentAttachment = typed()
      .find((t) => t.text.includes('첨부 테스트'))!
      .text.replaceAll('\r', '\n');
    const paths = [...sentAttachment.matchAll(/^\[첨부\] (.+?) \([^\n]+\)$/gm)].map(
      (match) => match[1],
    );
    check(
      paths.length === 3 &&
        paths.every(
          (file) =>
            file.startsWith(path.join(folders.alpha, '.cld-inbox') + path.sep) &&
            fs.existsSync(file),
        ),
      'fake session received three attachment paths, all present in the project inbox',
    );
    // The boss's bubble, not the fake session's echo of it (알겠어요: …).
    const attachmentBubble = alpha
      .locator('[data-chat-id]', { hasText: '첨부 테스트', hasNotText: '알겠어요' })
      .last();
    await attachmentBubble.locator('img').first().waitFor({ timeout: 10_000 });
    check(
      (await attachmentBubble.locator('img').count()) === 2 &&
        (await attachmentBubble.getByText('notes.txt').count()) === 1,
      'bubble shows two image thumbnails and one file chip',
    );
    await page.screenshot({ path: path.join(OUT_T0067, 'desktop.png') });
    const tooLarge = page.waitForEvent('filechooser');
    await alpha.getByRole('button', { name: '첨부', exact: true }).click();
    await (
      await tooLarge
    ).setFiles({
      name: 'huge.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(21 * 1024 * 1024),
    });
    await box.fill('큰 첨부는 전송하지 않음');
    const beforeLarge = typed().length;
    await alpha.getByRole('button', { name: '보내기' }).click();
    await page.waitForTimeout(700);
    check(
      (await alpha.getByText('파일은 20 MB 이하만 첨부할 수 있어요').count()) === 1 &&
        typed().length === beforeLarge,
      '21 MB attachment is refused and sends no message',
    );
    await alpha.getByRole('button', { name: 'huge.txt 첨부 제거' }).click();
    await box.fill('');

    // A busy lead: 생각 중…, then 보냄(대기 중), delivered when the turn ends.
    await tabs.getByRole('tab', { name: /^beta/ }).click();
    const beta = conv('beta');
    // A turn running: its prompt is the transcript's newest record (a busy status
    // alone, with the turn over in the transcript, counts as idle: background work).
    say('beta', 'user', '빌드 다시 돌려 줘');
    setStatus('beta', 'busy');
    await beta.getByTestId('typing').waitFor({ timeout: 10_000 });
    check(true, 'typing indicator: 생각 중… while the turn is busy');
    const dots = beta.locator('[data-testid="typing"] .thinking-dots');
    // U-34: the box keeps one width; the dots come 0, 1, 2, 3 one at a time (clip-path steps).
    const dotWidths: number[] = [];
    const dotClips: string[] = [];
    for (let i = 0; i < 9; i++) {
      dotWidths.push(Math.round((await dots.boundingBox())?.width ?? 0));
      dotClips.push(await dots.evaluate((el) => getComputedStyle(el).clipPath));
      await page.waitForTimeout(430);
    }
    check(
      new Set(dotWidths).size === 1 && dotWidths[0] > 0,
      `thinking dots keep one width while busy (${dotWidths.join(', ')})`,
    );
    check(
      new Set(dotClips).size === 4,
      `thinking dots show 0, 1, 2 and 3 dots (${new Set(dotClips).size} looks over ${dotClips.length} samples)`,
    );
    await beta.getByRole('textbox', { name: '보낼 글' }).fill('끝나면 테스트도 돌려줘');
    await beta.getByRole('button', { name: '보내기' }).click();
    await beta.getByText('보냄(대기 중)').waitFor({ timeout: 10_000 });
    check(
      !typed().some((t) => t.text.endsWith('끝나면 테스트도 돌려줘')),
      'busy lead: 보냄(대기 중), nothing typed in yet',
    );
    await shot(page, 'desktop-queued-busy');
    // A reload: the server still lists it as waiting, with 지금 보내기.
    await page.reload();
    await hangul(page);
    await hudButton.click();
    for (const n of ['alpha', 'beta', 'gamma']) await contact(n).click();
    await tabs.getByRole('tab', { name: /^beta/ }).click();
    const waiting = beta.locator('[data-testid="pending"]', { hasText: '끝나면 테스트도 돌려줘' });
    await waiting.getByText('보냄(대기 중)').waitFor({ timeout: 10_000 });
    check(
      (await waiting.getByRole('button', { name: '지금 보내기' }).count()) === 1 &&
        !typed().some((t) => t.text.endsWith('끝나면 테스트도 돌려줘')),
      'after a reload: the waiting message is back as 보냄(대기 중) with 지금 보내기',
    );
    await shot(page, 'desktop-queued-after-reload');
    // 지금 보내기: it goes in while the turn still runs (the fake draws esc to interrupt).
    await waiting.getByRole('button', { name: '지금 보내기' }).click();
    await beta.getByText('알겠어요: 끝나면 테스트도 돌려줘').waitFor({ timeout: 20_000 });
    check(
      typed().some((t) => t.text.endsWith('끝나면 테스트도 돌려줘')),
      '지금 보내기: typed in while busy, the reply follows',
    );
    // Ctrl+Enter (즉시 보내기) into a busy lead: typed at once.
    await beta.getByTestId('typing').waitFor({ state: 'detached', timeout: 10_000 });
    setStatus('beta', 'busy');
    await beta.getByTestId('typing').waitFor({ timeout: 10_000 });
    await beta.getByRole('textbox', { name: '보낼 글' }).fill('급한 거 먼저 봐줘');
    await beta.getByRole('textbox', { name: '보낼 글' }).press('Control+Enter');
    await beta.getByText('알겠어요: 급한 거 먼저 봐줘').waitFor({ timeout: 20_000 });
    check(
      typed().some((t) =>
        /^\[사장 · 메신저 · [^\]]+\] ⟨m:[a-z2-7]{8}⟩\r급한 거 먼저 봐줘$/.test(t.text),
      ),
      'Ctrl+Enter: 즉시 보내기 typed into the busy lead at once',
    );
    // T-0037c: a command is not a message to cut a turn for: Ctrl+Enter and the
    // send-now chord both wait for the turn's end, then it goes in without a header.
    say('beta', 'user', '로그 정리해 줘'); // a running turn: its prompt is the newest record
    setStatus('beta', 'busy');
    await beta.getByTestId('typing').waitFor({ timeout: 10_000 });
    const cmdBox = beta.getByRole('textbox', { name: '보낼 글' });
    const betaJob = sessionFile('beta')![1].jobId;
    await cmdBox.fill('/compact');
    await cmdBox.press('Control+Enter');
    const cmdBubble = beta.locator('[data-testid="pending"]', { hasText: '/compact' });
    await cmdBubble.getByText('보냄(대기 중)').waitFor({ timeout: 10_000 });
    check(
      (await cmdBubble.getByRole('button', { name: '지금 보내기' }).count()) === 0,
      'a waiting / command offers no 지금 보내기',
    );
    await page.waitForTimeout(2_500);
    check(
      (await cmdBubble.getByText('즉시').count()) === 0 &&
        !typed().some((t) => t.id === betaJob && t.text === '/compact'),
      'a / command sent with Ctrl+Enter during a turn waits (not 즉시) and is not typed',
    );
    await cmdBox.fill('/compact');
    await cmdBox.press('Control+x');
    await cmdBox.press('Control+s');
    await page.waitForTimeout(2_500);
    check(
      !typed().some((t) => t.id === betaJob && t.text === '/compact'),
      'a / command sent with the send-now chord during a turn is not typed either',
    );
    setStatus('beta', 'idle');
    await beta.getByText('받음').first().waitFor();
    await beta.getByText('알겠어요: /compact').first().waitFor({ timeout: 30_000 });
    check(
      typed().some((t) => t.id === betaJob && t.text === '/compact'),
      'the waiting / command goes in raw once the turn ends',
    );
    await beta
      .locator('[data-testid="pending"]')
      .first()
      .waitFor({ state: 'detached', timeout: 60_000 });
    await beta.getByTestId('typing').waitFor({ state: 'detached', timeout: 10_000 });
    check(
      (await beta.getByTestId('typing').count()) === 0 &&
        (await beta.locator('[data-testid="pending"]').count()) === 0,
      'busy lead: delivered (받음), the typing indicator and its dots stopped',
    );
    await shot(page, 'desktop-delivered-after-queue');

    // T-0117: while claude agents says beta waits on its terminal (blocked), a
    // boss bubble has not reached the Typist yet, so it can be replaced or
    // cancelled before the terminal is answered.
    const blockedFile = path.join(home, `fake-blocked-${sessionFile('beta')![1].jobId}`);
    fs.writeFileSync(blockedFile, '');
    const betaBox = beta.getByRole('textbox', { name: '보낼 글' });
    await betaBox.fill('확인 끝나면 배포해 줘');
    await betaBox.press('Control+x');
    await betaBox.press('Control+s');
    const heldBubble = beta.locator('[data-testid="pending"]', {
      hasText: '확인 끝나면 배포해 줘',
    });
    await heldBubble.getByText('보냄(대기 중) · 즉시').waitFor({ timeout: 10_000 });
    await beta.getByTestId('held-note').waitFor({ timeout: 15_000 });
    check(
      (await betaBox.inputValue()) === '' &&
        !typed().some((t) => t.text.endsWith('확인 끝나면 배포해 줘')) &&
        (await contact('beta').getByText('확인이 필요해요').count()) === 1,
      'blocked lead: Ctrl+X Ctrl+S queued as 즉시, nothing typed, 확인이 필요해요 in the contact and the conversation',
    );
    await heldBubble.hover();
    await heldBubble.getByRole('button', { name: '수정' }).click();
    await betaBox.fill('확인 끝나면 테스트까지 배포해 줘');
    await betaBox.press('Enter');
    const editedBubble = beta.locator('[data-testid="pending"]', {
      hasText: '확인 끝나면 테스트까지 배포해 줘',
    });
    await editedBubble.getByText('수정함').waitFor({ timeout: 10_000 });
    check(
      (await editedBubble.getByText('확인 끝나면 테스트까지 배포해 줘').count()) === 1 &&
        !typed().some((t) => t.text.endsWith('확인 끝나면 배포해 줘')),
      'held lead: 수정 replaces the pending bubble; the old text never reached the fake session',
    );
    await shot(page, 'desktop-held-blocked');
    fs.rmSync(blockedFile);
    await beta.getByText('알겠어요: 확인 끝나면 테스트까지 배포해 줘').waitFor({ timeout: 60_000 });
    await beta.getByTestId('held-note').waitFor({ state: 'detached', timeout: 15_000 });
    check(
      typed().some((t) => t.text.endsWith('확인 끝나면 테스트까지 배포해 줘')) &&
        !typed().some((t) => t.text.endsWith('확인 끝나면 배포해 줘')),
      'blocked lead answered: only the edited text goes in, and the note leaves',
    );

    fs.writeFileSync(blockedFile, '');
    await betaBox.fill('이 말은 취소할 거예요');
    await betaBox.press('Enter');
    const cancelledBubble = beta.locator('[data-testid="pending"]', {
      hasText: '이 말은 취소할 거예요',
    });
    await cancelledBubble.getByText('보냄(대기 중)').waitFor({ timeout: 10_000 });
    // 10-24 02:48: 지금 보내기 · 수정 · 취소 stay shown under a queued message, without hover or long press.
    const shown = async (name: string) =>
      cancelledBubble
        .getByRole('button', { name, exact: true })
        .evaluate(
          (b) =>
            b.getBoundingClientRect().width > 0 &&
            getComputedStyle(b.parentElement!).opacity === '1',
        );
    check(
      (await shown('지금 보내기')) && (await shown('수정')) && (await shown('취소')),
      'queued message: 지금 보내기, 수정 and 취소 are shown without hover',
    );
    await cancelledBubble.hover();
    await cancelledBubble.getByRole('button', { name: '취소', exact: true }).click();
    await page.waitForTimeout(1_500);
    fs.mkdirSync(OUT_UIA, { recursive: true });
    await page.screenshot({ path: path.join(OUT_UIA, 'u25-after-cancel.png') });
    await cancelledBubble.waitFor({ state: 'detached', timeout: 10_000 }); // U-25: a cancelled message is not shown
    fs.rmSync(blockedFile);
    await page.waitForTimeout(2_500);
    check(
      !typed().some((t) => t.text.endsWith('이 말은 취소할 거예요')),
      'held lead: 취소 hides the bubble (U-25) and nothing reaches the fake session',
    );

    // Unread: a reply in a closed conversation.
    await tabs.getByRole('button', { name: 'gamma 대화 닫기' }).click();
    say('gamma', 'assistant', 'gamma: 리뷰 끝났어요. 확인해 주세요.');
    await contacts.getByRole('button', { name: 'gamma 안 읽음 1' }).waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: '메신저 (안 읽음 1)' }).waitFor();
    check(
      (await contacts.locator('li > button:first-child').first().getAttribute('aria-label')) ===
        'gamma 안 읽음 1',
      'unread: the closed conversation counts 1, sorts first, the 메신저 tab shows it',
    );
    const toast = page.getByTestId('notice-toast');
    await toast.filter({ hasText: 'gamma' }).waitFor({ timeout: 10_000 });
    check(
      (await toast.innerText()).includes('💬') &&
        (await toast.innerText()).includes('gamma: 리뷰 끝났어요') &&
        (await page.getByTestId('notice-bell').count()) === 1,
      `T-0039: the reply is a 💬 notice ("${(await toast.innerText()).replace(/\s+/g, ' ')}"), the bell beside the 메신저 tab`,
    );
    await shot(page, 'desktop-unread');
    // A click on the notice opens that lead's conversation (10-22 01:3x).
    await toast.click();
    await conv('gamma').getByText('gamma: 리뷰 끝났어요. 확인해 주세요.').waitFor();
    check(
      (await tabs.getByRole('tab', { name: /^gamma/ }).getAttribute('aria-selected')) === 'true',
      "a click on the reply's notice opens gamma's conversation",
    );
    await page.getByRole('button', { name: '메신저', exact: true }).waitFor();
    check(
      (await contacts.getByRole('button', { name: 'gamma', exact: true }).count()) === 1,
      'opening it marks it read',
    );

    // A turn end with the messenger closed: its notice opens the conversation; the
    // bell's list keeps it unread until clicked, 모두 읽음 clears the badge.
    await page.getByRole('button', { name: '메신저 닫기' }).click();
    type Kept = { id: string; name: string; cause: string; read: boolean };
    const deltaNotices = () =>
      page.evaluate(() =>
        (JSON.parse(localStorage.getItem('cld.notices') ?? '[]') as Kept[]).filter(
          (n) => n.name === 'delta',
        ),
      );
    const before = new Set((await deltaNotices()).map((n) => n.id));
    say('delta', 'assistant', 'delta: 정리 끝났어요.');
    fs.appendFileSync(
      transcript('delta'),
      `${JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1000, timestamp: new Date().toISOString() })}\n`,
    );
    // Its notice (the toast may already show another lead's by now): in the bell's list.
    const freshDelta = async () => (await deltaNotices()).filter((n) => !before.has(n.id));
    for (const end = Date.now() + 20_000; !(await freshDelta()).length;) {
      if (Date.now() > end) throw new Error('no notice for delta');
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(4_000); // a turn end and its reply arrive apart; they pair into one
    const added = await freshDelta();
    const bell = page.getByTestId('notice-bell');
    await bell.click();
    const items = page.getByTestId('notice-item');
    const deltaItems = items.filter({ hasText: 'delta' });
    check(
      added.length === 1 &&
        added[0].cause === 'reply' &&
        !added[0].read &&
        (await deltaItems.first().getAttribute('data-read')) === 'false' &&
        (await page.getByTestId('notice-unread').count()) === 1,
      `delta's turn end and reply are one notice (${added.map((n) => n.cause).join(',')}), unread while the bell is open`,
    );
    await shot(page, 'desktop-bell');
    await deltaItems.first().click();
    await conv('delta').getByText('delta: 정리 끝났어요.').waitFor();
    check(true, "a click on delta's notice in the bell opens its conversation");
    await bell.click();
    check(
      (await items.filter({ hasText: 'delta' }).first().getAttribute('data-read')) === 'true',
      'the clicked notice is read',
    );
    say('gamma', 'assistant', 'gamma: 하나 더 있어요.');
    say('alpha', 'assistant', 'alpha: 저도요.');
    await page.getByRole('button', { name: '알림 닫기' }).click(); // the bell's panel
    await page.getByTestId('notice-unread').waitFor({ timeout: 15_000 });
    await bell.click();
    await page.getByTestId('notice-mark-all').click();
    await page.getByTestId('notice-unread').waitFor({ state: 'detached' });
    check(true, '모두 읽음 clears the bell badge');
    await page.getByRole('button', { name: '알림 닫기' }).click();

    // Drafts: kept when the conversation closes, on a switch, a closed messenger, a reload.
    await tabs.getByRole('tab', { name: /^alpha/ }).click();
    await alpha.getByRole('textbox', { name: '보낼 글' }).fill('나중에 보낼 메모');
    await tabs.getByRole('button', { name: 'alpha 대화 닫기' }).click();
    await contact('alpha').click();
    const draftNow = () => conv('alpha').getByRole('textbox', { name: '보낼 글' }).inputValue();
    check((await draftNow()) === '나중에 보낼 메모', 'draft: back after closing and reopening');
    await tabs.getByRole('tab', { name: /^beta/ }).click();
    await tabs.getByRole('tab', { name: /^alpha/ }).click();
    check((await draftNow()) === '나중에 보낼 메모', 'draft: back after switching away and back');
    await page.getByRole('button', { name: '메신저 닫기' }).click();
    await hudButton.click();
    await contact('alpha').click();
    check((await draftNow()) === '나중에 보낼 메모', 'draft: back after closing the messenger');
    await page.reload();
    await hangul(page);
    await hudButton.click();
    await contact('alpha').click();
    check((await draftNow()) === '나중에 보낼 메모', 'draft: back after a reload');
    await conv('alpha').getByRole('textbox', { name: '보낼 글' }).press('Enter');
    await conv('alpha').getByText('알겠어요: 나중에 보낼 메모').waitFor({ timeout: 20_000 });
    await tabs.getByRole('button', { name: 'alpha 대화 닫기' }).click();
    await contact('alpha').click();
    check((await draftNow()) === '', 'draft: cleared by sending');

    // Four conversations open: the RAM figure.
    for (const n of ['beta', 'gamma', 'delta']) await contact(n).click();
    await conv('delta').getByText('delta 할 일을 정리할게요.').waitFor();
    check((await tabs.getByRole('tab').count()) === 4, 'four conversations open');
    await page.waitForTimeout(4_000);
    rss.fourConversations = treeRss(server.pid!);
    await shot(page, 'desktop-four-tabs');
    // A fifth (there is none here): the cap is the unit tests'.

    // 터미널로 보기: the attach terminal, the heavy path.
    await tabs.getByRole('tab', { name: /^delta/ }).click();
    await conv('delta').getByRole('button', { name: '터미널로 보기' }).click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLElement>('.xterm-rows')].some((el) =>
          el.innerText.includes('fake Claude Code'),
        ),
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(3_000);
    rss.oneTerminal = treeRss(server.pid!);
    check(true, '터미널로 보기 opens the attach terminal as a tab of the terminal workspace');
    await shot(page, 'desktop-terminal');
    // T-0078: it is a tab of the terminal workspace; x detaches.
    await page
      .getByRole('button', { name: /터미널 닫기/ })
      .first()
      .click();
    await desk.close();

    // ════ T-0060: history, search, a notice's jump ════
    const history = async (label: string, opts: BrowserContextOptions) => {
      const { ctx, page: hp } = await open(opts);
      const snap = (name: string) =>
        hp.screenshot({ path: path.join(OUT_T0060, `${label}-${name}.png`) });
      const start = async (query = '') => {
        await hp.goto(`http://127.0.0.1:${port}/${query}`);
        await hangul(hp);
        if (opts.isMobile) await hp.addStyleTag({ content: SAFE_AREA });
        await hp.getByRole('button', { name: /^메신저($| \()/ }).waitFor();
      };
      await hp.goto(await daemon.loginUrl());
      await hp.waitForURL(`http://127.0.0.1:${port}/`);
      const hm = hp.getByRole('region', { name: '메신저', exact: true });
      const hd = hm.getByRole('region', { name: 'delta 대화' });
      const scroller = hd.getByTestId('chat-scroll');
      const openDelta = async () => {
        await start();
        await hp.getByRole('button', { name: /^메신저($| \()/ }).click();
        await hm
          .getByRole('list', { name: '연락처' })
          .getByRole('button', { name: /^delta/ })
          .click();
        await hd.getByText('delta 할 일을 정리할게요.').waitFor();
      };
      // A row that is not loaded yet is not in view.
      const inView = async (text: string) => {
        const rows = hd.locator('[data-chat-id]', { hasText: text });
        if ((await rows.count()) === 0) return false;
        return rows.evaluate((row) => {
          const box = row.getBoundingClientRect();
          const sc = row.closest('[data-testid="chat-scroll"]')!.getBoundingClientRect();
          return box.bottom > sc.top && box.top < sc.bottom;
        });
      };
      const marked = (text: string) =>
        hd
          .locator('[data-chat-id]', { hasText: text })
          .getAttribute('data-focused')
          .then((v) => v === 'true');

      // (1) Scrolling to the top keeps loading, down to the earlier session.
      await openDelta();
      // MSG-SCROLL-RUN: a minimized desktop messenger is display:none. Chromium
      // can lose its scroll offset while hidden, which must neither fetch older
      // pages nor move a reader away from their place.
      if (!opts.isMobile) {
        const messengerIcon = hp
          .locator('[data-hud-id="icon:messenger"]')
          .getByRole('button', { name: /^메신저/ });
        const bottomBefore = await scroller.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
          el.dispatchEvent(new Event('scroll'));
          return {
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            rows: el.querySelectorAll('[data-chat-id]').length,
          };
        });
        const minimize = hp
          .locator('[data-hud-window="messenger"]')
          .getByRole('button', { name: '최소화' });
        // The HUD icon closes an open messenger (a fresh mount on reopen); the
        // title-bar button minimizes it (display: none). Both must keep the place.
        for (let i = 1; i <= 6; i++) {
          await (i % 2 ? messengerIcon : minimize).click();
          await hp.waitForTimeout(300);
          await messengerIcon.click();
          await hp.waitForTimeout(500);
          const after = await scroller.evaluate((el) => ({
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            rows: el.querySelectorAll('[data-chat-id]').length,
          }));
          check(
            after.scrollHeight - after.scrollTop - after.clientHeight <= 48 &&
              after.rows === bottomBefore.rows,
            `desktop: ${i % 2 ? 'close/reopen' : 'minimize/show'} ${i} stays at the bottom and loads no older rows (${bottomBefore.scrollTop}/${bottomBefore.scrollHeight}, ${bottomBefore.rows} rows -> ${after.rows})`,
          );
        }
        const middleBefore = await scroller.evaluate((el) => {
          el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
          el.dispatchEvent(new Event('scroll'));
          const list = el.getBoundingClientRect();
          const row = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find(
            (item) => item.getBoundingClientRect().bottom > list.top,
          );
          return {
            id: row?.dataset.chatId ?? null,
            offset: row ? row.getBoundingClientRect().top - list.top : Number.NaN,
          };
        });
        await minimize.click();
        await hp.waitForTimeout(300);
        await messengerIcon.click();
        await hp.waitForTimeout(500);
        const middleAfter = await scroller.evaluate((el, id) => {
          const list = el.getBoundingClientRect();
          const row = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find(
            (item) => item.dataset.chatId === id,
          );
          const first = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find(
            (item) => item.getBoundingClientRect().bottom > list.top,
          );
          return {
            id: first?.dataset.chatId ?? null,
            offset: row ? row.getBoundingClientRect().top - list.top : Number.NaN,
          };
        }, middleBefore.id);
        check(
          middleBefore.id !== null &&
            middleAfter.id === middleBefore.id &&
            Math.abs(middleAfter.offset - middleBefore.offset) <= 8,
          `desktop: minimize/show keeps the middle row ${middleBefore.id} at ${Math.round(middleBefore.offset)} px (${Math.round(middleAfter.offset)} px after)`,
        );
      }
      const first = await hd.locator('[data-chat-id]').count();
      for (let i = 0; i < 40 && !(await hd.getByText('대화의 처음').count()); i++) {
        await scroller.evaluate((el) => (el.scrollTop = 0));
        await hp.waitForTimeout(400);
      }
      const all = await hd.locator('[data-chat-id]').count();
      const divider = hd.getByTestId('session-divider');
      check(
        first <= 80 && all > 80 && (await divider.count()) === 1,
        `${label}: scrolling up loads older pages (${first} → ${all} items), the 이전 대화 divider shows`,
      );
      const dividerText = (await divider.innerText()).trim();
      check(
        /^── 이전 대화 · \d+월 \d+일 \d\d:\d\d ──$/.test(dividerText) &&
          (await hd.getByText('어제 대화 0').count()) === 1 &&
          (await hd.getByText('대화의 처음').count()) === 1,
        `${label}: "${dividerText}", the earlier session above it, 대화의 처음 at the top`,
      );
      await divider.scrollIntoViewIfNeeded();
      await scroller.evaluate((el) => (el.scrollTop -= el.clientHeight / 3));
      await snap('1-divider');

      // (2) Search spans loaded pages and an earlier session. The newest hit is
      // selected first; ∧ loads/centres older pages, ∨ returns, and the result
      // list remains available for a direct jump.
      await openDelta();
      await hd.getByRole('button', { name: '대화 검색' }).click();
      const field = hd.getByRole('textbox', { name: '검색어' });
      await field.fill('자두나무');
      await field.press('Enter');
      await hd.getByText('1 / 4').waitFor({ timeout: 15_000 });
      const current = async (text: string) =>
        (await inView(text)) &&
        (await marked(text)) &&
        (await hd
          .locator('[data-chat-id]', { hasText: text })
          .locator('mark.bg-search-current')
          .count()) > 0;
      check(
        (await current('기록 300번째')) && !(await inView('기록 220번째')),
        `${label}: newest match is highlighted/in view; without stepping the next older match is out of view`,
      );
      const older = hd.getByRole('button', { name: '이전 검색 결과' });
      await older.click();
      await hd.getByText('2 / 4').waitFor({ timeout: 15_000 });
      await hd.getByText('기록 220번째: 자두나무 진행 상황').waitFor({ timeout: 15_000 });
      check(
        await current('기록 220번째'),
        `${label}: ∧ loads the next older current-session match`,
      );
      await older.click();
      await hd.getByText('3 / 4').waitFor({ timeout: 15_000 });
      await hd.getByText('기록 150번째: 자두나무 진행 상황').waitFor({ timeout: 15_000 });
      check(
        await current('기록 150번째'),
        `${label}: ∧ loads a second older page and highlights it`,
      );
      await older.click();
      await hd.getByText('4 / 4').waitFor({ timeout: 15_000 });
      await hd.getByText('어제 자두나무 심은 이야기').waitFor({ timeout: 15_000 });
      check(
        await current('어제 자두나무'),
        `${label}: ∧ reaches and highlights the earlier-session match`,
      );
      await hd.getByRole('button', { name: '다음 검색 결과' }).click();
      await hd.getByText('3 / 4').waitFor({ timeout: 15_000 });
      check(await current('기록 150번째'), `${label}: ∨ steps back to the newer match`);
      await field.press('Shift+Enter');
      await hd.getByText('2 / 4').waitFor({ timeout: 15_000 });
      check(
        await current('기록 220번째'),
        `${label}: Shift+Enter in the box steps to the newer match`,
      );
      await field.press('Enter');
      await hd.getByText('3 / 4').waitFor({ timeout: 15_000 });
      check(await current('기록 150번째'), `${label}: Enter steps to the next older match`);
      await hd.getByRole('button', { name: '목록' }).click();
      const results = hd.getByRole('list', { name: '검색 결과' });
      const hit = results.getByRole('button', { name: /자두나무/ }).first();
      await hit.waitFor({ timeout: 15_000 });
      const found = {
        hits: await results.getByRole('button').count(),
        text: (await hit.innerText()).replace(/\s+/g, ' '),
        marked: await hit.locator('mark.bg-search-match').count(),
      };
      check(
        found.hits === 4 && found.text.includes('자두나무') && found.marked === 1,
        `${label}: 목록 keeps four clickable, highlighted search rows ${JSON.stringify(found)}`,
      );
      await snap('2-search');
      await results.getByRole('button', { name: /어제 자두나무/ }).click();
      await hd.getByText('4 / 4').waitFor({ timeout: 15_000 });
      await hd
        .locator('[data-chat-id]', { hasText: '자두나무' })
        .first()
        .waitFor({ timeout: 15_000 });
      await hp.waitForTimeout(500);
      check(
        (await inView('어제 자두나무')) && (await marked('어제 자두나무')),
        `${label}: a result-list row jumps and sets the counter`,
      );
      await snap('2-jumped');
      await hp.keyboard.press('Escape');
      check(
        (await hd.getByRole('region', { name: '대화 검색' }).count()) === 0 &&
          (await hd.locator('mark').count()) === 0,
        `${label}: Esc closes search and clears rendered highlights`,
      );
      await hd.getByRole('button', { name: '대화 검색' }).click();
      await field.fill('없는말');
      await field.press('Enter');
      await hd.getByText('결과 없음').waitFor({ timeout: 15_000 });
      check(await hd.getByText('결과 없음').isVisible(), `${label}: no-match query says 결과 없음`);
      await hp.keyboard.press('Escape');

      // (3) A notice url with its time lands on the old item; without it, the newest.
      await start(`?open=chat&lead=delta&at=${OLD_AT}`);
      await hd.getByText('등대지기').waitFor({ timeout: 15_000 });
      await hp.waitForTimeout(500);
      check(
        (await inView('등대지기')) && (await marked('등대지기')),
        `${label}: /?open=chat&lead=delta&at=… opens with that item in view and marked`,
      );
      await snap('3-notice-at');
      await start('?open=chat&lead=delta');
      await hd.getByText('delta 할 일을 정리할게요.').waitFor({ timeout: 15_000 });
      await hp.waitForTimeout(500);
      check(
        (await hd.getByText('등대지기').count()) === 0 || !(await inView('등대지기')),
        `${label}: the same url without at opens at the newest (the old item out of view)`,
      );
      await snap('3-notice-no-at');
      await ctx.close();
    };
    await history('desktop', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await history('phone', { ...IPHONE13, viewport: { width: 393, height: 852 } });

    // ════ Phone ════
    const { ctx: phoneCtx, page: phone } = await open({
      ...IPHONE13,
      storageState: await desk.storageState().catch(() => undefined),
    });
    await phone.goto(await daemon.loginUrl());
    await phone.waitForURL(`http://127.0.0.1:${port}/`);
    await hangul(phone);
    await phone.addStyleTag({ content: SAFE_AREA });
    await phone.getByRole('button', { name: /^메신저($| \()/ }).tap();
    const pm = phone.getByRole('region', { name: '메신저', exact: true });
    const plist = pm.getByRole('list', { name: '연락처' });
    await plist.getByRole('button', { name: /^beta/ }).waitFor();
    const fits = () =>
      phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check(await fits(), 'phone: the contact list fits the width');
    await shot(phone, 'iphone13-contacts');
    await plist.getByRole('button', { name: /^beta/ }).tap();
    await pm
      .getByRole('region', { name: 'beta 대화' })
      .getByText('beta: 세 가지가 남았어요.')
      .waitFor();
    await pm.getByRole('button', { name: '‹ 목록' }).tap();
    await plist.getByRole('button', { name: /^gamma/ }).tap();
    const chips = pm.getByRole('navigation', { name: '열린 대화' });
    check((await chips.getByRole('tab').count()) === 2, 'phone: a row of chips for the open ones');
    await chips.getByRole('tab', { name: /^beta/ }).tap();
    const pbeta = pm.getByRole('region', { name: 'beta 대화' });
    await pbeta.getByText('알겠어요: 끝나면 테스트도 돌려줘').waitFor();
    check(true, 'phone: a chip switches conversations');
    {
      const pbox = pbeta.getByRole('textbox', { name: '보낼 글' });
      const h1 = (await pbox.boundingBox())!.height;
      await pbox.fill(Array.from({ length: 60 }, (_, i) => `줄 ${i + 1}`).join('\n'));
      const h60 = (await pbox.boundingBox())!.height;
      const screenH = await phone.evaluate(() => window.innerHeight);
      check(
        Math.abs(h60 - screenH / 3) <= 3 &&
          (await pbox.evaluate((el) => el.scrollHeight > el.clientHeight)),
        `phone: the message box grows from ${Math.round(h1)} to a third of the screen (${Math.round(h60)} of ${screenH}), then scrolls`,
      );
      await shot(phone, 't0111-phone-composer');
      await pbox.fill('');
      check(
        Math.abs((await pbox.boundingBox())!.height - h1) <= 1,
        'phone: emptied, the message box is one line again',
      );
    }
    {
      // T-0037: the menu works by touch: `/` opens it, a tap on a row completes the command.
      const pbox = pbeta.getByRole('textbox', { name: '보낼 글' });
      await pbox.fill('/');
      const pmenu = pbeta.getByRole('listbox', { name: '/ 명령' });
      await pmenu.getByRole('option', { name: /\/context/ }).tap();
      check(
        (await pbox.inputValue()) === '/context ' && (await pmenu.count()) === 0,
        'phone: a tap on a / menu row completes the command and closes the menu',
      );
      await pbox.fill('');
    }
    await pbeta.getByRole('textbox', { name: '보낼 글' }).fill('폰에서 보냄');
    await pbeta.getByRole('button', { name: '보내기' }).tap();
    await pbeta.getByText('알겠어요: 폰에서 보냄').waitFor({ timeout: 20_000 });
    const top = await pm.evaluate((el) => el.getBoundingClientRect().top);
    check(
      (await fits()) && top >= 47,
      `phone: a conversation sends, fits the width, sits below the notch (top ${Math.round(top)} px)`,
    );
    await shot(phone, 'iphone13-conversation');
    const phoneChooser = phone.waitForEvent('filechooser');
    await pbeta.getByRole('button', { name: '첨부', exact: true }).tap();
    await (
      await phoneChooser
    ).setFiles({ name: 'phone.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await pbeta.getByRole('textbox', { name: '보낼 글' }).fill('폰 첨부');
    await phone.screenshot({ path: path.join(OUT_T0067, 'phone-chips.png') });
    await pbeta.getByRole('button', { name: '보내기' }).tap();
    await pbeta
      .locator('[data-chat-id]', { hasText: '폰 첨부' })
      .locator('img')
      .waitFor({ timeout: 20_000 });
    await phone.screenshot({ path: path.join(OUT_T0067, 'phone.png') });
    await phoneCtx.close();

    // ════ T-0087: who sent each message ════
    // gamma's transcript gets a boss message, a Codex notice and a peer's message
    // (ops through `cld-gui send`), the way the engine's messenger types them.
    say('gamma', 'user', '[사장 · 메신저 · 10-22 14:10]\n사장이 직접 보낸 말');
    say(
      'gamma',
      'user',
      '[cld-gui · 보냄 · 10-22 14:12]\n[cld-gui codex] 작업 a1b2 끝: done · 폴더 /work/gamma · 커밋 2개',
    );
    say('gamma', 'user', '[cld-gui · ops에게서 · 10-22 14:15]\n규칙 추가했으니 확인해 줘');
    {
      const { ctx, page: p87 } = await open({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        storageState: await desk.storageState().catch(() => undefined),
      });
      await p87.goto(await daemon.loginUrl());
      await p87.waitForURL(`http://127.0.0.1:${port}/`);
      await hangul(p87);
      await p87.getByRole('button', { name: /^메신저/ }).click();
      const m87 = p87.getByRole('region', { name: '메신저', exact: true });
      const list87 = m87.getByRole('list', { name: '연락처' });
      await list87.getByText('ops: 규칙 추가했으니 확인해 줘').waitFor({ timeout: 15_000 });
      check(true, 'the list names a sender that is not the boss: "ops: 규칙 추가했으니 확인해 줘"');
      await p87.screenshot({ path: path.join(OUT_T0087, 'desktop-contacts.png') });
      await list87.getByRole('button', { name: /^gamma/ }).click();
      const g = m87.getByRole('region', { name: 'gamma 대화' });
      await g.getByText('규칙 추가했으니 확인해 줘').waitFor();
      const boss = g.locator('[data-from="boss"]', { hasText: '사장이 직접 보낸 말' });
      const peer = g.locator('[data-from="peer"]', { hasText: '규칙 추가했으니 확인해 줘' });
      const sys = g.locator('[data-from="system"]', { hasText: '[cld-gui codex] 작업 a1b2 끝' });
      check(
        (await boss.count()) === 1 && (await peer.count()) === 1 && (await sys.count()) === 1,
        'one message of each shape: data-from boss, peer, system',
      );
      check(
        (await peer.locator('[data-testid="from-name"]').innerText()) === 'ops',
        "the peer's bubble carries its name",
      );
      check(
        (await g.getByText('[cld-gui ·').count()) === 0 &&
          (await g.getByText('[사장 ·').count()) === 0,
        'no header line is shown in any of the three',
      );
      const box = async (l: typeof boss) => (await l.boundingBox())!;
      // the bubbles themselves, not their rows (a row only differs by its margin)
      const [bb, pb, sb] = [
        await box(boss.locator('div.border').first()),
        await box(peer.locator('div.border').first()),
        await box(sys),
      ];
      check(
        // UI-CONSISTENCY (10-25): a notice row is 48 px with its room, one line; two lines are 60+.
        pb.x < bb.x && pb.x + pb.width < bb.x + bb.width - 8 && Math.abs(sb.height) < 56,
        `peer bubble on the left (${Math.round(pb.x)}..${Math.round(pb.x + pb.width)}), the boss's on the right (${Math.round(bb.x)}..${Math.round(bb.x + bb.width)}), the notice one line (${Math.round(sb.height)} px)`,
      );
      const look = (l: typeof boss) =>
        l
          .locator('div.border')
          .first()
          .evaluate((el) => {
            const c = getComputedStyle(el);
            return `${c.backgroundColor}|${c.borderTopColor}`;
          });
      // what the boss's bubble classes resolve to (the theme's tokens, no colour literal here)
      const tokens = await p87.evaluate(() => {
        const el = document.body.appendChild(document.createElement('div'));
        el.className = 'border border-accent bg-active-bg';
        const c = getComputedStyle(el);
        const v = `${c.backgroundColor}|${c.borderTopColor}`;
        el.remove();
        return v;
      });
      const [bossLook, peerLook] = [await look(boss), await look(peer)];
      check(
        bossLook === tokens && peerLook !== bossLook,
        `the boss bubble is unchanged (${bossLook}); the peer's is its own (${peerLook})`,
      );
      await p87.screenshot({ path: path.join(OUT_T0087, 'desktop-conversation.png') });
      await ctx.close();
    }

    // ════ A push notification's click (T-0043, 10-22 01:4x) ════
    // Full Chromium (the headless shell's service workers are not the browser's).
    // The click is dispatched in the service worker as the OS would deliver it;
    // a synthetic event may not open a window, so with no page open the worker's
    // openWindow is recorded and that url opened, as the OS then does.
    pushBrowser = await launchBrowser({ executablePath: FULL_CHROME });
    const pctx = await pushBrowser.newContext({ viewport: { width: 1400, height: 900 } });
    await pctx.route('**/__t0043/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    const pp = await pctx.newPage();
    await pp.goto(await daemon.loginUrl());
    await pp.waitForURL(`http://127.0.0.1:${port}/`);
    await hangul(pp);
    await pp.getByRole('button', { name: /^메신저($| \()/ }).waitFor();
    await pp.evaluate(() => navigator.serviceWorker.register('/sw.js'));
    for (const end = Date.now() + 15_000; !pctx.serviceWorkers().length;) {
      if (Date.now() > end) throw new Error('no service worker');
      await pp.waitForTimeout(200);
    }
    const sw = pctx.serviceWorkers()[0];
    await pp
      .waitForFunction(() => !!navigator.serviceWorker.controller, undefined, {
        timeout: 15_000,
      })
      .catch(() => pp.reload()); // the first load is not controlled yet
    await pp.getByRole('button', { name: /^메신저($| \()/ }).waitFor();
    // A string: tsx's helpers (__name) do not exist in the worker.
    const clickInWorker = (url: string) =>
      sw.evaluate(`(() => {
        self.__opened = [];
        self.clients.openWindow = (x) => (self.__opened.push(x), Promise.resolve(null));
        const ev = new Event('notificationclick');
        Object.defineProperty(ev, 'notification', {
          value: { data: { agentId: null, url: ${JSON.stringify(url)} }, close() {} },
        });
        ev.waitUntil = () => undefined;
        self.dispatchEvent(ev);
      })()`);
    // (a) A page of the app is open: focused, told, and it opens the conversation in place.
    await pp.evaluate(() => ((window as unknown as { __kept: number }).__kept = 1));
    await clickInWorker('/?open=chat&lead=beta');
    const pmsg = pp.getByRole('region', { name: '메신저', exact: true });
    await pmsg.getByRole('region', { name: 'beta 대화' }).waitFor({ timeout: 10_000 });
    check(
      (await pp.evaluate(() => (window as unknown as { __kept?: number }).__kept)) === 1,
      "push click, a page open: the worker's message opens beta's conversation in place (no reload)",
    );
    await shot(pp, 'push-click-open-page');
    // (b) No page open: the worker opens a window at the target's url.
    await pp.close();
    await clickInWorker('/?open=chat&lead=gamma');
    const opened = await sw.evaluate(() => (self as unknown as { __opened: string[] }).__opened);
    check(
      JSON.stringify(opened) === JSON.stringify(['/?open=chat&lead=gamma']),
      `push click, no page: the worker opens ${JSON.stringify(opened)}`,
    );
    const fresh = await pctx.newPage();
    await fresh.goto(`http://127.0.0.1:${port}${opened[0]}`);
    await hangul(fresh);
    await fresh
      .getByRole('region', { name: '메신저', exact: true })
      .getByRole('region', { name: 'gamma 대화' })
      .waitFor({ timeout: 15_000 });
    check(
      !fresh.url().includes('open='),
      'push click, no page: that url opens gamma’s conversation after loading (the url cleaned)',
    );
    // (c) The session expired: the login page comes first, the target survives it.
    const anon = await pushBrowser.newContext({ viewport: { width: 1400, height: 900 } });
    await anon.route('**/__t0043/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    const lp = await anon.newPage();
    await lp.goto(`http://127.0.0.1:${port}/?open=chat&lead=delta`);
    const code = new URL(await daemon.loginUrl()).searchParams.get('code')!;
    await lp.locator('#code').fill(code);
    await lp.locator('#code').press('Enter');
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    await hangul(lp);
    await lp
      .getByRole('region', { name: '메신저', exact: true })
      .getByRole('region', { name: 'delta 대화' })
      .waitFor({ timeout: 15_000 });
    check(true, 'push click through the login: a code login lands on delta’s conversation');
    await shot(lp, 'push-click-after-login');
    // A url's target is checked: markup in a name opens nothing.
    const bad = await anon.newPage();
    await bad.goto(
      `http://127.0.0.1:${port}/?open=chat&lead=${encodeURIComponent('<img src=x onerror=alert(1)>')}`,
    );
    await bad.getByRole('button', { name: /^메신저($| \()/ }).waitFor();
    await bad.waitForTimeout(1_500);
    check(
      (await bad.getByRole('region', { name: '메신저', exact: true }).count()) === 0 &&
        (await bad.locator('img[src="x"]').count()) === 0,
      'a url naming markup as the lead opens nothing',
    );
    await anon.close();
    await pctx.close();

    const sends = serverLog.join('').match(/\[cld engine\] send .*/g) ?? [];
    fs.writeFileSync(path.join(OUT, 'send-log.txt'), `${sends.join('\n')}\n`);
    check(
      sends.some((l) => l.includes('"alpha" gui:linux: pane')) &&
        sends.some((l) => l.includes('"beta" gui:linux: queued')) &&
        sends.some((l) => l.includes('gui:ios')),
      'the daemon logs each send (lead, device, pane/queued), never the text',
    );
    check(!serverLog.join('').includes('배포 상태 알려줘'), 'no message text in the log');
    console.log(`rss MB: ${JSON.stringify(rss)}`);
    fs.writeFileSync(path.join(OUT, 'rss.json'), `${JSON.stringify(rss, null, 1)}\n`);
  } finally {
    clearInterval(replier);
    await browser?.close();
    await pushBrowser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(force);
    }
    clearTimeout(deadline);
    fs.writeFileSync(
      path.join(OUT, 'server-log.txt'),
      serverLog
        .join('')
        .replaceAll(home, '<home>')
        .replace(/code=[^\s&]+/g, 'code=<redacted>'),
    );
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

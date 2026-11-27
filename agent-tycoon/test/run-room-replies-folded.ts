/**
 * T-105: a group room's threads are folded by default (the replies open on a tap, the opening is kept per browser).
 * dist/cli.js with --engine on --allow-chat in a temp HOME whose `claude` is the engine fake. The 전체 room is
 * seeded with an untagged post, a 공지, two answered threads (A: alpha answered; B: alpha and beta answered) and
 * a tag beta never answered. Per session (desktop 모던, desktop 픽셀 감성, phone 390x844 in 모던; Chromium
 * --disable-gpu, the phone with touch and no scroll anchoring, as iOS has none):
 *  1. A and B are folded: a count row each, no reply drawn;
 *  2. B opens on a tap and its fold row keeps its place on screen (the room sticks to its bottom);
 *  3. B folded by hand and a new reply lands: its fold row says 새 답글 1, a tap clears it;
 *  4. (desktop 모던) a 답글 posted in the folded thread A leaves A open; a search hit on that 답글 with A
 *     folded opens A and lands on it; after a reload A and B are still open, the others folded.
 *
 *   npx tsx agent-tycoon/test/run-room-replies-folded.ts <port 19410-19419>
 *
 * Pictures and run.log in agent-tycoon/artifacts/t0105/.
 */
import type { Browser, BrowserContextOptions, Locator } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { monthFile } from '../../server/src/agent-tycoon/engine/groupLogFiles.js';
import { groupTimelineDir } from '../../server/src/agent-tycoon/engine/groups.js';
import { transcriptPath } from '../../server/src/agent-tycoon/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 19410 && port <= 19419)) throw new Error('port must be 19410-19419');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/t0105');
const DEADLINE_MS = 300_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0105/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const MIN = 60_000;
const STORE: Record<string, string> = { 'agty.title-scene': 'off', 'agty.office-iso': 'on', 'agty.floor': '1', 'agty.floor-view': 'one' };
const lines: string[] = [];
const log = (s: string) => (lines.push(s), console.log(s));
let failures = 0;

const pad = (v: number) => String(v).padStart(2, '0');
const stamp = (at: number) => {
  const d = new Date(at);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      ['alpha', 'beta'].map((name) => {
        const dir = path.join(home, 'work', name);
        fs.mkdirSync(dir, { recursive: true });
        return { name, folder: dir, room: '개발실', wantRunning: true };
      }),
    ),
  );

  const now = Date.now();
  const post = (id: string, at: number, text: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 1, kind: 'post', post: { id, at, sender: null, roomName: '전체', text, targets: [], delivery: {}, ...over } });
  const TA = { id: 'pAa', at: now - 33 * MIN, text: '@alpha 배포 끝났나요?', mark: 'aaaa2222' /* a delivery id is a-z2-7 x8 */ };
  const TB = { id: 'pBb', at: now - 25 * MIN, text: '@alpha @beta 로그 확인해 주세요', markA: 'bbbb2222', markB: 'bbbb3333' };
  const records = [
    post('p0plain', now - 40 * MIN, '오늘 배포 일정을 공유드려요. 저녁 9시에 점검이 있습니다.'),
    post(TA.id, TA.at, TA.text, { targets: ['alpha'], delivery: { alpha: 'delivered' }, messageIds: { alpha: TA.mark } }),
    post('p7notice', now - 36 * MIN, '공지: 오늘 저녁 9시에 서버 점검이 있어요', {
      targets: ['alpha', 'beta'],
      delivery: { alpha: 'delivered', beta: 'delivered' },
      notice: true,
    }),
    post(TB.id, TB.at, TB.text, {
      targets: ['alpha', 'beta'],
      delivery: { alpha: 'delivered', beta: 'delivered' },
      messageIds: { alpha: TB.markA, beta: TB.markB },
    }),
    post('p8wait', now - 10 * MIN, '@beta 테스트 결과 알려 주세요', { targets: ['beta'], delivery: { beta: 'delivered' }, messageIds: { beta: 'cccc4444' } }),
  ];
  fs.mkdirSync(groupTimelineDir(home), { recursive: true });
  fs.writeFileSync(monthFile(groupTimelineDir(home), 'all', now), `${records.join('\n')}\n`);

  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'], {
    FAKE_TURN_MS: '600',
  });
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
    killFakeSessions(home);
    removeTestHome(home);
    process.exit(1);
  };
  const deadline = setTimeout(() => abort('deadline'), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { sessionId: string; cwd: string; name: string; jobId: string };
  const sessionOf = (name: string): Sess | null => {
    for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (s.name === name) return s;
      } catch {
        /* being written */
      }
    }
    return null;
  };
  let uuid = 0;
  const id = () => `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const user = (at: number, text: string) => `${JSON.stringify({ type: 'user', uuid: id(), timestamp: new Date(at).toISOString(), message: { role: 'user', content: text } })}\n`;
  const said = (at: number, text: string) =>
    `${JSON.stringify({ type: 'assistant', uuid: id(), timestamp: new Date(at).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`;
  const header = (at: number, text: string, mark: string) => `[사장 · 단톡방 '전체' · ${stamp(at)}] ⟨m:${mark}⟩\n${text}`;

  let browser: Browser | undefined;
  try {
    for (const end = Date.now() + 40_000; !['alpha', 'beta'].every((n) => sessionOf(n)); ) {
      if (Date.now() > end) throw new Error('the engine did not revive alpha and beta');
      await new Promise((r) => setTimeout(r, 300));
    }
    const alpha = sessionOf('alpha')!;
    const beta = sessionOf('beta')!;
    const alphaFile = transcriptPath(alpha.cwd, alpha.sessionId, home);
    const betaFile = transcriptPath(beta.cwd, beta.sessionId, home);
    fs.mkdirSync(path.dirname(alphaFile), { recursive: true });
    fs.mkdirSync(path.dirname(betaFile), { recursive: true });
    fs.appendFileSync(
      alphaFile,
      user(TA.at + 1000, header(TA.at, TA.text, TA.mark)) +
        said(TA.at + 2000, '네, 배포 끝났어요. **v1.4** 로 올렸습니다.') +
        user(TB.at + 1000, header(TB.at, TB.text, TB.markA)) +
        said(TB.at + 2000, '로그에는 에러가 없어요.'),
    );
    fs.appendFileSync(
      betaFile,
      user(TB.at + 1500, header(TB.at, TB.text, TB.markB)) + said(TB.at + 2500, '저도 확인했어요. 경고가 두 건 있어요.'),
    );

    // alpha answers what the room types to it from now on (the 답글 in thread A).
    const typedLog = path.join(home, 'fake-claude-typed.log');
    const typedRaw = () =>
      fs.existsSync(typedLog)
        ? fs
            .readFileSync(typedLog, 'utf-8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { id: string; text: string })
        : [];
    let seen = typedRaw().length;
    const replier = setInterval(() => {
      const all = typedRaw();
      for (const item of all.slice(seen)) {
        if (sessionOf('alpha')?.jobId !== item.id || !item.text.includes("단톡방 '전체'")) continue;
        const at = Date.now();
        fs.appendFileSync(alphaFile, user(at, item.text.replaceAll('\r', '\n')) + said(at + 1, '롤백은 v1 태그로 돌려요'));
      }
      seen = all.length;
    }, 100);

    browser = await launchBrowser({ args: ['--disable-gpu'] });
    const loginUrl = await daemon.loginUrl();
    const base = `http://127.0.0.1:${port}/`;
    let cookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> | null = null;
    const phoneOpts = (() => {
      const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
      delete d.defaultBrowserType;
      return { ...d, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 2 } as BrowserContextOptions;
    })();
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
        log(`ok   ${name}`);
      } catch (err) {
        failures++;
        log(`FAIL ${name}: ${String(err).split('\n')[0]}`);
      }
    };

    const check = (ok: unknown, what: string) => {
      if (!ok) throw new Error(what);
    };
    let late = 0;
    const session = async (device: 'desktop' | 'phone', theme: 'modern' | 'pixel') => {
      const phone = device === 'phone';
      const ctx = await browser!.newContext(phone ? phoneOpts : { viewport: { width: 1600, height: 1000 } });
      if (cookies) await ctx.addCookies(cookies);
      await ctx.addInitScript(
        ([pairs, th]) => {
          (globalThis as { __name?: unknown }).__name = (fn: unknown) => fn;
          try {
            for (const [k, v] of pairs) localStorage.setItem(k, v);
            localStorage.setItem('agty.ui-theme', th);
          } catch {
            /* about:blank */
          }
        },
        [Object.entries(STORE), theme] as const,
      );
      if (theme === 'pixel' && fs.existsSync(FONT))
        await ctx.route('**/__t0105/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      const page = await ctx.newPage();
      page.on('pageerror', (e) => log(`  [pageerror] ${e.message}`));
      const styles = async () => {
        if (theme === 'pixel') await page.addStyleTag({ content: FONT_CSS });
        // iOS has no scroll anchoring: the phone run shows the fold row holds its place without it
        if (phone) await page.addStyleTag({ content: '[data-testid="room-scroll"] { overflow-anchor: none; }' });
      };
      const name = `${device}-${theme}`;
      const shot = async (what: string) => {
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(OUT, `${name}-${what}.png`) });
      };
      const press = (l: Locator) => (phone ? l.tap() : l.click());
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      const enter = async () => {
        await page.goto(cookies ? base : loginUrl);
        await page.waitForURL(base);
        cookies ??= await ctx.cookies();
        await styles();
        await (phone ? page.getByTestId('party-strip') : page.getByRole('button', { name: /^메신저/ })).waitFor({ timeout: 60_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(2_500);
        const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
        if (await infoClose.count()) await infoClose.click().catch(() => undefined);
        if (phone) await page.locator('[data-dock="messenger"]').tap();
        else await page.getByRole('button', { name: /^메신저/ }).click();
        await press(messenger.getByTestId('group-room-row-all'));
        await messenger.getByTestId('group-room-screen-all').waitFor({ timeout: 15_000 });
        await messenger.getByTestId('room-thread').filter({ hasText: TB.text }).waitFor({ timeout: 20_000 });
      };
      await step(`${name} open the room`, enter);
      const room = messenger.getByTestId('group-room-screen-all');
      const thread = (text: string) => room.getByTestId('room-thread').filter({ hasText: text });
      const a = thread(TA.text);
      const b = thread(TB.text);
      const top = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().top);
      const toBottom = async () => {
        await room.getByTestId('room-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
        await page.waitForTimeout(300);
      };

      await step(`${name} 1. threads with replies are folded, with their counts`, async () => {
        // T-113: these posts have no recorded counts (written before it): the room counts them once, just after its first frame
        await room.getByTestId('thread-fold').nth(1).waitFor({ timeout: 10_000 });
        await toBottom();
        check((await room.getByTestId('thread-fold').count()) === 2, 'two fold rows (A and B)');
        check((await room.locator('[data-testid="thread-fold"][data-folded]').count()) === 2, 'both folded');
        check((await room.getByTestId('thread-answer').count()) === 0 && (await room.locator('.room-reply').count()) === 0, 'no reply drawn');
        check((await room.getByText('경고가 두 건').count()) === 0, 'the reply text is not in the page');
        check(/\d/.test(await a.getByTestId('thread-fold').innerText()), 'A shows a count');
        check(/\d/.test(await b.getByTestId('thread-fold').innerText()), 'B shows a count');
        check((await room.getByTestId('thread-new').count()) === 0, 'a thread never opened shows no new count');
        await shot('1-folded');
      });
      await step(`${name} 2. B opens on a tap and its fold row keeps its place`, async () => {
        await toBottom();
        const before = await top(b.getByTestId('thread-fold'));
        await press(b.getByTestId('thread-fold'));
        await b.getByText('경고가 두 건').waitFor({ timeout: 5_000 });
        await page.waitForTimeout(400);
        const moved = Math.abs((await top(b.getByTestId('thread-fold'))) - before);
        check(moved <= 2, `the fold row moved ${moved}px`);
        check((await b.locator('[data-testid="thread-fold"][data-folded]').count()) === 0, 'B is open');
        check((await a.locator('[data-testid="thread-fold"][data-folded]').count()) === 1, 'A is still folded');
        await shot('2-opened');
        const open = await room.evaluate(() => localStorage.getItem('agty.room-thread-open'));
        check(open && open.includes('pBb'), 'the opening is kept in the browser');
      });
      await step(`${name} 3. folded by hand, a new reply counts on the fold row`, async () => {
        const before = await top(b.getByTestId('thread-fold'));
        await press(b.getByTestId('thread-fold'));
        await b.locator('[data-testid="thread-fold"][data-folded]').waitFor({ timeout: 5_000 });
        await page.waitForTimeout(400);
        const moved = Math.abs((await top(b.getByTestId('thread-fold'))) - before);
        check(moved <= 2, `the fold row moved ${moved}px when folding`);
        late++;
        fs.appendFileSync(betaFile, said(Date.now(), `추가로 확인한 것 ${late}: 배포 로그 정리 끝`));
        await b.getByTestId('thread-new').waitFor({ timeout: 15_000 });
        check(/1/.test(await b.getByTestId('thread-new').innerText()), 'the new count is 1');
        await shot('3-folded-new');
        await press(b.getByTestId('thread-fold'));
        await b.getByText('배포 로그 정리 끝').first().waitFor({ timeout: 5_000 });
        check((await b.getByTestId('thread-new').count()) === 0, 'opened, nothing is new');
      });
      if (phone || theme === 'pixel') return ctx.close();

      await step(`${name} 4a. a 답글 in the folded thread A leaves A open`, async () => {
        check((await a.locator('[data-testid="thread-fold"][data-folded]').count()) === 1, 'A starts folded');
        await a.scrollIntoViewIfNeeded();
        await a.hover();
        await a.getByTestId('message-actions').first().getByRole('button', { name: '답글' }).click();
        await room.getByRole('textbox', { name: '전체 메시지' }).fill('@alpha 롤백 계획도 알려 주세요');
        await room.getByRole('button', { name: '보내기', exact: true }).click();
        await a.getByTestId('thread-answer').filter({ hasText: '롤백 계획도' }).waitFor({ timeout: 20_000 });
        await a.getByText('롤백은 v1 태그로 돌려요').waitFor({ timeout: 25_000 });
        check((await a.locator('[data-testid="thread-fold"][data-folded]').count()) === 0, 'A is open after the reply');
        await shot('4a-own-reply');
      });
      await step(`${name} 4b. a search hit on a 답글 in the folded A opens A and lands on it`, async () => {
        await press(a.getByTestId('thread-fold'));
        await a.locator('[data-testid="thread-fold"][data-folded]').waitFor({ timeout: 5_000 });
        await room.getByTestId('room-scroll').evaluate((el) => (el.scrollTop = 0));
        const find = messenger.getByRole('searchbox', { name: '대화 목록에서 찾기' });
        await find.fill('롤백 계획도');
        const hit = messenger.getByTestId('search-all').getByRole('button').filter({ hasText: '롤백 계획도' }).first();
        await hit.waitFor({ timeout: 15_000 });
        await hit.click();
        const answer = a.getByTestId('thread-answer').filter({ hasText: '롤백 계획도' });
        await answer.waitFor({ timeout: 10_000 });
        await page.waitForTimeout(800);
        check((await a.locator('[data-testid="thread-fold"][data-folded]').count()) === 0, 'A is open');
        const inView = await answer.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const s = el.closest('[data-testid="room-scroll"]')!.getBoundingClientRect();
          return r.top >= s.top - 1 && r.bottom <= s.bottom + 1;
        });
        check(inView, 'the 답글 is in view');
        await shot('4b-search-landing');
      });
      await step(`${name} 4c. after a reload what was opened stays open`, async () => {
        await page.reload();
        await page.waitForURL(base);
        await styles();
        await page.getByRole('button', { name: /^메신저/ }).waitFor({ timeout: 60_000 });
        await page.waitForTimeout(2_500);
        const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
        if (await infoClose.count()) await infoClose.click().catch(() => undefined);
        await page.getByRole('button', { name: /^메신저/ }).click();
        await messenger.getByTestId('group-room-row-all').click();
        await b.waitFor({ timeout: 20_000 });
        check((await a.locator('[data-testid="thread-fold"][data-folded]').count()) === 0, 'A (opened by the search) is open');
        check((await b.locator('[data-testid="thread-fold"][data-folded]').count()) === 0, 'B (opened by hand) is open');
        await shot('4c-reloaded');
      });
      await ctx.close();
    };

    try {
      for (const [device, theme] of [['desktop', 'modern'], ['desktop', 'pixel'], ['phone', 'modern']] as const) await session(device, theme);
    } finally {
      clearInterval(replier);
    }
  } finally {
    await browser?.close().catch(() => undefined);
    await daemon.stop();
    clearTimeout(deadline);
    killFakeSessions(home);
    removeTestHome(home);
    fs.writeFileSync(path.join(OUT, 'run.log'), lines.join('\n') + '\n');
  }
}

main().then(
  () => process.exit(failures ? 1 : 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

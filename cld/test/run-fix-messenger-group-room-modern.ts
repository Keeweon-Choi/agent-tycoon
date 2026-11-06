/**
 * FIX-MESSENGER-GROUP-ROOM-MODERN (T-65): the group room in 모던 and 픽셀 감성, with threads that fold.
 * dist/cli.js with --engine on --allow-chat in a temp HOME whose `claude` is the engine fake. The 전체 room
 * is seeded with an untagged post, a 공지, two answered threads (A: alpha answered, then a 답글 and its
 * answer, left open; B: alpha and beta answered, folded) and a tag beta never answered.
 * Desktop Chromium 1600x1000 (--disable-gpu), then WebKit as an iPhone (390x844), each in both styles:
 * the list, the room, thread B folded, and a new reply landing on the folded thread B.
 * Pictures and <TAG>.log in cld/artifacts/fix-messenger-group-room-modern/.
 *
 *   TAG=before npx tsx cld/test/run-fix-messenger-group-room-modern.ts <port 19360-19369>
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { monthFile } from '../../server/src/cld/engine/groupLogFiles.js';
import { groupTimelineDir } from '../../server/src/cld/engine/groups.js';
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 19360 && port <= 19369)) throw new Error('port must be 19360-19369');
const TAG = process.env.TAG ?? 'after';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/fix-messenger-group-room-modern');
const DEADLINE_MS = 420_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__room/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const MIN = 60_000;
const STORE: Record<string, string> = { 'cld.title-scene': 'off', 'cld.office-iso': 'on', 'cld.floor': '1', 'cld.floor-view': 'one' };
const lines: string[] = [];
const log = (s: string) => (lines.push(s), console.log(s));

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
  const TA = { id: 'pAa', at: now - 50 * MIN, text: '@alpha 배포 끝났나요?', mark: 'aaaa1111' };
  const TB = { id: 'pBb', at: now - 30 * MIN, text: '@alpha @beta 로그 확인해 주세요', markA: 'bbbb2222', markB: 'bbbb3333' };
  const records = [
    post('p0plain', now - 70 * MIN, '오늘 배포 일정을 공유드려요. 저녁 9시에 점검이 있습니다.'),
    post(TA.id, TA.at, TA.text, { targets: ['alpha'], delivery: { alpha: 'delivered' }, messageIds: { alpha: TA.mark } }),
    post('p7notice', now - 40 * MIN, '공지: 오늘 저녁 9시에 서버 점검이 있어요', {
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
    let webkit: Browser | undefined;
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
        log(`FAIL ${name}: ${String(err).split('\n')[0]}`);
      }
    };

    let answered = false;
    let late = 0;
    const session = async (b: Browser, device: 'desktop' | 'phone', theme: 'modern' | 'pixel') => {
      const phone = device === 'phone';
      const ctx = await b.newContext(phone ? phoneOpts : { viewport: { width: 1600, height: 1000 } });
      if (cookies) await ctx.addCookies(cookies);
      await ctx.addInitScript(
        ([pairs, th]) => {
          (globalThis as { __name?: unknown }).__name = (fn: unknown) => fn;
          try {
            for (const [k, v] of pairs) localStorage.setItem(k, v);
            localStorage.setItem('cld.ui-theme', th);
          } catch {
            /* about:blank */
          }
        },
        [Object.entries(STORE), theme] as const,
      );
      if (theme === 'pixel' && fs.existsSync(FONT))
        await ctx.route('**/__room/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      const page = await ctx.newPage();
      page.on('pageerror', (e) => log(`  [pageerror] ${e.message}`));
      await page.goto(cookies ? base : loginUrl);
      await page.waitForURL(base);
      cookies ??= await ctx.cookies();
      if (theme === 'pixel') await page.addStyleTag({ content: FONT_CSS });
      await (phone ? page.getByTestId('party-strip') : page.getByRole('button', { name: /^메신저/ })).waitFor({ timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(2_500);
      const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
      if (await infoClose.count()) await infoClose.click().catch(() => undefined);
      const name = `${device}-${theme}`;
      const shot = async (what: string) => {
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(OUT, `${TAG}-${name}-${what}.png`) });
      };
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      await step(`${name} open the list`, async () => {
        if (phone) await page.locator('[data-dock="messenger"]').tap();
        else await page.getByRole('button', { name: /^메신저/ }).click();
        await messenger.getByTestId('group-room-row-all').waitFor({ timeout: 15_000 });
        await shot('list');
      });
      await step(`${name} open the room`, async () => {
        if (phone) await messenger.getByTestId('group-room-row-all').tap();
        else await messenger.getByTestId('group-room-row-all').click();
        const room = messenger.getByTestId('group-room-screen-all');
        await room.waitFor({ timeout: 15_000 });
        await room.getByTestId('room-thread').filter({ hasText: TB.text }).getByText('경고가 두 건').waitFor({ timeout: 20_000 });
        // thread A gets its 답글 once, from the desktop (a phone has only the hold sheet)
        if (!answered && !phone) {
          const a = room.getByTestId('room-thread').filter({ hasText: TA.text });
          await a.scrollIntoViewIfNeeded();
          await a.hover();
          await a.getByTestId('message-actions').first().getByRole('button', { name: '답글' }).click();
          await room.getByRole('textbox', { name: '전체 메시지' }).fill('@alpha 롤백 계획도 알려 주세요');
          await room.getByRole('button', { name: '보내기', exact: true }).click();
          await a.getByTestId('thread-answer').filter({ hasText: '롤백 계획도' }).getByText('롤백은 v1 태그로 돌려요').waitFor({ timeout: 25_000 });
          answered = true;
        }
        await room.getByTestId('room-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
        await shot('room');
        await room.getByTestId('room-scroll').evaluate((el) => (el.scrollTop = 0));
        await shot('room-top');
      });
      const room = messenger.getByTestId('group-room-screen-all');
      const b2 = room.getByTestId('room-thread').filter({ hasText: TB.text });
      await step(`${name} fold thread B`, async () => {
        await b2.getByTestId('thread-fold').click();
        await b2.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await shot('folded');
      });
      await step(`${name} a new reply lands on folded thread B`, async () => {
        late++;
        fs.appendFileSync(betaFile, said(Date.now(), `추가로 확인한 것 ${late}: 배포 로그 정리 끝`));
        await b2.getByTestId('thread-new').waitFor({ timeout: 15_000 });
        await b2.scrollIntoViewIfNeeded();
        await shot('folded-new');
      });
      await step(`${name} unfold thread B`, async () => {
        await b2.getByTestId('thread-fold').click();
        await b2.getByText('배포 로그 정리 끝').first().waitFor({ timeout: 5_000 });
        await shot('unfolded');
      });
      await step(`${name} manage and member list`, async () => {
        if (phone) return;
        await room.getByTestId('member-pill').click();
        await shot('members');
        await room.getByTestId('member-pill').click();
      });
      await ctx.close();
    };

    try {
      for (const theme of ['modern', 'pixel'] as const) await session(browser, 'desktop', theme);
      await browser.close();
      browser = undefined;
      webkit = await launchBrowser({ webkit: true });
      for (const theme of ['modern', 'pixel'] as const) await session(webkit, 'phone', theme);
    } finally {
      clearInterval(replier);
      await webkit?.close().catch(() => undefined);
    }
  } finally {
    await browser?.close().catch(() => undefined);
    await daemon.stop();
    clearTimeout(deadline);
    killFakeSessions(home);
    removeTestHome(home);
    fs.writeFileSync(path.join(OUT, `${TAG}.log`), lines.join('\n') + '\n');
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

/**
 * T-113: a group room's reply counts come with its posts; a thread's replies are read when it is opened.
 * dist/cli.js with --engine on --allow-chat in a temp HOME whose `claude` is the engine fake. The 전체 room is
 * seeded as this build leaves it (each reply line recorded under its post, the room counted): thread A (alpha
 * answered in its conversation before a renew, 12 MB after it, so reading it takes a window), thread B (alpha and beta
 * answered, and a 답글 post C to beta's line). Every page's WebSocket goes through a route that keeps each frame
 * the daemon sends and can hold or spoil one groupThread request. Per session (desktop 모던, desktop 픽셀 감성,
 * phone 390x844 in 모던; Chromium --disable-gpu):
 *  1. the room's first groupTimeline frame already has the counts (A 1, B 3) and no reply line; the fold rows say so;
 *  2. B opened with its request held 2 s: the loading row, then the replies;
 *  3. A opened with its request spoiled (an unknown room): the retry line; 다시 시도 loads A;
 *  4. B folded by hand and beta answers again: 새 답글 1 from the count alone (no thread read);
 *  6. (H3) the socket drops with B open: the room is asked for again, B loads again by itself (no retry line, no
 *     tap), and the room is live after it (a new reply under the folded B raises 새 답글);
 *  6b. (N1) the socket drops while A's load is on its way: A loads by itself on the new socket (no tap, no retry line);
 *  6c. (N1) the socket drops after A's load failed (its retry line shown): A loads by itself, the retry line goes;
 *  7. (L1, desktop 모던) a 답글 joining the open B: B's loaded replies stay drawn while its new part loads;
 *  5. (desktop 모던) C's quote lands on beta's line; a 답글 in the folded A opens A; a search hit on it, with A
 *     folded, opens A, loads it and lands on it.
 *
 *   npx tsx agent-tycoon/test/run-room-reply-count-first.ts <spare port, 18460>   (T0113_ONLY=desktop-modern: that session only)
 *
 * Pictures and run.log in agent-tycoon/artifacts/t0113/.
 */
import type { Browser, BrowserContextOptions, Locator, Page, WebSocketRoute } from '@playwright/test';
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
  sparePort,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/t0113');
const DEADLINE_MS = 300_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0113/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const MIN = 60_000;
const MB = 1024 * 1024;
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
  const TA = { id: 'pAa', at: now - 33 * MIN, text: '@alpha 배포 끝났나요?', mark: 'aaaa2222' };
  const TB = { id: 'pBb', at: now - 25 * MIN, text: '@alpha @beta 로그 확인해 주세요', markA: 'bbbb2222', markB: 'bbbb3333' };

  // The transcripts' lines, and each reply line's ChatItem id (`<time>-<uuid's first 8>-<index>`, transcriptView lineItems).
  let uuid = 0;
  const id = () => `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const user = (at: number, text: string) => `${JSON.stringify({ type: 'user', uuid: id(), timestamp: new Date(at).toISOString(), message: { role: 'user', content: text } })}\n`;
  const said = (at: number, text: string) => {
    const u = id();
    const line = `${JSON.stringify({ type: 'assistant', uuid: u, timestamp: new Date(at).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`;
    return { line, item: `${at}-${u.slice(0, 8)}-0`, at };
  };
  const tool = (at: number) => `${JSON.stringify({ type: 'user', uuid: id(), timestamp: new Date(at).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'x'.repeat(64 * 1024) }] } })}\n`;
  const header = (at: number, text: string, mark: string) => `[사장 · 단톡방 '전체' · ${stamp(at)}] ⟨m:${mark}⟩\n${text}`;
  const aReply = said(TA.at + 2000, '네, 배포 끝났어요. **v1.4** 로 올렸습니다.');
  const bAlpha = said(TB.at + 2000, '로그에는 에러가 없어요.');
  const bBeta = said(TB.at + 2500, '저도 확인했어요. 경고가 두 건 있어요.');
  // alpha's work between A and B: 12 MB of tool results, so A's reply lies past the 4 MB tail a room reads first.
  const work = Array.from({ length: Math.ceil((12 * MB) / (64 * 1024)) }, (_, k) => tool(TA.at + 3000 + k * 1000)).join('');

  const post = (pid: string, at: number, text: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 1, kind: 'post', post: { id: pid, at, sender: null, roomName: '전체', text, targets: [], delivery: {}, ...over } });
  const reply = (pid: string, member: string, r: { item: string; at: number }) => JSON.stringify({ v: 2, kind: 'reply', id: pid, member, item: r.item, at: r.at });
  const records = [
    post('p0plain', now - 40 * MIN, '오늘 배포 일정을 공유드려요. 저녁 9시에 점검이 있습니다.'),
    post(TA.id, TA.at, TA.text, { targets: ['alpha'], delivery: { alpha: 'delivered' }, messageIds: { alpha: TA.mark } }),
    post(TB.id, TB.at, TB.text, { targets: ['alpha', 'beta'], delivery: { alpha: 'delivered', beta: 'delivered' }, messageIds: { alpha: TB.markA, beta: TB.markB } }),
    // C: the boss's 답글 to beta's line: it joins B by the recorded id, before B's replies are loaded
    post('pCc', TB.at + 5 * MIN, '경고 두 건은 내일 볼게요', { replyTo: { id: bBeta.item, sender: 'beta', text: '저도 확인했어요. 경고가 두 건 있어요.' } }),
    post('p8wait', now - 10 * MIN, '@beta 테스트 결과 알려 주세요', { targets: ['beta'], delivery: { beta: 'delivered' }, messageIds: { beta: 'cccc4444' } }),
    reply(TA.id, 'alpha', aReply),
    reply(TB.id, 'alpha', bAlpha),
    reply(TB.id, 'beta', bBeta),
    JSON.stringify({ v: 2, kind: 'counted', at: now - 5 * MIN }),
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
    // alpha renewed between A and B: A's turn and the 12 MB after it are in its earlier conversation (a room
    // reads it with a binary search and one window), B's in the current one.
    const alphaEarlier = path.join(path.dirname(alphaFile), 'earlier-session.jsonl');
    fs.writeFileSync(alphaEarlier, user(TA.at - MIN, '시작') + user(TA.at + 1000, header(TA.at, TA.text, TA.mark)) + aReply.line + work);
    fs.appendFileSync(alphaFile, user(TB.at + 1000, header(TB.at, TB.text, TB.markA)) + bAlpha.line);
    fs.appendFileSync(betaFile, user(TB.at + 1500, header(TB.at, TB.text, TB.markB)) + bBeta.line);
    log(`alpha's earlier conversation: ${(fs.statSync(alphaEarlier).size / MB).toFixed(1)} MB`);

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
        fs.appendFileSync(alphaFile, user(at, item.text.replaceAll('\r', '\n')) + said(at + 1, '롤백은 v1 태그로 돌려요').line);
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

    type Frame = { t: number; dir: 'in' | 'out'; msg: { type?: string; [k: string]: unknown } };
    /** Every frame on the page's socket, and what the next groupThread request meets: passed, held 2 s, or spoiled. */
    const wire = async (page: Page) => {
      const frames: Frame[] = [];
      const state = { next: 'pass' as 'pass' | 'hold' | 'spoil' };
      let current: { page: WebSocketRoute; server: WebSocketRoute } | null = null;
      const parse = (m: string | Buffer) => {
        try {
          return JSON.parse(String(m)) as Frame['msg'];
        } catch {
          return {};
        }
      };
      await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
        const server = ws.connectToServer();
        current = { page: ws, server };
        ws.onMessage((m) => {
          const msg = parse(m);
          frames.push({ t: Date.now(), dir: 'out', msg });
          if (msg.type === 'groupThread' && state.next !== 'pass') {
            const how = state.next;
            state.next = 'pass';
            if (how === 'spoil') return server.send(JSON.stringify({ ...msg, room: 'no-such-room' }));
            return void setTimeout(() => {
              try {
                server.send(m);
              } catch {
                /* that socket dropped meanwhile (step 6b) */
              }
            }, 2000);
          }
          server.send(m);
        });
        server.onMessage((m) => {
          frames.push({ t: Date.now(), dir: 'in', msg: parse(m) });
          ws.send(m);
        });
      });
      /** The socket drops (as a phone's does in the background): the page sees it close and reconnects. */
      const drop = async () => {
        const was = current;
        current = null;
        await was?.page.close({ code: 1006, reason: 'dropped' }).catch(() => undefined);
        await was?.server.close().catch(() => undefined);
      };
      return { frames, state, drop };
    };
    const until = async (ok: () => boolean, ms: number, what: string) => {
      for (const end = Date.now() + ms; !ok(); await new Promise((r) => setTimeout(r, 100))) if (Date.now() > end) throw new Error(what);
    };
    type Posted = { id: string; loaded?: boolean; replies: Array<{ member: string; items: unknown[]; seen?: string[] }> };
    const timelines = (frames: Frame[]) => frames.filter((f) => f.dir === 'in' && f.msg.type === 'groupTimeline' && (f.msg.room as { id?: string })?.id === 'all');
    let late = 0; // beta's lines added under B (steps 4 and 6)
    let bPosts = 0; // the 답글 posts added to B (step 7)
    let aExtra = 0; // the 답글 post in A (step 5b) and alpha's answer to it
    /** At most 10 pictures: everything on desktop 모던, the first three on 픽셀 감성, two on the phone. */
    const KEEP: Record<string, string[]> = {
      'desktop-modern': ['1-counts', '2-loading', '3-failed', '4-new', '5-search-landing'],
      'desktop-pixel': ['1-counts', '2-loading', '3-failed'],
      'phone-modern': ['1-counts', '2-loading'],
    };

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
        await ctx.route('**/__t0113/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      const page = await ctx.newPage();
      page.on('pageerror', (e) => log(`  [pageerror] ${e.message}`));
      const { frames, state, drop } = await wire(page);
      const name = `${device}-${theme}`;
      const press = (l: Locator) => (phone ? l.tap() : l.click());
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      const room = messenger.getByTestId('group-room-screen-all');
      const shot = async (what: string, target: Locator = room) => {
        if (!KEEP[name]?.includes(what)) return;
        await page.waitForTimeout(400);
        await target.screenshot({ path: path.join(OUT, `${name}-${what}.png`) });
      };
      const thread = (text: string) => room.getByTestId('room-thread').filter({ hasText: text });
      const a = thread(TA.text);
      const b = thread(TB.text);
      /** beta's loaded line under B (C's quote holds its words too) */
      const betaLine = b.locator('[data-chat-id]').filter({ hasText: '경고가 두 건' });
      const foldText = async (l: Locator) => (await l.getByTestId('thread-fold').innerText()).replace(/\s+/g, ' ');
      let openedAt = 0;

      await step(`${name} open the room`, async () => {
        await page.goto(cookies ? base : loginUrl);
        await page.waitForURL(base);
        cookies ??= await ctx.cookies();
        if (theme === 'pixel') await page.addStyleTag({ content: FONT_CSS });
        await (phone ? page.getByTestId('party-strip') : page.getByRole('button', { name: /^메신저/ })).waitFor({ timeout: 60_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(2_500);
        const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
        if (await infoClose.count()) await infoClose.click().catch(() => undefined);
        if (phone) await page.locator('[data-dock="messenger"]').tap();
        else await page.getByRole('button', { name: /^메신저/ }).click();
        openedAt = Date.now();
        await press(messenger.getByTestId('group-room-row-all'));
        await room.waitFor({ timeout: 15_000 });
        await b.waitFor({ timeout: 20_000 });
      });

      await step(`${name} 1. the first frame has the counts and no reply line; the fold rows show them`, async () => {
        const asked = frames.find((f) => f.dir === 'out' && f.msg.type === 'groupView' && f.msg.on === true && f.t >= openedAt);
        check(asked, 'the page asked for the room');
        const first = timelines(frames).find((f) => f.t >= asked!.t);
        check(first, 'a groupTimeline came');
        const posts = first!.msg.posts as Posted[];
        const count = (pid: string) => posts.find((p) => p.id === pid)!.replies.map((r) => `${r.member}:${r.seen?.length ?? 0}`).join(',');
        check(count(TA.id) === 'alpha:1', `A's recorded count ${count(TA.id)}`);
        check(count(TB.id) === `alpha:1,beta:${1 + late}`, `B's recorded count ${count(TB.id)}`);
        const items = timelines(frames).filter((f) => f.t >= asked!.t).flatMap((f) => (f.msg.posts as Posted[]).flatMap((p) => p.replies.flatMap((r) => r.items)));
        check(items.length === 0, `${items.length} reply lines were sent before a thread was opened`);
        log(`  first groupTimeline ${first!.t - asked!.t} ms after groupView`);
        check(new RegExp(`답글 ${1 + aExtra}개`).test(await foldText(a)), `A says ${await foldText(a)}`);
        check(new RegExp(`답글 ${3 + late + bPosts}개`).test(await foldText(b)), `B says ${await foldText(b)}`);
        check((await room.locator('.room-reply').count()) === 0, 'no reply drawn');
        await shot('1-counts');
      });

      await step(`${name} 2. B opened: the loading row, then the replies`, async () => {
        state.next = 'hold';
        await press(b.getByTestId('thread-fold'));
        await b.getByTestId('thread-loading').waitFor({ timeout: 3_000 });
        await shot('2-loading', b);
        await betaLine.waitFor({ timeout: 10_000 });
        check((await b.getByTestId('thread-loading').count()) === 0, 'the loading row is gone');
        check(await b.getByText('경고 두 건은 내일 볼게요').isVisible(), "C is in B's thread");
        const ask = frames.filter((f) => f.dir === 'out' && f.msg.type === 'groupThread').at(-1)!;
        const done = frames.find((f) => f.dir === 'in' && f.msg.type === 'groupThreadResult' && f.msg.requestId === ask.msg.requestId);
        check(done?.msg.ok === true, 'groupThreadResult ok');
        log(`  B's replies read in ${done!.t - ask.t - 2000} ms (after the 2 s hold)`);
      });

      await step(`${name} 3. A's load fails: the retry line; 다시 시도 loads it (12 MB back)`, async () => {
        state.next = 'spoil';
        await press(a.getByTestId('thread-fold'));
        await a.getByTestId('thread-load-failed').waitFor({ timeout: 5_000 });
        await shot('3-failed', a);
        const t0 = Date.now();
        await press(a.getByRole('button', { name: '다시 시도' }));
        await a.getByText('배포 끝났어요').waitFor({ timeout: 10_000 });
        const ask = frames.filter((f) => f.dir === 'out' && f.msg.type === 'groupThread').at(-1)!;
        const done = frames.find((f) => f.dir === 'in' && f.msg.type === 'groupThreadResult' && f.msg.requestId === ask.msg.requestId);
        log(`  A's replies read in ${done ? done.t - ask.t : -1} ms, on screen ${Date.now() - t0} ms after the tap`);
      });

      await step(`${name} 4. B folded by hand, beta answers: 새 답글 1 from the count alone`, async () => {
        await press(b.getByTestId('thread-fold'));
        await b.locator('[data-testid="thread-fold"][data-folded]').waitFor({ timeout: 5_000 });
        late++;
        const asks = frames.filter((f) => f.dir === 'out' && f.msg.type === 'groupThread').length;
        fs.appendFileSync(betaFile, said(Date.now(), `추가로 확인한 것 ${late}: 배포 로그 정리 끝`).line);
        await b.getByTestId('thread-new').waitFor({ timeout: 15_000 });
        check(/1/.test(await b.getByTestId('thread-new').innerText()), 'the new count is 1');
        check(frames.filter((f) => f.dir === 'out' && f.msg.type === 'groupThread').length === asks, 'no thread was read for it');
        await shot('4-new', b);
        await press(b.getByTestId('thread-fold'));
        await b.getByText('배포 로그 정리 끝').first().waitFor({ timeout: 10_000 });
      });

      // T0113_NO_DROP=1 leaves step 6 out (a negative control of step 7 on a build without the reconnect fix)
      if (!process.env.T0113_NO_DROP) await step(`${name} 6. the socket drops with B open: the room and B come back by themselves, and stay live`, async () => {
        const dropAt = Date.now();
        await drop();
        await until(() => frames.some((f) => f.dir === 'out' && f.msg.type === 'groupView' && f.msg.on === true && f.t > dropAt), 20_000, 'the room was not asked for again');
        const viewAt = frames.find((f) => f.dir === 'out' && f.msg.type === 'groupView' && f.t > dropAt)!.t;
        await until(
          () => frames.some((f) => f.dir === 'out' && f.msg.type === 'groupThread' && f.t >= viewAt && (f.msg.posts as string[]).includes(TB.id)),
          10_000,
          'B was not asked for again',
        );
        await until(() => frames.some((f) => f.dir === 'in' && f.msg.type === 'groupThreadResult' && f.t >= viewAt && f.msg.ok === true), 10_000, 'no ok answer on the new socket');
        await b.getByText('배포 로그 정리 끝').first().waitFor({ timeout: 10_000 });
        check((await room.getByTestId('thread-load-failed').count()) === 0, 'a retry line is shown');
        log(`  reconnected: the room asked again ${viewAt - dropAt} ms after the drop`);
        // live after it: B folded again, a new line from beta raises 새 답글
        await press(b.getByTestId('thread-fold'));
        await b.locator('[data-testid="thread-fold"][data-folded]').waitFor({ timeout: 5_000 });
        late++;
        fs.appendFileSync(betaFile, said(Date.now(), `재연결 뒤 ${late}: 경고 두 건 정리함`).line);
        await b.getByTestId('thread-new').waitFor({ timeout: 15_000 });
        await press(b.getByTestId('thread-fold'));
        await b.getByText(`재연결 뒤 ${late}`).waitFor({ timeout: 10_000 });
      });
      /** A folded again (the daemon stops reading it), then opened with its request met by `how`. */
      const reopenA = async (how: 'hold' | 'spoil') => {
        if (!(await a.locator('[data-testid="thread-fold"][data-folded]').count())) await press(a.getByTestId('thread-fold'));
        await a.locator('[data-testid="thread-fold"][data-folded]').waitFor({ timeout: 5_000 });
        await page.waitForTimeout(1_800); // a poll: the frame without A's replies
        state.next = how;
        await press(a.getByTestId('thread-fold'));
      };
      const aLine = a.locator('[data-chat-id]').filter({ hasText: '배포 끝났어요' });
      const reconnected = async (what: string) => {
        const dropAt = Date.now();
        await drop();
        await until(() => frames.some((f) => f.dir === 'out' && f.msg.type === 'groupView' && f.t > dropAt), 20_000, `${what}: the room was not asked for again`);
        return dropAt;
      };
      await step(`${name} 6b. the socket drops while A's load is on its way: A loads by itself`, async () => {
        await reopenA('hold');
        await a.getByTestId('thread-loading').waitFor({ timeout: 3_000 });
        await reconnected('6b');
        await aLine.waitFor({ timeout: 10_000 });
        check((await a.getByTestId('thread-loading').count()) === 0, 'the spinner is still there');
        check((await a.getByTestId('thread-load-failed').count()) === 0, 'a retry line is shown');
      });
      await step(`${name} 6c. the socket drops after A's load failed: A loads by itself, the retry line goes`, async () => {
        await reopenA('spoil');
        await a.getByTestId('thread-load-failed').waitFor({ timeout: 5_000 });
        await reconnected('6c');
        await aLine.waitFor({ timeout: 10_000 });
        check((await a.getByTestId('thread-load-failed').count()) === 0, 'the retry line is still there');
        check((await a.getByTestId('thread-loading').count()) === 0, 'a spinner is shown');
      });
      if (phone || theme === 'pixel') return ctx.close();

      await step(`${name} 7. a 답글 joining the open B keeps B's loaded replies drawn while its part loads`, async () => {
        await b.scrollIntoViewIfNeeded();
        await b.hover();
        await b.getByTestId('message-actions').first().getByRole('button', { name: '답글' }).click();
        await room.getByRole('textbox', { name: '전체 메시지' }).fill('@beta 하나 더 확인해 주세요');
        state.next = 'hold';
        await room.getByRole('button', { name: '보내기', exact: true }).click();
        await b.getByTestId('thread-loading').waitFor({ timeout: 10_000 }); // the new 답글's part, held 2 s
        check(await betaLine.isVisible(), "B's loaded replies are hidden while the new part loads");
        check(await b.getByTestId('thread-answer').filter({ hasText: '하나 더 확인' }).isVisible(), 'the new 답글 is hidden while it loads');
        await b.getByTestId('thread-loading').waitFor({ state: 'detached', timeout: 10_000 });
        bPosts++;
      });

      await step(`${name} 5a. C's quote lands on beta's line`, async () => {
        await b.getByTestId('thread-answer').filter({ hasText: '경고 두 건은 내일' }).getByTestId('reply-quote').click();
        await room.locator('[data-chat-id][data-focused="true"]').filter({ hasText: '경고가 두 건' }).waitFor({ timeout: 5_000 });
      });
      await step(`${name} 5b. a 답글 in the folded A opens A`, async () => {
        await press(a.getByTestId('thread-fold'));
        await a.locator('[data-testid="thread-fold"][data-folded]').waitFor({ timeout: 5_000 });
        await a.scrollIntoViewIfNeeded();
        await a.hover();
        await a.getByTestId('message-actions').first().getByRole('button', { name: '답글' }).click();
        await room.getByRole('textbox', { name: '전체 메시지' }).fill('@alpha 롤백 계획도 알려 주세요');
        await room.getByRole('button', { name: '보내기', exact: true }).click();
        await a.getByTestId('thread-answer').filter({ hasText: '롤백 계획도' }).waitFor({ timeout: 20_000 });
        await a.getByText('롤백은 v1 태그로 돌려요').waitFor({ timeout: 25_000 });
        check((await a.locator('[data-testid="thread-fold"][data-folded]').count()) === 0, 'A is open after the reply');
        aExtra = 2;
      });
      await step(`${name} 5c. a search hit in the folded A opens it, loads it and lands on it`, async () => {
        await press(a.getByTestId('thread-fold'));
        await a.locator('[data-testid="thread-fold"][data-folded]').waitFor({ timeout: 5_000 });
        // a new page: the daemon let A's replies go with the old socket, so the hit has to load them
        await page.reload();
        await page.waitForURL(base);
        await page.getByRole('button', { name: /^메신저/ }).waitFor({ timeout: 60_000 });
        await page.waitForTimeout(2_500);
        const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
        if (await infoClose.count()) await infoClose.click().catch(() => undefined);
        if (!(await messenger.isVisible())) await page.getByRole('button', { name: /^메신저/ }).click();
        const find = messenger.getByRole('searchbox', { name: '대화 목록에서 찾기' });
        await find.fill('롤백 계획도');
        const hit = messenger.getByTestId('search-all').getByRole('button').filter({ hasText: '롤백 계획도' }).first();
        await hit.waitFor({ timeout: 15_000 });
        state.next = 'hold';
        await hit.click();
        const answer = a.getByTestId('thread-answer').filter({ hasText: '롤백 계획도' });
        await answer.waitFor({ timeout: 10_000 });
        await page.waitForTimeout(800);
        const inView = await answer.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const s = el.closest('[data-testid="room-scroll"]')!.getBoundingClientRect();
          return r.top >= s.top - 1 && r.bottom <= s.bottom + 1;
        });
        check(inView, 'the 답글 is in view');
        check((await a.locator('[data-testid="thread-fold"][data-folded]').count()) === 0, 'A is open');
        await shot('5-search-landing');
      });
      await ctx.close();
    };

    try {
      for (const [device, theme] of [['desktop', 'modern'], ['desktop', 'pixel'], ['phone', 'modern']] as const)
        if (!process.env.T0113_ONLY || process.env.T0113_ONLY === `${device}-${theme}`) await session(device, theme);
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

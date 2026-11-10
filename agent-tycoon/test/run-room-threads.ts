/**
 * ROOM-THREADS in the real messenger: dist/cli.js with --engine on --allow-chat in an isolated HOME
 * whose `claude` is the engine fake, headless Chromium (--disable-gpu), desktop 1280x1300.
 *
 * The 전체 room is seeded with many posts: an old tagged one whose reply is in alpha's transcript
 * from BEFORE a renew (the current conversation is another file), untagged ones, a 공지, a tagged
 * post beta never answered, and a recent one alpha answered.
 * 1. Scrolled to the top the oldest thread shows (the scroller keeps it) with its pre-renew reply,
 *    and it is not taken for waiting.
 * 2. Rails: the 공지 yellow, the unanswered tag the accent, the rest the neutral border.
 * 3. 답글 on a thread and sent: it shows inside that thread (no new thread), and alpha's answer to
 *    it under it.
 *
 *   npx tsx agent-tycoon/test/run-room-threads.ts <port 18530-18539>
 *
 * Screenshots: agent-tycoon/artifacts/room-threads-1104/*.png
 */
import type { Locator, Page } from '@playwright/test';
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
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
if (port < 18530 || port > 18539) throw new Error('this runner takes a port 18530-18539');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/room-threads-1104');
const DEADLINE_MS = 200_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__roomthreads/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const MIN = 60_000;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

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

  // ── The 전체 room's record (written before the daemon starts) ──
  const now = Date.now();
  const T = now - 120 * MIN;
  const post = (id: string, at: number, text: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 1, kind: 'post', post: { id, at, sender: null, roomName: '전체', text, targets: [], delivery: {}, ...over } });
  const OLD = { id: 'p0old', at: T, text: '@alpha 예전 질문: 배포 로그는 어디 있어요?', mark: 'aaaa2222' };
  const RECENT = { id: 'p9recent', at: now - 5 * MIN, text: '@alpha 배포 끝났나요?', mark: 'cccc4444' };
  const records = [
    post(OLD.id, OLD.at, OLD.text, { targets: ['alpha'], delivery: { alpha: 'delivered' }, messageIds: { alpha: OLD.mark } }),
    ...Array.from({ length: 12 }, (_, i) =>
      post(`p${i + 1}note`, T + (i + 1) * MIN, `메모 ${i + 1}: 오늘 할 일 정리. ${'점검 항목을 하나씩 적어 둡니다. '.repeat(3)}`),
    ),
    post('p7notice', now - 20 * MIN, '공지: 오늘 저녁 9시에 서버 점검이 있어요', {
      targets: ['alpha', 'beta'],
      delivery: { alpha: 'delivered', beta: 'delivered' },
      notice: true,
    }),
    post('p8wait', now - 10 * MIN, '@beta 테스트 결과 알려 주세요', {
      targets: ['beta'],
      delivery: { beta: 'delivered' },
      messageIds: { beta: 'bbbb3333' },
    }),
    post(RECENT.id, RECENT.at, RECENT.text, { targets: ['alpha'], delivery: { alpha: 'delivered' }, messageIds: { alpha: RECENT.mark } }),
  ];
  fs.mkdirSync(groupTimelineDir(home), { recursive: true });
  fs.writeFileSync(monthFile(groupTimelineDir(home), 'all', now), `${records.join('\n')}\n`);

  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const { child: server } = daemon;
  console.log(`port ${port}, daemon pid ${server.pid}`);
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null) server.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
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
  const record = (type: 'user' | 'assistant', at: number, text: string) =>
    `${JSON.stringify(
      type === 'user'
        ? { type, uuid: `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, timestamp: new Date(at).toISOString(), message: { role: type, content: text } }
        : { type, uuid: `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, timestamp: new Date(at).toISOString(), message: { role: type, content: [{ type: 'text', text }] } },
    )}\n`;
  const header = (p: { at: number; text: string; mark: string }) => `[사장 · 단톡방 '전체' · ${stamp(p.at)}] ⟨m:${p.mark}⟩\n${p.text}`;

  const browser = await launchBrowser();
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  try {
    for (const end = Date.now() + 40_000; !['alpha', 'beta'].every((n) => sessionOf(n)); ) {
      if (Date.now() > end) throw new Error('the engine did not revive alpha and beta');
      await new Promise((r) => setTimeout(r, 300));
    }
    // alpha: the conversation BEFORE its renew (another file in the same folder) answered the old
    // post; the current one began after it and answered the recent post.
    const alpha = sessionOf('alpha')!;
    const current = transcriptPath(alpha.cwd, alpha.sessionId, home);
    fs.mkdirSync(path.dirname(current), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(current), 'before-renew.jsonl'),
      record('user', T - 60 * MIN, '이전 대화 시작') +
        record('user', OLD.at + 1000, header(OLD)) +
        record('assistant', OLD.at + 2000, 'renew 전 답: 로그는 logs/deploy.log 에 있어요') +
        record('user', OLD.at + 3000, '[agty renew] 인수인계'),
    );
    fs.appendFileSync(
      current,
      record('user', RECENT.at - 60_000, '[agty renew] 새 대화로 이어 간다') +
        record('user', RECENT.at + 1000, header(RECENT)) +
        record('assistant', RECENT.at + 2000, '네, 배포 끝났어요'),
    );

    // alpha answers what the room types to it from now on (the 답글 below).
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
        fs.appendFileSync(current, record('user', at, item.text.replaceAll('\r', '\n')) + record('assistant', at + 1, '롤백은 v1 태그로 돌려요'));
      }
      seen = all.length;
    }, 100);

    try {
      const url = await daemon.loginUrl();
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 1300 } });
      await ctx.addInitScript('globalThis.__name = (fn) => fn;');
      if (fs.existsSync(FONT))
        await ctx.route('**/__roomthreads/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      await page.goto(url);
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
      if (await infoClose.count()) await infoClose.click();

      await page.getByRole('button', { name: /^메신저/ }).click();
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      await messenger.getByTestId('group-room-row-all').click();
      const room = messenger.getByTestId('group-room-screen-all');
      await room.waitFor();
      const threads = room.getByTestId('room-thread');
      const thread = (text: string): Locator => threads.filter({ hasText: text });
      await thread(RECENT.text).getByText('네, 배포 끝났어요').waitFor({ timeout: 20_000 });
      const scroller = room.getByTestId('room-scroll');

      // ── 1. Scroll up: the oldest thread shows, with its reply from before the renew ──
      const size = await scroller.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, top: el.scrollTop }));
      console.log(`  scroller ${JSON.stringify(size)}`);
      check(size.scroll > size.client + 200, 'the room overflows its pane (there is something to scroll up to)');
      check(size.top > 0, 'the room opens at its newest end');
      await scroller.hover();
      await page.mouse.wheel(0, -50_000);
      await page.waitForTimeout(3_500); // two view polls: a re-render must not throw the reader back down
      const top = await scroller.evaluate((el) => el.scrollTop);
      check(top < 20, `scrolled up, the room stays at its top over the polls (scrollTop ${top})`);
      const old = thread(OLD.text);
      await old.getByText('renew 전 답').waitFor({ timeout: 15_000 });
      const inView = await old.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const s = el.closest('[data-testid="room-scroll"]')!.getBoundingClientRect();
        return r.top >= s.top - 1 && r.top < s.bottom;
      });
      check(inView, 'the oldest thread is in view at the top');
      check(true, 'the old thread shows alpha\'s reply from before its renew');
      check((await old.getAttribute('data-tone')) === 'plain', 'the answered old thread is not taken for waiting');
      await shot(page, 'desktop-top-old-thread');

      // ── 2. Rails ──
      const rail = (l: Locator) =>
        l.evaluate((el) => {
          const c = getComputedStyle(el);
          return { tone: el.getAttribute('data-tone'), left: c.borderLeftColor, width: c.borderLeftWidth, top: c.borderTopColor };
        });
      const notice = await rail(thread('공지: 오늘 저녁'));
      const waiting = await rail(thread('@beta 테스트 결과'));
      const plain = await rail(thread('메모 12:'));
      console.log(`  rails ${JSON.stringify({ notice, waiting, plain })}`);
      check(notice.tone === 'notice' && waiting.tone === 'waiting' && plain.tone === 'plain', 'tones: notice, waiting, plain');
      check(plain.left === plain.top, 'a plain thread has the neutral border all round');
      check(new Set([notice.left, waiting.left, plain.left]).size === 3, 'the notice, waiting and plain rails differ in colour');
      const tones = await threads.evaluateAll((all) => all.map((n) => n.getAttribute('data-tone')));
      check(tones.filter((x) => x === 'waiting').length === 1, `exactly one thread waits (${tones.join(',')})`);

      // ── 3. 답글 on the recent thread: it joins that thread ──
      const before = await threads.count();
      const recent = thread(RECENT.text);
      await recent.scrollIntoViewIfNeeded();
      await recent.hover();
      await recent.getByTestId('message-actions').first().getByRole('button', { name: '답글' }).click();
      const composer = room.getByRole('textbox', { name: '전체 메시지' });
      await composer.fill('@alpha 롤백 계획도 알려 주세요');
      await room.getByRole('button', { name: '보내기', exact: true }).click();
      const answer = recent.getByTestId('thread-answer').filter({ hasText: '롤백 계획도' });
      await answer.waitFor({ timeout: 20_000 });
      await answer.getByText('롤백은 v1 태그로 돌려요').waitFor({ timeout: 20_000 });
      check(true, 'the 답글 shows inside its thread, alpha\'s answer under it');
      check((await threads.count()) === before, 'no new thread at the bottom');
      check((await answer.getByTestId('reply-arrow').count()) >= 2, 'the 답글 and its answer carry the arrow');
      await page.waitForTimeout(1_600);
      check((await recent.getAttribute('data-tone')) === 'plain', 'answered, the thread is plain again');
      await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await page.waitForTimeout(500);
      await shot(page, 'desktop-rails-and-thread-reply');
      await ctx.close();
    } finally {
      clearInterval(replier);
    }
    console.log('done');
  } finally {
    await browser.close().catch(() => undefined);
    if (server.exitCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(force);
    }
    clearTimeout(deadline);
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

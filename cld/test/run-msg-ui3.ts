/**
 * MSG-UI3 in the real messenger: dist/cli.js with --engine on --allow-chat in an isolated HOME
 * whose `claude` is the engine fake, headless Chromium (--disable-gpu), desktop and phone 393x852.
 *
 * 1. Settings: "내 프사" uploads a picture (cropped square, 128x128); the owner's faces show it;
 *    the daemon serves it to the logged-in browser and the stored file is 0600.
 * 2. A DM: a sub-agent's task notice names its temp employee; the owner's messages carry a face
 *    column mirroring the others, and every bubble shares one column width.
 * 3. A room (출시팀): 답글 on a member's reply pre-fills `@<member> `; on the owner's own post it
 *    does not. Each thread is one block (rail, background) and its replies carry the pixel arrow.
 *
 *   npx tsx cld/test/run-msg-ui3.ts <port 18256-18259>
 *
 * Screenshots: cld/artifacts/msg-ui3/*.png
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/msg-ui3');
const DEADLINE_MS = 280_000;
const PHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 } };
})();
const CLIP = ['clipboard-read', 'clipboard-write'];
const PHONE_390 = { ...PHONE, viewport: { width: 390, height: 844 } };
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__msgui3/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const PNG = path.join(REPO_ROOT, 'webview-ui/public/assets/characters/char_0.png');

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      ['alpha', 'beta', 'gamma'].map((name) => {
        const dir = path.join(home, 'work', name);
        fs.mkdirSync(dir, { recursive: true });
        return { name, folder: dir, room: '개발실', wantRunning: true };
      }),
    ),
  );
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

  // ── Claude, played: records go into the session's transcript; each returns its chat item id ──
  type Sess = { sessionId: string; cwd: string; name: string; jobId: string };
  const sessionOf = (name = 'alpha'): Sess | null => {
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
  // Seeded history an hour back, a second apart; what follows the seeding is written now.
  let clock = Date.now() - 3_600_000;
  let seeding = true;
  const say = (role: 'user' | 'assistant', text: string, who = 'alpha'): string => {
    const s = sessionOf(who)!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    clock = seeding ? clock + 1000 : Math.max(clock + 1, Date.now());
    const timestamp = new Date(clock).toISOString();
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
    return `${clock}-${id.slice(0, 8)}-0`;
  };
  const typedLog = path.join(home, 'fake-claude-typed.log');
  const typed = () =>
    fs.existsSync(typedLog)
      ? fs
          .readFileSync(typedLog, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { text: string }).text.replaceAll('\r', '\n'))
      : [];
  const waitTyped = async (needle: string) => {
    for (const end = Date.now() + 20_000; Date.now() < end;) {
      const hit = typed().find((t) => t.includes(needle));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`the fake claude never received ${JSON.stringify(needle)}`);
  };

  const browser = await launchBrowser();
  /** tsx names the arrow functions it passes to evaluate: give the page the helper it calls. */
  const nameShim = 'globalThis.__name = (fn) => fn;';
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const clip = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
  const clearClip = (page: Page) => page.evaluate(() => navigator.clipboard.writeText('-'));
  const row = (conv: Locator, id: string) => conv.locator(`[data-chat-id="${id}"]`);
  const inView = (loc: Locator) =>
    loc.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const list = el.closest('[data-testid="chat-scroll"]')!.getBoundingClientRect();
      return r.bottom > list.top && r.top < list.bottom;
    });
  const flashed = (loc: Locator) =>
    loc.evaluate(
      (el) =>
        new Promise<boolean>((done) => {
          const end = Date.now() + 10_000;
          const tick = () =>
            el.dataset.focused === 'true'
              ? done(true)
              : Date.now() > end
                ? done(false)
                : setTimeout(tick, 50);
          tick();
        }),
    );

  try {
    for (const end = Date.now() + 40_000; !['alpha', 'beta', 'gamma'].every((n) => sessionOf(n));) {
      if (Date.now() > end) throw new Error('the engine did not revive alpha, beta and gamma');
      await new Promise((r) => setTimeout(r, 300));
    }
    const LONG = '긴 글 확인용 문장입니다. '.repeat(24);
    say('user', `[사장 · 메신저 · 10-24 12:00] ⟨m:bbbb3333⟩\n${LONG}`);
    const leadLong = say('assistant', LONG);
    // A sub-agent spawn the lead made (it binds a temp employee), and its work notice.
    const lead = sessionOf('alpha')!;
    fs.appendFileSync(
      transcriptPath(lead.cwd, lead.sessionId, home),
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'ffffffff-0000-4000-8000-000000000001',
        timestamp: new Date(clock + 1).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_ui3', name: 'Task', input: { description: '로그 정리', prompt: 'x' } }],
        },
      })}\n`,
    );
    const noticeId = say(
      'user',
      '<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>toolu_ui3</tool-use-id>\n<status>completed</status>\n<summary>로그 정리 끝</summary>\n<result>오류 0건</result>\n</task-notification>',
    );
    const unknownId = say(
      'user',
      '<task-notification>\n<task-id>t2</task-id>\n<tool-use-id>toolu_gone</tool-use-id>\n<status>completed</status>\n<summary>다른 일 끝</summary>\n</task-notification>',
    );
    const bossShort = say('user', '[사장 · 메신저 · 10-24 12:01] ⟨m:cccc4444⟩\n고마워요');
    seeding = false;
    await new Promise((r) => setTimeout(r, 3_000));
    const url = await daemon.loginUrl();

    const REPLIES: Record<string, string> = {
      alpha: '알파 확인했어요: 배포는 문제없어요',
      beta: '베타도 확인했어요',
      gamma: '감마 확인 완료',
    };
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
        const who = ['alpha', 'beta', 'gamma'].find((n) => sessionOf(n)?.jobId === item.id);
        if (!who || !item.text.includes("단톡방 '출시팀'")) continue;
        say('user', item.text.replaceAll('\r', '\n'), who);
        say('assistant', REPLIES[who], who);
      }
      seen = all.length;
    }, 100);

    /** The DM's columns: the faces sit as far from their edge on both sides, every bubble has one width. */
    const columns = (conv: Locator) =>
      conv.evaluate((el) => {
        const list = el.querySelector('[data-testid="chat-scroll"]')!.getBoundingClientRect();
        const left = (el.querySelector('[data-testid="sender-face"]') as HTMLElement).getBoundingClientRect();
        const right = (el.querySelector('[data-testid="owner-face"]') as HTMLElement).getBoundingClientRect();
        const width = (sel: string) =>
          Math.max(
            ...[...el.querySelectorAll<HTMLElement>(sel)].map((n) => n.getBoundingClientRect().width),
          );
        return {
          gapLeft: left.left - list.left,
          gapRight: list.right - right.right,
          boss: width('[data-from="boss"] .border'),
          lead: width('[data-testid="chat-scroll"] > div > div:not([data-from]) .border'),
        };
      });
    const checkColumns = async (conv: Locator, tag: string) => {
      const c = await columns(conv);
      console.log(`  ${tag} columns: ${JSON.stringify(c)}`);
      check(Math.abs(c.gapLeft - c.gapRight) <= 2, `${tag}: the agent face and the owner face sit equally far from their edges`);
      check(Math.abs(c.boss - c.lead) <= 2, `${tag}: the owner's and the Lead's long bubbles have one width`);
    };
    const openDm = async (page: Page, touch: boolean) => {
      const tap = (l: Locator) => (touch ? l.tap() : l.click());
      await tap(page.getByRole('button', { name: /^메신저/ }));
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      await tap(messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }));
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      await row(conv, bossShort).waitFor();
      await conv.getByTestId('chat-scroll').evaluate((s) => (s.scrollTop = s.scrollHeight));
      return conv;
    };
    const noticeLabel = (conv: Locator, id: string) => row(conv, id).getByTestId('from-name').innerText();

    try {
      // ════ Desktop ════
      const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await deskCtx.addInitScript(nameShim);
      if (fs.existsSync(FONT))
        await deskCtx.route('**/__msgui3/malgun.ttf', (route) =>
          route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
        );
      const page = await deskCtx.newPage();
      page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      await page.goto(url);
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
      if (await infoClose.count()) await infoClose.click();

      // — The DM before any picture: the default owner icon, the named notice, aligned columns.
      let conv = await openDm(page, false);
      check(
        (await conv.getByTestId('owner-face').first().getAttribute('data-picture')) === 'default',
        'default: the owner face is the drawn default before a picture is set',
      );
      const named = await noticeLabel(conv, noticeId);
      check(/^.+ · 작업 알림$/.test(named), `notice: a known sub-agent shows its employee name (${named})`);
      check((await noticeLabel(conv, unknownId)) === '작업 알림', 'notice: an unknown execution keeps the plain label');
      await checkColumns(conv, 'desktop');
      await shot(page, 'desktop-dm-default-owner');

      // — Settings: pick a picture (the repo's own sprite sheet stands in), it shows everywhere.
      await page.getByRole('button', { name: '설정', exact: true }).click();
      await page.getByRole('tab', { name: '일반', exact: true }).click();
      const option = page.getByTestId('owner-picture-option');
      await option.waitFor();
      await option.getByTestId('owner-picture-input').setInputFiles(PNG);
      await option.locator('[data-testid="owner-face"][data-picture="custom"]').waitFor({ timeout: 10_000 }).catch(async (e) => {
        console.log(`  settings row: ${await option.innerText()}`);
        await shot(page, 'debug-settings');
        throw e;
      });
      check(true, 'settings: the picked picture shows in the settings row');
      await shot(page, 'desktop-settings-picture');
      const served = await page.evaluate(async () => {
        const r = await fetch('cld/profile/owner.png', { credentials: 'same-origin' });
        const bytes = new Uint8Array(await r.arrayBuffer());
        const view = new DataView(bytes.buffer);
        return { status: r.status, type: r.headers.get('content-type'), w: view.getUint32(16), h: view.getUint32(20) };
      });
      check(served.status === 200 && served.type === 'image/png' && served.w === 128 && served.h === 128, `server: serves a 128x128 PNG (${JSON.stringify(served)})`);
      const stored = path.join(configDirectory(home), 'profile/owner.png');
      check((fs.statSync(stored).mode & 0o777) === 0o600, 'server: the stored file is 0600');
      const anon = await fetch(`http://127.0.0.1:${port}/cld/profile/owner.png`);
      check(anon.status === 401, 'server: no login, no picture');
      await page.mouse.click(40, 600); // the backdrop closes the dialog
      await page.waitForTimeout(500);
      await shot(page, 'desktop-after-settings');
      conv = await openDm(page, false).catch(async () => page.getByRole('region', { name: 'alpha 대화' }));
      check(
        (await conv.getByTestId('owner-face').first().getAttribute('data-picture')) === 'custom',
        'picture: the owner faces in the DM now show it',
      );
      await checkColumns(conv, 'desktop+picture');
      await shot(page, 'desktop-dm-owner-picture');

      // — A room: reply → tag; threads as blocks.
      const dm = page.getByRole('region', { name: '메신저', exact: true });
      await dm.getByRole('button', { name: '‹ 목록' }).first().click().catch(() => undefined);
      const rooms = dm.getByRole('region', { name: '단톡방' });
      await rooms.getByRole('button', { name: '+ 방 만들기' }).click();
      await rooms.getByRole('textbox', { name: '방 이름' }).fill('출시팀');
      for (const name of ['alpha', 'beta', 'gamma']) await rooms.getByLabel(name).check();
      await rooms.getByRole('button', { name: '저장' }).click();
      await rooms.getByRole('button', { name: /^출시팀/ }).click();
      const room = dm.getByTestId(/group-room-screen-/);
      await room.waitFor();
      const composer = room.getByRole('textbox', { name: '출시팀 메시지' });
      await composer.fill('@');
      await room.getByRole('option', { name: '@전체' }).click();
      await composer.type('배포 상황 알려 주세요');
      await room.getByRole('button', { name: '보내기', exact: true }).click();
      for (const who of ['gamma', 'alpha', 'beta']) await room.getByText(REPLIES[who]).waitFor({ timeout: 30_000 });
      await composer.fill('두 번째 질문: 롤백 계획도 알려 주세요');
      await room.getByRole('button', { name: '보내기', exact: true }).click().catch(() => undefined);
      await page.waitForTimeout(800);
      await shot(page, 'desktop-room-threads');
      check((await room.getByTestId('reply-arrow').count()) >= 3, 'room: every thread reply carries the pixel arrow');
      check((await room.getByTestId('room-thread').count()) >= 1, 'room: each thread is one block');
      const tones = await room.getByTestId('room-thread').evaluateAll((all) => all.map((n) => getComputedStyle(n).borderLeftWidth));
      check(tones.every((w) => w === '2px'), `room: a 2px rail on each thread (${tones})`);
      const betaReply = room.locator('[data-chat-id]').filter({ hasText: REPLIES.beta }).first();
      await betaReply.hover();
      await betaReply.getByRole('button', { name: '답글' }).first().click();
      check((await composer.inputValue()) === '@beta ', `room: 답글 on beta's reply pre-fills "@beta " (${JSON.stringify(await composer.inputValue())})`);
      await shot(page, 'desktop-room-reply-prefill');
      await room.getByRole('button', { name: /답글 취소/ }).first().click().catch(() => undefined);
      await composer.fill('');
      const mine = room.getByTestId('room-thread').first();
      await mine.hover();
      await mine.getByRole('button', { name: '답글' }).first().click();
      check((await composer.inputValue()) === '', 'room: 답글 on the owner\'s own post adds no tag');
      await composer.fill('');

      // ════ Phone 393x852 ════
      const ctx2 = await browser.newContext({ ...PHONE, storageState: await deskCtx.storageState() });
      await ctx2.addInitScript(nameShim);
      if (fs.existsSync(FONT))
        await ctx2.route('**/__msgui3/malgun.ttf', (route) =>
          route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
        );
      const p2 = await ctx2.newPage();
      p2.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      await p2.goto(`http://127.0.0.1:${port}/`);
      await p2.addStyleTag({ content: FONT_CSS });
      await p2.getByRole('button', { name: /^메신저/ }).waitFor();
      const conv2 = await openDm(p2, true);
      await p2.waitForTimeout(500);
      check(
        /^.+ · 작업 알림$/.test(await noticeLabel(conv2, noticeId)),
        'phone: the named task notice',
      );
      await checkColumns(conv2, 'phone');
      await shot(p2, 'phone-dm-columns');
      const msg2 = p2.getByRole('region', { name: '메신저', exact: true });
      await msg2.getByRole('button', { name: '‹ 목록' }).first().tap();
      await msg2.getByRole('region', { name: '단톡방' }).getByRole('button', { name: /^출시팀/ }).tap();
      const room2 = msg2.getByTestId(/group-room-screen-/);
      await room2.waitFor();
      await room2.getByText(REPLIES.beta).waitFor();
      await shot(p2, 'phone-room-threads');
      check((await room2.getByTestId('reply-arrow').count()) >= 3, 'phone room: reply arrows');
      const overflow = await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      check(overflow, 'phone room: no horizontal page scroll');
      await ctx2.close();

      // — Reset: back to the default icon.
      await page.getByRole('button', { name: '설정', exact: true }).click();
      await page.getByRole('tab', { name: '일반', exact: true }).click();
      await page.getByTestId('owner-picture-option').getByRole('button', { name: '기본으로' }).click();
      await page.getByTestId('owner-picture-option').locator('[data-testid="owner-face"][data-picture="default"]').waitFor();
      check(!fs.existsSync(stored), 'reset: the stored file is gone and the default icon is back');
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

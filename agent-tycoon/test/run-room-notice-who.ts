/**
 * T-110: a room notice shows which members received it. dist/cli.js with --engine on --allow-chat in a temp HOME
 * whose `claude` is the engine fake. The 전체 room is seeded with one notice to four members, two delivered, one
 * waiting and one left in its inbox. Per session (desktop 모던, desktop 픽셀 감성, phone 390x844 in 모던; Chromium
 * --disable-gpu, the phone with touch):
 *  1. the notice's mode line is a button, folded: no member tag under the notice;
 *  2. a tap opens it: one tag per target, the names and states those the server sent in its groupTimeline
 *     frame (read off the WebSocket, not off the page), the delivered ones first;
 *  3. another tap folds it.
 *
 *   npx tsx agent-tycoon/test/run-room-notice-who.ts <port 19420-19429>
 *
 * Pictures `<session>-notice-folded.png` and `-notice-open.png` and run.log in agent-tycoon/artifacts/t0110/.
 */
import type { Browser, BrowserContextOptions, Locator, WebSocket } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { monthFile } from '../../server/src/agent-tycoon/engine/groupLogFiles.js';
import { groupTimelineDir } from '../../server/src/agent-tycoon/engine/groups.js';
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
if (!(port >= 19420 && port <= 19429)) throw new Error('port must be 19420-19429');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/t0110');
const DEADLINE_MS = 240_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0110/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const MIN = 60_000;
const MEMBERS = ['alpha', 'beta', 'gamma', 'delta'];
const NOTICE = '공지: 오늘 저녁 9시에 서버 점검이 있어요';
const STORE: Record<string, string> = { 'agty.title-scene': 'off', 'agty.office-iso': 'on', 'agty.floor': '1', 'agty.floor-view': 'one' };
const lines: string[] = [];
const log = (s: string) => (lines.push(s), console.log(s));
let failures = 0;

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      MEMBERS.map((name) => {
        const dir = path.join(home, 'work', name);
        fs.mkdirSync(dir, { recursive: true });
        return { name, folder: dir, room: '개발실', wantRunning: true };
      }),
    ),
  );

  const now = Date.now();
  const post = (id: string, at: number, text: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 1, kind: 'post', post: { id, at, sender: null, roomName: '전체', text, targets: [], delivery: {}, ...over } });
  const records = [
    post('p0plain', now - 40 * MIN, '오늘 배포 일정을 공유드려요. 저녁 9시에 점검이 있습니다.'),
    post('p7notice', now - 20 * MIN, NOTICE, {
      targets: MEMBERS,
      delivery: { alpha: 'pending', beta: 'delivered', gamma: 'off', delta: 'delivered' },
      notice: true,
    }),
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

  let browser: Browser | undefined;
  try {
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
        await ctx.route('**/__t0110/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      const page = await ctx.newPage();
      page.on('pageerror', (e) => log(`  [pageerror] ${e.message}`));
      // What the server sent for the notice: its groupTimeline frame, read off the socket.
      let sent: { targets: string[]; delivery: Record<string, string> } | null = null;
      page.on('websocket', (ws: WebSocket) =>
        ws.on('framereceived', ({ payload }) => {
          if (typeof payload !== 'string' || !payload.includes('groupTimeline')) return;
          try {
            const msg = JSON.parse(payload) as { type?: string; posts?: Array<{ text: string; targets: string[]; delivery: Record<string, string> }> };
            const found = msg.type === 'groupTimeline' ? msg.posts?.find((p) => p.text === NOTICE) : undefined;
            if (found) sent = { targets: found.targets, delivery: found.delivery };
          } catch {
            /* not ours */
          }
        }),
      );
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
        await page.screenshot({ path: path.join(OUT, `${name}-notice-${what}.png`) });
      };
      const press = (l: Locator) => (phone ? l.tap() : l.click());
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      if (phone) await page.locator('[data-dock="messenger"]').tap();
      else await page.getByRole('button', { name: /^메신저/ }).click();
      await press(messenger.getByTestId('group-room-row-all'));
      const room = messenger.getByTestId('group-room-screen-all');
      await room.waitFor({ timeout: 15_000 });
      const notice = room.getByTestId('room-thread').filter({ hasText: NOTICE });
      await notice.waitFor({ timeout: 20_000 });
      const toggle = notice.getByTestId('room-mode');
      const tags = notice.locator('.room-tag');

      await step(`${name} 1. folded: the mode line is a button and no member tag shows`, async () => {
        await notice.scrollIntoViewIfNeeded();
        check((await toggle.evaluate((el) => el.tagName)) === 'BUTTON', 'the mode line is a button');
        check((await toggle.getAttribute('aria-expanded')) === 'false', 'aria-expanded is false');
        check(/전달됨/.test(await toggle.innerText()), 'the line still says 전달됨');
        check((await tags.count()) === 0, 'no member tag under the notice');
        await shot('folded');
      });
      await step(`${name} 2. a tap shows one tag per target, as the server sent them, delivered first`, async () => {
        await press(toggle);
        await tags.first().waitFor({ timeout: 5_000 });
        check((await toggle.getAttribute('aria-expanded')) === 'true', 'aria-expanded is true');
        const frame = sent as { targets: string[]; delivery: Record<string, string> } | null;
        check(frame, 'the groupTimeline frame with the notice was seen on the socket');
        const states = Object.values(frame!.delivery);
        check(states.includes('delivered') && states.some((s) => s !== 'delivered'), 'the server sent a mix of delivered and not');
        const shown = await tags.evaluateAll((all) =>
          all.map((el) => ({ text: (el.textContent ?? '').trim(), state: el.getAttribute('data-state') })),
        );
        check(shown.length === frame!.targets.length, `${shown.length} tags for ${frame!.targets.length} targets`);
        // the order the server's data gives: delivered first, the rest in the room's (target) order
        const order = [...frame!.targets.filter((m) => frame!.delivery[m] === 'delivered'), ...frame!.targets.filter((m) => frame!.delivery[m] !== 'delivered')];
        order.forEach((member, i) => {
          check(shown[i].text.startsWith(`${member}:`), `tag ${i} is ${member} (${shown[i].text})`);
          check(shown[i].state === frame!.delivery[member], `${member}: data-state ${shown[i].state} is what the server sent (${frame!.delivery[member]})`);
        });
        log(`     tags: ${shown.map((s) => `${s.text} [${s.state}]`).join(' | ')}`);
        if (phone) {
          const wide = await room.getByTestId('room-scroll').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
          check(!wide, 'the tags wrap, the room does not scroll sideways');
        }
        await shot('open');
      });
      await step(`${name} 3. a second tap folds it again`, async () => {
        await press(toggle);
        await page.waitForTimeout(300);
        check((await tags.count()) === 0, 'the tags are gone');
        check((await toggle.getAttribute('aria-expanded')) === 'false', 'aria-expanded is false again');
      });
      await ctx.close();
    };

    for (const [device, theme] of [['desktop', 'modern'], ['desktop', 'pixel'], ['phone', 'modern']] as const) await session(device, theme);
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

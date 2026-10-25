/**
 * ROOM-UNREAD browser check: a group room that was read in full shows no red +n again by itself
 * (a daemon restart, a page reload), and something actually new still shows 1.  Members answer in
 * the opposite order to the room view's (beta first, alpha later), the case where a rebuilt id
 * list is not in time order.  Desktop 1280x800 and phone 393x852, temp HOME, own port, headless
 * Chromium with --disable-gpu (launchBrowser):
 *
 *   npx tsx cld/test/run-room-unread.ts <port 18256-18259>
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
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

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/room-unread');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__roomunread/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 280_000;
const PHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 } };
})();
const ROOM = '출시팀';
const REPLIES: Record<string, string> = { alpha: 'alpha: 배포 준비를 마쳤어요.', beta: 'beta: GPU 대기열을 확인했어요.' };
const ALPHA_LATE_MS = 700;

const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => boolean | Promise<boolean>, timeout = 20_000) {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (await test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin, claudePath } = makeEngineHome();
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
  const members = Object.keys(REPLIES);
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/projects.json'),
    JSON.stringify(
      members.map((name) => {
        const folder = path.join(home, 'work', name);
        fs.mkdirSync(folder, { recursive: true });
        return { name, folder, room: '개발실', wantRunning: true };
      }),
    ),
  );
  const start = () =>
    startDaemon({ home, claudePath }, port, ['--engine', 'on', '--allow-chat', '--no-terminal'], {
      FAKE_TURN_MS: '400',
    });
  let daemon = start();
  let browser: Browser | undefined;
  let replier: ReturnType<typeof setInterval> | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    type Session = { name: string; jobId: string; cwd: string; sessionId: string };
    const session = (name: string): Session | null => {
      const dir = path.join(home, '.claude/sessions');
      for (const file of fs.readdirSync(dir)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Session;
          if (parsed.name === name) return parsed;
        } catch {
          /* a fake is writing */
        }
      }
      return null;
    };
    await eventually('fake sessions', () => members.every((name) => session(name)));
    let serial = 0;
    const say = (name: string, role: 'user' | 'assistant', text: string) => {
      const s = session(name)!;
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const uuid = `${(++serial).toString(16).padStart(8, '0')}-0099-4000-8000-000000000000`;
      const message =
        role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] };
      fs.appendFileSync(
        file,
        `${JSON.stringify({ type: role, uuid, timestamp: new Date().toISOString(), message })}\n`,
      );
    };
    const typed = () => {
      const file = path.join(home, 'fake-claude-typed.log');
      return fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string })
        : [];
    };
    let seen = 0;
    let hold = false;
    replier = setInterval(() => {
      if (hold) return;
      const all = typed();
      for (const item of all.slice(seen)) {
        const name = members.find((member) => session(member)?.jobId === item.id);
        if (!name) continue;
        say(name, 'user', item.text.replaceAll('\r', '\n'));
        if (!item.text.includes(`단톡방 '${ROOM}'`)) continue;
        // beta at once, alpha later: the live ids arrive beta, alpha; a rebuild lists alpha, beta.
        if (name === 'alpha') setTimeout(() => say(name, 'assistant', REPLIES[name]), ALPHA_LATE_MS);
        else say(name, 'assistant', REPLIES[name]);
      }
      seen = all.length;
    }, 100);

    browser = await launchBrowser();
    const open = async (opts: BrowserContextOptions, touch: boolean) => {
      const ctx = await browser!.newContext(opts);
      if (fs.existsSync(FONT))
        await ctx.route('**/__roomunread/malgun.ttf', (route) =>
          route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
        );
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      return { ctx, page, touch };
    };
    const desk = await open({ viewport: { width: 1280, height: 800 } }, false);
    await desk.page.goto(await daemon.loginUrl());
    await desk.page.waitForURL(`http://127.0.0.1:${port}/`);
    const phone = await open({ ...PHONE, storageState: await desk.ctx.storageState() }, true);
    await phone.page.goto(`http://127.0.0.1:${port}/`);
    const devices_ = [
      { name: 'desktop', ...desk },
      { name: 'phone', ...phone },
    ];

    const messenger = (page: Page) => page.getByRole('region', { name: '메신저', exact: true });
    const rooms = (page: Page) => messenger(page).getByRole('region', { name: '단톡방' });
    const tap = (d: { touch: boolean }, l: ReturnType<Page['locator']>) => (d.touch ? l.tap() : l.click());
    const prepare = async (page: Page) => {
      await page.addStyleTag({ content: FONT_CSS });
      const info = page.getByRole('button', { name: '정보 창 닫기' });
      if (await info.count()) await info.click();
    };
    const openList = async (d: (typeof devices_)[number]) => {
      await prepare(d.page);
      if (!(await rooms(d.page).count())) await tap(d, d.page.getByRole('button', { name: /^메신저/ }));
      await rooms(d.page).waitFor();
    };
    const label = (page: Page) =>
      rooms(page).getByRole('button', { name: new RegExp(`^${ROOM}`) }).first().getAttribute('aria-label');
    const toList = async (d: (typeof devices_)[number]) => {
      const close = messenger(d.page).getByRole('button', { name: `${ROOM} 방 닫기` });
      if (await close.count()) await tap(d, close);
      else await tap(d, messenger(d.page).getByRole('button', { name: /목록/ }).first());
      await rooms(d.page).getByRole('button', { name: new RegExp(`^${ROOM}`) }).first().waitFor();
    };
    const openRoom = async (d: (typeof devices_)[number]) => {
      await tap(d, rooms(d.page).getByRole('button', { name: new RegExp(`^${ROOM}`) }).first());
      await messenger(d.page).getByTestId(/group-room-screen-/).waitFor();
    };
    const shot = (d: (typeof devices_)[number], name: string) =>
      d.page.screenshot({ path: path.join(OUT, `${d.name}-${name}.png`) });
    /** Stays read: the label is the bare room name for a few seconds (the badge would appear on the next list). */
    const quiet = async (d: (typeof devices_)[number], what: string) => {
      await wait(2_500);
      const l = await label(d.page);
      check(l === ROOM, `${d.name}: ${what}: no unread (label "${l}")`);
    };

    // 1. Create the room on the desktop, post to everyone; both members answer (beta first).
    await openList(desk);
    await rooms(desk.page).getByRole('button', { name: '+ 방 만들기' }).click();
    await rooms(desk.page).getByRole('textbox', { name: '방 이름' }).fill(ROOM);
    for (const name of members) await rooms(desk.page).getByLabel(name).check();
    await rooms(desk.page).getByRole('button', { name: '저장' }).click();
    await openList(phone);
    await openRoom(desk);
    const room = messenger(desk.page).getByTestId(/group-room-screen-/);
    const composer = room.getByRole('textbox', { name: `${ROOM} 메시지` });
    await composer.fill('@');
    await room.getByRole('option', { name: '@전체' }).click();
    await composer.fill('@전체 출시 준비를 알려줘');
    await room.getByRole('button', { name: '보내기', exact: true }).click();
    for (const reply of Object.values(REPLIES)) await room.getByText(reply).waitFor({ timeout: 20_000 });
    await openRoom(phone); // the phone reads it too
    for (const reply of Object.values(REPLIES))
      await messenger(phone.page).getByText(reply).first().waitFor({ timeout: 20_000 });
    await toList(desk);
    await toList(phone);
    for (const d of devices_) {
      await quiet(d, 'read in full');
      await shot(d, '1-read');
    }

    // 2. (b) a page reload.
    for (const d of devices_) {
      await d.page.reload();
      await openList(d);
      await quiet(d, 'after a page reload');
    }

    // 3. (a) a daemon restart (this runner's own), then the pages reload.
    await daemon.stop();
    daemon = start();
    await daemon.loginUrl();
    await eventually('both fake sessions back', () => members.every((name) => session(name)));
    for (const d of devices_) {
      await d.page.reload();
      await openList(d);
      await quiet(d, 'after a daemon restart + reload');
      await shot(d, '2-after-restart');
    }

    // 4. (d) the owner's own post counts for nobody; (e) a member's real new reply counts 1.
    hold = true;
    await openRoom(desk);
    await composer.fill('@alpha 혼자 확인해줘');
    await room.getByRole('button', { name: '보내기', exact: true }).click();
    await room.getByText('@alpha 혼자 확인해줘').waitFor({ timeout: 20_000 });
    await toList(desk);
    for (const d of devices_) await quiet(d, "the owner's own post");
    hold = false;
    for (const d of devices_) {
      await eventually(`${d.name}: a new reply shows 1`, async () => (await label(d.page)) === `${ROOM} 안 읽음 1`, 30_000);
      check(true, `${d.name}: a real new member reply raises the badge to 1`);
      await shot(d, '3-new-reply');
    }
    console.log('done');
  } finally {
    if (replier) clearInterval(replier);
    clearTimeout(deadline);
    await browser?.close().catch(() => undefined);
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);

/**
 * MSG-SENDFILE: a file an agent sends with SendUserFile in the MIDDLE of a turn (more tool calls
 * follow, no final text yet) shows as an attachment card that opens the viewer, in the agent's DM
 * and in a room (단톡방) turn, while the turn runs and after it ends, desktop and phone 393x852.
 * dist/cli.js with --engine on --allow-chat in an isolated HOME whose `claude` is the engine fake,
 * headless Chromium (--disable-gpu).
 *
 *   npx tsx cld/test/run-msg-sendfile.ts <port 18256-18259>
 *
 * Screenshots: cld/artifacts/msg-sendfile/*.png
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/msg-sendfile');
const DEADLINE_MS = 280_000;
const PHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 } };
})();
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__msf/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

function picture(w: number, h: number, base: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const line = x % 50 === 0 || y % 50 === 0;
      for (let c = 0; c < 3; c++)
        png.data[i + c] = line ? 255 : Math.round((base[c] * (x + y)) / (w + h));
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(configDirectory(home), { recursive: true });
  const folders: Record<string, string> = {};
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      ['alpha', 'beta'].map((name) => {
        const dir = (folders[name] = path.join(home, 'work', name));
        fs.mkdirSync(dir, { recursive: true });
        return { name, folder: dir, room: '개발실', wantRunning: true };
      }),
    ),
  );
  const drafts = ['dm-1.png', 'dm-2.png', 'room-1.png', 'room-2.png'].map((n, i) => {
    const file = path.join(folders.alpha, n);
    fs.writeFileSync(file, picture(300, 200, [[255, 90, 60], [60, 200, 120], [80, 120, 255], [230, 190, 40]][i] as [number, number, number]));
    return file;
  });
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const { child: server } = daemon;
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
  let clock = Date.now() - 60_000;
  /** One transcript record per content block, as Claude Code writes them. */
  const rec = (role: 'user' | 'assistant', content: unknown, who = 'alpha') => {
    const s = sessionOf(who)!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    clock = Math.max(clock + 1000, Date.now());
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        type: role,
        uuid: `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
        timestamp: new Date(clock).toISOString(),
        message: { role, content },
      })}\n`,
    );
  };
  const tool = (name: string, input: unknown) => {
    const id = `toolu_${++uuid}`;
    return [
      () => rec('assistant', [{ type: 'tool_use', id, name, input }]),
      () => rec('user', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]),
    ];
  };
  /** The turn up to the point the bug needs: a tool call, the send, more tool calls; no final text. */
  const midTurn = (files: string[], caption: string) => {
    for (const step of [
      ...tool('Bash', { command: 'ls', description: '목록' }),
      ...tool('SendUserFile', { files, caption, status: 'proactive' }),
      ...tool('Bash', { command: 'pwd', description: '위치' }),
      ...tool('Read', { file_path: '/tmp/x' }),
    ])
      step();
  };

  const typedLog = path.join(home, 'fake-claude-typed.log');
  const typedRaw = () =>
    fs.existsSync(typedLog)
      ? fs.readFileSync(typedLog, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string })
      : [];
  const browser = await launchBrowser();
  const nameShim = 'globalThis.__name = (fn) => fn;';
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const card = (scope: Locator, name: string) => scope.locator(`[title$="${name}"]`);
  const opens = async (page: Page, scope: Locator, name: string, touch: boolean) => {
    await (touch ? card(scope, name).tap() : card(scope, name).click());
    await page.locator('[data-testid="attach-viewer"]').waitFor({ timeout: 10_000 });
    await page.locator('[data-testid="attach-img"]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('[data-testid="attach-viewer"]').waitFor({ state: 'detached' }).catch(() => undefined);
  };
  let replier: ReturnType<typeof setInterval> | undefined;
  try {
    for (const end = Date.now() + 40_000; !['alpha', 'beta'].every((n) => sessionOf(n));) {
      if (Date.now() > end) throw new Error('the engine did not revive alpha and beta');
      await new Promise((r) => setTimeout(r, 300));
    }
    const url = await daemon.loginUrl();
    // The room turn: when the daemon types the room post into alpha, play the mid-turn part.
    let seen = typedRaw().length;
    replier = setInterval(() => {
      const all = typedRaw();
      for (const item of all.slice(seen)) {
        if (sessionOf('alpha')?.jobId !== item.id || !item.text.includes("단톡방 '시안방'")) continue;
        rec('user', item.text.replaceAll('\r', '\n'));
        midTurn([drafts[2], drafts[3]], '방 시안');
      }
      seen = all.length;
    }, 100);

    // The DM turn, still running: the owner asked, the agent sent two files, then kept working.
    rec('user', '[사장 · 메신저 · 10-24 13:30] ⟨m:aaaa1111⟩\n시안 보내줘');
    midTurn([drafts[0], drafts[1]], 'DM 시안');

    const open = async (page: Page, touch: boolean) => {
      const tap = (l: Locator) => (touch ? l.tap() : l.click());
      await page.getByRole('button', { name: /^메신저/ }).waitFor();
      await tap(page.getByRole('button', { name: /^메신저/ }));
      return page.getByRole('region', { name: '메신저', exact: true });
    };
    const dmOf = async (messenger: Locator, touch: boolean) => {
      const b = messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ });
      await (touch ? b.tap() : b.click());
      return messenger.getByRole('region', { name: 'alpha 대화' });
    };
    const bottom = (conv: Locator) => conv.getByTestId('chat-scroll').evaluate((s) => (s.scrollTop = s.scrollHeight));

    const run = async (page: Page, touch: boolean, tag: 'desktop' | 'phone') => {
      const messenger = await open(page, touch);
      const conv = await dmOf(messenger, touch);
      await card(conv, 'dm-1.png').waitFor({ timeout: 15_000 });
      await card(conv, 'dm-2.png').waitFor();
      await bottom(conv);
      check((await conv.getByText('DM 시안').count()) === 1, `${tag} DM mid-turn: the caption bubble shows`);
      check((await conv.locator('details', { hasText: 'SendUserFile' }).count()) === 0, `${tag} DM mid-turn: no bare SendUserFile tool line`);
      await card(conv, 'dm-1.png').locator('img').waitFor();
      await opens(page, conv, 'dm-1.png', touch);
      check(true, `${tag} DM mid-turn: the card opens the viewer`);
      await shot(page, `${tag}-dm-mid-turn`);
      return { messenger, conv };
    };
    const roomMidTurn = async (page: Page, messenger: Locator, tag: string) => {
      const back = messenger.getByRole('button', { name: '‹ 목록' }).first();
      if (await back.isVisible()) await back.click();
      const rooms = messenger.getByRole('region', { name: '단톡방' });
      await rooms.getByRole('button', { name: '+ 방 만들기' }).click();
      await rooms.getByRole('textbox', { name: '방 이름' }).fill('시안방');
      for (const name of ['alpha', 'beta']) await rooms.getByLabel(name).check();
      await rooms.getByRole('button', { name: '저장' }).click();
      await rooms.getByRole('button', { name: /^시안방/ }).click();
      const room = messenger.getByTestId(/group-room-screen-/);
      await room.waitFor();
      const composer = room.getByRole('textbox', { name: '시안방 메시지' });
      await composer.fill('@');
      await room.getByRole('option', { name: '@alpha' }).click();
      await composer.type('방 시안 보내줘');
      await room.getByRole('button', { name: '보내기', exact: true }).click();
      await card(room, 'room-1.png').waitFor({ timeout: 30_000 });
      await card(room, 'room-2.png').waitFor();
      check((await room.locator('details', { hasText: 'SendUserFile' }).count()) === 0, `${tag} room mid-turn: no bare SendUserFile tool line`);
      await opens(page, room, 'room-1.png', false);
      check(true, `${tag} room mid-turn: the card opens the viewer`);
      await shot(page, `${tag}-room-mid-turn`);
      return room;
    };

    // ════ Desktop ════
    const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await deskCtx.addInitScript(nameShim);
    if (fs.existsSync(FONT))
      await deskCtx.route('**/__msf/malgun.ttf', (r) => r.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    const page = await deskCtx.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
    if (await infoClose.count()) await infoClose.click();
    const d = await run(page, false, 'desktop');
    // The DM turn ends.
    rec('assistant', [{ type: 'text', text: 'DM 다 보냈어요' }]);
    await d.conv.getByText('DM 다 보냈어요').waitFor({ timeout: 15_000 });
    await bottom(d.conv);
    await card(d.conv, 'dm-1.png').waitFor();
    check(true, 'desktop DM after the turn: the card is still there');
    await shot(page, 'desktop-dm-after');
    // A room turn, running.
    const room = await roomMidTurn(page, d.messenger, 'desktop');
    rec('assistant', [{ type: 'text', text: '방 다 보냈어요' }]);
    await room.getByText('방 다 보냈어요').waitFor({ timeout: 15_000 });
    await card(room, 'room-1.png').waitFor();
    check(true, 'desktop room after the turn: the card is still there');
    await shot(page, 'desktop-room-after');

    // ════ Phone 393x852 ════ (both views read the same transcript, now a finished turn: new mid-turn on the phone)
    const ctx2 = await browser.newContext({ ...PHONE, storageState: await deskCtx.storageState() });
    await ctx2.addInitScript(nameShim);
    if (fs.existsSync(FONT))
      await ctx2.route('**/__msf/malgun.ttf', (r) => r.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    const p2 = await ctx2.newPage();
    p2.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await p2.goto(`http://127.0.0.1:${port}/`);
    await p2.addStyleTag({ content: FONT_CSS });
    // A second DM turn that is still running when the phone opens it.
    rec('user', '[사장 · 메신저 · 10-24 13:40] ⟨m:bbbb2222⟩\n한 번 더');
    fs.copyFileSync(drafts[0], path.join(folders.alpha, 'dm-3.png'));
    midTurn([path.join(folders.alpha, 'dm-3.png')], '폰 시안');
    const m2 = await open(p2, true);
    const c2 = await dmOf(m2, true);
    await card(c2, 'dm-3.png').waitFor({ timeout: 15_000 });
    await bottom(c2);
    check((await c2.getByText('폰 시안').count()) === 1, 'phone DM mid-turn: the caption bubble shows');
    await opens(p2, c2, 'dm-3.png', true);
    check(true, 'phone DM mid-turn: the card opens the viewer');
    await shot(p2, 'phone-dm-mid-turn');
    await m2.getByRole('button', { name: '‹ 목록' }).first().tap();
    const rooms2 = m2.getByRole('region', { name: '단톡방' });
    await rooms2.getByRole('button', { name: /^시안방/ }).tap();
    const room2 = m2.getByTestId(/group-room-screen-/);
    await room2.waitFor();
    await card(room2, 'room-1.png').waitFor({ timeout: 15_000 });
    await opens(p2, room2, 'room-1.png', true);
    check(true, 'phone room after the turn: the card opens the viewer');
    await shot(p2, 'phone-room-after');
    check(await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: no horizontal page scroll');
    await ctx2.close();
    console.log('done');
  } finally {
    if (replier) clearInterval(replier);
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

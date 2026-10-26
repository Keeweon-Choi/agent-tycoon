/**
 * BUBBLE-TAIL in the real messenger: dist/cli.js with --engine on --allow-chat in an isolated HOME
 * whose `claude` is the engine fake, headless Chromium (--disable-gpu), desktop and phone 393x852.
 * A DM with runs from the lead, a task notice (peer) and the boss: only a run's first bubble has a
 * tail, on the face's side; nothing overflows horizontally.
 *
 *   npx tsx cld/test/run-bubble-tail.ts <port 18256-18259>
 *
 * Screenshots: cld/artifacts/bubble-tail/*.png
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
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
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/bubble-tail');
const DEADLINE_MS = 280_000;
const PHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 } };
})();
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__bubbletail/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;

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
  const browser = await launchBrowser();
  /** tsx names the arrow functions it passes to evaluate: give the page the helper it calls. */
  const nameShim = 'globalThis.__name = (fn) => fn;';
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const row = (conv: Locator, id: string) => conv.locator(`[data-chat-id="${id}"]`);
  try {
    for (const end = Date.now() + 40_000; !['alpha', 'beta', 'gamma'].every((n) => sessionOf(n));) {
      if (Date.now() > end) throw new Error('the engine did not revive alpha, beta and gamma');
      await new Promise((r) => setTimeout(r, 300));
    }
    const LONG = '긴 글 확인용 문장입니다. '.repeat(24);
    const lead = sessionOf('alpha')!;
    say('user', '[사장 · 메신저 · 10-24 12:00] ⟨m:bbbb3333⟩\n먼저 보내는 짧은 말');
    say('user', '[사장 · 메신저 · 10-24 12:00] ⟨m:bbbb3334⟩\n' + LONG);
    say('assistant', '짧은 답');
    say('assistant', LONG);
    say('assistant', '- 목록 하나\n- 목록 둘\n\n`코드` 도 있어요');
    fs.appendFileSync(
      transcriptPath(lead.cwd, lead.sessionId, home),
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'ffffffff-0000-4000-8000-000000000001',
        timestamp: new Date(clock + 1).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_bt', name: 'Task', input: { description: '로그 정리', prompt: 'x' } }],
        },
      })}\n`,
    );
    say(
      'user',
      '<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>toolu_bt</tool-use-id>\n<status>completed</status>\n<summary>로그 정리 끝</summary>\n<result>오류 0건</result>\n</task-notification>',
    );
    say(
      'user',
      '<task-notification>\n<task-id>t2</task-id>\n<tool-use-id>toolu_bt</tool-use-id>\n<status>completed</status>\n<summary>두 번째 알림</summary>\n<result>' + LONG + '</result>\n</task-notification>',
    );
    const last = say('user', '[사장 · 메신저 · 10-24 12:01] ⟨m:cccc4444⟩\n고마워요');
    say('user', '[사장 · 메신저 · 10-24 12:01] ⟨m:cccc4445⟩\n한 줄 더');
    seeding = false;
    await new Promise((r) => setTimeout(r, 3_000));
    const url = await daemon.loginUrl();

    const openDm = async (page: Page, touch: boolean) => {
      const tap = (l: Locator) => (touch ? l.tap() : l.click());
      await tap(page.getByRole('button', { name: /^메신저/ }));
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      await tap(messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }));
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      await row(conv, last).waitFor();
      await conv.getByTestId('chat-scroll').evaluate((s) => (s.scrollTop = s.scrollHeight));
      return conv;
    };
    /** Every row's bubble stays inside the list; a tail sits between the face and its bubble. */
    const verify = async (page: Page, conv: Locator, tag: string) => {
      const r = await conv.evaluate((el) => {
        const list = el.querySelector('[data-testid="chat-scroll"]') as HTMLElement;
        const lb = list.getBoundingClientRect();
        const tails = [...el.querySelectorAll<HTMLElement>('[data-testid="bubble-tail"]')];
        const boxes = [...el.querySelectorAll<HTMLElement>('.bubble-box')];
        const out = boxes.filter((b) => {
          const x = b.getBoundingClientRect();
          return x.left < lb.left - 0.5 || x.right > lb.right + 0.5;
        }).length;
        return {
          tails: tails.map((t) => ({
            side: t.className.includes('bubble-tail-r') ? 'r' : 'l',
            kind: t.parentElement!.closest('[data-from]')?.getAttribute('data-from') ?? 'lead',
            first: !!t.closest('[data-chat-id]')!.querySelector('[data-testid="sender-face"], [data-testid="owner-face"]'),
          })),
          boxes: boxes.length,
          out,
          scrollX: list.scrollWidth > list.clientWidth,
        };
      });
      console.log(`  ${tag}: ${JSON.stringify(r)}`);
      const kinds = r.tails.map((t) => `${t.kind}:${t.side}`).sort();
      check(r.tails.length >= 3 && r.tails.every((t) => t.first), `${tag}: a tail only on a run's first bubble (the one beside a face)`);
      check(['boss:r', 'lead:l', 'peer:l'].every((k) => kinds.includes(k)), `${tag}: lead and peer tails on the left, the boss's on the right (${kinds.join(' ')})`);
      check(r.boxes > r.tails.length, `${tag}: later bubbles of a run have no tail`);
      check(r.out === 0 && !r.scrollX, `${tag}: no bubble leaves the column, no horizontal list scroll`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${tag}: no horizontal page scroll`);
    };
    const faceGap = async (conv: Locator, tag: string) => {
      const ok = await conv.evaluate((el) =>
        [...el.querySelectorAll<HTMLElement>('[data-testid="bubble-tail"]')].every((t) => {
          const face = t
            .closest('[data-chat-id]')!
            .querySelector<HTMLElement>('[data-testid="sender-face"], [data-testid="owner-face"]')!
            .getBoundingClientRect();
          const x = t.getBoundingClientRect();
          return t.className.includes('bubble-tail-r') ? x.right <= face.left + 0.5 : x.left >= face.right - 0.5;
        }),
      );
      check(ok, `${tag}: no tail overlaps a face`);
    };

    {
      const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await deskCtx.addInitScript(nameShim);
      if (fs.existsSync(FONT))
        await deskCtx.route('**/__bubbletail/malgun.ttf', (route) =>
          route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
        );
      const page = await deskCtx.newPage();
      page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      await page.goto(url);
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
      if (await infoClose.count()) await infoClose.click();
      const conv = await openDm(page, false);
      await verify(page, conv, 'desktop');
      await faceGap(conv, 'desktop');
      await shot(page, 'desktop-dm');
      await conv.getByTestId('chat-scroll').evaluate((s) => (s.scrollTop = 0));
      await shot(page, 'desktop-dm-top');

      const ctx2 = await browser.newContext({ ...PHONE, storageState: await deskCtx.storageState() });
      await ctx2.addInitScript(nameShim);
      if (fs.existsSync(FONT))
        await ctx2.route('**/__bubbletail/malgun.ttf', (route) =>
          route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
        );
      const p2 = await ctx2.newPage();
      p2.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      await p2.goto(`http://127.0.0.1:${port}/`);
      await p2.addStyleTag({ content: FONT_CSS });
      const conv2 = await openDm(p2, true);
      await verify(p2, conv2, 'phone');
      await faceGap(conv2, 'phone');
      await shot(p2, 'phone-dm');
      await conv2.getByTestId('chat-scroll').evaluate((s) => (s.scrollTop = 0));
      await shot(p2, 'phone-dm-top');
      await ctx2.close();
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

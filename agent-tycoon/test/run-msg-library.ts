/**
 * MSGLIB (owner 11-06 14:28), end to end on the REAL API: dist/cli.js --engine on --allow-chat in a temp HOME
 * whose `claude` is the engine fake, headless Chromium (--disable-gpu), a 390x844 touch phone and a 1280x800
 * desktop (x2). delta has a 300-item transcript the runner writes: files the boss attached (a text file, two
 * pictures, one deleted from disk afterwards), a file the lead sent, a question tag asked early and repeated
 * near the end, and a long message from each side at the bottom.
 *  1. the library lists them (preview on a picture, a deleted file reads gone), a row goes to its message and
 *     the return button takes the reader back to the bottom
 *  2. the repeat's tag chip goes to the first ask; the return button takes the reader back to where they were
 *  3. scrolling back by hand removes the return button
 *  4. the faces are the same size, centred in their frames; a lead's and the boss's long bubbles share a width
 * MSGLIB_PHASE=before takes the layout pictures only for comparison (checks of part 4 are logged, not asserted).
 * Screenshots in agent-tycoon/artifacts/feat-messenger-library-and-layout/.
 *
 *   npx tsx agent-tycoon/test/run-msg-library.ts <port 18750-18759>
 */
import type { Browser, BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { transcriptPath } from '../../server/src/agent-tycoon/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (port < 18750 || port > 18759) throw new Error('port must be 18750-18759');
const PHASE = process.env.MSGLIB_PHASE === 'before' ? 'before' : 'after';
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/feat-messenger-library-and-layout');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__lib/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const SAFE_AREA = ':root { --agty-safe-top: 47px !important; --agty-safe-bottom: 34px !important; }';
const DEADLINE_MS = 360_000;
const IPHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();
const TAG = '⟨q:deploy-order⟩';
const HISTORY = 300;
const FIRST = 40;
const REPEAT = 281;
const ASK = '배포 순서를 정해 주실래요?';
const LONG_BOSS = 290;
const LONG_LEAD = 291;
const LONG = '긴 이야기를 이어서 적어요. '.repeat(14);

let oks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  oks++;
  console.log(`ok - ${what}`);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function picture(w: number, h: number, base: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) png.data[i + c] = Math.round((base[c] * (x + y)) / (w + h));
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.writeFileSync(path.join(configDirectory(home), 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'delta');
  const inbox = path.join(folder, '.agty-inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'delta', folder, room: '개발실', wantRunning: true }]),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
    false,
  );
  const { child: server } = daemon;
  let browser: Browser | undefined;
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL'); // our own daemon only
    void browser?.close();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { pid: number; sessionId: string; cwd: string; name: string };
  const sessionFile = (): Sess | null => {
    for (const f of fs.readdirSync(sessions)) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (s.name === 'delta') return s;
      } catch {
        /* being written */
      }
    }
    return null;
  };
  const transcript = () => {
    const s = sessionFile()!;
    return transcriptPath(s.cwd, s.sessionId, home);
  };
  const rec = (i: number, role: 'user' | 'assistant', text: string, at: number) =>
    `${JSON.stringify(
      role === 'user'
        ? {
            type: 'user',
            uuid: `${i.toString(16).padStart(8, '0')}-6100-4000-8000-000000000000`,
            timestamp: new Date(at).toISOString(),
            message: { role, content: text },
          }
        : {
            type: 'assistant',
            uuid: `${i.toString(16).padStart(8, '0')}-6100-4000-8000-000000000000`,
            timestamp: new Date(at).toISOString(),
            message: { role, content: [{ type: 'text', text }] },
          },
    )}\n`;
  let live = 0;
  const say = (role: 'user' | 'assistant', text: string) =>
    fs.appendFileSync(transcript(), rec(0x70000 + ++live, role, text, Date.now()));

  try {
    const font = fs.readFileSync(FONT);
    for (const end = Date.now() + 40_000; !sessionFile(); ) {
      if (Date.now() > end) throw new Error('the engine did not revive the session');
      await wait(300);
    }
    const files = {
      notes: ['20261105-100000-notes.txt', 'text/plain', Buffer.from('메모 notes\n')],
      sky: ['20261105-100100-sky.png', 'image/png', picture(160, 100, [90, 160, 255])],
      gone: ['20261105-100200-gone.png', 'image/png', picture(80, 80, [255, 120, 60])],
    } as const;
    for (const [name, , data] of Object.values(files)) fs.writeFileSync(path.join(inbox, name), data);
    fs.writeFileSync(path.join(folder, 'shot.png'), picture(200, 120, [60, 200, 120]));
    const line = ([name, type, data]: (typeof files)[keyof typeof files]) =>
      `[첨부] ${path.join(inbox, name)} (${type}, ${Math.max(1, Math.ceil(data.length / 1024))} KB)`;
    const H0 = Date.now() - 2 * 3600_000;
    const special: Record<number, string> = {
      [FIRST]: `배포 전에 정해야 할 게 있어요. ${ASK} ${TAG}`,
      [REPEAT]: `다시 여쭤요: 배포 순서 ${TAG}`,
      20: `메모 보낼게요\n${line(files.notes)}`,
      60: `하늘 사진이에요\n${line(files.sky)}`,
      100: `이 사진도요\n${line(files.gone)}`,
      151: `화면을 캡처했어요\n[첨부] ${path.join(folder, 'shot.png')}`,
      [LONG_BOSS]: `제가 길게 적어 봅니다. ${LONG}`,
      [LONG_LEAD]: `네, 길게 답해 드릴게요. ${LONG}`,
    };
    const asLead = (i: number) => i === FIRST || i === REPEAT || i === 151 || i % 2 === 1;
    {
      const file = transcript();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const liveText = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
      const lines = Array.from({ length: HISTORY }, (_, i) =>
        rec(i, asLead(i) ? 'assistant' : 'user', special[i] ?? `기록 ${i}번째 메시지`, H0 + i * 10_000),
      );
      fs.writeFileSync(`${file}.tmp`, lines.join('') + liveText);
      fs.renameSync(`${file}.tmp`, file);
    }
    say('user', 'delta: 오늘 할 일 정리해 줘');
    say('assistant', 'delta 할 일을 정리할게요.');
    await wait(4_000);
    fs.rmSync(path.join(inbox, files.gone[0])); // gone before anybody looks

    browser = await launchBrowser();
    for (const [label, opts] of [
      ['phone', { ...IPHONE, viewport: { width: 390, height: 844 } }],
      ['desktop', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }],
    ] as const) {
      const touch = label === 'phone';
      const ctx = await browser.newContext(opts);
      await ctx.route('**/__lib/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
      await ctx.addInitScript('window.__name = (f) => f;'); // tsx names the arrow functions it sends to the page
      const page = await ctx.newPage();
      const snap = (name: string) => page.screenshot({ path: path.join(OUT, `${label}-${name}.png`) });
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS + (touch ? SAFE_AREA : '') });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      const conv = messenger.getByRole('region', { name: 'delta 대화' });
      const scroller = conv.getByTestId('chat-scroll');
      const tapOn = (l: Locator) => (touch ? l.tap() : l.click());
      await tapOn(page.getByRole('button', { name: /^메신저($| \()/ }));
      const delta = messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^delta/ });
      await delta.waitFor();
      await tapOn(delta);
      await conv.getByText('delta 할 일을 정리할게요.').waitFor();
      await wait(1_500);

      const atBottom = () =>
        scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 48);
      /** The row holding the words: where its top is inside the list, or null when it is not on the page. */
      const rowTop = (words: string) =>
        scroller.evaluate((el, w) => {
          const row = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find((r) => r.textContent?.includes(w));
          return row ? Math.round(row.getBoundingClientRect().top - el.getBoundingClientRect().top) : null;
        }, words);
      const inView = async (words: string) => {
        const top = await rowTop(words);
        const height = await scroller.evaluate((el) => el.clientHeight);
        return top !== null && top > -40 && top < height;
      };
      const returnButton = conv.getByTestId('jump-return');

      // ── 4. the layout, at the bottom ──
      await scroller.evaluate((el) => {
        const row = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find((r) => r.textContent?.includes('제가 길게'));
        el.scrollTop = row!.offsetTop - 20;
      });
      await wait(400);
      const metrics = await page.evaluate(() => {
        const rect = (el: Element | null) => el?.getBoundingClientRect().toJSON() as DOMRect | undefined;
        const rowOf = (words: string) => [...document.querySelectorAll('[data-chat-id]')].find((r) => r.textContent?.includes(words));
        const lead = rowOf('네, 길게')?.querySelector('.dlg-box');
        const boss = rowOf('제가 길게')?.querySelector('.dlg-box');
        const leadFace = rowOf('네, 길게')?.querySelector('[data-testid="sender-face"]');
        const bossFace = rowOf('제가 길게')?.querySelector('[data-testid="owner-face"]');
        const inner = (frame: Element | undefined | null) => {
          const f = rect(frame ?? null);
          const content = rect(frame?.querySelector('canvas, img, svg, span') ?? null);
          return f && content
            ? { dx: content.left + content.width / 2 - (f.left + f.width / 2), dy: content.top + content.height / 2 - (f.top + f.height / 2) }
            : null;
        };
        return {
          lead: rect(lead ?? null),
          boss: rect(boss ?? null),
          leadFace: rect(leadFace ?? null),
          bossFace: rect(bossFace ?? null),
          leadCentre: inner(leadFace),
          bossCentre: inner(bossFace),
          scroller: rect(document.querySelector('[data-testid="chat-scroll"]')),
        };
      });
      console.log(`${label} layout ${PHASE}:`, JSON.stringify(metrics));
      await snap(`layout-${PHASE}`);
      if (metrics.lead && metrics.boss && metrics.scroller) {
        const top = Math.max(0, Math.min(metrics.lead.top, metrics.boss.top) - 30);
        await page.screenshot({
          path: path.join(OUT, `${label}-layout-${PHASE}-zoom.png`),
          clip: { x: metrics.scroller.left, y: top, width: metrics.scroller.width, height: Math.min(metrics.scroller.bottom - top, 420) },
        });
      }
      if (PHASE === 'after') {
        const m = metrics;
        check(m.leadFace && m.bossFace && Math.abs(m.leadFace.width - m.bossFace.width) < 0.6 && Math.abs(m.leadFace.height - m.bossFace.height) < 0.6, `${label}: the lead's and the boss's faces are one size (${m.leadFace?.width}x${m.leadFace?.height} / ${m.bossFace?.width}x${m.bossFace?.height})`);
        check(m.leadFace && Math.abs(m.leadFace.width - 45) < 0.6, `${label}: the face frame is 45 px (75% of 60)`);
        check(m.leadCentre && Math.abs(m.leadCentre.dx) < 1.01 && Math.abs(m.leadCentre.dy) < 1.01, `${label}: the lead's face is centred in its frame ${JSON.stringify(m.leadCentre)}`);
        check(m.bossCentre && Math.abs(m.bossCentre.dx) < 1.01 && Math.abs(m.bossCentre.dy) < 1.01, `${label}: the boss's face is centred in its frame ${JSON.stringify(m.bossCentre)}`);
        check(m.lead && m.boss && Math.abs(m.lead.width - m.boss.width) < 1.01, `${label}: the long bubbles are one width (${m.lead?.width} / ${m.boss?.width})`);
        check(m.lead && m.boss && m.scroller && Math.abs(m.lead.left - m.scroller.left - (m.scroller.right - m.boss.right)) < 1.01, `${label}: the lead's left edge and the boss's right edge sit the same distance from their sides`);
      }

      await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await wait(500);

      // ── 1. the library, a row goes to its message, the return button comes back ──
      await tapOn(conv.getByTestId('library-open'));
      const lib = conv.getByTestId('library');
      await lib.waitFor();
      const rows = lib.getByTestId('library-row');
      await rows.first().waitFor();
      for (let i = 0; i < 40 && (await rows.count()) < 4; i++) await wait(150);
      check((await rows.count()) === 4, `${label}: the library lists the four files (${await rows.count()})`);
      check((await rows.first().innerText()).includes('shot.png'), `${label}: newest first, the lead's file on top`);
      const sky = rows.filter({ hasText: 'sky.png' });
      await sky.locator('img').waitFor({ timeout: 10_000 });
      check(true, `${label}: a picture shows a preview`);
      const goneRow = rows.filter({ hasText: 'gone.png' });
      check((await goneRow.getAttribute('data-gone')) === 'true' && (await goneRow.innerText()).includes('파일 없음'), `${label}: a deleted file reads gone`);
      check(await goneRow.getByRole('button', { name: /열어 보기/ }).isDisabled(), `${label}: a gone file cannot be opened`);
      check((await sky.innerText()).includes('나'), `${label}: the boss's file says who sent it`);
      await snap('library');
      check(await atBottom(), `${label}: the reader is at the bottom before going`);
      await tapOn(rows.filter({ hasText: 'notes.txt' }).getByRole('button', { name: /메시지로 가기/ }));
      for (const end = Date.now() + 15_000; !(await inView('메모 보낼게요')); ) {
        if (Date.now() > end) {
          await snap('debug-no-go');
          throw new Error('the library row did not go to its message');
        }
        await wait(150);
      }
      check((await lib.count()) === 0, `${label}: the library closes on going`);
      await returnButton.waitFor({ timeout: 5_000 });
      check(true, `${label}: the return button shows`);
      await snap('library-went');
      await tapOn(returnButton);
      for (const end = Date.now() + 10_000; !(await atBottom()); ) {
        if (Date.now() > end) throw new Error('the return button did not bring the reader back to the bottom');
        await wait(150);
      }
      check((await returnButton.count()) === 0, `${label}: back at the bottom, the return button is gone`);

      // ── 2. the tag chip goes far; the button returns to the exact place ──
      await scroller.evaluate((el) => {
        const row = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find((r) => r.textContent?.includes('다시 여쭤요'));
        el.scrollTop = row!.offsetTop - 120;
      });
      await wait(500);
      const before = await rowTop('다시 여쭤요');
      check(before !== null && (await inView('다시 여쭤요')), `${label}: the repeat is mid-screen (${before})`);
      await tapOn(scroller.locator('[data-chat-id]', { hasText: '다시 여쭤요' }).getByTestId('question-tag'));
      for (const end = Date.now() + 15_000; !(await inView(ASK)); ) {
        if (Date.now() > end) {
          await snap('debug-no-jump');
          throw new Error('the tag chip did not go to the first ask');
        }
        await wait(150);
      }
      await returnButton.waitFor({ timeout: 5_000 });
      await snap('chip-went');
      // a second jump from there keeps the first place
      await wait(300);
      await tapOn(returnButton);
      for (const end = Date.now() + 10_000; (await rowTop('다시 여쭤요')) === null || Math.abs(((await rowTop('다시 여쭤요')) ?? 1e9) - before!) > 3; ) {
        if (Date.now() > end) throw new Error(`the return button did not put the repeat back (${await rowTop('다시 여쭤요')} vs ${before})`);
        await wait(150);
      }
      check((await returnButton.count()) === 0, `${label}: back where the reader was (${before} px), the return button is gone`);

      // ── 3. coming back by hand removes it ──
      await tapOn(scroller.locator('[data-chat-id]', { hasText: '다시 여쭤요' }).getByTestId('question-tag'));
      await returnButton.waitFor({ timeout: 15_000 });
      await wait(500);
      await scroller.evaluate((el) => {
        const row = [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find((r) => r.textContent?.includes('다시 여쭤요'));
        el.scrollTop = row!.offsetTop - 120;
      });
      for (const end = Date.now() + 5_000; (await returnButton.count()) > 0; ) {
        if (Date.now() > end) throw new Error('scrolling back by hand did not remove the return button');
        await wait(100);
      }
      check(true, `${label}: scrolling back near the place removes the return button`);
      await ctx.close();
    }
    console.log(`${oks} checks passed`);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); // our own daemon only
    killFakeSessions(home);
    await wait(500);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

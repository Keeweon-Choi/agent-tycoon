/**
 * FEAT-MESSENGER-GPT-LOOK (owner 11-06 14:26): photos of the messenger next to the GPT mockup, on the REAL API:
 * dist/cli.js --engine on --allow-chat in a temp HOME whose `claude` is the engine fake, headless Chromium
 * (--disable-gpu), a 1440x1000 desktop and a 390x844 touch phone. delta has a short transcript the runner writes
 * (a question tag, files both ways, a long message from each side); echo and golf are two more leads.
 * The desktop shot carries a draft chip in the composer; a zoom of each part at 2x goes beside it.
 * MSGLOOK_PHASE=before|after names the photos; after also writes compare-gpt2.png (mockup left, ours right).
 * Photos in agent-tycoon/artifacts/feat-messenger-gpt-look/.
 *
 *   npx tsx agent-tycoon/test/run-msg-gpt-look.ts <port 18760-18769>
 */
import type { Browser, BrowserContextOptions } from '@playwright/test';
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
import { outDir, themePort, UI_THEME_INIT } from './uiTheme.js';

const port = Number(process.argv[2]);
if ((port < 18760 || port > 18769) && !themePort(port)) throw new Error('port must be 18760-18769');
const PHASE = process.env.MSGLOOK_PHASE === 'before' ? 'before' : 'after';
const OUT = outDir(path.join(REPO_ROOT, 'agent-tycoon/artifacts/feat-messenger-gpt-look'));
const MOCK = path.join(REPO_ROOT, '../specs/ui-mock-1104/hud-v3/base/gpt-2-messenger.png');
const SAFE_AREA = ':root { --agty-safe-top: 47px !important; --agty-safe-bottom: 34px !important; }';
/** The update and notice toasts are not the messenger's: out of the picture. */
const NO_TOASTS = '.floating-toast-frame { display: none !important; }';
/** The desktop shot puts the window where the mockup has it (about 1190x820); the 2x zooms keep the default size. */
const MOCK_PLACE = `localStorage.setItem('agty.hud.layout.v1', ${JSON.stringify(
  JSON.stringify({ v: 1, items: { messenger: { place: { corner: 'tl', dx: 118, dy: 104, w: 1190, h: 836 } } } }),
)});`;
const DEADLINE_MS = 300_000;
const IPHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();
const LEADS = ['delta', 'echo', 'golf'];
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

/** The mockup and ours side by side, tops aligned, on the app's dark background. */
function sideBySide(left: string, right: string, out: string): void {
  const a = PNG.sync.read(fs.readFileSync(left));
  const b = PNG.sync.read(fs.readFileSync(right));
  const gap = 16;
  const img = new PNG({ width: a.width + gap + b.width, height: Math.max(a.height, b.height) });
  img.data.fill(0);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  PNG.bitblt(a, img, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, img, 0, 0, b.width, b.height, a.width + gap, 0);
  fs.writeFileSync(out, PNG.sync.write(img));
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.writeFileSync(path.join(configDirectory(home), 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folderOf = (name: string) => path.join(home, 'work', name);
  for (const name of LEADS) fs.mkdirSync(path.join(folderOf(name), '.agty-inbox'), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(LEADS.map((name) => ({ name, folder: folderOf(name), room: '개발실', wantRunning: true }))),
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
  const sessionFile = (name: string): Sess | null => {
    for (const f of fs.readdirSync(sessions)) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (s.name === name) return s;
      } catch {
        /* being written */
      }
    }
    return null;
  };
  const rec = (i: number, role: 'user' | 'assistant', text: string, at: number) =>
    `${JSON.stringify({
      type: role,
      uuid: `${i.toString(16).padStart(8, '0')}-6200-4000-8000-000000000000`,
      timestamp: new Date(at).toISOString(),
      message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
    })}\n`;

  try {
    for (const end = Date.now() + 40_000; LEADS.some((n) => !sessionFile(n)); ) {
      if (Date.now() > end) throw new Error('the engine did not revive the sessions');
      await wait(300);
    }
    const inbox = path.join(folderOf('delta'), '.agty-inbox');
    const notes = '20261106-100000-review-notes.md';
    fs.writeFileSync(path.join(inbox, notes), '# review\n- build\n- docs\n');
    const zip = path.join(folderOf('delta'), 'build-v0.9.3.zip');
    fs.writeFileSync(zip, Buffer.alloc(286 * 1024, 7));
    fs.writeFileSync(path.join(folderOf('delta'), 'shot.png'), picture(200, 120, [60, 200, 120]));
    const H0 = Date.now() - 50 * 60_000;
    const lines: [role: 'user' | 'assistant', text: string][] = [
      ['user', 'T-42 공개 준비는 어떻게 되고 있나요?'],
      ['assistant', `네, 빌드 87%까지 끝났어요.\n남은 이슈는 2건이고 오늘 안에 정리할게요.\n[첨부] ${zip}`],
      ['user', '좋아요. 내일 오전에 내부 리뷰 해요. 체크리스트도 같이 주세요.'],
      ['assistant', '배포 전에 정할 게 있어요. 배포 순서를 정해 주실래요? ⟨q:deploy-order⟩'],
      ['user', `리뷰 메모 보낼게요\n[첨부] ${path.join(inbox, notes)} (text/markdown, 1 KB)`],
      ['assistant', `화면을 캡처했어요\n[첨부] ${path.join(folderOf('delta'), 'shot.png')}`],
      ['user', `제가 길게 적어 봅니다. ${'긴 이야기를 이어서 적어요. '.repeat(6)}`],
      ['assistant', `네, 길게 답해 드릴게요. ${'긴 이야기를 이어서 적어요. '.repeat(6)}`],
      ['assistant', '다시 여쭤요: 배포 순서 ⟨q:deploy-order⟩'],
    ];
    for (const name of LEADS) {
      const s = sessionFile(name)!;
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const liveText = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
      const mine = name === 'delta' ? lines : ([['user', `${name}: 오늘 할 일 정리해 줘`], ['assistant', `${name} 할 일을 정리할게요.`]] as const);
      const body = mine.map(([role, text], i) => rec(i + 1, role, text, H0 + i * 5 * 60_000)).join('');
      fs.writeFileSync(`${file}.tmp`, body + liveText);
      fs.renameSync(`${file}.tmp`, file);
    }
    await wait(3_000);

    browser = await launchBrowser();
    for (const [label, opts] of [
      ['desktop', { viewport: { width: Number(process.env.VIEW_W ?? 1440), height: 1000 } }],
      ['phone', { ...IPHONE, viewport: { width: 390, height: 844 } }],
    ] as const) {
      const touch = label === 'phone';
      const ctx = await browser.newContext(opts);
      await ctx.addInitScript('window.__name = (f) => f;' + UI_THEME_INIT); // tsx names the arrow functions it sends to the page
      if (!touch) await ctx.addInitScript(MOCK_PLACE);
      const page = await ctx.newPage();
      const shot = (name: string) => path.join(OUT, `${label}-${name}-${PHASE}.png`);
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: NO_TOASTS + (touch ? SAFE_AREA : '') });
      await page.evaluate(() => document.fonts.ready);
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      const conv = messenger.getByRole('region', { name: 'delta 대화' });
      const tapOn = (l: ReturnType<typeof page.locator>) => (touch ? l.tap() : l.click());
      await tapOn(page.getByRole('button', { name: /^메신저($| \()/ }));
      const delta = messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^delta/ });
      await delta.waitFor();
      await wait(800);
      if (!touch) {
        // echo read once, then a new reply from it: the list shows an unread count
        await tapOn(messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^echo/ }));
        await messenger.getByRole('region', { name: 'echo 대화' }).getByText('echo 할 일을').waitFor();
        await tapOn(delta);
        await conv.getByText('다시 여쭤요').waitFor();
        const s = sessionFile('echo')!;
        fs.appendFileSync(transcriptPath(s.cwd, s.sessionId, home), rec(90, 'assistant', 'echo: 정리 끝났어요. 확인해 주세요.', Date.now()));
        await wait(2_000);
      }
      if (touch) await page.screenshot({ path: shot('list') });
      await tapOn(delta);
      await conv.getByText('다시 여쭤요').waitFor();
      await conv.locator('input[type=file]').setInputFiles({ name: 'build-log.txt', mimeType: 'text/plain', buffer: Buffer.from('ok\n') });
      await wait(1_200);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: shot('conversation') });
      if (!touch) {
        // 2x zooms of the list, the head and timeline, the composer
        const zoom = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
        await zoom.addInitScript('window.__name = (f) => f;' + UI_THEME_INIT);
        const z = await zoom.newPage();
        await z.goto(await daemon.loginUrl());
        await z.waitForURL(`http://127.0.0.1:${port}/`);
        await z.addStyleTag({ content: NO_TOASTS });
        await z.evaluate(() => document.fonts.ready);
        const zm = z.getByRole('region', { name: '메신저', exact: true });
        await z.getByRole('button', { name: /^메신저($| \()/ }).click();
        await zm.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^delta/ }).click();
        const zc = zm.getByRole('region', { name: 'delta 대화' });
        await zc.getByText('다시 여쭤요').waitFor();
        await zc.locator('input[type=file]').setInputFiles({ name: 'build-log.txt', mimeType: 'text/plain', buffer: Buffer.from('ok\n') });
        await wait(1_200);
        await z.mouse.move(0, 0);
        const box = await zm.boundingBox();
        if (box) {
          // the top of the conversation (the day pill, the lead's file card) and the bottom (the composer)
          const scroll = zc.getByTestId('chat-scroll');
          await scroll.evaluate((el) => (el.scrollTop = 0));
          await wait(400);
          await z.screenshot({ path: shot('zoom-top'), clip: { x: box.x, y: box.y, width: box.width, height: Math.round(box.height * 0.6) } });
          await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
          await wait(400);
          const half = Math.round(box.height / 2);
          await z.screenshot({ path: shot('zoom-bottom'), clip: { x: box.x, y: box.y + half, width: box.width, height: box.height - half } });
        }
        await zoom.close();
        if (PHASE === 'after' && fs.existsSync(MOCK)) sideBySide(MOCK, shot('conversation'), path.join(OUT, 'compare-gpt2.png'));
      }
      await ctx.close();
    }
    console.log(`photos in ${OUT}`);
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

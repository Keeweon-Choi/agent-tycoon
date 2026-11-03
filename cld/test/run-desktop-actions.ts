/**
 * DESKTOP-ACTIONS check (owner 11-03 13:07: in the desktop app's messenger 내려받기, 저장·공유 and
 * 새 탭에서 열기 did nothing and no floating notice showed). dist/cli.js with --engine on in an
 * isolated HOME whose `claude` is the engine fake, on port 18276 or 18277, headless Chromium
 * (--disable-gpu, through the shared harness). One lead (alpha) whose transcript holds an image.
 *
 * Browser 1280x800 (what browsers and phones keep):
 * - 복사 on a message: its toast is the topmost thing on screen, over the messenger window;
 * - in the viewer, 내려받기 downloads and its toast is over the viewer;
 * - 새 탭에서 열기 opens a popup that asks for the file itself;
 * - no 저장·공유 (headless Chromium cannot share; a browser never gets the save dialog instead).
 * The desktop app, simulated: a stub window.__TAURI_INTERNALS__ whose invoke records its calls, and
 * the app's own LINKS_JS taken from cld/desktop/src-tauri/src/lib.rs:
 * - 새 탭에서 열기 invokes open_external with the file's http URL, and a client with no cookie
 *   (the default browser) gets the image from it; no popup opens;
 * - 저장·공유 is shown and opens the save dialog (a stub showSaveFilePicker) with the file's
 *   name, and the file's bytes are written to it;
 * - the app's download event (what on_download sends) shows 다운로드 폴더에 저장했어요 over the viewer.
 * Screenshots go to cld/artifacts/desktop-actions/.
 *
 *   npx tsx cld/test/run-desktop-actions.ts <port 18276|18277>
 */
import type { Locator, Page } from '@playwright/test';
import { request } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18276 && port !== 18277) throw new Error('port must be 18276 or 18277');
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/desktop-actions');
const DEADLINE_MS = 240_000;
const LIB_RS = path.join(REPO_ROOT, 'cld/desktop/src-tauri/src/lib.rs');
/** The app's IPC bridge, its invoke calls recorded, and a save dialog that counts what is written. */
const APP_STUB = `(() => {
  const calls = [];
  const saved = [];
  window.__calls = calls;
  window.__saved = saved;
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve(null);
    },
  };
  window.showSaveFilePicker = async ({ suggestedName }) => ({
    createWritable: async () => {
      let bytes = 0;
      return {
        write: async (data) => { bytes += data.size; },
        close: async () => { saved.push({ name: suggestedName, bytes }); },
      };
    },
  });
})();`;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
async function until(what: string, fn: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
}

function picture(w: number, h: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) png.data.set([200, 90, (i % w) & 255, 255], i * 4);
  return PNG.sync.write(png);
}

/** The toast holding `text` is on screen and nothing covers its middle. */
const onTop = (page: Page, text: string) =>
  page.evaluate((text) => {
    const el = [...document.querySelectorAll('[role="status"]')].find((e) =>
      e.textContent?.includes(text),
    );
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.width > 0 && !!hit && el.contains(hit);
  }, text);

async function main(): Promise<void> {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const linksJs = /const LINKS_JS: &str = r#"([\s\S]*?)"#;/.exec(fs.readFileSync(LIB_RS, 'utf-8'))?.[1];
  if (!linksJs) throw new Error('LINKS_JS not found in lib.rs');
  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  const inbox = path.join(folder, '.cld-inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const deadline = setTimeout(() => {
    console.error(`deadline ${DEADLINE_MS / 1000} s`);
    void daemon.stop().then(() => {
      killFakeSessions(home);
      process.exit(2);
    });
  }, DEADLINE_MS);
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    const image = picture(600, 400);
    const imageName = '20261103-130700-a.png';
    fs.writeFileSync(path.join(inbox, imageName), image);
    await daemon.loginUrl();
    let session: { cwd: string; sessionId: string } | undefined;
    for (const end = Date.now() + 40_000; !session; ) {
      if (Date.now() > end) throw new Error('the engine did not revive alpha');
      for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : [])
        try {
          const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8'));
          if (s.name === 'alpha') session = s;
        } catch {
          /* being written */
        }
      await new Promise((r) => setTimeout(r, 300));
    }
    const transcript = transcriptPath(session.cwd, session.sessionId, home);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    const uuid = (i: number) => `${i.toString(16).padStart(8, '0')}-da00-4000-8000-000000000000`;
    const at = (i: number) => new Date(Date.now() - 60_000 + i * 1000).toISOString();
    fs.appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'user',
        uuid: uuid(1),
        timestamp: at(1),
        message: {
          role: 'user',
          content: `사진 한 장\n[첨부] ${path.join(inbox, imageName)} (image/png, ${Math.ceil(image.length / 1024)} KB)`,
        },
      })}\n${JSON.stringify({
        type: 'assistant',
        uuid: uuid(2),
        timestamp: at(2),
        message: { role: 'assistant', content: [{ type: 'text', text: '사진 받았어요' }] },
      })}\n`,
    );

    browser = await launchBrowser();
    const pageErrors: string[] = [];
    const open = async (app: boolean) => {
      const ctx = await browser!.newContext({
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      if (app) {
        // What the app injects: the IPC bridge (invoke recorded here) and its link script.
        // A string, not a function: tsx would add helpers the page does not have.
        await ctx.addInitScript({ content: APP_STUB });
        await ctx.addInitScript({ content: linksJs });
      }
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(BASE);
      const hud = page.getByRole('button', { name: /^메신저/ });
      await hud.waitFor();
      await hud.click();
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      await messenger
        .getByRole('list', { name: '연락처' })
        .getByRole('button', { name: /^alpha/ })
        .click();
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      await conv.getByText('사진 받았어요').waitFor({ timeout: 20_000 });
      return { ctx, page, conv };
    };
    const openViewer = async (page: Page, conv: Locator) => {
      await conv.locator(`[title$="a.png"]`).click();
      await page.locator('[data-testid="attach-viewer"]').waitFor();
      await page.locator('[data-testid="attach-download"]').waitFor();
    };
    const shot = (page: Page, name: string) =>
      page.screenshot({ path: path.join(OUT, `${name}.png`) });

    // ════ Browser ════
    {
      const { ctx, page, conv } = await open(false);
      const reply = conv.locator('[data-chat-id]').filter({ hasText: '사진 받았어요' }).last();
      await reply.hover();
      await reply.getByTestId('message-actions').getByRole('button', { name: '복사' }).click();
      await until('copy toast on top', () => onTop(page, '메시지를 복사했어요'));
      check(true, 'browser: the 복사 toast shows over the messenger window');
      await shot(page, 'browser-copy-toast');

      await openViewer(page, conv);
      check(
        (await page.locator('[data-testid="attach-share"]').count()) === 0,
        'browser: no 저장·공유 where the browser cannot share (never the save dialog instead)',
      );
      const download = page.waitForEvent('download');
      await page.locator('[data-testid="attach-download"]').click();
      check((await download).suggestedFilename().endsWith('a.png'), 'browser: 내려받기 downloads a.png');
      await until('download toast on top', () => onTop(page, '내려받았어요'));
      check(true, 'browser: the 내려받았어요 toast shows over the viewer');
      await shot(page, 'browser-viewer-download-toast');

      const popup = ctx.waitForEvent('page');
      const fileRequest = ctx.waitForEvent('request', (r) =>
        r.url().includes('/api/cld/files/content/'),
      );
      await page.locator('[data-testid="attach-open"]').click();
      const tab = await popup;
      check((await fileRequest).frame().page() === tab, 'browser: 새 탭에서 열기 opens a tab that asks for the file');
      await tab.close().catch(() => undefined);
      await ctx.close();
    }

    // ════ Desktop app (stub bridge + the app's LINKS_JS) ════
    {
      const { ctx, page, conv } = await open(true);
      await openViewer(page, conv);
      let popups = 0;
      ctx.on('page', () => popups++);
      await page.locator('[data-testid="attach-open"]').click();
      await until('open_external invoked', async () =>
        (await page.evaluate(() => (window as unknown as { __calls: { cmd: string }[] }).__calls))
          .some((c) => c.cmd === 'open_external'),
      );
      const calls = await page.evaluate(
        () => (window as unknown as { __calls: { cmd: string; args: { url?: string } }[] }).__calls,
      );
      const asked = calls.filter((c) => c.cmd === 'open_external');
      const url = asked[0]?.args?.url ?? '';
      check(
        asked.length === 1 && url.startsWith(`${BASE}api/cld/files/content/`) && popups === 0,
        `app: 새 탭에서 열기 invokes open_external once with ${url.replace(/content\/.*/, 'content/<ticket>')}, no popup`,
      );
      const outside = await request.newContext(); // the default browser: no cookie
      const got = await outside.get(url);
      check(
        got.status() === 200 &&
          (got.headers()['content-type'] ?? '').startsWith('image/png') &&
          (await got.body()).equals(image),
        'app: the default browser (no cookie) gets the image from that URL',
      );
      check((await outside.get(url)).status() === 401, 'app: the URL is used up after that');
      await outside.dispose();
      await until('opened toast', () => onTop(page, '새 탭에서 열었어요'));

      const share = page.locator('[data-testid="attach-share"]');
      check((await share.count()) === 1, 'app: 저장·공유 is offered (the save dialog)');
      await share.click();
      await until('saved toast', () => onTop(page, '저장했어요'));
      const saved = await page.evaluate(
        () => (window as unknown as { __saved: { name: string; bytes: number }[] }).__saved,
      );
      check(
        saved.length === 1 && saved[0].name.endsWith('a.png') && saved[0].bytes === image.length,
        `app: 저장·공유 asks where to save ${saved[0]?.name} and writes its ${saved[0]?.bytes} bytes`,
      );
      await shot(page, 'app-viewer-saved-toast');

      const download = page.waitForEvent('download');
      await page.locator('[data-testid="attach-download"]').click();
      await download;
      // What lib.rs on_download sends when WebView2 has written the file.
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('agent-tycoon-download', { detail: { name: 'a.png', ok: true } }),
        ),
      );
      await until('app download toast', () => onTop(page, '다운로드 폴더에 저장했어요: a.png'));
      check(true, "app: the app's download event shows 다운로드 폴더에 저장했어요 over the viewer");
      await shot(page, 'app-viewer-download-toast');
      await ctx.close();
    }

    check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
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

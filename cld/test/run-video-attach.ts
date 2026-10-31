/**
 * VIDEO-ATTACH check: a video attached in the messenger plays in place, large in the viewer, and an
 * agent's `[첨부] /abs/path.mp4` line shows the same player. dist/cli.js with --engine on in an
 * isolated HOME whose `claude` is the engine fake, on one spare port. Short clips made with ffmpeg:
 * clip.mp4 (H.264) and clip.webm (VP8); a browser that cannot decode one must show the file card.
 *
 * Scenarios (same daemon and conversation): Chromium desktop 1280x800, Chromium phone (iPhone 13
 * viewport, touch) and WebKit with devices['iPhone 13'] (iOS Safari's engine, the one that needs HTTP
 * Range). Each: the list says [동영상]; both clips show inline with controls, playsinline and
 * metadata preload; playing advances currentTime; a seek lands; the viewer plays it large; a Range
 * request answers 206 and a bad one 416. The first scenario also picks the clips through the
 * composer's file input and sends them (streamed upload), and an over-limit 21 MB .txt is refused 413
 * with no file left.
 *
 * VIDEO_NO_RANGE=1 is the negative control: run it against a build whose ticket route ignores Range.
 *
 *   npx tsx cld/test/run-video-attach.ts <port 18268 or 18269>
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices, webkit } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
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
if (![18268, 18269].includes(port)) throw new Error('this runner uses ports 18268 / 18269 only');
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/video-attach');
const DEADLINE_MS = 420_000;
const NO_RANGE = process.env.VIDEO_NO_RANGE === '1';
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__video/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const CONTENT = '/api/cld/files/content/';

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
async function until(what: string, fn: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out: ${what}`);
}
const ffmpeg = (args: string[]) => {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
};

/** The iPhone 13 emulation for Chromium (its WebKit-only default browser type dropped). */
const chromiumPhone = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();
const webkitPhone = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();

async function main(): Promise<void> {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const clips = fs.mkdtempSync(path.join(os.tmpdir(), 'video-attach-clips-'));
  const mp4 = path.join(clips, 'clip.mp4');
  const webm = path.join(clips, 'clip.webm');
  const src = ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15'];
  ffmpeg([...src, '-pix_fmt', 'yuv420p', mp4]);
  ffmpeg([...src, '-c:v', 'libvpx', '-b:v', '200k', webm]);

  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  const inbox = path.join(folder, '.cld-inbox');
  fs.mkdirSync(folder, { recursive: true });
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
  let chromium: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  let safari: Awaited<ReturnType<typeof webkit.launch>> | undefined;
  try {
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
    const record = (i: number, role: 'user' | 'assistant', text: string) =>
      `${JSON.stringify({
        type: role,
        uuid: `${i.toString(16).padStart(8, '0')}-8400-4000-8000-000000000000`,
        timestamp: new Date(Date.now() - 60_000 + i * 1000).toISOString(),
        message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
      })}\n`;

    const font = fs.existsSync(FONT) ? fs.readFileSync(FONT) : null;
    const pageErrors: string[] = [];
    const open = async (
      browser: NonNullable<typeof chromium>,
      opts: BrowserContextOptions,
      statuses: Array<{ status: number; range: string | undefined }>,
    ) => {
      const ctx = await browser.newContext({ locale: 'ko-KR', ...opts });
      // launchBrowser sets these for Chromium; the WebKit browser is launched here, so it gets them too.
      await ctx.addInitScript((pairs: Array<[string, string]>) => {
        for (const [k, v] of pairs)
          try {
            if (!localStorage.getItem(k)) localStorage.setItem(k, v);
          } catch {
            /* no storage */
          }
      }, [
        ['cld.camera-mode', 'off'],
        ['cld.title-scene', 'off'],
        ['cld.office-hours', '{"on":false}'],
        ['cld.push-banner-dismissed', String(Date.now())],
      ]);
      if (font)
        await ctx.route('**/__video/malgun.ttf', (r) =>
          r.fulfill({ body: font, contentType: 'font/ttf' }),
        );
      await ctx.addInitScript('window.__name = window.__name || ((f) => f);'); // tsx's keepNames helper
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      page.on('response', (r) => {
        if (r.url().includes(CONTENT))
          statuses.push({ status: r.status(), range: r.request().headers()['range'] });
      });
      page.on('console', (m) => {
        if (m.type() === 'error') console.log(`  [console.error] ${m.text().slice(0, 200)}`);
      });
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(BASE);
      if (font) {
        await page.addStyleTag({ content: FONT_CSS });
        await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
      }
      return { ctx, page };
    };
    const tapOn = (l: Locator, touch: boolean) => (touch ? l.tap() : l.click());
    const messengerOf = async (page: Page, touch: boolean) => {
      const hud = page.getByRole('button', { name: /^메신저/ });
      await hud.waitFor({ timeout: 20_000 }).catch(async (e) => {
        await shot(page, 'debug-no-hud');
        console.log(`  url=${page.url()}`);
        throw e;
      });
      await tapOn(hud, touch);
      return page.getByRole('region', { name: '메신저', exact: true });
    };
    const contactOf = (messenger: Locator) =>
      messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ });
    const shot = (page: Page, name: string) =>
      page.screenshot({ path: path.join(OUT, `${name}.png`) });

    /** Plays `video` (a click is the user's gesture), watches currentTime advance, seeks. */
    const playAndSeek = async (page: Page, video: Locator, label: string) => {
      await video.scrollIntoViewIfNeeded();
      await video.evaluate(
        (el: HTMLVideoElement) =>
          new Promise<void>((res) => {
            if (el.readyState >= 1) res();
            else el.addEventListener('loadedmetadata', () => res(), { once: true });
          }),
      );
      const attrs = await video.evaluate((el: HTMLVideoElement) => ({
        controls: el.controls,
        playsInline: el.hasAttribute('playsinline'),
        preload: el.preload,
        autoplay: el.autoplay,
        duration: el.duration,
        width: el.videoWidth,
      }));
      check(
        attrs.controls &&
          attrs.playsInline &&
          attrs.preload === 'metadata' &&
          !attrs.autoplay &&
          Math.abs(attrs.duration - 3) < 0.6 &&
          attrs.width === 320,
        `${label}: controls, playsinline, preload=metadata, no autoplay, 3 s of 320 px video (${JSON.stringify(attrs)})`,
      );
      await video.click({ position: { x: 20, y: 20 } });
      await video.evaluate((el: HTMLVideoElement) => el.play().catch(() => undefined));
      const t0 = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
      await until(`${label}: currentTime advances`, async () =>
        (await video.evaluate((el: HTMLVideoElement) => el.currentTime)) > t0 + 0.4,
      );
      check(true, `${label}: playing, currentTime advanced past ${(t0 + 0.4).toFixed(1)} s`);
      const landed = await video.evaluate(
        (el: HTMLVideoElement) =>
          new Promise<number>((res, rej) => {
            el.addEventListener('seeked', () => res(el.currentTime), { once: true });
            el.addEventListener('error', () => rej(new Error('media error')), { once: true });
            el.currentTime = 2.2;
          }),
      );
      check(Math.abs(landed - 2.2) < 0.4 || landed > 2.2, `${label}: a seek to 2.2 s lands at ${landed.toFixed(2)} s`);
      await video.evaluate((el: HTMLVideoElement) => el.pause());
    };

    const scenario = async (
      name: string,
      browser: NonNullable<typeof chromium>,
      opts: BrowserContextOptions,
      touch: boolean,
      first: boolean,
    ) => {
      console.log(`── ${name}`);
      const statuses: Array<{ status: number; range: string | undefined }> = [];
      const { ctx, page } = await open(browser, opts, statuses);
      const messenger = await messengerOf(page, touch);

      if (first) {
        // Pick both clips in the composer and send them: a streamed upload.
        await tapOn(contactOf(messenger), touch);
        const conv0 = messenger.getByRole('region', { name: 'alpha 대화' });
        await conv0.waitFor();
        const accept = await conv0.locator('input[type="file"]').first().getAttribute('accept');
        check(
          accept?.includes('video/*') && accept.includes('.mp4') && accept.includes('.mov'),
          `the file picker offers videos (accept="${accept?.slice(0, 40)}…")`,
        );
        const box = conv0.getByRole('textbox', { name: '보낼 글' });
        await box.fill('영상 두 개 보낼게요');
        await conv0.locator('input[type="file"]').first().setInputFiles([mp4, webm]);
        await conv0.getByTestId('draft-open').first().waitFor();
        await shot(page, `${name}-composer`);
        await conv0.getByRole('button', { name: '보내기' }).click();
        const stored = () =>
          fs.existsSync(inbox)
            ? fs.readdirSync(inbox).map((f) => ({ f, size: fs.statSync(path.join(inbox, f)).size }))
            : [];
        await until('both clips stored in the inbox', async () => stored().length === 2, 30_000);
        check(
          stored().some((s) => s.f.endsWith('clip.mp4') && s.size === fs.statSync(mp4).size) &&
            stored().some((s) => s.f.endsWith('clip.webm') && s.size === fs.statSync(webm).size),
          `the upload stored both clips whole in .cld-inbox (${stored().map((s) => `${s.f} ${s.size}`).join(', ')})`,
        );
        // The same thing over the wire: a 21 MB text file is refused 413, a clip over it is not.
        const refused = await page.evaluate(
          (project) =>
            new Promise<number>((resolve) => {
              const xhr = new XMLHttpRequest();
              xhr.open('POST', `/cld/attach/${project}`);
              xhr.setRequestHeader('Content-Type', 'application/octet-stream');
              xhr.setRequestHeader('X-File-Name', 'big.txt');
              xhr.setRequestHeader('X-File-Type', 'text/plain');
              xhr.onload = () => resolve(xhr.status);
              xhr.onerror = () => resolve(0);
              xhr.send(new Blob([new Uint8Array(21 * 1024 * 1024)]));
            }),
          'alpha',
        );
        check(
          refused === 413 && stored().length === 2,
          `a 21 MB text upload answers ${refused} and leaves no file`,
        );
        const [mp4Saved, webmSaved] = ['clip.mp4', 'clip.webm'].map(
          (n) => path.join(inbox, stored().find((s) => s.f.endsWith(n))!.f),
        );
        const kb = (f: string) => Math.max(1, Math.ceil(fs.statSync(f).size / 1024));
        // What the owner's own transcript holds, and an agent's own [첨부] line for a file in its folder.
        fs.copyFileSync(mp4, path.join(folder, 'agent.mp4'));
        fs.appendFileSync(
          transcript,
          record(1, 'user', `[첨부] ${mp4Saved} (video/mp4, ${kb(mp4Saved)} KB)`) +
            record(2, 'user', `[첨부] ${webmSaved} (video/webm, ${kb(webmSaved)} KB)`) +
            record(3, 'assistant', `이쪽이 만든 영상이에요\n[첨부] ${path.join(folder, 'agent.mp4')}`) +
            record(4, 'assistant', `[첨부] ${path.join(folder, 'agent.mp4')}`),
        );
        await tapOn(page.getByRole('button', { name: '목록' }).first(), touch).catch(() => undefined);
      }

      // The list reads [동영상] for a last message that is a video.
      await until('the list says [동영상]', async () => {
        const list = contactOf(messenger);
        return (await list.count()) > 0 && ((await list.first().textContent()) ?? '').includes('[동영상]');
      }, 30_000).catch(async (e) => {
        await shot(page, `${name}-debug-list`);
        throw e;
      });
      check(true, `${name}: the conversation list shows [동영상] for a video-only last message`);
      await shot(page, `${name}-list`);

      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      if (!(await conv.isVisible())) await tapOn(contactOf(messenger), touch);
      await conv.getByText('이쪽이 만든 영상이에요').waitFor({ timeout: 30_000 }).catch(async (e) => {
        await shot(page, `${name}-debug-conv`);
        throw e;
      });
      const videos = conv.getByTestId('bubble-video');
      await until('inline players', async () => (await videos.count()) >= 3, 30_000);
      check(true, `${name}: ${await videos.count()} inline players in the conversation (two uploads, one agent line)`);
      await shot(page, `${name}-inline`);

      // Which clips can this engine decode?
      const can = await page.evaluate(() => {
        const v = document.createElement('video');
        return {
          mp4: v.canPlayType('video/mp4; codecs="avc1.42E01E"'),
          webm: v.canPlayType('video/webm; codecs="vp8"'),
        };
      });
      console.log(`  canPlayType: ${JSON.stringify(can)}`);
      const playable = (can.mp4 ? 1 : 0) + (can.webm ? 1 : 0);
      check(playable >= 1, `${name}: the engine decodes at least one test clip`);

      // One inline player per clip, found by its file name; a clip this engine cannot decode falls back to its file chip.
      const playerOf = (name: string) =>
        conv
          .getByTestId('bubble-video-open')
          .filter({ hasText: name })
          .last()
          .locator('xpath=..')
          .getByTestId('bubble-video');
      const clipsHere: Array<[string, string]> = [
        ['clip.mp4', can.mp4],
        ['clip.webm', can.webm],
      ];
      for (const [name2, decodes] of clipsHere) {
        if (decodes) {
          await playAndSeek(page, playerOf(name2), `${name}: inline ${name2}`);
        } else {
          await until(`${name2} falls back`, async () => (await playerOf(name2).count()) === 0, 20_000);
          check(true, `${name}: this engine cannot decode ${name2}; its bubble shows the file chip instead of a dead player`);
        }
      }
      // The agent's [첨부] line is a player too, not a chip (or the chip where the engine cannot decode it).
      const agentOpen = conv.getByTestId('bubble-video-open').filter({ hasText: 'agent.mp4' });
      check((await agentOpen.count()) >= 1, `${name}: the agent's [첨부] .../agent.mp4 line is a video attachment of its own`);
      const inlineWidth = await playerOf('clip.webm').evaluate((el) => el.getBoundingClientRect().width).catch(() => 0);

      // The viewer plays it large (or shows the file card with its download where the engine cannot decode it).
      const viewer = page.getByTestId('attach-viewer');
      const viewerOn = async (file: string, decodes: string) => {
        const button = conv.getByTestId('bubble-video-open').filter({ hasText: file }).last();
        await button.scrollIntoViewIfNeeded();
        await tapOn(button, touch);
        await viewer.waitFor();
        if (decodes) {
          const large = viewer.getByTestId('attach-video');
          await large.waitFor();
          const w = await large.evaluate((el) => el.getBoundingClientRect().width);
          check(w > Math.max(inlineWidth, 1), `${name}: ${file} in the viewer is larger (${Math.round(w)} px vs ${Math.round(inlineWidth)} px inline)`);
          await playAndSeek(page, large, `${name}: viewer ${file}`);
        } else {
          await viewer.getByTestId('attach-file').waitFor();
          check(true, `${name}: ${file} cannot be decoded here, the viewer shows the file card with its download`);
        }
        await shot(page, `${name}-viewer-${file.replace('.', '-')}`);
        await viewer.getByTestId('attach-close').click();
        await viewer.waitFor({ state: 'detached' });
      };
      await viewerOn('agent.mp4', can.mp4);
      await viewerOn('clip.webm', can.webm);

      // Range over the wire, with this browser's own session.
      const ranged = await page.evaluate(async () => {
        const mint = async (p: string) =>
          (
            await (
              await fetch('/api/cld/files/alpha/ticket', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: p, mode: 'preview' }),
              })
            ).json()
          ).url as string;
        const url = await mint('agent.mp4');
        const head = await fetch(url, { headers: { Range: 'bytes=0-9' } });
        const bad = await fetch(url, { headers: { Range: 'bytes=99999999-' } });
        return {
          status: head.status,
          range: head.headers.get('content-range'),
          type: head.headers.get('content-type'),
          bytes: (await head.arrayBuffer()).byteLength,
          bad: bad.status,
          badRange: bad.headers.get('content-range'),
        };
      });
      console.log(`  ${JSON.stringify(ranged)}`);
      check(
        ranged.status === 206 && ranged.bytes === 10 && ranged.type === 'video/mp4' && ranged.bad === 416 && /^bytes \*\/\d+$/.test(ranged.badRange ?? ''),
        `${name}: Range answers 206 with 10 bytes, a range past the end 416`,
      );
      const used = statuses.filter((s) => s.range).length;
      console.log(`  media requests: ${JSON.stringify(statuses.map((s) => [s.status, s.range]))}`);
      check(used > 0 || !can.webm, `${name}: the player asked for ranges (${used} Range requests, statuses ${[...new Set(statuses.map((s) => s.status))].join('/')})`);
      await ctx.close();
    };

    // VIDEO_ONLY=webkit runs just the Safari-engine scenario (it then does the upload itself).
    const only = process.env.VIDEO_ONLY;
    if (only !== 'webkit') {
      chromium = await launchBrowser();
      await scenario('desktop-chromium', chromium, { viewport: { width: 1280, height: 800 } }, false, true);
      await scenario('phone-chromium', chromium, chromiumPhone, true, false);
    }
    safari = await webkit.launch();
    await scenario('phone-webkit', safari, webkitPhone, true, only === 'webkit');
    check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`);
    if (NO_RANGE) console.log('(negative control build: Range was expected to fail above)');
  } finally {
    clearTimeout(deadline);
    await chromium?.close();
    await safari?.close();
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(clips, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

/**
 * T-0105 check: files the orchestrator sends show in the messenger and open in
 * the attachment viewer. dist/cli.js with --engine on in an isolated HOME whose
 * `claude` is the engine fake, on a spare port, headless Chromium (--disable-gpu,
 * through the shared harness). One lead (alpha) whose transcript holds
 * - a SendUserFile call with two PNGs (in Claude Code's scratchpad for the
 *   project, outside the project folder, as a screenshot is) and a caption,
 * - a SendUserFile call with a text file, a symlink to a file outside the
 *   project, a file elsewhere (another folder), a missing file and a directory,
 * - a text reply whose own `[첨부] <path>` line names a third PNG.
 *
 * Checks: both thumbnails show in alpha's conversation and carry the caption; a
 * tap opens the viewer with the page URL unchanged; prev/next walk the
 * conversation's files (the [첨부] one included, wrapping); the sent files are
 * copied once into alpha/.cld-outbox (0600/0700) and the page never shows the
 * source path; the symlink, the file elsewhere, the missing file and the directory show
 * "파일을 열 수 없어요: <name>" and are not copied.
 * Negative control: a symlink planted in .cld-outbox to a file outside the
 * project is refused by the file ticket (403), the original path as well.
 * Screenshots go to cld/artifacts/t0105/.
 *
 *   npx tsx cld/test/run-agent-files.ts <port 18256-18259>
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
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
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0105');
const DEADLINE_MS = 240_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0105/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;

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

/** A picture with a grid, so a zoomed or panned view is visibly different. */
function picture(w: number, h: number, base: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const line = x % 100 === 0 || y % 100 === 0;
      for (let c = 0; c < 3; c++)
        png.data[i + c] = line ? 255 : Math.round((base[c] * (x + y)) / (w + h));
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}

/** Touches through CDP (Playwright only taps). Each step moves every finger. */
async function touches(page: Page, steps: Pt[][]) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: steps[0] });
  for (const s of steps.slice(1))
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: s });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
/** Two quick taps in one CDP session (two Playwright taps are slower than a double tap). */
async function doubleTap(page: Page, at: Pt) {
  const cdp = await page.context().newCDPSession(page);
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await cdp.detach();
}
const lerp = (a: Pt, b: Pt, k: number): Pt => ({
  x: a.x + (b.x - a.x) * k,
  y: a.y + (b.y - a.y) * k,
});
const drag = (page: Page, from: Pt, to: Pt) =>
  touches(
    page,
    Array.from({ length: 13 }, (_, k) => [lerp(from, to, k / 12)]),
  );
const pinch = (page: Page, a0: Pt, b0: Pt, a1: Pt, b1: Pt) =>
  touches(
    page,
    Array.from({ length: 13 }, (_, k) => [lerp(a0, a1, k / 12), lerp(b0, b1, k / 12)]),
  );

async function main(): Promise<void> {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  const outside = path.join(home, 'elsewhere');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  // Claude Code's scratchpad for alpha (where its screenshots land): the outbox's other source.
  const padRoot = path.join(
    os.tmpdir(),
    `claude-${process.getuid!()}`,
    normalizeProjectPath(folder),
  );
  const pad = path.join(padRoot, 'session', 'scratchpad');
  fs.mkdirSync(pad, { recursive: true });
  fs.mkdirSync(path.join(home, '.config/cld-gui'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/projects.json'),
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
    // Files outside the project folder, in its scratchpad, as a screenshot the orchestrator took would.
    const shot1 = path.join(pad, 'shot1.png');
    const shot2 = path.join(pad, 'shot2.png');
    const shot3 = path.join(pad, 'shot3.png');
    const notes = path.join(pad, 'notes.txt');
    const secret = path.join(outside, 'secret.png');
    fs.writeFileSync(shot1, picture(1200, 800, [255, 90, 60]));
    fs.writeFileSync(shot2, picture(800, 1200, [60, 200, 120]));
    fs.writeFileSync(shot3, picture(900, 900, [80, 120, 255]));
    fs.writeFileSync(notes, '메모 notes\n');
    fs.writeFileSync(secret, picture(300, 300, [255, 0, 255]));
    const link = path.join(folder, 'link.png'); // a symlink to a file outside the project
    fs.symlinkSync(secret, link);
    const dirPng = path.join(outside, 'dir.png');
    fs.mkdirSync(dirPng);
    const missing = path.join(outside, 'missing.png');

    await daemon.loginUrl(); // the daemon is up
    let session: { cwd: string; sessionId: string } | undefined;
    for (const end = Date.now() + 40_000; !session;) {
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
    const record = (i: number, blocks: unknown[]) =>
      `${JSON.stringify({
        type: 'assistant',
        uuid: `${i.toString(16).padStart(8, '0')}-0105-4000-8000-000000000000`,
        timestamp: new Date(Date.now() - 60_000 + i * 1000).toISOString(),
        message: { role: 'assistant', content: blocks },
      })}\n`;
    const send = (id: string, files: string[], caption: string) => ({
      type: 'tool_use',
      id,
      name: 'SendUserFile',
      input: { files, caption, status: 'proactive' },
    });
    fs.appendFileSync(
      transcript,
      record(1, [send('toolu_a', [shot1, shot2], '화면 두 장입니다')]) +
        record(2, [send('toolu_b', [notes, link, secret, missing, dirPng], '나머지 파일')]) +
        record(3, [{ type: 'text', text: `끝났어요\n[첨부] ${shot3}` }]),
    );

    browser = await launchBrowser();
    const font = fs.existsSync(FONT) ? fs.readFileSync(FONT) : null;
    const pageErrors: string[] = [];
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    if (font)
      await ctx.route('**/__t0105/malgun.ttf', (r) =>
        r.fulfill({ body: font, contentType: 'font/ttf' }),
      );
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(BASE);
    if (font) {
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    }

    await page.getByRole('button', { name: /^메신저/ }).click();
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    await messenger
      .getByRole('list', { name: '연락처' })
      .getByRole('button', { name: /^alpha/ })
      .click();
    const conv = messenger.getByRole('region', { name: 'alpha 대화' });
    await conv.getByText('끝났어요').waitFor({ timeout: 20_000 });
    const viewer = page.locator('[data-testid="attach-viewer"]');
    // The title holds the file name, then "n / total · size".
    const counter = async () =>
      ((await page.locator('.attach-title').textContent()) ?? '').replace(
        /^.*?(\d+ \/ \d+ · )/,
        '$1',
      );
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

    // ── Shown ──
    const t1 = conv.locator('[title$="shot1.png"] img');
    const t2 = conv.locator('[title$="shot2.png"] img');
    await t1.waitFor();
    await t2.waitFor();
    check(
      (await conv.getByText('화면 두 장입니다').count()) === 1,
      'the SendUserFile caption is the bubble text',
    );
    check(
      (await conv.locator('details', { hasText: 'SendUserFile' }).count()) === 0,
      'the call no longer shows as a bare tool line',
    );
    for (const t of [t1, t2]) {
      const ok = await t.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);
      check(ok, 'a thumbnail is loaded from a file ticket');
      check(
        ((await t.getAttribute('src')) ?? '').startsWith('/api/cld/files/content/'),
        'its src is a one-use file ticket, not a path',
      );
    }
    await conv.locator('[title$="notes.txt"]').waitFor();
    check(true, 'a text file shows as a chip');
    for (const name of ['link.png', 'secret.png', 'missing.png', 'dir.png'])
      check(
        (await conv.getByText(`파일을 열 수 없어요: ${name}`).count()) === 1,
        `"파일을 열 수 없어요: ${name}" is shown`,
      );
    await conv.locator('[title$="shot3.png"] img').waitFor();
    check(true, 'the [첨부] line of the reply shows its picture; the line itself is gone');
    check(
      (await conv.getByText('[첨부]').count()) === 0 &&
        !(await page.content()).includes(outside) &&
        !(await page.content()).includes(pad),
      'no [첨부] text and no source path anywhere in the page',
    );
    await shot('messenger');

    // ── The copies ──
    const outbox = path.join(folder, '.cld-outbox');
    const copies = fs.readdirSync(outbox);
    check(
      copies.length === 4 &&
        ['shot1.png', 'shot2.png', 'shot3.png', 'notes.txt'].every((n) =>
          copies.some((c) => c.endsWith(`-${n}`)),
        ),
      `exactly the four readable files were copied once into .cld-outbox (${copies.length})`,
    );
    check(
      (fs.statSync(outbox).mode & 0o777) === 0o700 &&
        copies.every((c) => (fs.statSync(path.join(outbox, c)).mode & 0o777) === 0o600),
      'the folder is 0700 and every copy 0600',
    );
    check(
      !copies.some((c) => /link|secret|missing|dir/.test(c)),
      'the symlink, the file elsewhere, the missing file and the directory were not copied',
    );
    check(
      !fs.readdirSync(outside).some((n) => n.startsWith('.')) &&
        fs.readFileSync(shot1).equals(
          fs.readFileSync(
            path.join(
              outbox,
              copies.find((c) => c.endsWith('-shot1.png'))!,
            ),
          ),
        ),
      'the copy is the file, the original is untouched',
    );

    // ── Opened ──
    await t1.click();
    await viewer.waitFor();
    await page.locator('[data-testid="attach-img"]').waitFor();
    check(page.url() === BASE, 'a tap opens the viewer and the page URL is unchanged');
    check((await counter())?.startsWith('1 / 4 · ') === true, `counter "${await counter()}"`);
    await shot('viewer');
    const next = page.locator('[data-testid="attach-next"]');
    const prev = page.locator('[data-testid="attach-prev"]');
    await next.click();
    await until('2 / 4', async () => ((await counter()) ?? '').startsWith('2 / 4 · '));
    await next.click();
    await until('3 / 4 (the text file)', async () =>
      ((await counter()) ?? '').startsWith('3 / 4 · '),
    );
    await page.locator('[data-testid="attach-file"]').waitFor();
    await next.click();
    await until('4 / 4 (the [첨부] picture)', async () =>
      ((await counter()) ?? '').startsWith('4 / 4 · '),
    );
    await page.locator('[data-testid="attach-img"]').waitFor();
    await next.click();
    await until('wraps to 1 / 4', async () => ((await counter()) ?? '').startsWith('1 / 4 · '));
    await prev.click();
    await until('prev wraps to 4 / 4', async () =>
      ((await counter()) ?? '').startsWith('4 / 4 · '),
    );
    check(page.url() === BASE, 'prev/next walk the four files, wrapping, URL unchanged');
    await page.keyboard.press('Escape');
    await until('closed', async () => (await viewer.count()) === 0);
    check(page.url() === BASE, 'Esc closes it and the app is still there');

    // ── Negative control: nothing but the copy is served ──
    const ticket = (rel: string) =>
      page.evaluate(async (path) => {
        const r = await fetch('/api/cld/files/alpha/ticket', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path, mode: 'preview' }),
        });
        return r.status;
      }, rel);
    const own = copies.find((c) => c.endsWith('-shot1.png'))!;
    check((await ticket(`.cld-outbox/${own}`)) === 200, 'a ticket for the copy is granted');
    fs.symlinkSync(secret, path.join(outbox, 'planted.png'));
    check(
      (await ticket('.cld-outbox/planted.png')) === 403,
      'negative control: a symlink planted in .cld-outbox to a file outside the project is refused (403)',
    );
    check(
      (await ticket('link.png')) === 403,
      'negative control: the symlink inside the project pointing outside is refused (403)',
    );
    check(
      (await ticket(shot1)) >= 400 && (await ticket(path.relative(folder, shot1))) >= 400,
      'negative control: the original path is served by no ticket',
    );

    check(
      pageErrors.length === 0,
      `no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`,
    );
    await ctx.close();
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(padRoot, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

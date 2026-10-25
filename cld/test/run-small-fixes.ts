/**
 * SMALL-FIXES check, desktop 1280x800 and phone 393x852 (touch). dist/cli.js with --engine on in an
 * isolated HOME whose `claude` is the engine fake, on a spare port, headless Chromium (--disable-gpu).
 * 1. The messenger composer: with a multi-line draft being typed, a click/tap on an attachment chip
 *    opens the viewer on the FIRST click and the input keeps its height (it used to shrink on blur,
 *    the layout moved and the click missed). A press on the footer's padding keeps it too; a press
 *    outside the footer shrinks it again.
 * 2. The 현황판: a running tool's own description is still there after the page reloads (the
 *    resend snapshot carries it), never "명령 실행 중".
 * Screenshots go to cld/artifacts/small-fixes/.
 *
 *   npx tsx cld/test/run-small-fixes.ts <port 18256-18259>
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
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

const port = sparePort();
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/small-fixes');
const DEADLINE_MS = 240_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sf/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const IPHONE13 = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();
const DESC = '보드 화면의 단위 시험을 돌려서 결과를 확인';
const COMMAND = 'cd /work/alpha/packages/board && npm test -- --run --reporter=verbose';

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
async function until(what: string, fn: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out: ${what}`);
}

async function main(): Promise<void> {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
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
    await daemon.loginUrl();
    let session: { cwd: string; sessionId: string } | undefined;
    for (const end = Date.now() + 40_000; !session;) {
      if (Date.now() > end) throw new Error('the engine did not revive alpha');
      for (const f of fs.readdirSync(sessions))
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
    fs.appendFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        uuid: '00000001-5f00-4000-8000-000000000000',
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        message: { role: 'user', content: '안녕' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          uuid: '00000002-5f00-4000-8000-000000000000',
          timestamp: new Date(Date.now() - 59_000).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: '반가워요' }] },
        }) +
        '\n',
    );

    const png = new PNG({ width: 64, height: 64 });
    png.data.fill(200);
    const picture = PNG.sync.write(png);

    browser = await launchBrowser();
    const font = fs.existsSync(FONT) ? fs.readFileSync(FONT) : null;
    const pageErrors: string[] = [];
    const open = async (opts: BrowserContextOptions) => {
      const ctx = await browser!.newContext(opts);
      if (font)
        await ctx.route('**/__sf/malgun.ttf', (r) =>
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
      return { ctx, page };
    };
    const shot = (page: Page, name: string) =>
      page.screenshot({ path: path.join(OUT, `${name}.png`) });

    const composer = async (page: Page, touch: boolean, label: string) => {
      const hud = page.getByRole('button', { name: '메신저', exact: true });
      await hud.waitFor();
      await (touch ? hud.tap() : hud.click());
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      const alpha = messenger
        .getByRole('list', { name: '연락처' })
        .getByRole('button', { name: /^alpha/ });
      await (touch ? alpha.tap() : alpha.click());
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      await conv.getByText('반가워요').waitFor({ timeout: 20_000 });
      await messenger
        .locator('input[type="file"]')
        .first()
        .setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: picture });
      const chip = messenger.locator('[data-testid="draft-open"]');
      await chip.waitFor();
      const box = messenger.getByRole('textbox', { name: '보낼 글' });
      const height = async () => (await box.boundingBox())!.height;
      const collapsed = await height();
      await (touch ? box.tap() : box.click());
      await box.fill('쓰던 글\n둘째 줄\n셋째 줄');
      const typing = await height();
      check(
        typing > collapsed + 10,
        `${label}: a multi-line draft is taller (${typing}) than collapsed (${collapsed})`,
      );
      await shot(page, `${label}-typing`);

      // 1. a press on the footer's padding keeps the size
      const foot = (await box.evaluate((el) =>
        el.closest('footer')!.getBoundingClientRect().toJSON(),
      )) as {
        left: number;
        top: number;
      };
      if (touch) await page.touchscreen.tap(foot.left + 3, foot.top + 3);
      else await page.mouse.click(foot.left + 3, foot.top + 3);
      await page.waitForTimeout(300);
      check(
        (await height()) === typing,
        `${label}: a press on the footer padding keeps the input height`,
      );

      // 2. the chip opens on the first click, the input keeps its height
      await (touch ? box.tap() : box.click());
      const chipBefore = await chip.boundingBox();
      await (touch ? chip.tap() : chip.click());
      const viewer = page.locator('[data-testid="attach-viewer"]');
      await viewer.waitFor({ timeout: 5_000 });
      check(true, `${label}: the attachment chip opens the viewer on the first click`);
      await shot(page, `${label}-viewer`);
      await page.keyboard.press('Escape'); // a press on the close button would be outside the footer
      await viewer.waitFor({ state: 'detached' });
      check(
        (await height()) === typing && Math.abs((await chip.boundingBox())!.y - chipBefore!.y) < 1,
        `${label}: input height (${typing}) and chip position unchanged after the chip click`,
      );
      await shot(page, `${label}-after-chip`);

      // 3. a press outside the composer shrinks it again
      const list = messenger.getByRole('region', { name: 'alpha 대화' }).getByText('반가워요');
      await (touch ? list.tap() : list.click());
      await until(
        `${label}: shrinks after a press outside`,
        async () => (await height()) === collapsed,
      );
      check(true, `${label}: a press outside the footer shrinks the input again (${collapsed})`);
      await (touch ? hud.tap() : hud.click()); // close the messenger again
    };

    const board = async (page: Page, touch: boolean, label: string) => {
      if (touch) await page.locator('[data-dock="board"]').tap();
      else {
        const icon = page.locator('[data-hud-id="icon:office"] button');
        await icon.waitFor();
        if (!(await page.locator('[data-hud-window="office"]').isVisible())) await icon.click();
        await page.locator('[data-hud-window="office"]').waitFor();
      }
      const row = page.locator('article').filter({
        has: page.getByRole('heading', { name: 'alpha', exact: true }),
      });
      await row.waitFor();
      const btn = row.getByRole('button', { name: 'alpha', exact: true });
      await (touch ? btn.tap() : btn.click());
      await until(`${label}: alpha's line reads its description`, async () =>
        (await row.innerText()).includes(DESC),
      );
      check(
        !(await row.innerText()).includes('명령 실행 중'),
        `${label}: no generic "명령 실행 중"`,
      );
      return row;
    };

    // ── Desktop ──
    const desk = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await composer(desk.page, false, 'desktop');
    // the tool starts; the transcript names its own description
    fs.appendFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-5',
          content: [
            {
              type: 'tool_use',
              id: 'tu-sf-1',
              name: 'Bash',
              input: { command: COMMAND, description: DESC },
            },
          ],
        },
      }) + '\n',
    );
    await board(desk.page, false, 'desktop');
    await shot(desk.page, 'desktop-board-live');
    await desk.page.reload();
    await desk.page.waitForURL(BASE);
    const row = await board(desk.page, false, 'desktop after reload');
    check((await row.innerText()).includes(DESC), 'desktop: the description survives a reload');
    await shot(desk.page, 'desktop-board-after-reload');
    await desk.ctx.close();

    // ── Phone ──
    const ph = await open({ ...IPHONE13, viewport: { width: 393, height: 852 } });
    await composer(ph.page, true, 'phone');
    await board(ph.page, true, 'phone');
    await ph.page.reload();
    await ph.page.waitForURL(BASE);
    const prow = await board(ph.page, true, 'phone after reload');
    check((await prow.innerText()).includes(DESC), 'phone: the description survives a reload');
    await shot(ph.page, 'phone-board-after-reload');
    await ph.ctx.close();

    check(
      pageErrors.length === 0,
      `no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`,
    );
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

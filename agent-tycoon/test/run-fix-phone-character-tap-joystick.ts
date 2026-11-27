/**
 * FIX-PHONE-CHARACTER-TAP (T-106): on the phone a tap on a character only selects it, so the walking
 * pad stays free; the information sheet opens by a second action (a tap on the selected character,
 * or the selection chip). dist/cli.js with --engine on in an isolated HOME whose `claude` is the
 * engine fake, headless Chromium (--disable-gpu), a 390x844 touch phone in both screen styles, then
 * a 1280x800 desktop whose click still opens the inspector.
 *
 * Phone, per style: a real touch tap on the character -> selected, no sheet, the pad and the chip
 * show and nothing covers the pad; dragging the pad walks the selected character; the chip opens
 * the sheet, closing it leaves the character selected; a tap on the selected character opens it.
 * Screenshots go to agent-tycoon/artifacts/t0106/.
 *
 *   npx tsx agent-tycoon/test/run-fix-phone-character-tap-joystick.ts <port 18260-18599>
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { transcriptPath } from '../../server/src/agent-tycoon/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/t0106');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0106/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
/** From the bottom of the nameplate down onto the character's body. */
const BODY_BELOW_PLATE_PX = 18;
const DEADLINE_MS = 240_000;
const LEADS = ['alpha', 'beta'];

function check(ok: unknown, what: string): void {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
  if (!ok) process.exitCode = 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Tile {
  col: number;
  row: number;
  active: boolean;
}
type Hooks = {
  getCharacterTile: (id: number) => Tile | null;
  getSelectedAgentId: () => number | null;
  selectAgent: (id: number) => void;
  follow: (id: number) => void;
};
const hooks = <T>(page: Page, fn: (h: Hooks, a: any) => T, arg?: unknown): Promise<T> =>
  page.evaluate(
    ([src, a]) =>
      (new Function('h', 'a', `return (${src})(h, a)`) as (h: unknown, a: unknown) => T)(
        (window as unknown as { __agentTycoonTestHooks: Hooks }).__agentTycoonTestHooks,
        a,
      ),
    [fn.toString(), arg] as const,
  );

type Pt = { x: number; y: number };
/** A finger that goes down at `from`, drags to `to` in steps, stays `holdMs`, and lifts. */
async function drag(page: Page, from: Pt, to: Pt, holdMs: number, during?: () => Promise<void>) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (p: Pt) => [{ x: p.x, y: p.y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from) });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: pt({
        x: from.x + ((to.x - from.x) * i) / 6,
        y: from.y + ((to.y - from.y) * i) / 6,
      }),
    });
    await sleep(16);
  }
  await sleep(holdMs);
  await during?.();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      LEADS.map((name, i) => {
        const folder = path.join(home, 'work', name);
        fs.mkdirSync(folder, { recursive: true });
        return { name, folder, room: i < 2 ? '개발실' : '연구실', wantRunning: true };
      }),
    ),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const { child: server } = daemon;
  const deadline = setTimeout(() => {
    console.error(`aborted: deadline ${DEADLINE_MS / 1000} s`);
    server.kill('SIGKILL');
    killFakeSessions(home);
    process.exit(1);
  }, DEADLINE_MS);

  type Sess = { sessionId: string; cwd: string; name: string };
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
  // Claude, played: a lead is working while its transcript ends in a tool call,
  // and idle (after the 5 s text-idle timer) when it ends in a plain reply.
  let uuid = 0;
  const append = (name: string, record: Record<string, unknown>) => {
    const s = sessionOf(name)!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    fs.appendFileSync(
      file,
      `${JSON.stringify({ uuid: id, timestamp: new Date().toISOString(), ...record })}\n`,
    );
  };
  const rest = (name: string) => {
    append(name, { type: 'user', message: { role: 'user', content: '정리해 줘' } });
    append(name, {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '정리했어요.' }] },
    });
  };
  const browser = await launchBrowser();
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  try {
    for (const end = Date.now() + 40_000; !LEADS.every((n) => sessionOf(n));) {
      if (Date.now() > end) throw new Error('the engine did not revive the sessions');
      await sleep(300);
    }
    for (const n of LEADS) rest(n);

    const open = async (phone: boolean, theme: 'modern' | 'pixel') => {
      const ctx = await browser.newContext(
        phone
          ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
          : { viewport: { width: 1280, height: 800 } },
      );
      await ctx.route('**/__t0106/malgun.ttf', (route) =>
        route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
      );
      await ctx.addInitScript((th) => {
        (window as unknown as { __AGENT_TYCOON_E2E: boolean }).__AGENT_TYCOON_E2E = true;
        (window as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
        localStorage.setItem('agty.title-scene', 'off');
        localStorage.setItem('agty.office-iso', 'off');
        localStorage.setItem('agty.ui-theme', th);
        localStorage.setItem(
          'agty.office-hours',
          JSON.stringify({ on: false, start: 540, end: 1080, days: [1, 2, 3, 4, 5], lingerMin: 10 }),
        );
      }, theme);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
      await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
      await sleep(2000);
      return { ctx, page };
    };
    const pageErrors: string[] = [];
    const selected = (page: Page) => hooks(page, (h) => h.getSelectedAgentId());
    const sheet = (page: Page) => page.getByTestId('inspector');

    /** A point on the character's body (CSS px): under the middle of its nameplate, read again each time
     *  (a selection moves the camera after it). */
    const bodyOf = async (page: Page, id: number): Promise<Pt> => {
      const r = (await page.locator(`[data-testid="agent-overlay"][data-agent-id="${id}"]`).first().boundingBox())!;
      return { x: r.x + r.width / 2, y: r.y + r.height + BODY_BELOW_PLATE_PX };
    };
    /** The nameplate has stood still for 1 s (a character on a coffee break is still walking). */
    const still = async (page: Page, id: number) => {
      let last = '';
      let since = Date.now();
      for (const end = Date.now() + 30_000; Date.now() < end; await sleep(200)) {
        const now = JSON.stringify(await bodyOf(page, id));
        if (now !== last) {
          last = now;
          since = Date.now();
        } else if (Date.now() - since >= 1_000) return;
      }
    };

    for (const theme of ['modern', 'pixel'] as const) {
      const { ctx, page } = await open(true, theme);
      const tag = `phone-${theme}`;
      const label = page.locator('[data-testid="agent-overlay"]', { hasText: 'alpha' }).first();
      await label.waitFor({ timeout: 15_000 });
      const id = Number(await label.getAttribute('data-agent-id'));
      const tile = () => hooks(page, (h, a) => h.getCharacterTile(a), id);
      for (const end = Date.now() + 20_000; Date.now() < end && (await tile())?.active;) await sleep(200);
      const pad = page.getByTestId('joystick');
      const chip = page.getByTestId('selection-chip');
      const tapAt = (p: Pt) => page.touchscreen.tap(p.x, p.y);

      await still(page, id);
      // Selected through the hook first: a tap on the body is then the second tap and opens the sheet.
      await hooks(page, (h, a) => h.follow(a), id);
      await sleep(2000); // the camera zooms in on it
      await still(page, id);
      const bp = await bodyOf(page, id);
      const before = await selected(page);
      await tapAt(bp);
      await sleep(400);
      console.log(`[${tag}] body ${JSON.stringify(bp)} selected ${before} -> ${await selected(page)}`);
      check(await sheet(page).isVisible(), `[${tag}] a tap on the selected character opens its sheet`);
      await shot(page, `${tag}-3-sheet-open-by-tap`);
      await page.getByTestId('inspector-close').tap();
      await sleep(300);
      check((await sheet(page).count()) === 0, `[${tag}] closing the sheet returns to the office`);
      check((await selected(page)) === id, `[${tag}] the character is still selected after closing`);
      check(await chip.isVisible(), `[${tag}] the chip is back after closing`);
      // Empty floor clears the selection (the office's left edge, mid-height).
      const cv = (await page.locator('canvas').first().boundingBox())!;
      await tapAt({ x: cv.x + 6, y: cv.y + cv.height / 3 });
      await sleep(400);
      check((await selected(page)) === null, `[${tag}] a tap on empty floor clears the selection`);
      check(await chip.isHidden(), `[${tag}] no chip with nothing selected`);

      // The first real tap: selected, no sheet, the pad free.
      await still(page, id);
      // (nothing is selected, so no miss changes anything: tap down the body until one lands)
      for (const dy of [0, 8, 16, 24, 32, 44, 56]) {
        const b = await bodyOf(page, id);
        await tapAt({ x: b.x, y: b.y - BODY_BELOW_PLATE_PX + dy });
        await sleep(250);
        if ((await selected(page)) === id) break;
      }
      await sleep(300);
      check((await selected(page)) === id, `[${tag}] a first tap selects the character`);
      check((await sheet(page).count()) === 0, `[${tag}] a first tap opens no sheet`);
      await pad.waitFor({ timeout: 5_000 });
      const box = (await pad.boundingBox())!;
      const c: Pt = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      check(
        await pad.evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), c),
        `[${tag}] nothing covers the pad`,
      );
      const cb = (await chip.boundingBox())!;
      const modes = (await page.getByTestId('camera-modes').boundingBox())!;
      const dock = (await page.getByTestId('mobile-bottom').boundingBox())!;
      check(
        cb.y + cb.height <= box.y && (cb.x + cb.width <= modes.x || cb.y + cb.height <= modes.y),
        `[${tag}] the chip covers neither the pad nor the camera group (chip y ${Math.round(cb.y)}-${Math.round(cb.y + cb.height)}, pad y ${Math.round(box.y)})`,
      );
      check(cb.y + cb.height <= dock.y, `[${tag}] the chip is above the dock`);
      await shot(page, `${tag}-1-after-first-tap`);

      // Walking: the pad walks the selected character.
      const start = (await tile())!;
      await drag(page, c, { x: c.x + 40, y: c.y }, 1500, async () => shot(page, `${tag}-2-walking`));
      await sleep(900);
      const end = (await tile())!;
      check(
        end.col !== start.col || end.row !== start.row,
        `[${tag}] dragging the pad walked it ((${start.col},${start.row}) to (${end.col},${end.row}))`,
      );
      check((await selected(page)) === id && (await sheet(page).count()) === 0, `[${tag}] still selected, still no sheet`);

      // The chip is the clear second action.
      await chip.tap();
      await sleep(400);
      check(await sheet(page).isVisible(), `[${tag}] the chip opens the sheet`);
      await shot(page, `${tag}-4-sheet-open-by-chip`);
      await page.getByTestId('inspector-close').tap();
      await sleep(300);
      check((await selected(page)) === id && (await chip.isVisible()), `[${tag}] closed by the chip's sheet: selected, chip back`);

      await ctx.close();
    }

    // Desktop: a click still selects and opens the inspector as before.
    {
      const { ctx, page } = await open(false, 'modern');
      const label = page.locator('[data-testid="agent-overlay"]', { hasText: 'alpha' }).first();
      const id = Number(await label.getAttribute('data-agent-id'));
      await still(page, id);
      const p = await bodyOf(page, id);
      await page.mouse.click(p.x, p.y);
      await sleep(500);
      check((await selected(page)) === id, '[desktop] a click selects the character');
      check(await sheet(page).isVisible(), '[desktop] the click opens the inspector');
      check(await page.getByTestId('selection-chip').count() === 0, '[desktop] no chip');
      await shot(page, 'desktop-inspector');
      await ctx.close();
    }

    check(pageErrors.length === 0, `no page errors ${pageErrors.join(' | ')}`);
  } finally {
    await browser.close();
    if (server.exitCode === null && server.signalCode === null) {
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
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

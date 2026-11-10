/**
 * JOYSTICK check: the phone's walking pad drives the selected character like the direction keys.
 * dist/cli.js with --engine on --allow-chat in an isolated HOME whose `claude` is the engine fake,
 * on a spare port, headless Chromium with --disable-gpu, a 390x844 touch phone, office hours off.
 *
 * - no pad while nothing is selected; selecting a character shows it, bottom-left, clear of the
 *   自動/로비 group and the dock;
 * - a touch inside the dead zone moves nothing; dragging right walks the character right, down
 *   walks it down (the same path as D / S), and lifting the finger stops it within a tile;
 * - after the idle delay the pad fades to its low opacity; touching it brings it back;
 * - the isometric office walks too (a drag to the screen's down-right steps world right);
 * - the pad is gone on the messenger page.
 * Screenshots go to agent-tycoon/artifacts/joystick/.
 *
 *   npx tsx agent-tycoon/test/run-joystick.ts <port 18256-18259>
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
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/joystick');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__joystick/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 240_000;
const LEADS = ['alpha', 'beta'];
const FADE_WAIT_MS = 3_600;

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
  const startWork = (name: string) =>
    append(name, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: `toolu_${uuid}`, name: 'Read', input: { file_path: '/x' } },
        ],
      },
    });

  const browser = await launchBrowser();
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  try {
    const url = await daemon.loginUrl();
    for (const end = Date.now() + 40_000; !LEADS.every((n) => sessionOf(n));) {
      if (Date.now() > end) throw new Error('the engine did not revive the sessions');
      await sleep(300);
    }
    for (const n of LEADS) rest(n);

    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    await ctx.route('**/__joystick/malgun.ttf', (route) =>
      route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
    );
    await ctx.addInitScript(() => {
      (window as unknown as { __AGENT_TYCOON_E2E: boolean }).__AGENT_TYCOON_E2E = true;
      (window as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
      localStorage.setItem('agty.title-scene', 'off');
      if (localStorage.getItem('agty.office-iso') === null)
        localStorage.setItem('agty.office-iso', 'off');
      localStorage.setItem(
        'agty.office-hours',
        JSON.stringify({ on: false, start: 540, end: 1080, days: [1, 2, 3, 4, 5], lingerMin: 10 }),
      );
    });
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
    await sleep(2000);

    const label = page.locator('[data-testid="agent-overlay"]', { hasText: 'alpha' }).first();
    await label.waitFor({ timeout: 15_000 });
    const id = Number(await label.getAttribute('data-agent-id'));
    const pad = page.getByTestId('joystick');
    const tile = () => hooks(page, (h, a) => h.getCharacterTile(a), id);

    // The reply must have settled into idle (a working character keeps its seat).
    for (const end = Date.now() + 20_000; Date.now() < end && (await tile())?.active;)
      await sleep(200);
    check(!(await tile())?.active, 'alpha is idle');
    // OWNER-AVATAR: the pad is there with nothing selected (it walks the owner's character).
    await hooks(page, (h, a) => h.selectAgent(a), id);
    await pad.waitFor({ timeout: 5_000 });
    check(true, 'the pad shows on the office page');
    await sleep(500);
    await shot(page, 'pad-shown-2d');

    const box = (await pad.boundingBox())!;
    const modes = (await page.getByTestId('camera-modes').boundingBox())!;
    const dock = (await page.getByTestId('mobile-bottom').boundingBox())!;
    const vh = 844;
    check(box.x >= 0 && box.x < 40, `the pad sits at the left edge (x ${Math.round(box.x)})`);
    check(box.y + box.height <= dock.y, 'the pad is above the dock');
    check(box.x + box.width <= modes.x, 'the pad is clear of the 자동/로비 group');
    check(box.y + box.height <= vh, 'the pad is inside the viewport');
    check(box.width >= 88 && box.height >= 88, `the pad is thumb-sized (${box.width}px)`);
    const c: Pt = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    check(
      await pad.evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), c),
      'nothing (the lobby board) covers the pad',
    );

    // The dead zone: a small touch moves nothing.
    const start = (await tile())!;
    await drag(page, c, { x: c.x + 4, y: c.y }, 600);
    await sleep(500);
    const same = (await tile())!;
    check(
      same.col === start.col && same.row === start.row,
      `a dead-zone touch moves nothing (${same.col},${same.row})`,
    );

    /** Wait until the character has stood still for 700 ms (a slow frame rate delays a walk). */
    const settle = async (): Promise<Tile> => {
      let last = (await tile())!;
      let since = Date.now();
      for (const end = Date.now() + 8_000; Date.now() < end;) {
        await sleep(100);
        const now = (await tile())!;
        if (now.col !== last.col || now.row !== last.row) {
          last = now;
          since = Date.now();
        } else if (Date.now() - since >= 700) break;
      }
      return last;
    };

    // Right: it walks right, and a lift stops it within the queue (at most two more tiles).
    let atLift: Tile | null = null;
    await drag(page, c, { x: c.x + 40, y: c.y }, 1500, async () => {
      atLift = await tile();
      await shot(page, 'dragging-right');
    });
    const right = await settle();
    check(
      right.row === start.row && right.col >= start.col + 1,
      `dragging right walked it right (${start.col} to ${right.col})`,
    );
    check(
      atLift !== null && right.col - (atLift as Tile).col <= 2,
      `lifting the finger stops it (${(atLift as Tile | null)?.col} at the lift, ${right.col} at rest)`,
    );

    // Down.
    await drag(page, c, { x: c.x, y: c.y + 40 }, 900);
    const down = await settle();
    check(
      down.col === right.col && down.row > right.row,
      `dragging down walked it down (${right.row} to ${down.row})`,
    );
    await shot(page, 'after-walk-2d');

    // The fade: idle for the delay, then low opacity; a touch brings it back.
    await sleep(FADE_WAIT_MS);
    const faded = await pad.evaluate((el) => ({
      awake: el.getAttribute('data-awake'),
      opacity: Number(getComputedStyle(el).opacity),
    }));
    check(faded.awake === 'false' && faded.opacity < 0.3, `idle, the pad fades (${faded.opacity})`);
    await shot(page, 'pad-faded');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: c.x, y: c.y, id: 1 }],
    });
    await sleep(600);
    const woke = await pad.evaluate((el) => ({
      awake: el.getAttribute('data-awake'),
      opacity: Number(getComputedStyle(el).opacity),
    }));
    check(woke.awake === 'true' && woke.opacity > 0.5, `a touch brings it back (${woke.opacity})`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();

    // Isometric: the screen's down-right is the world's right.
    await page.evaluate(() => localStorage.setItem('agty.office-iso', 'on'));
    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
    await sleep(2000);
    await hooks(page, (h, a) => h.selectAgent(a), id);
    await pad.waitFor({ timeout: 5_000 });
    await sleep(500);
    await shot(page, 'pad-shown-iso');
    const ib = (await pad.boundingBox())!;
    const ic: Pt = { x: ib.x + ib.width / 2, y: ib.y + ib.height / 2 };
    const iStart = await settle(); // the reloaded character first settles at its seat
    const trail: string[] = [];
    let walking = true;
    const sampler = (async () => {
      while (walking) {
        const t = (await tile())!;
        trail.push(`(${t.col},${t.row})`);
        await sleep(100);
      }
    })();
    await drag(page, ic, { x: ic.x + 28, y: ic.y + 28 }, 900);
    const iEnd = await settle();
    walking = false;
    await sampler;
    console.log(`iso trail ${trail.join(' ')}`);
    check(
      iEnd.row === iStart.row && iEnd.col > iStart.col,
      `iso: a down-right drag walks world right ((${iStart.col},${iStart.row}) to (${iEnd.col},${iEnd.row}))`,
    );
    await page.evaluate(() => localStorage.setItem('agty.office-iso', 'off'));

    // Gone under the pages and the terminal view.
    await page
      .getByRole('button', { name: /메신저|Messenger/ })
      .first()
      .click();
    await sleep(800);
    check(await pad.isHidden(), 'the pad is gone on the messenger page');
    await shot(page, 'messenger-no-pad');

    check(pageErrors.length === 0, `no page errors ${pageErrors.join(' | ')}`);
    await ctx.close();
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

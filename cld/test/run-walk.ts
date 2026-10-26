/**
 * T-0048 check: walk the selected character with WASD / the arrow keys.
 * dist/cli.js with --engine on --allow-chat in an isolated HOME whose
 * `claude` is the engine fake, on a spare port, in headless Chromium with
 * --disable-gpu, office hours off (so nobody is sent home).
 *
 * - select a character, press D three times: it moves exactly three tiles and
 *   the camera follows it;
 * - held WASD starts within one rendered frame, stays smooth across tile
 *   boundaries, stops within one tile, and turns at the next boundary;
 * - a deliberately sparse repeat-only stream proves the rAF sampler sees pauses;
 * - a wall stops it (the key presses past the last free tile do nothing);
 * - typing "ddd" in the messenger moves nothing;
 * - Esc deselects, then a key pans the camera and the character stays put;
 * - when the agent starts working the keys do nothing to it, a hint shows once.
 * Screenshots go to cld/artifacts/t0048/.
 *
 *   npx tsx cld/test/run-walk.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0048');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0048/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 240_000;
const LEADS = ['alpha', 'beta', 'gamma', 'delta'];
const HINT = 'beta가 일하는 중이라 자리에 있어요';
const TILE_SIZE_PX = 16;
const KEY_WALK_SPEED_PX_PER_SEC = 96;
const KEY_WALK_DISTANCE_TOLERANCE = 0.25;
const FIRST_MOTION_SAMPLE_MS = 50;
const HELD_WALK_SAMPLE_MS = 1_000;
const RELEASE_SETTLE_SAMPLE_MS = 200;
const TURN_SAMPLE_MS = 300;
const REPEAT_STUTTER_INTERVAL_MS = 500;
const REPEAT_STUTTER_SAMPLE_MS = 1_200;
const STUTTER_EQUAL_SAMPLE_RUN = 3;
const RIGHT_RUN_TILES = 8;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, fn: () => Promise<boolean>, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`timed out: ${what}`);
}

interface Tile {
  col: number;
  row: number;
  state: string;
  queued: number;
  active: boolean;
  away: boolean;
}
interface Position {
  x: number;
  y: number;
}
type Hooks = {
  getCharacters: () => Array<{ id: number; agentName?: string; isGreeter?: boolean }>;
  getCharacterTile: (id: number) => Tile | null;
  getCharacterPosition: (id: number) => Position | null;
  getSelectedAgentId: () => number | null;
  getCameraFollowId: () => number | null;
  getTileCenter: (c: number, r: number) => { x: number; y: number } | null;
  getTiles: () => { cols: number; rows: number; tiles: number[] };
  isTileWalkable: (c: number, r: number) => boolean;
  selectAgent: (id: number) => void;
};

/** Read every animation frame, so stutter is measured from the rendered game's state. */
async function samplePosition(page: Page, id: number, durationMs: number): Promise<Position[]> {
  return page.evaluate(
    ([agentId, duration]) =>
      new Promise<Position[]>((resolve) => {
        const samples: Position[] = [];
        const started = performance.now();
        const sample = () => {
          const pos = (
            window as unknown as {
              __pixelAgentsTestHooks: { getCharacterPosition: (id: number) => Position | null };
            }
          ).__pixelAgentsTestHooks.getCharacterPosition(agentId);
          if (pos) samples.push(pos);
          if (performance.now() - started >= duration) resolve(samples);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    [id, durationMs] as const,
  );
}

function hasPause(samples: Position[], axis: keyof Position): boolean {
  let equal = 1;
  for (let i = 1; i < samples.length; i++) {
    equal = Math.abs(samples[i][axis] - samples[i - 1][axis]) < Number.EPSILON ? equal + 1 : 1;
    if (equal >= STUTTER_EQUAL_SAMPLE_RUN) return true;
  }
  return false;
}
const hooks = <T>(page: Page, fn: (h: Hooks, a: any) => T, arg?: unknown): Promise<T> =>
  page.evaluate(
    ([src, a]) =>
      (new Function('h', 'a', `return (${src})(h, a)`) as (h: unknown, a: unknown) => T)(
        (window as unknown as { __pixelAgentsTestHooks: Hooks }).__pixelAgentsTestHooks,
        a,
      ),
    [fn.toString(), arg] as const,
  );

const DIRS = [
  { key: 'd', dc: 1, dr: 0 },
  { key: 'a', dc: -1, dr: 0 },
  { key: 's', dc: 0, dr: 1 },
  { key: 'w', dc: 0, dr: -1 },
] as const;
type WalkDirection = (typeof DIRS)[number];
type WalkPoint = { col: number; row: number };

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

    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.route('**/__t0048/malgun.ttf', (route) =>
      route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
    );
    await ctx.addInitScript(() => {
      (window as unknown as { __PIXEL_AGENTS_E2E: boolean }).__PIXEL_AGENTS_E2E = true;
      (window as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
      // Office hours off: nobody goes home.
      localStorage.setItem(
        'cld.office-hours',
        JSON.stringify({
          on: false,
          start: 540,
          end: 1080,
          days: [1, 2, 3, 4, 5],
          lingerMin: 10,
        }),
      );
    });
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();

    /** The character whose overlay label names the lead. */
    const idOf = async (name: string) => {
      const label = page.locator('[data-testid="agent-overlay"]', { hasText: name }).first();
      await label.waitFor({ timeout: 15_000 });
      return Number(await label.getAttribute('data-agent-id'));
    };
    const tile = (id: number) => hooks(page, (h, i) => h.getCharacterTile(i), id);
    const position = (id: number) => hooks(page, (h, i) => h.getCharacterPosition(i), id);
    const camera = () =>
      hooks(page, (h) => ({ ...h.getTileCenter(0, 0)!, follow: h.getCameraFollowId() }));
    const selected = () => hooks(page, (h) => h.getSelectedAgentId());
    const walkable = (c: number, r: number) =>
      hooks(page, (h, a) => h.isTileWalkable(a[0], a[1]), [c, r]);
    const wallAt = (c: number, r: number) =>
      hooks(
        page,
        (h, a) => {
          const t = h.getTiles();
          const [col, row] = a as number[];
          return t.tiles[row * t.cols + col] === 0;
        },
        [c, r],
      );
    /** Click a character's overlay until the office selects and follows it. */
    const clickSelect = async (id: number) => {
      for (let i = 0; i < 8; i++) {
        if ((await selected()) === id && (await camera()).follow === id) return;
        const t = await tile(id);
        const c = await hooks(page, (h, a) => h.getTileCenter(a[0], a[1]), [t!.col, t!.row]);
        const canvas = (await page.getByTestId('office-canvas').boundingBox())!;
        await page.mouse.click(canvas.x + c!.x, canvas.y + c!.y - 6);
        await sleep(400);
      }
      throw new Error('a click on the character did not select and follow it');
    };
    /** Wait for it to stand still, then return its tile. */
    const settled = async (id: number) => {
      let t: Tile | null = null;
      await until('the character stands still', async () => {
        t = await tile(id);
        return t!.queued === 0 && t!.state !== 'walk';
      });
      return t! as Tile;
    };
    /** Move with separate taps to a floor tile that has room for a D-held walk. */
    const prepareRightRun = async (id: number, requireDown: boolean) => {
      const map = await hooks(page, (h) => h.getTiles());
      const open = await Promise.all(
        Array.from({ length: map.rows }, (_, row) =>
          Promise.all(Array.from({ length: map.cols }, (_, col) => walkable(col, row))),
        ),
      );
      const here = await settled(id);
      open[here.row][here.col] = true; // an assigned seat is walkable only to its owner
      const needDown = requireDown ? 3 : 0;
      let target: Tile | null = null;
      for (let row = 0; row < map.rows && !target; row++) {
        for (let col = 0; col + RIGHT_RUN_TILES < map.cols && !target; col++) {
          if (
            Array.from({ length: RIGHT_RUN_TILES + 1 }, (_, n) => open[row][col + n]).every(
              Boolean,
            ) &&
            Array.from({ length: needDown + 1 }, (_, n) => open[row + n]?.[col]).every(Boolean)
          )
            target = { col, row, state: '', queued: 0, active: false, away: false };
        }
      }
      if (!target) throw new Error('no rightward runway for held-key check');

      const key = (col: number, row: number) => `${col},${row}`;
      const origin = { col: here.col, row: here.row };
      const queue = [origin];
      const previous = new Map<string, { previous: WalkPoint; dir: WalkDirection }>();
      const seen = new Set([key(origin.col, origin.row)]);
      for (let index = 0; index < queue.length; index++) {
        const at = queue[index];
        if (at.col === target.col && at.row === target.row) break;
        for (const dir of DIRS) {
          const next = { col: at.col + dir.dc, row: at.row + dir.dr };
          if (!open[next.row]?.[next.col] || seen.has(key(next.col, next.row))) continue;
          seen.add(key(next.col, next.row));
          previous.set(key(next.col, next.row), { previous: at, dir });
          queue.push(next);
        }
      }
      const steps: Array<(typeof DIRS)[number]> = [];
      for (let at = target; at.col !== origin.col || at.row !== origin.row;) {
        const step = previous.get(key(at.col, at.row));
        if (!step) throw new Error('rightward runway is not reachable');
        steps.unshift(step.dir);
        at = step.previous;
      }
      for (const step of steps) {
        await page.keyboard.press(step.key);
        await settled(id);
      }
    };

    const lead = 'alpha';
    const id = await idOf(lead);
    await sleep(2_000); // spawn effects, to their seats
    await until(
      `${lead} is idle`,
      async () => {
        return !(await tile(id))!.active;
      },
      20_000,
    );
    await clickSelect(id);
    check(
      (await selected()) === id && (await camera()).follow === id,
      `a click on ${lead} (agent ${id}) selects it and the camera follows`,
    );

    // ── D three times: exactly three tiles ──
    let start = await settled(id);
    check(
      !start.active && !start.away,
      `${lead} is idle and on the floor at (${start.col},${start.row})`,
    );
    // Which way has three free tiles? A wandering character may take a moment.
    let moved = false;
    for (let attempt = 0; attempt < 6 && !moved; attempt++) {
      start = await settled(id);
      const free = async (d: (typeof DIRS)[number]) => {
        for (let k = 1; k <= 3; k++)
          if (!(await walkable(start.col + d.dc * k, start.row + d.dr * k))) return false;
        return true;
      };
      let dir: (typeof DIRS)[number] | undefined;
      for (const d of DIRS) if (!dir && (await free(d))) dir = d;
      if (!dir) throw new Error('no direction with three free tiles');
      // Press the key without waiting between presses (a player taps it).
      for (let i = 0; i < 3; i++) await page.keyboard.press(dir.key);
      const mid = await tile(id);
      const end = await settled(id);
      if (mid && end.col === start.col + dir.dc * 3 && end.row === start.row + dir.dr * 3) {
        moved = true;
        check(
          true,
          `pressing ${dir.key.toUpperCase()} three times walked ${lead} three tiles: (${start.col},${start.row}) to (${end.col},${end.row})`,
        );
      }
    }
    check(moved, `three presses of one key move the character exactly three tiles`);
    check((await camera()).follow === id, 'the camera still follows the walking character');
    await shot(page, 'desktop-walked');

    // ── Held D: immediate, smooth, fast, and bounded on release ──
    await prepareRightRun(id, true);
    const beforeDown = (await position(id))!;
    await page.keyboard.down('d');
    const firstFrames = await samplePosition(page, id, FIRST_MOTION_SAMPLE_MS);
    check(
      firstFrames.some((sample) => sample.x > beforeDown.x),
      `D changes x within ${FIRST_MOTION_SAMPLE_MS} ms`,
    );
    const heldStart = firstFrames.at(-1)!;
    const heldFrames = await samplePosition(page, id, HELD_WALK_SAMPLE_MS);
    const afterFirstTile = heldFrames.filter((sample) => sample.x >= heldStart.x + TILE_SIZE_PX);
    const heldEnd = heldFrames.at(-1)!;
    const heldDistance = heldEnd.x - heldStart.x;
    const minHeldDistance = KEY_WALK_SPEED_PX_PER_SEC * (1 - KEY_WALK_DISTANCE_TOLERANCE);
    const maxHeldDistance = KEY_WALK_SPEED_PX_PER_SEC * (1 + KEY_WALK_DISTANCE_TOLERANCE);
    check(
      afterFirstTile.length > 0 && !hasPause(afterFirstTile, 'x'),
      'held D has no run of three equal rAF x samples after the first tile',
    );
    check(
      heldDistance >= minHeldDistance && heldDistance <= maxHeldDistance,
      `held D covers ${heldDistance.toFixed(1)} px in 1 s (96 px/s ± 25%)`,
    );
    const beforeUp = (await position(id))!;
    await page.keyboard.up('d');
    const releaseFrames = await samplePosition(page, id, RELEASE_SETTLE_SAMPLE_MS);
    const releaseEnd = releaseFrames.at(-1)!;
    check(
      releaseEnd.x - beforeUp.x <= TILE_SIZE_PX,
      `releasing D travels no more than one tile (${(releaseEnd.x - beforeUp.x).toFixed(1)} px)`,
    );
    check(
      hasPause(releaseFrames.slice(-STUTTER_EQUAL_SAMPLE_RUN), 'x'),
      `releasing D stops within ${RELEASE_SETTLE_SAMPLE_MS} ms`,
    );
    await shot(page, 'desktop-held-walk');

    // ── Latest held key wins; releasing it resumes the older direction ──
    await settled(id);
    await prepareRightRun(id, true);
    const turnStart = (await position(id))!;
    await page.keyboard.down('d');
    await samplePosition(page, id, FIRST_MOTION_SAMPLE_MS);
    await page.keyboard.down('s');
    const turnFrames = await samplePosition(page, id, TURN_SAMPLE_MS);
    check(turnFrames.at(-1)!.y > turnStart.y, 'holding D then S turns down at the next tile');
    const fallbackStart = (await position(id))!;
    await page.keyboard.up('s');
    const fallbackFrames = await samplePosition(page, id, TURN_SAMPLE_MS);
    check(fallbackFrames.at(-1)!.x > fallbackStart.x, 'releasing S resumes rightward walking');
    await page.keyboard.up('d');
    await settled(id);

    // ── The sampler catches the old sparse-repeat stutter pattern ──
    await prepareRightRun(id, false);
    const badStart = (await position(id))!;
    // A tap every interval walks one tile and then stands: the pattern a walk
    // driven by OS key repeats had. The new held-key walk never makes it.
    const tap = () =>
      page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', bubbles: true }),
        );
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'd', code: 'KeyD', bubbles: true }));
      });
    await tap();
    const badFramesPromise = samplePosition(page, id, REPEAT_STUTTER_SAMPLE_MS);
    for (
      let repeat = REPEAT_STUTTER_INTERVAL_MS;
      repeat < REPEAT_STUTTER_SAMPLE_MS;
      repeat += REPEAT_STUTTER_INTERVAL_MS
    ) {
      await sleep(REPEAT_STUTTER_INTERVAL_MS);
      await tap();
    }
    const badFrames = await badFramesPromise;
    check(badFrames.at(-1)!.x > badStart.x, 'the sparse-repeat control starts with one tile');
    check(hasPause(badFrames, 'x'), 'the rAF sampler detects the sparse repeat stutter pause');

    // ── a wall blocks it ──
    start = await settled(id);
    let blocked: { dir: (typeof DIRS)[number]; free: number; wall: boolean } | undefined;
    for (const d of DIRS) {
      let k = 0;
      while (k < 7 && (await walkable(start.col + d.dc * (k + 1), start.row + d.dr * (k + 1)))) k++;
      if (k >= 7) continue;
      const wall = await wallAt(start.col + d.dc * (k + 1), start.row + d.dr * (k + 1));
      if (!blocked || (wall && !blocked.wall)) blocked = { dir: d, free: k, wall };
    }
    if (!blocked) throw new Error('no blocked direction found');
    const bt = {
      col: start.col + blocked.dir.dc * (blocked.free + 1),
      row: start.row + blocked.dir.dr * (blocked.free + 1),
    };
    for (let i = 0; i < blocked.free + 3; i++) await page.keyboard.press(blocked.dir.key);
    const stop = await settled(id);
    const want = {
      col: start.col + blocked.dir.dc * blocked.free,
      row: start.row + blocked.dir.dr * blocked.free,
    };
    check(
      stop.col === want.col && stop.row === want.row,
      `${blocked.free + 3} presses of ${blocked.dir.key.toUpperCase()} stop at the last free tile (${stop.col},${stop.row}) before the ${blocked.wall ? 'wall' : 'obstacle'} at (${bt.col},${bt.row})`,
    );
    await page.keyboard.press(blocked.dir.key);
    await sleep(600);
    const still = await tile(id);
    check(
      still!.col === stop.col && still!.row === stop.row,
      'one more press against it moves nothing',
    );
    await shot(page, 'desktop-wall');

    // ── typing in the messenger moves nothing ──
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    await page.getByRole('button', { name: /^메신저/ }).click();
    await messenger
      .getByRole('list', { name: '연락처' })
      .getByRole('button', { name: /^alpha/ })
      .click();
    const box = messenger
      .getByRole('region', { name: 'alpha 대화' })
      .getByRole('textbox', { name: '보낼 글' });
    await box.click();
    await hooks(page, (h, i) => h.selectAgent(i), id); // selected while typing
    const before = await settled(id);
    check((await selected()) === id, 'the character is selected while the messenger box has focus');
    await page.keyboard.type('wdsa dddd');
    await sleep(800);
    const after = await tile(id);
    check((await box.inputValue()) === 'wdsa dddd', 'the letters went into the messenger box');
    check(
      after!.col === before.col && after!.row === before.row && after!.queued === 0,
      `typing wasd in the messenger moves nothing (still (${after!.col},${after!.row}))`,
    );
    await shot(page, 'desktop-typing');
    await box.fill('');
    await page.getByRole('button', { name: '메신저 닫기' }).click();

    // ── Esc hands the keys back to the camera ──
    await page
      .locator('body')
      .click({ position: { x: 2, y: 2 } })
      .catch(() => undefined);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await clickSelect(id);
    const pre = await settled(id);
    await page.keyboard.press('Escape');
    await sleep(300);
    check(
      (await selected()) === null && (await camera()).follow === null,
      'Esc deselects the character and stops the follow',
    );
    const c0 = await camera();
    await page.keyboard.down('d');
    await sleep(500);
    await page.keyboard.up('d');
    await sleep(600);
    const c1 = await camera();
    const post = await tile(id);
    check(
      c1.x - c0.x < -50 && post!.col === pre.col && post!.row === pre.row,
      `after Esc, D pans the camera (${(c1.x - c0.x).toFixed(0)} px) and the character stays at (${post!.col},${post!.row})`,
    );
    await shot(page, 'desktop-esc-pan');

    // ── a working agent keeps its seat; one hint ──
    const work = 'beta';
    const wid = await idOf(work);
    startWork(work);
    await until(`${work} is working`, async () => (await tile(wid))!.active, 15_000);
    // A precondition, not a check: the keys below are judged by where beta ends up.
    await until(`${work} stands still`, async () => (await tile(wid))!.queued === 0, 40_000).catch(
      () => undefined,
    );
    await clickSelect(wid);
    const atWork = await tile(wid);
    await page.keyboard.press('d');
    await page.keyboard.press('d');
    await sleep(600);
    const afterWork = await tile(wid);
    check(
      afterWork!.col === atWork!.col && afterWork!.row === atWork!.row && afterWork!.queued === 0,
      `a working ${work} ignores the keys (still (${afterWork!.col},${afterWork!.row}))`,
    );
    check(
      (await page.getByText(HINT).count()) === 1,
      'the grammatical hint "beta가 일하는 중이라 자리에 있어요" shows once, not once per key',
    );
    await shot(page, 'desktop-working-hint');
    check(
      pageErrors.length === 0,
      `no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`,
    );
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
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

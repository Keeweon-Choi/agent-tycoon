/**
 * C1 drink art (owner 11-01): the isometric coffee machine and vending machine play their frames,
 * a character with a 6-row iso8 sheet drinks in its own poses, and the coffee steams. dist/cli.js
 * on an isolated HOME (the fake claude R-8), headless Chromium without a GPU, the office opened
 * isometric with ?fx=1 (window.__agtyFx plays the coffee break; `drink` 'energy' sends it to the
 * vending machine).
 *
 * The test sheet is built here, in the temp HOME only: the owner's boss-iso.png (5 rows) plus the
 * v2 drink cells as its 6th row, with the steam origin from the art's anchors.json (drink-coffee-1,
 * the one cell that shows the cup's surface). Nothing of it is written to the repo.
 *
 * Desktop 1280x800 and phone 390x844: a coffee break and an energy-drink break, each an mp4,
 * stills of the machine playing and of the drink; a short mp4 and a GIF of the desktop coffee break.
 * Output: cld/artifacts/c1-drink/.
 *
 *   npx tsx cld/test/run-c1-drink.ts <port 18262|18263>
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';

import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  warmUpOffice,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
if (port !== 18262 && port !== 18263) throw new Error('C1 drink records on 18262 or 18263');
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/c1-drink');
const RAW = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-drink-video-'));
const PRIVATE = '/tmp/example-home/projects/cld-gui/packs-private';
const SHEET = process.env.SHEET ?? `${PRIVATE}/char-iso-1/steps-v2/boss-iso.png`;
const CELLS =
  process.env.CELLS ??
  '/tmp/example-home/projects/cld-gui/.worktrees/integ/.worktrees/codex-1101-095708/packs-private/c1-drink-v2';
const [CW, CH] = [288, 528];
/** Where the cup's surface is in drink-coffee-1 (cell px): the v2 art's anchors.json. */
const CUP_STEAM = { col: 1, x: 132, y: 170 };
const PRESET = 'boss-drink';
const AGENT = 9_001;
const DESKTOP: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  recordVideo: { dir: RAW, size: { width: 1280, height: 800 } },
};
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  recordVideo: { dir: RAW, size: { width: 780, height: 1688 } },
};
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;
const HIDE_BAR =
  '[data-testid="fx-dev-bar"], [data-testid="update-notice"] { display: none !important; }';
/** Seconds into the machine's use when its last frame (the full cup, the can in the tray) shows
 *  (constants.ts LOUNGE_USE_SEC: coffee 1 + 2.4, vending 0.8 + 0.7, plus a little). */
const FULL_AT = { coffee: 3.9, energy: 2 };
/** Seconds into the coffee machine's use while it pours (LOUNGE_USE_SEC.coffee: 1 to 3.4). */
const POUR_AT = 2;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
const hook = <T>(page: Page, call: string): Promise<T> =>
  page.evaluate(`window.__agentTycoonTestHooks.${call}`) as Promise<T>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ff = (args: string[]) =>
  execFileSync('nice', ['-n', '10', 'ffmpeg', '-y', '-loglevel', 'error', ...args]);

/** boss-iso (8 columns, 5 rows) plus a 6th row: coffee 1-3, can 1-3, two empty cells. */
function buildSheet(dir: string): void {
  const src = PNG.sync.read(fs.readFileSync(SHEET));
  check(
    src.width === CW * 8 && src.height === CH * 5,
    `test sheet source ${src.width}x${src.height}`,
  );
  const out = new PNG({ width: src.width, height: CH * 6 });
  src.data.copy(out.data, 0, 0, src.data.length);
  const cells = ['coffee-1', 'coffee-2', 'coffee-3', 'can-1', 'can-2', 'can-3'];
  cells.forEach((name, col) => {
    const c = PNG.sync.read(fs.readFileSync(path.join(CELLS, `drink-${name}.png`)));
    PNG.bitblt(c, out, 0, 0, CW, CH, col * CW, CH * 5);
  });
  const png = PNG.sync.write(out, { colorType: 6, deflateLevel: 9 });
  fs.writeFileSync(path.join(dir, `${PRESET}.png`), png);
  fs.writeFileSync(
    path.join(dir, `${PRESET}.json`),
    JSON.stringify({
      label: 'Boss drink',
      columns: 'standFirst',
      walk: 'steps',
      drinkSteam: [CUP_STEAM],
    }),
  );
  check(
    png.length <= 6 * 1024 * 1024,
    `6-row test sheet ${(png.length / 1024 / 1024).toFixed(2)} MB (cap 6 MB)`,
  );
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const chars = path.join(configDirectory(fake.home), 'characters');
  fs.mkdirSync(chars, { recursive: true });
  buildSheet(chars);
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  try {
    const open = async (opts: BrowserContextOptions) => {
      const ctx = await browser.newContext(opts);
      await warmUpOffice(ctx, daemon, 1500);
      const login = await ctx.newPage();
      await login.goto(await daemon.loginUrl());
      await login.waitForURL(BASE);
      await login.close();
      await ctx.addInitScript(INIT);
      await ctx.addInitScript(`try { localStorage.setItem('cld.office-iso', 'on') } catch {}`);
      const page = await ctx.newPage();
      const t0 = Date.now();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      await page.goto(`${BASE}?fx=1`);
      await page.waitForFunction(
        () =>
          (
            window as unknown as { __agentTycoonTestHooks?: { getCharacters(): unknown[] } }
          ).__agentTycoonTestHooks?.getCharacters().length,
        undefined,
        { timeout: 30_000 },
      );
      await page.addStyleTag({ content: HIDE_BAR });
      await page.waitForTimeout(3000);
      return { page, t0 };
    };

    /** The test character next to the pantry: spawned wearing the preset, walked there. */
    const atPantry = async (page: Page): Promise<number> => {
      let palette = -1;
      for (let i = 0; i < 60 && palette < 0; i++) {
        palette = await hook<number>(page, `spawnPreset('${PRESET}', 1, ${AGENT})`);
        if (palette < 0) await sleep(500);
      }
      check(palette >= 0, `preset ${PRESET} loaded (palette ${palette})`);
      await hook(page, `setActive(${AGENT}, false)`);
      const furniture = await hook<Array<{ type: string; col: number; row: number }>>(
        page,
        'getFurniture()',
      );
      const coffee = furniture.find((f) => f.type === 'COFFEE_MACHINE');
      const vending = furniture.find((f) => f.type === 'VENDING_MACHINE');
      check(coffee && vending, `a coffee machine and a vending machine on the layout`);
      // a free tile two rows below the coffee machine's stand tile
      let goal: { col: number; row: number } | null = null;
      for (const [dc, dr] of [
        [0, 3],
        [1, 3],
        [-1, 3],
        [0, 4],
        [1, 4],
        [2, 3],
      ])
        if (await hook<boolean>(page, `isTileWalkable(${coffee!.col + dc}, ${coffee!.row + dr})`)) {
          goal = { col: coffee!.col + dc, row: coffee!.row + dr };
          break;
        }
      check(goal, `a free tile by the pantry (${JSON.stringify(goal)})`);
      check(
        await hook<boolean>(page, `walkTo(${AGENT}, ${goal!.col}, ${goal!.row})`),
        'walks to the pantry',
      );
      const end = Date.now() + 90_000;
      for (;;) {
        const t = await hook<{ col: number; row: number; state: string } | null>(
          page,
          `getCharacterTile(${AGENT})`,
        );
        if (t && t.col === goal!.col && t.row === goal!.row && t.state !== 'walk') break;
        if (Date.now() > end) throw new Error(`did not reach the pantry: ${JSON.stringify(t)}`);
        await sleep(250);
      }
      return AGENT;
    };

    /** Close the page, keep its video as <name>.mp4 trimmed to [from, from + dur]. */
    const finish = async (page: Page, name: string, from: number, dur: number) => {
      const video = page.video()!;
      await page.context().close();
      const out = path.join(OUT, `${name}.mp4`);
      ff([
        '-ss',
        from.toFixed(2),
        '-i',
        await video.path(),
        '-t',
        dur.toFixed(2),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-an',
        out,
      ]);
      return out;
    };

    for (const [view, opts] of [
      ['desktop', DESKTOP],
      ['phone', PHONE],
    ] as const) {
      const { page, t0 } = await open(opts);
      const id = await atPantry(page);
      if (view === 'desktop') await hook(page, 'setZoom(6)');
      await hook(page, `follow(${id})`);
      await hook(page, 'selectAgent(null)');
      await page.mouse.move(2, 2);
      await page.waitForTimeout(1500);
      const from = (Date.now() - t0) / 1000;
      for (const drink of ['coffee', 'energy'] as const) {
        await page.evaluate(`window.__agtyFx.play('coffee', ${id}, undefined, '${drink}')`);
        const phases: string[] = [];
        const kinds = new Set<string>();
        let used = false;
        let usedAt = '';
        let drank = false;
        const end = Date.now() + 60_000;
        for (;;) {
          if (Date.now() > end)
            throw new Error(`the ${drink} break did not end: ${phases.join('>')}`);
          const t = await hook<{
            rest: string | null;
            restKind: string | null;
            col: number;
            row: number;
          }>(page, `getCharacterTile(${id})`);
          const phase = t.rest ?? 'none';
          if (t.restKind) kinds.add(t.restKind);
          if (phases.at(-1) !== phase) phases.push(phase);
          if (phase === 'use' && !used) {
            used = true;
            usedAt = `${t.col},${t.row}`;
            if (drink === 'coffee') {
              // the pour (the machine's state 1, from 1 s in)
              await sleep(POUR_AT * 1000);
              await page.screenshot({ path: path.join(OUT, `${view}-coffee-pour.png`) });
            }
            await sleep((FULL_AT[drink] - (drink === 'coffee' ? POUR_AT : 0)) * 1000);
            await page.screenshot({ path: path.join(OUT, `${view}-${drink}-machine.png`) });
          }
          if (phase === 'drink' && !drank) {
            drank = true;
            await sleep(150);
            await page.screenshot({ path: path.join(OUT, `${view}-${drink}-lifted.png`) });
            await sleep(1300);
            await page.screenshot({ path: path.join(OUT, `${view}-${drink}-sip.png`) });
          }
          if (phase === 'none' && phases.includes('go')) break;
          await sleep(100);
        }
        const want = drink === 'coffee' ? 'coffee' : 'vending';
        check(
          phases
            .join('>')
            .replace(/^none>/, '')
            .startsWith('fetch>use>drink>go') && kinds.has(want),
          `${view}: ${drink} break ${phases.join(' > ')} at the ${[...kinds].join(',')} machine, used from ${usedAt}`,
        );
        await sleep(1000);
      }
      const stop = (Date.now() - t0) / 1000;
      await finish(page, `${view}-breaks`, from - 0.5, stop - from + 0.5);
    }

    // the desktop coffee break at the machine (its first 14 s) as a GIF around the character
    const gif = path.join(OUT, 'desktop-coffee.gif');
    ff([
      '-t',
      '14',
      '-i',
      path.join(OUT, 'desktop-breaks.mp4'),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      path.join(OUT, 'desktop-coffee.mp4'),
    ]);
    ff([
      '-t',
      '14',
      '-i',
      path.join(OUT, 'desktop-breaks.mp4'),
      '-vf',
      'fps=8,crop=400:420:440:180,scale=280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none',
      '-loop',
      '0',
      gif,
    ]);
    const mb = fs.statSync(gif).size / 1024 / 1024;
    check(mb <= 8, `${path.basename(gif)}: ${mb.toFixed(2)} MB`);
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
  } finally {
    await browser.close();
    if (daemon.child.exitCode === null) {
      const exited = new Promise((r) => daemon.child.once('exit', r));
      daemon.child.kill('SIGTERM');
      await Promise.race([exited, sleep(5_000)]);
      if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
    }
    fs.rmSync(RAW, { recursive: true, force: true });
  }
  console.log('all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

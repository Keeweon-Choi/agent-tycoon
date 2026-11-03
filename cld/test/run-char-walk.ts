/**
 * CHAR-ISO-1 / WALK-FIX: a video of one character preset walking in the isometric office in its
 * eight screen directions (a held arrow key each, two for a diagonal), then tapped a tile at a
 * time (the owner's way with the joystick), at a chosen zoom, followed by the camera; a strip of
 * stills per walk and, beside each still, the sheet cell the office drew (row, column, mirrored)
 * read from the character's facing and walk frame. For reviewing character art in motion; the
 * art itself is not in the repo (expansion packs live in the git-ignored packs-private/), so the
 * preset folder is an argument.
 * dist/cli.js (or CLI_JS) with --engine on in an isolated HOME whose `claude` is the engine fake,
 * on a spare port, headless Chromium with --disable-gpu; the preset's <id>.png / <id>.json are
 * copied into that HOME's characters folder and given to the lead 'alpha'.
 *
 *   npx tsx cld/test/run-char-walk.ts <port 18256-18269> <preset dir> <preset id> <out dir> [zoom] [phone]
 * Writes <out dir>/office-walk.webm, strip-<walk>.png per walk, walk-log.json, and prints the
 * cells drawn per walk.
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
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
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const [presetDir, presetId, outDir] = process.argv
  .slice(3, 6)
  .map((a, i) => (i === 1 ? a : path.resolve(a)));
const ZOOM = Number(process.argv[6] ?? 6);
const PHONE = process.argv[7] === 'phone';
const CLI = process.env.CLI_JS ?? path.join(REPO_ROOT, 'dist/cli.js');
const DEADLINE_MS = 240_000;
const VIEW = PHONE ? { width: 390, height: 844 } : { width: 960, height: 720 };
const CONTEXT: BrowserContextOptions = PHONE
  ? { viewport: VIEW, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
  : { viewport: VIEW, deviceScaleFactor: 1 };
const HOLD_MS = 900;
const PAUSE_MS = 700;
const TAPS = 4;
const TAP_GAP_MS = 420;
/** The still around the followed character (CSS px): an iso character is ~24×44 iso px. */
const CLIP = { w: Math.round(40 * ZOOM), h: Math.round(56 * ZOOM) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The eight screen directions as held keys (the iso camera: a key is a screen direction). */
const WALKS: Array<{ name: string; keys: string[]; taps?: number }> = [
  { name: 'right', keys: ['ArrowRight'] },
  { name: 'down-right', keys: ['ArrowRight', 'ArrowDown'] },
  { name: 'down', keys: ['ArrowDown'] },
  { name: 'down-left', keys: ['ArrowDown', 'ArrowLeft'] },
  { name: 'left', keys: ['ArrowLeft'] },
  { name: 'up-left', keys: ['ArrowLeft', 'ArrowUp'] },
  { name: 'up', keys: ['ArrowUp'] },
  { name: 'up-right', keys: ['ArrowUp', 'ArrowRight'] },
  { name: 'tap-right', keys: ['ArrowRight'], taps: TAPS },
  { name: 'tap-down-right', keys: ['ArrowRight', 'ArrowDown'], taps: TAPS },
  { name: 'tap-left', keys: ['ArrowLeft'], taps: TAPS },
  { name: 'tap-up-left', keys: ['ArrowLeft', 'ArrowUp'], taps: TAPS },
];

type Pose = {
  col: number;
  row: number;
  state: string;
  dir: number;
  frame: number;
  diagRow: number | null;
};
type Hooks = {
  getCharacterTile: (id: number) => (Pose & { active: boolean }) | null;
  selectAgent: (id: number) => void;
  setZoom: (z: number) => void;
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

/** The iso8 sheet cell the isometric office draws for a pose (cld/iso/sprites.ts characterView
 *  and importedSheet.ts: walk columns 2, 8, 3, 8; rows 1-5 three-quarter front, three-quarter
 *  back, front, back, right side; 'm' mirrored), or '-' when it stands. */
function cellOf(p: Pose): string {
  if (p.state !== 'walk') return '-';
  const [DOWN, LEFT, RIGHT] = [0, 1, 2];
  const across = p.dir === RIGHT ? 1 : p.dir === LEFT ? -1 : 0;
  const dr = across ? (p.diagRow ?? 0) : p.dir === DOWN ? 1 : -1;
  const [sx, sy] = [Math.sign(across - dr), Math.sign(across + dr)];
  const col = [2, 8, 3, 8][p.frame % 4];
  if (sx && sy) return `r${sy > 0 ? 1 : 2}c${col}${sx < 0 ? 'm' : ''}`;
  if (sy) return `r${sy > 0 ? 3 : 4}c${col}`;
  return `r5c${col}${sx < 0 ? 'm' : ''}`;
}

/** Run-length text of the cells drawn: "r5c2 ×3, r5c8 ×2, ...". */
const runs = (cells: string[]): string =>
  cells
    .reduce<Array<[string, number]>>((acc, c) => {
      const last = acc[acc.length - 1];
      if (last && last[0] === c) last[1]++;
      else acc.push([c, 1]);
      return acc;
    }, [])
    .map(([c, n]) => (n > 1 ? `${c} ×${n}` : c))
    .join(', ');

/** The stills of one walk side by side (a 2 px gap), at the device scale they were shot. */
function strip(shots: Buffer[], file: string): void {
  const pngs = shots.map((b) => PNG.sync.read(b));
  if (!pngs.length) return;
  const [w, h] = [pngs[0].width, pngs[0].height];
  const out = new PNG({ width: pngs.length * (w + 2), height: h });
  out.data.fill(0);
  pngs.forEach((p, i) =>
    PNG.bitblt(p, out, 0, 0, Math.min(w, p.width), Math.min(h, p.height), i * (w + 2), 0),
  );
  fs.writeFileSync(file, PNG.sync.write(out));
}

async function main() {
  if (!presetDir || !presetId || !outDir)
    throw new Error('usage: <port> <preset dir> <id> <out dir> [zoom] [phone]');
  await assertPortFree(port);
  fs.mkdirSync(outDir, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.join(cfg, 'characters'), { recursive: true });
  for (const ext of ['.png', '.json'])
    fs.copyFileSync(
      path.join(presetDir, presetId + ext),
      path.join(cfg, 'characters', presetId + ext),
    );
  fs.writeFileSync(
    path.join(cfg, 'characters.json'),
    JSON.stringify({ alpha: { preset: presetId } }),
  );
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
    false,
    CLI,
  );
  const { child: server } = daemon;
  const deadline = setTimeout(() => {
    console.error(`aborted: deadline ${DEADLINE_MS / 1000} s`);
    server.kill('SIGKILL');
    killFakeSessions(home);
    process.exit(1);
  }, DEADLINE_MS);

  const browser = await launchBrowser();
  try {
    const url = await daemon.loginUrl();
    // The lead's transcript ends in a plain reply: it is idle (and free to walk).
    let session: { sessionId: string; cwd: string } | null = null;
    for (const end = Date.now() + 40_000; !session; await sleep(300)) {
      if (Date.now() > end) throw new Error('the engine did not revive the session');
      for (const f of fs.readdirSync(sessions))
        try {
          const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8'));
          if (s.name === 'alpha') session = s;
        } catch {
          /* being written */
        }
    }
    const file = transcriptPath(session.cwd, session.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = (uuid: string, rec: object) =>
      `${JSON.stringify({ uuid, timestamp: new Date().toISOString(), ...rec })}\n`;
    fs.appendFileSync(
      file,
      line('00000001-0000-4000-8000-000000000000', {
        type: 'user',
        message: { role: 'user', content: 'hi' },
      }) +
        line('00000002-0000-4000-8000-000000000000', {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        }),
    );

    const ctx = await browser.newContext({
      ...CONTEXT,
      recordVideo: { dir: outDir, size: VIEW },
    });
    await ctx.addInitScript(() => {
      (window as unknown as { __AGENT_TYCOON_E2E: boolean }).__AGENT_TYCOON_E2E = true;
      (window as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
      localStorage.setItem('cld.title-scene', 'off');
      localStorage.setItem('cld.office-iso', 'on');
      localStorage.setItem(
        'cld.office-hours',
        JSON.stringify({ on: false, start: 540, end: 1080, days: [1, 2, 3, 4, 5], lingerMin: 10 }),
      );
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    const label = page.locator('[data-testid="agent-overlay"]', { hasText: 'alpha' }).first();
    await label.waitFor({ timeout: 30_000 });
    const id = Number(await label.getAttribute('data-agent-id'));
    // the lobby board stands in front of the room and would hide the walker: off for the video
    await page.addStyleTag({
      content: '[data-testid="lobby-board"] { display: none !important; }',
    });
    const tile = () => hooks(page, (h, a) => h.getCharacterTile(a), id);
    for (const end = Date.now() + 20_000; Date.now() < end && (await tile())?.active;)
      await sleep(200);
    await hooks(page, (h, a) => h.selectAgent(a), id);
    await hooks(page, (h, a) => h.setZoom(a), ZOOM);
    await hooks(page, (h, a) => h.follow(a), id);
    await sleep(2_500); // the sheet loads and the camera settles
    const video = page.video();
    const clip = {
      x: Math.round(VIEW.width / 2 - CLIP.w / 2),
      y: Math.round(VIEW.height / 2 - CLIP.h * 0.62),
      width: CLIP.w,
      height: CLIP.h,
    };
    const log: Array<{ walk: string; from: string; to: string; cells: string[] }> = [];
    // stills and the pose at each, as fast as the page gives them, until `until`
    const sample = async (until: number, shots: Buffer[], cells: string[]) => {
      while (Date.now() < until) {
        const [png, pose] = await Promise.all([page.screenshot({ clip }), tile()]);
        if (pose && pose.state === 'walk') {
          shots.push(png);
          cells.push(cellOf(pose));
        }
      }
    };
    for (const walk of WALKS) {
      const from = await tile();
      const shots: Buffer[] = [];
      const cells: string[] = [];
      if (walk.taps) {
        for (let i = 0; i < walk.taps; i++) {
          for (const k of walk.keys) await page.keyboard.down(k);
          await sleep(40);
          for (const k of walk.keys) await page.keyboard.up(k);
          await sample(Date.now() + TAP_GAP_MS, shots, cells);
        }
      } else {
        for (const k of walk.keys) await page.keyboard.down(k);
        await sample(Date.now() + HOLD_MS, shots, cells);
        for (const k of walk.keys) await page.keyboard.up(k);
      }
      await sleep(PAUSE_MS);
      const to = await tile();
      strip(shots, path.join(outDir, `strip-${walk.name}.png`));
      log.push({
        walk: walk.name,
        from: `(${from?.col},${from?.row})`,
        to: `(${to?.col},${to?.row})`,
        cells,
      });
      console.log(
        `${walk.name}: (${from?.col},${from?.row}) -> (${to?.col},${to?.row}): ${runs(cells)}`,
      );
    }
    fs.writeFileSync(path.join(outDir, 'walk-log.json'), JSON.stringify(log, null, 1));
    await ctx.close();
    if (video) fs.renameSync(await video.path(), path.join(outDir, 'office-walk.webm'));
    console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');
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

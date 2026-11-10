/**
 * DIAG-1104: a built-in person (palette 3) and a mascot (Tori) walking on the diagonals, in the
 * isometric view and then the top-down view, each a held pair of arrow keys (one key for a
 * straight walk) with the camera following. Per walk it samples stills and what the office draws
 * (getCharacterTile().views: its own sheet or the three-quarter one beside it, 'diag'), and fails
 * when a pose (walking, and standing after) draws other than its last step asks (the
 * three-quarter walk on a world step in the isometric view and on a diagonal one in the top view,
 * else its own views), or a diagonal walk never drew the three-quarter walk.
 * dist/cli.js with --engine on in an isolated HOME whose `claude` is the engine fake, headless
 * Chromium with --disable-gpu (launchBrowser).
 *
 *   npx tsx agent-tycoon/test/run-diag-walk.ts <port 18450-18459>
 * Writes agent-tycoon/artifacts/diag-walk-1104/: <view>.png (a row of stills per character and walk, the
 * last one standing), iso-walk.gif (the person's isometric diagonals), office-walk.webm.
 */
import type { Page } from '@playwright/test';
import { execFileSync } from 'child_process';
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
  sparePort,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const OUT = process.env.OUT_DIR ?? path.join(REPO_ROOT, 'agent-tycoon/artifacts/diag-walk-1104');
const CLI = process.env.CLI_JS ?? path.join(REPO_ROOT, 'dist/cli.js');
const DEADLINE_MS = 300_000;
const ZOOM = 6;
const VIEW = { width: 960, height: 720 };
const HOLD_MS = 900;
const PAUSE_MS = 600;
const STILLS = 6;
const CLIP = { w: 40 * ZOOM, h: 56 * ZOOM };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const [DOWN, LEFT, RIGHT, UP] = [0, 1, 2, 3];

type Drawn = { sheet: 'own' | 'diag'; dir: number; mirror: boolean };
type Pose = {
  state: string;
  dir: number;
  diagRow: number | null;
  active: boolean;
  views: { top: Drawn; iso: Drawn };
};
const hooks = <T>(page: Page, fn: (h: any, a: any) => T, arg?: unknown): Promise<T> =>
  page.evaluate(
    ([src, a]) =>
      (new Function('h', 'a', `return (${src})(h, a)`) as (h: unknown, a: unknown) => T)(
        (window as unknown as { __agentTycoonTestHooks: unknown }).__agentTycoonTestHooks,
        a,
      ),
    [fn.toString(), arg] as const,
  );

/** The walks per view: held keys (screen directions in the isometric view, world ones on top). */
const WALKS: Record<'iso' | 'top', Array<{ name: string; keys: string[] }>> = {
  iso: [
    { name: 'down-right', keys: ['ArrowRight', 'ArrowDown'] },
    { name: 'down-left', keys: ['ArrowDown', 'ArrowLeft'] },
    { name: 'up-left', keys: ['ArrowLeft', 'ArrowUp'] },
    { name: 'up-right', keys: ['ArrowUp', 'ArrowRight'] },
    { name: 'right', keys: ['ArrowRight'] },
  ],
  top: [
    { name: 'down-right', keys: ['ArrowRight', 'ArrowDown'] },
    { name: 'down-left', keys: ['ArrowDown', 'ArrowLeft'] },
    { name: 'up-left', keys: ['ArrowLeft', 'ArrowUp'] },
    { name: 'up-right', keys: ['ArrowUp', 'ArrowRight'] },
    { name: 'down', keys: ['ArrowDown'] },
  ],
};

/** What a pose must draw in `view`: the three-quarter sheet (its row and mirroring) or its own. */
function want(p: Pose, view: 'iso' | 'top'): Drawn | 'own' {
  const across = p.dir === RIGHT ? 1 : p.dir === LEFT ? -1 : 0;
  const dr = across ? (p.diagRow ?? 0) : p.dir === DOWN ? 1 : -1;
  const [sx, sy] = view === 'iso' ? [Math.sign(across - dr), Math.sign(across + dr)] : [across, dr];
  if (!(sx && sy)) return 'own';
  return { sheet: 'diag', dir: sy > 0 ? DOWN : UP, mirror: sx < 0 };
}

const drawn = (d: Drawn) => (d.sheet === 'own' ? 'own' : JSON.stringify(d));
const wantText = (p: Pose, view: 'iso' | 'top') => {
  const w = want(p, view);
  return w === 'own' ? w : JSON.stringify(w);
};

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
  if (!ok) failures.push(what);
}

/** Rows of stills side by side (2 px gaps), one row per entry. */
function grid(rows: Buffer[][], file: string): void {
  const pngs = rows.map((r) => r.map((b) => PNG.sync.read(b)));
  const first = pngs.flat()[0];
  if (!first) return;
  const [w, h] = [first.width, first.height];
  const cols = Math.max(...pngs.map((r) => r.length));
  const out = new PNG({ width: cols * (w + 2), height: pngs.length * (h + 2) });
  out.data.fill(255);
  pngs.forEach((r, y) =>
    r.forEach((p, x) => PNG.bitblt(p, out, 0, 0, w, h, x * (w + 2), y * (h + 2))),
  );
  fs.writeFileSync(file, PNG.sync.write(out));
}

/** `n` of `list` spread evenly. */
const spread = <T>(list: T[], n: number): T[] =>
  list.length <= n
    ? list
    : Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]);

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const who = { alpha: { palette: 3 }, beta: { v: 2, kind: 'mascot', species: 'tori' } };
  fs.writeFileSync(path.join(cfg, 'characters.json'), JSON.stringify(who));
  const projects = Object.keys(who).map((name) => {
    const folder = path.join(home, 'work', name);
    fs.mkdirSync(folder, { recursive: true });
    return { name, folder, room: '개발실', wantRunning: true };
  });
  fs.writeFileSync(path.join(cfg, 'projects.json'), JSON.stringify(projects));
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
    // each lead's transcript ends in a plain reply: it is idle (and free to walk)
    const found = new Map<string, { sessionId: string; cwd: string }>();
    for (const end = Date.now() + 40_000; found.size < projects.length; await sleep(300)) {
      if (Date.now() > end) throw new Error('the engine did not revive the sessions');
      for (const f of fs.readdirSync(sessions))
        try {
          const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8'));
          if (s.name in who) found.set(s.name, s);
        } catch {
          /* being written */
        }
    }
    const line = (uuid: string, rec: object) =>
      `${JSON.stringify({ uuid, timestamp: new Date().toISOString(), ...rec })}\n`;
    for (const s of found.values()) {
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
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
    }

    const ctx = await browser.newContext({ viewport: VIEW, recordVideo: { dir: OUT, size: VIEW } });
    await ctx.addInitScript(() => {
      (window as unknown as { __AGENT_TYCOON_E2E: boolean }).__AGENT_TYCOON_E2E = true;
      (window as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
      localStorage.setItem('agty.title-scene', 'off');
      if (!localStorage.getItem('agty.office-iso')) localStorage.setItem('agty.office-iso', 'on');
      localStorage.setItem(
        'agty.office-hours',
        JSON.stringify({ on: false, start: 540, end: 1080, days: [1, 2, 3, 4, 5], lingerMin: 10 }),
      );
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    const clip = {
      x: Math.round(VIEW.width / 2 - CLIP.w / 2),
      y: Math.round(VIEW.height / 2 - CLIP.h * 0.62),
      width: CLIP.w,
      height: CLIP.h,
    };
    const gif: Buffer[] = [];
    for (const view of ['iso', 'top'] as const) {
      if (view === 'top') {
        await page.evaluate(() => localStorage.setItem('agty.office-iso', 'off'));
        await page.reload();
      }
      await page.addStyleTag({
        content: '[data-testid="lobby-board"] { display: none !important; }',
      });
      const rows: Buffer[][] = [];
      for (const name of Object.keys(who)) {
        const label = page.locator('[data-testid="agent-overlay"]', { hasText: name }).first();
        await label.waitFor({ timeout: 30_000 });
        const id = Number(await label.getAttribute('data-agent-id'));
        const tile = () => hooks<Pose | null>(page, (h, a) => h.getCharacterTile(a), id);
        for (const end = Date.now() + 20_000; Date.now() < end && (await tile())?.active;)
          await sleep(200);
        await hooks(page, (h, a) => h.selectAgent(a), id);
        await hooks(page, (h, a) => h.setZoom(a), ZOOM);
        await hooks(page, (h, a) => h.follow(a), id);
        await sleep(2_000); // the camera settles
        for (const walk of WALKS[view]) {
          const shots: Buffer[] = [];
          const poses: Pose[] = [];
          for (const k of walk.keys) await page.keyboard.down(k);
          for (const until = Date.now() + HOLD_MS; Date.now() < until;) {
            const [png, pose] = await Promise.all([page.screenshot({ clip }), tile()]);
            if (pose?.state !== 'walk') continue;
            shots.push(png);
            poses.push(pose);
          }
          for (const k of walk.keys) await page.keyboard.up(k);
          await sleep(PAUSE_MS);
          // the step under way ends first
          for (
            const end = Date.now() + PAUSE_MS * 3;
            Date.now() < end && (await tile())?.state === 'walk';
          )
            await sleep(100);
          const [still, stood] = await Promise.all([page.screenshot({ clip }), tile()]);
          const diagonal = walk.keys.length === 2;
          const bad = poses.filter((p) => drawn(p.views[view]) !== wantText(p, view));
          const threeQuarter = poses.filter((p) => p.views[view].sheet === 'diag').length;
          check(
            poses.length > 0 && bad.length === 0,
            `${view} ${name} ${walk.name}: ${poses.length} walking samples, ${threeQuarter} three-quarter, ${bad.length} wrong`,
          );
          // a pair of keys walks the diagonals: the three-quarter walk drew; standing it keeps
          // its last step's (a key let go first, or a blocked step, may end it straight)
          if (diagonal)
            check(threeQuarter > 0, `${view} ${name} ${walk.name}: the three-quarter walk drew`);
          check(
            !!stood && stood.state !== 'walk' && drawn(stood.views[view]) === wantText(stood, view),
            `${view} ${name} ${walk.name}: standing after it, as its last step (${JSON.stringify(stood && { ...stood, views: stood.views[view] })})`,
          );
          rows.push([...spread(shots, STILLS), still]);
          if (view === 'iso' && name === 'alpha' && diagonal) gif.push(...shots, still, still);
        }
      }
      grid(rows, path.join(OUT, `${view}.png`));
    }
    gif.forEach((b, i) =>
      fs.writeFileSync(path.join(OUT, `f-${String(i).padStart(3, '0')}.png`), b),
    );
    execFileSync('ffmpeg', [
      '-loglevel',
      'error',
      '-y',
      '-framerate',
      '8',
      '-i',
      path.join(OUT, 'f-%03d.png'),
      '-vf',
      'split[a][b];[a]palettegen[p];[b][p]paletteuse',
      path.join(OUT, 'iso-walk.gif'),
    ]);
    for (const f of fs.readdirSync(OUT)) if (/^f-\d+\.png$/.test(f)) fs.rmSync(path.join(OUT, f));
    const video = page.video();
    await ctx.close();
    if (video) fs.renameSync(await video.path(), path.join(OUT, 'office-walk.webm'));
    check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
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
  if (failures.length) throw new Error(`${failures.length} check(s) failed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

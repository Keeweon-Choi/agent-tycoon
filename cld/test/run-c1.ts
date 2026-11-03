/**
 * C1 mock-ups: records the rebirth variants (A light pillar, B star orbit and nova, C fireworks)
 * and the coffee break, with dist/cli.js on an isolated HOME (the fake claude R-8), headless
 * Chromium without a GPU, the office opened with ?fx=1 (the dev trigger, window.__agtyFx).
 *
 * - desktop 1280x800 top-down: each rebirth and the coffee break (walk, machine, drink, +1, back);
 * - desktop isometric: each rebirth;
 * - phone 390x844: each rebirth and the coffee break;
 * - reduced motion: the still badge.
 * Each clip becomes an H.264/yuv420p mp4 (plays on an iPhone), silent and with its jingle
 * (rendered offline in the page by the very synth the app plays, muxed at the effect's start);
 * one still per variant at its peak; a looping GIF per variant (<= 480 px, for the messenger);
 * the idle frame count before and after the effects (and during one).
 * Output: cld/artifacts/c1/.
 *
 *   npx tsx cld/test/run-c1.ts <port 18266|18267>
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
if (port !== 18266 && port !== 18267) throw new Error('C1 records on 18266 or 18267');
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/c1');
const RAW = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-video-'));
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
const IDLE_MS = 3000;
const LEAD_SEC = 1; // video kept before the effect starts
const TAIL_SEC = 1; // and after it ends
type Kind = 'levelUpA' | 'levelUpB' | 'levelUpC' | 'coffee';
const LETTER: Record<Kind, string> = {
  levelUpA: 'rebirth-A',
  levelUpB: 'rebirth-B',
  levelUpC: 'rebirth-C',
  coffee: 'coffee',
};
/** Length and the moment to photograph (s after the start), as actions.ts draws them. */
const REBIRTH: Record<Exclude<Kind, 'coffee'>, { sec: number; peak: number }> = {
  levelUpA: { sec: 3, peak: 1.1 },
  levelUpB: { sec: 3.2, peak: 1.6 },
  levelUpC: { sec: 3.5, peak: 1.75 },
};

/** The e2e hooks, and a frame counter (one clearRect(0,0,..) of the office canvas per frame). */
const INIT = `
  globalThis.__name = (fn) => fn;
  window.__AGENT_TYCOON_E2E = true;
  window.__frames = 0;
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h) {
    if (x === 0 && y === 0 && this.canvas.dataset && this.canvas.dataset.testid === 'office-canvas') {
      const t = document.timeline.currentTime;
      if (t !== window.__frameAt) { window.__frameAt = t; window.__frames++; }
    }
    return clear.call(this, x, y, w, h);
  };`;
/** The dev bar and the "updated to vX" toast are not part of the mock-up. */
const HIDE_BAR =
  '[data-testid="fx-dev-bar"], [data-testid="update-notice"] { display: none !important; }';

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
const hook = <T>(page: Page, call: string): Promise<T> =>
  page.evaluate(`window.__agentTycoonTestHooks.${call}`) as Promise<T>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ff = (args: string[]) =>
  execFileSync('nice', ['-n', '10', 'ffmpeg', '-y', '-loglevel', 'error', ...args]);

/** Frames drawn in IDLE_MS while nothing on the office moves (a few tries: a walker is not idle). */
async function idleFrames(page: Page): Promise<number | null> {
  for (let i = 0; i < 15; i++) {
    const r = (await page.evaluate(`(async () => {
      const h = window.__agentTycoonTestHooks;
      const start = window.__frames;
      const t0 = performance.now();
      let moved = false;
      while (performance.now() - t0 < ${IDLE_MS}) {
        for (const c of h.getCharacters()) {
          const t = h.getCharacterTile(c.id);
          if (c.matrixEffect || c.bubbleType === 'waiting' || (t && !t.away && (t.state === 'walk' || t.ride)))
            moved = true;
        }
        for (const p of h.getPets()) if (p.state !== 'idle' || p.bubbleType) moved = true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return { frames: window.__frames - start, moved };
    })()`)) as { frames: number; moved: boolean };
    if (!r.moved) return r.frames;
  }
  return null;
}

/** 16-bit PCM mono WAV. */
function wav(rate: number, samples: number[]): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) =>
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2),
  );
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function probe(file: string): string {
  return execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_name,pix_fmt,width,height',
    '-of',
    'csv=p=0',
    file,
  ])
    .toString()
    .trim()
    .replace(/\n/g, ' | ');
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const results: string[] = [];
  try {
    /** A logged-in office page with ?fx=1, recorded; `t0` is when its video started. */
    const open = async (
      opts: BrowserContextOptions,
      extra: { iso?: boolean; reduced?: boolean } = {},
    ) => {
      const ctx = await browser.newContext({
        ...opts,
        ...(extra.reduced && { reducedMotion: 'reduce' as const }),
      });
      await warmUpOffice(ctx, daemon, 1500);
      const login = await ctx.newPage();
      await login.goto(await daemon.loginUrl());
      await login.waitForURL(BASE);
      await login.close();
      await ctx.addInitScript(INIT);
      await ctx.addInitScript(
        `try { localStorage.setItem('cld.office-iso', '${extra.iso ? 'on' : 'off'}') } catch {}`,
      );
      const page = await ctx.newPage();
      const t0 = Date.now();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      await page.goto(`${BASE}?fx=1`);
      if (!page.url().startsWith(BASE)) throw new Error(`not logged in: ${page.url()}`);
      await page.waitForFunction(
        () =>
          (
            window as unknown as { __agentTycoonTestHooks?: { getCharacters(): unknown[] } }
          ).__agentTycoonTestHooks?.getCharacters().length,
        undefined,
        { timeout: 30_000 },
      );
      await page.evaluate(() => document.fonts.load("36px 'FS Pixel Sans'", 'Aa'));
      await page.waitForTimeout(3500);
      return { page, t0 };
    };

    /** The character nearest a coffee machine (the same floor, in practice). */
    const pickNearCoffee = async (page: Page): Promise<number> => {
      const furniture = await hook<Array<{ type: string; col: number; row: number }>>(
        page,
        'getFurniture()',
      );
      const machines = furniture.filter((f) => f.type === 'COFFEE_MACHINE');
      const chars = await hook<Array<{ id: number; isSubagent?: boolean }>>(
        page,
        'getCharacters()',
      );
      let best = { id: chars[0].id, d: Infinity };
      for (const c of chars) {
        if (c.isSubagent) continue;
        const t = await hook<{ col: number; row: number; away: boolean } | null>(
          page,
          `getCharacterTile(${c.id})`,
        );
        if (!t || t.away) continue;
        for (const m of machines) {
          const d = Math.abs(t.col - m.col) + Math.abs(t.row - m.row);
          if (d < best.d) best = { id: c.id, d };
        }
      }
      check(
        machines.length > 0 && best.d < Infinity,
        `a coffee machine (${machines.length}) and a character ${best.id} near it (${best.d} tiles)`,
      );
      return best.id;
    };

    const frame = async (page: Page, id: number, iso: boolean, phone: boolean) => {
      if (!phone) {
        await hook(page, 'setZoom(4)');
        await page.waitForTimeout(300);
      }
      if (iso) {
        await hook(page, `follow(${id})`);
        await hook(page, 'selectAgent(null)'); // the camera follows; no plate menu over the effect
      } else await hook(page, `centerOn(${id})`);
      await page.mouse.move(2, 2);
      await page.waitForTimeout(1500);
    };

    /** Close the page, keep its video as <name>-silent.mp4 trimmed to [from, from + dur]. */
    const finish = async (page: Page, name: string, from: number, dur: number): Promise<string> => {
      const video = page.video()!;
      await page.context().close();
      const webm = await video.path();
      const out = path.join(OUT, `${name}-silent.mp4`);
      ff([
        '-ss',
        from.toFixed(2),
        '-i',
        webm,
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
    const withSound = (silent: string, name: string, kind: Kind, at: number) => {
      const out = path.join(OUT, `${name}.mp4`);
      ff([
        '-i',
        silent,
        '-i',
        path.join(OUT, `${LETTER[kind]}.wav`),
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-c:v',
        'copy',
        '-af',
        `adelay=${Math.round(at * 1000)}:all=1,apad`,
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-shortest',
        '-movflags',
        '+faststart',
        out,
      ]);
      return out;
    };

    // ── The jingles, rendered offline by the app's own synth ──
    {
      const { page } = await open(DESKTOP);
      for (const kind of Object.keys(LETTER) as Kind[]) {
        const r = (await page.evaluate(`window.__agtyFx.wav('${kind}')`)) as {
          rate: number;
          samples: number[];
        };
        let last = r.samples.length - 1;
        while (last > 0 && Math.abs(r.samples[last]) < 1e-4) last--;
        const peak = r.samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
        fs.writeFileSync(
          path.join(OUT, `${LETTER[kind]}.wav`),
          wav(r.rate, r.samples.slice(0, last + r.rate / 10)),
        );
        check(
          peak > 0.01 && peak <= 1,
          `${kind} jingle rendered: ${(last / r.rate).toFixed(2)} s, peak ${peak.toFixed(2)}`,
        );
      }
      await page.screenshot({ path: path.join(OUT, 'dev-bar.png') });
      await page.context().close();
    }

    // ── Rebirths: desktop top-down, desktop isometric, phone ──
    for (const [view, opts, iso] of [
      ['desktop', DESKTOP, false],
      ['iso', DESKTOP, true],
      ['phone', PHONE, false],
    ] as const) {
      for (const kind of ['levelUpA', 'levelUpB', 'levelUpC'] as const) {
        const { page, t0 } = await open(opts, { iso });
        await page.addStyleTag({ content: HIDE_BAR });
        const id = await pickNearCoffee(page);
        await frame(page, id, iso, view === 'phone');
        let busyFrames: number | null = null;
        if (view === 'desktop' && kind === 'levelUpA') {
          const before = await idleFrames(page);
          const f0 = (await page.evaluate('window.__frames')) as number;
          const start = (Date.now() - t0) / 1000;
          await page.evaluate(`window.__agtyFx.play('${kind}', ${id}, 3)`);
          await sleep(REBIRTH[kind].peak * 1000);
          await page.screenshot({ path: path.join(OUT, `${view}-${LETTER[kind]}-peak.png`) });
          await sleep((REBIRTH[kind].sec - REBIRTH[kind].peak) * 1000);
          busyFrames = ((await page.evaluate('window.__frames')) as number) - f0;
          await sleep(1500);
          const after = await idleFrames(page);
          results.push(
            `idle frames in ${IDLE_MS} ms: before ${before}, after ${after}; during the ${REBIRTH[kind].sec} s rebirth: ${busyFrames}`,
          );
          check(before !== null && after !== null && after <= before + 2, results.at(-1)!);
          const silent = await finish(
            page,
            `${view}-${LETTER[kind]}`,
            start - LEAD_SEC,
            REBIRTH[kind].sec + LEAD_SEC + TAIL_SEC,
          );
          withSound(silent, `${view}-${LETTER[kind]}`, kind, LEAD_SEC);
          continue;
        }
        const start = (Date.now() - t0) / 1000;
        await page.evaluate(`window.__agtyFx.play('${kind}', ${id}, 3)`);
        await sleep(REBIRTH[kind].peak * 1000);
        await page.screenshot({ path: path.join(OUT, `${view}-${LETTER[kind]}-peak.png`) });
        await sleep((REBIRTH[kind].sec - REBIRTH[kind].peak + TAIL_SEC + 0.3) * 1000);
        const silent = await finish(
          page,
          `${view}-${LETTER[kind]}`,
          start - LEAD_SEC,
          REBIRTH[kind].sec + LEAD_SEC + TAIL_SEC,
        );
        withSound(silent, `${view}-${LETTER[kind]}`, kind, LEAD_SEC);
      }
    }

    // ── The coffee break: desktop and phone ──
    for (const [view, opts] of [
      ['desktop', DESKTOP],
      ['phone', PHONE],
    ] as const) {
      const { page, t0 } = await open(opts);
      await page.addStyleTag({ content: HIDE_BAR });
      const id = await pickNearCoffee(page);
      await frame(page, id, false, view === 'phone');
      if (view === 'desktop') await hook(page, 'setZoom(3)');
      // the camera walks with it (no selection: no plate menu)
      await hook(page, `follow(${id})`);
      await hook(page, 'selectAgent(null)');
      await page.waitForTimeout(500);
      const desk = await hook<{ col: number; row: number }>(page, `getCharacterTile(${id})`);
      const start = (Date.now() - t0) / 1000;
      await page.evaluate(`window.__agtyFx.play('coffee', ${id})`);
      const phases: string[] = [];
      let pop = 0;
      let drinkShot = false;
      const end = Date.now() + 60_000;
      for (;;) {
        if (Date.now() > end) throw new Error(`the coffee break did not end: ${phases.join('>')}`);
        const t = await hook<{ rest: string | null; col: number; row: number }>(
          page,
          `getCharacterTile(${id})`,
        );
        const phase = t.rest ?? 'none';
        if (phases.at(-1) !== phase) {
          phases.push(phase);
          if (phase === 'go') {
            pop = (Date.now() - t0) / 1000;
            await sleep(350);
            await page.screenshot({ path: path.join(OUT, `${view}-coffee-plus.png`) });
          }
        }
        if (phase === 'drink' && !drinkShot) {
          drinkShot = true;
          await sleep(1300);
          await page.screenshot({ path: path.join(OUT, `${view}-coffee-drink.png`) });
        }
        if (phase === 'none' && phases.includes('go')) break;
        await sleep(100);
      }
      await sleep(1500);
      const back = await hook<{ col: number; row: number }>(page, `getCharacterTile(${id})`);
      check(
        phases.join('>').replace(/^none>/, '') === 'fetch>use>drink>go>none' &&
          back.col === desk.col &&
          back.row === desk.row,
        `${view}: coffee break ${phases.join(' > ')}, back at its desk ${back.col},${back.row}`,
      );
      const stop = (Date.now() - t0) / 1000;
      const silent = await finish(
        page,
        `${view}-coffee`,
        start - LEAD_SEC,
        stop - start + LEAD_SEC,
      );
      withSound(silent, `${view}-coffee`, 'coffee', pop - start + LEAD_SEC);
    }

    // ── Reduced motion: the still badge ──
    {
      const { page } = await open(DESKTOP, { reduced: true });
      await page.addStyleTag({ content: HIDE_BAR });
      const id = await pickNearCoffee(page);
      await frame(page, id, false, false);
      await page.evaluate(`window.__agtyFx.play('levelUpA', ${id}, 3)`);
      await sleep(800);
      await page.screenshot({ path: path.join(OUT, 'desktop-rebirth-reduced-motion.png') });
      await page.context().close();
    }

    // ── GIFs for the messenger (the desktop clips, around the character) ──
    for (const kind of Object.keys(LETTER) as Kind[]) {
      const gif = path.join(OUT, `${LETTER[kind]}.gif`);
      // the coffee clip is long (a walk there and back): fewer frames, smaller
      const [fps, crop, w] =
        kind === 'coffee' ? [8, 'crop=640:520:320:140', 320] : [12, 'crop=640:640:320:80', 480];
      ff([
        '-i',
        path.join(OUT, `desktop-${LETTER[kind]}-silent.mp4`),
        '-vf',
        `${kind === 'coffee' ? 'setpts=PTS/2.5,' : ''}fps=${fps},${crop},scale=${w}:-1:flags=neighbor,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none`,
        '-loop',
        '0',
        gif,
      ]);
      const mb = fs.statSync(gif).size / 1024 / 1024;
      check(mb <= 4, `${path.basename(gif)}: ${mb.toFixed(2)} MB`);
    }

    for (const f of fs
      .readdirSync(OUT)
      .filter((f) => f.endsWith('.mp4'))
      .sort())
      console.log(`${f}: ${probe(path.join(OUT, f))}`);
    for (const r of results) console.log(r);
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

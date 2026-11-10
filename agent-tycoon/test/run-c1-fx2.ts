/**
 * C1-FX2 mock-ups: the three grand rebirth candidates (R1 ascension, R2 phoenix, R3
 * constellation) and one level-up (A, the light pillar), with dist/cli.js on an isolated HOME
 * (the fake claude R-8), headless Chromium without a GPU, the office opened with ?fx=1 (the dev
 * trigger, window.__agtyFx). Pattern: run-c1.ts.
 *
 * - isometric, desktop 1280x800 and phone 390x844: each effect recorded once, an H.264/yuv420p
 *   mp4 with its jingle (rendered offline in the page by the app's own synth) and a peak still;
 * - top-down desktop: a peak still of each (readability in the other office);
 * - a looping GIF of each (the desktop clip round the character, <= 4 MB).
 * Output: agent-tycoon/artifacts/c1-fx2/ (the mp4 and GIF files are not committed).
 *
 *   npx tsx agent-tycoon/test/run-c1-fx2.ts <port 18264|18265>
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
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
if (port !== 18264 && port !== 18265) throw new Error('C1-FX2 records on 18264 or 18265');
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/c1-fx2');
const RAW = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-fx2-video-'));
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
const LEAD_SEC = 1;
const TAIL_SEC = 1;
const GIF_MAX_MB = 4;
/** Each effect: its file name, the count shown, its length and the moment to photograph (s). */
const FX = {
  rebirthR1: { name: 'rebirth-R1-ascension', count: 3, sec: 6, peak: 3.0 },
  rebirthR2: { name: 'rebirth-R2-phoenix', count: 3, sec: 6.2, peak: 2.9 },
  rebirthR3: { name: 'rebirth-R3-constellation', count: 3, sec: 6.5, peak: 2.75 },
  levelUpA: { name: 'levelup-A', count: 12, sec: 3, peak: 1.1 },
} as const;
type Kind = keyof typeof FX;
const KINDS = Object.keys(FX) as Kind[];

const INIT = `
  globalThis.__name = (fn) => fn;
  window.__AGENT_TYCOON_E2E = true;`;
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

const probe = (file: string) =>
  execFileSync('ffprobe', [
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

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  try {
    const open = async (opts: BrowserContextOptions, iso: boolean) => {
      const ctx = await browser.newContext(opts);
      await warmUpOffice(ctx, daemon, 1500);
      const login = await ctx.newPage();
      await login.goto(await daemon.loginUrl());
      await login.waitForURL(BASE);
      await login.close();
      await ctx.addInitScript(INIT);
      await ctx.addInitScript(
        `try { localStorage.setItem('agty.office-iso', '${iso ? 'on' : 'off'}') } catch {}`,
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
      await page.addStyleTag({ content: HIDE_BAR });
      return { page, t0 };
    };

    /** A seated agent (not a sub-agent, not away), the camera on it, no plate menu. */
    const frame = async (page: Page, iso: boolean, phone: boolean): Promise<number> => {
      const chars = await hook<Array<{ id: number; isSubagent?: boolean }>>(
        page,
        'getCharacters()',
      );
      let id: number | null = null;
      for (const c of chars) {
        if (c.isSubagent) continue;
        const t = await hook<{ away: boolean } | null>(page, `getCharacterTile(${c.id})`);
        if (t && !t.away) {
          id = c.id;
          break;
        }
      }
      if (id === null) throw new Error('no character in the office');
      if (!phone) await hook(page, 'setZoom(4)');
      if (iso) {
        await hook(page, `follow(${id})`);
        await hook(page, 'selectAgent(null)');
      } else await hook(page, `centerOn(${id})`);
      await page.mouse.move(2, 2);
      await page.waitForTimeout(1500);
      return id;
    };

    // ── The jingles, rendered offline by the app's own synth ──
    {
      const { page } = await open(DESKTOP, true);
      for (const kind of KINDS) {
        const r = (await page.evaluate(`window.__agtyFx.wav('${kind}')`)) as {
          rate: number;
          samples: number[];
        };
        let last = r.samples.length - 1;
        while (last > 0 && Math.abs(r.samples[last]) < 1e-4) last--;
        const peak = r.samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
        fs.writeFileSync(
          path.join(OUT, `${FX[kind].name}.wav`),
          wav(r.rate, r.samples.slice(0, last + r.rate / 10)),
        );
        check(
          peak > 0.01 && peak <= 1,
          `${kind} jingle: ${(last / r.rate).toFixed(2)} s, peak ${peak.toFixed(2)}`,
        );
      }
      await page.context().close();
    }

    // ── Isometric, desktop and phone: video, sound and the peak still ──
    for (const [view, opts] of [
      ['desktop', DESKTOP],
      ['phone', PHONE],
    ] as const) {
      for (const kind of KINDS) {
        const fx = FX[kind];
        const { page, t0 } = await open(opts, true);
        const id = await frame(page, true, view === 'phone');
        const start = (Date.now() - t0) / 1000;
        await page.evaluate(`window.__agtyFx.play('${kind}', ${id}, ${fx.count})`);
        await sleep(fx.peak * 1000);
        await page.screenshot({ path: path.join(OUT, `${view}-${fx.name}-peak.png`) });
        await sleep((fx.sec - fx.peak + TAIL_SEC + 0.3) * 1000);
        const video = page.video()!;
        await page.context().close();
        const silent = path.join(RAW, `${view}-${fx.name}-silent.mp4`);
        ff([
          '-ss',
          (start - LEAD_SEC).toFixed(2),
          '-i',
          await video.path(),
          '-t',
          (fx.sec + LEAD_SEC + TAIL_SEC).toFixed(2),
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-an',
          silent,
        ]);
        ff([
          '-i',
          silent,
          '-i',
          path.join(OUT, `${fx.name}.wav`),
          '-map',
          '0:v',
          '-map',
          '1:a',
          '-c:v',
          'copy',
          '-af',
          `adelay=${LEAD_SEC * 1000}:all=1,apad`,
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-shortest',
          '-movflags',
          '+faststart',
          path.join(OUT, `${view}-${fx.name}.mp4`),
        ]);
        if (view === 'desktop') {
          // the GIF: round the character, as small as it must be to stay under the cap
          const gif = path.join(OUT, `${fx.name}.gif`);
          for (const [fps, w] of [
            [12, 480],
            [10, 400],
            [8, 360],
          ] as const) {
            ff([
              '-i',
              silent,
              '-vf',
              `fps=${fps},crop=800:640:240:80,scale=${w}:-1:flags=neighbor,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none`,
              '-loop',
              '0',
              gif,
            ]);
            if (fs.statSync(gif).size / 1024 / 1024 <= GIF_MAX_MB) break;
          }
          const mb = fs.statSync(gif).size / 1024 / 1024;
          check(mb <= GIF_MAX_MB, `${path.basename(gif)}: ${mb.toFixed(2)} MB`);
        }
      }
    }

    // ── Top-down desktop: the peak stills only ──
    {
      const still: BrowserContextOptions = { ...DESKTOP, recordVideo: undefined };
      for (const kind of KINDS) {
        const fx = FX[kind];
        const { page } = await open(still, false);
        const id = await frame(page, false, false);
        await page.evaluate(`window.__agtyFx.play('${kind}', ${id}, ${fx.count})`);
        await sleep(fx.peak * 1000);
        await page.screenshot({ path: path.join(OUT, `topdown-${fx.name}-peak.png`) });
        await page.context().close();
      }
    }

    for (const f of fs
      .readdirSync(OUT)
      .filter((f) => f.endsWith('.mp4'))
      .sort())
      console.log(`${f}: ${probe(path.join(OUT, f))}`);
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

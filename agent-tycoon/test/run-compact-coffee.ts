/**
 * COMPACT-COFFEE recording (owner 11-01 14:50): the coffee break starts when Claude Code starts
 * compacting and lasts while it compacts. dist/cli.js with --engine on in a temp HOME whose
 * `claude` is the engine fake: the project `alpha` runs in our PTY host (claude-pty), and a
 * "FAKE-COMPACT 40" typed into its terminal makes the fake show Claude Code's spinner line
 * "✻ Compacting conversation… (Ns · esc to interrupt)" for 40 s (COMPACT_MS: longer than the walk
 * and the drink, so the hold shows), then write the compact_boundary (fake-claude/pty-tui.cjs).
 * Headless Chromium without a GPU, the isometric office with ?fx=1 (only for
 * window.__agtyFx.playing), desktop (1280x800) and phone (390x844) at once.
 * Checks: the break starts within a few seconds of the spinner, before the boundary; it drinks
 * on and ends after the boundary (without the hold it is over ~30 s after it starts); one break
 * only (no second one at the boundary).
 * Output: agent-tycoon/artifacts/compact-coffee/<view>-compact-coffee.mp4 (not committed) and a stills strip.
 *
 *   nice -n 10 npx tsx agent-tycoon/test/run-compact-coffee.ts <port 18260|18261>
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { PtyHostClient } from '../../server/src/agent-tycoon/ptyhost/client.js';
import { ptyhostPaths } from '../../server/src/agent-tycoon/ptyhost/protocol.js';
import {
  assertPortFree,
  type Daemon,
  isFakeOf,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]) || 18260;
if (port !== 18260 && port !== 18261) throw new Error('COMPACT-COFFEE records on 18260 or 18261');
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/compact-coffee');
const RAW = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-coffee-video-'));
const DEADLINE_MS = 300_000;
/** Longer than the walk to the machine and its drink (~20 s in the default office): the drink
 *  must still be going when the boundary lands, else the hold proved nothing. Real compactions
 *  take 30-60 s. */
const COMPACT_MS = 40_000;
const LEAD_SEC = 1;
const TAIL_SEC = 2;
const STRIP_FRAMES = 8;
const HIDE =
  '[data-testid="fx-dev-bar"], [data-testid="update-notice"] { display: none !important; }';
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
  recordVideo: { dir: RAW, size: { width: 390, height: 844 } },
};

let oks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  oks++;
  console.log(`ok - ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(
  what: string,
  fn: () => Promise<boolean> | boolean,
  ms = 30_000,
): Promise<void> {
  for (const end = Date.now() + ms; ; await sleep(150)) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}
const read = (f: string): string => {
  try {
    return fs.readFileSync(f, 'utf-8');
  } catch {
    return '';
  }
};
const hook = <T>(page: Page, js: string): Promise<T> =>
  page.evaluate(`window.__agentTycoonTestHooks.${js}`) as Promise<T>;
const playing = (page: Page, id: number) =>
  page.evaluate(`window.__agtyFx.playing(${id})`) as Promise<number | null>;
const ff = (args: string[]) =>
  execFileSync('nice', ['-n', '10', 'ffmpeg', '-y', '-loglevel', 'error', ...args]);
const plateOf = (page: Page, name: string): Promise<number | null> =>
  page.$$eval(
    '[data-testid="agent-overlay"]',
    (nodes, name) => {
      const n = nodes.find(
        (x) => x.querySelector('[data-testid="agent-name"]')?.textContent === name,
      );
      return n ? Number(n.getAttribute('data-agent-id')) : null;
    },
    name,
  );

interface View {
  name: 'desktop' | 'phone';
  page: Page;
  t0: number;
  id: number;
  /** Seconds (from the view's t0) the character's moment started and ended, each time. */
  starts: number[];
  ends: number[];
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const host = ptyhostPaths(home);
  fs.writeFileSync(
    path.join(configDirectory(home), 'config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([
      { name: 'alpha', folder, room: '개발실', wantRunning: true, provider: 'claude-pty' },
    ]),
  );
  const terminals = () => {
    try {
      return JSON.parse(read(host.terminals)) as Array<{ id: string; pid: number }>;
    } catch {
      return [];
    }
  };
  const hostPid = (): number => {
    const m = [...read(host.log).matchAll(/listening, pid (\d+)/g)].at(-1);
    return m ? Number(m[1]) : 0;
  };
  const daemon: Daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const browser = await launchBrowser();
  const client = new PtyHostClient({ home, launch: () => undefined, log: () => undefined });
  const pageErrors: string[] = [];
  const views: View[] = [];
  let code = 0;
  const deadline = setTimeout(() => {
    console.error(`COMPACT-COFFEE: past the deadline ${DEADLINE_MS / 1000} s`);
    process.exit(1);
  }, DEADLINE_MS);
  try {
    const [term] = await (async () => {
      await until('alpha runs in the PTY host', () => terminals().length > 0, 60_000);
      return terminals();
    })();
    await sleep(1_500); // its probe and first screen
    const type = async (text: string) => {
      const r = await client.write(term.id, `\x1b[200~${text}\x1b[201~`);
      check(r.ok, `typed into terminal ${term.id}: ${text}`);
      await sleep(200);
      await client.write(term.id, '\r');
    };
    await type('hello'); // a first turn: its transcript, so the boundary is news later
    const transcript = () => {
      try {
        return fs
          .readdirSync(path.join(home, '.claude/projects'), { recursive: true })
          .map(String)
          .find((f) => f.endsWith('.jsonl'));
      } catch {
        return undefined; // not written yet
      }
    };
    await until('the transcript', () => !!transcript());
    const file = path.join(home, '.claude/projects', transcript()!);

    const loginUrl = await daemon.loginUrl();
    let cookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> = [];
    for (const [name, opts] of [
      ['desktop', DESKTOP],
      ['phone', PHONE],
    ] as const) {
      const ctx = await browser.newContext(opts);
      await ctx.addInitScript(
        "globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true; try { localStorage.setItem('agty.office-iso', 'on'); localStorage.setItem('agty.camera-mode', 'auto') } catch {}",
      );
      if (cookies.length) await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      const t0 = Date.now();
      page.on('pageerror', (err) => pageErrors.push(`${name}: ${String(err)}`));
      if (!cookies.length) {
        await page.goto(loginUrl);
        await page.waitForURL(BASE);
        cookies = await ctx.cookies();
      }
      await page.goto(`${BASE}?fx=1`);
      await page.evaluate(() => document.fonts.load("36px 'FS Pixel Sans'", 'Aa'));
      await page.addStyleTag({ content: HIDE });
      views.push({ name, page, t0, id: 0, starts: [], ends: [] });
    }
    for (const v of views) {
      await until(
        `${v.name}: alpha is in`,
        async () => (await plateOf(v.page, 'alpha')) !== null,
        45_000,
      );
      v.id = (await plateOf(v.page, 'alpha'))!;
      const closeInfo = v.page.getByRole('button', { name: '정보 창 닫기' });
      if (await closeInfo.count()) await closeInfo.click();
      await hook(v.page, `setZoom(${v.name === 'desktop' ? 4 : 3})`);
      await hook(v.page, `follow(${v.id})`);
    }
    check(views[0].id === views[1].id, `alpha's character ${views[0].id} on both`);
    await sleep(7_000); // past the page's settle window (REST_SETTLE_MS), at its desk

    // Watch the moment on both, every 150 ms, from before the spinner to well after the boundary.
    let watching = true;
    const watch = (async () => {
      const on = new Map<View, boolean>();
      while (watching) {
        for (const v of views) {
          const now = (await playing(v.page, v.id)) !== null;
          const t = (Date.now() - v.t0) / 1000;
          if (now && !on.get(v)) v.starts.push(t);
          if (!now && on.get(v)) v.ends.push(t);
          on.set(v, now);
        }
        await sleep(150);
      }
    })();
    const sec = (v: View) => (Date.now() - v.t0) / 1000;
    const spinnerAt = new Map(views.map((v) => [v, sec(v)]));
    await type(`FAKE-COMPACT ${COMPACT_MS / 1000} /compact`);
    await until(
      'the compact_boundary',
      () => read(file).includes('"compact_boundary"'),
      COMPACT_MS + 10_000,
    );
    const boundaryAt = new Map(views.map((v) => [v, sec(v)]));
    await until(
      'the break is over on both',
      () => views.every((v) => v.ends.length >= v.starts.length && v.starts.length > 0),
      60_000,
    );
    await sleep(12_000); // a second break would start here
    watching = false;
    await watch;

    for (const v of views) {
      const s = spinnerAt.get(v)!;
      const b = boundaryAt.get(v)!;
      check(
        v.starts.length === 1,
        `${v.name}: one break only (starts at ${v.starts.map((x) => (x - s).toFixed(1)).join(', ')} s after the spinner)`,
      );
      const start = v.starts[0] - s;
      check(
        start < 4 && v.starts[0] < b,
        `${v.name}: it started ${start.toFixed(1)} s after the spinner, ${(b - v.starts[0]).toFixed(1)} s before the boundary`,
      );
      // Negative control: without the hold the break is over ~30 s after it starts, before the boundary.
      check(
        v.ends[0] > b,
        `${v.name}: it drank on through the compaction, ended ${(v.ends[0] - b).toFixed(1)} s after the boundary (the walk back)`,
      );
    }
    check(
      (read(file).match(/"compact_boundary"/g) ?? []).length === 1,
      'the transcript has the one compaction',
    );

    for (const v of views) {
      const video = v.page.video()!;
      await v.page.context().close();
      const raw = await video.path();
      const from = Math.max(0, spinnerAt.get(v)! - LEAD_SEC);
      const len = v.ends[0] + TAIL_SEC - from;
      const mp4 = path.join(OUT, `${v.name}-compact-coffee.mp4`);
      ff([
        '-ss',
        from.toFixed(2),
        '-i',
        raw,
        '-t',
        len.toFixed(2),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-movflags',
        '+faststart',
        mp4,
      ]);
      const w = v.name === 'phone' ? 260 : 400;
      ff([
        '-i',
        mp4,
        '-vf',
        `fps=${STRIP_FRAMES}/${len.toFixed(2)},scale=${w}:-1,tile=${STRIP_FRAMES}x1:padding=4:color=black`,
        '-frames:v',
        '1',
        path.join(OUT, `${v.name}-compact-coffee-strip.png`),
      ]);
      console.log(
        `${path.basename(mp4)}: ${len.toFixed(1)} s (spinner at ${LEAD_SEC} s, boundary at ${(boundaryAt.get(v)! - from).toFixed(1)} s)`,
      );
    }
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
  } catch (err) {
    code = 1;
    console.error(err);
    console.error(`--- daemon log tail ---\n${daemon.log.join('').slice(-3000)}`);
  } finally {
    clearTimeout(deadline);
    client.dispose();
    await browser.close().catch(() => undefined);
    await daemon.stop().catch(() => undefined);
    // The host and the fakes are this test HOME's, nothing else.
    const hp = hostPid();
    if (hp && isFakeOf(hp, home)) process.kill(hp, 'SIGKILL');
    killFakeSessions(home);
    fs.rmSync(RAW, { recursive: true, force: true });
    if (code === 0) fs.rmSync(home, { recursive: true, force: true });
    else console.error(`left for a look: ${home}`);
  }
  console.log(`${oks} checks passed`);
  process.exit(code);
}

void main();

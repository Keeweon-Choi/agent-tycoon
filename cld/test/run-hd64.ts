/**
 * HD64-SAMPLE verification: dist/cli.js with an isolated HOME on a spare port, headless Chromium
 * without a GPU. One fake Claude session (`lead`, a `sleep` with a transcript reading a file) wears
 * the built-in bunny preset (cld/packs/hd-bunny); no model is ever called.
 *
 *  1. In the office (Classic camera) at zoom 2 and 4: the copy the bunny draws at each (32×64,
 *     64×128) and at 3 (16×32), screenshots next to the built-in staff and furniture, with more
 *     bunnies walking and typing at desks; the lead reads (her transcript's last tool is Read).
 *  2. Performance, desktop (1280×800) and phone (390×844 at 3×, touch) with the CPU throttled 4×:
 *     the readout's draw time and the frames a second with 1, 10 and 20 bunnies (and 20 built-in
 *     characters for comparison), the sprite cache built per character at zoom 4, 2 and 3, the JS
 *     heap. Numbers: cld/artifacts/hd64/perf.json; screenshots: cld/artifacts/hd64/office-*.png.
 *
 *   npx tsx cld/test/run-hd64.ts <port 18256-18259>
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/hd64');
const DESK = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const THROTTLE = 4;
const COUNTS = [1, 10, 20];
const SAMPLE_MS = 3000;
const WARMUP_MS = 2500;
const PACK = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'cld/packs/hd-bunny/pack.json'), 'utf-8'),
) as {
  id: string;
  presets: { look: { parts: Record<string, string> } & Record<string, unknown> }[];
};
const preset = PACK.presets[0].look;
/** The preset's look as the daemon stores it: part ids namespaced by the pack. */
const LOOK = {
  ...preset,
  parts: Object.fromEntries(Object.entries(preset.parts).map(([k, v]) => [k, `${PACK.id}/${v}`])),
};

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

function session(home: string) {
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/characters.json'),
    JSON.stringify({ lead: LOOK }),
  );
  const cwd = '/work/alpha';
  const proc = spawn('sleep', ['1200'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c1025900-0000-4000-8000-000000000001';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: `${cwd}/a.md` } },
        ],
      },
    }) + '\n',
  );
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      cwd,
      startedAt: Date.now() - 600_000,
      procStart,
      version: '2.1.306',
      kind: 'interactive',
      name: 'lead',
      status: 'busy',
    }),
  );
  return proc;
}

const INIT = `
  globalThis.__name = (fn) => fn; // tsx names the functions it passes to page.evaluate
  window.__PIXEL_AGENTS_E2E = true;`;
const CLASSIC = { 'cld.camera-mode': 'classic', 'cld.backdrop': 'off', 'cld.title-scene': 'off' };

type Hooks = {
  setZoom: (z: number) => void;
  centerOn: (id: number) => boolean;
  walkTo: (id: number, col: number, row: number) => boolean;
  getCharacterTile: (id: number) => { col: number; row: number } | null;
  getAgentSeats: () => Array<{ id: number }>;
  getCharacters: () => Array<{ id: number }>;
  getCharacterPosition: (id: number) => { x: number; y: number } | null;
  getTileCenter: (c: number, r: number) => { x: number; y: number } | null;
  spawnLook: (look: unknown, n: number, firstId: number) => number[];
  cacheBuildMs: (palette: number, hue: number, zoom: number) => number;
  drawnDensity: (palette: number, hue: number, zoom: number) => number;
  perf: () => {
    avgMs: number;
    maxMs: number;
    characters: number;
    hd64: number;
    zoom: number;
    cacheBytes: number;
  };
  setPerf: (on: boolean) => void;
};
const hooks =
  (page: Page) =>
  <T>(fn: (h: Hooks, arg: unknown) => T, arg?: unknown): Promise<T> =>
    page.evaluate(
      `(${fn.toString()})(window.__pixelAgentsTestHooks, ${JSON.stringify(arg ?? null)})`,
    ) as Promise<T>;

async function open(browser: Browser, url: string, opts: BrowserContextOptions) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(INIT);
  await ctx.addInitScript((pairs) => {
    for (const [k, v] of pairs)
      try {
        localStorage.setItem(k, v);
      } catch {
        // about:blank
      }
  }, Object.entries(CLASSIC));
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForURL(/\/$/);
  await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
  const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
  if (await closeInfo.count()) await closeInfo.first().click();
  await page.waitForTimeout(1500);
  return { ctx, page, errors };
}

/** The lead's palette (the one her sprite draws from), found by its HD64 density. */
async function leadPalette(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __pixelAgentsTestHooks: { drawnDensity: (p: number, h: number, z: number) => number };
    };
    for (let p = 0; p < 2000; p++)
      if (w.__pixelAgentsTestHooks.drawnDensity(p, 0, 4) === 3) return p; // a 64×128 person draws at density 3 (SHEET-IMPORT)
    return -1;
  });
}

/** A screenshot of the canvas around world point (x, y), CSS px. */
async function around(page: Page, id: number, name: string, wTiles = 9, hTiles = 6) {
  const box = await hooks(page)(
    (h, a) => {
      const [id] = a as [number];
      const p = h.getCharacterPosition(id);
      const t0 = h.getTileCenter(0, 0)!;
      const t1 = h.getTileCenter(1, 0)!;
      const tile = t1.x - t0.x;
      return p
        ? { x: t0.x + ((p.x - 8) / 16) * tile, y: t0.y + ((p.y - 8) / 16) * tile, tile }
        : null;
    },
    [id],
  );
  if (!box) return;
  const clip = {
    x: Math.max(0, box.x - (wTiles / 2) * box.tile),
    y: Math.max(0, box.y - hTiles * 0.7 * box.tile),
    width: wTiles * box.tile,
    height: hTiles * box.tile,
  };
  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip });
}

/** Frames a second over SAMPLE_MS, and the readout's draw time over its last 60 frames. */
async function sample(page: Page) {
  const fps = await page.evaluate(
    (ms) =>
      new Promise<number>((done) => {
        let n = 0;
        const t0 = performance.now();
        const step = () => {
          n++;
          if (performance.now() - t0 < ms) requestAnimationFrame(step);
          else done((n * 1000) / (performance.now() - t0));
        };
        requestAnimationFrame(step);
      }),
    SAMPLE_MS,
  );
  const perf = await hooks(page)((h) => h.perf());
  return {
    fps: Math.round(fps * 10) / 10,
    drawMs: Math.round(perf.avgMs * 100) / 100,
    drawMaxMs: Math.round(perf.maxMs * 10) / 10,
    characters: perf.characters,
    hd64: perf.hd64,
    cacheMB: Math.round((perf.cacheBytes / 1048576) * 10) / 10,
  };
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  // this runner's own pictures from an earlier pass (the generator's stay)
  for (const f of fs.readdirSync(OUT))
    if (/^(office|perf)-.*\.png$|^perf\.json$/.test(f)) fs.rmSync(path.join(OUT, f));
  const browser = await launchBrowser();
  const fake = makeEngineHome();
  const home = fake.home;
  const lead = session(home);
  const daemon = startDaemon({ home, claudePath: fake.claudePath }, port, ['--no-terminal'], {});
  const result: Record<string, unknown> = {};
  try {
    // ── 1. in the office ──
    {
      const { ctx, page, errors } = await open(browser, await daemon.loginUrl(), DESK);
      const palette = await leadPalette(page);
      check(palette >= 0, 'the lead wears the bunny preset (a 64×128 sheet)');
      const picked = await hooks(page)(
        (h, a) => [1, 2, 3, 4, 6, 8].map((z) => h.drawnDensity(a as number, 0, z)),
        palette,
      );
      check(
        // SHEET-IMPORT: one master at every zoom, never the copy the zoom divides (was 1,2,1,4,2,4)
        picked.join() === '3,3,3,3,3,3',
        `the density per zoom 1,2,3,4,6,8: ${picked.join(',')} (her one 64×128 master drawn at 3 each time)`,
      );
      result.lodPerZoom = Object.fromEntries([1, 2, 3, 4, 6, 8].map((z, i) => [z, picked[i]]));
      const leadId = (await hooks(page)((h) => h.getAgentSeats()))[0].id;
      // more bunnies: half typing at desks, half walking about
      await hooks(page)((h, l) => h.spawnLook(l, 4, 9100), LOOK);
      await page.waitForTimeout(1500);
      for (const z of [2, 3, 4]) {
        await hooks(page)((h, a) => h.setZoom(a as number), z);
        await hooks(page)((h, id) => h.centerOn(id as number), leadId);
        await page.waitForTimeout(2000);
        await page.screenshot({ path: path.join(OUT, `office-zoom${z}.png`) });
        await around(page, leadId, `office-zoom${z}-lead`);
        // one bunny typing at a desk; one sent walking across the room, caught twice mid-stride
        await hooks(page)((h, a) => h.centerOn(a as number), 9100);
        await page.waitForTimeout(600);
        await around(page, 9100, `office-zoom${z}-typing`);
        const walking = await hooks(page)((h) => {
          const t = h.getCharacterTile(9101);
          if (!t) return false;
          // the farthest tile it can reach within six tiles (a few steps of the cycle)
          for (let d = 6; d >= 3; d--)
            for (const [dc, dr] of [
              [d, 0],
              [-d, 0],
              [0, d],
              [0, -d],
              [d, d],
              [-d, d],
              [d, -d],
              [-d, -d],
            ])
              if (h.walkTo(9101, t.col + dc, t.row + dr)) return true;
          return false;
        });
        check(walking, `zoom ${z}: a bunny walks`);
        for (const k of [1, 2]) {
          await page.waitForTimeout(k === 1 ? 500 : 230);
          await hooks(page)((h, a) => h.centerOn(a as number), 9101);
          await around(page, 9101, `office-zoom${z}-walking${k}`);
        }
      }
      check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
      await ctx.close();
    }
    // ── 2. performance: per profile, zoom and count a fresh page; every character's sprite
    // cache built first (timed: the one-off cost), then the steady frames sampled ──
    for (const [name, opts] of [
      ['desktop', DESK],
      ['phone', PHONE],
    ] as const) {
      const rows: Record<string, unknown>[] = [];
      const measure = async (
        zoom: number,
        look: unknown,
        extra: number,
        label: Record<string, unknown>,
      ) => {
        const { ctx, page } = await open(browser, await daemon.loginUrl(), opts);
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
        await hooks(page)((h) => h.setPerf(true));
        await hooks(page)((h, z) => h.setZoom(z as number), zoom);
        const t0 = Date.now();
        const palettes = extra
          ? await hooks(page)(
              (h, a) => {
                const [l, k] = a as [unknown, number];
                return h.spawnLook(l, k, 9100);
              },
              [look, extra],
            )
          : [];
        const composeMs = (Date.now() - t0) / Math.max(1, extra);
        // the lead's palette too, then each character's cache at this zoom
        const all = [await leadPalette(page), ...palettes].filter((p) => p >= 0);
        const builds: number[] = [];
        for (const p of all)
          builds.push(
            await hooks(page)(
              (h, a) => {
                const [pal, z] = a as [number, number];
                return h.cacheBuildMs(pal, 0, z);
              },
              [p, zoom],
            ),
          );
        await page.waitForTimeout(WARMUP_MS);
        const s = await sample(page);
        const heapMB =
          Math.round(
            ((await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }).usedSize / 104857.6,
          ) / 10;
        builds.sort((x, y) => x - y);
        const row = {
          ...label,
          zoom,
          ...s,
          heapMB,
          composeMsPerCharacter: Math.round(composeMs),
          cacheBuildMsMedian: Math.round(builds[Math.floor(builds.length / 2)] * 10) / 10,
        };
        rows.push(row);
        console.log(name, JSON.stringify(row));
        if (zoom === 4 && extra === 19)
          await page.screenshot({
            path: path.join(OUT, `perf-${name}-${label.classic ? 'classic' : 'hd64'}.png`),
          });
        await ctx.close();
      };
      for (const zoom of [4, 2, 3])
        for (const n of COUNTS) await measure(zoom, LOOK, n - 1, { hd64: n });
      // for comparison: 19 built-in (16×32) characters besides the lead
      await measure(4, { palette: 0 }, 19, { classic: 19 });
      result[name] = { throttle: THROTTLE, rows };
    }
    fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify(result, null, 2) + '\n');
    check(true, 'perf.json written');
  } finally {
    await daemon.stop();
    lead.kill();
    killFakeSessions(home);
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

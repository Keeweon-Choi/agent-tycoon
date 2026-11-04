/**
 * LOOKS-MEM (owner 11-04 20:00): 꾸미기 on an iPhone lagged and Safari closed the page ("이 주소에서
 * 반복적으로 문제가 발생했다"): the 사람 tab's sheet chips decoded every preset sheet whole (8 sheets
 * of 2304×3168 and the 2592×2640 bunny, ~29 MB each decoded). dist/cli.js with an isolated HOME,
 * headless Chromium (--disable-gpu), a phone (390×844, touch, dpr 3) and a desktop (1282×832).
 *
 * Test sheets of the owner's shape (never the owner's files): 8 imported iso8 sheets with the
 * drink row, 2304×3168, 5-7 MB each, plus the built-in bunny. The lead wears one of them and the
 * owner the bunny. Per viewport: the browser's memory (PSS of the whole Chromium tree: renderer,
 * GPU process, browser; decoded images included) in the office, then with 꾸미기's 사람 tab open
 * and its sheet row in view (all thumbnails loaded): the growth must stay under LIMIT_MB; the
 * thumbnails are small pictures; two sheets picked in turn leave only the last one decoded; the
 * saved one is in characters.json; after closing, the office still draws the lead as that sheet.
 * Then (owner 20:17) 5 rounds of open, pick 4 people, 4 mascots and 3 sheets, close: the memory
 * after the last round stays within CYCLE_LIMIT_MB of the first, and only worn sheets stay decoded.
 * `--original` (negative control): the thumbnail requests are answered with the whole sheet, as
 * before the fix; the memory check must then fail.
 * Screenshots and numbers to cld/artifacts/looks-mem-1104/.
 *
 *   npx tsx cld/test/run-looks-mem-1104.ts <port 18520-18529> [--original]
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18520 && port <= 18529)) throw new Error('port 18520-18529');
const ORIGINAL = process.argv.includes('--original');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/looks-mem-1104');
/** The test sheets, made once (outside the repo). */
const SHEET_CACHE = path.join(os.tmpdir(), 'looks-mem-1104-sheets');
/** 꾸미기's 사람 tab may add this much to the browser (its thumbnails, the window). */
const LIMIT_MB = 60;
/** Rounds of open, pick, close; the last may sit at most this far over the first. */
const CYCLES = 5;
const CYCLE_LIMIT_MB = 40;
const SIZES: Record<string, BrowserContextOptions> = {
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  desktop: { viewport: { width: 1282, height: 832 } },
};
const SHEETS = ['t-boss', ...Array.from({ length: 7 }, (_, i) => `t-char-${i + 1}`)];
/** What each viewport picks in turn (the last one is saved). */
const PICKS: Record<string, [string, string]> = {
  phone: ['t-char-1', 't-char-2'],
  desktop: ['t-char-3', 't-char-4'],
};

let failed = 0;
function check(ok: unknown, what: string): void {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

/** An imported iso8 sheet with its drink row (8 columns of 288×528, 6 rows): a noisy figure per
 *  cell in its own hue, as big on disk as the owner's (5-7 MB). */
function makeSheet(file: string, hue: number): void {
  const [W, H, FW, FH] = [2304, 3168, 288, 528];
  const png = new PNG({ width: W, height: H });
  const base = [
    [200, 60, 60],
    [60, 160, 70],
    [60, 90, 200],
    [190, 160, 40],
    [150, 60, 180],
    [40, 160, 170],
    [210, 110, 40],
    [120, 120, 120],
  ][hue % 8];
  let seed = hue * 7919 + 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8) & 63;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [cx, cy] = [(x % FW) - FW / 2, (y % FH) - FH * 0.55];
      if ((cx / 80) ** 2 + (cy / 200) ** 2 > 1) continue;
      const i = (y * W + x) * 4;
      png.data[i] = base[0] + rnd() - 32;
      png.data[i + 1] = base[1] + rnd() - 32;
      png.data[i + 2] = base[2] + rnd() - 32;
      png.data[i + 3] = 255;
    }
  fs.writeFileSync(file, PNG.sync.write(png, { colorType: 6 }));
}

function session(home: string, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c1104200-0000-4000-8000-000000000001';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: `${cwd}/README.md` } },
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
      name,
      status: 'busy',
    }),
  );
  return proc;
}

// ── /proc: the browser this runner started (its descendants only) ──
function descendants(root: number): number[] {
  const parent = new Map<number, number>();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf-8');
      parent.set(Number(d), Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]));
    } catch {
      // gone
    }
  }
  const out: number[] = [];
  const q = [root];
  while (q.length) {
    const p = q.shift()!;
    for (const [c, pp] of parent) if (pp === p) (out.push(c), q.push(c));
  }
  return out;
}
const isChromium = (pid: number) => {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').includes('chrom');
  } catch {
    return false;
  }
};
const kindOf = (pid: number) => {
  try {
    return (
      /--type=([a-z-]+)/.exec(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8'))?.[1] ?? 'browser'
    );
  } catch {
    return 'gone';
  }
};
function pssMB(pid: number): number {
  try {
    const s = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf-8');
    return Number(/^Pss:\s+(\d+)/m.exec(s)![1]) / 1024;
  } catch {
    return 0;
  }
}
function rssMB(pid: number): number {
  try {
    return (
      Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf-8'))![1]) / 1024
    );
  } catch {
    return 0;
  }
}

async function memory(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await page.waitForTimeout(1500);
  await cdp.send('HeapProfiler.collectGarbage');
  await page.waitForTimeout(500);
  const { usedSize } = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
  await cdp.detach();
  const pids = descendants(process.pid).filter(isChromium);
  const by: Record<string, number> = {};
  for (const p of pids) by[kindOf(p)] = (by[kindOf(p)] ?? 0) + pssMB(p);
  const renderers = pids.filter((p) => kindOf(p) === 'renderer');
  return {
    totalPssMB: Math.round(Object.values(by).reduce((a, b) => a + b, 0)),
    rendererPssMB: Math.round(by.renderer ?? 0),
    rendererRssMB: Math.round(renderers.reduce((a, p) => a + rssMB(p), 0)),
    gpuPssMB: Math.round(by['gpu-process'] ?? 0),
    jsHeapMB: Math.round(usedSize / 1048576),
  };
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SHEET_CACHE, { recursive: true });
  SHEETS.forEach((id, i) => {
    const file = path.join(SHEET_CACHE, `${id}.png`);
    if (!fs.existsSync(file)) makeSheet(file, i);
  });
  const { home, claudePath } = makeEngineHome();
  const chars = path.join(configDirectory(home), 'characters');
  fs.mkdirSync(chars, { recursive: true });
  for (const id of SHEETS) {
    fs.copyFileSync(path.join(SHEET_CACHE, `${id}.png`), path.join(chars, `${id}.png`));
    fs.writeFileSync(
      path.join(chars, `${id}.json`),
      JSON.stringify({ label: id, columns: 'standFirst', walk: 'steps' }),
    );
  }
  const store = path.join(configDirectory(home), 'characters.json');
  fs.writeFileSync(
    store,
    JSON.stringify({
      $meta: { v: 3, pinnedAt: new Date().toISOString() },
      lead: { preset: 't-boss' },
      owner: { preset: 'builtin-bunny' },
    }),
  );
  const looks = () =>
    JSON.parse(fs.readFileSync(store, 'utf-8')) as Record<string, Record<string, unknown>>;
  const lead = session(home, 'lead', '/work/alpha');
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal'], {});
  const browser = await launchBrowser();
  const results: Record<string, unknown> = { original: ORIGINAL, limitMB: LIMIT_MB };
  const tag = ORIGINAL ? 'ORIGINAL-' : '';
  try {
    for (const [size, opts] of Object.entries(SIZES)) {
      const ctx = await browser.newContext(opts);
      await ctx.addInitScript(
        "globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true; window.__AGENT_TYCOON_LATER_FEATURES = 'off';",
      );
      if (ORIGINAL)
        // as before the fix: each chip shows the whole sheet
        await ctx.route(/\/cld\/characters\/[^/]+\.thumb\.png/, (route) =>
          route.continue({ url: route.request().url().replace('.thumb.png', '.png') }),
        );
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 60_000 });
      const sheetsOf = () =>
        page.evaluate(() =>
          (
            window as unknown as { __agentTycoonTestHooks: { loadedPresetSheets(): string[] } }
          ).__agentTycoonTestHooks
            .loadedPresetSheets()
            .map((u) => /characters\/([^.?]+)/.exec(u)?.[1] ?? u),
        );
      /** The camera on the lead (the sheet character), for the office pictures. */
      const showLead = async () => {
        await page.evaluate(() => {
          const h = (
            window as unknown as {
              __agentTycoonTestHooks: {
                getCharacters(): Array<{ id: number; agentName?: string }>;
                centerOn(id: number): boolean;
              };
            }
          ).__agentTycoonTestHooks;
          const lead = h.getCharacters().find((c) => c.agentName === 'lead');
          if (lead) h.centerOn(lead.id);
        });
        await page.waitForTimeout(1500);
      };
      const wearing = looks().lead?.preset as string;
      await until(`the office loaded the lead's ${wearing}`, async () =>
        (await sheetsOf()).includes(wearing),
      );
      await page.waitForTimeout(3000);
      await showLead();
      await page.screenshot({ path: path.join(OUT, `${tag}${size}-office-before.png`) });
      const m0 = await memory(page);
      const office0 = await sheetsOf();
      console.log(`${size}: the office decoded ${office0.join(', ')}`);

      // 꾸미기 for the lead, 사람 tab, its sheet row in view: every thumbnail loads
      await page.evaluate(() =>
        (
          window as unknown as { __agentTycoonTestHooks: { openLooks(n: string): void } }
        ).__agentTycoonTestHooks.openLooks('lead'),
      );
      const win = page.locator('[data-testid="looks-window"]');
      await win.waitFor();
      const chips = win.locator('[data-testid^="looks-sheetchar-"]:not([data-testid$="-add"])');
      await chips.last().scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      const imgs = chips.locator('img');
      const thumbs = await imgs.count();
      await until(
        'the thumbnails loaded',
        async () =>
          (await imgs.evaluateAll((els) =>
            els.every((e) => (e as HTMLImageElement).complete),
          )) as boolean,
        60_000,
      ).catch(() => undefined);
      // whatever the tab starts decoding has finished (nothing new for 3 s)
      for (let last = -1, still = 0, t = 0; still < 3 && t < 90; t++) {
        const n = (await sheetsOf()).length;
        still = n === last ? still + 1 : 0;
        last = n;
        await page.waitForTimeout(1000);
      }
      const m1 = await memory(page);
      const natural = (await imgs.evaluateAll((els) =>
        els.map((e) => [
          (e as HTMLImageElement).naturalWidth,
          (e as HTMLImageElement).naturalHeight,
        ]),
      )) as number[][];
      const openSheets = await sheetsOf();
      await win.screenshot({ path: path.join(OUT, `${tag}${size}-people-tab.png`) });
      const grew = m1.totalPssMB - m0.totalPssMB;
      check(
        grew < LIMIT_MB,
        `${size}: opening the 사람 tab grows the browser by ${grew} MB (< ${LIMIT_MB} MB; renderer ${m1.rendererPssMB - m0.rendererPssMB} MB)`,
      );
      check(
        thumbs === SHEETS.length + 1 &&
          natural.length === thumbs &&
          natural.every(([w, h]) => w > 0 && h > 0 && w <= 96 && h <= 192),
        `${size}: ${thumbs} sheet chips show small thumbnails (${natural.map((n) => n.join('×')).join(', ')})`,
      );
      check(
        openSheets.every((s) => office0.includes(s)),
        `${size}: the tab decodes no sheet the office did not (${openSheets.join(', ')})`,
      );

      // two sheets picked in turn: the preview keeps only the last one
      const [first, second] = PICKS[size];
      await win.getByTestId(`looks-sheetchar-${first}`).click();
      await until(`${first} decoded for the preview`, async () =>
        (await sheetsOf()).includes(first),
      );
      await page.waitForTimeout(800);
      await win.getByTestId(`looks-sheetchar-${second}`).click();
      await until(`${second} decoded for the preview`, async () =>
        (await sheetsOf()).includes(second),
      );
      await page.waitForTimeout(1000);
      const picked = await sheetsOf();
      check(
        !picked.includes(first),
        `${size}: ${first} was let go when ${second} was picked (${picked.join(', ')})`,
      );
      await page.waitForTimeout(500);
      await page.locator('[data-testid="looks-preview"]').screenshot({
        path: path.join(OUT, `${tag}${size}-preview.png`),
      });
      const m2 = await memory(page);
      await win.getByTestId('looks-save').click();
      await until(`${second} saved`, () => looks().lead?.preset === second);
      check(true, `${size}: ${second} saved to characters.json`);
      // closed: the office wears the saved sheet; the one the lead wore before is let go
      await page.evaluate(() =>
        (
          window as unknown as { __agentTycoonTestHooks: { closeLooks(): void } }
        ).__agentTycoonTestHooks.closeLooks(),
      );
      await win.waitFor({ state: 'detached', timeout: 10_000 });
      await page.waitForTimeout(3000);
      const closed = await sheetsOf();
      check(
        closed.includes(second) && !closed.includes(wearing) && !closed.includes(first),
        `${size}: after closing, the office keeps ${second} and drops ${wearing} (${closed.join(', ')})`,
      );
      const m3 = await memory(page);
      await showLead();
      await page.screenshot({ path: path.join(OUT, `${tag}${size}-office-after.png`) });
      const leadDrawn = await page.evaluate(() => {
        const h = (
          window as unknown as {
            __agentTycoonTestHooks: {
              getCharacters(): Array<{ agentName?: string; palette: number }>;
            };
          }
        ).__agentTycoonTestHooks;
        return h.getCharacters().map((c) => c.palette);
      });
      check(
        leadDrawn.some((p) => p >= 1000),
        `${size}: the office draws a sheet character (palettes ${leadDrawn.join(', ')})`,
      );
      // owner 20:17: opened and closed again and again, picking people, mascots and sheets
      // (never saved), the window must not pile up canvases or pictures
      const cycles: number[] = [];
      for (let round = 0; round < CYCLES; round++) {
        await page.evaluate(() =>
          (
            window as unknown as { __agentTycoonTestHooks: { openLooks(n: string): void } }
          ).__agentTycoonTestHooks.openLooks('lead'),
        );
        await win.waitFor();
        for (const n of [0, 5, 11, 17]) await win.getByTestId(`looks-people-${n}`).click();
        await win.getByRole('button', { name: '마스코트', exact: true }).click();
        const mascots = win.locator('section button[aria-pressed]');
        for (let i = 0; i < Math.min(4, await mascots.count()); i++) await mascots.nth(i).click();
        await win.getByRole('button', { name: '사람', exact: true }).click();
        for (const id of ['t-char-5', 't-char-6', 'builtin-bunny']) {
          await win.getByTestId(`looks-sheetchar-${id}`).click();
          await until(`${id} in the preview`, async () => (await sheetsOf()).includes(id));
          await page.waitForTimeout(600);
        }
        await page.evaluate(() =>
          (
            window as unknown as { __agentTycoonTestHooks: { closeLooks(): void } }
          ).__agentTycoonTestHooks.closeLooks(),
        );
        await win.waitFor({ state: 'detached', timeout: 10_000 });
        await page.waitForTimeout(1000);
        cycles.push((await memory(page)).totalPssMB);
      }
      const after = await sheetsOf();
      const climb = cycles[cycles.length - 1] - cycles[0];
      check(
        climb < CYCLE_LIMIT_MB,
        `${size}: ${CYCLES} rounds of open, pick ${4 + 4 + 3} looks, close: memory ${cycles.join(' → ')} MB (climb ${climb} < ${CYCLE_LIMIT_MB})`,
      );
      check(
        after.every((s) => s === second || s === 'builtin-bunny'),
        `${size}: after the rounds only the worn sheets stay decoded (${after.join(', ')})`,
      );
      const warm = (await page.evaluate('window.__agentTycoonTestHooks.warmState()')) as {
        bytes: number;
      };
      check(errors.length === 0, `${size}: no page errors (${errors.join(' | ')})`);
      results[size] = {
        office: m0,
        peopleTab: m1,
        picked: m2,
        closed: m3,
        grewMB: grew,
        natural,
        cyclesMB: cycles,
        zoomLruMB: Math.round(warm.bytes / 1048576),
      };
      console.log(JSON.stringify({ size, m0, m1, m2, m3, cycles }));
      await ctx.close();
    }
    const daemonPid = daemon.child.pid!;
    results.daemonRssMB = Math.round(rssMB(daemonPid));
    // a number for the report, no check: the daemon is as big without any sheet (scan, not thumbnails)
    console.log(`the daemon: ${results.daemonRssMB as number} MB RSS`);
    fs.writeFileSync(path.join(OUT, `${tag}results.json`), JSON.stringify(results, null, 1));
    console.log(failed ? `${failed} checks FAILED` : 'all checks passed');
  } finally {
    await browser.close();
    await daemon.stop();
    lead.kill();
    killFakeSessions(home);
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

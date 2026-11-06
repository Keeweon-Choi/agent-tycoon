/**
 * FIX-OFFICE-NAMEPLATE-FIXED (T-67, owner 11-06 22:26): resting agents' plates must hold still at every zoom,
 * and every plate is one fixed width (a long name ends in …). Temp HOME, one floor, the rest-crowd set
 * (run-office-rest-crowd.ts) plus one long name: off-duty engine projects rest in the lounge, two Claude
 * sessions work through it. dist/cli.js, headless Chromium without a GPU (and WebKit for the phone), no model.
 * Per screen style on the desktop (1600x1000): zoom all the way out about the lounge, then step in through every
 * zoom; at each, record every plate's rectangle and crowd state over FRAMES consecutive frames and fail when one
 * changes while its character's anchor did not move. Plates are checked for one width, the long name for its
 * ellipsis and its full name on hover. The phone (WebKit 390x844) gets the same frame check at its zoom.
 * Pictures in cld/artifacts/fix-office-nameplate-fixed/; a failed check exits 1.
 * MEASURE=1 prints instead the card width each screen style and 화면 크기 step needs for SAMPLE (Chromium and
 * WebKit, the larger, rounded up): the values of constants.ts NAMEPLATE_SIZES.*.card.
 *
 *   npx tsx cld/test/run-office-nameplate-fixed.ts <port 19270-19279>
 */
import type { Browser, Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  startDaemon,
  writeEngineProjects,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 19270 && port <= 19279)) throw new Error('port must be 19270-19279');
const OUT = path.resolve('cld/artifacts/fix-office-nameplate-fixed');
const PREFIX = process.env.PREFIX ?? '';
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;
const STORE: Record<string, string> = {
  'cld.title-scene': 'off',
  'cld.office-iso': 'on',
  'cld.floor': '1',
  'cld.floor-view': 'one',
  // No working day: every engine project is off duty (퇴근) and rests in the lounge.
  'cld.office-hours': JSON.stringify({ on: true, start: 540, end: 1080, days: [], lingerMin: 1 }),
};
const FRAMES = 90;
/** The owner's sample name (11-06 22:34): the card is as wide as it needs, and the rests as "휴식 1/2". */
const SAMPLE = '샘와이즈 깃지';
const SAMPLE_RESTS = '휴식 1/2';
const LONG = 'tycoon-admin-dashboard-backend-service';
const CREW = ['cld-gui', 'wayfinder'];
const REST_NAMES = ['neus', 'tycoon-admin', LONG, 'cex', 'pofol', 'atlas'];
const assistant = (content: object[]) => ({
  type: 'assistant',
  message: { model: 'claude-opus-4-7', content, usage: { input_tokens: 10, cache_read_input_tokens: 40_000, output_tokens: 200 } },
});

function session(home: string, n: number, name: string) {
  const cwd = `/work/${name}`;
  const proc = spawn('sleep', ['1800'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `b1106222-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 3_600_000, procStart, version: '2.1.306', kind: 'interactive', name, status: 'busy' }),
  );
  return { proc, file };
}

interface Frame {
  /** agent id -> plate rect + crowd state, and its character's anchor. */
  [id: string]: { plate: string; anchor: string; name: string; w: number; crowd: boolean };
}

/** FRAMES consecutive animation frames of every plate's box (rounded to 1/100 px). */
async function record(page: Page): Promise<Frame[]> {
  return page.evaluate(async (n) => {
    const f = (v: number) => v.toFixed(2);
    const frames: Frame[] = [];
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const frame: Frame = {};
      for (const box of document.querySelectorAll<HTMLElement>('[data-testid="agent-overlay"]')) {
        const id = box.dataset.agentId!;
        const plate = box.querySelector('[data-nameplate]');
        const anchor = document.querySelector(`[data-testid="status-icon-anchor"][data-agent-id="${id}"]`);
        if (!plate || !anchor) continue;
        const r = plate.getBoundingClientRect();
        const a = anchor.getBoundingClientRect();
        frame[id] = {
          plate: `${f(r.left)},${f(r.top)},${f(r.width)}x${f(r.height)}`,
          anchor: `${f(a.left)},${f(a.top)}`,
          name: box.querySelector('[data-testid="agent-name"]')?.textContent ?? '',
          w: r.width,
          crowd: box.hasAttribute('data-crowd'),
        };
      }
      frames.push(frame);
    }
    return frames;
  }, FRAMES);
}

/** Plates that changed between two frames while their character's anchor did not; counts the frames compared. */
function unstable(frames: Frame[]): { pairs: number; changes: string[]; still: number } {
  const changes: string[] = [];
  let pairs = 0;
  const still = new Set<string>();
  for (let i = 1; i < frames.length; i++) {
    for (const [id, now] of Object.entries(frames[i])) {
      const was = frames[i - 1][id];
      if (!was || was.anchor !== now.anchor) continue;
      pairs++;
      still.add(id);
      if (was.plate !== now.plate || was.crowd !== now.crowd)
        changes.push(`frame ${i} ${now.name}: ${was.plate}${was.crowd ? ' crowd' : ''} -> ${now.plate}${now.crowd ? ' crowd' : ''}`);
    }
  }
  return { pairs, changes, still: still.size };
}

async function lounge(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const pts = [...document.querySelectorAll('[data-testid="agent-overlay"][data-rest]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: (r.left + r.right) / 2, y: r.bottom };
    });
    const on = pts.filter((p) => p.x > 0 && p.y > 0 && p.x < innerWidth && p.y < innerHeight);
    if (!on.length) return null;
    return { x: on.reduce((a, p) => a + p.x, 0) / on.length, y: on.reduce((a, p) => a + p.y, 0) / on.length };
  });
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const crew = CREW.map((name, i) => ({ name, ...session(home, i + 1, name) }));
  writeEngineProjects(
    home,
    REST_NAMES.map((name) => {
      const folder = path.join(home, 'ws', name);
      fs.mkdirSync(folder, { recursive: true });
      return { name, folder };
    }),
  );
  const args = ['--no-terminal', '--allow-chat', '--engine', 'on', '--allow-actions'];
  const daemon = startDaemon({ home, claudePath }, port, args, {}, false);
  const browsers: Browser[] = [];
  const append = (file: string, r: object) => fs.appendFileSync(file, JSON.stringify(r) + '\n');
  let tick = 0;
  const driver = setInterval(() => {
    tick++;
    for (const c of crew) {
      const id = `tu-${c.name}-${Math.floor(tick / 2)}`;
      if (tick % 2 === 0) append(c.file, assistant([{ type: 'tool_use', id, name: 'Read', input: { file_path: '/work/a.ts' } }]));
      else append(c.file, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu-${c.name}-${Math.floor((tick - 1) / 2)}`, content: 'ok' }] } });
    }
  }, 1600);
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };
  let totalPairs = 0;
  let totalChanges = 0;
  try {
    const chromium = await launchBrowser({ partyFrame: true, officeHours: true });
    browsers.push(chromium);
    const ctx0 = await chromium.newContext();
    const lp = await ctx0.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await ctx0.cookies();
    await ctx0.close();
    const open = async (browser: Browser, theme: string, phone: boolean, settle = 30_000) => {
      const ctx = await browser.newContext({
        viewport: phone ? { width: 390, height: 844 } : { width: 1600, height: 1000 },
        deviceScaleFactor: phone ? 3 : 2,
        ...(phone ? { isMobile: true, hasTouch: true } : {}),
      });
      await ctx.addInitScript(INIT);
      await ctx.addInitScript(
        (pairs) => {
          for (const [k, v] of pairs)
            try {
              localStorage.setItem(k, v);
            } catch {
              // about:blank
            }
        },
        [...Object.entries(STORE), ['cld.ui-theme', theme]],
      );
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.getByTestId('office-canvas').waitFor({ timeout: 60_000 });
      await page.locator('[data-nameplate]').first().waitFor({ timeout: 60_000 });
      // Long enough for the off-duty ones to walk to the lounge and sit.
      await page.waitForTimeout(settle);
      return { ctx, page };
    };
    const frameCheck = async (page: Page, where: string) => {
      const frames = await record(page);
      const u = unstable(frames);
      totalPairs += u.pairs;
      totalChanges += u.changes.length;
      for (const c of u.changes.slice(0, 6)) console.log(`  ${c}`);
      check(u.changes.length === 0, `${where}: ${u.still} still plates, ${u.pairs} frame pairs, ${u.changes.length} changed`);
      const widths = new Set(Object.values(frames[frames.length - 1]).map((p) => p.w.toFixed(1)));
      check(widths.size === 1, `${where}: every plate one width (${[...widths].join(' / ')})`);
    };

    if (process.env.MEASURE) {
      const wk0 = await launchBrowser({ webkit: true, partyFrame: true, officeHours: true });
      browsers.push(wk0);
      const need: Record<string, number> = {};
      for (const [engine, b] of [['chromium', chromium], ['webkit', wk0]] as const)
        for (const theme of ['modern', 'pixel'] as const)
          for (const scale of ['small', 'medium', 'large'] as const) {
            STORE['cld.ui-scale'] = scale;
            const { ctx, page } = await open(b, theme, false, 8_000);
            const m = await page.evaluate(
              async ([sample, rests]) => {
                await document.fonts.ready;
                const plates = [...document.querySelectorAll<HTMLElement>('[data-nameplate]')];
                const withAll = plates.find((p) => p.querySelector('[data-testid="rank-icon"]') && p.querySelector('[data-testid="level-ring"]') && !p.closest('[data-crowd]'));
                const withBar = plates.find((p) => p.querySelector('[data-slim] [data-testid="compaction-text"]') && !p.closest('[data-crowd]'));
                if (!withAll || !withBar) return null;
                const name = withAll.querySelector<HTMLElement>('[data-testid="agent-name"]')!;
                const probe = name.cloneNode() as HTMLElement;
                probe.textContent = sample;
                probe.className = 'font-bold leading-tight whitespace-nowrap';
                probe.style.position = 'absolute';
                name.parentElement!.append(probe);
                const nameNeed = withAll.getBoundingClientRect().width - name.getBoundingClientRect().width + probe.getBoundingClientRect().width;
                probe.remove();
                const row = withBar.querySelector<HTMLElement>('[data-slim]')!;
                const col = row.parentElement!;
                const text = row.querySelector<HTMLElement>('[data-testid="compaction-text"]')!;
                const was = text.textContent;
                text.textContent = rests;
                row.style.width = 'max-content';
                const barNeed = withBar.getBoundingClientRect().width - col.getBoundingClientRect().width + row.getBoundingClientRect().width;
                row.style.width = '';
                text.textContent = was;
                return { nameNeed, barNeed };
              },
              [SAMPLE, SAMPLE_RESTS],
            );
            console.log(`${engine} ${theme} ${scale}: ${JSON.stringify(m)}`);
            if (m) need[`${theme} ${scale}`] = Math.max(need[`${theme} ${scale}`] ?? 0, Math.ceil(Math.max(m.nameNeed, m.barNeed)));
            await ctx.close();
          }
      console.log(`card widths: ${JSON.stringify(need)}`);
      return;
    }
    for (const theme of ['modern', 'pixel'] as const) {
      const { ctx, page } = await open(chromium, theme, false);
      const at = await lounge(page);
      check(!!at, `desktop ${theme}: resting plates on screen`);
      const wheel = async (dy: number) => {
        const p = (await lounge(page)) ?? at!;
        await page.mouse.move(p.x, p.y);
        await page.mouse.wheel(0, dy);
        await page.waitForTimeout(150);
      };
      for (let i = 0; i < 10; i++) await wheel(120); // all the way out
      let lastZoom = '';
      for (let step = 0; step < 12; step++) {
        await page.mouse.move(5, 500); // nothing hovered
        await page.waitForTimeout(1200);
        const zoom = await page.evaluate(() => localStorage.getItem('cld.camera') ?? '');
        await frameCheck(page, `desktop ${theme} step ${step}`);
        if (step === 2 || step === 5) {
          await page.screenshot({ path: path.join(OUT, `${PREFIX}desktop-${theme}-zoom-${step}.png`) });
          const p = step === 5 ? await page.locator('[data-nameplate]:has([data-name="neus"])').boundingBox() : null;
          if (p && p.x > 0 && p.y > 0 && p.x < 1600 && p.y < 1000)
            await page.screenshot({ path: path.join(OUT, `${PREFIX}desktop-${theme}-lounge.png`), clip: { x: Math.max(0, Math.min(1000, p.x - 300)), y: Math.max(0, Math.min(640, p.y - 160)), width: 600, height: 360 } });
        }
        if (zoom && zoom === lastZoom && step > 8) break;
        lastZoom = zoom;
        await wheel(-120);
      }
      // The long name: an ellipsis at rest; the pointer over its plate shows it whole in the same width,
      // and a click there selects its character (the plates take no pointer events: the canvas hit-tests them).
      for (let i = 0; i < 6; i++) await wheel(120); // back out to where the lounge is on screen
      await page.mouse.move(5, 500);
      await page.waitForTimeout(1200);
      const long = page.locator(`[data-testid="agent-name"][data-name="${LONG}"]`);
      if (await long.count()) {
        const cut = await long.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis');
        check(cut, `desktop ${theme}: the long name is cut with an ellipsis`);
        const title = await long.getAttribute('title');
        check(title === LONG, `desktop ${theme}: the long name's whole text is its title`);
        const plate = page.locator(`[data-nameplate]:has([data-name="${LONG}"])`);
        const before = await plate.boundingBox();
        await page.mouse.move(before!.x + before!.width / 2, before!.y + 4);
        await page.waitForTimeout(600);
        const hover = await long.evaluate((el) => ({
          whole: el.scrollWidth <= el.clientWidth + 1 && !el.hasAttribute('data-cut'),
          w: el.closest('[data-nameplate]')!.getBoundingClientRect().width,
          focus: el.closest('[data-nameplate]')!.hasAttribute('data-focus'),
        }));
        check(hover.focus && hover.whole, `desktop ${theme}: over its plate the long name shows whole`);
        check(Math.abs(hover.w - before!.width) < 0.5, `desktop ${theme}: and the plate keeps its width (${hover.w} / ${before!.width})`);
        await page.screenshot({ path: path.join(OUT, `${PREFIX}desktop-${theme}-hover.png`), clip: { x: Math.max(0, before!.x - 150), y: Math.max(0, before!.y - 120), width: 400, height: 260 } });
        await page.mouse.click(before!.x + before!.width / 2, before!.y + 4);
        await page.waitForTimeout(400);
        check(await plate.evaluate((el) => el.hasAttribute('data-selected')), `desktop ${theme}: a click on the plate selects its character`);
      } else check(false, `desktop ${theme}: the long name has a plate`);
      await ctx.close();
    }

    const wk = await launchBrowser({ webkit: true, partyFrame: true, officeHours: true });
    browsers.push(wk);
    for (const theme of ['modern', 'pixel'] as const) {
      const { ctx, page } = await open(wk, theme, true);
      await frameCheck(page, `phone ${theme}`);
      await page.screenshot({ path: path.join(OUT, `${PREFIX}phone-${theme}.png`) });
      await ctx.close();
    }
    console.log(`TOTAL: ${totalPairs} still frame pairs, ${totalChanges} changed`);
    if (failures.length) throw new Error(`${failures.length} check(s) failed:\n${failures.join('\n')}`);
  } finally {
    clearInterval(driver);
    for (const b of browsers) await b.close();
    await daemon.stop();
    for (const c of crew) c.proc.kill();
    killFakeSessions(home);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

/**
 * Base pictures for the HUD mockup (hud-v3): the office as it is today with eight fake agents in
 * mixed states, the HUD as it is today and with the HUD hidden, plus the HUD's parts cut out.
 * dist/cli.js in an isolated HOME on a spare port, headless Chromium without a GPU, no model: the
 * eight Claude sessions are files in the temp HOME (a `sleep` for the pid, a transcript each) that
 * this script keeps writing to. Pictures go to $OUT_DIR (not committed); next to them
 * layout.json lists every test-id'd element's box, for the inventory.
 *
 *   npx tsx agent-tycoon/test/capture-ui-hud-base.ts <port 18630-18639>
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18630 && port <= 18639)) throw new Error('port must be 18630-18639');
const OUT = process.env.OUT_DIR;
if (!OUT) throw new Error('OUT_DIR is required');

const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;
const STORE: Record<string, string> = {
  'agty.title-scene': 'off',
  'agty.office-iso': 'on',
  'agty.floor': '1',
  // This floor's inside (the whole-building view is shot on its own as now-pc-building.png).
  'agty.floor-view': 'one',
};

type Mode = 'work' | 'wait' | 'perm' | 'error' | 'rest';
/** [name, mode, context tokens (of the window the daemon assumes), the tools a working one cycles]. */
const CREW: Array<[string, Mode, number, string[]]> = [
  ['agent-tycoon', 'work', 62_000, ['Edit', 'Read', 'Bash']],
  ['pofol', 'work', 118_000, ['Read', 'Grep']],
  ['wayfinder', 'work', 31_000, ['Bash', 'Edit']],
  ['aixon', 'work', 154_000, ['Write', 'Read']],
  ['neus', 'wait', 88_000, []],
  ['smartglass', 'perm', 47_000, []],
  ['savetax', 'error', 171_000, []],
  ['keeweon', 'rest', 12_000, []],
];

const assistant = (content: object[], tokens: number) => ({
  type: 'assistant',
  message: {
    model: 'claude-opus-4-7',
    content,
    usage: { input_tokens: 10, cache_read_input_tokens: tokens, output_tokens: 200 },
  },
});

function session(home: string, n: number, name: string, mode: Mode) {
  const cwd = `/work/${name}`;
  const proc = spawn('sleep', ['1800'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `b1104000-0000-4000-8000-00000000000${n}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      cwd,
      startedAt: Date.now() - 3_600_000 - n * 600_000,
      procStart,
      version: '2.1.306',
      kind: 'interactive',
      name,
      status: mode === 'work' || mode === 'perm' ? 'busy' : 'idle',
    }),
  );
  return { proc, file };
}

const INPUTS: Record<string, object> = {
  Edit: { file_path: '/work/app/src/App.tsx', old_string: 'a', new_string: 'b' },
  Read: { file_path: '/work/app/src/main.ts' },
  Bash: { command: 'npm test' },
  Grep: { pattern: 'TODO' },
  Write: { file_path: '/work/app/notes.md', content: 'x' },
};

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(path.join(OUT, 'parts'), { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const crew = CREW.map(([name, mode, tokens, tools], i) => ({
    name,
    mode,
    tokens,
    tools,
    ...session(home, i + 1, name, mode),
  }));
  fs.writeFileSync(
    path.join(configDirectory(home), 'building.json'),
    JSON.stringify({
      version: 1,
      perProject: false,
      floors: [
        { id: '1', name: '1F', rooms: [], characters: [] },
        { id: '2', name: '2F', rooms: [], characters: [] },
        { id: '3', name: '3F', rooms: [], characters: [] },
      ],
    }),
  );
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal'], {});
  const browser = await launchBrowser({ partyFrame: true });
  const append = (file: string, r: object) => fs.appendFileSync(file, JSON.stringify(r) + '\n');
  let tick = 0;
  let driver: NodeJS.Timeout | undefined;
  try {
    // The scenes that stay: a question, an error that ended its turn, a rest. Written once the page
    // is up (a transcript that exists before the daemon watches it is only read, no timers run).
    const scene = () => {
    for (const c of crew) {
      if (c.mode === 'wait') {
        append(c.file, assistant([{ type: 'text', text: 'Should I also migrate the old settings?' }], c.tokens));
        append(c.file, { type: 'system', subtype: 'turn_duration', durationMs: 90_000 });
      } else if (c.mode === 'perm') {
        append(c.file, assistant([{ type: 'tool_use', id: 'tu-p', name: 'Bash', input: { command: 'rm -rf build && git push --force' } }], c.tokens));
      } else if (c.mode === 'error') {
        append(c.file, assistant([{ type: 'tool_use', id: 'tu-e', name: 'Bash', input: { command: 'npm run build' } }], c.tokens));
        append(c.file, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-e', is_error: true, content: 'Error: build failed' }] } });
        append(c.file, assistant([{ type: 'text', text: 'The build failed with 3 type errors. Stopping here.' }], c.tokens));
        append(c.file, { type: 'system', subtype: 'turn_duration', durationMs: 40_000 });
      } else if (c.mode === 'rest') {
        append(c.file, assistant([{ type: 'text', text: 'Done. All tests pass.' }], c.tokens));
        append(c.file, { type: 'system', subtype: 'turn_duration', durationMs: 20_000 });
      }
    }
    };
    // The workers keep a tool call open for 1.6 s, then answer it and start the next one.
    const startDriver = () => { driver = setInterval(() => {
      tick++;
      for (const c of crew.filter((x) => x.mode === 'work')) {
        const tool = c.tools[Math.floor(tick / 2) % c.tools.length];
        const id = `tu-${c.name}-${Math.floor(tick / 2)}`;
        if (tick % 2 === 0)
          append(c.file, assistant([{ type: 'tool_use', id, name: tool, input: INPUTS[tool] }], c.tokens));
        else
          append(c.file, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu-${c.name}-${Math.floor((tick - 1) / 2)}`, content: 'ok' }] } });
      }
    }, 1600); };

    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();

    let sceneDone = false;
    const open = async (viewport: { width: number; height: number }, phone: boolean) => {
      const ctx = await browser.newContext({
        viewport,
        deviceScaleFactor: phone ? 3 : 1,
        ...(phone ? { isMobile: true, hasTouch: true } : {}),
      });
      await ctx.addInitScript(INIT);
      await ctx.addInitScript(
        (pairs) => {
          // The camera's own default (launchBrowser pins 'off' for old runners, which also keeps the owner's character away).
          try {
            localStorage.removeItem('agty.camera-mode');
          } catch {
            // about:blank
          }
          for (const [k, v] of pairs)
            try {
              if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
            } catch {
              // about:blank
            }
        },
        Object.entries(STORE),
      );
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.getByTestId('office-canvas').waitFor({ timeout: 60_000 });
      await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 60_000 });
      if (!sceneDone) {
        sceneDone = true;
        scene();
        startDriver();
      }
      // Eight characters, the permission bubble (7 s heuristic) and the walking in settle.
      for (const c of crew) {
        await page
          .locator(`[data-testid="agent-name"][data-name="${c.name}"]`)
          .first()
          .waitFor({ timeout: 60_000 })
          .catch(() => console.log(`no nameplate for ${c.name}`));
      }
      await page.waitForTimeout(12_000);
      return { ctx, page };
    };

    const shot = (page: import('@playwright/test').Page, name: string) =>
      page.screenshot({ path: path.join(OUT, name) });

    /** Hides every element but the canvas (and what holds it); `keep` leaves matching ones in. */
    const cleanUp = (page: import('@playwright/test').Page, keep: string | null) =>
      page.evaluate((keepSel) => {
        document.querySelector('#clean-style')?.remove();
        document.querySelectorAll('[data-keep]').forEach((e) => e.removeAttribute('data-keep'));
        const canvas = document.querySelector('[data-testid="office-canvas"]');
        for (let e = canvas?.parentElement; e; e = e.parentElement) e.setAttribute('data-keep', '');
        const style = document.createElement('style');
        style.id = 'clean-style';
        style.textContent = `body *:not([data-keep]):not([data-testid="office-canvas"])${keepSel ? `:not(${keepSel}):not(${keepSel} *)` : ''} { visibility: hidden !important; }`;
        document.head.append(style);
      }, keep);
    const dirty = (page: import('@playwright/test').Page) =>
      page.evaluate(() => {
        document.querySelector('#clean-style')?.remove();
      });

    // ── PC 1600x1000 ──────────────────────────────────────────────
    const pc = await open({ width: 1600, height: 1000 }, false);
    const page = pc.page;
    await page.evaluate(() => localStorage.setItem('agty.floor-view', 'all'));
    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(8000);
    await shot(page, 'now-pc-building.png');
    await page.evaluate(() => localStorage.setItem('agty.floor-view', 'one'));
    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(8000);
    await shot(page, 'now-pc.png');
    // Every test-id'd element's box, and the other fixed/absolute roots, for the inventory.
    const layout = await page.evaluate(() => {
      const rows: Array<Record<string, unknown>> = [];
      for (const e of Array.from(document.querySelectorAll('[data-testid],[data-hud-id],[data-hud-window]'))) {
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        rows.push({
          testid: e.getAttribute('data-testid'),
          hud: e.getAttribute('data-hud-id') ?? e.getAttribute('data-hud-window'),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          text: (e.textContent ?? '').trim().slice(0, 60),
        });
      }
      return rows;
    });
    fs.writeFileSync(path.join(OUT, 'parts', 'layout-pc.json'), JSON.stringify(layout, null, 1));

    // Parts: 1x and 2x, element by element (what is missing is logged, not fatal).
    const PARTS: Array<[string, string, boolean]> = [
      ['party-bar', '[data-testid="card-container"]', false],
      ['party-portraits', '[data-testid="agent-card"][data-portrait]', true],
      ['top-bar', '[data-hud-id="usage"]', false],
      ['top-bar-right', '[data-testid="hud-jobs"], [data-testid="hud-menu"]', true],
      ['floor-buttons', '[data-hud-id="floors"]', false],
      ['side-icons', '[data-hud-id^="icon:"]', true],
      ['update-notice', '[data-testid="update-notice"]', false],
      ['lobby-board', '[data-testid="lobby-board"]', false],
    ];
    const partShots = async (pg: import('@playwright/test').Page, prefix: string, sel: string, name: string, union = false) => {
      const loc = pg.locator(sel);
      const n = await loc.count();
      if (!n) return console.log(`part missing: ${name} (${sel})`);
      let box: { x: number; y: number; width: number; height: number } | null;
      if (union) {
        const boxes = (await Promise.all(Array.from({ length: n }, (_, i) => loc.nth(i).boundingBox()))).filter(Boolean) as Array<{ x: number; y: number; width: number; height: number }>;
        const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
        const x1 = Math.max(...boxes.map((b) => b.x + b.width)), y1 = Math.max(...boxes.map((b) => b.y + b.height));
        box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      } else box = await loc.first().boundingBox();
      if (!box) return;
      const clip = { x: Math.max(0, box.x - 4), y: Math.max(0, box.y - 4), width: box.width + 8, height: box.height + 8 };
      const one = await pg.screenshot({ path: path.join(OUT, 'parts', `${prefix}${name}-1x.png`), clip });
      // 2x for the desktop (a device-pixel-1 page): nearest neighbour, the pixel art stays sharp.
      // ponytail: the phone's parts are already 3 device pixels per CSS pixel, so they get no 2x.
      if (prefix === 'pc-') {
        const src = PNG.sync.read(one);
        const big = new PNG({ width: src.width * 2, height: src.height * 2 });
        for (let y = 0; y < big.height; y++)
          for (let x = 0; x < big.width; x++) {
            const si = ((y >> 1) * src.width + (x >> 1)) << 2;
            big.data.set(src.data.subarray(si, si + 4), (y * big.width + x) << 2);
          }
        fs.writeFileSync(path.join(OUT, 'parts', `${prefix}${name}-2x.png`), PNG.sync.write(big));
      }
      console.log(`part ${prefix}${name}: ${Math.round(box.width)}x${Math.round(box.height)} at ${Math.round(box.x)},${Math.round(box.y)}`);
    };
    for (const [name, sel, union] of PARTS) await partShots(page, 'pc-', sel, name, union);

    // The figure sits below its plate: step the pointer down until the plate opens its details.
    const FOCUS = (n: string) => `[data-testid="agent-overlay"]:has([data-name="${n}"]) [data-focus]`;
    const find = async (pg: import('@playwright/test').Page, name: string) => {
      const b = (await pg.locator(`[data-testid="agent-overlay"]:has([data-name="${name}"])`).first().boundingBox())!;
      for (const dy of [18, 12, 24, 6, 30, 38, 46, 56]) {
        const at = { x: b.x + b.width / 2, y: b.y + b.height + dy };
        await pg.mouse.move(5, 500);
        await pg.mouse.move(at.x, at.y);
        await pg.waitForTimeout(400);
        if (await pg.locator(FOCUS(name)).count()) return at;
      }
      console.log(`no hover target for ${name}`);
      return { x: b.x + b.width / 2, y: b.y + b.height + 18 };
    };
    const target = await find(page, 'agent-tycoon');
    await page.mouse.move(target.x, target.y);
    await page.waitForTimeout(800);
    await shot(page, 'now-pc-hover.png');
    // Selected: a click.
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(1200);
    await shot(page, 'now-pc-selected.png');
    const popup = page.locator('[data-testid="agent-overlay"]', { has: page.locator('[data-testid="agent-details"]') }).first();
    if (await popup.count()) {
      const b = await popup.boundingBox();
      console.log(`popup ${JSON.stringify(b)}`);
      await partShots(page, 'pc-', '[data-testid="agent-overlay"]:has([data-testid="agent-details"])', 'staff-popup');
      await partShots(page, 'pc-', '[data-testid="agent-overlay"]:has([data-testid="agent-details"]) [data-nameplate]', 'staff-popup-plate');
      await partShots(page, 'pc-', '[role="menu"][aria-label]', 'staff-menu');
    } else console.log('no popup after the click');
    fs.writeFileSync(
      path.join(OUT, 'parts', 'popup-text.json'),
      JSON.stringify(
        await page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-testid="agent-overlay"]')).map((e) => ({
            name: e.querySelector('[data-testid="agent-name"]')?.textContent,
            focus: !!e.querySelector('[data-focus]'),
            text: (e as HTMLElement).innerText.replace(/\n+/g, ' | '),
          })),
        ),
        null,
        1,
      ),
    );
    // The floating HUD as the selected state leaves it (the layout again: what the click opened).
    fs.writeFileSync(
      path.join(OUT, 'parts', 'layout-pc-selected.json'),
      JSON.stringify(
        await page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-testid],[data-hud-id],[data-hud-window]'))
            .map((e) => {
              const r = e.getBoundingClientRect();
              return { testid: e.getAttribute('data-testid'), hud: e.getAttribute('data-hud-id') ?? e.getAttribute('data-hud-window'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: (e.textContent ?? '').trim().slice(0, 80) };
            })
            .filter((r) => r.w && r.h),
        ),
        null,
        1,
      ),
    );

    // Clean: canvas only; plates and bubbles are DOM, so the labels-off picture is the same one.
    await page.mouse.click(5, 500); // deselect
    await page.mouse.move(5, 500);
    await page.waitForTimeout(800);
    await cleanUp(page, '[data-testid="agent-overlay"], [data-testid="agent-bubble"], [data-testid="status-icon-anchor"]');
    await page.waitForTimeout(300);
    await shot(page, 'clean-pc-plates.png');
    await cleanUp(page, null);
    await page.waitForTimeout(300);
    await shot(page, 'clean-pc.png');
    await shot(page, 'clean-pc-nolabels.png');
    await dirty(page);
    await pc.ctx.close();

    // ── PC 1024x700 ───────────────────────────────────────────────
    const compact = await open({ width: 1024, height: 700 }, false);
    await shot(compact.page, 'now-pc-compact.png');
    await cleanUp(compact.page, null);
    await compact.page.waitForTimeout(300);
    await shot(compact.page, 'clean-pc-compact.png');
    await shot(compact.page, 'clean-pc-compact-nolabels.png');
    await compact.ctx.close();

    // ── Phone 390x844 dpr 3 ───────────────────────────────────────
    const ph = await open({ width: 390, height: 844 }, true);
    const pp = ph.page;
    await shot(pp, 'now-phone.png');
    fs.writeFileSync(
      path.join(OUT, 'parts', 'layout-phone.json'),
      JSON.stringify(
        await pp.evaluate(() =>
          Array.from(document.querySelectorAll('[data-testid],[data-hud-id],[data-hud-window]'))
            .map((e) => {
              const r = e.getBoundingClientRect();
              return { testid: e.getAttribute('data-testid'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: (e.textContent ?? '').trim().slice(0, 80) };
            })
            .filter((r) => r.w && r.h),
        ),
        null,
        1,
      ),
    );
    for (const [name, sel] of [
      ['top-bar', '[data-testid="mobile-top-bar"]'],
      ['dock', '[data-testid="mobile-dock"]'],
      ['agent-bar', '[data-testid="mobile-agent-bar"]'],
    ]) await partShots(pp, 'phone-', sel, name);
    // A tap on the first figure whose plate is on screen opens the phone's card (its menu row).
    let tapped = '';
    for (const c of crew) {
      if (tapped) break;
      const box = await pp.locator(`[data-testid="agent-overlay"]:has([data-name="${c.name}"])`).first().boundingBox();
      if (!box || box.y < 150 || box.y + box.height > 700 || box.x < 0 || box.x + box.width > 390) continue;
      for (const dy of [18, 30, 42, 10, 54]) {
        await pp.touchscreen.tap(box.x + box.width / 2, box.y + box.height + dy);
        await pp.waitForTimeout(900);
        if (await pp.locator('[data-testid="inspector"][data-sheet]').count()) {
          tapped = c.name;
          break;
        }
      }
    }
    console.log(`phone card opened for: ${tapped || 'nobody'}`);
    await pp.waitForTimeout(800);
    await shot(pp, 'now-phone-selected.png');
    await partShots(pp, 'phone-', '[data-testid="inspector"][data-sheet]', 'staff-popup'); // the member sheet (FEAT-PARTY-V2)
    await pp.touchscreen.tap(195, 600);
    await pp.waitForTimeout(500);
    await cleanUp(pp, null);
    await pp.waitForTimeout(300);
    await shot(pp, 'clean-phone.png');
    await shot(pp, 'clean-phone-nolabels.png');
    await ph.ctx.close();
  } finally {
    if (driver) clearInterval(driver);
    await browser.close();
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

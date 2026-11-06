/**
 * FIX-OFFICE-REST-CROWD (owner 11-06 21:10): many off-duty agents rest on one sofa set; their plates, 퇴근 and 야근
 * badges must not pile on each other or on a working agent's plate. Temp HOME, one floor: ten stopped engine
 * projects (office hours with no working day, so they are off duty and go to the lounge) and two Claude
 * sessions working through it (야근). dist/cli.js (CLI=another build's cli.js for a baseline), headless Chromium
 * without a GPU, no model. In both screen styles, on the desktop (1600x1000) and the phone (390x844): no two
 * visible plates, badges (퇴근, 야근) or rest bubbles overlap by more than a border, a plate or a feet badge
 * row hidden by the crowd pass is not counted as visible, and the working agents' plates are never hidden.
 * Pictures in cld/artifacts/fix-office-rest-crowd/<PREFIX>-*.png; a failed check exits 1.
 *
 *   PREFIX=after npx tsx cld/test/run-office-rest-crowd.ts <port 19190-19199>
 */
import type { Page } from '@playwright/test';
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
if (!(port >= 19190 && port <= 19199)) throw new Error('port must be 19190-19199');
const PREFIX = process.env.PREFIX ?? 'after';
const OUT = path.resolve('cld/artifacts/fix-office-rest-crowd');
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;
const STORE: Record<string, string> = {
  'cld.title-scene': 'off',
  'cld.office-iso': 'on',
  'cld.floor': '1',
  'cld.floor-view': 'one',
  // No working day: every orchestrator is off duty (퇴근) and rests in the lounge, whatever the clock says.
  'cld.office-hours': JSON.stringify({ on: true, start: 540, end: 1080, days: [], lingerMin: 1 }),
};

type Mode = 'work' | 'rest';
const CREW: Array<[string, Mode]> = [
  ['cld-gui', 'work'],
  ['wayfinder', 'work'],
];
const REST_NAMES = ['cex', 'neus', 'tycoon-admin', 'pofol', 'atlas', 'borealis', 'cinder', 'delta', 'ember', 'fjord'];
const assistant = (content: object[]) => ({
  type: 'assistant',
  message: { model: 'claude-opus-4-7', content, usage: { input_tokens: 10, cache_read_input_tokens: 40_000, output_tokens: 200 } },
});

function session(home: string, n: number, name: string, mode: Mode) {
  const cwd = `/work/${name}`;
  const proc = spawn('sleep', ['1800'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `b1106210-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 3_600_000, procStart, version: '2.1.306', kind: 'interactive', name, status: mode === 'work' ? 'busy' : 'idle' }),
  );
  return { proc, file };
}

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
  what: string;
}
/** Every visible plate, 퇴근/야근/OFF badge and rest bubble on screen, with its box. */
async function visibleBoxes(page: Page): Promise<{ boxes: Box[]; hiddenWorking: string[]; plates: number; crowded: number }> {
  return page.evaluate(() => {
    const boxes: Box[] = [];
    const rect = (el: Element, what: string) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width <= 0 || r.height <= 0 || cs.display === 'none' || cs.visibility === 'hidden') return;
      boxes.push({ l: r.left, t: r.top, r: r.right, b: r.bottom, what });
    };
    for (const el of document.querySelectorAll('[data-nameplate]'))
      rect(el, `plate ${el.getAttribute('data-agent-id')} ${el.querySelector('[data-testid="agent-name"]')?.textContent ?? ''}`);
    for (const el of document.querySelectorAll('[data-testid="feet-badges"] > *')) rect(el, `feet ${el.closest('[data-agent-id]')?.getAttribute('data-agent-id')} ${el.textContent}`);
    for (const el of document.querySelectorAll('[data-testid="office-badges"] > *')) rect(el, `office ${el.textContent}`);
    for (const el of document.querySelectorAll('[data-testid="rest-bubble"]')) rect(el, 'rest-bubble');
    const hiddenWorking = [...document.querySelectorAll('[data-testid="agent-overlay"][data-crowd]:not([data-rest])')].map((e) => e.getAttribute('data-agent-id') ?? '');
    return {
      boxes,
      hiddenWorking,
      plates: document.querySelectorAll('[data-nameplate]').length,
      crowded: document.querySelectorAll('[data-testid="agent-overlay"][data-crowd]').length,
    };
  });
}

const SLOP = 4;
function overlapPairs(boxes: Box[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.l + SLOP < b.r && b.l + SLOP < a.r && a.t + SLOP < b.b && b.t + SLOP < a.b) out.push(`${a.what} x ${b.what}`);
    }
  return out;
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const crew = CREW.map(([name, mode], i) => ({ name, mode, ...session(home, i + 1, name, mode) }));
  const projects = REST_NAMES.map((name) => {
    const folder = path.join(home, 'ws', name);
    fs.mkdirSync(folder, { recursive: true });
    return { name, folder };
  });
  writeEngineProjects(home, projects);
  const cli = process.env.CLI ? path.resolve(process.env.CLI) : undefined;
  const args = ['--no-terminal', '--allow-chat', '--engine', 'on', '--allow-actions'];
  const daemon = startDaemon({ home, claudePath }, port, args, {}, false, ...(cli ? [cli] : []));
  const browser = await launchBrowser({ partyFrame: true, officeHours: true });
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
  try {
    const ctx0 = await browser.newContext();
    const lp = await ctx0.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await ctx0.cookies();
    await ctx0.close();
    for (const device of ['desktop', 'phone'] as const) {
      for (const theme of ['modern', 'pixel'] as const) {
        const phone = device === 'phone';
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
        // Long enough for the off-duty ones to walk to the lounge and sit, and for the crowd pass to settle.
        await page.waitForTimeout(30_000);
        const where = `${device} ${theme}`;
        await page.screenshot({ path: path.join(OUT, `${PREFIX}-${device}-${theme}.png`) });
        const seen = await visibleBoxes(page);
        const pairs = overlapPairs(seen.boxes);
        console.log(`${where}: ${seen.plates} plates, ${seen.crowded} crowded, ${seen.boxes.length} visible boxes`);
        for (const p of pairs) console.log(`  overlap: ${p}`);
        check(seen.plates >= 10, `${where}: the ten resting agents have plates (${seen.plates})`);
        check(pairs.length === 0, `${where}: no two visible plates or badges overlap (${pairs.length})`);
        check(seen.hiddenWorking.length === 0, `${where}: no working plate is crowded`);
        // Status-icon anchors: no two characters drawn at one point.
        const anchors = await page.$$eval('[data-testid="status-icon-anchor"]', (els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return `${Math.round(r.left / 2)},${Math.round(r.top / 2)}`;
          }),
        );
        check(new Set(anchors).size === anchors.length, `${where}: no two status icons at one point`);
        await ctx.close();
      }
    }
    if (failures.length) throw new Error(`${failures.length} check(s) failed:\n${failures.join('\n')}`);
  } finally {
    clearInterval(driver);
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

/**
 * FIX-OFFICE-STALE-PLATES (owner 11-06 20:34): no plate or badge where no character is drawn, and every
 * plate on its character. A three-floor building in a temp HOME: two Claude sessions working on 1F, one
 * on 2F (building.json), one idle, and two stopped engine projects (OFF); office hours with no working
 * day, so the orchestrators are off duty and rest in the lounge (퇴근), the case of the owner's picture.
 * dist/cli.js (CLI=another build's cli.js for a baseline) on a spare port, headless Chromium without a
 * GPU, no model. Checks, in both screen styles: a hover just under each shown plate's head point selects
 * that same character (so it is drawn where its plate is); 2F's agent has no plate on 1F and has one on
 * 2F after the elevator; the same after a daemon restart. Pictures in
 * agent-tycoon/artifacts/fix-office-stale-plates/<PREFIX>-*.png; a failed check exits 1.
 *
 *   PREFIX=after npx tsx agent-tycoon/test/run-office-stale-plates.ts <port 19190-19199>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  startDaemon,
  writeEngineProjects,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 19190 && port <= 19199)) throw new Error('port must be 19190-19199');
const PREFIX = process.env.PREFIX ?? 'after';
const OUT = path.resolve('agent-tycoon/artifacts/fix-office-stale-plates');
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;
const STORE: Record<string, string> = {
  'agty.title-scene': 'off',
  'agty.office-iso': 'on',
  'agty.floor': '1',
  'agty.floor-view': 'one',
  // No working day: every orchestrator is off duty (퇴근) and rests in the lounge, whatever the clock says.
  'agty.office-hours': JSON.stringify({ on: true, start: 540, end: 1080, days: [], lingerMin: 1 }),
};

type Mode = 'work' | 'rest';
const CREW: Array<[string, Mode]> = [
  ['agent-tycoon', 'work'],
  ['harvester', 'work'],
  ['pearl', 'work'], // on 2F
  ['iris', 'rest'],
];
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
  const sessionId = `b1106200-0000-4000-8000-${String(n).padStart(12, '0')}`;
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

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const crew = CREW.map(([name, mode], i) => ({ name, mode, ...session(home, i + 1, name, mode) }));
  fs.writeFileSync(
    path.join(configDirectory(home), 'building.json'),
    JSON.stringify({
      version: 1,
      perProject: false,
      floors: ['1', '2', '3'].map((id) => ({ id, name: `${id}F`, rooms: [], characters: id === '2' ? ['pearl'] : [] })),
    }),
  );
  const projects = ['studio-admin', 'fox'].map((name) => {
    const folder = path.join(home, 'ws', name);
    fs.mkdirSync(folder, { recursive: true });
    return { name, folder };
  });
  writeEngineProjects(home, projects);
  const cli = process.env.CLI ? path.resolve(process.env.CLI) : undefined;
  const args = ['--no-terminal', '--allow-chat', '--engine', 'on', '--allow-actions'];
  const start = () => startDaemon({ home, claudePath }, port, args, {}, false, ...(cli ? [cli] : []));
  let daemon = start();
  const browser = await launchBrowser({ partyFrame: true, officeHours: true });
  const append = (file: string, r: object) => fs.appendFileSync(file, JSON.stringify(r) + '\n');
  let tick = 0;
  const driver = setInterval(() => {
    tick++;
    for (const c of crew.filter((x) => x.mode === 'work')) {
      const id = `tu-${c.name}-${Math.floor(tick / 2)}`;
      if (tick % 2 === 0) append(c.file, assistant([{ type: 'tool_use', id, name: 'Read', input: { file_path: '/work/a.ts' } }]));
      else append(c.file, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu-${c.name}-${Math.floor((tick - 1) / 2)}`, content: 'ok' }] } });
    }
  }, 1600);
  for (const c of crew.filter((x) => x.mode === 'rest')) {
    append(c.file, assistant([{ type: 'text', text: 'Done.' }]));
    append(c.file, { type: 'system', subtype: 'turn_duration', durationMs: 20_000 });
  }
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    const login = async () => {
      const ctx = await browser.newContext();
      const lp = await ctx.newPage();
      await lp.goto(await daemon.loginUrl());
      await lp.waitForURL(`http://127.0.0.1:${port}/`);
      const cookies = await ctx.cookies();
      await ctx.close();
      return cookies;
    };
    const open = async (theme: 'modern' | 'pixel') => {
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
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
        [...Object.entries(STORE), ['agty.ui-theme', theme]],
      );
      await ctx.addCookies(await login());
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.getByTestId('office-canvas').waitFor({ timeout: 60_000 });
      await page.locator('[data-nameplate]').first().waitFor({ timeout: 60_000 });
      // Long enough for the off-duty ones to walk to the lounge and sit.
      await page.waitForTimeout(25_000);
      return { ctx, page };
    };
    /** Each shown plate: a hover just under its head point must select that same character. */
    const platesOnFigures = async (page: Page, where: string) => {
      const plates = await page.$$eval('[data-nameplate]', (els) =>
        els
          .filter((el) => el.getBoundingClientRect().width > 0)
          .map((el) => ({ id: el.getAttribute('data-agent-id')!, name: el.querySelector('[data-testid="agent-name"]')?.textContent ?? '' })),
      );
      const feet = await page.locator('[data-testid="feet-badges"]').count();
      console.log(`${where}: plates ${plates.map((p) => p.name).join(', ')}; feet badges ${feet}`);
      for (const p of plates) {
        const head = await page.locator(`[data-testid="status-icon-anchor"][data-agent-id="${p.id}"]`).boundingBox();
        let hit = false;
        for (const dy of [10, 18, 26, 34, 42, 6]) {
          if (!head) break;
          await page.mouse.move(head.x + 1, head.y + dy);
          await page.waitForTimeout(250);
          if (await page.locator(`[data-nameplate][data-agent-id="${p.id}"][data-focus]`).count()) {
            hit = true;
            break;
          }
        }
        check(hit, `${where}: ${p.name}'s plate sits on its drawn character`);
      }
      await page.mouse.move(5, 500);
      return plates;
    };
    const hasPlate = (plates: Array<{ name: string }>, name: string) => plates.some((p) => p.name === name);

    for (const theme of ['modern', 'pixel'] as const) {
      const { ctx, page } = await open(theme);
      await page.screenshot({ path: path.join(OUT, `${PREFIX}-${theme}-1f.png`) });
      const first = await platesOnFigures(page, `${theme} 1F`);
      check(!hasPlate(first, 'pearl'), `${theme} 1F: no plate for pearl (on 2F)`);
      await page.getByTestId('elevator-up').click();
      await page.waitForTimeout(3000);
      await page.screenshot({ path: path.join(OUT, `${PREFIX}-${theme}-2f.png`) });
      const second = await platesOnFigures(page, `${theme} 2F`);
      check(hasPlate(second, 'pearl'), `${theme} 2F: pearl's plate`);
      check(!second.some((p) => hasPlate(first, p.name)), `${theme} 2F: none of 1F's plates`);
      await page.getByTestId('elevator-down').click();
      await page.waitForTimeout(3000);
      await page.screenshot({ path: path.join(OUT, `${PREFIX}-${theme}-1f-back.png`) });
      await ctx.close();
    }
    // A daemon restart with the off ones: the page reloads onto the same office.
    await daemon.stop();
    daemon = start();
    const { ctx, page } = await open('modern');
    await page.screenshot({ path: path.join(OUT, `${PREFIX}-modern-1f-restart.png`) });
    await platesOnFigures(page, 'after restart 1F');
    await ctx.close();
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

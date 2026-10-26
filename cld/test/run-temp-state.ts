/**
 * TEMP-STATE check: dist/cli.js with an isolated HOME on a spare port, headless Chromium (no GPU),
 * desktop 1280x800, one floor shown at a time, a building of two floors. Fake sessions only (a
 * `sleep` with a transcript we write), no model is ever called. Linger time 600 min: a finished
 * sub-agent rests in the lounge for the whole run.
 *
 * - wave 1: `lead` spawns two foreground sub-agents and a background one (its own transcript,
 *   with usage); all finish and rest: each keeps its roster name, the background one its 피로도;
 * - wave 2: two new spawns take the two longest idle employees: those two resting characters walk
 *   out (one person, one character), named; the background one rests on, named, with 피로도;
 * - 🤝 dots: to the working and the resting ones, none to one walking out or gone; the lead moves to floor 2:
 *   no dots run from it to a sub-agent on floor 1;
 * - a daemon restart and a page reload: the background sub-agent (recovered next to its lead on
 *   floor 2) still named, its 피로도 known, dots to it; after it finishes too.
 * Screenshots go to cld/artifacts/temp-state/.
 *
 *   npx tsx cld/test/run-temp-state.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { STAFF_NAMES } from '../../core/src/cld/staffNames.js';
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
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/temp-state');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__ts/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 420_000;

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[], usage?: Rec): Rec => ({
  type: 'assistant',
  message: { model: 'claude-opus-4-5', content, ...(usage && { usage }) },
});
const userResult = (id: string, text: string): Rec => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const sub = (parent: string, msg: Rec): Rec => ({
  type: 'progress',
  parentToolUseID: parent,
  data: { type: 'agent_progress', message: msg },
});
const usage = (cached: number): Rec => ({
  input_tokens: 10,
  cache_creation_input_tokens: 20_000,
  cache_read_input_tokens: cached,
  output_tokens: 500,
});
const done = (agent: string, tool: string): Rec => ({
  type: 'queue-operation',
  operation: 'enqueue',
  content: `<task-notification><task-id>${agent}</task-id><tool-use-id>${tool}</tool-use-id><status>completed</status></task-notification>`,
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: string[] = [];
/** REPRO=1: report a failed check and go on (the run before the fix shows every symptom). */
function check(ok: unknown, what: string): void {
  if (!ok && process.env.REPRO) return void console.log(`FAIL - ${what}`);
  if (!ok) throw new Error(`check failed: ${what}`);
  results.push(what);
  console.log(`ok - ${what}`);
}
async function until(what: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(250)) if (await fn()) return;
  throw new Error(`timed out: ${what}`);
}

const rosterNames = new Set(STAFF_NAMES.flatMap((n) => [n.ko, n.en]));
const isRosterName = (name: string) => rosterNames.has(name.replace(/ \d+$/, ''));

interface Temp {
  id: number;
  phase: string;
  row: number;
  name: string | null;
  fatigue: 'bar' | 'unknown' | 'none';
}
type FloorRect = { id: string; row: number; rows: number };

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  fs.writeFileSync(
    path.join(configDirectory(home), 'building.json'),
    JSON.stringify({
      version: 1,
      perProject: false,
      floors: [
        { id: '1', name: '1층', rooms: [], characters: [] },
        { id: '2', name: '2층', rooms: [], characters: [] },
      ],
    }),
  );
  // The lead: a live Claude Code session (a `sleep` of ours) in /work/alpha.
  const cwd = '/work/alpha';
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c1024230-0000-4000-8000-000000000001';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  const subDir = path.join(projectDir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(transcript, '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 600_000, procStart, version: '2.1.306', kind: 'interactive', name: 'lead', status: 'busy' }),
  );
  const append = (records: Rec[], file = transcript) => {
    for (const r of records) fs.appendFileSync(file, JSON.stringify(r) + '\n');
  };
  /** A background sub-agent's own transcript (meta + jsonl); `finish` marks its meta as Claude does. */
  const bgAgent = (agent: string, tool: string, description: string) => {
    const meta = (finished?: true) =>
      fs.writeFileSync(
        path.join(subDir, `agent-${agent}.meta.json`),
        JSON.stringify({ agentType: 'general-purpose', description, toolUseId: tool, finished }),
      );
    fs.writeFileSync(path.join(subDir, `agent-${agent}.jsonl`), '');
    meta();
    return { file: path.join(subDir, `agent-${agent}.jsonl`), finish: () => meta(true) };
  };

  const launch = () => startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on'], {});
  let daemon = launch();
  const browser = await launchBrowser();
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  const pageErrors: string[] = [];
  const received: Rec[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(
      `globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;
       try { localStorage.setItem('cld.office-hours', '{"on":false,"lingerMin":600}');
             localStorage.setItem('cld.floor-view', 'one'); localStorage.setItem('cld.floor', '1'); } catch {}`,
    );
    const font = fs.readFileSync(FONT);
    await ctx.route('**/__ts/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('websocket', (ws) =>
      ws.on('framereceived', (f) => {
        try {
          received.push(JSON.parse(String(f.payload)) as Rec);
        } catch {
          /* binary */
        }
      }),
    );
    const login = async () => {
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(BASE);
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    };
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const floors = (): FloorRect[] =>
      (([...received].reverse().find((m) => m.type === 'layoutLoaded') as { layout?: { cldFloors?: FloorRect[] } })
        ?.layout?.cldFloors ?? []);
    const floorOf = (row: number) => floors().findIndex((r) => row >= r.row && row < r.row + r.rows);
    const leadId = async (): Promise<number> =>
      page.$$eval('[data-testid="agent-overlay"]', (ns) => {
        const n = ns.find((x) => x.querySelector('[data-testid="agent-name"]')?.textContent === 'lead');
        return n ? Number(n.getAttribute('data-agent-id')) : 0;
      });
    const temps = async (): Promise<Temp[]> =>
      page.evaluate(() => {
        const staff = (Reflect.get(window, '__cldStaff') ?? []) as Array<{ id: number; phase?: string; at: number[] }>;
        return staff
          .filter((s) => s.phase)
          .map((s) => {
            const n = document.querySelector(`[data-testid="agent-overlay"][data-agent-id="${s.id}"]`);
            return {
              id: s.id,
              phase: s.phase!,
              row: s.at[1],
              name: n?.querySelector('[data-testid="agent-name"]')?.textContent ?? null,
              fatigue: n?.querySelector('[data-testid="fatigue"]')
                ? ('bar' as const)
                : n?.querySelector('[data-testid="fatigue-unknown"]')
                  ? ('unknown' as const)
                  : ('none' as const),
            };
          });
      });
    /** lead>sub links drawn in the last half second. */
    const links = async (): Promise<Array<[number, number]>> =>
      page.evaluate(() => {
        const l = (Reflect.get(window, '__cldLinks') ?? {}) as Record<string, number>;
        const now = performance.now();
        return Object.entries(l)
          .filter(([, at]) => now - at < 500)
          .map(([k]) => k.split('>').map(Number) as [number, number]);
      });
    const roster = () => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(configDirectory(home), 'roster.json'), 'utf-8'));
        return Object.values(r.projects as Record<string, { employees: Array<{ nameId: string; execution: string | null }>; executions: Record<string, { ended: number | null; endedBy?: string }> }>).map((p) => ({
          employees: p.employees.map((e) => `${e.nameId}:${e.execution}`),
          executions: Object.entries(p.executions).map(([k, b]) => `${k}:${b.ended === null ? 'open' : b.endedBy}`),
        }));
      } catch {
        return null;
      }
    };
    const describe = async () =>
      JSON.stringify({
        temps: await temps(),
        links: await links(),
        roster: roster(),
        wire: process.env.REPRO
          ? received.filter((m) => m.type === 'tempStaff' || String(m.type).startsWith('subagent') || m.type === 'agentToolStart' || m.type === 'existingAgents').slice(-12)
          : undefined,
      });
    const allNamed = (ts: Temp[]) => ts.every((t) => t.name !== null && isRosterName(t.name));

    await login();
    await until('the lead is in', async () => (await leadId()) !== 0, 60_000);
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();

    // ── Wave 1: two foreground and a background sub-agent work, then rest. ──
    const bg1 = bgAgent('a1e3f0c1d2b4', 'tu-bg1', 'scan logs');
    append([
      said([
        call('tu-a', 'Task', { description: 'fix login', prompt: 'x', model: 'opus' }),
        call('tu-b', 'Task', { description: 'fix logout', prompt: 'x', model: 'opus' }),
        call('tu-bg1', 'Agent', { description: 'scan logs', prompt: 'y', run_in_background: true }),
      ]),
      userResult('tu-bg1', 'Async agent launched successfully.\nagentId: a1e3f0c1d2b4'),
      sub('tu-a', said([call('tu-a-1', 'Grep', { pattern: 'login' })])),
      sub('tu-b', said([call('tu-b-1', 'Grep', { pattern: 'logout' })])),
    ]);
    await wait(1500);
    append([{ ...said([call('tu-bg1-1', 'Read', { file_path: '/work/alpha/app.log' })], usage(90_000)), isSidechain: true }], bg1.file);
    await until('wave 1: three named sub-agents at work, the background one with 피로도', async () => {
      const ts = await temps();
      return ts.length === 3 && allNamed(ts) && ts.some((t) => t.fatigue === 'bar');
    }, 60_000).catch(async (e) => {
      console.error(await describe());
      throw e;
    });
    const wave1 = await temps();
    const bgName = wave1.find((t) => t.fatigue === 'bar')!.name;
    check(true, `wave 1 at work: ${wave1.map((t) => `${t.name} (${t.fatigue})`).join(', ')}`);
    append([sub('tu-a', userResult('tu-a-1', 'found')), userResult('tu-a', 'done')]);
    append([sub('tu-b', userResult('tu-b-1', 'found')), userResult('tu-b', 'done')]);
    await wait(500); // the background one finishes last: its employee is idle the shortest
    bg1.finish();
    append([done('a1e3f0c1d2b4', 'tu-bg1')]);
    await until('wave 1 rests', async () => {
      const ts = await temps();
      return ts.length === 3 && ts.every((t) => t.phase === 'lingering');
    }, 30_000);
    await wait(3000);
    const resting = await temps();
    check(allNamed(resting), `resting, all keep their names: ${resting.map((t) => t.name).join(', ')}`);
    const bgRest = resting.find((t) => t.name === bgName);
    check(bgRest?.fatigue === 'bar', `the background one keeps its 피로도 after it finished (${bgRest?.fatigue})`);
    await shot('desktop-wave1-resting');

    // ── Wave 2: two new spawns take the two longest idle employees; those two resting characters
    //    walk out (one person, one character), still named; the background one rests on. ──
    const bg2 = bgAgent('a2e3f0c1d2b4', 'tu-bg2', 'index docs');
    append([
      said([
        call('tu-c', 'Task', { description: 'write tests', prompt: 'x', model: 'opus' }),
        call('tu-bg2', 'Agent', { description: 'index docs', prompt: 'y', run_in_background: true }),
      ]),
      userResult('tu-bg2', 'Async agent launched successfully.\nagentId: a2e3f0c1d2b4'),
      sub('tu-c', said([call('tu-c-1', 'Bash', { command: 'npm test' })])),
    ]);
    await wait(1500);
    append([{ ...said([call('tu-bg2-1', 'Read', { file_path: '/work/alpha/README.md' })], usage(60_000)), isSidechain: true }], bg2.file);
    let leavers: Temp[] = [];
    await until('wave 2: two at work, the background one resting, two walking out', async () => {
      const ts = await temps();
      const leaving = ts.filter((t) => t.phase === 'leaving');
      if (leaving.length) leavers = leaving;
      return (
        ts.filter((t) => t.phase === 'working').length === 2 &&
        ts.filter((t) => t.phase === 'lingering').length === 1 &&
        leavers.length === 2
      );
    }, 60_000).catch(async (e) => {
      console.error(await describe());
      throw e;
    });
    const wave2 = await temps();
    console.log(await describe());
    check(allNamed(wave2), `wave 2: every sub-agent named (${wave2.map((t) => `${t.name}/${t.phase}`).join(', ')})`);
    check(allNamed(leavers), `the two walking out keep their names (${leavers.map((t) => t.name).join(', ')})`);
    const restingOn = wave2.find((t) => t.phase === 'lingering')!;
    check(restingOn.name === bgName && restingOn.fatigue === 'bar', `the background one rests on, named, with 피로도 (${restingOn.name})`);
    const lead = await leadId();
    const want = wave2.filter((t) => t.phase === 'working' || t.phase === 'lingering').map((t) => t.id);
    await until('dots to the working and the resting ones only', async () => {
      const subs = new Set((await links()).filter(([l]) => l === lead).map(([, s]) => s));
      return want.every((id) => subs.has(id)) && leavers.every((t) => !subs.has(t.id));
    }, 10_000).catch(async (e) => {
      console.error(await describe());
      throw e;
    });
    check(true, 'dots run to the two at work and the one resting, none to the two walking out');
    await shot('desktop-wave2-names-dots');
    await until('the two walked out', async () => {
      const ids = new Set((await temps()).map((t) => t.id));
      return leavers.every((t) => !ids.has(t.id));
    }, 60_000);
    check(
      (await links()).every(([, s]) => !leavers.some((t) => t.id === s)),
      'no dots to the two once they are gone',
    );

    // ── The lead moves to floor 2: no dots from it to anyone on floor 1. ──
    const moved = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const ws = new WebSocket(`ws://${location.host}/ws`);
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'moveToFloor', floorId: '2', character: 'lead' }));
            setTimeout(() => {
              ws.close();
              resolve(true);
            }, 500);
          };
          ws.onerror = () => resolve(false);
        }),
    );
    check(moved, 'moveToFloor sent');
    await until('the lead is on floor 2', async () => {
      const b = [...received].reverse().find((m) => m.type === 'buildingState') as { floors?: Array<{ characters: string[] }> } | undefined;
      return !!b?.floors?.[1]?.characters.includes('lead');
    });
    await wait(4000);
    const leadRow = await page.evaluate((id) => {
      const staff = (Reflect.get(window, '__cldStaff') ?? []) as Array<{ id: number; at: number[] }>;
      return staff.find((s) => s.id === id)?.at[1] ?? -1;
    }, lead);
    const after = await temps();
    const cross = (await links()).filter(([l, s]) => {
      const t = after.find((x) => x.id === s);
      return l === lead && t && floorOf(t.row) !== floorOf(leadRow);
    });
    console.log(`lead row ${leadRow} floor ${floorOf(leadRow)}; ${await describe()}`);
    check(floorOf(leadRow) === 1, `the lead stands on floor 2 (row ${leadRow})`);
    check(
      after.some((t) => floorOf(t.row) === 0),
      `some sub-agents stayed on floor 1 (${after.map((t) => floorOf(t.row) + 1).join(',')})`,
    );
    check(cross.length === 0, `no dots from the lead to a sub-agent on another floor (${JSON.stringify(cross)})`);
    await shot('desktop-lead-on-floor2-no-dots');

    // ── A daemon restart and a page reload: names and 피로도 stay. ──
    daemon.child.kill('SIGTERM');
    await new Promise((r) => daemon.child.once('exit', r));
    daemon = launch();
    received.length = 0;
    await login();
    // The lead is on floor 2 now (no overlay on floor 1): it is back when the office seats it.
    await until('the lead is back', async () =>
      page.evaluate(() =>
        ((Reflect.get(window, '__cldStaff') ?? []) as Array<{ id: number }>).some((s) => s.id > 0),
      ),
    60_000);
    // New work on the open spawns (the restart's history read is over by now). The background one
    // is recovered next to its lead on floor 2; the foreground one's spawn line was before the
    // restart, so it is not seen again (as upstream).
    await wait(3000);
    append([sub('tu-c', userResult('tu-c-1', 'ok')), sub('tu-c', said([call('tu-c-2', 'Read', { file_path: '/work/alpha/x.ts' })]))]);
    append([{ ...said([call('tu-bg2-2', 'Grep', { pattern: 'docs' })], usage(70_000)), isSidechain: true }], bg2.file);
    await page.keyboard.press('2');
    /** Overlays are drawn for the floor shown only (floor 2 now). */
    const upstairs = async () => (await temps()).filter((t) => floorOf(t.row) === 1);
    await until('after the restart: the background sub-agent on floor 2, named, with 피로도', async () => {
      const ts = await upstairs();
      return ts.length >= 1 && allNamed(ts) && ts.some((t) => t.fatigue === 'bar');
    }, 60_000).catch(async (e) => {
      console.error(await describe());
      throw e;
    });
    const back = await upstairs();
    check(true, `after a restart and a reload, named with 피로도: ${back.map((t) => `${t.name} (${t.fatigue})`).join(', ')}`);
    await until('dots to it on floor 2', async () => (await links()).some(([l, s]) => back.some((t) => t.id === s) && l > 0), 10_000);
    check(true, 'dots run to it on its lead floor');
    await wait(1000);
    await shot('desktop-after-restart-floor2');

    // It finishes: still named, its 피로도 still known.
    bg2.finish();
    append([sub('tu-c', userResult('tu-c-2', 'ok')), userResult('tu-c', 'done'), done('a2e3f0c1d2b4', 'tu-bg2')]);
    await until('it rests', async () => {
      const ts = await upstairs();
      return ts.length >= 1 && ts.every((t) => t.phase === 'lingering');
    }, 30_000);
    await wait(3000);
    const end = await upstairs();
    check(allNamed(end), `finished after the restart, still named: ${end.map((t) => t.name).join(', ')}`);
    check(end.some((t) => t.fatigue === 'bar'), 'and it keeps its 피로도');
    await shot('desktop-after-restart-resting');
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
    console.log(`\n${results.length} checks passed`);
  } finally {
    clearTimeout(deadline);
    if (process.env.REPRO) fs.writeFileSync('/tmp/temp-state-daemon.log', daemon.log.join(''));
    await browser.close();
    if (daemon.child.exitCode === null) {
      const exited = new Promise((r) => daemon.child.once('exit', r));
      daemon.child.kill('SIGTERM');
      await exited;
    }
    proc.kill('SIGKILL');
    killFakeSessions(home);
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch (err) {
      console.warn(`left ${home}: ${String(err)}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

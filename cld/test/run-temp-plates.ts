/**
 * TEMP-PLATES check: dist/cli.js with an isolated HOME on a spare port, headless Chromium
 * (no GPU), desktop 1280x800 and phone 393x852. Fake sessions only (a `sleep` with a
 * transcript we write), no model is ever called.
 *
 * The office: the Claude session `lead` in /work/alpha and one Codex temporary (no Worker)
 * for project alpha.
 * - wave 1: `lead` spawns a foreground sub-agent (Task) and an unnamed background one (its
 *   own transcript, with usage); the two sub-characters and the Codex temporary wear
 *   roster names and the same nameplate (level ring; 피로도 from the background
 *   sub-agent's own context, 미확인 for the others); the details say "임시 직원";
 * - the wave ends (tool result, the background queue-operation, the Codex run done);
 * - wave 2: two new spawns come back as the same employees (roster.json), and their XP
 *   has grown (levels.json emp:<id>).
 * Screenshots go to cld/artifacts/temp-plates/.
 *
 *   npx tsx cld/test/run-temp-plates.ts <port 18256-18259>
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
  seedCodexTask,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/temp-plates');
const BG_AGENT = 'a7e3f0c1d2b4';
const CODEX_ID = '1024-170000-alpha';

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[], usage?: Rec): Rec => ({
  type: 'assistant',
  message: { model: 'claude-sonnet-4-5', content, ...(usage && { usage }) },
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
const turnEnd: Rec = { type: 'system', subtype: 'turn_duration', durationMs: 1000 };

const results: string[] = [];
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  results.push(what);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

/** A live Claude Code session (a `sleep` of ours) named `name` in `cwd`; its transcript. */
function session(home: string, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c1024000-0000-4000-8000-000000000001';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, '');
  const subDir = path.join(projectDir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
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
  return { proc, transcript, subDir };
}

interface Plate {
  id: number;
  kind: string;
  name: string;
  ring: boolean;
  fatigue: 'bar' | 'unknown' | 'none';
  rank: string | null;
}
const plates = (page: Page): Promise<Plate[]> =>
  page.$$eval('[data-testid="agent-overlay"]', (nodes) =>
    nodes.map((n) => ({
      id: Number(n.getAttribute('data-agent-id')),
      kind: n.getAttribute('data-kind') ?? '',
      name: n.querySelector('[data-testid="agent-name"]')?.textContent ?? '',
      ring: !!n.querySelector('[data-testid="level-ring"]'),
      fatigue: n.querySelector('[data-testid="fatigue"]')
        ? ('bar' as const)
        : n.querySelector('[data-testid="fatigue-unknown"]')
          ? ('unknown' as const)
          : ('none' as const),
      rank: n.querySelector('[data-testid="rank-icon"]')?.getAttribute('data-rank') ?? null,
    })),
  );
const temps = async (page: Page) =>
  (await plates(page)).filter((p) => p.kind === 'subagent' || p.kind === 'codex');
const rosterNames = new Set(STAFF_NAMES.flatMap((n) => [n.ko, n.en]));
const isRosterName = (name: string) => rosterNames.has(name.replace(/ \d+$/, ''));

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const sleeper = spawn('sleep', ['900'], { stdio: 'ignore' });
  const codexStarted = new Date(Date.now() - 300_000).toISOString();
  seedCodexTask(home, {
    id: CODEX_ID,
    project: 'alpha',
    state: 'running',
    spec: 'T-77-cache.md',
    model: 'terra',
    started: codexStarted,
    pid: sleeper.pid!,
  });
  const lead = session(home, 'lead', '/work/alpha');
  const append = (records: Rec[], file = lead.transcript) => {
    for (const r of records) fs.appendFileSync(file, JSON.stringify(r) + '\n');
  };
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on'], {});
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const select = (page: Page, id: number | null) =>
    page.evaluate((id) => {
      (
        window as unknown as { __pixelAgentsTestHooks: { selectAgent: (id: number | null) => void } }
      ).__pixelAgentsTestHooks.selectAgent(id as number);
    }, id);
  const roster = () =>
    JSON.parse(fs.readFileSync(path.join(home, '.config/cld-gui/roster.json'), 'utf-8')) as {
      projects: Record<string, { employees: Array<{ id: string; nameId: string; execution: string | null }>; executions: Record<string, { employee: string }> }>;
    };
  const xpOf = (employee: string): number => {
    try {
      const l = JSON.parse(fs.readFileSync(path.join(home, '.config/cld-gui/levels.json'), 'utf-8'));
      return l.levels[`emp:${employee}`]?.xp ?? 0;
    } catch {
      return 0;
    }
  };

  try {
    const loginUrl = await started.loginUrl();
    const { ctx: desk, page } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await desk.cookies());
    await phone.goto(`http://127.0.0.1:${port}/`);
    for (const p of [page, phone])
      await until('lead and the Codex temporary are in', async () => {
        const all = await plates(p);
        return all.some((x) => x.name === 'lead') && all.some((x) => x.kind === 'codex');
      });
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();

    // The Codex temporary: a roster name, a ring, its rank, 피로도 미확인.
    const codex = (await plates(page)).find((x) => x.kind === 'codex')!;
    check(isRosterName(codex.name), `the Codex temporary wears a roster name (${codex.name})`);
    check(codex.ring && codex.rank === 'intern', `it has the level ring and its rank icon (${codex.rank})`);
    check(codex.fatigue === 'unknown', 'its 피로도 says 미확인 (no verified usage)');

    // Wave 1: a foreground sub-agent and an unnamed background one (its own transcript).
    fs.writeFileSync(path.join(lead.subDir, `agent-${BG_AGENT}.jsonl`), '');
    fs.writeFileSync(
      path.join(lead.subDir, `agent-${BG_AGENT}.meta.json`),
      JSON.stringify({ agentType: 'general-purpose', description: 'scan logs', toolUseId: 'tu-bg' }),
    );
    append([
      said([
        call('tu-a', 'Task', { description: 'fix login', prompt: 'x', model: 'sonnet' }),
        call('tu-bg', 'Agent', { description: 'scan logs', prompt: 'y', run_in_background: true }),
      ]),
      userResult('tu-bg', `Async agent launched successfully.\nagentId: ${BG_AGENT}`),
      sub('tu-a', said([call('tu-a-1', 'Grep', { pattern: 'login' })])),
    ]);
    const bgFile = path.join(lead.subDir, `agent-${BG_AGENT}.jsonl`);
    await new Promise((r) => setTimeout(r, 2_000));
    append(
      [
        {
          ...said([call('tu-bg-1', 'Read', { file_path: '/work/alpha/app.log' })], {
            input_tokens: 10,
            cache_creation_input_tokens: 20_000,
            cache_read_input_tokens: 90_000,
            output_tokens: 500,
          }),
          isSidechain: true,
        },
      ],
      bgFile,
    );
    for (const p of [page, phone])
      await until(
        'two named sub-agents',
        async () => (await temps(p)).filter((x) => x.kind === 'subagent' && isRosterName(x.name)).length === 2,
        45_000,
      ).catch(async (err) => {
        await shot(p, 'debug');
        console.error(JSON.stringify(await plates(p)));
        throw err;
      });
    await until('the background sub-agent shows its own 피로도', async () =>
      (await temps(page)).some((x) => x.kind === 'subagent' && x.fatigue === 'bar'),
    );
    const wave1 = await temps(page);
    const subs1 = wave1.filter((x) => x.kind === 'subagent');
    check(new Set(wave1.map((x) => x.name)).size === wave1.length, `names differ (${wave1.map((x) => x.name).join(', ')})`);
    check(subs1.every((x) => x.ring), 'every sub-agent plate has the level ring');
    check(
      subs1.filter((x) => x.fatigue === 'bar').length === 1 && subs1.filter((x) => x.fatigue === 'unknown').length === 1,
      'the background sub-agent shows its context as 피로도, the foreground one 미확인',
    );
    check(subs1.some((x) => x.rank === 'intern'), 'the Sonnet spawn has the intern rank icon (Lv 1) on the plate');
    await page.waitForTimeout(3_000); // walking in
    await shot(page, 'desktop-wave1');
    await shot(phone, 'phone-wave1');
    const fg = subs1.find((x) => x.fatigue === 'unknown')!;
    await select(page, fg.id);
    const details = page.locator(`[data-testid="agent-overlay"][data-agent-id="${fg.id}"] [data-testid="temp-employee"]`);
    await details.waitFor({ timeout: 5_000 });
    check((await details.textContent())?.includes('새 세션'), `the details say: ${await details.textContent()}`);
    await page.waitForTimeout(500);
    await shot(page, 'desktop-details');
    await select(page, null);

    const before = roster().projects;
    const leadRoster = before.lead.employees;
    check(leadRoster.length === 2 && leadRoster.every((e) => e.execution), 'the lead project hired two employees, both at work');
    check(before.alpha.employees.length === 1, 'the Codex temporary is on project alpha\'s roster, not mixed in');
    const wave1Ids = leadRoster.map((e) => e.id).sort();

    // The wave ends: the result, the background completion, the Codex run done.
    append([
      sub('tu-a', userResult('tu-a-1', 'found')),
      userResult('tu-a', 'done'),
      {
        type: 'queue-operation',
        operation: 'enqueue',
        content: `<task-notification><task-id>${BG_AGENT}</task-id><tool-use-id>tu-bg</tool-use-id><status>completed</status></task-notification>`,
      },
      said([{ type: 'text', text: 'ok' }]),
      turnEnd,
    ]);
    seedCodexTask(home, {
      id: CODEX_ID,
      project: 'alpha',
      state: 'done',
      spec: 'T-77-cache.md',
      model: 'terra',
      started: codexStarted,
      ended: new Date().toISOString(),
      exit: 0,
    });
    await until('wave 1 is released', async () => roster().projects.lead.employees.every((e) => !e.execution), 30_000);
    await until('the Codex run is released', async () => roster().projects.alpha.employees.every((e) => !e.execution), 30_000);
    // Each wave 1 sub-agent: one tool (2) and its finish (10), paid once.
    await until('wave 1 XP is written', async () => wave1Ids.every((id) => xpOf(id) === 12), 20_000);
    const xp1 = Object.fromEntries(wave1Ids.map((id) => [id, xpOf(id)]));
    const codexEmp = roster().projects.alpha.employees[0].id;
    await until('the Codex run earned XP_JOB', async () => xpOf(codexEmp) >= 20, 20_000);
    check(true, `wave 1 XP: ${JSON.stringify(xp1)}, the Codex employee ${xpOf(codexEmp)}`);

    // Wave 2: two new spawns come back as the same employees, and their XP grows.
    append([
      said([
        call('tu-c', 'Task', { description: 'write tests', prompt: 'x', model: 'haiku' }),
        call('tu-d', 'Task', { description: 'update docs', prompt: 'y' }),
      ]),
      sub('tu-c', said([call('tu-c-1', 'Bash', { command: 'npm test' })])),
      sub('tu-d', said([call('tu-d-1', 'Read', { file_path: '/work/alpha/README.md' })])),
    ]);
    await until('wave 2 is at work', async () => roster().projects.lead.employees.every((e) => e.execution), 30_000);
    const after = roster().projects.lead;
    check(
      after.employees.length === 2 && after.employees.map((e) => e.id).sort().join() === wave1Ids.join(),
      'wave 2 went to the same two employees (no new hire)',
    );
    const c = after.executions['claude:tu-c'].employee;
    const d = after.executions['claude:tu-d'].employee;
    check(c !== d, 'two at once never share an employee');
    for (const p of [page, phone])
      await until('wave 2 wears the wave 1 names', async () => {
        const names = (await temps(p)).filter((x) => x.kind === 'subagent').map((x) => x.name);
        return names.length >= 2 && subs1.every((s) => names.includes(s.name));
      }, 30_000).catch(async (err) => {
        await shot(p, 'debug-wave2');
        console.error(JSON.stringify(await plates(p)));
        throw err;
      });
    check(true, `wave 2 plates: ${(await temps(page)).filter((x) => x.kind === 'subagent').map((x) => x.name).join(', ')}`);
    await page.waitForTimeout(1_500);
    await shot(page, 'desktop-wave2');
    await shot(phone, 'phone-wave2');
    // The language switch names the same employees in English (the phone, reloaded mid-work).
    const en = (ko: string) => STAFF_NAMES.find((n) => n.ko === ko.replace(/ \d+$/, ''))?.en;
    const wantEn = subs1.map((s) => en(s.name)).sort();
    await phone.evaluate(() => localStorage.setItem('cld.lang', 'en'));
    await phone.reload();
    await until('English names on the phone', async () => {
      const names = (await temps(phone)).filter((x) => x.kind === 'subagent').map((x) => x.name).sort();
      return JSON.stringify(names) === JSON.stringify(wantEn);
    }, 30_000).catch(async (err) => {
      await shot(phone, 'debug-english');
      console.error(JSON.stringify(await plates(phone)), JSON.stringify(wantEn));
      throw err;
    });
    check(true, `in English the same employees: ${wantEn.join(', ')}`);
    await phone.waitForTimeout(1_500);
    await shot(phone, 'phone-english');
    append([sub('tu-c', userResult('tu-c-1', 'ok')), userResult('tu-c', 'done'), sub('tu-d', userResult('tu-d-1', 'ok')), userResult('tu-d', 'done')]);
    await until('wave 2 XP grows', async () => wave1Ids.every((id) => xpOf(id) === xp1[id] + 12), 20_000);
    check(true, `XP grew: ${JSON.stringify(Object.fromEntries(wave1Ids.map((id) => [id, xpOf(id)])))}`);
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    console.log(`\n${results.length} checks passed`);
  } finally {
    await browser.close();
    started.child.kill();
    lead.proc.kill();
    sleeper.kill();
    killFakeSessions(home);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

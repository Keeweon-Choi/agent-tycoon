/**
 * GAME-UI-1 G3 on the REAL API: dist/cli.js in a temp HOME (the engine's fake claude as `claude-pty`, never a
 * real agent), four Leads (alpha, beta, delta, eta) whose transcripts put them in the four states (일하는 중,
 * 나를 기다림, 허락 기다림, 쉬는 중) with real context usage; the status-line usage report and Codex log faked
 * (testHome.fakeUsage: Claude 5h 38% · 7d 59% used, Codex 12% · 27%); a loopback LHM data.json for the CPU
 * temperature (--lhm-port; the daemon's own hw sampling while someone watches); three live jobs in alpha (a tqdm
 * log at 45%, a median-estimated one, a first run), our own `sleep` processes.
 *  1. 07 HUD (hud-v3: the usage panel, the corner and the 메뉴): the panel shows what is LEFT (62%), the job counter 3, no heat chip at 62°; at 88°
 *     amber 뜨거움 and one nudge (frames), at 96° red 위험; 1280 wide folds the day cells
 *  2. 05 party: every card in the card bar has its context strip and state icon (the 파티 window is gone since FEAT-PARTY-V2); it listed the
 *     four with their state, context left (delta under 20%: amber), model and Lv; a card opens the stats
 *  3. 06 job run: the top running job walks (frames), fills from tqdm / the median, the first run fills
 *     nothing; exit 0 → CLEAR · exit 0 and three coins once (frames), the counter rolls to 2; exit 1 →
 *     GAME OVER · exit 1 with 로그 opening the log
 *  4. 게임 효과 off: an end shows the plate without coins, nothing moves
 *  5. phone 390x844: the job chip and the hot chip on top, the 5-hour gauges below; no horizontal scroll
 *  6. one picture beside the mocks (compare-mock.png)
 * Screenshots in agent-tycoon/artifacts/game-office/.
 *
 *   npx tsx agent-tycoon/test/run-game-office.ts [port 18320|18321|18340|18432]
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type * as net from 'net';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { transcriptPath } from '../../server/src/agent-tycoon/providers/claudeProvider.js';
import {
  assertPortFree,
  type Daemon,
  fakeUsage,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]) || 18320;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/game-office');
const MOCKS = path.join(REPO_ROOT, '../specs/ui-mock-1103/ideas/agents');
const DEADLINE_MS = 420_000;
const LEADS = [
  { name: 'alpha', model: 'claude-opus-5-5', tokens: 52_000, state: 'work' },
  { name: 'beta', model: 'claude-sonnet-4-5', tokens: 138_000, state: 'ask' },
  { name: 'delta', model: 'claude-haiku-4-5', tokens: 176_000, state: 'lock' },
  { name: 'eta', model: 'claude-sonnet-4-5', tokens: 24_000, state: 'rest' },
] as const;
const DESK: BrowserContextOptions = { viewport: { width: 1400, height: 900 } };
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let oks = 0;
const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually<T>(what: string, test: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeout = 30_000): Promise<T> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}
type Rec = Record<string, unknown>;
const stamp = (r: Rec): Rec => ({ uuid: `u-${Math.random().toString(16).slice(2, 10)}`, timestamp: new Date().toISOString(), ...r });

/** A loopback LHM web server: one Zen CPU whose control temperature the runner sets. */
async function fakeLhm(): Promise<{ port: number; set: (c: number) => void; close: () => void }> {
  let temp = 62;
  const tree = () => ({
    Text: 'Sensor',
    Children: [
      {
        Text: 'PC',
        Children: [
          {
            Text: 'AMD Ryzen 7 7700',
            HardwareId: '/amdcpu/0',
            Children: [{ SensorId: '/amdcpu/0/temperature/2', Type: 'Temperature', Text: 'Core (Tctl/Tdie)', Value: `${temp},0 °C` }],
          },
        ],
      },
    ],
  });
  const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(tree())));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as net.AddressInfo).port, set: (c) => void (temp = c), close: () => server.close() };
}

async function main() {
  if (![18320, 18321, 18340, 18432].includes(port)) throw new Error('port 18320, 18321, 18340 or 18432');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const ids = LEADS.map((_, i) => String.fromCharCode(97 + i).repeat(10));
  const folders = LEADS.map((l) => fs.mkdtempSync(path.join(home, `${l.name}-`)));
  put('projects.json', { v: 2, projects: LEADS.map((l, i) => ({ projectId: `p_${ids[i]}`, name: l.name, folder: folders[i], room: `${l.name}-room`, leadAssignmentId: `a_${ids[i]}` })) });
  put('assignments.json', { v: 1, assignments: LEADS.map((l, i) => ({ assignmentId: `a_${ids[i]}`, projectId: `p_${ids[i]}`, role: 'lead', provider: 'claude-pty', model: l.model, wantRunning: true })) });
  // 'build desktop' took 6 minutes the last three times: its bar is the median estimate.
  put('job-history.json', { 'build desktop': [360_000, 360_000, 360_000] });

  // Three live jobs in alpha, our own `sleep` processes (killed at the end).
  const jobsDir = path.join(home, '.local/state/agent-tycoon/jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  const sleeps: ChildProcess[] = [];
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
  const liveJob = (tag: string, desc: string, minAgo: number, log: string) => {
    const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
    sleeps.push(proc);
    const pid = proc.pid!;
    const id = `1103-${String(pid % 1_000_000).padStart(6, '0')}-${tag}`;
    const logFile = path.join(jobsDir, `${id}.log`);
    fs.writeFileSync(logFile, log);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    fs.writeFileSync(
      path.join(jobsDir, `${id}.json`),
      JSON.stringify({ id, pid, pstart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], boot, project: 'alpha', cmd: `bash ${tag}.sh`, desc, dir: folders[0], tab: null, tty: false, log: logFile, started: new Date(Date.now() - minAgo * 60_000).toISOString(), ended: null, exit: null, source: 'cli' }),
    );
    return id;
  };
  const e2e = liveJob('e2e', 'e2e standalone', 1, 'running 114 tests\nspecs:  45%|████▌     | 51/114 [04:12<05:08,  0.20it/s]');
  const build = liveJob('build', 'build desktop', 3, 'vite build\ntransforming (812) src/agent-tycoon/hud/HudWindow.tsx\n');
  const deploy = liveJob('deploy', 'deploy check', 4, 'smoke /api/health\n');
  const end = (id: string, code: number) => fs.writeFileSync(path.join(jobsDir, `${id}.exit`), `${code}\n`);

  const usage = await fakeUsage(home, { fiveHour: 38, sevenDay: 59 }, { fiveHour: 12, sevenDay: 27 });
  const lhm = await fakeLhm();
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal', '--lhm-port', String(lhm.port)], {
    ...usage.env,
    FAKE_TURN_MS: '240000',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
    for (const s of sleeps) s.kill('SIGKILL');
    process.exit(2);
  }, DEADLINE_MS);

  const sessionOf = (name: string) => {
    for (const file of fs.readdirSync(path.join(home, '.claude/sessions'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as { name: string; sessionId: string; cwd: string };
        if (s.name === name) return s;
      } catch {
        /* written as we read */
      }
    }
    return undefined;
  };
  const append = (name: string, ...records: Rec[]) => {
    const s = sessionOf(name)!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const r of records) fs.appendFileSync(file, `${JSON.stringify(stamp(r))}\n`);
  };
  const said = (model: string, tokens: number, content: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', model, content, usage: { input_tokens: 10, cache_read_input_tokens: tokens - 110, output_tokens: 100 } } });
  const turnEnd = { type: 'system', subtype: 'turn_duration', durationMs: 1200 };

  const newPage = async (opts: BrowserContextOptions, effects = true) => {
    const ctx = await browser!.newContext(opts);
    if (!effects) await ctx.addInitScript(() => localStorage.setItem('agty.game-effects', 'off'));
    const p = await ctx.newPage();
    await p.goto(await daemon.loginUrl());
    await p.waitForURL(`http://127.0.0.1:${port}/`);
    const toast = await p.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 4_000 }).catch(() => null);
    const v = toast?.match(/v([\d.]+)/)?.[1];
    if (v) {
      await p.evaluate((x) => localStorage.setItem('agty.changelogSeen', x), v);
      await p.reload();
    }
    return p;
  };
  const shot = (p: Page | ReturnType<Page['locator']>, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
  const attr = (p: Page, sel: string, a: string) => p.locator(sel).first().getAttribute(a);

  let busy: ReturnType<typeof setInterval> | undefined;
  try {
    await daemon.loginUrl();
    for (const l of LEADS) await eventually(`${l.name} revived`, () => !!sessionOf(l.name), 90_000);
    check(true, 'the four Leads run (fake claude-pty)');
    browser = await launchBrowser();
    const desk = await newPage(DESK);
    await desk.getByTestId('usage-panel').waitFor({ timeout: 30_000 }); // hud-v3: the PC's usage is the panel at the bottom right
    // The four states, each with a real context sample, written while the page watches (a card's activity
    // counts from its first live event, as the card bar's dot does).
    // FEAT-PARTY-V2: the card bar's marks are the party's portraits (each carries its state).
    const portraits = desk.locator('[data-testid="agent-card"][data-portrait]');
    await eventually('four party portraits', async () => (await portraits.count()) >= 4, 30_000);
    const [alpha, beta, delta, eta] = LEADS;
    // alpha runs a Bash call that keeps reporting progress: working, never a permission wait.
    append(alpha.name, { type: 'user', message: { content: 'usage.ts 를 읽어 주세요' } }, said(alpha.model, alpha.tokens, [{ type: 'tool_use', id: 'toolu_alpha1', name: 'Bash', input: { command: 'cat usage.ts', description: 'usage.ts 읽기' } }]));
    busy = setInterval(() => append(alpha.name, { type: 'progress', parentToolUseID: 'toolu_alpha1', data: { type: 'bash_progress' } }), 3_000);
    append(beta.name, { type: 'user', message: { content: '마이그레이션 정리' } }, said(beta.model, beta.tokens, [{ type: 'text', text: '마이그레이션 먼저 돌릴까요?' }]), turnEnd);
    append(delta.name, { type: 'user', message: { content: 'e2e 돌려 주세요' } }, said(delta.model, delta.tokens, [{ type: 'tool_use', id: 'toolu_delta1', name: 'Bash', input: { command: 'npm run e2e', description: 'e2e' } }]));
    append(eta.name, { type: 'user', message: { content: '정리해 주세요' } }, said(eta.model, eta.tokens, [{ type: 'text', text: '정리했어요.' }]), turnEnd);


    // ── 07 HUD ──
    // hud-v3: the PC has no top bar. The usage panel shows each provider's main window (what is left), the corner
    // shows a hot CPU only, and the job counter sits in the 메뉴 (its row is in the DOM, hidden, while the menu is shut).
    const gauge = (id: string) => desk.locator(`[data-testid="usage-panel-provider"][data-provider="${id}"]`);
    const openMenu = async (p: Page) => {
      if ((await p.getByTestId('hud-menu').getAttribute('aria-expanded')) !== 'true') await p.getByTestId('hud-menu').click();
    };
    await eventually('Claude gauge 62% left', async () => (await gauge('claude').innerText()).includes('62%'));
    const claudeText = (await gauge('claude').innerText()).replace(/\s+/g, ' ');
    check(/62%/.test(claudeText), `Claude gauge shows what is left (${claudeText})`);
    check(Number(await gauge('claude').locator('.game-segbar').getAttribute('data-lit')) >= 4, 'Claude 5h: about 5 of 8 cells lit (62% left)');
    const codexText = (await gauge('codex').innerText()).replace(/\s+/g, ' ');
    check(/88%/.test(codexText), `Codex gauge 88% (${codexText})`);
    check((await desk.getByTestId('hud-heat').count()) === 0, 'heat 62°: the corner shows a CPU chip only when it runs hot');
    await eventually('job counter 3', async () => (await attr(desk, '[data-testid="hud-jobs"]', 'data-count')) === '3', 20_000);
    check(true, 'job counter: 3 running');
    const bar = desk.getByTestId('usage-panel');
    await shot(bar, 'hud-desktop-1400');

    // ── 05 party: each portrait's state ──
    const markState = async (name: string) => portraits.and(desk.locator(`[title="${name}"]`)).getAttribute('data-state');
    for (const l of LEADS) await eventually(`${l.name} is ${l.state}`, async () => (await markState(l.name)) === l.state, 30_000);
    check(true, 'party: alpha work, beta ask, delta lock (after the permission timer), eta rest');
    await shot(desk, 'desktop-office');

    // ── 07 heat: 88 amber with one nudge, 96 red ──
    lhm.set(88);
    await eventually('heat 88 warn', async () => (await attr(desk, '[data-testid="hud-heat"]', 'data-tone')) === 'warn', 15_000);
    const heat = desk.getByTestId('hud-heat');
    check((await heat.getAttribute('data-nudge')) === '' && /88°/.test(await heat.innerText()), 'heat 88°: amber, 뜨거움, one nudge');
    await shot(heat, 'frames-heat-0');
    await wait(120);
    await shot(heat, 'frames-heat-1');
    await wait(480);
    await shot(heat, 'frames-heat-2');
    lhm.set(96);
    await eventually('heat 96 bad', async () => (await attr(desk, '[data-testid="hud-heat"]', 'data-tone')) === 'bad', 15_000);
    check(/96°/.test(await heat.innerText()), 'heat 96°: red, 위험');
    await shot(desk.getByTestId('hud-corner'), 'hud-desktop-hot');

    // ── 06 job run ──
    await openMenu(desk);
    await desk.getByTestId('hud-jobs').click();
    const dev = desk.locator('[data-hud-window="office"]');
    await dev.waitFor();
    const picker = dev.getByRole('combobox', { name: '개발 프로젝트' });
    await picker.waitFor();
    await picker.selectOption('alpha');
    const runs = dev.getByRole('button', { name: '실행', exact: true });
    if ((await runs.getAttribute('aria-pressed')) !== 'true') await runs.click();
    const jobCard = (id: string) => dev.locator(`[data-testid="job-card"][data-job-ref="${id}"]`);
    await jobCard(e2e).waitFor({ timeout: 15_000 });
    const run = (id: string) => jobCard(id).getByTestId('job-run');
    check((await run(e2e).getAttribute('data-source')) === 'tqdm' && (await run(e2e).getAttribute('data-lit')) === '13', 'e2e: 13 of 30 cells from the tqdm bar (45%)');
    check((await run(build).getAttribute('data-source')) === 'median' && Number(await run(build).getAttribute('data-lit')) > 0, `build: filled from the median (${await run(build).getAttribute('data-lit')} cells)`);
    check((await run(deploy).getAttribute('data-source')) === 'none' && (await run(deploy).getAttribute('data-lit')) === '0', 'deploy: first run, nothing filled');
    await eventually('the top job walks', async () => (await run(e2e).getAttribute('data-walking')) === 'true', 10_000);
    check((await run(build).getAttribute('data-walking')) === null, 'only the top running job walks');
    await jobCard(e2e).scrollIntoViewIfNeeded();
    await shot(dev, 'desktop-jobs-running');
    for (const i of [0, 1, 2]) {
      await shot(run(e2e), `frames-walk-${i}`);
      await wait(130);
    }
    // exit 0: CLEAR and three coins once; the counter rolls to 2
    end(e2e, 0);
    await eventually('e2e done', async () => (await run(e2e).getAttribute('data-kind')) === 'done', 20_000);
    const coins = run(e2e).locator('.game-coin');
    check((await coins.count()) === 3, 'exit 0: three coins');
    await shot(jobCard(e2e), 'frames-clear-0');
    await wait(350);
    await shot(jobCard(e2e), 'frames-clear-1');
    await wait(900);
    await shot(jobCard(e2e), 'frames-clear-2');
    check((await jobCard(e2e).getByTestId('job-plate').innerText()).includes('CLEAR · exit 0'), 'CLEAR · exit 0 plate');
    check((await run(e2e).getAttribute('data-lit')) === '30', 'done: all cells');
    check(await coins.evaluateAll((els) => els.every((e) => getComputedStyle(e).opacity === '0')), 'the coins are gone after 0.8 s');
    await eventually('counter 2', async () => (await attr(desk, '[data-testid="hud-jobs"]', 'data-count')) === '2', 10_000);
    check((await desk.getByTestId('hud-jobs').locator('[data-roll]').count()) === 1, 'the job counter rolled to 2');
    // exit 1: GAME OVER where it stopped, 로그. The same command took 5 minutes when it passed (a
    // deploy has a new description each time: the command is the basis), and the log says why.
    put('job-history.json', { 'build desktop': [360_000, 360_000, 360_000], '$ bash deploy.sh': [300_000, 300_000, 300_000] });
    fs.appendFileSync(path.join(jobsDir, `${deploy}.log`), 'FAIL smoke /api/health: 502\nGATE FAIL\nnot deploying\n');
    end(deploy, 1);
    await eventually('deploy failed', async () => (await run(deploy).getAttribute('data-kind')) === 'failed', 20_000);
    const plate = jobCard(deploy).getByTestId('job-plate');
    check((await plate.innerText()).includes('GAME OVER · exit 1'), 'exit 1: GAME OVER · exit 1');
    check((await jobCard(deploy).getByText('다시 실행').count()) === 0, 'no 다시 실행');
    const lit = Number(await run(deploy).getAttribute('data-lit'));
    const marked = run(deploy).locator('.game-run-lane > i[data-mark]');
    check(lit >= 20 && lit < 30 && (await marked.count()) === 1 && (await run(deploy).locator('.game-run-lane > i').nth(lit).getAttribute('data-mark')) !== null, `exit 1: filled to where it stopped (${lit} of 30), that cell red`);
    check((await jobCard(deploy).getByTestId('job-stop-line').innerText()) === '멈춘 곳: FAIL smoke /api/health: 502', 'exit 1: 멈춘 곳 is the cause line');
    const failOut = path.join(REPO_ROOT, 'agent-tycoon/artifacts/job-fail-1104');
    fs.mkdirSync(failOut, { recursive: true });
    await jobCard(deploy).scrollIntoViewIfNeeded();
    await jobCard(deploy).screenshot({ path: path.join(failOut, 'after-desktop-card.png') });
    await plate.getByRole('button', { name: /로그/ }).click();
    await jobCard(deploy).getByTestId('job-digest').waitFor({ timeout: 5_000 });
    check(true, '로그 opens the log');
    await shot(dev, 'desktop-jobs-ended');

    // ── 1280 wide ──
    await desk.setViewportSize({ width: 1280, height: 800 });
    await wait(400);
    await shot(bar, 'hud-desktop-1280');
    await desk.context().close();

    // ── 게임 효과 off: the plate without coins ──
    const still = await newPage(DESK, false);
    check((await still.evaluate(() => document.documentElement.dataset.gameMotion)) === 'off', '게임 효과 off: data-game-motion=off');
    await still.getByTestId('hud-menu').click();
    await still.getByTestId('hud-jobs').click();
    const dev2 = still.locator('[data-hud-window="office"]');
    await dev2.getByRole('combobox', { name: '개발 프로젝트' }).selectOption('alpha');
    const runs2 = dev2.getByRole('button', { name: '실행', exact: true });
    if ((await runs2.getAttribute('aria-pressed')) !== 'true') await runs2.click();
    const buildCard = dev2.locator(`[data-testid="job-card"][data-job-ref="${build}"]`);
    await buildCard.waitFor({ timeout: 15_000 });
    check((await buildCard.getByTestId('job-run').getAttribute('data-walking')) === null, 'effects off: the runner stands');
    end(build, 0);
    await eventually('build done', async () => (await buildCard.getByTestId('job-run').getAttribute('data-kind')) === 'done', 20_000);
    check((await buildCard.locator('.game-coin').count()) === 0 && (await buildCard.getByTestId('job-plate').isVisible()), 'effects off: the plate, no coins');
    await shot(dev2, 'effects-off');
    await still.context().close();

    // ── Phone ──
    const phone = await newPage(PHONE);
    const top = phone.getByTestId('mobile-top-bar');
    await top.getByTestId('hud-jobs').waitFor({ timeout: 30_000 });
    await eventually('phone hot chip', async () => (await top.getByTestId('hud-heat').count()) === 1, 15_000);
    check(/96°/.test(await top.getByTestId('hud-heat').innerText()), 'phone: the job chip and the hot 96° chip on top');
    const strip = phone.getByTestId('cc-seg-usage');
    const rows = await strip.locator('[data-agent]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    // FEAT-PHONE-CONTROL-CENTER: the desktop control center's folded usage, on one row.
    check(rows.length >= 1 && rows.every((y) => y === rows[0]), `phone: the folded usage is one row (${rows})`);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: no horizontal scroll');
    await shot(phone, 'phone-office');
    await phone.context().close();

    // ── Beside the mocks ──
    const cmp = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const img = (f: string) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
    const row = (label: string, mock: string, ours: string) =>
      `<h2>${label}</h2><div class="r"><figure><img src="${img(path.join(MOCKS, mock))}"><figcaption>mock</figcaption></figure><figure><img src="${img(path.join(OUT, ours))}"><figcaption>ours (real API)</figcaption></figure></div>`;
    await cmp.setContent(
      // eslint-disable-next-line agent-tycoon/no-inline-colors -- the comparison sheet only, never the product
      `<style>body{background:#1e1e2e;color:#ccc;font:14px sans-serif;margin:8px}.r{display:flex;gap:8px}figure{margin:0;flex:1}img{width:100%;border:2px solid #444}h2{font-size:14px;margin:8px 0 4px}</style>
      ${row('05 party', '05-party.png', 'desktop-party.png')}${row('06 job run', '06-job-run.png', 'desktop-jobs-ended.png')}${row('07 HUD', '07-hud.png', 'hud-desktop-hot.png')}`,
    );
    await cmp.screenshot({ path: path.join(OUT, 'compare-mock.png'), fullPage: true });
    await cmp.close();
    console.log(`\n${oks} checks ok · screenshots in ${OUT}`);
  } finally {
    clearTimeout(deadline);
    clearInterval(busy);
    await browser?.close().catch(() => undefined);
    await daemon.stop();
    for (const s of sleeps) s.kill('SIGTERM');
    lhm.close();
    killFakeSessions(home);
    removeTestHome(home);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

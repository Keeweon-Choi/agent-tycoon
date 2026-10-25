/**
 * T-0016 vanilla proof (TC-167, NFR-CMP-009): the office with nothing of ours
 * around it. dist/cli.js runs with on a spare port in an isolated HOME
 * that holds only a fake `claude` (`agents --json`: three sessions, scenario V-3)
 * and their transcripts: no office, no rules file, no ~/.claude settings, no Codex.
 * tmux, nvidia-smi and office are traps on PATH that log any run.
 *
 * Headless Chromium logs in and checks that the office works end to end
 * (characters, EZ texts, the office-only panels hidden or empty, no PC names or GPU
 * thresholds anywhere on screen, no launch flags passed to `claude`, nothing run
 * that should not be). Then it writes the user's own ez-rules.json -- one rule that
 * changes a phrase, one broken entry -- and checks that a NEW page speaks with it
 * while the daemon logs the broken entry once. Screenshots use Hangul from
 * malgun.ttf (read only). T-0059/ENV-2: with no claude-dashboard plugin and no usage
 * source the top bar says usage is unknown and shows no numbers (negative control); 프로젝트 현황 works from a card's own git folder; then
 * the daemon restarts with a fake plugin in HOME and the strip shows the plugin's
 * numbers, still without office. A hard deadline and SIGINT/SIGTERM/SIGHUP kill the server.
 *
 *   npx tsx cld/test/run-vanilla.ts <port 18256-18259>
 */
import type { Browser, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { ezRulesPath } from '../../server/src/cld/ezRules.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  openOfficeWindow,
  openWorkbenchTab,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0016');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const EMOJI_FONT = '/mnt/c/Windows/Fonts/seguiemj.ttf';
// Hangul from Malgun Gothic and emoji from Segoe UI Emoji (read only), everything
// else still the pixel font: headless Chromium here has neither.
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0016/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
  @font-face { font-family: 'FS Pixel Sans'; src: url('/__t0016/emoji.ttf');
  unicode-range: U+2190-21FF, U+2300-23FF, U+2600-27BF, U+2B00-2BFF, U+FE0F, U+200D, U+1F000-1FAFF; }`;
const DEADLINE_MS = 180_000;
/** Nothing of this PC, and no GPU budget (4.5 or 6 GiB, not part of a longer number), may appear on screen. */
const NEVER_ON_SCREEN: RegExp[] = [
  /orch-pofol|pofol|ops|rules\.md/,
  /(?<![\d.])(4\.5|6)\s?GiB/,
];
/** Messages only a office provider sends. */
// officeJobs and codexTasks are the built-in engine's (on without a office, T-0019, T-0021), not office data.
const OFFICE_ONLY_MESSAGES = ['officeEvent', 'statusOutput'];

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

const record = (tool: Record<string, unknown>) =>
  `${JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: `tu-${Math.random().toString(36).slice(2)}`, ...tool }],
    },
  })}\n`;

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'V-3', agentsJson: true }); // no office in HOME at all
  // The three sessions live in real folders under the fake HOME (api is a git repo with one
  // commit and one untracked file), so 프로젝트 현황 has something to read.
  const work = (n: string) => path.join(fake.home, 'work', n);
  const scenario = path.join(fake.home, 'scenario-v3');
  fs.mkdirSync(scenario);
  const rows = JSON.parse(
    fs.readFileSync(path.join(fake.env.FAKE_CLAUDE_SCENARIO, 'agents.json'), 'utf-8'),
  ) as Array<{ cwd: string; sessionId: string }>;
  for (const r of rows) {
    r.cwd = work(path.basename(r.cwd));
    fs.mkdirSync(r.cwd, { recursive: true });
    const file = path.join(
      fake.home,
      '.claude/projects',
      normalizeProjectPath(r.cwd),
      `${r.sessionId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  fs.writeFileSync(path.join(scenario, 'agents.json'), JSON.stringify(rows));
  fake.env.FAKE_CLAUDE_SCENARIO = scenario;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', work('api'), ...args], {
      env: { ...process.env, HOME: fake.home, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'ignore',
    });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work('api'), 'app.ts'), 'export {};\n');
  git('add', 'app.ts');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first api commit');
  fs.writeFileSync(path.join(work('api'), 'untracked.txt'), 'x\n');
  const trapLog = path.join(fake.home, 'traps.log');
  const traps = path.join(fake.home, 'trap-bin');
  fs.mkdirSync(traps);
  for (const name of ['tmux', 'nvidia-smi', 'office']) {
    const file = path.join(traps, name);
    fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${trapLog}"\nexit 1\n`);
    fs.chmodSync(file, 0o755);
  }
  const daemonArgs = ['--no-terminal'];
  const daemon = startDaemon(fake, port, daemonArgs, { PATH: traps });
  const { child: server, log: serverLog } = daemon;
  const loginUrl = daemon.loginUrl();
  let second: ReturnType<typeof startDaemon> | undefined; // the restart with the plugin
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    for (const d of [server, second?.child])
      if (d && d.exitCode === null && d.signalCode === null) d.kill('SIGKILL');
    fs.rmSync(fake.home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const received: Array<Record<string, unknown>> = [];
  const problems: string[] = [];
  let browser: Browser | undefined;
  let font: Buffer | undefined;
  let emoji: Buffer | undefined;
  const open = async (opts: Parameters<Browser['newContext']>[0]) => {
    const ctx = await browser!.newContext(opts);
    // T-0029: the 현황판 folds rooms and orchestrators; these checks press
    // buttons inside the cards, so a fresh profile starts with all open (모두 펼치기).
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('cld.status-tree'))
        localStorage.setItem('cld.status-tree', '{"rooms":true,"orchs":true}');
    });
    await ctx.route('**/__t0016/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    await ctx.route('**/__t0016/emoji.ttf', (route) =>
      route.fulfill({ body: emoji, contentType: 'font/ttf' }),
    );
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
    });
    page.on('websocket', (ws) =>
      ws.on('framereceived', (f) => {
        try {
          received.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
        } catch {
          /* binary */
        }
      }),
    );
    return { ctx, page };
  };
  const hangul = async (page: Page) => {
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
  };
  const screen = (page: Page) => page.evaluate(() => document.body.innerText);
  const shown = (page: Page, text: string) =>
    page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: 60_000 });
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const transcript = (cwd: string, sessionId: string) =>
    path.join(fake.home, '.claude/projects', normalizeProjectPath(cwd), `${sessionId}.jsonl`);
  const api = transcript(work('api'), 'b0000001-0000-4000-8000-000000000001');
  const docs = transcript(work('docs'), 'b0000002-0000-4000-8000-000000000002');
  const web = transcript(work('web'), 'b0000003-0000-4000-8000-000000000003');
  const openProjectStatus = async (page: Page, session: string) => {
    const drawer = page.getByRole('complementary');
    await drawer.getByRole('button', { name: '현황판', exact: true }).click();
    const node = drawer.locator('article', { hasText: session });
    if (!(await node.innerText()).includes('지금 하는 일'))
      await node.locator('div').first().click();
    await node.getByRole('button', { name: /프로젝트 현황/ }).click();
    return node;
  };
  const types = () => received.map((m) => String(m.type));

  try {
    font = fs.readFileSync(FONT);
    emoji = fs.readFileSync(EMOJI_FONT);
    browser = await launchBrowser();

    // ── Desktop ──
    const { page } = await open({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 1,
    });
    await page.goto(await loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(page); // T-0108: a desktop starts with icons only
    await hangul(page);
    // Three sessions at work: a file read, a test run, and a office command that
    // means nothing here (the office rules are off without a office).
    await page.waitForTimeout(1500);
    fs.appendFileSync(
      api,
      record({ name: 'Read', input: { file_path: `${work('api')}/src/app.ts` } }),
    );
    fs.appendFileSync(docs, record({ name: 'Bash', input: { command: 'npm test' } }));
    fs.appendFileSync(web, record({ name: 'Bash', input: { command: 'office codex fix bug' } }));
    await shown(page, '📖 자료 읽는 중');
    await shown(page, '🧪 시험 돌리는 중');
    await shown(page, '💻 명령 실행 중');
    await page.waitForTimeout(800);
    check(true, 'the office shows 📖 자료 읽는 중, 🧪 시험 돌리는 중 and 💻 명령 실행 중');
    const overlays = await page.locator('[data-testid="agent-overlay"]').allTextContents();
    check(
      overlays.length === 3 &&
        ['api-refactor', 'docs-site', 'web'].every((n) => overlays.some((t) => t.includes(n))),
      `three characters, named by session and folder (${overlays.map((t) => t.slice(0, 24)).join(' | ')})`,
    );
    check(
      !(await screen(page)).includes('Codex에게 맡김'),
      '`office codex …` is just a command without a office: no 🤖 Codex에게 맡김',
    );
    await shot(page, 'vanilla-desktop');

    // The office-only panels hide or stay empty; nothing says "office" is missing.
    const drawer = page.getByRole('complementary');
    await drawer.waitFor();
    const status = await drawer.innerText();
    check(
      status.includes('api-refactor') &&
        ['받은편지', '휴식 ', '화면 정보 없음', '마지막 턴', 'office'].every(
          (t) => !status.includes(t),
        ),
      '현황판 lists the sessions without office-only rows (받은편지, 휴식 N, 화면 정보, 마지막 턴) or the word office',
    );
    check(
      // UI-C1: the 현황판 keeps 현황판 and HW; the engine's jobs (without an office, --engine auto)
      // and, since T-0021, its Codex runs are the 작업실's Task and 에이전트 tabs.
      (await drawer.getByRole('button', { name: '작업', exact: true }).count()) === 0 &&
        (await drawer.getByRole('button', { name: 'Codex', exact: true }).count()) === 0,
      'the 현황판 has no 작업 or Codex tab any more',
    );
    await openWorkbenchTab(page, 'Task');
    const bench = page.locator('[data-hud-window="workbench"]');
    check(
      (await bench.getByRole('button', { name: 'Task', exact: true }).count()) === 1 &&
        (await bench.getByRole('button', { name: '에이전트', exact: true }).count()) === 1,
      "the engine's jobs and Codex runs are the 작업실's Task and 에이전트 tabs (no office needed)",
    );
    await page.locator('[data-hud-id="icon:workbench"] button').click(); // closes it again
    // T-0070: no 소식 tab; its events are in the 알림 list, empty here, no error.
    check(
      (await drawer.getByRole('button', { name: '소식', exact: true }).count()) === 0,
      'no 소식 tab',
    );
    await page.getByTestId('notice-bell').click();
    await page.waitForTimeout(300);
    check(
      (await page.getByText('아직 알림이 없어요', { exact: false }).count()) === 1,
      '알림: empty, no error',
    );
    await shot(page, 'vanilla-panel-feed');
    await page.getByRole('button', { name: '알림 닫기' }).click();
    await drawer.getByRole('button', { name: 'HW', exact: true }).click();
    await page.waitForTimeout(300);
    const hwText = await drawer.innerText();
    check(
      // T-0021: the engine's own 'GPU 예약' (lease queue) section is there (and, on a GPU host, its
      // '예약 없이 GPU 사용' lines for the host's own processes); a GPU card is not.
      hwText.includes('RAM') &&
        !hwText.replaceAll(/GPU 예약|예약 없이 GPU 사용[^\n]*/g, '').includes('GPU') &&
        !hwText.includes('HW 수집 멈춤'),
      'HW: the built-in sampler (CPU load, memory, disk), no GPU card, not stalled',
    );
    await shot(page, 'vanilla-panel-hw');
    await drawer.getByRole('button', { name: '현황판', exact: true }).click();
    const everything = await screen(page);
    for (const bad of NEVER_ON_SCREEN) check(!bad.test(everything), `${bad} is nowhere on screen`);

    // ── Phone ──
    const { page: phone } = await open({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    // Its own login: a session copied to a second browser is refused its device key (409).
    await phone.goto(await daemon.loginUrl());
    await phone.waitForURL(`http://127.0.0.1:${port}/`);
    await hangul(phone);
    // T-0036: an office label is only the name until tapped; the words are on the 현황판.
    await shown(phone, 'docs-site');
    await phone.waitForTimeout(800);
    await shot(phone, 'vanilla-phone');
    await phone
      .locator('[data-hud-id^="icon:"]')
      .getByRole('button', { name: '현황판', exact: true })
      .click();
    await phone.getByLabel('현황판 화면').waitFor();
    // The words come and go with the session (a tool phrase, then 생각 중, or a permission wait after 7 s):
    // what this page shows on the phone is each session's "지금 하는 일" line.
    await shown(phone, '지금 하는 일');
    await phone.waitForTimeout(500);
    await shot(phone, 'vanilla-phone-status');
    const phoneText = await screen(phone);
    for (const bad of NEVER_ON_SCREEN)
      check(!bad.test(phoneText), `phone: ${bad} is nowhere on screen`);

    // ── What the daemon did and said ──
    const calls = fs.readFileSync(fake.claudeLog, 'utf-8').split('\n').filter(Boolean);
    check(
      calls.includes('agents --json') &&
        // The engine reads the installed CLI's model choices once (--version, --help).
        calls.every((l) => ['agents --json', '--version', '--help'].includes(l)),
      `claude was only asked \`agents --json\` and its --version/--help (${calls.length} times): no --append-system-prompt-file, --settings or --bg`,
    );
    check(
      !fs.existsSync(trapLog) && !fs.existsSync(path.join(fake.home, '.claude/settings.json')),
      'tmux, nvidia-smi and office were never run, and ~/.claude/settings.json was not created',
    );
    const log = serverLog.join('');
    check(
      /providers: claude \+ engine/.test(log),
      'the daemon ran on Claude Code and the engine, and never named office in its own log lines',
    );
    const seen = new Set(types());
    check(
      OFFICE_ONLY_MESSAGES.every((t) => !seen.has(t)) && !seen.has('ezRules'),
      `no office-only message and no ezRules without a file (${[...seen].sort().join(', ')})`,
    );
    check(
      received.filter((m) => m.type === 'usageState').every((m) => !m.claude && !m.codex),
      'ENV-2: usage without any source is unknown (null), no numbers made up',
    );
    const officeState = [...received].reverse().find((m) => m.type === 'officeSnapshot') as
      { orchestrators: unknown[] } | undefined;
    check(
      officeState !== undefined &&
        !('capabilities' in officeState) &&
        !('ops' in officeState) &&
        officeState.orchestrators.length === 3,
      'officeState: no office commands, no ops agent, three sessions',
    );
    const hw = received.find((m) => m.type === 'hwSample') as Record<string, unknown> | undefined;
    check(
      hw !== undefined &&
        hw.gpuTempC === undefined &&
        hw.vramTotalMib === undefined &&
        hw.stale === false,
      'hwSample from the built-in sampler: no GPU field, none made up',
    );

    // ── The user's own ez-rules.json ──
    received.length = 0;
    fs.mkdirSync(path.dirname(ezRulesPath(fake.home)), { recursive: true });
    fs.writeFileSync(
      ezRulesPath(fake.home),
      JSON.stringify({
        commands: [
          { program: ['npm'], subContains: ['test'], emoji: '✅', text: '검증하는 중' },
          { program: ['office'], sub: ['codex'], emoji: '🧑', text: '외주 맡기는 중' },
          { program: ['make'], emoji: '🔧', text: 'x'.repeat(17) }, // too long: ignored, logged once
        ],
        tools: [{ tool: ['Read'], emoji: '👀', text: '살펴보는 중' }],
      }),
    );
    // Fresh tool calls, so no 7 s "waiting for permission" bubble has taken over a label.
    fs.appendFileSync(
      api,
      record({ name: 'Read', input: { file_path: `${work('api')}/src/b.ts` } }),
    );
    fs.appendFileSync(docs, record({ name: 'Bash', input: { command: 'npm test' } }));
    fs.appendFileSync(web, record({ name: 'Bash', input: { command: 'office codex fix bug' } }));
    const { page: again } = await open({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 1,
    });
    await again.goto(await daemon.loginUrl());
    await again.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(again); // T-0108: a desktop starts with icons only
    await hangul(again);
    await shown(again, '✅ 검증하는 중');
    await shown(again, '🧑 외주 맡기는 중');
    await shown(again, '👀 살펴보는 중');
    await again.waitForTimeout(800);
    check(
      true,
      'a new page speaks with the user rules: ✅ 검증하는 중, 🧑 외주 맡기는 중, 👀 살펴보는 중',
    );
    check(
      !(await screen(again)).includes('🧪 시험 돌리는 중'),
      'the rule replaced the built-in phrase for npm test',
    );
    const old = await screen(page);
    check(
      old.includes('📖 자료 읽는 중') && !old.includes('👀'),
      'the page that was already open keeps the built-in table until it reloads',
    );
    await shot(again, 'vanilla-user-rules');
    check(
      types().filter((t) => t === 'ezRules').length === 1,
      'the daemon sent ezRules once to the new client',
    );
    const rulesLog = serverLog
      .join('')
      .split('\n')
      .filter((l) => l.includes('ez-rules.json'));
    check(
      rulesLog.length === 1 &&
        rulesLog[0].includes('commands[2]') &&
        rulesLog[0].includes('longer than 16'),
      `the broken entry was logged once, and only it: ${rulesLog[0]}`,
    );
    // T-0059 negative control: no plugin file and no usage source yet, so no numbers.
    const noUsage = await screen(again);
    check(
      noUsage.includes('Claude 사용량 알 수 없음') && !/\b5h\b|\b7d\b/.test(noUsage),
      'without any usage source the top bar says Claude 사용량 알 수 없음 and shows no numbers',
    );
    // T-0059: 프로젝트 현황 on a plain Claude session without office, from its own git folder.
    const card = await openProjectStatus(again, 'api-refactor');
    await shown(again, '브랜치 main');
    const statusText = await card.innerText();
    check(
      statusText.includes('브랜치 main · 변경 1건') && statusText.includes('first api commit'),
      '프로젝트 현황 (no office): branch main, 1 change, the last commit subject',
    );
    // T-0063: no command runs here, so the label promises only the commits.
    check(
      statusText.includes('프로젝트 현황 — 최근 커밋') && !statusText.includes('현황 명령'),
      '프로젝트 현황 (no office): the label says 최근 커밋, not a 현황 명령',
    );
    await shot(again, 'vanilla-project-status');
    check(!fs.existsSync(trapLog), 'the local report ran no office, tmux or nvidia-smi');

    // T-0059: the daemon restarts with a fake plugin in HOME; the strip shows its numbers.
    for (const p of [page, phone, again]) await p.context().close(); // no reconnect noise
    await daemon.stop();
    const plugin = path.join(
      fake.home,
      '.claude/plugins/cache/claude-dashboard/claude-dashboard/9.9.9/dist/check-usage.js',
    );
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    fs.writeFileSync(
      plugin,
      `console.log(JSON.stringify({ claude: { fiveHourPercent: 42, sevenDayPercent: 16 }, codex: { fiveHourPercent: 35, sevenDayPercent: 6 } }));\n`,
    );
    second = startDaemon(fake, port, daemonArgs, { PATH: traps });
    const { page: withPlugin } = await open({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 1,
    });
    await withPlugin.goto(await second.loginUrl());
    await withPlugin.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(withPlugin); // T-0108: a desktop starts with icons only
    await hangul(withPlugin);
    await shown(withPlugin, '42%');
    const bar = await screen(withPlugin);
    check(
      /Claude\s*5h\s*42%[\s\S]*7d\s*16%[\s\S]*Codex\s*5h\s*35%[\s\S]*7d\s*6%/.test(bar),
      'with the plugin the top bar shows Claude 5h 42% 7d 16% and Codex 5h 35% 7d 6%',
    );
    await shot(withPlugin, 'vanilla-usage-strip');
    check(
      types().includes('usageState') && !fs.existsSync(trapLog),
      'the usageState came from the plugin alone (office traps still silent)',
    );
    check(
      problems.length === 0,
      `no page error or console error in any page${problems.map((p) => `\n  ${p}`).join('')}`,
    );

    fs.writeFileSync(path.join(OUT, 'fake-claude-calls.txt'), `${calls.join('\n')}\n`);
    fs.writeFileSync(path.join(OUT, 'ws-message-types.txt'), `${[...seen].sort().join('\n')}\n`);
    fs.writeFileSync(
      path.join(OUT, 'trap-log.txt'),
      '(empty: tmux, nvidia-smi and office were never run)\n',
    );
  } finally {
    await browser?.close();
    await second?.stop();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(force);
    }
    clearTimeout(deadline);
    fs.writeFileSync(
      path.join(OUT, 'daemon-log.txt'),
      serverLog
        .join('')
        .replaceAll(fake.home, '<fake-home>')
        .replace(/code=[^\s&]+/g, 'code=<redacted>'),
    );
    fs.rmSync(fake.home, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

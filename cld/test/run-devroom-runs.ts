/**
 * DV2 개발실 실행 row, end to end: dist/cli.js in a temp HOME on one of ports 19120-19129, a temp
 * repository whose package.json has a failing `test`, a `dev` that prints `Local: http://localhost:<free
 * port>/`, a `typecheck` that passes and a `lan` that names only a LAN address; the engine's fake claude
 * as Lead `shop-web` and Worker `web-worker` on Task T-1's worktree (never a real claude). The owner
 * picks the scripts (nothing runs before), presses 테스트 (exit 1 in the worktree's folder, the issue's
 * testsPassed observed false, the merge pre-check line), 개발 서버 (its address offered and handed to
 * 미리보기; the LAN one never offered), sends the failed lines to web-worker, and 멈추기 signals only the
 * dev job's own processes (CLD_GUI_TEST_FAKE_KILL: the daemon writes the signals to a file, never sends
 * them; the scripts end by themselves). Desktop 1600x1000 and 1024x700 in 모던, one 픽셀 감성 shot, the
 * phone's 실행 page at 390x844. Screenshots in cld/artifacts/feat-devroom-runs/.
 *
 *   taskset -c 4,5 nice -n 10 npx tsx cld/test/run-devroom-runs.ts <port 19120-19129>
 */
import type { Browser, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import type { WorktreeRecord } from '../../server/src/cld/engine/git/worktrees.js';
import { jobsDir } from '../../server/src/cld/engine/jobs.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 19120 && port <= 19129)) throw new Error('port: 19120-19129');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/feat-devroom-runs');
const DEADLINE_MS = 300_000;
/** The scripts end by themselves (the stop is fake): never longer than this. */
const SCRIPT_LIFE_MS = 90_000;
let oks = 0;
const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => boolean, timeout = 30_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

const SCRIPTS: Record<string, string> = {
  'test.mjs': `console.log('cwd=' + process.cwd());
console.log(' FAIL  src/shop/cart.test.ts > sumPrice > adds item prices');
console.log('AssertionError: expected 3000 to be 3500');
console.log(' Test Files  1 failed | 3 passed (4)');
process.exit(1);
`,
  'dev.mjs': `import http from 'node:http';
const s = http.createServer((_q, r) => r.end('<h1>shop-web dev</h1>'));
s.listen(0, '127.0.0.1', () => console.log('  VITE v6.3.5  ready\\n\\n  ➜  Local:   http://localhost:' + s.address().port + '/'));
setTimeout(() => process.exit(0), ${SCRIPT_LIFE_MS});
`,
  'lan.mjs': `console.log('  ➜  Local:   http://192.168.1.5:5199/');
setTimeout(() => process.exit(0), ${SCRIPT_LIFE_MS});
`,
  'ok.mjs': `console.log('no type errors');\n`,
};

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const killLog = path.join(home, 'fake-kill.log');
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const repo = makeTempRepo();
  const folder = repo.folder;
  for (const [name, text] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(folder, name), text);
  fs.writeFileSync(
    path.join(folder, 'package.json'),
    JSON.stringify({ name: 'shop-web', scripts: { dev: 'node dev.mjs', test: 'node test.mjs', typecheck: 'node ok.mjs', lan: 'node lan.mjs', pretest: 'echo PRE-SCRIPT-RAN' } }, null, 2),
  );
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'scripts']);
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'shop-web', folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({ v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] }),
  );
  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    {
      PATH,
      CLD_GUI_TEST_FAKE_KILL: killLog,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@localhost',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@localhost',
      LANG: 'C.UTF-8',
    },
    true,
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], { env: { PATH, HOME: home, CLD_OUTPUT: 'json' }, encoding: 'utf8', timeout: 60_000 });
    const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout || '{}') as Record<string, any>;
    const session = (name: string) =>
      fs.readdirSync(path.join(home, '.claude/sessions')).some((file) => {
        try {
          return (JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as { name: string }).name === name;
        } catch {
          return false;
        }
      });
    const typed = () => {
      const file = path.join(home, 'fake-claude-typed.log');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string }) : [];
    };
    const jobRecords = () =>
      fs.readdirSync(jobsDir(home)).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(jobsDir(home), n), 'utf8')) as Record<string, any>);
    const task = () => (JSON.parse(fs.readFileSync(path.join(cfg, 'tasks.json'), 'utf8')) as { tasks: Array<Record<string, any>> }).tasks.find((x) => x.id === 'T-1')!;

    await daemon.loginUrl();
    await eventually('the Lead revived', () => session('shop-web'));
    check(json(cli('worker', 'add', 'shop-web', 'web-worker')).ok === true, 'Worker web-worker added');
    check(json(cli('task', 'add', '장바구니 합계 계산 분리', '--project', 'shop-web', '--assignee', 'web-worker', '--status', 'doing')).task?.id === 'T-1', 'Task T-1');
    check(json(cli('worktree', 'new', '--task', 'T-1', '--assign', 'web-worker')).ok === true, 'T-1 gets a worktree');
    const wt = (JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[]).find((r) => r.taskId === 'T-1')!;
    // One commit ahead of main, so the 머지 tab shows its pre-check list.
    fs.writeFileSync(path.join(wt.path, 'cart.ts'), 'export const sumPrice = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n');
    repo.git(['add', '-A'], wt.path);
    repo.git(['commit', '-q', '-m', 'sumPrice'], wt.path);
    check(json(cli('worker', 'start', 'web-worker')).ok === true, 'web-worker started');
    await eventually('web-worker live', () => session('web-worker'), 60_000);

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const newPage = async (opts: Parameters<Browser['newContext']>[0], theme = 'modern') => {
      const ctx = await browser!.newContext(opts);
      await ctx.addInitScript(([v, th]) => {
        localStorage.setItem('cld.changelogSeen', v);
        localStorage.setItem('cld.ui-theme', th);
      }, [seen, theme]);
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const openDevroom = async (p: Page) => {
      await p.locator('[data-hud-id="icon:devroom"] button').click();
      const win = p.locator('[data-hud-window="devroom"]');
      await win.waitFor({ timeout: 20_000 });
      await win.getByTestId('hud-title-devroom').dblclick();
      await win.locator(`[data-testid="devroom-card"][data-task="${wt.task}"]`).click();
      await win.getByTestId('run-row').waitFor();
      return win;
    };

    // ── Desktop 1600x1000: pick the scripts; nothing has run. ──
    const desk = await newPage({ viewport: { width: 1600, height: 1000 } });
    const win = await openDevroom(desk);
    await win.getByTestId('run-pick-open').waitFor({ timeout: 20_000 });
    check((await win.getByTestId('run-row').innerText()).includes('실행 단추를 아직 안 골랐어요'), 'the row asks for picks first');
    await win.getByTestId('run-pick-open').click();
    const picker = desk.getByTestId('run-picker');
    for (const [script, role] of [['dev', 'dev'], ['test', 'test'], ['typecheck', 'typecheck'], ['lan', 'other']])
      await picker.locator(`select[data-script="${script}"]`).selectOption(role);
    await shot(desk, 'desktop-picker');
    await picker.getByTestId('run-pick-save').click();
    await win.locator('[data-testid="run-chip"]').nth(3).waitFor({ timeout: 10_000 });
    const chips = await win.getByTestId('run-chip').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-script')}:${e.getAttribute('data-state')}`));
    check(chips.join() === 'dev:none,test:none,typecheck:none,lan:none', `the picked scripts are buttons, none run yet (${chips.join(', ')})`);
    check(jobRecords().length === 0, 'picking ran nothing');
    const stored = JSON.parse(fs.readFileSync(path.join(cfg, 'run-scripts.json'), 'utf8')) as Record<string, any>;
    check(stored.projects['shop-web'].find((p: { script: string }) => p.script === 'test').cmd === 'node test.mjs', "the picks are kept in the daemon's config with their command");

    // ── 개발 서버: its loopback address goes to 미리보기. ──
    const chip = (s: string) => win.locator(`[data-testid="run-chip"][data-script="${s}"]`);
    await chip('dev').click();
    const pane = win.getByTestId('run-pane');
    const offer = pane.getByTestId('run-offer');
    await offer.waitFor({ timeout: 30_000 });
    const devUrl = (await offer.getAttribute('data-url'))!;
    check(/^http:\/\/localhost:\d+\/$/.test(devUrl), `the dev server's address is offered (${devUrl})`);
    const devJob = jobRecords().find((r) => r.run?.script === 'dev')!;
    check(devJob.dir === wt.path && devJob.cmd === 'npm run --ignore-scripts dev', `dev ran in the worktree's folder (${devJob.dir}) as the picked script`);

    // ── 테스트: exit 1 in the worktree, observed on the issue. ──
    await chip('test').click();
    const drawer = win.getByTestId('run-drawer');
    await desk.waitForFunction(() => document.querySelector('[data-testid="run-drawer"]')?.getAttribute('data-state') === 'failed', undefined, { timeout: 30_000 });
    check((await drawer.getAttribute('data-exit')) === '1', 'the failing test ends with exit code 1');
    await desk.waitForFunction(() => document.querySelector('[data-testid="run-drawer"] [data-testid="run-log"]')?.textContent?.includes('AssertionError'), undefined, { timeout: 15_000 });
    const testLog = fs.readFileSync(jobRecords().find((r) => r.run?.script === 'test')!.log, 'utf8');
    check(testLog.includes(`cwd=${wt.path}`), `the test ran in the worktree's folder (${wt.path})`);
    check(!testLog.includes('PRE-SCRIPT-RAN'), "npm ran without the package's pretest script");
    check((await chip('test').innerText()).includes('실패 · 종료 코드 1'), `the chip says it (${(await chip('test').innerText()).replace(/\s+/g, ' ')})`);
    await eventually('T-1 observed', () => task().testsPassed?.source === 'observed');
    check(task().testsPassed.value === false && task().testsRan.value === true, `T-1 testsPassed = ${JSON.stringify(task().testsPassed)}`);
    check((await win.getByTestId('devroom-runs').innerText()).includes('실행 1개'), 'the footer counts the run going');
    await desk.waitForTimeout(500);
    await shot(desk, 'desktop-1600-d2');

    // ── 보내기: the failed lines go to web-worker only on the press. ──
    check(!typed().some((x) => x.text.includes('AssertionError')), 'nothing was sent by itself');
    await drawer.getByTestId('run-send').click();
    await eventually('web-worker got the failed lines', () => typed().some((x) => x.text.includes('AssertionError: expected 3000 to be 3500')), 60_000);
    check(true, 'web-worker 에게 보내기 sends the failed lines through the messenger');

    // ── 미리보기: the offered address fills the tab. ──
    await pane.getByTestId('run-open-preview').click();
    await win.getByTestId('preview').waitFor();
    check((await win.getByTestId('preview').getAttribute('data-url')) === devUrl, 'the address lands in 미리보기');
    await desk.waitForTimeout(800);
    await shot(desk, 'desktop-preview');
    await win.locator('[role="tab"][data-tab="terminal"]').click();

    // ── A LAN address is never offered. ──
    await chip('lan').click();
    await desk.waitForFunction(() => document.querySelector('[data-testid="run-pane"] [data-testid="run-log"]')?.textContent?.includes('192.168.1.5'), undefined, { timeout: 30_000 });
    await desk.waitForTimeout(500);
    check((await pane.getByTestId('run-offer').count()) === 0, 'a non-loopback address is not offered to 미리보기');
    check((await win.getByTestId('devroom-runs').innerText()).includes('실행 2개'), 'the footer counts two runs');

    // ── 멈추기: only the dev job's own processes (fake kill). ──
    await chip('dev').click(); // running: opens its pane again
    await pane.getByTestId('run-stop').click();
    await eventually('the stop was asked', () => fs.existsSync(killLog));
    const pid = devJob.pid as number;
    const signals = fs.readFileSync(killLog, 'utf8').trim().split('\n');
    const ours = (target: number) => {
      const p = Math.abs(target);
      if (p === pid) return true;
      try {
        return Number(fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ').pop()!.split(' ')[1]) === pid;
      } catch {
        return false;
      }
    };
    check(signals.length > 0 && signals.every((l) => ours(Number(l.split(' ')[0])) && l.endsWith('SIGTERM')), `멈추기 signals only the dev job (pid ${pid}) and its children: ${signals.join(' | ')}`);
    check(jobRecords().find((r) => r.id === devJob.id)?.stopped === true, 'the dev job is recorded as stopped by the owner');

    // ── 머지 tab: the observed test line. ──
    await win.locator('[role="tab"][data-tab="merge"]').click();
    const testsCheck = win.locator('[data-testid="merge-check"][data-check="tests"]');
    await testsCheck.waitFor({ timeout: 30_000 });
    check((await testsCheck.innerText()).includes('테스트 실행 · 종료 코드 1'), `the merge pre-check shows the observed test (${(await testsCheck.innerText()).trim()})`);
    await shot(desk, 'desktop-merge-precheck');
    await win.locator('[role="tab"][data-tab="terminal"]').click();
    await chip('typecheck').click();
    await desk.waitForFunction(() => document.querySelector('[data-testid="run-chip"][data-script="typecheck"]')?.getAttribute('data-state') === 'ok', undefined, { timeout: 30_000 });
    check((await chip('typecheck').innerText()).includes('성공'), 'a passing script reads 성공');

    // ── 1024x700 and 픽셀 감성. ──
    const small = await newPage({ viewport: { width: 1024, height: 700 } });
    const w2 = await openDevroom(small);
    await w2.locator('[data-testid="run-chip"][data-script="test"]').waitFor({ timeout: 20_000 });
    await small.waitForTimeout(500);
    await shot(small, 'desktop-1024');
    const pixel = await newPage({ viewport: { width: 1600, height: 1000 } }, 'pixel');
    const w3 = await openDevroom(pixel);
    await w3.locator('[data-testid="run-chip"][data-script="test"]').waitFor({ timeout: 20_000 });
    await w3.locator('[data-testid="run-chip"][data-script="lan"]').click();
    await w3.getByTestId('run-pane').waitFor();
    await pixel.waitForTimeout(800);
    await shot(pixel, 'desktop-pixel');

    // ── Phone 390x844: the 실행 page. ──
    const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    const list = phone.getByTestId('devroom-phone');
    const pcard = list.locator(`[data-testid="devroom-card"][data-task="${wt.task}"]`);
    await pcard.waitFor({ timeout: 20_000 });
    await pcard.locator('b').tap();
    await pcard.locator('[data-page="runs"]').tap();
    const runs = phone.getByTestId('run-phone');
    await runs.locator('[data-testid="run-card"]').nth(3).waitFor({ timeout: 20_000 });
    await phone.waitForFunction(() => document.querySelector('[data-testid="run-card"][data-script="test"] [data-testid="run-log"]')?.textContent?.includes('AssertionError'), undefined, { timeout: 15_000 });
    const states = await runs.getByTestId('run-card').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-script')}:${e.getAttribute('data-state')}`));
    check(states.includes('test:failed') && states.includes('typecheck:ok'), `phone: the 실행 page (${states.join(', ')})`);
    await phone.waitForTimeout(400);
    await shot(phone, 'phone-runs');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(OUT, 'daemon.log.txt'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    repo.cleanup();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

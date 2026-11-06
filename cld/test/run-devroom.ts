/**
 * P4-S2, the 개발실 (dev room), end to end: dist/cli.js in a temp HOME on a spare port, a temp
 * repository, the engine's fake claude as Lead `shop-web` and four Workers (never a real claude).
 * Four Tasks get worktrees like mockups-1101/devroom-W1b: web-worker busy on its turn, api-worker's
 * Task in review, ui-worker resting, docs-worker's branch merged into main and its Task done.
 * Desktop (Chromium --disable-gpu, 1280x800): the dock opens the dev room, the filter narrows it to
 * shop-web, the cards wear their chips (merged dimmed, last), the `…` menu opens (W1b), 머지 selects
 * the 머지 tab; the messenger's ⌘ opens it on the Lead's trunk; the 작업실 task card opens it on its
 * worktree; "+ 새 작업 맡기기" reaches the Lead. Phone (390x844, touch): the list with a card
 * expanded to 터미널 / 변경 / 머지 (W5). P4-TERM: the Workers run in our PTY host (claude-pty, the
 * default for `worker add`): the picked web-worker's pane on the 터미널 board shows its fake TUI, two
 * sub-agents written into its transcript are listed behind its `서브 2` chip, the footer shows the
 * daemon's stats; the phone's 터미널 sub-page shows the same terminal and the same chip.
 * DEVROOM-PHONE (owner 11-01 13:30): ui-worker's Task conflicts with main, a second project
 * (api-server) shows the phone's project chips, and 30 old Codex worktrees with no Task fold into
 * one `쉬는 작업 30개` row; the phone (390x844 and 360x780) shows compact cards, needs-you first,
 * and every sub-page (터미널, 변경, 머지, 미리보기). Screenshots in cld/artifacts/devroom-phone/
 * (w5-vs-now.png: the mock-up beside the phone's list).
 * DEVROOM-NAMES (owner 11-01 16:23): one old Codex run is bound to a temp employee in the roster and
 * changed 15 files, another has a record but no binding (it gets one of the project's employees, kept
 * in its record): their cards show the employee's name and face; the phone's 변경 file tabs show
 * readable names in one row that scrolls sideways.
 *
 *   nice -n 10 npx tsx cld/test/run-devroom.ts <port 18262|18263> [artifacts folder, default devroom-phone]
 */
import type { Browser, Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ACTIVE_STAFF_NAMES, staffName } from '../../core/src/cld/staffNames.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import { codexDir, type CodexRecord, readCodex } from '../../server/src/cld/engine/codex.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import type { WorktreeRecord } from '../../server/src/cld/engine/git/worktrees.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openWorkbenchTab,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18262 && port !== 18263) throw new Error('port: 18262 or 18263');
const OUT = path.join(REPO_ROOT, 'cld/artifacts', process.argv[3] ?? 'devroom-phone');
/** DEVROOM-NAMES: the bound run (15 files) and the one with a record but no binding. */
const BOUND = 'codex-1022-130111';
const UNBOUND = 'codex-1022-130211';
const MANY = 15;
const EMPLOYEE = { id: 'emp-1', nameId: ACTIVE_STAFF_NAMES[0].id };
const EMPLOYEE_NAME = staffName(EMPLOYEE.nameId, 'ko');
const STALE = 30;
const DEADLINE_MS = 300_000;
let oks = 0;
const notes: string[] = [];

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

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[]): Rec => ({ type: 'assistant', message: { model: 'claude-opus-4-5', content } });
const result = (id: string): Rec => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const sub = (parent: string, msg: Rec): Rec => ({ type: 'progress', parentToolUseID: parent, data: { type: 'agent_progress', message: msg } });

const WORK = [
  { worker: 'web-worker', title: '장바구니 합계 계산 분리', file: 'src/shop/Cart.ts', text: 'export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n' },
  { worker: 'api-worker', title: '로그인 속도 제한', file: 'src/api/rate.ts', text: 'export const LIMIT = 5;\n' },
  { worker: 'ui-worker', title: '결제 화면 문구 정리', file: 'src/ui/pay.txt', text: '결제하기\n' },
  { worker: 'docs-worker', title: 'README 오타 수정', file: 'README.md', text: '# shop-web\n' },
];

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const repo = makeTempRepo();
  const folder = repo.folder;
  const repo2 = makeTempRepo();
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [
        { projectId: 'p_aaaaaaaaaa', name: 'shop-web', folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' },
        { projectId: 'p_bbbbbbbbbb', name: 'api-server', folder: repo2.folder, room: '개발실', leadAssignmentId: 'a_bbbbbbbbbb' },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({ v: 1, assignments: [
        { assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true },
        { assignmentId: 'a_bbbbbbbbbb', projectId: 'p_bbbbbbbbbb', role: 'lead', provider: 'claude', wantRunning: true },
      ],
    }),
  );
  // DEVROOM-NAMES: shop-web's one temp employee, bound to BOUND's Codex run (ended).
  fs.writeFileSync(
    path.join(cfg, 'roster.json'),
    JSON.stringify({ v: 1, projects: { 'shop-web': {
      employees: [{ id: EMPLOYEE.id, nameId: EMPLOYEE.nameId, hiredAt: 1, lastReleasedAt: 2, execution: null }],
      executions: { [`codex:1022-130111-run`]: { employee: EMPLOYEE.id, started: 1, ended: 2, endedBy: 'end', paid: [] } },
    } } }),
  );
  const codexRecords = codexDir(home, 'linux', {});
  fs.mkdirSync(codexRecords, { recursive: true });
  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  // A long fake turn: web-worker stays busy (작업 중) after the one message it gets.
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    {
      PATH,
      FAKE_TURN_MS: '240000',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      // The conflict pre-check merges in a scratch index: git wants a committer.
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
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
        env: { PATH, HOME: home, CLD_OUTPUT: 'json' },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout || '{}') as Record<string, any>;
    const session = (name: string) =>
      fs.readdirSync(path.join(home, '.claude/sessions')).some((file) => {
        try {
          return (JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as { name: string }).name === name;
        } catch {
          return false;
        }
      });
    /** The fake TUI's transcript of the agent named `name` (its session file has its id and folder). */
    const transcriptOf = (name: string): string | undefined => {
      for (const file of fs.readdirSync(path.join(home, '.claude/sessions'))) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as { name: string; sessionId: string; cwd: string };
          if (s.name === name) return path.join(home, '.claude/projects', s.cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${s.sessionId}.jsonl`);
        } catch {
          /* written as we read */
        }
      }
      return undefined;
    };
    const typed = () => {
      const file = path.join(home, 'fake-claude-typed.log');
      return fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string })
        : [];
    };
    await daemon.loginUrl();
    await eventually('the Lead revived', () => session('shop-web'));

    const wts: WorktreeRecord[] = [];
    for (const [i, w] of WORK.entries()) {
      check(json(cli('worker', 'add', 'shop-web', w.worker)).ok === true, `Worker ${w.worker} added`);
      const id = json(cli('task', 'add', w.title, '--project', 'shop-web', '--assignee', w.worker, '--status', 'doing')).task?.id as string;
      check(id === `T-${i + 1}`, `Task ${id} for ${w.worker}`);
      check(json(cli('worktree', 'new', '--task', id, '--assign', w.worker)).ok === true, `${id} gets a worktree for ${w.worker}`);
      const wt = (JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[]).find((r) => r.taskId === id)!;
      fs.mkdirSync(path.dirname(path.join(wt.path, w.file)), { recursive: true });
      fs.writeFileSync(path.join(wt.path, w.file), w.text);
      repo.git(['add', '-A'], wt.path);
      repo.git(['commit', '-q', '-m', w.title], wt.path);
      wts.push(wt);
    }
    // docs-worker's branch went into main by hand, its Task is done: ✔ 머지됨, dimmed, last.
    repo.git(['merge', '-q', '--no-edit', wts[3].branch], folder);
    check(json(cli('task', 'update', 'T-4', '--status', 'done')).ok === true, 'T-4 done (merged into main)');
    check(json(cli('task', 'update', 'T-2', '--status', 'review')).ok === true, 'T-2 in review');
    // ui-worker's file also lands on main, written differently: T-3 conflicts (! 충돌 1파일).
    fs.mkdirSync(path.join(folder, 'src/ui'), { recursive: true });
    fs.writeFileSync(path.join(folder, WORK[2].file), 'pay now\n');
    repo.git(['add', '-A'], folder);
    repo.git(['commit', '-q', '-m', 'main writes pay.txt'], folder);
    // 30 old Codex runs' worktrees (10-22, no Task, nobody, one commit that day), as on the owner's phone.
    const root = repo.git(['rev-list', '--max-parents=0', 'HEAD'], folder).trim();
    const records = JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[];
    for (let i = 0; i < STALE; i++) {
      const task = `codex-1022-13${String(i).padStart(2, '0')}11`;
      const at = `2026-10-22T13:${String(i).padStart(2, '0')}:11`;
      const wtPath = path.join(path.dirname(wts[0].path), task);
      repo.git(['worktree', 'add', '-q', '-b', `codex/${task}`, wtPath, root], folder);
      if (task === BOUND) {
        const names = ['CODEX_PROGRESS.md', 'reviewNotes.ts', 'appearance.ts', 'notifications.tsx', 'navigation.ts', 'messengerStore.ts', 'constants.ts', 'characters.ts', 'officeStore.ts', 'CharacterMugShot.tsx', 'ChatComposer.tsx', 'kindLabels.ts', 'notices.ts', 'HardwarePanel.tsx', 'settings.ts'];
        for (const [n, name] of names.slice(0, MANY).entries()) {
          fs.mkdirSync(path.join(wtPath, `src/m${n}`), { recursive: true });
          fs.writeFileSync(path.join(wtPath, `src/m${n}`, name), `// ${name}\n`);
        }
        repo.git(['add', '-A'], wtPath);
      }
      if (task === BOUND || task === UNBOUND) {
        const id = task === BOUND ? '1022-130111-run' : '1022-130211-run';
        const rec: CodexRecord = {
          id, project: 'shop-web', model: null, state: 'done', dir: wtPath, worktree: wtPath, branch: `codex/${task}`, base: null,
          spec: 'spec.md', started: at, ended: at, exit: 0, resetAt: null, sid: null, commits: 1, jobId: id, log: 'x.log', pid: null, source: 'cli',
        };
        fs.writeFileSync(path.join(codexRecords, `${id}.json`), JSON.stringify(rec));
      }
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'codex run'], {
        cwd: wtPath,
        stdio: 'ignore',
        env: {
          ...process.env,
          HOME: home,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'Codex',
          GIT_AUTHOR_EMAIL: 'codex@example.com',
          GIT_COMMITTER_NAME: 'Codex',
          GIT_COMMITTER_EMAIL: 'codex@example.com',
          GIT_AUTHOR_DATE: at,
          GIT_COMMITTER_DATE: at,
        },
      });
      records.push({ project: 'shop-web', task, path: wtPath, branch: `codex/${task}`, base: wts[0].base, created: new Date(at).toISOString(), status: 'active', createdBy: 'agent:codex' });
    }
    fs.writeFileSync(path.join(cfg, 'worktrees.json'), JSON.stringify(records, null, 2));
    check(true, `${STALE} old Codex worktrees recorded`);
    for (const w of WORK) {
      check(json(cli('worker', 'start', w.worker)).ok === true, `${w.worker} started`);
      await eventually(`${w.worker} live`, () => session(w.worker));
    }
    const sent = cli('send', 'web-worker', '장바구니 합계 계산을 sumPrice 로 분리해 주세요');
    await eventually(`web-worker typed its message (${sent.stdout}${sent.stderr})`, () => typed().some((x) => x.text.includes('sumPrice')), 60_000);
    check(true, 'web-worker is in its turn');

    browser = await launchBrowser();
    // The "v0.x 으로 업데이트됐어요" toast would cover the screenshots: this version's notes count as seen.
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const newPage = async (b: Browser, opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await b.newContext(opts);
      await ctx.addInitScript((v) => localStorage.setItem('cld.changelogSeen', v), seen);
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

    // ── Desktop: the dock's ⌘ opens the window; the filter narrows it to shop-web. ──
    const desk = await newPage(browser, { viewport: { width: 1280, height: 800 } });
    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.waitFor({ timeout: 20_000 });
    check(true, 'the dock ⌘ icon opens the 개발실 window');
    await win.getByTestId('hud-title-devroom').dblclick(); // maximized, like the mock-up's window
    await win.getByTestId('devroom-filter').click();
    await win.getByRole('menuitemradio', { name: 'shop-web' }).click();
    check((await win.getByTestId('hud-title-devroom').innerText()).includes('개발실 / shop-web'), 'the title names the filtered project');
    const card = (task: string) => win.locator(`[data-testid="devroom-card"][data-task="${task}"]`);
    await card(wts[3].task).waitFor({ timeout: 20_000 });
    const order = await win.getByTestId('devroom-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-task')));
    check(order.length === 4 && order.at(-1) === wts[3].task, `four cards, the merged one last (${order.join(', ')})`);
    check((await win.getByTestId('devroom-resting').innerText()).includes(`쉬는 워크트리 ${STALE}개`), `the rail folds the ${STALE} resting Codex worktrees into one row`);
    // DEVROOM-NAMES: unfolded, the bound Codex card names its temp employee under its face.
    await win.getByTestId('devroom-resting').click();
    await card(BOUND).waitFor();
    check((await card(BOUND).getByTestId('devroom-who').innerText()) === EMPLOYEE_NAME, `desktop: ${BOUND} names ${EMPLOYEE_NAME}`);
    check((await card(BOUND).locator(`[data-employee="${EMPLOYEE.id}"] canvas`).count()) === 1, 'desktop: and shows its face');
    await card(BOUND).scrollIntoViewIfNeeded();
    await desk.waitForTimeout(300);
    await shot(desk, 'desktop-names');
    await win.getByTestId('devroom-resting').click();
    const chip = (task: string) => card(task).getByTestId('devroom-chip');
    await desk.waitForFunction((t) => document.querySelector(`[data-testid="devroom-card"][data-task="${t}"] [data-testid="devroom-chip"]`)?.getAttribute('data-chip') === 'merged', wts[3].task, { timeout: 20_000 });
    check(true, 'docs-worker wears ✔ 머지됨');
    check((await chip(wts[1].task).getAttribute('data-chip')) === 'review', 'api-worker wears ● 검토 대기');
    try {
      await desk.waitForFunction((t) => document.querySelector(`[data-testid="devroom-card"][data-task="${t}"] [data-testid="devroom-chip"]`)?.getAttribute('data-chip') === 'working', wts[0].task, { timeout: 30_000 });
      check(true, 'web-worker wears ● 작업 중 during its turn');
    } catch {
      notes.push(`web-worker's chip stayed ${await chip(wts[0].task).getAttribute('data-chip')} (its fake turn was not seen as busy)`);
    }
    // The default pick: a card that needs the owner (api-worker's review or ui-worker's conflict), never a resting one.
    const first = await win.locator('[data-testid="devroom-card"][data-picked]').getAttribute('data-task');
    check(first === wts[1].task || first === wts[2].task, `the rail picks a needs-you card by default (${first})`);
    await desk.waitForFunction((t) => document.querySelector(`[data-testid="devroom-card"][data-task="${t}"] [data-testid="devroom-chip"]`)?.getAttribute('data-chip') === 'conflict', wts[2].task, { timeout: 60_000 });
    await desk.waitForTimeout(400);
    await shot(desk, 'desktop-rail');
    await card(wts[0].task).click();
    check(await card(wts[0].task).getAttribute('data-picked'), "web-worker's card is picked");
    // P4-TERM (DEVROOM-SUBVIEW): the picked Worker's live terminal (PTY host) in the board's pane, its sub-agents behind a chip, the footer's stats.
    const col = win.locator('[data-testid="devroom-pane"][data-agent="web-worker"]');
    await col.waitFor({ timeout: 20_000 });
    check(true, 'web-worker (claude-pty) gets a pane on the board');
    // DEVROOM-PANE-CHAT: a pane opens in 대화; its 터미널 side shows the PTY.
    await col.locator('[data-testid="devroom-pane-view"][data-view="terminal"]').click();
    await desk.waitForFunction(
      () => [...document.querySelectorAll<HTMLElement>('[data-testid="devroom-pane"][data-agent="web-worker"] .xterm-rows')].some((el) => el.innerText.includes('fake Claude Code (pty) · web-worker')),
      undefined,
      { timeout: 30_000 },
    );
    check(true, "web-worker's pane shows its PTY's screen");
    const file = transcriptOf('web-worker');
    check(file && fs.existsSync(file), `web-worker's transcript (${file})`);
    const append = (records: Rec[]) => records.forEach((r) => fs.appendFileSync(file!, `${JSON.stringify(r)}\n`));
    append([
      said([call('tu-test', 'Task', { description: '테스트', prompt: 'run the cart tests' }), call('tu-tsc', 'Task', { description: '타입 검사', prompt: 'tsc' })]),
      sub('tu-test', said([call('tu-test-1', 'Bash', { command: 'npm test -- cart' })])),
      sub('tu-test', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-test-1', content: '12 passed' }] } }),
      sub('tu-test', said([call('tu-test-2', 'Read', { file_path: 'src/shop/Cart.ts' })])),
      sub('tu-tsc', said([call('tu-tsc-1', 'Bash', { command: 'tsc --noEmit' })])),
    ]);
    await desk.waitForFunction(() => document.querySelector('[data-testid="devroom-pane"][data-agent="web-worker"] [data-testid="devroom-sub-chip"]')?.textContent?.includes('2'), undefined, { timeout: 20_000 });
    await col.getByTestId('devroom-sub-chip').click();
    const subs = await col.getByTestId('devroom-sub-row').allInnerTexts();
    check(subs.length === 2 && subs[0].includes('테스트') && subs[1].includes('타입 검사'), `the 서브 2 chip lists the two sub-agents: ${subs.map((x) => x.split('\n')[0]).join(' | ')}`);
    await col.getByTestId('devroom-sub-chip').click();
    check((await win.getByTestId('devroom-term-count').innerText()).includes('서브 에이전트 2개'), 'the tab bar counts the terminals and sub-agents');
    await win.getByTestId('devroom-stats').waitFor({ timeout: 20_000 });
    const stats = await win.getByTestId('devroom-stats').innerText();
    check(/터미널 \d+개 · 데몬 메모리 약 \d+ MB/.test(stats), `the footer's stats: ${stats}`);
    // A card's `…` menu, as in W1b (the mock-up's is on the merged card, whose 머지 has nothing to do).
    await card(wts[2].task).getByTestId('devroom-more').click();
    const menu = win.getByTestId('devroom-menu');
    await menu.waitFor();
    const items = await menu.locator('[data-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-item')));
    check(items.join() === 'explorer,sync,merge,remove', `the … menu: ${items.join(', ')}`);
    await desk.waitForTimeout(400);
    await shot(desk, 'W1b-desktop');

    // 머지 in another card's menu picks it and opens the 머지 tab (S4's place).
    await desk.keyboard.press('Escape');
    await card(wts[1].task).getByTestId('devroom-more').click();
    await menu.locator('[data-item="merge"]').click();
    await win.locator('[data-testid="devroom-body"][data-tab="merge"]').waitFor();
    check(await card(wts[1].task).getAttribute('data-picked'), '머지 picks the card and opens the 머지 tab');

    // + 리드에게 새 이슈 맡기기: one line to the Lead.
    await win.getByTestId('devroom-new').click();
    const form = desk.getByTestId('devroom-new-task');
    await form.locator('input').fill('쿠폰 할인 계산 추가');
    await shot(desk, 'new-task-dialog');
    await form.getByRole('button', { name: '리드에게 보내기' }).click();
    await eventually('the Lead got the new task', () => typed().some((x) => x.text.includes('쿠폰 할인 계산 추가') && x.text.includes('worktree')), 30_000);
    check(true, 'the new task reached the Lead with the worktree hint');

    // The messenger's ⌘ opens the dev room on the Lead's trunk (mock-up I). A maximized window covers the icons.
    await win.getByTestId('hud-title-devroom').dblclick();
    await desk.getByRole('button', { name: /^메신저/ }).click();
    const messenger = desk.getByRole('region', { name: '메신저', exact: true });
    await messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^shop-web/ }).click();
    const conv = messenger.getByRole('region', { name: 'shop-web 대화' });
    await conv.getByTestId('devroom-link').click();
    await win.locator('[data-testid="devroom-trunk"][aria-pressed="true"]').waitFor({ timeout: 10_000 });
    check(true, "the messenger's ⌘ opens the dev room on the Lead (trunk)");
    await shot(desk, 'I-messenger-link');

    // The 작업실 task card's link picks its worktree.
    await openWorkbenchTab(desk, '이슈', { project: 'shop-web' });
    const wb = desk.locator('[data-hud-window="office"]');
    await wb.locator('[data-testid="task-card"][data-task-id="T-3"]').click();
    await wb.getByTestId('task-devroom').click();
    await desk.waitForFunction((t) => document.querySelector(`[data-hud-window="devroom"] [data-testid="devroom-card"][data-task="${t}"]`)?.hasAttribute('data-picked'), wts[2].task, { timeout: 10_000 });
    check(true, "the 작업실 card's ⌘ opens the dev room on its worktree");

    // ── Phone (DEVROOM-PHONE): the list, needs-you first, the resting row, every sub-page (W5). ──
    // Chromium's phone mode: this Linux WebKit draws no Galmuri (tofu).
    const phone = await newPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    const list = phone.getByTestId('devroom-phone');
    await list.waitFor({ timeout: 20_000 });
    const filter = list.getByTestId('devroom-filter');
    await filter.waitFor({ timeout: 20_000 });
    const chips = await filter.getByRole('radio').allInnerTexts();
    check(chips.join() === '모든 프로젝트,shop-web,api-server', `phone: the project chips (${chips.join(', ')})`);
    await list.locator('[data-testid="devroom-group"][data-project="api-server"]').waitFor({ timeout: 20_000 });
    await phone.waitForTimeout(400);
    await shot(phone, 'phone-filter-all');
    await filter.getByRole('radio', { name: 'shop-web' }).tap();
    await list.locator('[data-testid="devroom-group"][data-project="api-server"]').waitFor({ state: 'detached' });
    check((await list.getByTestId('devroom-back').locator('..').innerText()).includes('개발실 · shop-web'), 'phone: the shop-web chip narrows the list and the header names it');
    const pcard = (task: string) => list.locator(`[data-testid="devroom-card"][data-task="${task}"]`);
    await pcard(wts[3].task).waitFor({ timeout: 20_000 });
    await phone.waitForFunction((t) => document.querySelector(`[data-testid="devroom-card"][data-task="${t}"] [data-testid="devroom-chip"]`)?.getAttribute('data-chip') === 'conflict', wts[2].task, { timeout: 60_000 });
    check(true, 'phone: ui-worker wears ! 충돌 (the pre-check)');
    // web-worker's chip moves with its fake turn (작업 중, or ! 승인 while it waits): the order follows the chips.
    const porder = await list.getByTestId('devroom-card').evaluateAll((els) =>
      els.map((e) => [e.getAttribute('data-task'), e.querySelector('[data-testid="devroom-chip"]')?.getAttribute('data-chip')] as const),
    );
    const RANK: Record<string, number> = { conflict: 0, approve: 0, review: 0, fixing: 1, working: 1, idle: 2, merged: 3 };
    const ranks = porder.map(([, c]) => RANK[c ?? ''] ?? 9);
    check(
      porder.length === 4 && ranks.every((r, i) => i === 0 || ranks[i - 1] <= r) && porder[0][1] !== 'working' && porder[3][0] === wts[3].task,
      `phone: needs-you first, merged last; the ${STALE} Codex folders hidden (${porder.map((x) => x.join(':')).join(', ')})`,
    );
    const resting = list.getByTestId('devroom-resting');
    check((await resting.innerText()).includes(`쉬는 워크트리 ${STALE}개`), `phone: one row folds the ${STALE} resting worktrees`);
    check((await list.getByTestId('devroom-count').innerText()).includes('main 에서 3개 작업이 진행돼요'), 'phone: the count line counts the 3 active ones only');
    const tall = (await pcard(wts[0].task).boundingBox())?.height ?? 0;
    check(tall >= 56 && tall <= 74, `phone: a card is compact (${tall} px)`);
    check(await list.getByTestId('devroom-hint').isVisible(), 'phone: the first visit explains the cards in one line');
    await phone.waitForFunction(() => /\(\d+개 · [\d.]+ [KMG]?B\)/.test(document.querySelector('[data-testid="devroom-cleanup"]')?.textContent ?? ''), undefined, { timeout: 30_000 });
    check(true, `phone: the cleanup button counts and sizes (${await list.getByTestId('devroom-cleanup').innerText()})`);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `phone: no sideways scroll (${overflow})`);
    await phone.waitForTimeout(400);
    await shot(phone, 'phone-list-390');
    await list.getByTestId('devroom-hint').getByRole('button').tap();
    check((await list.getByTestId('devroom-hint').count()) === 0, 'phone: 알겠어요 puts the hint away');

    // The mock-up W5 (its left phone) beside this list.
    // The mock-ups are not committed: this checkout's, or (in a .worktrees/ checkout) the main one's.
    const w5 = [REPO_ROOT, path.resolve(REPO_ROOT, '../..')].map((r) => path.join(r, 'cld/artifacts/mockups-1101/devroom-W5.png')).find((f) => fs.existsSync(f));
    if (!w5) notes.push('no mockups-1101/devroom-W5.png here: w5-vs-now.png skipped');
    const side = w5 ? await browser.newPage({ viewport: { width: 812, height: 860 } }) : null;
    if (side && w5) {
    const b64 = (f: string) => fs.readFileSync(f).toString('base64');
    await side.setContent(
      `<body style="margin:0;background:#111;display:flex;gap:16px;padding:8px">` +
        `<div style="width:390px;height:844px;overflow:hidden"><img src="data:image/png;base64,${b64(w5)}"></div>` +
        `<img style="width:390px;height:844px" src="data:image/png;base64,${b64(path.join(OUT, 'phone-list-390.png'))}"></body>`,
    );
      await side.screenshot({ path: path.join(OUT, 'w5-vs-now.png') });
      await side.close();
    }

    await resting.tap();
    await pcard('codex-1022-130011').waitFor();
    check((await list.getByTestId('devroom-card').count()) === 4 + STALE, 'phone: 펼치기 shows the resting ones');
    const codexTitle = await pcard('codex-1022-130011').locator('b').innerText();
    check(codexTitle === '실행 · 10-22 13:00', `phone: a Codex folder reads as a label (${codexTitle})`);
    check((await pcard('codex-1022-130011').innerText()).includes('codex/codex-1022-130011'), 'phone: its branch in small text');
    // DEVROOM-NAMES: the bound run and the unbound one wear the employee's name and face.
    for (const task of [BOUND, UNBOUND]) {
      const title = await pcard(task).locator('b').innerText();
      check(title === `${EMPLOYEE_NAME} · Codex 10-22 13:${task.slice(13, 15)}`, `phone: ${task} names its temp employee (${title})`);
      check((await pcard(task).locator(`[data-employee="${EMPLOYEE.id}"] canvas`).count()) === 1, `phone: ${task} shows the employee's face`);
    }
    check(readCodex(codexRecords, '1022-130211-run')?.employee?.employeeId === EMPLOYEE.id, 'the unbound run keeps its employee in its record');
    await pcard(BOUND).scrollIntoViewIfNeeded();
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-names');
    // The 변경 page of the 15-file run: readable tabs in one sideways row.
    await pcard(BOUND).locator('b').tap();
    await pcard(BOUND).locator('[data-page="changes"]').tap();
    const tabs = phone.getByTestId('review-file-tab');
    await phone.waitForFunction((n) => document.querySelectorAll('[data-testid="review-file-tab"]').length === n, MANY, { timeout: 30_000 });
    check(true, `phone: 변경 lists the ${MANY} files as tabs`);
    const firstTab = await tabs.first().innerText();
    check(firstTab.replace('…', '').length >= 10, `phone: a tab shows a readable name (${firstTab})`);
    const row = phone.getByTestId('review-file-tabs');
    const widths = await row.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    check(widths[0] > widths[1], `phone: the tab row scrolls sideways (${widths.join(' > ')})`);
    await row.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await tabs.last().tap();
    await phone.waitForFunction(() => {
      const t = document.querySelector('[data-testid="review-file-tab"][data-on]')?.getBoundingClientRect();
      return !!t && t.left >= 0 && t.right <= window.innerWidth;
    }, undefined, { timeout: 5_000 });
    check((await tabs.last().getAttribute('data-on')) !== null, 'phone: the picked last tab is selected and in view');
    await phone.waitForTimeout(400);
    await shot(phone, 'phone-changes-15');
    await list.getByTestId('devroom-back').tap();
    await pcard(wts[0].task).waitFor();
    if ((await resting.getAttribute('aria-expanded')) !== 'true') await resting.tap();
    await pcard(BOUND).waitFor();
    await resting.scrollIntoViewIfNeeded();
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-resting-open');
    await resting.tap();

    const openSub = async (task: string, page: string, ready: string, name: string) => {
      if (!(await pcard(task).getAttribute('data-open'))) await pcard(task).locator('b').tap();
      await pcard(task).locator(`[data-page="${page}"]`).tap();
      await list.locator(`[data-testid="devroom-page"][data-page="${page}"]`).waitFor();
      await phone.locator(ready).first().waitFor({ timeout: 30_000 });
      await phone.waitForTimeout(400);
      await shot(phone, name);
    };
    await pcard(wts[0].task).locator('b').tap();
    await pcard(wts[0].task).locator('[data-page="terminal"]').waitFor();
    const pages = await pcard(wts[0].task).locator('[data-page]').evaluateAll((els) => els.map((e) => e.getAttribute('data-page')));
    check(pages.join() === 'terminal,changes,merge,runs,preview', `phone: a tapped card shows ${pages.join(' / ')}`);
    check(await pcard(wts[0].task).getByTestId('devroom-explorer').isVisible(), 'phone: and 탐색기에서 열기');
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-card-open');

    await openSub(wts[0].task, 'terminal', '[data-testid="devroom-phone-term"]', 'phone-terminal-boot');
    await phone.locator('[data-testid="devroom-phone-term"] [data-testid="devroom-pane-view"][data-view="terminal"]').tap();
    await phone.waitForFunction(
      () => [...document.querySelectorAll<HTMLElement>('[data-testid="devroom-phone-term"] .xterm-rows')].some((el) => el.innerText.includes('fake Claude Code (pty)')),
      undefined,
      { timeout: 30_000 },
    );
    check(true, "phone: 터미널 opens the sub-page with web-worker's PTY screen");
    await phone.waitForTimeout(400);
    await shot(phone, 'phone-terminal');
    await list.getByTestId('devroom-sub-chip').tap();
    check((await list.getByTestId('devroom-sub-row').count()) === 2, "phone: the 서브 2 chip lists web-worker's sub-agents");
    await list.getByTestId('devroom-back').tap();
    await pcard(wts[0].task).waitFor();
    check(true, 'phone: ‹ 뒤로 returns to the list');
    fs.rmSync(path.join(OUT, 'phone-terminal-boot.png'), { force: true });

    await openSub(wts[1].task, 'changes', '[data-testid="review-title"]', 'phone-changes');
    check(true, 'phone: 변경 opens the review sheet (R3)');
    await list.getByTestId('devroom-back').tap();
    await openSub(wts[2].task, 'merge', '[data-testid="merge-conflict"]', 'phone-merge-390');
    const conflict = await phone.getByTestId('merge-conflict').innerText();
    check(conflict.includes('PC 에서') && conflict.includes('에이전트에게 맡기기') && (await phone.getByTestId('merge-manual').count()) === 0, 'phone: 머지 shows the conflict read-only with 에이전트에게 맡기기');
    await list.getByTestId('devroom-back').tap();
    await openSub(wts[0].task, 'preview', '[data-testid="preview-phone"]', 'phone-preview');
    check(true, 'phone: 미리보기 shows the P2 notice');
    await list.getByTestId('devroom-back').tap();

    // A narrower phone: the same list, no sideways scroll.
    const narrow = await newPage(browser, { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await narrow.locator('[data-dock="devroom"]').tap();
    await narrow.locator(`[data-testid="devroom-card"][data-task="${wts[3].task}"]`).waitFor({ timeout: 20_000 });
    const over360 = await narrow.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(over360 <= 0, `phone 360: no sideways scroll (${over360})`);
    await narrow.waitForTimeout(400);
    await shot(narrow, 'phone-list-360');
    const ncard = narrow.locator(`[data-testid="devroom-card"][data-task="${wts[2].task}"]`);
    await ncard.locator('b').tap();
    await ncard.locator('[data-page="merge"]').tap();
    await narrow.getByTestId('merge-conflict').waitFor({ timeout: 30_000 });
    const box = async (sel: string) => (await narrow.locator(sel).first().boundingBox())!;
    const banner = await box('[data-testid="merge-conflict"] > div');
    const go = await box('[data-testid="merge-handoff"]');
    check(go.width >= banner.width - 40, `phone 360: 에이전트에게 맡기기 spans the banner (${Math.round(go.width)} of ${Math.round(banner.width)} px)`);
    await narrow.waitForTimeout(400);
    await shot(narrow, 'phone-merge-360');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
    for (const n of notes) console.log(`note - ${n}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom.daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    repo.cleanup();
    repo2.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

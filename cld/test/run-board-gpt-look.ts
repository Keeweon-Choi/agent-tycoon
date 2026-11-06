/**
 * The 현황판 window (A5, GPT mockup look; FEAT-BOARD-LESS: fits every size, shows less): pictures and checks. dist/cli.js in an isolated HOME on a
 * spare port, headless Chromium without a GPU, no model. The scene is run-office-hud-pc.ts's: eight fake
 * Claude sessions (working, a question, a permission, resting) as files in the temp HOME, plus fixture
 * records the daemon reads as it would its own: tasks.json (Tasks in progress, blocked, done today),
 * events.jsonl (the feed), and the jobs folder (one job running on a `sleep`, two ended). The window is
 * shot at every size of SIZES (1600x1000 maximized, the owner's ~1245 px window, the default window,
 * 1024x700) and on a 390x844 phone; at each, nothing in the board is cut or spills out of its box and a
 * cut text keeps its full text on hover. Then the dock has no 퀘스트, the issue board opens from the
 * 현황판, its cards carry no stars, the 개발 tab no HI-SCORE, and a card dragged from 할 일 to 진행 중
 * lands there with its history line. Pictures go to cld/artifacts/feat-board-less/<PREFIX>-*.png
 * (UI_THEME=pixel adds -pixel to the prefix's files through OUT_DIR, see uiTheme.ts).
 *
 *   PREFIX=after UI_THEME=modern npx tsx cld/test/run-board-gpt-look.ts <port 18940-18949>
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { outDir, themePort, UI_THEME_INIT } from './uiTheme.js';

const port = Number(process.argv[2]);
if (!((port >= 18940 && port <= 18949) || themePort(port))) throw new Error('port must be 18940-18949');
const PREFIX = process.env.PREFIX ?? 'after';
const OUT = outDir(path.resolve('cld/artifacts/feat-board-less'));
const STYLE = process.env.UI_THEME === 'pixel' ? '-pixel' : '';

const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;
const STORE: Record<string, string> = {
  'cld.title-scene': 'off',
  'cld.office-iso': 'on',
  'cld.floor': '1',
  'cld.floor-view': 'one',
};

type Mode = 'work' | 'wait' | 'perm' | 'rest';
const CREW: Array<[string, Mode, number, string[]]> = [
  ['cld-gui', 'work', 62_000, ['Edit', 'Read', 'Bash']],
  ['pofol', 'work', 118_000, ['Read', 'Grep']],
  ['wayfinder', 'work', 31_000, ['Bash', 'Edit']],
  ['aixon', 'work', 154_000, ['Write', 'Read']],
  ['neus', 'wait', 88_000, []],
  ['smartglass', 'perm', 47_000, []],
  ['savetax', 'rest', 171_000, []],
  ['keeweon', 'rest', 12_000, []],
];

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
/** Fixture Tasks (the daemon's own store format), some with reported facts for the lights. */
const TASKS = [
  ['T-42', 'cld-gui', 'P9-NOTE 공개 내보내기', 'doing', 12, true],
  ['G3', 'cld-gui', '웹뷰 세 가지(WebView2·WKWebView·WebKitGTK)와 데스크톱 앱 첫 실행의 화면 차이 정리', 'review', 25, false],
  ['T-53', 'wayfinder', 'ISO 아이소메트릭 다층 건물', 'doing', 40, false],
  ['P7', 'pofol', 'Windows 기본 데몬', 'todo', 90, false],
  ['U-39', 'aixon', '공지 전 여섯 출처 라이선스 정리', 'blocked', 33, false],
  ['T-60', 'smartglass', '렌즈 보정 값 저장', 'doing', 8, true],
  ['T-31', 'cld-gui', '배포 #34 검사설치', 'done', 50, true],
  ['T-32', 'pofol', '포트폴리오 첫 화면', 'done', 120, false],
  ['T-12', 'neus', '뉴스 요약 규칙', 'done', 60 * 30, false],
] as const;

const assistant = (content: object[], tokens: number) => ({
  type: 'assistant',
  message: {
    model: 'claude-opus-4-7',
    content,
    usage: { input_tokens: 10, cache_read_input_tokens: tokens, output_tokens: 200 },
  },
});

const statOf = (pid: number) => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
};

function session(home: string, n: number, name: string, mode: Mode) {
  const cwd = `/work/${name}`;
  const proc = spawn('sleep', ['1800'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const sessionId = `b1106000-0000-4000-8000-${String(n).padStart(12, '0')}`;
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
      procStart: statOf(pid),
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

function seedRecords(home: string, jobPid: number) {
  const cfg = configDirectory(home);
  fs.writeFileSync(
    path.join(cfg, 'tasks.json'),
    JSON.stringify({
      v: 2,
      tasks: TASKS.map(([id, project, title, status, min, facts]) => ({
        id,
        project,
        title,
        status,
        source: 'reported',
        statusSource: 'reported',
        owner: { kind: 'lead', name: project },
        createdAt: ago(min + 60),
        updatedAt: ago(min),
        ...(id === 'P7' && { priority: 'P0' }),
        history: status === 'done' ? [{ at: ago(min), by: 'cli', change: 'status doing → done' }] : [],
        ...(facts && {
          commits: { value: 3, source: 'observed', at: ago(min) },
          testsPassed: { value: true, source: 'reported', at: ago(min) },
        }),
      })),
    }),
  );
  fs.writeFileSync(
    path.join(cfg, 'events.jsonl'),
    [
      { type: 'orch_start', ts: ago(95), source: 'engine', name: 'neus', resumed: true },
      { type: 'job_end', ts: ago(46), source: 'cli', project: 'pofol', id: 'j-build', label: '빌드', exit: 1 },
      { type: 'delegate', ts: ago(34), source: 'engine', from: 'cld-gui', to: 'wayfinder', task: 'T-53' },
      { type: 'task_report', ts: ago(22), source: 'engine', from: 'cld-gui', task: 'G3', status: 'review' },
      { type: 'job_start', ts: ago(15), source: 'cli', project: 'aixon', id: 'j-train', label: '학습' },
      { type: 'job_end', ts: ago(13), source: 'cli', project: 'cld-gui', id: 'j-deploy', label: '배포 #34 검사설치', exit: 0 },
      { type: 'job_end', ts: ago(9), source: 'cli', project: 'cld-gui', id: 'j-deploy2', label: '배포 #44: 모던 테마(기본)-픽셀 감성-알림 색과 메신저 정렬·겹침 수정 검사 설치', exit: 0 },
    ]
      .map((e) => JSON.stringify({ v: 1, ...e }))
      .join('\n') + '\n',
  );
  const jobs = path.join(home, '.local/state/cld-gui/jobs');
  fs.mkdirSync(jobs, { recursive: true });
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
  const job = (id: string, project: string, desc: string, cmd: string, rec: object) => {
    fs.writeFileSync(path.join(jobs, `${id}.log`), '');
    fs.writeFileSync(
      path.join(jobs, `${id}.json`),
      JSON.stringify({ id, project, cmd, desc, dir: `/work/${project}`, tab: null, tty: false, log: path.join(jobs, `${id}.log`), boot, source: 'cli', ...rec }),
    );
  };
  job('j-train', 'aixon', '학습', 'python train.py', { pid: jobPid, pstart: statOf(jobPid), started: ago(15), ended: null, exit: null });
  job('j-deploy', 'cld-gui', '배포 #34 검사설치', './deploy.sh', { pid: null, pstart: null, started: ago(20), ended: ago(13), exit: 0 });
  job('j-build', 'pofol', '빌드', 'npm run build', { pid: null, pstart: null, started: ago(50), ended: ago(46), exit: 1 });
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const crew = CREW.map(([name, mode, tokens, tools], i) => ({
    name,
    mode,
    tokens,
    tools,
    ...session(home, i + 1, name, mode),
  }));
  const jobProc = spawn('sleep', ['1800'], { stdio: 'ignore' });
  seedRecords(home, jobProc.pid!);
  fs.writeFileSync(
    path.join(configDirectory(home), 'building.json'),
    JSON.stringify({ version: 1, perProject: false, floors: [{ id: '1', name: '1F', rooms: [], characters: [] }] }),
  );
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal', '--allow-chat'], {});
  const browser = await launchBrowser({ partyFrame: true });
  const append = (file: string, r: object) => fs.appendFileSync(file, JSON.stringify(r) + '\n');
  let tick = 0;
  let driver: NodeJS.Timeout | undefined;
  type Page = import('@playwright/test').Page;
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    const scene = () => {
      for (const c of crew) {
        if (c.mode === 'wait') {
          append(c.file, assistant([{ type: 'text', text: 'Should I also migrate the old settings?' }], c.tokens));
          append(c.file, { type: 'system', subtype: 'turn_duration', durationMs: 90_000 });
        } else if (c.mode === 'perm') {
          append(c.file, assistant([{ type: 'tool_use', id: 'tu-p', name: 'Bash', input: { command: 'git push --force' } }], c.tokens));
        } else if (c.mode === 'rest') {
          append(c.file, assistant([{ type: 'text', text: 'Done. All tests pass.' }], c.tokens));
          append(c.file, { type: 'system', subtype: 'turn_duration', durationMs: 20_000 });
        }
      }
    };
    const startDriver = () => {
      driver = setInterval(() => {
        tick++;
        for (const c of crew.filter((x) => x.mode === 'work')) {
          const tool = c.tools[Math.floor(tick / 2) % c.tools.length];
          const id = `tu-${c.name}-${Math.floor(tick / 2)}`;
          if (tick % 2 === 0) append(c.file, assistant([{ type: 'tool_use', id, name: tool, input: INPUTS[tool] }], c.tokens));
          else
            append(c.file, {
              type: 'user',
              message: { content: [{ type: 'tool_result', tool_use_id: `tu-${c.name}-${Math.floor((tick - 1) / 2)}`, content: 'ok' }] },
            });
        }
      }, 1600);
    };

    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();

    let sceneDone = false;
    const open = async (viewport: { width: number; height: number }, mobile = false, layout?: object, extra: Record<string, string> = {}) => {
      const ctx = await browser.newContext({ viewport, ...(mobile && { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }) });
      await ctx.addInitScript(INIT + UI_THEME_INIT);
      await ctx.addInitScript(
        (pairs) => {
          for (const [k, v] of pairs)
            try {
              if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
            } catch {
              // about:blank
            }
        },
        [...Object.entries({ ...STORE, ...extra }), ...(layout ? [['cld.hud.layout.v1', JSON.stringify(layout)]] : [])],
      );
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.getByTestId('office-canvas').waitFor({ timeout: 60_000 });
      if (!sceneDone) {
        sceneDone = true;
        await page.locator('[data-testid="agent-card"]').first().waitFor({ timeout: 60_000 });
        scene();
        startDriver();
      }
      await page.waitForTimeout(10_000);
      return { ctx, page };
    };
    const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${PREFIX}${STYLE}-${name}.png`) });
    const win = (page: Page) => page.locator('[data-hud-window="office"]');
    const maximize = async (page: Page) => {
      const buttons = page.locator('[data-testid="hud-title-office"] button');
      await buttons.nth((await buttons.count()) - 2).click();
      await page.waitForTimeout(800);
    };
    /**
     * Nothing in the board is cut: its scroller never scrolls sideways, no part pokes out of its box
     * (a count card, a panel) or of the board, and a text cut with … keeps its full text on hover.
     */
    const fits = async (page: Page, what: string) => {
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        const board = [...document.querySelectorAll('[data-board-look]')].find((el) => (el as HTMLElement).offsetParent !== null);
        if (!board) return ['no board on screen'];
        const scroller = board.closest('.overflow-y-auto') ?? board.parentElement!;
        if (scroller.scrollWidth > scroller.clientWidth + 1) out.push(`scrolls sideways ${scroller.scrollWidth}>${scroller.clientWidth}`);
        const outer = scroller.getBoundingClientRect();
        const name = (el: Element) => `${el.tagName.toLowerCase()}.${el.className.toString().split(' ').slice(0, 2).join('.')}`;
        for (const box of board.querySelectorAll('.sb-panel, .sb-kpi')) {
          const b = box.getBoundingClientRect();
          if (b.right > outer.right + 1 || b.left < outer.left - 1) out.push(`${name(box)} out of the window`);
          for (const el of box.querySelectorAll('*')) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && (r.right > b.right + 1 || r.left < b.left - 1)) {
              out.push(`${name(el)} pokes out of ${name(box)}`);
              break;
            }
          }
        }
        for (const el of board.querySelectorAll('*')) {
          const s = getComputedStyle(el);
          if (s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && !el.closest('[title]'))
            out.push(`cut without a hover text: ${el.textContent?.slice(0, 24)}`);
        }
        return out;
      });
      check(bad.length === 0, `${what}: nothing cut or spilling (${bad.slice(0, 6).join(' | ')})`);
    };
    /** Every count card says what it counts on hover. */
    const explained = async (page: Page, what: string) => {
      const plain = await page.evaluate(() =>
        [...document.querySelectorAll('[data-board-look] [data-testid="board-kpi"]')].filter((el) => !el.getAttribute('title')).length,
      );
      check(plain === 0, `${what}: every count card has its hover line`);
    };

    // The owner's window (11-06 17:53, about 1245 px on a 1936x1056 screen), the default window, maximized ones.
    const SIZES: Array<{ name: string; vp: { width: number; height: number }; max?: boolean; layout?: object; store?: Record<string, string> }> = [
      { name: 'pc-1600x1000-max', vp: { width: 1600, height: 1000 }, max: true },
      {
        name: 'pc-1936x1056-w1245',
        vp: { width: 1936, height: 1056 },
        layout: { v: 1, items: { office: { place: { corner: 'tl', dx: 105, dy: 130, w: 1245, h: 770 } } } },
        // The owner's 화면 크기 is 작게 (his screenshot's left column is 230 x 0.875 wide).
        store: { 'cld.ui-scale': 'small' },
      },
      { name: 'pc-1600x1000', vp: { width: 1600, height: 1000 } },
      { name: 'pc-1024x700-max', vp: { width: 1024, height: 700 }, max: true },
    ];
    // ONLY=<size name> shoots that size alone (a quick look while working).
    for (const size of SIZES.filter((x) => !process.env.ONLY || x.name === process.env.ONLY)) {
      const { ctx, page } = await open(size.vp, false, size.layout, size.store);
      await openOfficeWindow(page);
      await page.waitForTimeout(1500);
      if (size.max) await maximize(page);
      await shot(page, size.name);
      if (PREFIX === 'after') {
        await fits(page, size.name);
        await explained(page, size.name);
        check((await page.getByTestId('board-kpi').count()) === 5, `${size.name}: the five count cards show`);
        check((await page.getByTestId('board-task-row').count()) >= 3, `${size.name}: the issues in progress are listed`);
        check((await page.getByTestId('board-approval').count()) >= 1, `${size.name}: someone waits for an answer`);
        check((await page.getByTestId('board-activity').count()) >= 3, `${size.name}: recent activity reads the feed`);
        check((await win(page).locator('.sb-lights, [data-testid="board-filter-reset"]').count()) === 0, `${size.name}: no evidence lights, no filter reset`);
        if (!size.max) {
          // (Over a maximized window the dock folds to its handle.)
          check((await page.locator('[data-hud-id="icon:devroom"]').count()) === 1, `${size.name}: the dock is up`);
          check((await page.locator('[data-hud-id="icon:quests"]').count()) === 0, `${size.name}: the dock has no 퀘스트`);
          check((await page.locator('[data-hud-id="icon:devroom"]').innerText()).includes('개발실'), `${size.name}: the dock's workbench button says 개발실`);
        }
        check((await page.getByTestId('hud-title-office').innerText()).includes('현황판'), `${size.name}: the window is titled 현황판`);
      }
      if (size.name === 'pc-1600x1000-max' && PREFIX === 'after') {
        check(
          (await win(page).getByTestId('board-kpi').filter({ hasText: '오늘 끝난 이슈' }).getAttribute('data-count')) === '2',
          '오늘 끝난 이슈 counts the two issues done today (their history says when)',
        );
        // Owner 11-06 18:10: the 현황판 has 요약 and 프로젝트; the dock's 프로젝트 button is the 개발실.
        const officeTabs = await win(page).getByRole('navigation', { name: '사무실 메뉴' }).getByRole('button').allInnerTexts();
        check(officeTabs.join(',') === '요약,프로젝트,실행', `the 현황판's tabs are 요약 · 프로젝트 · 실행 (${officeTabs.join(',')})`);
        // The issue board is one press away from the 현황판.
        await win(page).getByTestId('board-issues-open').click();
        await page.getByTestId('task-board').waitFor();
        await win(page).getByRole('combobox', { name: '개발 프로젝트' }).selectOption('pofol');
        await page.waitForTimeout(1200);
        check(await page.getByTestId('task-board').isVisible(), 'the 현황판 opens the issue board');
        const subTabs = await win(page).getByRole('navigation', { name: '개발 메뉴' }).getByRole('button').allInnerTexts();
        check(subTabs.join(',') === '지금 상황,이슈,요구사항,지도,문서', `the 프로젝트 tab has 지금 상황 · 이슈 · 요구사항 · 지도 · 문서 only (${subTabs.join(',')})`);
        check(
          (await win(page).getByTestId('workbench-body').getByRole('button', { name: '실행', exact: true }).count()) === 0,
          'the issue board has no 이슈 / 실행 toggle',
        );
        check((await page.locator('.quest-stars').count()) === 0, 'the issue cards carry no stars');
        check((await page.getByTestId('quest-priority').count()) >= 1, 'the priority stays as its P0-style tag');
        check((await page.locator('[data-testid="tab-hi-score"], [data-testid="hi-digits"]').count()) === 0, 'no HI-SCORE in the 개발 tab');
        await shot(page, 'issues-1600x1000-max');
        // Jira-like: drag P7 from 할 일 to 진행 중; it lands there and its history says so.
        const card = page.locator('[data-testid="task-card"][data-task-id="P7"]');
        const doing = page.locator('[data-testid="task-group"][data-status="doing"]');
        check((await card.getAttribute('data-task-status')) === 'todo', 'P7 starts in 할 일');
        // By hand: pofol has nothing in 진행 중, so that column shows only once the drag has begun.
        const from = (await card.boundingBox())!;
        await page.mouse.move(from.x + from.width / 2, from.y + 20);
        await page.mouse.down();
        await page.mouse.move(from.x + from.width / 2 + 30, from.y + 40, { steps: 5 });
        await doing.waitFor();
        const to = (await doing.boundingBox())!;
        await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 10 });
        await page.waitForTimeout(300);
        check((await doing.getAttribute('data-drop')) === 'true', 'the target column lights up under the card');
        await shot(page, 'issues-dragging');
        await page.mouse.up();
        await page.waitForTimeout(1500);
        check((await doing.locator('[data-task-id="P7"]').count()) === 1, 'the dragged card sits in 진행 중');
        check((await card.getAttribute('data-task-status')) === 'doing', 'the dragged card is 진행 중');
        await card.locator('button').first().click();
        await page.waitForTimeout(600);
        const history = (await page.getByTestId('task-history').first().textContent()) ?? '';
        check(history.includes('status todo → doing'), `the card's history line shows the change (${history.slice(0, 80)})`);
        await shot(page, 'issues-dragged');
        // The two windows link: an issue with an agent opens the 개발실, the 개발실 opens the 현황판's 프로젝트 tab.
        const link = page.locator('[data-testid="task-card"][data-task-id="P7"] [data-testid="task-open-devroom"], [data-testid="quest-side"] [data-testid="task-open-devroom"]').first();
        check((await link.count()) === 1, 'an issue with an agent offers 개발실에서 열기');
        await link.click();
        await page.locator('[data-hud-window="devroom"]').waitFor();
        await page.waitForTimeout(1200);
        await shot(page, 'devroom-from-issue');
        await page.getByTestId('devroom-open-board').click();
        await page.waitForTimeout(1200);
        check(
          (await win(page).getByTestId('workbench-body').getAttribute('data-tab')) === 'cockpit',
          "the 개발실's 현황판에서 보기 opens the 프로젝트 tab on 지금 상황",
        );
        check((await win(page).getByTestId('brain-resume').innerText()).includes('지금 상황'), 'the five lines are titled 지금 상황');
        await shot(page, 'board-from-devroom');
      }
      await ctx.close();
    }

    // 실행: its own tab, every project; the control center's 실행 중 and a job notice open it on the run.
    if (!process.env.ONLY) {
      const { ctx, page } = await open({ width: 1600, height: 1000 });
      await page.locator('[data-testid="cc-running"]:visible, [data-testid="cc-seg-running"]:visible').first().click();
      await page.getByTestId('runs-panel').waitFor();
      await page.waitForTimeout(800);
      check(await win(page).getByTestId('runs-panel').isVisible(), "the control center's 실행 중 opens the 현황판's 실행 tab");
      check((await win(page).locator('[data-job-ref]').count()) >= 1, 'the 실행 tab lists the jobs of every project');
      await shot(page, 'runs-1600x1000');
      await page.goto(`http://127.0.0.1:${port}/?open=job&id=j-train`);
      await page.getByTestId('runs-panel').waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1200);
      check((await win(page).locator('[data-job-ref="j-train"]').count()) === 1, 'a job notice opens the 실행 tab with its job in the list');
      await shot(page, 'runs-from-notice');
      await ctx.close();
    }

    // The phone: the 현황판 is the dock's page.
    if (!process.env.ONLY) {
      const { ctx, page } = await open({ width: 390, height: 844 }, true);
      await page.locator('[data-hud-id="icon:office"] button').first().click();
      await page.waitForTimeout(1500);
      await shot(page, 'phone-390x844');
      if (PREFIX === 'after') await fits(page, 'phone');
      const scroller = page.locator('[data-board-look]').locator('xpath=ancestor::*[contains(@class,"overflow-y-auto")][1]');
      await scroller.evaluate((el) => el.scrollBy(0, 640)).catch(() => undefined);
      await page.waitForTimeout(400);
      await shot(page, 'phone-390x844-scrolled');
      await ctx.close();
    }
    if (failures.length) throw new Error(`${failures.length} check(s) failed:\n${failures.join('\n')}`);
  } finally {
    if (driver) clearInterval(driver);
    await browser.close();
    await daemon.stop();
    for (const c of crew) c.proc.kill();
    jobProc.kill();
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

/**
 * D3 / GP-4 shape: dist/cli.js in a temp HOME (the engine fake as `claude`), one
 * project with its Lead and two Workers added and started through `cld-gui worker`.
 * Checks: three sessions and three characters; the messenger lists the project
 * (= its Lead) with its Workers collapsed under it; the project conversation
 * reaches the Lead, a Worker DM that Worker, a room mention only the mentioned
 * Worker, and `cld-gui send <project>` the Lead. Screenshots in cld/artifacts/d3/.
 *
 * W1 (the 작업실): the project is a git clone with a loose change and one task
 * worktree, a second project `beta` has a task of its own. The 현황판 card has no
 * repository button or panel but a 작업실 button; it opens the 작업실 on alpha
 * (desktop window and phone Dock page): 에이전트 lists the Lead and both Workers,
 * Task only alpha's task, worktree and 변경 the repository; the project and tab
 * are remembered across a reload. Screenshots in cld/artifacts/w1/.
 *
 * D3b: the 현황판 lists the projects only (no Worker card). "+ Worker" in the 작업실
 * adds alpha-c (a refusal shows in the form; its row and its character appear).
 * EX-7a, both modes: 'Lead 로' on alpha-a in the 작업실 (the old Lead goes on as
 * Worker alpha-a), and later `cld-gui worker promote alpha-b --old stop`; sampled every
 * 20 ms meanwhile: never two Leads of alpha on disk, never two live sessions named
 * alpha. The new Lead's first typed message is the swap prompt; `cld-gui send alpha`
 * reaches it. EX-7b: the Lead stopped, Worker alpha-b finishes a Task with its own
 * token, then the swap: the new Lead's prompt lists it, the Task keeps its assignee
 * (by assignment id), and the project chat scrolls back into the old Lead's turns.
 * Screenshots in cld/artifacts/d3b/.
 *
 *   nice -n 10 taskset -c 0-3 npx tsx cld/test/run-lead-workers.ts <port 18256-18259>
 */
import type { Browser, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { execFile, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { Worktrees } from '../../server/src/cld/engine/git/worktrees.js';
import { joinRegistry } from '../../server/src/cld/engine/registry.js';
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  engineCalls,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/d3');
const OUT_W1 = path.join(REPO_ROOT, 'cld/artifacts/w1');
const OUT_D3B = path.join(REPO_ROOT, 'cld/artifacts/d3b');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__d3/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 420_000;
const AGENTS = ['alpha', 'alpha-a', 'alpha-b'] as const;
let oks = 0;

const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => boolean, timeout = 20_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(OUT_W1, { recursive: true });
  fs.mkdirSync(OUT_D3B, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = path.join(home, '.config/cld-gui');
  // Our own temp HOME: its daemon's port is the spare one, never the live daemon's.
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  // W1: alpha is a git clone with committed code, a loose change and one task worktree.
  const repo = makeTempRepo();
  repo.write('src/app.ts', 'export const value = 1;\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'add app']);
  repo.git(['push', '-q', 'origin', 'main']);
  repo.write('src/app.ts', 'export const value = 2; // tuned\n');
  repo.write('notes.md', '# Notes\n');
  const folder = repo.folder;
  const tree = path.join(folder, '.worktrees', 'b');
  fs.mkdirSync(tree, { recursive: true });
  await new Worktrees({
    file: path.join(cfg, 'worktrees.json'),
    run: repo.run,
    log: () => undefined,
  }).create({ name: 'alpha', folder }, 'login');
  const betaFolder = path.join(home, 'work', 'beta');
  fs.mkdirSync(betaFolder, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({
      v: 2,
      projects: [
        { projectId: 'p_aaaaaaaaaa', name: 'alpha', folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' },
        { projectId: 'p_bbbbbbbbbb', name: 'beta', folder: betaFolder, room: '개발실', leadAssignmentId: 'a_bbbbbbbbbb' },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({
      v: 1,
      assignments: [
        { assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true },
        { assignmentId: 'a_bbbbbbbbbb', projectId: 'p_bbbbbbbbbb', role: 'lead', provider: 'claude', wantRunning: false },
      ],
    }),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { FAKE_TURN_MS: '400', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  let replier: ReturnType<typeof setInterval> | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
        env: { ...process.env, HOME: home, CLD_OUTPUT: 'json' },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout || '{}') as Record<string, unknown>;
    type Session = { name: string; jobId: string; cwd: string; sessionId: string };
    const session = (name: string): Session | null => {
      const dir = path.join(home, '.claude/sessions');
      for (const file of fs.readdirSync(dir)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Session;
          if (parsed.name === name) return parsed;
        } catch {
          /* a fake is writing */
        }
      }
      return null;
    };
    await daemon.loginUrl(); // up
    await eventually('the Lead revived', () => !!session('alpha'));

    // Two Workers through the owner's CLI (the engine action), one in a worktree of the project.
    check(json(cli('worker', 'add', 'alpha', 'alpha-a', '--model', 'sonnet')).ok === true, 'cld-gui worker add alpha alpha-a');
    check(json(cli('worker', 'add', 'alpha', 'alpha-b', '--folder', tree)).ok === true, 'cld-gui worker add alpha alpha-b --folder <worktree>');
    const taken = json(cli('worker', 'add', 'alpha', 'alpha'));
    check(taken.ok === false && String(taken.error).includes('이미 있는 이름'), 'a Worker cannot take the project’s name');
    for (const w of ['alpha-a', 'alpha-b']) check(json(cli('worker', 'start', w)).ok === true, `cld-gui worker start ${w}`);
    await eventually('three sessions', () => AGENTS.every((n) => session(n)));
    const sessions = AGENTS.map((n) => session(n)!);
    check(new Set(sessions.map((s) => s.sessionId)).size === 3 && new Set(sessions.map((s) => s.jobId)).size === 3, 'three separate sessions (ids and jobs)');
    check(session('alpha-b')!.cwd === tree && session('alpha-a')!.cwd === folder, 'each session in its own folder (alpha-b in the worktree)');
    const listed = json(cli('worker', 'list')).workers as Array<{ name: string; project: string; live: boolean }>;
    check(
      JSON.stringify(listed.map((w) => [w.name, w.project, w.live])) === JSON.stringify([['alpha-a', 'alpha', true], ['alpha-b', 'alpha', true]]),
      'cld-gui worker list: both Workers of alpha, live',
    );
    const stored = JSON.parse(fs.readFileSync(path.join(cfg, 'assignments.json'), 'utf8')) as { v: number; assignments: Array<{ role: string; name?: string }> };
    check(stored.v === 2 && stored.assignments.map((a) => a.name ?? a.role).sort().join() === 'alpha-a,alpha-b,lead,lead', 'assignments.json v2: the two Leads (alpha, beta) and alpha’s two Workers');

    // The fake answers whatever is typed into a session in its transcript.
    let serial = 0;
    const say = (name: string, role: 'user' | 'assistant', text: string) => {
      const s = session(name)!;
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const uuid = `${(++serial).toString(16).padStart(8, '0')}-0d30-4000-8000-000000000000`;
      const message = role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] };
      fs.appendFileSync(file, `${JSON.stringify({ type: role, uuid, timestamp: new Date().toISOString(), message })}\n`);
    };
    const typed = () => {
      const file = path.join(home, 'fake-claude-typed.log');
      return fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string })
        : [];
    };
    const typedTo = (name: string) => typed().filter((t) => t.id === session(name)!.jobId);
    const nameOfJob = (jobId: string): string | null => {
      const dir = path.join(home, '.claude/sessions');
      for (const file of fs.readdirSync(dir)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Session;
          if (parsed.jobId === jobId) return parsed.name;
        } catch {
          /* a fake is writing */
        }
      }
      return null;
    };
    let seen = 0;
    replier = setInterval(() => {
      const all = typed();
      for (const item of all.slice(seen)) {
        const name = nameOfJob(item.id);
        if (!name) continue;
        say(name, 'user', item.text.replaceAll('\r', '\n'));
        say(name, 'assistant', `${name}: 받았어요`);
      }
      seen = all.length;
    }, 100);

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    if (fs.existsSync(FONT))
      await context.route('**/__d3/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    const page = await context.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    const names = page.locator('[data-testid="agent-overlay"] [data-testid="agent-name"]');
    for (const n of AGENTS) await names.getByText(n, { exact: true }).first().waitFor({ timeout: 20_000 });
    const labels = (await names.allInnerTexts()).map((l) => l.trim()).sort();
    check(
      JSON.stringify(labels) === JSON.stringify([...AGENTS, 'beta']),
      `three characters in the office, plus beta’s resting Lead: ${labels.join(', ')}`,
    );
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'office-three-characters.png') });

    // The messenger: the project's chat, its Workers collapsed under it (F-7).
    await page.getByRole('button', { name: /^메신저/ }).click();
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    const contacts = messenger.getByRole('list', { name: '연락처' });
    const contact = (n: string) => contacts.getByRole('button', { name: new RegExp(`^${n}( 안 읽음 \\d+)?$`) });
    await contact('alpha').waitFor();
    const group = messenger.getByTestId('workers-alpha');
    await group.waitFor();
    check(
      (await group.evaluate((el) => (el as HTMLDetailsElement).open)) === false &&
        !(await contact('alpha-a').isVisible()) &&
        (await group.locator('summary').innerText()).includes('Worker 2명'),
      'the messenger lists the project; its two Workers sit collapsed under it',
    );
    await page.screenshot({ path: path.join(OUT, 'messenger-workers-collapsed.png') });
    await group.locator('summary').click();
    await contact('alpha-b').waitFor();
    check(await contact('alpha-a').isVisible(), 'opening the Worker group shows alpha-a and alpha-b');
    await page.screenshot({ path: path.join(OUT, 'messenger-workers-open.png') });

    const conv = (n: string) => messenger.getByRole('region', { name: `${n} 대화` });
    const sendDm = async (n: string, text: string) => {
      await contact(n).click();
      const box = conv(n).getByRole('textbox', { name: '보낼 글' });
      await box.fill(text);
      await box.press('Enter');
      await eventually(`"${text}" typed`, () => typed().some((t) => t.text.includes(text)));
    };
    await sendDm('alpha', '프로젝트에게 보내는 글');
    check(
      typed().filter((t) => t.text.includes('프로젝트에게 보내는 글')).every((t) => t.id === session('alpha')!.jobId),
      'the project conversation reaches the Lead’s session',
    );
    await sendDm('alpha-b', 'Worker b 에게만');
    check(
      typed().filter((t) => t.text.includes('Worker b 에게만')).map((t) => t.id).join() === session('alpha-b')!.jobId,
      'a Worker DM reaches only that Worker’s session',
    );
    await conv('alpha-b').getByText('alpha-b: 받았어요').waitFor({ timeout: 20_000 });
    await page.screenshot({ path: path.join(OUT, 'worker-dm.png') });

    // A room with the Lead and both Workers: a mention reaches only the mentioned Worker.
    const rooms = messenger.getByRole('region', { name: '단톡방' });
    await rooms.getByRole('button', { name: '+ 방 만들기' }).click();
    await rooms.getByRole('textbox', { name: '방 이름' }).fill('팀방');
    for (const n of AGENTS) await rooms.getByLabel(n, { exact: true }).check();
    await rooms.getByRole('button', { name: '저장' }).click();
    await rooms.getByRole('button', { name: /^팀방/ }).click();
    const room = messenger.getByTestId(/group-room-screen-/);
    await room.waitFor();
    // MSG-UI2: the header has a member pill; its list names each member.
    await room.getByRole('button', { name: '멤버 3명 보기' }).click();
    const memberNames = await room.getByRole('list', { name: '구성원' }).locator('strong').allTextContents();
    check(
      [...memberNames].sort().join(', ') === 'alpha, alpha-a, alpha-b',
      `a room holds the Lead and both Workers by name (${memberNames.join(', ')})`,
    );
    const before = typed().length;
    const composer = room.getByRole('textbox', { name: '팀방 메시지' });
    await composer.fill('@alpha-a 리뷰 부탁해요');
    await room.getByRole('button', { name: '보내기', exact: true }).click();
    await eventually('the mention typed', () => typed().length > before);
    await wait(1_500); // and nobody else
    const fresh = typed().slice(before);
    check(fresh.length === 1 && fresh[0].id === session('alpha-a')!.jobId && fresh[0].text.includes("단톡방 '팀방'"), 'a room mention @alpha-a reaches only alpha-a');
    await room.getByText('alpha-a: 받았어요').waitFor({ timeout: 20_000 });
    await page.screenshot({ path: path.join(OUT, 'room-mention.png') });

    // `cld-gui send <project>` reaches the Lead.
    const leadBefore = typedTo('alpha').length;
    const sent = json(cli('send', 'alpha', 'CLI 에서 프로젝트에게'));
    check(sent.ok === true, 'cld-gui send alpha');
    await eventually('the CLI message typed', () => typedTo('alpha').length > leadBefore);
    check(typed().filter((t) => t.text.includes('CLI 에서 프로젝트에게')).every((t) => t.id === session('alpha')!.jobId), 'cld-gui send <project> reaches the Lead’s session');

    const phone = await browser.newContext({ ...devices['iPhone 13'] });
    const phonePage: Page = await phone.newPage();
    await phonePage.goto(await daemon.loginUrl());
    await phonePage.getByRole('button', { name: /^메신저/ }).click();
    await phonePage.getByTestId('workers-alpha').waitFor();
    await phonePage.getByTestId('workers-alpha').locator('summary').click();
    await phonePage.waitForTimeout(500);
    await phonePage.screenshot({ path: path.join(OUT, 'phone-messenger-workers.png') });
    check(true, 'phone: the Worker group opens in the messenger list');
    await phone.close();
    await context.close();

    // ── W1: the 작업실. A new desktop and a new phone (their own localStorage).
    cli('task', 'add', '알파 로그인 고치기', '--project', 'alpha', '--id', 'login');
    cli('task', 'add', '베타 문서 쓰기', '--project', 'beta');
    const shotW1 = (p: Page, name: string) => p.screenshot({ path: path.join(OUT_W1, `${name}.png`) });
    const newPage = async (opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await browser!.newContext(opts);
      if (fs.existsSync(FONT))
        await ctx.route('**/__d3/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      await p.addStyleTag({ content: FONT_CSS });
      return { ctx, p };
    };
    const { ctx: deskCtx, p: desk } = await newPage({ viewport: { width: 1280, height: 800 } });
    await openOfficeWindow(desk);
    const officeWin = desk.locator('[data-hud-window="office"]');
    const alphaCard = officeWin.locator('article').filter({ has: desk.getByRole('heading', { name: 'alpha', exact: true }) });
    await alphaCard.waitFor();
    if ((await alphaCard.getByRole('button', { name: 'alpha' }).first().getAttribute('aria-expanded')) !== 'true')
      await alphaCard.getByRole('button', { name: 'alpha' }).first().click();
    const wbButton = alphaCard.getByRole('button', { name: '작업실', exact: true });
    await wbButton.waitFor();
    check(
      (await alphaCard.getByRole('button', { name: '저장소' }).count()) === 0 &&
        (await alphaCard.getByLabel('alpha 저장소').count()) === 0 &&
        (await wbButton.count()) === 1,
      'W1: the 현황판 card has a 작업실 button and no repository button or panel',
    );
    await shotW1(desk, 'desktop-card');
    const bench = desk.locator('[data-hud-window="workbench"]');
    check((await bench.count()) === 0, 'W1: the 작업실 is closed until asked for');
    await wbButton.click();
    await bench.waitFor();
    const picker = bench.getByRole('combobox', { name: '작업실 프로젝트' });
    check((await picker.inputValue()) === 'alpha', 'W1: the 작업실 opens on the project the button belongs to');
    check(
      (await picker.locator('option').allInnerTexts()).join() === 'alpha,beta',
      'W1: the picker lists the projects, not their Workers',
    );
    const tab = (p: Page, name: string) => p.locator('[data-hud-window="workbench"], [aria-label="작업실 화면"]').getByRole('button', { name, exact: true });
    // 에이전트
    const agents = bench.getByTestId('workbench-agent');
    await agents.first().waitFor();
    const roster = await agents.evaluateAll((els) => els.map((el) => `${el.getAttribute('data-name')}|${(el.textContent ?? '').replace(/\s+/g, ' ')}`));
    check(
      roster.map((r) => r.split('|')[0]).join() === 'alpha,alpha-a,alpha-b' &&
        roster[0].includes('Lead') &&
        roster[1].includes('Worker') &&
        roster[1].includes('sonnet'),
      `W1: 에이전트 lists the Lead and both Workers with role and model (${roster.join(' ; ')})`,
    );
    check(
      roster.every((r) => /켜짐|일하는 중|쉬는 중/.test(r)) &&
        (await agents.first().getByRole('button', { name: '대화 열기' }).count()) === 1,
      'W1: each agent shows a state word and a chat button',
    );
    await shotW1(desk, 'desktop-agents');
    await agents.nth(1).getByRole('button', { name: '대화 열기' }).click();
    await desk.getByRole('region', { name: 'alpha-a 대화' }).waitFor();
    check(true, 'W1: the chat button opens that Worker’s conversation in the messenger');
    await desk.getByRole('button', { name: /^메신저/ }).first().click(); // closes the messenger window again
    // Task
    await tab(desk, 'Task').click();
    await bench.getByTestId('task-board').waitFor();
    await bench.getByText('알파 로그인 고치기').first().waitFor();
    check(
      (await bench.getByText('베타 문서 쓰기').count()) === 0 && (await bench.getByText('알파 로그인 고치기').count()) > 0,
      'W1: Task shows alpha’s task only, not beta’s',
    );
    await shotW1(desk, 'desktop-tasks');
    // worktree
    await tab(desk, 'worktree').click();
    await bench.getByText('작업 공간 (1)').waitFor();
    check((await bench.getByText('login', { exact: true }).count()) === 1, 'W1: worktree lists the task worktree');
    await shotW1(desk, 'desktop-worktree');
    // 변경
    await tab(desk, '변경').click();
    await bench.getByText('main → origin/main').waitFor();
    check(
      (await bench.getByRole('button', { name: 'src/app.ts', exact: true }).count()) === 1 &&
        (await bench.getByRole('button', { name: 'notes.md', exact: true }).count()) === 1 &&
        (await bench.getByText('작업 공간 (1)').count()) === 0,
      'W1: 변경 shows the changed files (the worktree list is its own tab)',
    );
    await bench.getByRole('button', { name: 'src/app.ts', exact: true }).click();
    await bench.getByLabel('diff', { exact: true }).waitFor();
    await shotW1(desk, 'desktop-changes');
    // The picker: beta has no Workers and its own task.
    await picker.selectOption('beta');
    check(
      (await bench.getByLabel('beta 저장소').count()) === 1,
      'W1: picking another project shows that project’s repository tab',
    );
    await tab(desk, 'Task').click();
    await bench.getByText('베타 문서 쓰기').first().waitFor();
    check((await bench.getByText('알파 로그인 고치기').count()) === 0, 'W1: Task follows the picked project (beta: its own task only)');
    await tab(desk, '에이전트').click();
    check((await bench.getByTestId('workbench-agent').count()) === 1, 'W1: beta’s team is its Lead alone');
    // Remembered per device: left on beta / Task, a reload and the icon bring it back.
    await tab(desk, 'Task').click();
    await desk.reload();
    await desk.addStyleTag({ content: FONT_CSS });
    const bench2 = desk.locator('[data-hud-window="workbench"]');
    const benchIcon = desk.locator('[data-hud-id="icon:workbench"] button');
    await benchIcon.waitFor(); // the icons and the restored windows render in the same commit
    if (!(await bench2.isVisible())) await benchIcon.click(); // (the open flag is remembered too)
    await bench2.waitFor();
    check(
      (await bench2.getByRole('combobox', { name: '작업실 프로젝트' }).inputValue()) === 'beta' &&
        (await bench2.getByRole('button', { name: 'Task', exact: true }).getAttribute('aria-pressed')) === 'true',
      'W1: the project and the tab are remembered per device (a reload reopens beta / Task)',
    );
    await shotW1(desk, 'desktop-remembered');
    // D3b: the 현황판 lists the projects (= their Leads): no Worker card, their characters stay.
    await bench2.getByRole('button', { name: '작업실 닫기' }).click(); // it covers the board
    await bench2.waitFor({ state: 'detached' });
    await openOfficeWindow(desk);
    const boardCards = desk.locator('[data-hud-window="office"] article');
    await boardCards.filter({ has: desk.getByRole('heading', { name: 'alpha', exact: true }) }).waitFor();
    await desk.locator('[data-testid="agent-overlay"] [data-testid="agent-name"]').getByText('alpha-a', { exact: true }).first().waitFor({ timeout: 20_000 });
    const headings = await desk.locator('[data-hud-window="office"] article h3, [data-hud-window="office"] article h2').allInnerTexts();
    check(
      (await boardCards.filter({ has: desk.getByRole('heading', { name: 'alpha-a', exact: true }) }).count()) === 0 &&
        (await boardCards.filter({ has: desk.getByRole('heading', { name: 'alpha-b', exact: true }) }).count()) === 0 &&
        (await desk.locator('[data-testid="agent-overlay"] [data-testid="agent-name"]').getByText('alpha-a', { exact: true }).count()) > 0,
      `D3b: the 현황판 shows no Worker card, the Workers' characters stay (${headings.map((h) => h.trim()).join(', ')})`,
    );
    await desk.screenshot({ path: path.join(OUT_D3B, 'board-no-worker-cards.png') });
    await deskCtx.close();

    // The phone: the Dock between 현황판 and 메신저, a full page.
    const { ctx: phoneCtx, p: ph } = await newPage({ ...devices['iPhone 13'] });
    const dockOrder = await ph.getByTestId('mobile-dock').locator('button[data-dock]').evaluateAll((els) => els.map((el) => el.getAttribute('data-dock')));
    check(
      dockOrder.indexOf('workbench') === dockOrder.indexOf('board') + 1 && dockOrder.indexOf('messenger') === dockOrder.indexOf('workbench') + 1,
      `W1: the Dock lists 작업실 between 현황판 and 메신저 (${dockOrder.join(', ')})`,
    );
    await ph.locator('[data-dock="board"]').tap();
    const pBoard = ph.getByLabel('현황판 화면');
    const pAlpha = pBoard.locator('article').filter({ has: ph.getByRole('heading', { name: 'alpha', exact: true }) });
    await pAlpha.waitFor();
    if ((await pAlpha.getByRole('button', { name: 'alpha' }).first().getAttribute('aria-expanded')) !== 'true')
      await pAlpha.getByRole('button', { name: 'alpha' }).first().tap();
    check(
      (await pAlpha.getByRole('button', { name: '저장소' }).count()) === 0 && (await pAlpha.getByRole('button', { name: '작업실', exact: true }).count()) === 1,
      'W1: phone: the 현황판 card has the 작업실 button, no repository button',
    );
    await shotW1(ph, 'phone-card');
    await pAlpha.getByRole('button', { name: '작업실', exact: true }).tap();
    const page2 = ph.getByLabel('작업실 화면');
    await page2.waitFor();
    check(
      (await ph.getByTestId('mobile-dock').locator('[aria-current="page"]').getAttribute('data-dock')) === 'workbench' &&
        (await page2.getByRole('combobox', { name: '작업실 프로젝트' }).inputValue()) === 'alpha',
      'W1: phone: the button opens the 작업실 page on alpha (the Dock shows it)',
    );
    await page2.getByTestId('workbench-agent').first().waitFor();
    check((await page2.getByTestId('workbench-agent').count()) === 3, 'W1: phone: 에이전트 lists the Lead and both Workers');
    await shotW1(ph, 'phone-agents');
    await tab(ph, 'Task').tap();
    await page2.getByText('알파 로그인 고치기').first().waitFor();
    check((await page2.getByText('베타 문서 쓰기').count()) === 0, 'W1: phone: Task shows alpha’s task only');
    await shotW1(ph, 'phone-tasks');
    await tab(ph, 'worktree').tap();
    await page2.getByText('작업 공간 (1)').waitFor();
    await shotW1(ph, 'phone-worktree');
    await tab(ph, '변경').tap();
    await page2.getByText('main → origin/main').waitFor();
    check((await page2.getByRole('button', { name: 'src/app.ts', exact: true }).count()) === 1, 'W1: phone: 변경 shows the changed files');
    await shotW1(ph, 'phone-changes');
    const overflow = await ph.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `W1: phone: nothing wider than the screen (${overflow})`);
    await phoneCtx.close();

    // ── D3b ─────────────────────────────────────────────────────
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT_D3B, `${name}.png`) });
    const cfgJson = (f: string) => JSON.parse(fs.readFileSync(path.join(cfg, f), 'utf8')) as Record<string, unknown>;
    const assignmentId = (name: string): string => {
      const loaded = joinRegistry(cfgJson('projects.json').projects as unknown[], cfgJson('assignments.json').assignments as unknown[]);
      const p = loaded.projects.find((x) => x.name === name)!;
      return (p.role ? p.assignmentId : p.leadAssignmentId)!;
    };
    const liveNamed = (name: string) => {
      const dir = path.join(home, '.claude/sessions');
      return fs.readdirSync(dir).filter((file) => {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Session & { pid: number };
          return parsed.name === name && fs.existsSync(`/proc/${parsed.pid}`);
        } catch {
          return false;
        }
      }).length;
    };
    /** EX-7a's watch while a swap runs: alpha's Leads on disk (a mix that loads as broken has
     *  none) and live sessions answering to "alpha", every 20 ms. */
    const watchSwap = () => {
      const seenMax = { leads: 0, sessions: 0, samples: 0 };
      const timer = setInterval(() => {
        try {
          const loaded = joinRegistry(cfgJson('projects.json').projects as unknown[], cfgJson('assignments.json').assignments as unknown[]);
          const leads = loaded.broken ? 0 : loaded.projects.filter((p) => !p.role && p.projectId === 'p_aaaaaaaaaa').length;
          seenMax.leads = Math.max(seenMax.leads, leads);
        } catch {
          /* a file mid-rename */
        }
        seenMax.sessions = Math.max(seenMax.sessions, liveNamed('alpha'));
        seenMax.samples++;
      }, 20);
      return () => (clearInterval(timer), seenMax);
    };
    const { ctx: d3Ctx, p: d3 } = await newPage({ viewport: { width: 1280, height: 800 } });
    const wb = d3.locator('[data-hud-window="workbench"]');
    const benchIcon3 = d3.locator('[data-hud-id="icon:workbench"] button');
    await benchIcon3.waitFor();
    if (!(await wb.isVisible())) await benchIcon3.click();
    await wb.waitFor();
    await wb.getByRole('combobox', { name: '작업실 프로젝트' }).selectOption('alpha');
    await wb.getByRole('button', { name: '에이전트', exact: true }).click();
    await wb.getByTestId('workbench-agent').first().waitFor();

    // "+ Worker": a refusal in the form (the name check, then the engine's), then alpha-c.
    await wb.getByRole('button', { name: '+ Worker', exact: true }).click();
    const form = d3.getByRole('form', { name: 'alpha 에 Worker 추가' });
    await form.waitFor();
    await form.getByLabel('이름').fill('beta');
    await form.getByRole('button', { name: '추가', exact: true }).click();
    await form.getByRole('alert').waitFor();
    check((await form.getByRole('alert').innerText()).includes('프로젝트 이름'), 'D3b + Worker: a project’s name is refused in the form');
    await form.getByLabel('이름').fill('alpha-c');
    await form.getByLabel('폴더').fill('/tmp');
    await form.getByRole('button', { name: '추가', exact: true }).click();
    await form.getByRole('alert').getByText(/worktree/).waitFor({ timeout: 20_000 });
    check(true, `D3b + Worker: the engine's refusal shows in the form (${await form.getByRole('alert').innerText()})`);
    await form.getByLabel('폴더').fill(folder);
    await form.getByLabel('역할').selectOption('reviewer');
    const modelOptions = await form.getByLabel('모델').locator('option').allInnerTexts();
    const modeOptions = await form.getByLabel('권한 모드').locator('option').allInnerTexts();
    check(modelOptions.length > 1 && modeOptions.includes('plan'), `D3b + Worker: model and permission mode from the CLI's lists (${modelOptions.join('/')}; ${modeOptions.join('/')})`);
    await form.getByLabel('모델').selectOption({ index: 1 });
    await form.getByLabel('권한 모드').selectOption('plan');
    await shot(d3, 'add-worker-form');
    await form.getByRole('button', { name: '추가', exact: true }).click();
    await form.waitFor({ state: 'detached', timeout: 20_000 });
    await wb.locator('[data-testid="workbench-agent"][data-name="alpha-c"]').waitFor({ timeout: 20_000 });
    await d3.locator('[data-testid="agent-overlay"] [data-testid="agent-name"]').getByText('alpha-c', { exact: true }).first().waitFor({ timeout: 20_000 });
    const listedC = (json(cli('worker', 'list')).workers as Array<{ name: string; role: string; permissionMode?: string }>).find((w) => w.name === 'alpha-c');
    check(listedC?.role === 'reviewer' && listedC.permissionMode === 'plan', 'D3b + Worker: alpha-c added (reviewer, plan): its row in 에이전트 and its character in the office');
    await shot(d3, 'agents-with-alpha-c');

    // EX-7a, oldLead worker, through the 작업실: 'Lead 로' on alpha-a.
    const ids0 = { lead: assignmentId('alpha'), a: assignmentId('alpha-a'), b: assignmentId('alpha-b') };
    const leadSid0 = session('alpha')!.sessionId;
    const rowA = wb.locator('[data-testid="workbench-agent"][data-name="alpha-a"]');
    await rowA.getByRole('button', { name: 'Lead 로', exact: true }).click();
    const dialog = d3.getByRole('alertdialog', { name: "'alpha-a' 을(를) Lead 로" });
    await dialog.waitFor();
    check(
      (await dialog.getByLabel("Worker 'alpha-a' 로 계속").isChecked()) && (await dialog.innerText()).includes('@alpha'),
      'D3b: the confirmation says what changes, keeping the old Lead as Worker by default',
    );
    await shot(d3, 'promote-confirm');
    const typedBefore = typed().length;
    let stopWatch = watchSwap();
    await dialog.getByRole('button', { name: 'Lead 로 바꾸기', exact: true }).click();
    await eventually('the swap', () => assignmentId('alpha') === ids0.a && !!session('alpha-a') && !!session('alpha') && session('alpha')!.sessionId !== leadSid0, 60_000);
    await eventually('the new Lead typed into', () => typed().slice(typedBefore).some((x) => x.id === session('alpha')!.jobId), 30_000);
    let watched = stopWatch();
    check(watched.leads === 1 && watched.sessions <= 1 && watched.samples > 10, `EX-7a (worker): at most one Lead of alpha on disk and one live "alpha" session in ${watched.samples} samples`);
    check(assignmentId('alpha-a') === ids0.lead && liveNamed('alpha') === 1 && liveNamed('alpha-a') === 1, 'EX-7a (worker): alpha is alpha-a’s assignment, the old Lead goes on as Worker alpha-a');
    const firstToNew = typed().slice(typedBefore).find((x) => x.id === session('alpha')!.jobId)!;
    check(firstToNew.text.startsWith('[cld-gui Lead 교체') && firstToNew.text.includes('열린 Task'), 'EX-7a: the new Lead’s first message is the swap prompt (open Tasks listed)');
    console.log(`--- first prompt (EX-7a) ---\n${firstToNew.text.replaceAll('\r', '\n')}\n---`);
    const toNew = typedTo('alpha').length;
    check(json(cli('send', 'alpha', 'EX-7a 뒤 CLI 에서 프로젝트에게')).ok === true, 'cld-gui send alpha after the swap');
    await eventually('the CLI message typed', () => typedTo('alpha').length > toNew, 30_000);
    check(typed().filter((x) => x.text.includes('EX-7a 뒤 CLI 에서')).every((x) => x.id === session('alpha')!.jobId), 'EX-7a: cld-gui send alpha reaches the new Lead');
    await eventually('the agents tab after the swap', () => true);
    await wb.locator('[data-testid="workbench-agent"][data-name="alpha"]').getByText('Lead').first().waitFor();
    await d3.waitForTimeout(1_000);
    await shot(d3, 'agents-after-swap');
    check(true, 'D3b: 에이전트 tab after the swap (screenshot)');

    // EX-7b: the Lead stopped; Worker alpha-b finishes a Task with its own token; then the swap.
    cli('task', 'update', 'login', '--assignee', 'alpha-b');
    await openOfficeWindow(d3);
    const leadCard = d3.locator('[data-hud-window="office"] article').filter({ has: d3.getByRole('heading', { name: 'alpha', exact: true }) });
    await leadCard.waitFor();
    const leadHead = leadCard.getByRole('button', { name: 'alpha' }).first();
    if ((await leadHead.getAttribute('aria-expanded')) !== 'true') await leadHead.click();
    await leadCard.getByRole('button', { name: '끄기', exact: true }).click();
    await d3.getByRole('alertdialog').getByRole('button', { name: '끄기', exact: true }).click();
    await eventually('the Lead stopped', () => liveNamed('alpha') === 0, 30_000);
    const bCall = engineCalls(home).filter((c) => c.argv[0] === '--bg' && c.argv.includes('alpha-b')).at(-1)!;
    const bToken = (JSON.parse(bCall.argv[bCall.argv.indexOf('--settings') + 1]) as { env: Record<string, string> }).env.CLD_AGENT_TOKEN;
    const asWorker = spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), 'task', 'done', 'login'], {
      env: { ...process.env, HOME: home, CLD_OUTPUT: 'json', CLD_AGENT_TOKEN: bToken },
      encoding: 'utf8',
      cwd: tree,
      timeout: 60_000,
    });
    check(JSON.parse(asWorker.stdout || '{}').ok === true, `EX-7b: Worker alpha-b marks its Task done with its own token while the Lead is off (${asWorker.stdout.trim().slice(0, 120)})`);
    const termLead = session('alpha') ?? null; // off: none
    const typedBefore2 = typed().length;
    stopWatch = watchSwap();
    // Asynchronous: the 20 ms watch runs in this process meanwhile.
    const cliAsync = (...args: string[]) =>
      new Promise<Record<string, unknown>>((resolve) =>
        execFile(
          process.execPath,
          [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args],
          { env: { ...process.env, HOME: home, CLD_OUTPUT: 'json' }, encoding: 'utf8', timeout: 120_000 },
          (_err, stdout) => resolve(JSON.parse(stdout || '{}') as Record<string, unknown>),
        ),
      );
    const promoted = await cliAsync('worker', 'promote', 'alpha-b', '--old', 'stop');
    watched = stopWatch();
    check(promoted.ok === true && termLead === null, `EX-7a (stop): cld-gui worker promote alpha-b --old stop (${String(promoted.error ?? 'ok')})`);
    check(watched.leads === 1 && watched.sessions <= 1, `EX-7a (stop): at most one Lead of alpha and one live "alpha" session in ${watched.samples} samples`);
    check(assignmentId('alpha') === ids0.b && assignmentId('alpha-b') === ids0.a && liveNamed('alpha-b') === 0 && liveNamed('alpha') === 1, 'EX-7a (stop): alpha is alpha-b’s assignment; the old Lead is Worker alpha-b, off');
    // D1: a later ordinary start of the demoted Worker (it holds the old Lead's conversation)
    // continues it as a copy under its own name: still never a second live "alpha".
    stopWatch = watchSwap();
    const later = await cliAsync('worker', 'start', 'alpha-b');
    await eventually('alpha-b live', () => liveNamed('alpha-b') === 1, 30_000);
    watched = stopWatch();
    check(
      later.ok === true && watched.sessions <= 1 && liveNamed('alpha') === 1 && watched.samples > 3,
      `D3b: a later start of the old Lead as Worker alpha-b: one live "alpha" session in ${watched.samples} samples, alpha-b under its own name`,
    );
    await eventually('the second new Lead typed into', () => typed().slice(typedBefore2).some((x) => x.id === session('alpha')!.jobId), 30_000);
    const second = typed().slice(typedBefore2).find((x) => x.id === session('alpha')!.jobId)!.text.replaceAll('\r', '\n');
    check(/최근 끝난 Task \(24시간, \d+개\):\s+#login 알파 로그인 고치기 · done · 담당 alpha /.test(second), 'EX-7b: the new Lead’s first prompt lists the Task the Worker finished (its assignee under the name it answers to now)');
    console.log(`--- first prompt (EX-7b) ---\n${second}\n---`);
    const shown = json(cli('task', 'show', 'login', '--json')).task as { status: string; assignee: { assignmentId: string; name: string }; history: unknown[] };
    check(shown.status === 'done' && shown.assignee.assignmentId === ids0.b && shown.history.length >= 3, 'EX-7b: the Task keeps its status, history and assignee (by assignment id)');
    // The project chat scrolls back into the old Leads' turns.
    await d3.getByRole('button', { name: /^메신저/ }).first().click();
    const msgr = d3.getByRole('region', { name: '메신저', exact: true });
    await msgr.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha( 안 읽음 \d+)?$/ }).click();
    const chat = msgr.getByRole('region', { name: 'alpha 대화' });
    await chat.waitFor();
    const old = chat.getByText('EX-7a 뒤 CLI 에서 프로젝트에게');
    for (const end = Date.now() + 30_000; !(await old.count()) && Date.now() < end; ) {
      await chat.locator('[data-chat-id]').first().scrollIntoViewIfNeeded().catch(() => undefined);
      await chat.evaluate((el) => el.querySelectorAll('*').forEach((n) => ((n as HTMLElement).scrollTop = 0)));
      await d3.waitForTimeout(300);
    }
    check((await old.count()) > 0, 'EX-7b: the project chat scrolls back into the old Lead’s turns');
    await old.first().scrollIntoViewIfNeeded();
    await shot(d3, 'project-chat-scrollback');
    // The lobby board lists the projects only, and every agent has one character.
    await d3.locator('[data-testid="board-tab-projects"]').first().dispatchEvent('click');
    await d3.waitForTimeout(500);
    const boardRows = await d3.getByTestId('board-project').allInnerTexts();
    const overlayNames = (await d3.locator('[data-testid="agent-overlay"] [data-testid="agent-name"]').allInnerTexts()).map((x) => x.trim());
    check(
      boardRows.length > 0 &&
        boardRows.every((r) => !/^alpha-[abc]$/.test(r.trim().split(/\s+/)[0])) && // its name (a row's last event may name a Worker)
        new Set(overlayNames).size === overlayNames.length &&
        ['alpha', 'alpha-a', 'alpha-b', 'alpha-c'].every((n) => overlayNames.includes(n)),
      `D3b: the lobby board lists projects only (${boardRows.map((r) => r.split('\n')[0]).join(', ')}); one character per agent (${overlayNames.join(', ')})`,
    );
    await shot(d3, 'lobby-board-projects');
    await d3Ctx.close();
    console.log(`${oks} ok`);
  } finally {
    if (replier) clearInterval(replier);
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);

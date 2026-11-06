/**
 * ACP-1: an ACP agent end to end. dist/cli.js in a temp HOME (its own port), the engine's fake
 * claude as the Lead and the mock ACP agent (e2e/fixtures/mock-acp) as the only `gemini` on a PATH
 * of our own: never a real agent. Headless Chromium (--disable-gpu).
 * - the + Worker form (개발실 → 새 워크트리 → 새 에이전트 만들기…) lists Gemini with its mark;
 *   picking it adds alpha-g1 (provider gemini);
 * - `cld-gui worker start alpha-g1`, a message from the messenger: its words, a folded tool line,
 *   the plan, then a permission card with the agent's options; 이번만 허용 reaches the agent once;
 * - the 개발실 대화 pane of alpha-g1 (on its task worktree) shows the conversation; its terminal
 *   side links the chat (no terminal for an ACP agent).
 * Photos in cld/artifacts/feat-acp-agents/ (desktop 1600x1000 모던 and 픽셀 감성, iPhone 13).
 *
 *   nice -n 10 taskset -c 12-19 npx tsx cld/test/run-acp-agents.ts <port 18260-18599>
 */
import type { Browser, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { findOnPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/feat-acp-agents');
const MOCK = path.join(REPO_ROOT, 'e2e/fixtures/mock-acp/mock-acp');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__acp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
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

const OPTIONS = [
  { optionId: 'proceed_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'proceed_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
];

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  // The mock ACP agent as `gemini`, in a bin dir of its own.
  const acpBin = path.join(home, 'acp-bin');
  fs.mkdirSync(acpBin);
  fs.symlinkSync(MOCK, path.join(acpBin, 'gemini'));
  fs.writeFileSync(
    path.join(home, 'mock-acp.json'),
    JSON.stringify({
      turns: [
        [
          { say: '빌드 폴더를 살펴볼게요.' },
          { tool: { toolCallId: 't1', kind: 'read', title: 'package.json', locations: [{ path: 'package.json' }] } },
          { toolDone: 't1' },
          { plan: [{ content: '빌드 폴더 확인', status: 'completed' }, { content: '오래된 빌드 지우기', status: 'in_progress' }] },
          { usage: { used: 52_000, size: 1_000_000 } },
          { ask: { toolCall: { toolCallId: 't2', kind: 'execute', title: 'rm -rf build', rawInput: { command: 'rm -rf build' } }, options: OPTIONS } },
          { say: '지웠어요. 다음 일을 알려 주세요.' },
        ],
        [{ say: '개발실에서 받은 말에 답해요.' }],
      ],
    }),
  );
  const repo = makeTempRepo();
  const folder = repo.folder;
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({ v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] }),
  );
  // Never the user's PATH (a real gemini may live there): the mock, the fake claude, node, git.
  // ponytail: on WSL the daemon's session PATH adds the Windows PATH (sessionPath.ts), so a
  // Windows-installed agent (VS Code's copilot shim) is offered in the form too; never picked here.
  const PATH = [acpBin, bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  check(findOnPath('gemini', PATH) === path.join(acpBin, 'gemini'), 'the only gemini on the daemon’s PATH is the mock ACP agent');
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { PATH, FAKE_TURN_MS: '400', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
    true,
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const opened: Page[] = [];
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
    const mockLog = () => {
      const file = path.join(home, 'mock-acp.log');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>) : [];
    };
    await daemon.loginUrl();
    await eventually('the Lead revived', () => fs.readdirSync(path.join(home, '.claude/sessions')).length > 0, 60_000);

    browser = await launchBrowser();
    const newPage = async (opts: Parameters<Browser['newContext']>[0], theme = 'modern') => {
      const ctx = await browser!.newContext(opts);
      await ctx.addInitScript((x) => localStorage.setItem('cld.ui-theme', x), theme);
      if (fs.existsSync(FONT))
        await ctx.route('**/__acp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      const p = await ctx.newPage();
      opened.push(p);
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      const toast = await p.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 5_000 }).catch(() => null);
      const v = toast?.match(/v([\d.]+)/)?.[1];
      if (v) {
        await p.evaluate((x) => localStorage.setItem('cld.changelogSeen', x), v);
        await p.reload();
      }
      await p.addStyleTag({ content: FONT_CSS });
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

    // ── 1. The + Worker form (the 개발실's 새 에이전트 만들기…) with Gemini (the mock) ──
    const desk = await newPage({ viewport: { width: 1600, height: 1000 } });
    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.waitFor({ timeout: 20_000 });
    await win.getByTestId('hud-title-devroom').dblclick();
    await win.getByTestId('devroom-new-space').click();
    const sheet = win.getByTestId('newspace-sheet');
    await sheet.waitFor({ timeout: 20_000 });
    await sheet.getByRole('button', { name: '새 에이전트 만들기…', exact: true }).click();
    const form = desk.getByRole('form', { name: 'alpha 에 Worker 추가' });
    await form.waitFor();
    const gemini = form.getByTestId('worker-provider').locator('[data-provider="gemini"]');
    await gemini.waitFor({ timeout: 20_000 });
    await gemini.click();
    check((await gemini.getAttribute('aria-checked')) === 'true' && (await gemini.innerText()).includes('Gemini'), 'the form lists Gemini by its own name and picks it');
    await form.getByLabel('이름').fill('alpha-g1');
    await shot(desk, '01-add-worker-gemini');
    await form.getByRole('button', { name: '추가', exact: true }).click();
    await form.waitFor({ state: 'detached', timeout: 20_000 });
    await sheet.getByRole('button', { name: '취소', exact: true }).last().click();
    await sheet.waitFor({ state: 'detached', timeout: 10_000 });
    const listed = (json(cli('worker', 'list')).workers as Array<Record<string, unknown>>).find((w) => w.name === 'alpha-g1');
    check(listed?.provider === 'gemini', `alpha-g1 added as a gemini Worker (${JSON.stringify(listed)})`);
    // On a task worktree of its own, so the 개발실 shows it in a pane.
    const taskId = json(cli('task', 'add', '빌드 정리', '--project', 'alpha', '--assignee', 'alpha-g1', '--status', 'doing')).task?.id as string;
    check(json(cli('worktree', 'new', '--task', taskId, '--assign', 'alpha-g1')).ok === true, `${taskId} gets a 워크트리 for alpha-g1`);
    const started = json(cli('worker', 'start', 'alpha-g1'));
    check(started.ok === true, `cld-gui worker start alpha-g1 (${JSON.stringify(started).slice(0, 200)})`);
    await eventually('the mock was initialized and has a session', () => mockLog().some((l) => l.got?.method === 'session/new'), 30_000);
    const argv = mockLog().find((l) => l.start)!;
    check(JSON.stringify(argv.argv) === JSON.stringify(['--acp']), `the agent got exactly its preset argv (${JSON.stringify(argv.argv)})`);

    // ── 2. The messenger: a message, the agent's turn, its permission options ──
    // A page of its own: the 개발실 fills the desk page.
    const side = await newPage({ viewport: { width: 1600, height: 1000 } });
    await side.getByRole('button', { name: /^메신저/ }).first().click();
    const messenger = side.getByRole('region', { name: '메신저', exact: true });
    await messenger.getByTestId('workers-alpha').locator('summary').click({ timeout: 20_000 });
    await messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha-g1/ }).first().click({ timeout: 20_000 });
    const talk = messenger.getByRole('region', { name: 'alpha-g1 대화' });
    const box = talk.getByLabel('보낼 글');
    await box.fill('빌드 폴더 정리해 줘');
    await box.press('Enter');
    await eventually('the prompt reached the agent', () => mockLog().some((l) => l.got?.method === 'session/prompt'), 30_000);
    check(
      JSON.stringify(mockLog().find((l) => l.got?.method === 'session/prompt')!.got.params.prompt).includes('빌드 폴더 정리해 줘'),
      'the messenger’s words went to the agent as session/prompt',
    );
    const card = talk.getByTestId('permission-card');
    await card.waitFor({ timeout: 30_000 });
    const kinds = await card.getByTestId('permission-option').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
    check(JSON.stringify(kinds) === JSON.stringify(['allow_once', 'allow_always', 'reject_once']), `the card offers the agent's options (${kinds.join(', ')})`);
    check((await card.innerText()).includes('rm -rf build'), 'the card names the call');
    await talk.getByText('빌드 폴더를 살펴볼게요.').first().waitFor({ timeout: 15_000 });
    check(true, 'the agent’s words show as its bubble');
    await shot(side, '02-messenger-permission-modern');
    await card.locator('[data-testid="permission-option"][data-kind="allow_once"]').click();
    await eventually('the answer reached the agent', () => mockLog().some((l) => l.answer), 15_000);
    const answers = mockLog().filter((l) => l.answer);
    check(
      answers.length === 1 && answers[0].answer.result?.outcome?.optionId === 'proceed_once',
      `이번만 허용 reached the agent exactly once (${JSON.stringify(answers.map((a) => a.answer.result))})`,
    );
    await talk.getByText('지웠어요. 다음 일을 알려 주세요.').first().waitFor({ timeout: 15_000 });
    check(true, 'the turn went on after the answer');
    await shot(side, '03-messenger-answered-modern');

    // ── 3. The 개발실: alpha-g1's 대화 pane ──
    if (!(await win.isVisible())) await desk.locator('[data-hud-id="icon:devroom"] button').click();
    await win.waitFor({ timeout: 20_000 });
    // The rail names the worktree's assignee once the repo is read again (it said 맡은 사람 없음 at first in one run).
    const wtCard = win.locator('[data-testid="devroom-card"]').filter({ hasText: '빌드 정리' }).filter({ hasText: 'alpha-g1' });
    await wtCard.first().click({ timeout: 60_000 }).catch((err: unknown) => {
      // Evidence for the late assignee: what the daemon recorded and what the rail shows.
      const rec = fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8');
      console.log(`worktrees.json: ${rec}\nworker list: ${cli('worker', 'list').stdout}`);
      throw err;
    });
    await win.locator('[data-testid="devroom-card"][data-picked]').filter({ hasText: '빌드 정리' }).waitFor({ timeout: 10_000 });
    const pane = win.locator('[data-testid="devroom-pane"][data-agent="alpha-g1"]');
    await pane.locator('[data-testid="chat-scroll"]').waitFor({ timeout: 20_000 });
    await pane.getByText('지웠어요. 다음 일을 알려 주세요.').first().waitFor({ timeout: 15_000 });
    check(true, "the 개발실's 대화 pane shows alpha-g1's conversation");
    const paneBox = pane.getByRole('textbox');
    await paneBox.fill('개발실에서 한 마디');
    await paneBox.press('Enter');
    await pane.getByText('개발실에서 받은 말에 답해요.').first().waitFor({ timeout: 20_000 });
    check(true, 'a message from the pane is answered in the pane');
    await shot(desk, '04-devroom-chat-modern');
    // aria-disabled (dimmed), yet pressed it shows why: Playwright counts it as disabled.
    await pane.locator('[data-testid="devroom-pane-view"][data-view="terminal"]').click({ force: true });
    await pane.getByTestId('devroom-term-chat').waitFor({ timeout: 10_000 });
    check((await pane.getByTestId('devroom-term-none').innerText()).includes('대화에서 보기'), 'its terminal side links the chat, not the runs');
    await shot(desk, '05-devroom-no-terminal-modern');
    await pane.getByTestId('devroom-term-chat').click();
    await pane.locator('[data-testid="chat-scroll"]').waitFor({ timeout: 10_000 });
    check(true, 'the link opens the 대화 view');

    // ── 4. 픽셀 감성: the same messenger and pane ──
    const pixel = await newPage({ viewport: { width: 1600, height: 1000 } }, 'pixel');
    await pixel.getByRole('button', { name: /^메신저/ }).first().click();
    const pm = pixel.getByRole('region', { name: '메신저', exact: true });
    await pm.getByTestId('workers-alpha').locator('summary').click({ timeout: 20_000 });
    await pm.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha-g1/ }).first().click({ timeout: 20_000 });
    await pm.getByRole('region', { name: 'alpha-g1 대화' }).getByText('개발실에서 받은 말에 답해요.').first().waitFor({ timeout: 15_000 });
    await shot(pixel, '06-messenger-pixel');
    check(true, '픽셀 감성: the messenger shows the conversation');

    // ── 5. The phone ──
    const phone = await newPage({ ...devices['iPhone 13'] });
    await phone.locator('[data-dock="devroom"]').tap();
    await phone.locator('[data-testid="devroom-card"]').filter({ hasText: '빌드 정리' }).first().tap({ timeout: 20_000 });
    const term = phone.getByTestId('devroom-phone-term');
    await term.getByText('개발실에서 받은 말에 답해요.').first().waitFor({ timeout: 20_000 });
    await phone.waitForTimeout(500);
    await shot(phone, '07-phone-devroom-chat');
    check(true, 'phone: the 개발실 opens alpha-g1 in 대화');
    console.log(`\n${oks} checks passed`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-acp-agents.daemon.log'), daemon.log.join(''));
    for (const [i, p] of opened.entries())
      await p.screenshot({ path: path.join(os.tmpdir(), `run-acp-agents.failure-${i}.png`) }).catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

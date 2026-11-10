/**
 * BRN K5 end to end on the REAL API: dist/cli.js in a temp HOME (the engine fake as `claude`, no real
 * agent), project `agent-tycoon` on a temp git repository with this repository's data shape: Tasks in
 * doing, review, blocked, done and todo, a renew term in renew-history.json and the Lead's delivered
 * handoff written by K1's own renewPrompt/basisLines (tags, 7 done lines, a long line, a planted
 * token). A second project `beta` has no handoff.
 *  1. the 개요 opens on the five lines, in order, from their sources (handoff with its time, board)
 *  2. tags stay visible ([판단], [미확인]); the planted token never reaches the page
 *  3. one row each (cut, not wrapped); a tap opens a line to every item and "N줄 더"
 *  4. beta says 인수인계 없음 and falls back to its board
 *  5. phone 390x844: the same five lines at the top of each devroom project, no sideways scroll
 * Screenshots in agent-tycoon/artifacts/feat-brain-resume-summary/.
 *
 *   taskset -c 8,9 nice -n 10 npx tsx agent-tycoon/test/run-brain-k5-resume.ts [port 18770-18779]
 */
import type { Browser, BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import { basisLines, handoffFormat, renewPrompt } from '../../server/src/agent-tycoon/engine/handoff.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, openWorkbenchTab, REPO_ROOT, startDaemon } from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]) || 18770;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/feat-brain-resume-summary');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
const TOKEN = 'ghp_K5plantedFakeToken0123456789abcdef';
const PHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } };
})();
let oks = 0;
const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually<T>(what: string, test: () => Promise<T | null | undefined | false>, timeout = 20_000): Promise<T> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

const HANDOFF = [
  '## 목표',
  '- [사실] Brain K3 에이전트 조회 도구를 끝내고 독립 검증에 넘긴다',
  '## 완료',
  '- [사실] get_resume_context 가 교대 기록과 인수인계를 읽는다 (7a6532a4)',
  '- [사실] 요약 끝 개수가 빠진 것처럼 읽히던 것을 고쳤다',
  '- [사실] 데몬에 붙인 러너 한 번 통과',
  '- [판단] fit() 이 16 KB 에서 충분히 자른다',
  '- 꼬리표 없는 완료 줄',
  '- [사실] 여섯째 완료',
  '- [사실] 일곱째 완료',
  '## 미해결',
  `- [판단] 폰 개발실에서 긴 줄이 넘칠 것 같다 ${'긴 설명이 이어진다 '.repeat(30)}`,
  `- [미확인] 배포 키가 바뀌었는지 모름 (token=${TOKEN})`,
  '## 다음 행동',
  '- [판단] K5 다섯 줄을 개요 맨 위에 붙인다',
  '- [미확인] engine.ts 는 다른 작업이 끝난 뒤 본다',
  '## 결정 (선택)',
  '- 다섯 줄에는 안 나오는 결정',
].join('\n');

async function main() {
  if (port < 18770 || port > 18779) throw new Error('port 18770-18779');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), typeof data === 'string' ? data : JSON.stringify(data));
  };
  const repo = makeTempRepo({ push: false });
  repo.write('README.md', '# agent-tycoon\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: readme']);
  const head = repo.git(['rev-parse', 'HEAD']).trim();
  const other = makeTempRepo({ push: false });
  other.write('README.md', '# beta\n');
  other.git(['add', '-A']);
  other.git(['commit', '-q', '-m', 'docs: readme']);
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', {
    v: 2,
    projects: [
      { projectId: 'p_aaaaaaaaaa', name: 'agent-tycoon', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' },
      { projectId: 'p_bbbbbbbbbb', name: 'beta', folder: other.folder, room: '개발실', leadAssignmentId: 'a_bbbbbbbbbb' },
    ],
  });
  put('assignments.json', {
    v: 1,
    assignments: [
      { assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true },
      { assignmentId: 'a_bbbbbbbbbb', projectId: 'p_bbbbbbbbbb', role: 'lead', provider: 'claude', wantRunning: true },
    ],
  });
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const t = (id: string, title: string, status: string, at: string, extra = {}, project = 'agent-tycoon') => ({ id, project, title, status, source: 'reported', createdAt: at, updatedAt: at, history: [], ...extra });
  put('tasks.json', {
    v: 2,
    tasks: [
      t('T-118', 'Brain K5 개요 다섯 줄', 'doing', ago(5), { assignee: { assignmentId: 'a_aaaaaaaaaa', name: 'agent-tycoon' } }),
      t('T-117', 'Brain K3 에이전트 조회 도구', 'review', ago(30)),
      t('T-116', '맥 서명 인증서 받기', 'blocked', ago(600)),
      t('T-115', 'K1 교대 인수인계 결함 수정', 'done', ago(90)),
      t('T-114', '지도 아키텍처 그래프', 'done', ago(200)),
      t('T-113', '메신저 뒤로 가기', 'done', ago(400)),
      t('T-112', '옛 일', 'done', ago(5000)),
      t('T-119', 'K4 시험 결과 모으기', 'todo', ago(60), { priority: 'P1' }),
      t('T-120', 'K6 Codex 실행 기록 보기', 'todo', ago(50), { priority: 'P2' }),
      t('T-2', 'beta 첫 화면', 'todo', ago(70), {}, 'beta'),
      t('T-3', 'beta 로그인', 'doing', ago(20), {}, 'beta'),
    ],
  });
  // K1's renew: the history term and the delivered handoff, written by K1's own functions.
  const endedAt = Date.now() - 2 * 60 * 60_000;
  put('renew-history.json', { v: 1, terms: [{ name: 'agent-tycoon', projectId: 'p_aaaaaaaaaa', sessionId: 'old-session-1', next: 'new-session-1', transcript: '/x/old-session-1.jsonl', bytes: 10, endedAt }] });
  const basis = basisLines({ oldSessionId: 'old-session-1', transcript: '/x/old-session-1.jsonl', folder: repo.folder, git: { branch: 'feat/brain-agent-queries', head, changed: 0 }, worktrees: [] }).join('\n');
  const message = renewPrompt({ when: '11-06 13:00', handoff: HANDOFF, file: 'handoff.md', format: handoffFormat(HANDOFF), basis });
  put(`inbox/agent-tycoon/delivered/${endedAt}-000001abcd.md`, message);

  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal']);
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  try {
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    if (fs.existsSync(FONT)) await ctx.route('**/__sp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    const page = await ctx.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });

    const api = (await (await page.request.get(`http://127.0.0.1:${port}/api/agty/spec/agent-tycoon/resume`)).json()) as { handoff: { done: { total: number; items: unknown[] } } | null };
    check(api.handoff?.done.total === 7 && api.handoff.done.items.length === 5, `the route reads the handoff, 5 of its 7 done lines (${api.handoff?.done.items.length}/${api.handoff?.done.total})`);
    check(!JSON.stringify(api).includes(TOKEN), 'the planted token is masked in the route answer');

    // ── 1. desktop 개요 ──
    await openWorkbenchTab(page, '개요', { project: 'agent-tycoon' });
    const win = page.locator(DEV_WINDOW);
    await win.getByTestId('hud-title-office').dblclick();
    const box = win.getByTestId('brain-resume');
    await eventually('the five lines with the handoff', async () => (await box.getAttribute('data-handoff')) === 'true');
    const line = (key: string) => box.locator(`[data-testid="brs-line"][data-key="${key}"]`);
    const keys = await box.getByTestId('brs-line').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
    check(keys.join(' ') === 'now done blocked who next', `1: five lines in order (${keys.join(' ')})`);
    const ovTop = await win.getByTestId('ov-top').boundingBox();
    const resumeBox = await box.boundingBox();
    const cols = await win.getByTestId('ov-col-issues').boundingBox();
    check(ovTop && resumeBox && cols && resumeBox.y > ovTop.y && resumeBox.y < cols.y, '1: right under the 개요 header, above the panels');
    const text = async (l: Locator) => (await l.locator('summary').textContent()) ?? '';
    const now = await text(line('now'));
    check(now.includes('T-118') && now.includes('T-117') && now.includes('Task 보드'), `1: 지금 = doing and review from the board (${now})`);
    const done = await text(line('done'));
    check(done.includes('인수인계 · 2시간 전') && done.includes('get_resume_context') && done.includes('T-115'), `1: 어디까지 = the handoff's 완료 with its time, then done Tasks (${done.slice(0, 120)}…)`);
    const next = await text(line('next'));
    check(next.includes('K5 다섯 줄') && !next.includes('T-119'), `1: 다음 = the handoff's 다음 행동 over the board (${next})`);
    const blocked = await text(line('blocked'));
    check(blocked.includes('T-116') && blocked.includes('폰 개발실'), `1: 막힘 = blocked Task and the handoff's 미해결 (${blocked.slice(0, 100)}…)`);
    const who = await text(line('who'));
    check(who.includes('agent-tycoon'), `1: 누구 names the Lead with its state (${who})`);

    // ── 2. tags and masking ──
    const tags = await box.locator('.brs-tag').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-tag')}:${e.textContent}`));
    check(tags.includes('judgement:판단') && tags.includes('unverified:미확인') && tags.includes('fact:사실') && tags.includes('untagged:미확인'), `2: tags visible as written; an untagged line reads 미확인 (${[...new Set(tags)].join(', ')})`);
    check(!(await page.content()).includes(TOKEN), '2: the planted token is nowhere on the page');
    check(!(await box.textContent())?.includes('다섯 줄에는 안 나오는 결정'), '2: the optional 결정 section stays out');

    // ── 3. one row each; open one ──
    const heights = await box.locator('summary').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    check(Math.max(...heights) - Math.min(...heights) <= 4 && Math.max(...heights) < 48, `3: each line is one row (${heights.join(', ')} px)`);
    const sum = line('blocked').locator('.brs-sum');
    check(await sum.evaluate((e) => e.scrollWidth > e.clientWidth), '3: the long 막힘 line is cut, not wrapped');
    await shot(page, '01-desktop-overview');
    await line('done').locator('summary').click();
    await line('blocked').locator('summary').click();
    await eventually('the lines open', async () => (await line('done').getAttribute('open')) !== null);
    const items = await line('done').getByTestId('brs-item').count();
    check(items === 8 && (await line('done').textContent())?.includes('인수인계에 2줄 더 있음'), `3: 어디까지 open: 5 handoff lines + 3 done Tasks, and "2줄 더" (${items})`);
    await wait(200);
    await box.screenshot({ path: path.join(OUT, '02-desktop-open.png') });

    // ── 4. beta: no handoff ──
    await win.getByRole('combobox', { name: '개발 프로젝트' }).selectOption('beta');
    await eventually('beta without a handoff', async () => (await box.getAttribute('data-handoff')) === 'false');
    const notes = await box.locator('[data-testid="brs-line"][data-note="noHandoff"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
    check(notes.join(' ') === 'done blocked next' && (await text(line('done'))).includes('인수인계 없음'), `4: beta says 인수인계 없음 where it reads one (${notes.join(' ')})`);
    check((await text(line('next'))).includes('T-2'), '4: beta\'s 다음 falls back to the top of 할 일');
    await box.screenshot({ path: path.join(OUT, '03-desktop-no-handoff.png') });
    const state = await ctx.storageState();
    await ctx.close();

    // ── 5. phone devroom ──
    const pctx = await browser.newContext({ ...PHONE, storageState: state });
    if (fs.existsSync(FONT)) await pctx.route('**/__sp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    const phone = await pctx.newPage();
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.addStyleTag({ content: FONT_CSS });
    await phone.locator('[data-dock="devroom"]').tap();
    const list = phone.getByTestId('devroom-phone');
    const pgroup = list.locator('[data-testid="devroom-group"][data-project="agent-tycoon"]');
    const pbox = pgroup.getByTestId('brain-resume');
    await eventually('phone five lines', async () => (await pbox.getAttribute('data-handoff').catch(() => null)) === 'true');
    const pk = await pbox.getByTestId('brs-line').count();
    const pb = await pbox.boundingBox();
    check(pk === 5 && pb && pb.width <= 390 && pb.x >= 0, `5: the five lines at the top of the phone devroom project (${pk}, ${pb?.width} px wide)`);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '5: no horizontal page scroll at 390 px');
    await wait(300);
    await shot(phone, '04-phone-devroom');
    await pbox.locator('[data-testid="brs-line"][data-key="blocked"] summary').tap();
    await wait(300);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '5: an open line wraps inside the phone width');
    await pbox.screenshot({ path: path.join(OUT, '05-phone-open.png') });
    await pctx.close();
    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    console.error(daemon.log.join('').split('\n').filter((l) => /spec|error/i.test(l)).slice(-20).join('\n'));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    repo.cleanup();
    other.cleanup();
  }
}
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

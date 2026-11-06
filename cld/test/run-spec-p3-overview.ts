/**
 * SPT-P3-OVERVIEW end to end on the REAL API (no page.route fixtures): dist/cli.js in a temp HOME (the
 * engine fake as `claude`, no real agent), project `alpha` on a temp git repository with an SRS of
 * five requirements, commits naming FR-ENG-001 and T-2, Tasks in todo, doing, review, blocked and
 * done (one done this week, one long ago), jobs with exit 0 and 1, and one merge record seeded in
 * merge-history.json before the daemon starts. Spec tracking on through the API.
 *  1. the 개요's numbers match the data (and the summary API)
 *  2. '미연결 N' opens 요구사항 on that filter with N rows
 *  2b. a 수용 number opens 요구사항 with 수용▾ on that state (acceptance=, SPT-P3-ACCEPT)
 *  3. a status number opens 이슈 with that column in view
 *  4. 최근 근거: a commit with its requirement chip tagged 관측, the failed job, the merge
 *  5. a chip opens the detail; back on the 개요, 최근 본 요구사항 shows it
 *  6. phone 390x844: the columns stack, no horizontal scroll
 *  7. the graph chunk is not requested on the 개요 (only once 최근 본 opens the graph)
 * Screenshots in cld/artifacts/spec-p3-overview/.
 *
 *   npx tsx cld/test/run-spec-p3-overview.ts [port 18294|18295]
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]) || 18294;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/spec-p3-overview');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
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

const SRS =
  '# SRS\n\n## 3.1 엔진\n\n| ID | 요구 |\n|---|---|\n| FR-ENG-001 | 엔진이 세션을 이어 받는다 (FR-ENG-002 참고) |\n| FR-ENG-002 | 엔진이 작업을 기록한다 |\n| FR-ENG-003 | 엔진이 꺼진 프로젝트를 건너뛴다 |\n\n' +
  '## 3.2 원격\n\n| ID | 요구 |\n|---|---|\n| FR-REM-001 | 바깥에서 사무실을 연다 |\n| FR-REM-002 | 폰에서 현황판을 본다 |\n';
const NOW = new Date().toISOString();
const LONG_AGO = '2026-01-05T08:00:00.000Z';

async function main() {
  if (port !== 18294 && port !== 18295) throw new Error('port 18294 or 18295');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  };
  const repo = makeTempRepo({ push: false });
  repo.write('docs/requirements/SRS.md', SRS);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(repo.folder, 'docs/requirements/SRS.md'), old, old);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS']);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'FR-ENG-001: resume the session after a restart']);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'T-2 follow-up: keep the resume token']);
  const resume = repo.git(['log', '--format=%H %s']).split('\n').find((l) => l.endsWith(' FR-ENG-001: resume the session after a restart'))!.slice(0, 40);
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', { v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] });
  put('assignments.json', { v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] });
  const t = (id: string, title: string, status: string, at = NOW, extra = {}) => ({ id, project: 'alpha', title, status, source: 'reported', createdAt: at, updatedAt: at, history: [], ...extra });
  put('tasks.json', {
    v: 2,
    tasks: [
      t('T-1', 'FR-ENG-002 기록 정리', 'doing', NOW, { assignee: { assignmentId: 'a_aaaaaaaaaa', name: 'old name' } }),
      t('T-2', '세션 이어 받기', 'review'),
      t('T-3', '원격 인증서 대기', 'blocked'),
      t('T-4', '설치 안내', 'done'),
      t('T-5', '옛 정리', 'done', LONG_AGO),
      t('T-6', '폰 현황판', 'todo'),
    ],
  });
  // The merge record, seeded before the daemon starts (W4's file in the settings directory).
  put('merge-history.json', { alpha: [{ ok: true, at: NOW, target: 'main', auto: true, task: 'T-4', branch: 'task/t-4', kind: 'ff', sha: resume }] });
  const jobs = path.join(home, '.local/state/cld-gui/jobs');
  fs.mkdirSync(jobs, { recursive: true });
  const job = (id: string, desc: string, cmd: string, exit: number, ended: string) => {
    fs.writeFileSync(path.join(jobs, `${id}.log`), '');
    fs.writeFileSync(
      path.join(jobs, `${id}.json`),
      JSON.stringify({ id, pid: null, pstart: null, boot: 'x', project: 'alpha', cmd, desc, dir: repo.folder, tab: null, tty: false, log: path.join(jobs, `${id}.log`), started: ended, ended, exit, source: 'cli' }),
    );
  };
  job('1103-080000-unit', 'unit FR-ENG-002', 'npm test', 0, '2026-11-03T08:01:00.000Z');
  job('1103-090000-deploy', 'deploy main', './deploy.sh', 1, '2026-11-03T09:01:00.000Z');
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal']);
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}, repo ${repo.folder}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  try {
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    if (fs.existsSync(FONT)) await ctx.route('**/__sp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    const page = await ctx.newPage();
    const graphChunk: string[] = [];
    page.on('request', (r) => {
      if (/TraceGraph|react-flow|xyflow/i.test(r.url())) graphChunk.push(r.url());
    });
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    const enabled = await page.evaluate(async () => (await fetch('/api/cld/spec/alpha/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docs: ['docs/requirements/SRS.md'] }) })).status);
    check(enabled === 200, `spec tracking on (${enabled})`);
    const sum = (await (await page.request.get(`http://127.0.0.1:${port}/api/cld/spec/alpha/summary`)).json()) as Record<string, unknown> & { work: { linked: number; total: number } };
    check(sum.unlinked === 3 && sum.observedOnly === 2 && sum.work.total === 5 && sum.work.linked === 0, `1: the summary API: unlinked 3, observed only 2, work 0/5 (${JSON.stringify({ u: sum.unlinked, o: sum.observedOnly, w: sum.work })})`);

    // ── the 개요 ──
    const icon = page.locator('[data-hud-id="icon:office"] button');
    await icon.waitFor();
    if (!(await page.locator(DEV_WINDOW).isVisible())) await icon.click();
    const win = page.locator(DEV_WINDOW);
    await win.getByRole('button', { name: '프로젝트', exact: true }).click();
    const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
    await picker.selectOption('alpha');
    await win.getByTestId('hud-title-office').dblclick();
    const tab = (name: string) => win.getByRole('button', { name, exact: true });
    await tab('개요').click();
    const ov = win.getByTestId('spec-cockpit');
    const count = async (id: string) => Number(await ov.getByTestId(`ov-${id}`).getAttribute('data-count'));
    await eventually('the 개요 with tracking on', async () => (await ov.getAttribute('data-enabled')) === 'true' && (await ov.getByTestId('ov-check-unlinked').count()) === 1 && (await ov.getByTestId('ov-commit').count()) > 0);
    const counts = Object.fromEntries(await Promise.all(['top-doing', 'top-review', 'top-blocked', 'issues-todo', 'issues-done', 'done-week', 'top-reqs', 'check-unlinked', 'check-review', 'check-missing', 'observed', 'work-linked', 'work-total', 'ev-integration'].map(async (id) => [id, await count(id)])));
    check(
      JSON.stringify(counts) ===
        JSON.stringify({ 'top-doing': 1, 'top-review': 1, 'top-blocked': 1, 'issues-todo': 1, 'issues-done': 2, 'done-week': 1, 'top-reqs': 5, 'check-unlinked': 3, 'check-review': 0, 'check-missing': 0, observed: 2, 'work-linked': 0, 'work-total': 5, 'ev-integration': 0 }),
      `1: the 개요's numbers match the data (${JSON.stringify(counts)})`,
    );
    check((await count('acc-none')) === 5 && (await count('acc-accepted')) === 0, `1: 수용 counts from SPT-P3-ACCEPT's summary.acceptance (검토 전 ${await count('acc-none')}, 수락 ${await count('acc-accepted')})`);
    check((await ov.getByTestId('ov-observed').textContent())?.includes('관측'), "1: the observed-only number carries the '관측' tag");
    const working = await ov.getByTestId('ov-task').allTextContents();
    check(working.length === 3 && working[0].includes('alpha') && working.some((w) => w.includes('막힘')), `진행 중 작업: doing, review and blocked with the assignee (its assignment's name now) and status (${working.join(' | ')})`);

    // ── 4. 최근 근거 ──
    const commit = ov.locator(`[data-testid="ov-commit"][data-sha="${resume}"]`);
    const chip = commit.getByTestId('ov-chip');
    check((await chip.getAttribute('data-status')) === 'observed' && (await chip.textContent())?.includes('FR-ENG-001') && (await chip.textContent())?.includes('관측'), `4: the commit naming FR-ENG-001 has its chip tagged 관측 (${await chip.textContent()})`);
    check((await ov.locator('[data-testid="ov-job"][data-exit="1"]').textContent())?.includes('deploy main'), '4: the failed job is listed with its exit 1');
    check((await ov.getByTestId('ov-merge').count()) === 1 && (await ov.getByTestId('ov-merge').textContent())?.includes('T-4'), `4: the seeded merge record (${await ov.getByTestId('ov-merge').textContent()})`);
    await wait(300);
    await shot(page, '01-overview');

    // ── 2. 미연결 → 요구사항 on that filter ──
    await ov.getByTestId('ov-check-unlinked').click();
    const reqs = win.getByTestId('spec-reqs');
    await eventually('the 미연결 list', async () => (await reqs.getByTestId('spec-reqs-show').getAttribute('data-show').catch(() => null)) === 'unlinked' && (await reqs.getByTestId('spec-item').count()) === 3);
    const ids = await reqs.getByTestId('spec-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
    check(ids.join(' ') === 'FR-ENG-003 FR-REM-001 FR-REM-002', `2: '미연결 3' opens 요구사항 with its 3 rows (${ids.join(' ')})`);
    await shot(page, '02-unlinked-list');

    // ── 2b. a 수용 number → 요구사항 on `acceptance=` (its own dimension, not a `show` chip) ──
    await tab('개요').click();
    await ov.getByTestId('ov-acc-none').click();
    await eventually('the 검토 전 list', async () => (await reqs.getByTestId('spec-reqs-acceptance').inputValue().catch(() => '')) === 'none' && (await reqs.getByTestId('spec-item').count()) === 5);
    check((await reqs.getByTestId('spec-reqs-show').count()) === 0, "2b: '검토 전 5' opens 요구사항 with 수용▾ on 검토 전 and its 5 rows, no show chip");

    // ── 3. a status number → 이슈 ──
    await tab('개요').click();
    await ov.getByTestId('ov-top-blocked').waitFor();
    await ov.getByTestId('ov-top-blocked').click();
    const body = win.getByTestId('workbench-body');
    await eventually('이슈 open', async () => (await body.getAttribute('data-tab')) === 'tasks' && (await body.locator('[data-testid="task-group"][data-status="blocked"]').count()) === 1);
    await wait(300);
    const bodyBox = await body.boundingBox();
    const colBox = await body.locator('[data-testid="task-group"][data-status="blocked"]').boundingBox();
    check(bodyBox && colBox && colBox.y >= bodyBox.y - 1 && colBox.y < bodyBox.y + bodyBox.height, `3: '막힘 1' opens 이슈 with the 막힘 column in view (column at ${colBox?.y}, body ${bodyBox?.y}-${bodyBox && bodyBox.y + bodyBox.height})`);
    await shot(page, '03-issues-blocked');

    // ── 5. a chip opens the detail; 최근 본 요구사항 ──
    await tab('개요').click();
    await chip.waitFor();
    await chip.click();
    const detail = win.getByTestId('spec-detail');
    await eventually('the detail', async () => (await detail.getAttribute('data-uid')) !== null && (await detail.getByTestId('spec-detail-id').textContent()) === 'FR-ENG-001');
    check((await body.getAttribute('data-tab')) === 'reqs', '5: the chip opens FR-ENG-001 in the 요구사항 detail');
    await shot(page, '04-chip-detail');
    const uid = (await detail.getAttribute('data-uid'))!;
    await tab('개요').click();
    const viewed = ov.locator(`[data-testid="ov-viewed"][data-uid="${uid}"]`);
    await eventually('최근 본', async () => (await viewed.count()) === 1);
    check((await viewed.textContent()) === 'FR-ENG-001', '5: 최근 본 요구사항 shows FR-ENG-001');
    await shot(page, '05-recently-viewed');

    // ── 7. no graph chunk on the 개요 ──
    check(graphChunk.length === 0, `7: the graph chunk was not requested while on the 개요 and 요구사항 (${graphChunk.join(', ') || 'none'})`);
    await viewed.click();
    const graph = win.getByTestId('spec-graph');
    await eventually('the neighbourhood', async () => (await graph.getAttribute('data-level').catch(() => null)) === 'neighbourhood');
    check(graphChunk.length > 0, '7: it loads only when 최근 본 opens the graph, on that neighbourhood');
    await shot(page, '06-viewed-graph');
    const state = await ctx.storageState();
    await ctx.close();

    // ── 6. phone ──
    const pctx = await browser.newContext({ ...PHONE, storageState: state });
    if (fs.existsSync(FONT)) await pctx.route('**/__sp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    const phone = await pctx.newPage();
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.addStyleTag({ content: FONT_CSS });
    await phone.locator('[data-dock="board"]').tap();
    const pw = phone.locator('[aria-label="현황판 화면"]');
    const dev = pw.getByRole('button', { name: '프로젝트', exact: true });
    if ((await dev.count()) && (await dev.getAttribute('aria-pressed')) !== 'true') await dev.tap();
    await pw.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name: '개요', exact: true }).tap();
    const pov = pw.getByTestId('spec-cockpit');
    await eventually('phone 개요', async () => (await pov.getByTestId('ov-col-check').count()) === 1);
    await wait(300);
    const cols = await Promise.all(['ov-col-issues', 'ov-col-reqs', 'ov-col-check'].map((id) => pov.getByTestId(id).boundingBox()));
    check(cols.every((b) => b && b.width >= 330) && cols[0]!.y < cols[1]!.y && cols[1]!.y < cols[2]!.y, `6: the columns stack on a phone (${cols.map((b) => `${b?.width}@${b?.y}`).join(' ')})`);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '6: no horizontal page scroll at 390 px');
    await shot(phone, '07-phone-overview');
    await pov.getByTestId('ov-recent').scrollIntoViewIfNeeded();
    await shot(phone, '08-phone-recent');
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
  }
}
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

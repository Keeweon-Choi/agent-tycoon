/**
 * SPT-P2 end to end on the REAL trace API (no page.route fixtures): dist/cli.js in a temp HOME (the
 * engine fake as `claude`, no real agent), one project `alpha` whose folder is a temp git repository
 * with an SRS (FR-ENG-001's 출처 cell names T-2), a commit naming FR-ENG-001 and one naming T-2,
 * Tasks in tasks.json (T-1's title names FR-ENG-002; T-9 is another project's and names FR-ENG-001)
 * and job records (one's description names FR-ENG-002, one deploy). Spec tracking on through the API.
 *  A. the API answers match the contract (core/src/cld/spec/trace.ts): graph at its three levels,
 *     item detail, pickers; every observed source is there with where its ID is; nothing of beta
 *  B. the 그래프 tab and the detail on that data: overview → group → neighbourhood; [확인] on T-2
 *     brings its commit as suggested; [연결 추가] a deploy job; 배포 확인 turns 배포 ✔; the 요구사항
 *     list's four state columns; links.json holds only the decisions
 * Screenshots in cld/artifacts/spec-p2/.
 *
 *   npx tsx cld/test/run-spec-p2-real.ts [port 18288|18289]
 */
import type { Browser, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import type { TraceEdge, TraceGraph, TraceItem, TraceNode, TracePick } from '../../core/src/cld/spec/trace.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, openOfficeWindow, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]) || 18288;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/spec-p2');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
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
  '# SRS\n\n## 3.1 엔진\n\n| ID | 요구 | 출처 |\n|---|---|---|\n| FR-ENG-001 | 엔진이 세션을 이어 받는다 (FR-ENG-002 참고) | T-2 |\n| FR-ENG-002 | 엔진이 작업을 기록한다 | |\n| FR-ENG-003 | 엔진이 꺼진 프로젝트를 건너뛴다 | |\n\n## 3.2 원격\n\n| ID | 요구 | 출처 |\n|---|---|---|\n| FR-REM-001 | 바깥에서 사무실을 연다 | |\n';
const AT = '2026-11-03T08:00:00.000Z';

// ── the contract, checked by shape ──
const TYPES = ['req', 'doc', 'task', 'commit', 'job', 'msg', 'comp', 'group'];
const RELS = ['implements', 'changes', 'verifies', 'discusses', 'realizes', 'refs'];
const STATUSES = ['confirmed', 'observed', 'suggested', 'rejected'];
const str = (v: unknown) => typeof v === 'string';
const opt = (v: unknown, f: (x: unknown) => boolean) => v === undefined || f(v);
const nodeOk = (n: TraceNode) => str(n.id) && TYPES.includes(n.type) && str(n.label) && opt(n.title, (t) => str(t) && (t as string).length <= 200) && opt(n.count, (c) => typeof c === 'number');
const edgeOk = (e: TraceEdge) => str(e.id) && str(e.from) && str(e.to) && RELS.includes(e.rel) && STATUSES.includes(e.status);
const graphOk = (g: TraceGraph) => ['overview', 'group', 'neighbourhood'].includes(g.level) && g.nodes.every(nodeOk) && g.edges.every(edgeOk) && opt(g.hidden, (h) => typeof h === 'number');

async function main() {
  if (port !== 18288 && port !== 18289) throw new Error('port 18288 or 18289');
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
  const shaOf = (subject: string) => repo.git(['log', '--format=%H %s']).split('\n').find((l) => l.slice(41) === subject)!.slice(0, 40);
  const resume = shaOf('FR-ENG-001: resume the session after a restart');
  const follow = shaOf('T-2 follow-up: keep the resume token');
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', { v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] });
  put('assignments.json', { v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] });
  const t = (id: string, project: string, title: string, status: string, extra = {}) => ({ id, project, title, status, source: 'reported', createdAt: AT, updatedAt: AT, history: [], ...extra });
  put('tasks.json', {
    v: 2,
    tasks: [
      t('T-1', 'alpha', 'FR-ENG-002 기록 정리', 'doing'),
      t('T-2', 'alpha', '세션 이어 받기', 'done', { reportedDone: { value: true, source: 'reported', at: AT } }),
      t('T-9', 'beta', 'FR-ENG-001 다른 프로젝트 일', 'todo'),
    ],
  });
  const jobs = path.join(home, '.local/state/cld-gui/jobs');
  fs.mkdirSync(jobs, { recursive: true });
  const job = (id: string, desc: string, cmd: string) => {
    fs.writeFileSync(path.join(jobs, `${id}.log`), '');
    fs.writeFileSync(
      path.join(jobs, `${id}.json`),
      JSON.stringify({ id, pid: null, pstart: null, boot: 'x', project: 'alpha', cmd, desc, dir: repo.folder, tab: null, tty: false, log: path.join(jobs, `${id}.log`), started: AT, ended: AT, exit: 0, source: 'cli' }),
    );
  };
  job('1103-080000-unit', 'unit FR-ENG-002', 'npm test');
  job('1103-090000-deploy', 'deploy main', './deploy.sh');
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
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    const api = async <T>(route: string): Promise<T> => {
      const r = await page.request.get(`http://127.0.0.1:${port}/api/cld/spec/alpha/${route}`);
      if (!r.ok()) throw new Error(`${route}: ${r.status()} ${await r.text()}`);
      return (await r.json()) as T;
    };
    const enabled = await page.evaluate(async () => (await fetch('/api/cld/spec/alpha/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docs: ['docs/requirements/SRS.md'] }) })).status);
    check(enabled === 200, `spec tracking on (${enabled})`);
    const items = (await api<{ items: Array<{ uid: string; displayId?: string; trace?: unknown }> }>('items')).items;
    const uid = Object.fromEntries(items.map((i) => [i.displayId ?? '', i.uid]));
    check(items.length === 4 && items.every((i) => i.trace), `four requirements, each with its trace (${items.map((i) => i.displayId).join(' ')})`);

    // ── A. the API against the contract ──
    const ov = await api<TraceGraph>('graph?level=overview');
    check(graphOk(ov) && ov.nodes.map((n) => `${n.label}:${n.count}`).join(' ') === 'FR-ENG:3 FR-REM:1', `A: overview groups by prefix (${ov.nodes.map((n) => `${n.label}:${n.count}`).join(' ')})`);
    const grp = await api<TraceGraph>(`graph?level=group&group=${encodeURIComponent(ov.nodes[0].id)}`);
    check(graphOk(grp) && grp.nodes.length === 3 && grp.nodes.every((n) => n.group === 'SRS.md · 3.1 엔진'), `A: the group's requirements in their section (${grp.nodes.map((n) => n.group).join(', ')})`);
    const hood = await api<TraceGraph>(`graph?level=neighbourhood&center=${uid['FR-ENG-001']}&depth=1`);
    const ends = hood.nodes.map((n) => n.id);
    check(graphOk(hood) && ends.includes('T-2') && ends.includes(resume) && ends.includes(uid['FR-ENG-002']) && !ends.includes('T-9'), `A: FR-ENG-001's neighbourhood: T-2, its commit, FR-ENG-002; not beta's T-9 (${hood.nodes.map((n) => n.label).join(' ')})`);
    const one = await api<TraceItem>(`item/${uid['FR-ENG-001']}`);
    const e = (it: TraceItem, to: string) => it.edges.find((x) => x.to === to || x.from === to);
    check(nodeOk(one.node) && one.edges.every(edgeOk) && one.nodes.every(nodeOk) && Array.isArray(one.history), 'A: the item detail has the contract shape');
    check(e(one, 'T-2')?.status === 'observed' && e(one, 'T-2')?.source?.path === 'docs/requirements/SRS.md' && e(one, 'T-2')?.source?.line === 7, `A: T-2 is observed where the SRS row names it (${JSON.stringify(e(one, 'T-2')?.source)})`);
    check(e(one, resume)?.status === 'observed' && e(one, resume)?.source?.sha === resume, 'A: the commit naming FR-ENG-001 is observed with its SHA');
    const two = await api<TraceItem>(`item/${uid['FR-ENG-002']}`);
    check(e(two, 'T-1')?.status === 'observed' && e(two, 'T-1')?.reason === 'title', "A: T-1's title names FR-ENG-002 (observed)");
    check(e(two, '1103-080000-unit')?.rel === 'verifies' && e(two, '1103-080000-unit')?.status === 'observed', "A: the job's description names FR-ENG-002 (observed verifies)");
    const picks = await api<{ candidates: TracePick[] }>('candidates?type=task&q=');
    check(picks.candidates.map((c) => c.id).join(' ') === 'T-1 T-2', `A: the Task picker offers this project's Tasks only (${picks.candidates.map((c) => c.id).join(' ')})`);
    const jobPicks = await api<{ candidates: TracePick[] }>('candidates?type=job&q=deploy');
    check(jobPicks.candidates.length === 1 && jobPicks.candidates[0].id === '1103-090000-deploy', 'A: the job picker finds the deploy job');
    check((await page.request.get(`http://127.0.0.1:${port}/api/cld/spec/alpha/candidates`).then((r) => r.json())).docs?.length > 0, "A: the 켜기 window's candidates (no type) still answer");
    check(!fs.existsSync(path.join(cfg, 'spec/p_aaaaaaaaaa/links.json')), 'A: nothing is stored before the owner decides');

    // ── B. the graph and the detail on that data ──
    await openOfficeWindow(page);
    const win = page.locator(DEV_WINDOW);
    await win.getByRole('button', { name: '개발', exact: true }).click();
    const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
    await picker.selectOption('alpha');
    const tab = (name: string) => win.getByRole('button', { name, exact: true });
    await win.getByTestId('hud-title-office').dblclick();
    await tab('지도').click();
    await win.getByTestId('map-views').locator('[data-view="trace"]').click(); // MAP-A: the requirements graph is the 지도's 요구사항 추적 view
    const graph = win.getByTestId('spec-graph');
    const node = (id: string) => graph.locator(`.react-flow__node[data-id="${id}"]`);
    await eventually('overview', async () => (await graph.locator('.react-flow__node-trace').count()) === 2);
    check((await node(ov.nodes[0].id).textContent())?.includes('FR-ENG'), 'B: the overview draws the two groups');
    await shot(page, '01-overview');
    await node(ov.nodes[0].id).click();
    await eventually('group', async () => (await graph.getAttribute('data-level')) === 'group' && (await graph.locator('.react-flow__node-trace').count()) === 3);
    check((await node(uid['FR-ENG-003']).textContent())?.includes('미연결'), 'B: FR-ENG-003 has nothing: 미연결');
    await shot(page, '02-group');
    await node(uid['FR-ENG-001']).dblclick();
    await eventually('neighbourhood', async () => (await graph.getAttribute('data-level')) === 'neighbourhood' && (await node('T-2').count()) === 1);
    // React Flow draws the edges once the nodes are measured, a frame after the nodes.
    await eventually('observed edges', async () => (await graph.locator('.tg-e--observed').count()) >= 3);
    check(true, 'B: a double click on a requirement in the group reaches its neighbourhood, with the observed links');
    await shot(page, '03-neighbourhood');
    await node(uid['FR-ENG-001']).click();
    const detail = win.getByTestId('spec-detail');
    await eventually('detail', async () => (await detail.getAttribute('data-uid')) === uid['FR-ENG-001'] && (await detail.getByTestId('spec-link').count()) >= 3);
    await shot(page, '04-detail-observed');
    const linkTo = (to: string) => detail.locator(`[data-testid="spec-link"][data-to="${to}"]`);
    await linkTo('T-2').getByTestId('spec-link-confirm').click();
    await eventually('T-2 confirmed and its commit suggested', async () => (await linkTo('T-2').getAttribute('data-status')) === 'confirmed' && (await linkTo(follow).getAttribute('data-status')) === 'suggested');
    check(true, "B: [확인] on T-2 stores it; T-2's commit shows as suggested");
    const work = await detail.getByTestId('spec-detail-work').textContent();
    check(work?.includes('작업 1'), `B: 작업 counts the confirmed Task (${work})`);
    await detail.getByTestId('spec-add').click();
    const add = detail.getByTestId('spec-add-link');
    await add.getByTestId('spec-add-type').selectOption('job');
    await add.getByTestId('spec-add-kind').selectOption('deploy');
    await eventually('deploy job candidate', async () => (await add.locator('[data-id="1103-090000-deploy"]').count()) === 1);
    await add.locator('[data-id="1103-090000-deploy"]').click();
    await eventually('deploy linked', async () => (await linkTo('1103-090000-deploy').getAttribute('data-status')) === 'confirmed');
    const evidence = () => detail.getByTestId('spec-detail-evidence').locator('[data-axis="deploy"]').getAttribute('data-led');
    check((await evidence()) === 'half', `B: the deploy job's exit 0 alone is ◐ (${await evidence()})`);
    await linkTo('1103-090000-deploy').getByTestId('spec-deploy').click();
    const dialog = page.getByTestId('spec-deploy-dialog');
    await dialog.waitFor();
    await dialog.getByTestId('spec-deploy-confirm').click();
    await eventually('deploy observed', async () => (await evidence()) === 'on');
    check(true, 'B: 배포 확인 makes 배포 ✔');
    await shot(page, '05-detail-confirmed');
    await detail.getByTestId('spec-detail-close').click();
    await tab('요구사항').click();
    const row = win.locator(`[data-testid="spec-item"][data-uid="${uid['FR-ENG-001']}"]`);
    await eventually('row', async () => (await row.count()) === 1);
    const cols = await row.getByTestId('spec-item-trace').locator('[data-col]').evaluateAll((els) => els.map((e) => (e.getAttribute('data-col') === 'evidence' ? [...e.querySelectorAll('[data-led]')].map((l) => ({ on: '✔', half: '◐', off: '–' })[l.getAttribute('data-led') as 'on']).join('') : e.textContent)));
    check(cols.join(' | ') === '끝남 1 | ✔✔–✔ | 검토 전 | 최신', `B: the list shows the four states from the real API (${cols.join(' | ')})`);
    await shot(page, '06-reqs-list');
    const stored = JSON.parse(fs.readFileSync(path.join(cfg, 'spec/p_aaaaaaaaaa/links.json'), 'utf-8')) as { links: Array<{ status: string; rel: string }>; deploys: unknown[] };
    check(stored.links.map((l) => `${l.status}:${l.rel}`).sort().join(' ') === 'confirmed:implements confirmed:verifies' && stored.deploys.length === 1, `B: links.json holds only the two decisions and the deploy confirmation (${stored.links.map((l) => l.rel).join(' ')})`);
    check((fs.statSync(path.join(cfg, 'spec/p_aaaaaaaaaa/links.json')).mode & 0o777) === 0o600, 'B: links.json is 0600');
    await ctx.close();
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

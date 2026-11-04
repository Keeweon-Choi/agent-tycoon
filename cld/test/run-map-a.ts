/**
 * MAP-A end to end on the REAL API (no page.route fixtures but the font): dist/cli.js in a temp
 * HOME (the engine fake as `claude`, no real agent). Project `alpha`'s folder is a temp git
 * repository holding a copy of this repository's cld/docs and its top folders and one level below
 * (one empty file each); `beta` keeps spec tracking off; `gamma` tracks one note with no requirement
 * and no folder. Tasks: T-1 doing, T-2 done with a completion report, T-3 review.
 *  0. 지도 → 구조: folder proposals and documents' diagrams; [제안 모두 승인] makes the top modules
 *     with no typing; [되돌리기] takes it back; approved again
 *  1. a module card → Inspector → [관련 요구사항 보기] → a requirement centred in the trace graph →
 *     its component node → back at that module in the structure; a requirement node opens its detail
 *  3. a commit naming the requirement and T-2's completion report leave its acceptance at none
 *  6. keyboard: Tab to a card, Enter picks, Enter goes in, Esc comes back up
 *  2. the module's document edited: its card reads 재검토 필요
 *  4. beta (tracking off) and gamma (no requirement) open on an empty map
 *  5. phone 390x844: the left pane folded, the Inspector a full-screen sheet, no horizontal scroll
 * Also the daemon's RSS with no viewer and every project off, and the first paint of the 지도 tab.
 * Screenshots in cld/artifacts/map-a/.
 *
 *   npx tsx cld/test/run-map-a.ts [port 18308|18309]
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { type Browser, devices } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { TraceItem, TraceMap } from '../../core/src/cld/spec/trace.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, openOfficeWindow, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]) || 18308;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/map-a');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 480_000;
const AT = '2026-11-03T10:00:00.000Z';
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
async function eventually<T>(what: string, test: () => Promise<T | null | undefined | false>, timeout = 40_000): Promise<T> {
  for (const end = Date.now() + timeout; ; await wait(300)) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}
const rssKb = (pid: number) => Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf-8'))?.[1] ?? 0);
const md = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? md(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []));

async function main() {
  if (port !== 18308 && port !== 18309) throw new Error('port 18308 or 18309');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  };
  const old = new Date(Date.now() - 60_000); // settled: the scan reads them now
  const repo = makeTempRepo({ push: false });
  fs.cpSync(path.join(REPO_ROOT, 'cld/docs'), path.join(repo.folder, 'cld/docs'), { recursive: true });
  const tree = (args: string[]) => execFileSync('git', ['ls-tree', '-d', '--name-only', 'HEAD', ...args], { cwd: REPO_ROOT, encoding: 'utf-8' }).split('\n').filter(Boolean);
  const tops = tree([]);
  for (const d of [...tops, ...tree(['--', ...tops.map((x) => `${x}/`)])]) {
    fs.mkdirSync(path.join(repo.folder, d), { recursive: true });
    if (!fs.existsSync(path.join(repo.folder, d, 'keep.txt'))) fs.writeFileSync(path.join(repo.folder, d, 'keep.txt'), '');
  }
  for (const f of md(path.join(repo.folder, 'cld/docs'))) fs.utimesSync(f, old, old);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs and folders']);
  const offRepo = makeTempRepo({ push: false });
  offRepo.write('docs/requirements/SRS.md', '# SRS\n\n| ID | 요구 |\n|---|---|\n| FR-OFF-001 | 꺼진 프로젝트 |\n');
  offRepo.git(['add', '-A']);
  offRepo.git(['commit', '-q', '-m', 'srs']);
  const emptyRepo = makeTempRepo({ push: false });
  emptyRepo.write('notes.md', '# 메모\n\n그냥 메모예요.\n');
  fs.utimesSync(path.join(emptyRepo.folder, 'notes.md'), old, old);
  emptyRepo.git(['add', '-A']);
  emptyRepo.git(['commit', '-q', '-m', 'notes']);
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const proj = (n: string, letter: string, folder: string) => ({ projectId: `p_${letter.repeat(10)}`, name: n, folder, room: '개발실', leadAssignmentId: `a_${letter.repeat(10)}` });
  put('projects.json', { v: 2, projects: [proj('alpha', 'a', repo.folder), proj('beta', 'b', offRepo.folder), proj('gamma', 'c', emptyRepo.folder)] });
  put('assignments.json', { v: 1, assignments: ['a', 'b', 'c'].map((l) => ({ assignmentId: `a_${l.repeat(10)}`, projectId: `p_${l.repeat(10)}`, role: 'lead', provider: 'claude', wantRunning: false })) });
  const task = (id: string, title: string, status: string, more: object = {}) => ({ id, project: 'alpha', title, status, priority: 'P1', owner: { kind: 'worker', name: 'Ann' }, source: 'reported', createdAt: AT, updatedAt: AT, history: [], ...more });
  put('tasks.json', { v: 2, tasks: [task('T-1', '지도 작업 하나', 'doing'), task('T-2', '지도 작업 둘', 'done', { reportedDone: { value: true, source: 'reported', at: AT } }), task('T-3', '지도 작업 셋', 'review')] });
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal']);
  const pid = daemon.child.pid!;
  console.log(`daemon pid ${pid} on ${port}, HOME ${home}, repo ${repo.folder}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  try {
    const login = await daemon.loginUrl();
    // ── RSS with no viewer, every project off (tracking is turned on only later) ──
    await wait(20_000); // past the start's own garbage
    const rss0 = rssKb(pid);
    await wait(20_000);
    const rss1 = rssKb(pid);
    console.log(`perf: daemon RSS with no viewer, all projects off: ${rss0} kB at 20 s → ${rss1} kB at 40 s`);
    check(rss1 <= rss0 + 8 * 1024, `RSS with no viewer does not grow (${rss0} → ${rss1} kB)`);
    check(!fs.existsSync(path.join(cfg, 'spec')), 'nothing was analysed: no spec folder before tracking is turned on');

    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const font = async (c: typeof ctx) => {
      if (fs.existsSync(FONT)) await c.route('**/__sp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    };
    await font(ctx);
    const page = await ctx.newPage();
    await page.goto(login);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const api = async <T>(project: string, route: string): Promise<T> => {
      const r = await page.request.get(`http://127.0.0.1:${port}/api/cld/spec/${project}/${route}`);
      if (!r.ok()) throw new Error(`${route}: ${r.status()} ${await r.text()}`);
      return (await r.json()) as T;
    };
    const map = (uid = 'root', project = 'alpha') => api<TraceMap>(project, `map?uid=${uid}`);
    const post = (project: string, route: string, body: object) =>
      page.evaluate(async ([pr, r, b]) => (await fetch(`/api/cld/spec/${pr}/${r}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).status, [project, route, body] as const);

    const off = await map('root', 'beta');
    check(!off.enabled && !off.cards.length && !fs.existsSync(path.join(cfg, 'spec/p_bbbbbbbbbb')), '4: beta (tracking off): the map API answers empty and nothing of beta is analysed or stored');
    const cand = await api<{ docs: Array<{ path: string; preselect: boolean }> }>('alpha', 'candidates');
    const withMermaid = md(path.join(repo.folder, 'cld/docs')).filter((f) => fs.readFileSync(f, 'utf-8').includes('```mermaid')).map((f) => path.relative(repo.folder, f));
    const picked = [...new Set([...cand.docs.filter((d) => d.preselect).map((d) => d.path), ...withMermaid])];
    const t0 = Date.now();
    check((await post('alpha', 'enable', { docs: picked })) === 200, `alpha: spec tracking on with ${picked.length} documents of cld/docs (${Date.now() - t0} ms)`);
    check((await post('gamma', 'enable', { docs: ['notes.md'] })) === 200, 'gamma: spec tracking on with one note');
    const q0 = Date.now();
    const m0 = await map();
    const q1 = Date.now();
    await map();
    console.log(`perf: map query on this repository: first ${q1 - q0} ms (index built), held ${Date.now() - q1} ms (HTTP included)`);
    check(m0.pending.folders.length > 0 && m0.pending.diagrams.length > 0 && m0.cards.every((c) => c.standing !== 'approved'), `alpha: ${m0.pending.diagrams.length} diagrams and ${m0.pending.folders.length} folders wait for approval; no card approved yet`);

    await openOfficeWindow(page);
    const win = page.locator(DEV_WINDOW);
    await win.getByRole('button', { name: '개발', exact: true }).click();
    const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
    await picker.selectOption('alpha');
    await win.getByTestId('hud-title-office').dblclick(); // maximized
    const tab = (name: string) => win.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name, exact: true });
    const cards = win.getByTestId('map-cards');
    const card = (id: string) => cards.locator(`[data-testid="map-card"][data-id="${id}"]`);
    const inspector = win.getByTestId('map-inspector');
    const p0 = Date.now();
    await tab('지도').click();
    await eventually('the cards', async () => (await cards.getByTestId('map-card').count()) > 0);
    console.log(`perf: 지도 tab first paint (lazy chunk + map query): ${Date.now() - p0} ms`);
    const views = await win.getByTestId('map-views').getByRole('button').allTextContents();
    check(views.join('|') === '구조|기능 흐름|요구사항 추적' && (await tab('지도').count()) === 1, `the tab is 지도 with 구조 | 기능 흐름 | 요구사항 추적 (${views.join('|')})`);
    await shot(page, '01-structure-before');

    // ── 0. [제안 모두 승인] ──
    const approveAll = win.getByTestId('map-approve-all');
    check(((await approveAll.textContent()) ?? '').includes(`폴더 ${m0.pending.folders.length}`), `0: [제안 모두 승인] names what it approves (${await approveAll.textContent()})`);
    await approveAll.click();
    await eventually('approved', async () => (await cards.locator('[data-testid="map-card"]:not([data-standing="approved"])').count()) === 0 && (await win.getByTestId('map-undo-all').count()) === 1);
    const m1 = await map();
    check(m1.cards.every((c) => c.standing === 'approved' && c.origin === 'owner_confirmed') && m1.cards.some((c) => c.label === 'server/'), `0: one click: every top card approved, folders under their own names (${m1.cards.map((c) => c.label).join(', ')})`);
    const arch1 = JSON.parse(fs.readFileSync(path.join(cfg, 'spec/p_aaaaaaaaaa/arch.json'), 'utf-8')) as { rev: number; history: Array<{ action: string }> };
    check(arch1.rev === 1 && arch1.history.map((h) => h.action).join() === 'approved-all', '0: one write (arch.json rev 1, one approved-all line in its history)');
    await shot(page, '02-approved-all');
    await win.getByTestId('map-undo-all').click();
    await eventually('undone', async () => (await win.getByTestId('map-approve-all').count()) === 1 && (await win.getByTestId('map-undo-all').count()) === 0);
    check((await map()).cards.every((c) => c.standing !== 'approved'), '0: [되돌리기] brings the proposals back');
    await win.getByTestId('map-approve-all').click();
    await eventually('approved again', async () => (await win.getByTestId('map-undo-all').count()) === 1);

    // A module read from a document with suggested requirements; two of them confirmed, Tasks on them, a commit naming one.
    const all = await map();
    let comp = '';
    let mod: TraceMap | null = null;
    for (const r of all.tree.filter((x) => x.id.startsWith('c_') && !x.children)) {
      const v = await map(r.id);
      if (v.selected.reqs.suggested >= 2 && v.selected.sources.length) {
        comp = r.id;
        mod = v;
        break;
      }
    }
    check(comp && mod, `a module with suggested requirements: ${mod?.selected.label} (${mod?.selected.reqs.suggested} suggested)`);
    const [ra, rb] = mod!.reqs;
    check((await post('alpha', 'links/confirm', { edges: [ra, rb].map((r) => ({ from: r.uid, to: comp, rel: 'realizes' })) })) === 200, `${ra.label} and ${rb.label} confirmed to ${mod!.selected.label}`);
    for (const [r, t] of [
      [ra, 'T-1'],
      [ra, 'T-2'],
      [rb, 'T-3'],
    ] as const)
      check((await post('alpha', 'links', { from: r.uid, to: t, rel: 'implements' })) === 200, `${t} confirmed to ${r.label}`);
    repo.write('cld/map-a-note.txt', 'x');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', `map: ${ra.label} 작업 T-1`]);
    const m2 = await eventually('counts', async () => {
      const v = await map(comp);
      return v.selected.reqs.confirmed === 2 && v.selected.activeTasks === 2 ? v : null;
    });
    check(m2.selected.reqs.suggested === mod!.selected.reqs.suggested - 2, `the module counts 2 confirmed, ${m2.selected.reqs.suggested} suggested apart, 2 active Tasks (T-1 doing, T-3 review; T-2 done is not)`);

    // ── 1. card → Inspector → requirements → trace graph → back ──
    const crumbs = m2.crumbs.slice(1, -1); // the levels above the module
    await win.getByTestId('map-crumbs').getByRole('button').first().click(); // the root
    for (const c of crumbs) {
      await eventually(`card ${c.label}`, async () => (await card(c.id).count()) === 1);
      await card(c.id).click();
      await eventually('inspector', async () => (await inspector.getAttribute('data-id')) === c.id);
      await card(c.id).dblclick();
      await eventually(`inside ${c.label}`, async () => (await cards.getAttribute('data-at')) === c.id);
    }
    await eventually('the module card', async () => (await card(comp).count()) === 1);
    await card(comp).click();
    await eventually('its Inspector', async () => (await inspector.getAttribute('data-id')) === comp && (await inspector.getByTestId('map-req-counts').getAttribute('data-confirmed')) === '2');
    const counts = inspector.getByTestId('map-req-counts');
    const hud = await counts.locator('.game-hud').evaluateAll((els) => els.map((e) => `${e.querySelector('.game-hud-k')?.textContent}=${e.getAttribute('data-count')}`));
    check((await counts.getAttribute('data-tasks')) === '2' && hud[0] === '확정=2' && hud[2] === `추정=${m2.selected.reqs.suggested}` && hud[3] === '진행 중 Task=2', `1: the Inspector's counters keep 확정, 관측 and 추정 apart, 진행 중 Task 2 (${hud.join(' ')})`);
    check((await inspector.getByTestId('map-source').count()) > 0, '1: and where it is written, with [원본 열기]');
    await shot(page, '03-inspector');
    await inspector.getByTestId('map-to-trace').click();
    const traceReqs = win.getByTestId('map-trace-reqs');
    await eventually('the trace list', async () => (await traceReqs.getAttribute('data-id')) === comp && (await traceReqs.getByTestId('map-trace-req').count()) > 0);
    const statuses = await traceReqs.getByTestId('map-trace-req').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')));
    check(statuses[0] === 'confirmed' && statuses[1] === 'confirmed' && statuses.slice(2).every((s) => s === 'suggested'), `1: 요구사항 추적 lists the module's requirements, confirmed first, suggested marked (${statuses.join(',')})`);
    await traceReqs.locator(`[data-testid="map-trace-req"][data-uid="${ra.uid}"]`).click();
    const graph = win.getByTestId('spec-graph');
    await eventually('centred', async () => (await graph.getAttribute('data-level')) === 'neighbourhood' && (await graph.locator(`[data-testid="spec-graph-list"] li[data-id="${comp}"]`).count()) === 1);
    check(true, `1: ${ra.label} centred in the trace graph with ${mod!.selected.label} beside it`);
    await shot(page, '04-trace');
    await graph.locator(`[data-testid="spec-graph-list"] li[data-id="${ra.uid}"]`).getByTestId('spec-graph-item').click();
    const detail = win.getByTestId('spec-detail');
    await eventually('the requirement detail', async () => (await detail.getAttribute('data-uid')) === ra.uid);
    check(true, '1: the requirement node opens the existing detail');
    // ── 3. acceptance unmoved by a commit or a completion report ──
    const item = await eventually('the commit seen', async () => {
      const i = await api<TraceItem>('alpha', `item/${ra.uid}`);
      return i.node.state?.evidence?.reported && i.edges.some((e) => e.rel === 'changes') ? i : null;
    }, 60_000);
    check(item.node.state?.acceptance?.current === 'none', `3: a commit naming ${ra.label} and T-2's completion report leave its acceptance at none (evidence ${JSON.stringify(item.node.state?.evidence)})`);
    await shot(page, '05-trace-detail');
    await graph.locator(`[data-testid="spec-graph-list"] li[data-id="${comp}"]`).getByTestId('spec-graph-item').click();
    await eventually('back in the structure', async () => (await win.getByTestId('map-tab').getAttribute('data-view')) === 'structure' && (await inspector.getAttribute('data-id')) === comp);
    check((await card(comp).getAttribute('aria-pressed')) === 'true', '1: the component node brings the structure back with the same module selected');
    await shot(page, '06-back-to-module');

    // ── 6. keyboard ──
    await win.getByTestId('map-crumbs').getByRole('button').first().click();
    await eventually('root', async () => (await cards.getAttribute('data-at')) === 'root');
    const firstId = (await map()).cards.find((c) => c.children)!.id;
    const first = card(firstId);
    await first.focus();
    await page.keyboard.press('Tab');
    const secondId = await page.evaluate(() => document.activeElement?.getAttribute('data-id'));
    check(secondId && secondId !== firstId, '6: Tab moves to the next card');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await eventually('picked', async () => (await first.getAttribute('aria-pressed')) === 'true' && (await inspector.getAttribute('data-id')) === firstId);
    check(true, '6: Enter picks the card (the Inspector shows it)');
    await page.keyboard.press('Enter');
    await eventually('in', async () => (await cards.getAttribute('data-at')) === firstId);
    check(true, '6: Enter again goes in');
    await page.keyboard.press('Escape');
    await eventually('up', async () => (await cards.getAttribute('data-at')) === 'root');
    check(true, '6: Esc comes back up');

    // ── 2. the module's document edited: 재검토 필요 ──
    const src = m2.selected.sources[0];
    const file = path.join(repo.folder, src.path);
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    let fence = src.line - 1;
    while (fence > 0 && !/^\s*```\s*mermaid/.test(lines[fence])) fence--;
    lines.splice(fence + 2, 0, '  mapAnew[Map A new part]');
    fs.writeFileSync(file, lines.join('\n'));
    fs.utimesSync(file, old, old);
    await eventually('the edit scanned', async () => (await map(comp)).selected.standing === 'review', 60_000);
    const parent = m2.crumbs[m2.crumbs.length - 2].id;
    await win.getByTestId('map-tree').locator(`[data-testid="map-tree-row"][data-id="${comp}"]`).click();
    await eventually('the page shows 재검토 필요', async () => (await cards.getAttribute('data-at')) === parent && (await card(comp).getAttribute('data-standing')) === 'review');
    check(((await card(comp).textContent()) ?? '').includes('재검토 필요'), `2: after ${src.path} changed, ${mod!.selected.label} reads 재검토 필요`);
    await shot(page, '07-review');
    check(repo.git(['status', '--porcelain']).trim() === `M ${src.path}`, '2: the repository has only the test’s own edit (the daemon wrote nothing there)');

    // ── 4. tracking off and no requirement: empty maps ──
    await picker.selectOption('beta');
    await tab('지도').click();
    await eventually('beta empty', async () => (await win.getByTestId('map-empty').getAttribute('data-why')) === 'off');
    check(true, '4: beta (tracking off) opens on 명세 추적이 꺼져 있어요');
    await shot(page, '08-off');
    await picker.selectOption('gamma');
    await tab('지도').click();
    // gamma's repository holds one folder (the temp repository's `sub/`): only that proposal, no requirement anywhere.
    const g = await map('root', 'gamma');
    check(g.enabled && g.reqTotal === 0 && g.cards.every((c) => c.standing === 'proposed') && !g.reqs.length, `4: gamma has no requirement and no module but a folder proposal (${g.cards.map((c) => c.label).join(', ')})`);
    await eventually('gamma map', async () => (await cards.getByTestId('map-card').count()) === g.cards.length && (await win.getByTestId('map-root-card').textContent())?.includes('gamma'));
    await win.getByTestId('map-views').locator('[data-view="trace"]').click();
    await eventually('gamma trace', async () => ((await win.getByTestId('map-trace-reqs').textContent()) ?? '').includes('연결된 요구사항이 없어요'));
    check(true, '4: gamma opens safely: its 요구사항 추적 says no requirement is linked');
    await shot(page, '09-no-requirements');
    await win.getByTestId('map-views').locator('[data-view="flow"]').click();
    check(((await win.getByTestId('map-flow-empty').textContent()) ?? '').includes('다음 단계'), '기능 흐름 shows its honest empty state');
    await shot(page, '10-empty-flow');
    const state = await ctx.storageState();
    await ctx.close();

    // ── 5. phone ──
    const pctx = await browser.newContext({ ...PHONE, storageState: { cookies: state.cookies, origins: state.origins.map((o) => ({ ...o, localStorage: o.localStorage.filter((x) => !x.name.includes('workbench')) })) } });
    await font(pctx);
    const phone = await pctx.newPage();
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.addStyleTag({ content: FONT_CSS });
    await phone.locator('[data-dock="board"]').tap();
    const pw = phone.locator('[aria-label="현황판 화면"]');
    const dev = pw.getByRole('button', { name: '개발', exact: true });
    if ((await dev.count()) && (await dev.getAttribute('aria-pressed')) !== 'true') await dev.tap();
    const ppicker = pw.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the phone picker', async () => (await ppicker.locator('option[value="alpha"]').count()) > 0);
    await ppicker.selectOption('alpha');
    await pw.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name: '지도', exact: true }).tap();
    const pcards = pw.getByTestId('map-cards');
    await eventually('phone cards', async () => (await pcards.getByTestId('map-card').count()) > 0);
    const fold = pw.getByTestId('map-nav-fold');
    check((await fold.count()) === 1 && (await fold.getAttribute('open')) === null, '5: the left pane is folded on a phone');
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '5: no horizontal page scroll at 390 px');
    await shot(phone, '11-phone-structure');
    await pcards.getByTestId('map-card').first().tap();
    const sheet = phone.getByTestId('map-inspector');
    await eventually('phone Inspector', async () => (await sheet.count()) === 1);
    const box = await sheet.boundingBox();
    check(box && box.x <= 1 && box.width >= 388 && box.height >= 800, `5: the Inspector is a full-screen sheet (${box?.width}x${box?.height})`);
    await shot(phone, '12-phone-inspector');
    await sheet.getByTestId('map-inspector-close').tap();
    await eventually('sheet closed', async () => (await sheet.count()) === 0);
    await fold.locator('summary').tap();
    await eventually('nav open', async () => (await fold.getByTestId('map-tree-row').count()) > 1);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '5: still no horizontal scroll with the left pane open');
    await shot(phone, '13-phone-nav');
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
    for (const r of [repo, offRepo, emptyRepo]) r.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

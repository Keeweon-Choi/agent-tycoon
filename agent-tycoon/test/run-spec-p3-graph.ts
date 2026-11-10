/**
 * SPT-P3-GRAPH visual check: dist/cli.js in a temp HOME (the engine fake as `claude`, no real agent),
 * one project `alpha` whose folder is a temp git repository with a small SRS, spec tracking on. The
 * trace API (SPT-P2, built in parallel) is served from fixtures with Playwright `page.route`
 * (graph, item, candidates, links, review, deploy-confirm), built on the daemon's real UIDs; the
 * 요구사항 list is the daemon's own answer with the four states added. Mutations are checked as
 * request payloads.
 *  1. overview → group → neighbourhood (breadcrumbs, compound boxes, '미연결', '커밋 +4')
 *  2. an edge click shows its provenance (observed: where the ID is; confirmed: who)
 *  3. filters (확정만 → '숨긴 것 N개', kinds, 보기, depth 2) and keyboard (edges not focusable, Enter picks)
 *  4. fold and unfold the commits
 *  5. the detail opens from the graph and from the 요구사항 list (four state columns)
 *  6. [확인] / [아님] / [모두 확인] send the right requests; [연결 추가]; 배포 확인
 *  7. [연결 검토함]
 *  8. phone 390x844: graph with the list under it, detail full screen, no horizontal scroll
 * Screenshots in agent-tycoon/artifacts/spec-p3-graph/.
 *
 *   npx tsx agent-tycoon/test/run-spec-p3-graph.ts [port 18286|18287]
 */
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import type { TraceEdge, TraceGraph, TraceNode } from '../../core/src/agent-tycoon/spec/trace.js';
import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import {
  assertPortFree,
  type Daemon,
  DEV_WINDOW,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]) || 18286;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/spec-p3-graph');
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
  '# SRS\n\n## 3.1 엔진\n\n| ID | 요구 |\n|---|---|\n| FR-ENG-001 | 엔진이 세션을 이어 받는다 |\n| FR-ENG-002 | 엔진이 작업을 기록한다 |\n| FR-ENG-003 | 엔진이 꺼진 프로젝트를 건너뛴다 |\n\n## 3.2 원격\n\n| ID | 요구 |\n|---|---|\n| FR-REM-001 | 바깥에서 사무실을 연다 |\n';
const AT = '2026-11-03T08:00:00.000Z';
const sha = (n: number) => `${String(n).repeat(7)}abcdef0123456789abcdef0123456789a`.slice(0, 40);

/** The fixtures, on the daemon's own UIDs. */
function fixtures(uid: Record<string, string>) {
  const [e1, e2, e3, r1] = ['FR-ENG-001', 'FR-ENG-002', 'FR-ENG-003', 'FR-REM-001'].map((id) => uid[id]);
  const src = { path: 'docs/requirements/SRS.md' };
  const rich = {
    work: { total: 2, byStatus: { doing: 1, done: 1 } },
    evidence: { change: 'observed', integration: 'observed', test: 'reported', deploy: 'reported', reported: true },
    acceptance: { current: 'none' },
    freshness: 'review',
    linkReview: true,
  } as const;
  const doing = { work: { total: 1, byStatus: { doing: 1 } }, evidence: { change: 'reported', integration: 'none', test: 'none', deploy: 'none', reported: false }, acceptance: { current: 'none' }, freshness: 'current' } as const;
  const req = (id: string, label: string, title: string, line: number, state?: TraceNode['state'], group?: string): TraceNode => ({ id, type: 'req', label, title, state, group, source: { ...src, line } });
  const reqs = {
    e1: req(e1, 'FR-ENG-001', '엔진이 세션을 이어 받는다', 7, rich, 'SRS.md · 3.1 세션'),
    e2: req(e2, 'FR-ENG-002', '엔진이 작업을 기록한다', 8, doing, 'SRS.md · 3.1 세션'),
    e3: req(e3, 'FR-ENG-003', '엔진이 꺼진 프로젝트를 건너뛴다', 9, undefined, 'SRS.md · 3.1 꺼짐'),
  };
  const overview: TraceGraph = {
    level: 'overview',
    nodes: [
      { id: 'grp:FR-ENG', type: 'group', label: 'FR-ENG', count: 3, state: { work: { total: 3, byStatus: { done: 1, doing: 2 } }, evidence: rich.evidence, acceptance: { current: 'none' }, freshness: 'review' } },
      { id: 'grp:FR-REM', type: 'group', label: 'FR-REM', count: 1, state: { acceptance: { current: 'none' }, freshness: 'current' } },
    ],
    edges: [],
  };
  const group: TraceGraph = {
    level: 'group',
    nodes: [reqs.e1, reqs.e2, reqs.e3],
    edges: [{ id: 'l-ref', from: e1, to: e2, rel: 'refs', status: 'observed', source: { ...src, line: 7 } }],
  };
  const task = (id: string, title: string): TraceNode => ({ id, type: 'task', label: id, title });
  const commit = (n: number, title: string): TraceNode => ({ id: sha(n), type: 'commit', label: sha(n).slice(0, 7), title, source: { sha: sha(n) } });
  const job = (id: string, title: string): TraceNode => ({ id, type: 'job', label: id, title, source: { jobId: id } });
  const hoodNodes: TraceNode[] = [
    { ...reqs.e1, group: undefined },
    task('T-0101', '세션 이어 받기'),
    task('T-0102', 'FR-ENG-001 재시작'),
    task('T-0103', '다른 일'),
    commit(1, 'FR-ENG-001 resume'),
    commit(2, 'FR-ENG-001 tests'),
    commit(3, 'FR-ENG-001 docs'),
    commit(4, 'engine: resume'),
    commit(5, 'T-0101 follow-up'),
    job('J-1', 'deploy check'),
    job('J-2', 'unit FR-ENG-001'),
    { id: 'd_adr0009', type: 'doc', label: 'ADR-0009', title: '세션 엔진', source: { path: 'docs/adr/0009.md', line: 1 } },
  ];
  const ed = (id: string, to: string, rel: TraceEdge['rel'], status: TraceEdge['status'], extra: Partial<TraceEdge> = {}): TraceEdge => ({ id, from: e1, to, rel, status, ...extra });
  const hoodEdges: TraceEdge[] = [
    ed('l1', 'T-0101', 'implements', 'confirmed', { by: { kind: 'owner' }, at: AT }),
    ed('l2', 'T-0102', 'implements', 'observed', { source: { taskId: 'T-0102' }, reason: 'Task title' }),
    ed('l3', 'T-0103', 'implements', 'rejected', { by: { kind: 'owner' }, at: AT }),
    ed('l4', sha(1), 'changes', 'observed', { source: { sha: sha(1) } }),
    ed('l5', sha(2), 'changes', 'observed', { source: { sha: sha(2) } }),
    ed('l6', sha(3), 'changes', 'observed', { source: { sha: sha(3) } }),
    ed('l7', sha(4), 'changes', 'confirmed', { by: { kind: 'owner' }, at: AT }),
    { id: 'l8', from: 'T-0101', to: sha(5), rel: 'changes', status: 'suggested', reason: 'T-0101 커밋' },
    ed('l9', 'J-1', 'verifies', 'confirmed', { kind: 'deploy', by: { kind: 'owner' }, at: AT }),
    ed('l10', 'J-2', 'verifies', 'observed', { kind: 'unit', source: { jobId: 'J-2' } }),
    ed('l11', 'd_adr0009', 'refs', 'suggested', { reason: 'ADR-0009 제목이 같다' }),
  ];
  const hood1: TraceGraph = { level: 'neighbourhood', center: e1, nodes: hoodNodes, edges: hoodEdges };
  const hood2: TraceGraph = {
    ...hood1,
    nodes: [...hoodNodes, { ...reqs.e2, group: undefined }, job('J-3', 'integration T-0101')],
    edges: [...hoodEdges, ed('l12', e2, 'refs', 'observed', { source: { ...src, line: 7 } }), { id: 'l13', from: 'T-0101', to: 'J-3', rel: 'verifies', status: 'suggested', reason: 'T-0101 시험' }],
    hidden: 3,
  };
  const ends = (edges: TraceEdge[]) => hoodNodes.filter((n) => edges.some((e) => e.to === n.id));
  const itemEdges = hoodEdges.filter((e) => e.from === e1);
  const item = (u: string) =>
    u === e1
      ? {
          node: reqs.e1,
          edges: itemEdges,
          nodes: ends(itemEdges),
          history: [
            { at: AT, kind: 'identity', action: 'created' },
            { at: AT, kind: 'link', action: 'confirmed', detail: 'T-0101', by: { kind: 'owner' } },
            { at: AT, kind: 'identity', action: 'textChanged', detail: '5c24f88' },
          ],
        }
      : { node: Object.values(reqs).find((r) => r.id === u) ?? { id: u, type: 'req', label: u }, edges: [], nodes: [], history: [] };
  const candidates = {
    task: [{ id: 'T-0200', label: 'T-0200', title: '세션 저장 정리' }],
    commit: [{ id: sha(7), label: sha(7).slice(0, 7), title: 'engine: save' }],
    job: [{ id: 'J-9', label: 'J-9', title: 'deploy main' }],
  };
  const trace: Record<string, unknown> = { [e1]: rich, [e2]: doing, [r1]: { acceptance: { current: 'accepted' }, freshness: 'current', evidence: { change: 'observed', integration: 'observed', test: 'observed', deploy: 'observed', reported: true }, work: { total: 1, byStatus: { done: 1 } } } };
  return { e1, e2, e3, overview, group, hood1, hood2, item, candidates, trace };
}

type Post = { path: string; body: unknown };

async function main() {
  if (port !== 18286 && port !== 18287) throw new Error('port 18286 or 18287');
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
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', { v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] });
  put('assignments.json', { v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] });
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal']);
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}, repo ${repo.folder}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  try {
    browser = await launchBrowser();
    const posts: Post[] = [];
    const graphUrls: string[] = [];
    let fx: ReturnType<typeof fixtures> | null = null;
    const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    /** The trace API from fixtures; everything else of the daemon is real. */
    const routes = async (ctx: BrowserContext) => {
      if (fs.existsSync(FONT)) await ctx.route('**/__sp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      await ctx.route(
        (url) => url.pathname.startsWith('/api/agty/spec/alpha/'),
        async (route) => {
          const url = new URL(route.request().url());
          const rest = url.pathname.slice('/api/agty/spec/alpha/'.length);
          const method = route.request().method();
          if (!fx) return route.continue();
          if (rest === 'graph') {
            graphUrls.push(url.search);
            const level = url.searchParams.get('level');
            return route.fulfill(json(level === 'overview' ? fx.overview : level === 'group' ? fx.group : url.searchParams.get('depth') === '2' ? fx.hood2 : fx.hood1));
          }
          if (rest.startsWith('item/')) return route.fulfill(json(fx.item(decodeURIComponent(rest.slice(5)))));
          if (rest === 'candidates' && url.searchParams.get('type'))
            return route.fulfill(json({ candidates: fx.candidates[url.searchParams.get('type') as 'task'] ?? [] }));
          if (method === 'POST' && ['links', 'links/confirm', 'links/reject', 'review', 'deploy-confirm'].includes(rest)) {
            posts.push({ path: rest, body: route.request().postDataJSON() });
            return route.fulfill(json({ ok: true }));
          }
          if (rest.startsWith('items')) {
            const real = await route.fetch();
            const body = (await real.json()) as { items: Array<{ uid: string; trace?: unknown }> };
            for (const it of body.items) it.trace = fx.trace[it.uid];
            return route.fulfill(json(body));
          }
          return route.continue();
        },
      );
    };
    const expectPost = async (p: string, body: unknown, text: string) => {
      const seen = () => posts.some((x) => x.path === p && isDeepStrictEqual(x.body, body));
      await eventually(`POST ${p} ${JSON.stringify(body)}`, async () => seen()).catch((err: Error) => {
        throw new Error(`${err.message}; sent ${JSON.stringify(posts)}`);
      });
      check(true, `${text} (${p} ${JSON.stringify(body)})`);
    };
    const hangul = (p: Page) => p.addStyleTag({ content: FONT_CSS });
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await routes(ctx);
    const page = await ctx.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await hangul(page);
    // Spec tracking on, through the real API; the fixtures use the UIDs it gave.
    const enabled = await page.evaluate(async () => (await fetch('/api/agty/spec/alpha/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docs: ['docs/requirements/SRS.md'] }) })).status);
    check(enabled === 200, `spec tracking on (${enabled})`);
    const items = (await (await page.request.get(`http://127.0.0.1:${port}/api/agty/spec/alpha/items`)).json()).items as Array<{ uid: string; displayId?: string }>;
    fx = fixtures(Object.fromEntries(items.map((i) => [i.displayId ?? '', i.uid])));
    check(items.length === 4, `four requirements with UIDs (${items.map((i) => i.displayId).join(' ')})`);

    await openOfficeWindow(page);
    const win = page.locator(DEV_WINDOW);
    await win.getByRole('button', { name: '프로젝트', exact: true }).click();
    const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
    await picker.selectOption('alpha');
    const tab = (name: string) => win.getByRole('button', { name, exact: true });
    const names = await win.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button').allTextContents();
    check(names.join(' ') === '개요 이슈 요구사항 지도 문서 에이전트 변경', `지도 (MAP-A, was 그래프) comes after 요구사항 (${names.join(' ')})`);
    await win.getByTestId('hud-title-office').dblclick(); // maximized: graph and detail side by side

    // ── 1. overview → group → neighbourhood ──
    await tab('지도').click();
    await win.getByTestId('map-views').locator('[data-view="trace"]').click(); // MAP-A: the requirements graph is the 지도's 요구사항 추적 view
    const graph = win.getByTestId('spec-graph');
    const node = (id: string) => graph.locator(`.react-flow__node[data-id="${id}"]`);
    const level = () => graph.getAttribute('data-level');
    await eventually('overview nodes', async () => (await graph.locator('.react-flow__node-trace').count()) === 2);
    check((await level()) === 'overview', '1: the graph opens on the overview of groups');
    const grpText = await node('grp:FR-ENG').textContent();
    check(grpText?.includes('FR-ENG') && grpText.includes('요구사항 3'), `1: a group node shows its name and count (${grpText})`);
    const attribution = graph.locator('.react-flow__attribution');
    check((await attribution.isVisible()) && (await attribution.textContent())?.includes('React Flow'), '1: the React Flow attribution is shown');
    check((await graph.locator('.react-flow__edge[tabindex]').count()) === 0, '1: edges are not focusable');
    await shot(page, '01-overview');
    await node('grp:FR-ENG').click();
    await eventually('group level', async () => (await level()) === 'group' && (await graph.locator('.react-flow__node-trace').count()) === 3);
    const crumbs = await graph.getByTestId('spec-graph-crumbs').getByRole('button').allTextContents();
    check(crumbs.join(' › ') === '전체 › FR-ENG', `1: breadcrumbs (${crumbs.join(' › ')})`);
    check((await graph.locator('.react-flow__node-box').count()) === 2, '1: two sections drawn as cluster boxes (parent nodes)');
    check((await node(fx.e3).textContent())?.includes('미연결'), '1: the requirement without links shows 미연결');
    check((await node(fx.e1).locator('.tg-dot').count()) === 4, '1: a requirement node has four state dots');
    await shot(page, '02-group');
    await node(fx.e1).click();
    const detail = win.getByTestId('spec-detail');
    await eventually('detail from the graph', async () => (await detail.getAttribute('data-uid')) === fx!.e1 && (await detail.getByTestId('spec-detail-freshness').count()) > 0);
    check(true, '5: a click on a requirement node opens its detail');
    await node(fx.e1).dblclick();
    await eventually('neighbourhood', async () => (await level()) === 'neighbourhood' && (await graph.locator('.react-flow__node-trace').count()) > 5);
    check(graphUrls.at(-1) === `?level=neighbourhood&center=${encodeURIComponent(fx.e1)}&depth=1`, `1: a double click asks for the neighbourhood (${graphUrls.at(-1)})`);
    const fold = node(`fold:${fx.e1}`);
    check((await fold.textContent()) === '커밋 +4', `4: the four commits of FR-ENG-001 fold into one node (${await fold.textContent()})`);
    check((await node(sha(5)).count()) === 1, "4: T-0101's single commit stays a node");
    await shot(page, '03-neighbourhood');
    await graph.getByTestId('spec-graph-crumbs').getByRole('button', { name: 'FR-ENG', exact: true }).click();
    await eventually('back to the group', async () => (await level()) === 'group');
    check(true, '1: the breadcrumb goes back a level');
    await graph.locator(`[data-testid="spec-graph-list"] li[data-id="${fx.e1}"]`).getByTestId('spec-graph-open').click();
    await eventually('neighbourhood again', async () => (await level()) === 'neighbourhood');
    await detail.getByTestId('spec-detail-close').click();

    // ── 2. edge provenance ──
    /** Edges fan out of one node, so their midpoints crowd: click 85% along the path, near its own end. */
    const clickEdge = async (id: string) => {
      const at = await graph.locator(`[data-testid="rf__edge-${id}"] .react-flow__edge-interaction`).evaluate((el) => {
        const p = el as SVGPathElement;
        const pt = p.getPointAtLength(p.getTotalLength() * 0.85);
        const m = p.getScreenCTM()!;
        return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
      });
      await page.mouse.click(at.x, at.y);
    };
    await clickEdge('l2');
    const pop = graph.getByTestId('spec-edge-pop');
    await eventually('observed provenance', async () => (await pop.getAttribute('data-status')) === 'observed');
    const popText = await pop.textContent();
    check(popText?.includes('관측') && popText.includes('T-0102에 ID가 적혀 있어요'), `2: an observed edge says where the ID is written (${popText})`);
    check((await graph.locator('[data-testid="rf__edge-l2"] .react-flow__edge-text').textContent()) === '관측', "2: the observed edge carries the '관측' tag");
    await shot(page, '04-edge-observed');
    await pop.getByRole('button', { name: '닫기' }).click();
    await clickEdge('l1');
    await eventually('confirmed provenance', async () => (await pop.getAttribute('data-status')) === 'confirmed');
    check((await pop.textContent())?.includes('사장님'), `2: a confirmed edge says who confirmed it (${await pop.textContent()})`);
    const dash = await graph.locator('[data-testid="rf__edge-l11"] .react-flow__edge-path').evaluate((p) => getComputedStyle(p).strokeDasharray);
    const dim = await graph.locator('[data-testid="rf__edge-l3"]').evaluate((p) => getComputedStyle(p).opacity);
    check(dash.includes('6') && Number(dim) < 1, `2: suggested is dashed (${dash}), rejected is dimmed (${dim})`);

    // ── 3. filters and keyboard ──
    const links = graph.getByTestId('spec-graph-links');
    const hidden = graph.getByTestId('spec-graph-hidden');
    await links.selectOption('confirmed');
    await eventually('hidden count', async () => (await hidden.count()) > 0);
    const hiddenN = Number(await hidden.getAttribute('data-count'));
    check(hiddenN === 8 && (await graph.locator('.tg-e--observed, .tg-e--suggested, .tg-e--rejected').count()) === 0, `3: 확정만 leaves only confirmed edges and says 숨긴 것 ${hiddenN}개`);
    await shot(page, '05-filter-confirmed');
    await links.selectOption('suggested');
    await graph.getByTestId('spec-graph-types').locator('input[data-type="job"]').uncheck();
    await eventually('jobs hidden', async () => (await graph.locator('.react-flow__node[data-id="J-1"]').count()) === 0);
    check(Number(await hidden.getAttribute('data-count')) === 2, `3: unticking 작업 기록 hides the two jobs (${await hidden.getAttribute('data-count')})`);
    await graph.getByTestId('spec-graph-show-all').click();
    await eventually('all shown', async () => (await hidden.count()) === 0 && (await node('J-1').count()) === 1);
    check(true, "3: '보기' shows everything again");
    await graph.getByTestId('spec-graph-depth').selectOption('2');
    await eventually('depth 2', async () => (await node('J-3').count()) === 1);
    check(graphUrls.at(-1)?.endsWith('depth=2') && (await hidden.getAttribute('data-count')) === '3', `3: depth 2 asks again and shows the server's hidden count (${graphUrls.at(-1)})`);
    await graph.getByTestId('spec-graph-depth').selectOption('1');
    await eventually('depth 1', async () => (await node('J-3').count()) === 0);
    await node('T-0101').focus();
    await page.keyboard.press('Enter');
    await eventually('node picked by Enter', async () => (await graph.getByTestId('spec-node-pop').textContent())?.includes('T-0101'));
    check(true, '3: Enter on a focused node picks it');

    // ── 4. fold / unfold ──
    await graph.getByTestId('spec-node-pop').getByRole('button', { name: '닫기' }).click();
    await fold.click();
    await eventually('unfolded', async () => (await fold.count()) === 0 && (await node(sha(1)).count()) === 1);
    check((await Promise.all([1, 2, 3, 4].map((n) => node(sha(n)).count()))).every((c) => c === 1), '4: a click on 커밋 +4 shows the four commits');
    await shot(page, '06-commits-unfolded');
    await graph.getByTestId('spec-graph-refold').click();
    await eventually('folded again', async () => (await fold.count()) === 1);
    check(true, '4: 커밋 접기 folds them again');

    // ── 5-7. detail from the graph: links, actions ──
    await node(fx.e1).click();
    await eventually('detail', async () => (await detail.getAttribute('data-uid')) === fx!.e1 && (await detail.getByTestId('spec-link').count()) === 10);
    const ev = await detail.getByTestId('spec-detail-evidence').locator('[data-axis]').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-axis'), e.getAttribute('data-led')])));
    check(ev.change === 'on' && ev.deploy === 'half' && ev.reported === 'half' && (await detail.getByTestId('game-legend').count()) === 1, `5: 근거 shows the LEDs, 완료 보고 and the legend (${JSON.stringify(ev)})`);
    check((await detail.getByTestId('spec-detail-acceptance').textContent())?.includes('검토 전') && (await detail.getByTestId('spec-detail-freshness').textContent())?.includes('재검토 필요'), '5: 수용 검토 전, 최신 재검토 필요');
    check((await detail.getByTestId('spec-detail-work').textContent())?.includes('작업 2'), `5: 작업 shows the Task counts (${await detail.getByTestId('spec-detail-work').textContent()})`);
    const rels = await detail.getByTestId('spec-rel').evaluateAll((els) => els.map((e) => e.getAttribute('data-rel')));
    check(rels.join(' ') === 'implements changes verifies refs', `5: links grouped by rel (${rels.join(' ')})`);
    await shot(page, '07-detail-from-graph');
    const linkTo = (to: string) => detail.locator(`[data-testid="spec-link"][data-to="${to}"]`);
    await linkTo('T-0102').getByTestId('spec-link-confirm').click();
    await expectPost('links/confirm', { edges: [{ from: fx.e1, to: 'T-0102', rel: 'implements' }] }, '6: [확인] on an observed link confirms that one link');
    await linkTo('J-2').getByTestId('spec-link-reject').click();
    await expectPost('links/reject', { from: fx.e1, to: 'J-2', rel: 'verifies' }, '6: [아님] rejects it');
    const bulk = detail.getByTestId('spec-bulk');
    check((await bulk.count()) === 1 && (await bulk.getAttribute('data-count')) === '3', '6: [모두 확인] for the three commits seen by their messages');
    await bulk.getByTestId('spec-confirm-all').click();
    await expectPost('links/confirm', { edges: [1, 2, 3].map((n) => ({ from: fx!.e1, to: sha(n), rel: 'changes' })) }, '6: [모두 확인] sends the three in one request');
    await detail.getByTestId('spec-review').click();
    await expectPost('review', { uid: fx.e1 }, '7: [연결 검토함] sends review for this requirement');
    await detail.getByTestId('spec-add').click();
    const add = detail.getByTestId('spec-add-link');
    await eventually('task candidates', async () => (await add.getByTestId('spec-add-pick').count()) === 1);
    await add.getByTestId('spec-add-pick').click();
    await expectPost('links', { from: fx.e1, to: 'T-0200', rel: 'implements' }, '6: [연결 추가] links a picked Task');
    await detail.getByTestId('spec-add').click();
    await add.getByTestId('spec-add-type').selectOption('job');
    await add.getByTestId('spec-add-kind').selectOption('deploy');
    await eventually('job candidates', async () => (await add.locator('[data-id="J-9"]').count()) === 1);
    await shot(page, '08-add-link-job');
    await add.locator('[data-id="J-9"]').click();
    await expectPost('links', { from: fx.e1, to: 'J-9', rel: 'verifies', kind: 'deploy' }, '6: [연결 추가] links a job as a deploy check');
    await linkTo('J-1').getByTestId('spec-deploy').click();
    const dialog = page.getByTestId('spec-deploy-dialog');
    await dialog.waitFor();
    await shot(page, '09-deploy-confirm');
    await dialog.getByTestId('spec-deploy-confirm').click();
    await expectPost('deploy-confirm', { jobId: 'J-1' }, '6: 배포 확인 records the deploy for the job');
    await detail.getByTestId('spec-detail-close').click();

    // ── 5. detail from the 요구사항 list ──
    await tab('요구사항').click();
    const row = (u: string) => win.locator(`[data-testid="spec-item"][data-uid="${u}"]`);
    await eventually('rows', async () => (await row(fx!.e1).count()) === 1);
    const cols = await row(fx.e1).getByTestId('spec-item-trace').locator('[data-col]').evaluateAll((els) => els.map((e) => (e.getAttribute('data-col') === 'evidence' ? [...e.querySelectorAll('[data-led]')].map((l) => ({ on: '✔', half: '◐', off: '–' })[l.getAttribute('data-led') as 'on']).join('') : e.textContent)));
    check(cols.join(' | ') === '진행 중 1 · 끝남 1 | ✔✔◐◐ | 검토 전 | 재검토 필요', `5: the list shows the four states (${cols.join(' | ')})`);
    await row(fx.e2).getByRole('button').click();
    await eventually('detail from the list', async () => (await win.getByTestId('spec-detail').getAttribute('data-uid')) === fx!.e2 && (await win.getByTestId('spec-detail-freshness').count()) > 0);
    check(true, '5: a row of 요구사항 opens the detail');
    await shot(page, '10-reqs-detail');
    const phoneState = await ctx.storageState();
    await ctx.close();

    // ── 8. phone ──
    const pctx = await browser.newContext({ ...PHONE, storageState: phoneState });
    await routes(pctx);
    const phone = await pctx.newPage();
    await phone.goto(`http://127.0.0.1:${port}/`);
    await hangul(phone);
    await phone.locator('[data-dock="board"]').tap();
    const pw = phone.locator('[aria-label="현황판 화면"]');
    const dev = pw.getByRole('button', { name: '프로젝트', exact: true });
    if ((await dev.count()) && (await dev.getAttribute('aria-pressed')) !== 'true') await dev.tap();
    const nav = pw.getByRole('navigation', { name: '개발 메뉴' });
    const phoneTabs = await nav.getByRole('button').allTextContents();
    check(phoneTabs.join(' ') === '개요 이슈 요구사항 지도 문서 더보기', `8: phone tabs (${phoneTabs.join(' ')})`);
    await nav.getByRole('button', { name: '지도', exact: true }).tap();
    await pw.getByTestId('map-views').locator('[data-view="trace"]').tap();
    const pg = pw.getByTestId('spec-graph');
    await eventually('phone overview', async () => (await pg.locator('.react-flow__node-trace').count()) === 2);
    await pg.locator('[data-testid="spec-graph-list"] li[data-id="grp:FR-ENG"]').getByTestId('spec-graph-item').tap();
    await eventually('phone group', async () => (await pg.getAttribute('data-level')) === 'group');
    await wait(400); // fitView after the remount
    const box = await pg.locator('.tg-root').boundingBox();
    const list = await pg.getByTestId('spec-graph-list').boundingBox();
    check(box && list && box.width >= 340 && list.y >= box.y + box.height, `8: the graph takes the width (${box?.width}px) and the list sits under it`);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '8: no horizontal page scroll on 지도 at 390 px');
    await shot(phone, '11-phone-graph');
    await pg.locator(`[data-testid="spec-graph-list"] li[data-id="${fx.e1}"]`).getByTestId('spec-graph-item').tap();
    const pd = phone.getByTestId('spec-detail'); // on the body (portal), above the Dock page
    await eventually('phone detail', async () => (await pd.getByTestId('spec-detail-freshness').count()) > 0);
    const dbox = await pd.boundingBox();
    check(dbox && dbox.width >= 389 && dbox.height >= 840, `8: the detail is full screen on a phone (${dbox?.width}x${dbox?.height})`);
    await shot(phone, '12-phone-detail');
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * SPT-P4C, end to end on the REAL API (no page.route fixtures but the font): dist/cli.js in a temp
 * HOME (the engine fake as `claude`, no real agent). Project `alpha`'s folder is a temp git
 * repository with an SRS (FR-ARC-001 names 'Scheduler'; FR-ARC-002 has a 구현 모듈 column naming
 * `server/queue.ts`; FR-ARC-003 names nothing) and a design document whose flowchart has Scheduler,
 * Queue, Worker and a node labelled `server`. Desktop 1600x1000, then phone 390x844:
 *  1. FR-ARC-001's detail shows Scheduler suggested (why: the requirement names it); [확인] confirms it
 *  2. FR-ARC-002 shows `server` observed from its module column
 *  3. [연결 추가] with the 구성요소 picker links FR-ARC-003 to Worker
 *  4. the 아키텍처 view shows the requirement counts; Worker's detail lists FR-ARC-003, the chip opens it
 *  5. the requirement graph's neighbourhood of FR-ARC-001 shows Scheduler
 *  6. Worker removed from the diagram: FR-ARC-003's link stays, its end missing (nothing deleted)
 *  7. phone: the detail full screen with its 구성요소 group, the 아키텍처 counts, no horizontal scroll
 * Screenshots in agent-tycoon/artifacts/spec-p4c/.
 *
 *   npx tsx agent-tycoon/test/run-spec-p4c-arch-links.ts [port 18304|18305]
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { type Browser, devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import type { TraceArch, TraceItem } from '../../core/src/agent-tycoon/spec/trace.js';
import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, openOfficeWindow, REPO_ROOT, startDaemon } from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]) || 18304;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/spec-p4c');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 360_000;
const PHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } };
})();
const SRS = [
  '# SRS',
  '',
  '## 3.1 작업 처리',
  '',
  '| ID | 요구 | 구현 모듈 |',
  '|---|---|---|',
  '| FR-ARC-001 | The Scheduler splits the jobs by priority | |',
  '| FR-ARC-002 | 작업을 줄 세워 순서대로 넘긴다 | server/queue.ts |',
  '| FR-ARC-003 | 작업 하나를 실행하고 결과를 남긴다 | |',
  '',
].join('\n');
const DESIGN = (worker: boolean) =>
  ['# 작업 처리 설계', '', '```mermaid', 'flowchart LR', '  S[Scheduler] --> Q[Queue]', ...(worker ? ['  Q --> W[Worker]'] : []), '  Q --> V[server]', '```', ''].join('\n');

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

async function main() {
  if (port !== 18304 && port !== 18305) throw new Error('port 18304 or 18305');
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
  repo.write('docs/requirements/SRS.md', SRS);
  repo.write('docs/design/flow.md', DESIGN(true));
  for (const f of ['docs/requirements/SRS.md', 'docs/design/flow.md']) fs.utimesSync(path.join(repo.folder, f), old, old);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS and design']);
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
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const font = async (c: typeof ctx) => {
      if (fs.existsSync(FONT)) await c.route('**/__sp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    };
    await font(ctx);
    const page = await ctx.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const api = async <T>(route: string): Promise<T> => (await page.request.get(`http://127.0.0.1:${port}/api/agty/spec/alpha/${route}`)).json() as Promise<T>;
    const status = await page.evaluate(
      async (ds) => (await fetch('/api/agty/spec/alpha/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docs: ds }) })).status,
      ['docs/requirements/SRS.md', 'docs/design/flow.md'],
    );
    check(status === 200, 'alpha: spec tracking on with the SRS and the design document');
    const items = (await api<{ items: Array<{ uid: string; displayId?: string }> }>('items')).items;
    const uid = Object.fromEntries(items.map((i) => [i.displayId, i.uid]));
    const arch0 = await api<TraceArch>('arch');
    const comp = Object.fromEntries(arch0.nodes.map((n) => [n.label, n.id]));
    check(uid['FR-ARC-001'] && uid['FR-ARC-002'] && uid['FR-ARC-003'] && comp.Scheduler && comp.Queue && comp.Worker && comp.server, `three requirements and four components (${Object.keys(comp).join(', ')})`);

    await openOfficeWindow(page);
    const win = page.locator(DEV_WINDOW);
    await win.getByRole('button', { name: '프로젝트', exact: true }).click();
    const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
    await picker.selectOption('alpha');
    await win.getByTestId('hud-title-office').dblclick(); // maximized: list and detail side by side
    const tab = (name: string) => win.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name, exact: true });
    const detail = win.getByTestId('spec-detail');
    const openReq = async (id: string) => {
      const row = win.locator(`[data-testid="spec-item"][data-uid="${uid[id]}"]`);
      await eventually(`row ${id}`, async () => (await row.count()) === 1);
      await row.getByRole('button').first().click();
      await eventually(`detail ${id}`, async () => (await detail.getAttribute('data-uid')) === uid[id] && (await detail.getByTestId('spec-detail-text').count()) === 1);
    };
    const chip = (to: string) => detail.locator(`[data-testid="spec-rel"][data-rel="realizes"] [data-testid="spec-link"][data-to="${to}"]`);

    // ── 1. suggested by label, confirmed ──
    await tab('요구사항').click();
    await openReq('FR-ARC-001');
    const sch = chip(comp.Scheduler);
    await eventually('Scheduler chip', async () => (await sch.count()) === 1);
    const schText = (await sch.textContent()) ?? '';
    check((await sch.getAttribute('data-status')) === 'suggested' && schText.includes('Scheduler') && schText.includes('이유: 요구사항에 이름이 나옴'), `1: FR-ARC-001 shows Scheduler suggested, with the reason (${schText})`);
    check(((await detail.locator('[data-testid="spec-rel"][data-rel="realizes"]').textContent()) ?? '').startsWith('구성요소'), '1: under the 구성요소 group of 연결');
    await shot(page, '01-suggested');
    await sch.getByTestId('spec-link-confirm').click();
    await eventually('Scheduler confirmed', async () => (await sch.getAttribute('data-status')) === 'confirmed');
    const links = JSON.parse(fs.readFileSync(path.join(cfg, 'spec/p_aaaaaaaaaa/links.json'), 'utf-8')) as { links: Array<{ to: { t: string; uid?: string }; rel: string; status: string }> };
    check(links.links.length === 1 && links.links[0].rel === 'realizes' && links.links[0].to.uid === comp.Scheduler && links.links[0].status === 'confirmed', '1: [확인] stores one confirmed realizes link (the suggestion itself was never stored)');
    await shot(page, '02-confirmed');

    // ── 2. observed from the module column ──
    await openReq('FR-ARC-002');
    const srv = chip(comp.server);
    await eventually('server chip', async () => (await srv.count()) === 1);
    const srvText = (await srv.textContent()) ?? '';
    check((await srv.getAttribute('data-status')) === 'observed' && srvText.includes('모듈 열: server/queue.ts') && srvText.includes('docs/requirements/SRS.md:8 의 모듈 칸에 경로가 적혀 있어요') && !srvText.includes('ID가 적혀'), `2: FR-ARC-002 shows server observed from its 구현 모듈 column (${srvText})`);
    await shot(page, '03-observed-module');

    // ── 3. [연결 추가] with the component picker ──
    await openReq('FR-ARC-003');
    await detail.getByTestId('spec-add').click();
    await detail.getByTestId('spec-add-type').selectOption('component');
    check((await detail.getByTestId('spec-add-type').locator('option[value="component"]').textContent()) === '구성요소', '3: the picker offers 구성요소');
    await detail.getByTestId('spec-add-search').fill('Work');
    const pick = detail.locator(`[data-testid="spec-add-pick"][data-id="${comp.Worker}"]`);
    await eventually('Worker in the picker', async () => (await pick.count()) === 1 && (await detail.getByTestId('spec-add-pick').count()) === 1);
    await shot(page, '04-picker');
    await pick.click();
    const wrk = chip(comp.Worker);
    await eventually('Worker linked', async () => (await wrk.getAttribute('data-status')) === 'confirmed');
    check(true, '3: [연결 추가] links FR-ARC-003 to Worker, confirmed');
    await shot(page, '05-added');

    // ── 4. the 아키텍처 view's counts and chips ──
    await tab('지도').click();
    const sw = win.getByTestId('spec-graph-switch');
    await eventually('the switch', async () => (await sw.count()) === 1);
    await sw.locator('[data-view="arch"]').click();
    const g = win.getByTestId('arch-graph');
    const node = (id: string) => g.locator(`[data-testid="arch-node"][data-id="${id}"]`);
    await eventually('nodes', async () => (await g.getByTestId('arch-node').count()) === 4);
    const count = async (id: string) => (await node(id).getByTestId('arch-req-count').count()) ? await node(id).getByTestId('arch-req-count').textContent() : null;
    const counts = [await count(comp.Scheduler), await count(comp.server), await count(comp.Worker), await count(comp.Queue)];
    check(counts.join('|') === '요구사항 1|요구사항 1|요구사항 1|', `4: requirement counts on the nodes: Scheduler, server, Worker 1 each, Queue none (${counts.join('|')})`);
    await shot(page, '06-arch-counts');
    await node(comp.Worker).click();
    const pop = g.getByTestId('arch-node-pop');
    await eventually('Worker pop', async () => (await pop.count()) === 1);
    const reqChips = await pop.getByTestId('arch-req').allTextContents();
    check(reqChips.join(',') === 'FR-ARC-003' && ((await pop.textContent()) ?? '').includes('이 구성요소의 요구사항 1개'), `4: Worker's detail lists its requirements (${reqChips.join(',')})`);
    await pop.getByTestId('arch-req').click();
    await eventually('FR-ARC-003 opened', async () => (await detail.getAttribute('data-uid')) === uid['FR-ARC-003']);
    // The header shows the UID until the detail has loaded.
    await eventually('FR-ARC-003 loaded', async () => (await detail.getByTestId('spec-detail-id').textContent()) === 'FR-ARC-003');
    check(true, '4: the chip opens FR-ARC-003’s detail');
    await shot(page, '07-arch-chip-opens');

    // ── 5. the requirement graph's neighbourhood ──
    await win.getByTestId('map-views').locator('[data-view="trace"]').click(); // MAP-A: the 지도's 요구사항 추적
    const graph = win.getByTestId('spec-graph');
    const tnode = (id: string) => graph.locator(`.react-flow__node[data-id="${id}"]`);
    const level = () => graph.getAttribute('data-level');
    await eventually('overview', async () => (await graph.locator('.react-flow__node-trace').count()) > 0);
    if ((await level()) === 'overview') {
      await graph.locator('.react-flow__node-trace', { hasText: 'FR-ARC' }).first().click();
      await eventually('group level', async () => (await level()) === 'group');
    }
    await eventually('FR-ARC-001 node', async () => (await tnode(uid['FR-ARC-001']).count()) === 1);
    await tnode(uid['FR-ARC-001']).click();
    await tnode(uid['FR-ARC-001']).dblclick();
    await eventually('neighbourhood', async () => (await level()) === 'neighbourhood');
    const schNode = graph.locator(`[data-testid="spec-graph-node"][data-id="${comp.Scheduler}"]`);
    await eventually('Scheduler in the neighbourhood', async () => (await schNode.count()) === 1);
    check((await schNode.getAttribute('data-type')) === 'comp' && ((await schNode.textContent()) ?? '').includes('Scheduler'), '5: the neighbourhood of FR-ARC-001 shows Scheduler (a component node)');
    await shot(page, '08-neighbourhood');

    // ── 6. Worker removed from the diagram ──
    repo.write('docs/design/flow.md', DESIGN(false));
    const gone = await eventually(
      'the edit scanned',
      async () => {
        const it = await api<TraceItem>(`item/${uid['FR-ARC-003']}`);
        return it.nodes.find((n) => n.id === comp.Worker)?.state?.freshness === 'missing' ? it : null;
      },
      60_000,
    );
    const left = JSON.parse(fs.readFileSync(path.join(cfg, 'spec/p_aaaaaaaaaa/links.json'), 'utf-8')) as { links: Array<{ to: { uid?: string } }> };
    check(gone.edges.find((e) => e.to === comp.Worker)?.status === 'confirmed' && gone.node.state?.freshness === 'missing' && left.links.some((l) => l.to.uid === comp.Worker), "6: FR-ARC-003's link stays confirmed with its end missing; links.json keeps it");
    await tab('요구사항').click();
    await openReq('FR-ARC-003');
    await eventually('missing shown', async () => ((await detail.getByTestId('spec-detail-freshness').textContent()) ?? '').includes('원본 없음') && (await chip(comp.Worker).count()) === 1);
    check(true, '6: the detail shows 원본 없음 and still lists the link');
    await shot(page, '09-missing');
    const state = await ctx.storageState();
    await ctx.close();

    // ── 7. phone ──
    const pctx = await browser.newContext({ ...PHONE, storageState: { cookies: state.cookies, origins: state.origins.map((o) => ({ ...o, localStorage: o.localStorage.filter((x) => !x.name.includes('workbench')) })) } });
    await font(pctx);
    const phone = await pctx.newPage();
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.addStyleTag({ content: FONT_CSS });
    await phone.locator('[data-dock="board"]').tap();
    const pw = phone.locator('[aria-label="현황판 화면"]');
    const dev = pw.getByRole('button', { name: '프로젝트', exact: true });
    if ((await dev.count()) && (await dev.getAttribute('aria-pressed')) !== 'true') await dev.tap();
    const ppicker = pw.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the phone picker', async () => (await ppicker.locator('option[value="alpha"]').count()) > 0);
    await ppicker.selectOption('alpha');
    const ptab = (name: string) => pw.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name, exact: true });
    await ptab('요구사항').tap();
    const prow = pw.locator(`[data-testid="spec-item"][data-uid="${uid['FR-ARC-001']}"]`);
    await eventually('phone row', async () => (await prow.count()) === 1);
    await prow.getByRole('button').first().tap();
    const pd = phone.getByTestId('spec-detail');
    await eventually('phone detail', async () => (await pd.getAttribute('data-uid')) === uid['FR-ARC-001']);
    const pdBox = await pd.boundingBox();
    const prel = pd.locator('[data-testid="spec-rel"][data-rel="realizes"]');
    await prel.scrollIntoViewIfNeeded();
    check(pdBox && pdBox.width >= 389 && (await prel.locator(`[data-to="${comp.Scheduler}"]`).getAttribute('data-status')) === 'confirmed', `7: the detail is full screen (${pdBox?.width}px) with Scheduler confirmed under 구성요소`);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '7: no horizontal page scroll at 390 px (detail)');
    await shot(phone, '10-phone-detail');
    await pd.getByTestId('spec-detail-close').tap();
    await ptab('지도').tap();
    const psw = pw.getByTestId('spec-graph-switch');
    await eventually('phone switch', async () => (await psw.count()) === 1);
    await psw.locator('[data-view="arch"]').tap();
    const pg = pw.getByTestId('arch-graph');
    await eventually('phone nodes', async () => (await pg.getByTestId('arch-node').count()) === 3);
    await wait(400); // fitView
    const listed = await pg.getByTestId('arch-item').allTextContents();
    check(listed.some((x) => x.includes('Scheduler') && x.includes('요구사항 1')) && listed.some((x) => x.includes('server') && x.includes('요구사항 1')), `7: the phone's list shows the counts (${listed.join(' | ')})`);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '7: no horizontal page scroll at 390 px (아키텍처)');
    await shot(phone, '11-phone-arch');
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

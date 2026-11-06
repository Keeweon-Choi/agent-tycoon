/**
 * SPT C2 (TC-234, FR-TRC-018) end to end on the REAL API and the real child process: dist/cli.js in a
 * temp HOME (the engine fake as `claude`, no agent runs). Project `alpha` is THIS repository's folder
 * with spec tracking on (the sidecar lives in the temp HOME; the repository is only read).
 *  1. the scan with its links: the paths on by default (확정·직접), the commits read, 꼬리표로만 commits
 *  2. ENG's chain (요구 → 작업 → 커밋 → 파일), its cells; a cell's detail (?block=)
 *  3. desktop: ENG picked lights the cells it reaches (요구 N) and dims the rest, its chain on the right,
 *     [요구→작업→근거 펼치기]; a cell picked lights the features that reach it, its recent work
 *  4. phone 390x844: the ENG row opens its chain in place (cells stacked), [구조로 →] lit cells
 *  5. the mock (R4 b-cockpit.png) and ours side by side; 6. no viewer: the daemon's RSS, git status
 * Screenshots in cld/artifacts/cockpit-map-chain/.
 *
 *   npx tsx cld/test/run-spec-c2-chain.ts [port 18310|18311]
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { type Browser, devices } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { TraceMap } from '../../core/src/cld/spec/trace.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, openOfficeWindow, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]) || 18310;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/cockpit-map-chain');
const MOCK = path.resolve(REPO_ROOT, '../specs/ui-mock-1104/cockpit/b-cockpit.png');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 400_000;
const BUDGET_KB = 100 * 1024;
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
/** The lowest RSS over 30 s after 20 s (GC returns memory when it likes). */
async function settledRss(pid: number): Promise<number> {
  await wait(20_000);
  let low = rssKb(pid);
  for (let t = 0; t < 30_000; t += 5_000) {
    await wait(5_000);
    low = Math.min(low, rssKb(pid));
  }
  return low;
}

async function main() {
  if (port !== 18310 && port !== 18311) throw new Error('port 18310 or 18311');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  };
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', { v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: REPO_ROOT, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] });
  put('assignments.json', { v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: false }] });
  const status = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: REPO_ROOT, encoding: 'utf-8' }).split('\n').filter((l) => l && !l.includes('cld/artifacts/')).join('\n');
  const before = status();
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-actions', '--no-terminal']);
  const pid = daemon.child.pid!;
  console.log(`daemon pid ${pid} on ${port}, HOME ${home}, alpha = ${REPO_ROOT}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  try {
    await daemon.loginUrl();
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const font = async (c: typeof ctx) => {
      if (fs.existsSync(FONT)) await c.route('**/__sp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    };
    await font(ctx);
    const page = await ctx.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const api = async <T>(route: string): Promise<T> => {
      const r = await page.request.get(`http://127.0.0.1:${port}/api/cld/spec/alpha/${route}`);
      if (!r.ok()) throw new Error(`${route}: ${r.status()} ${await r.text()}`);
      return (await r.json()) as T;
    };
    const post = (route: string, body: object) =>
      page.evaluate(async ([r, b]) => (await fetch(`/api/cld/spec/alpha/${r}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).status, [route, body] as const);

    // ── 1. the scan with its links ──
    const cand = await api<{ docs: Array<{ path: string; preselect: boolean }> }>('candidates');
    const picked = [...new Set([...cand.docs.filter((d) => d.preselect).map((d) => d.path), 'cld/docs/requirements/SRS.md'])];
    check((await post('enable', { docs: picked })) === 200, `1: alpha (this repository): spec tracking on with ${picked.length} documents`);
    const q0 = Date.now();
    const m = await eventually('the structure', async () => {
      const x = await api<TraceMap>('map');
      return x.structure && x.features.length ? x : null;
    });
    const s = m.structure!;
    console.log(`perf: first map read ${Date.now() - q0} ms; the child process: ${s.ms} ms, peak RSS ${s.rssKb} kB, ${s.files} files; ${m.commits} commits read${m.commitsCapped ? ' (capped)' : ''}`);
    check(m.pathsOn.join() === 'confirmed,direct', `1: paths on by default: ${m.pathsOn.join(', ')} (commit and task off: their sample under 70%)`);
    check(m.commits > 1000 && !m.commitsCapped, `1: ${m.commits} commits read by git log --no-merges (first-parent read ${'≤'}500 before)`);
    const featureReqs = m.features.reduce((n, f) => n + f.reqs, 0);
    console.log(`linked: ${m.linked}/${featureReqs}; tag-only commits ${m.tagOnly}; bars: ${m.features.map((f) => `${f.short} ${f.linked}/${f.reqs}`).join(' ')}`);
    check(m.tagOnly > 0, `1: ${m.tagOnly} commits linked by a head-comment tag only, counted apart (D3)`);

    // ── 2. ENG ──
    const eng = (await api<TraceMap>('map?feature=FR-ENG')).feature!;
    console.log(`ENG chain: ${eng.chain.reqs} reqs → ${eng.chain.tasks} tasks → ${eng.chain.commits} commits → ${eng.chain.files} files; week ${eng.week}; tasks ${eng.tasks.map((t) => `${t.id}(${t.reqs})`).join(' ')}`);
    check(eng.chain.reqs === 13 && eng.chain.tasks > 0, `2: ENG's chain: 요구 ${eng.chain.reqs} → 작업 ${eng.chain.tasks} → 커밋 ${eng.chain.commits} → 파일 ${eng.chain.files}`);
    const reached = s.blocks.filter((b) => b.features.some((f) => f.key === 'FR-ENG'));
    console.log(`ENG reaches: ${reached.map((b) => `${b.id} ${b.features.find((f) => f.key === 'FR-ENG')!.reqs}`).join(', ')}`);
    check(reached.length > 0, `2: ENG reaches ${reached.filter((b) => b.kind !== 'rail').length} modules · ${reached.filter((b) => b.kind === 'rail').length} rails (by 확정·직접)`);
    const engineBlock = (await api<TraceMap>(`map?block=${encodeURIComponent('server/src/cld/engine')}`)).block!;
    console.log(`engine cell: week ${engineBlock.week}, features ${engineBlock.features.map((f) => `${f.short} ${f.reqs}`).join(' ')}, tags ${engineBlock.tags.map((t) => t.tag).join(' ')}, tag-only ${engineBlock.tagOnly}`);
    check(engineBlock.recent.length > 0, `2: the engine cell's detail: ${engineBlock.recent.length} recent commits, ${engineBlock.tagOnly} tag-only`);

    // ── 3. desktop ──
    await openOfficeWindow(page);
    const win = page.locator(DEV_WINDOW);
    await win.getByRole('button', { name: '프로젝트', exact: true }).click();
    const pickerBox = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await pickerBox.locator('option[value="alpha"]').count()) > 0);
    await pickerBox.selectOption('alpha');
    await win.getByTestId('hud-title-office').dblclick(); // maximized
    await win.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name: '지도', exact: true }).click();
    await eventually('the cells', async () => (await win.getByTestId('map-cell').count()) >= 9);
    await win.locator('[data-testid="map-feature"][data-key="FR-ENG"]').click();
    const panel = win.getByTestId('map-feature-panel');
    await eventually('ENG chain', async () => (await panel.getByTestId('map-chain').count()) === 1);
    const lit = await win.locator('[data-testid="map-cell"][data-lit]').count();
    const dim = await win.locator('[data-testid="map-cell"][data-dim]').count();
    const reach = win.getByTestId('map-reach');
    const said = Number(await reach.getAttribute('data-cells')) + Number(await reach.getAttribute('data-rails'));
    check(lit === reached.length && lit === said && dim === s.blocks.length - lit, `3: ENG picked: ${lit} cells lit with 요구 N, ${dim} dimmed; the head says "${(await reach.innerText()).trim()}"`);
    check((await panel.getByTestId('map-chain').getAttribute('data-files')) === String(eng.chain.files), '3: the chain on the right: 요구 → 작업 → 커밋 → 파일');
    await shot(page, '01-desktop-eng');
    await panel.getByTestId('map-chain-open').click();
    await eventually('the table', async () => (await panel.getByTestId('map-chain-table').count()) === 1);
    check((await panel.getByTestId('map-chain-table').locator('tbody tr').count()) === 13, '3: [요구→작업→근거 펼치기]: 13 rows, the paths off dimmed');
    await panel.getByTestId('map-chain-table').scrollIntoViewIfNeeded();
    await shot(page, '02-desktop-eng-open');
    const cell = win.locator('[data-testid="map-cell"][data-id="server/src/cld/engine"]');
    await cell.click();
    await eventually('the cell detail', async () => (await win.getByTestId('map-block-recent').locator('li').count()) > 0);
    const rowsLit = await win.locator('[data-testid="map-feature"][data-lit]').count();
    check(rowsLit === engineBlock.features.filter((f) => m.features.some((x) => x.key === f.key)).length && rowsLit > 0, `3: the engine cell picked: ${rowsLit} feature rows lit, its recent work and ${engineBlock.tagOnly} tag-only commits on the right`);
    await shot(page, '03-desktop-cell');

    // ── 4. phone ──
    const state = await ctx.storageState();
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
    await pw.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name: '지도', exact: true }).tap();
    await eventually('phone features', async () => (await phone.getByTestId('map-feature').count()) > 0);
    await phone.locator('[data-testid="map-feature"][data-key="FR-ENG"]').tap();
    const cellsIn = phone.getByTestId('map-feature-cells');
    await eventually('the chain in place', async () => (await cellsIn.count()) === 1);
    check((await cellsIn.locator('li').count()) === reached.length, `4: the ENG row opened in place: chain numbers, ${reached.length} cells stacked by band`);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '4: no horizontal scroll at 390 px');
    await phone.getByTestId('map-chain').scrollIntoViewIfNeeded();
    await shot(phone, '04-phone-eng-open');
    await phone.getByTestId('map-to-structure').tap();
    await eventually('phone structure', async () => (await phone.locator('[data-testid="map-cell"][data-lit]').count()) === reached.length);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '4: [구조로 →]: the lit cells, no horizontal scroll');
    await shot(phone, '05-phone-structure-lit');
    await pctx.close();

    // ── 5. the mock and ours ──
    if (fs.existsSync(MOCK)) {
      const cmp = await ctx.newPage();
      await cmp.setViewportSize({ width: 2600, height: 900 });
      const img = (f: string) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
      await cmp.setContent(
        `<body style="margin:0;font:14px sans-serif;display:flex;gap:16px;padding:8px"><figure style="margin:0"><figcaption>R4 mock b-cockpit.png</figcaption><img src="${img(MOCK)}" width="1282"></figure><figure style="margin:0"><figcaption>C2 (this run)</figcaption><img src="${img(path.join(OUT, '01-desktop-eng.png'))}" width="1282"></figure></body>`,
      );
      await cmp.screenshot({ path: path.join(OUT, '06-compare-mock.png'), fullPage: true });
      await cmp.close();
    }

    // ── 6. no viewer ──
    await browser.close();
    browser = undefined;
    const rss = await settledRss(pid);
    console.log(`perf: daemon RSS with no viewer after the map: ${Math.round(rss / 1024)} MB (budget ${BUDGET_KB / 1024} MB; printed, as in C1: the idle daemon here holds Phases 1-4's tracking of every document)`);
    check(status() === before, '6: this repository read only: git status as before the run');
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
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * SPT Phase 3 done, end to end on the REAL API (no page.route fixtures but the font): dist/cli.js in
 * a temp HOME (the engine fake as `claude`, no real agent), one project `alpha` whose folder is a temp
 * git repository holding a copy of THIS repository's agent-tycoon/docs/requirements/SRS.md. One real ID,
 * FR-TRC-008, gets: a Task (its title names it, confirmed in the UI), a commit whose message names it,
 * a job with exit 0 that names it in its description, and an acceptance record (in the UI).
 * Desktop 1600x1000, then phone 390x844, the same path on both:
 *  1. the 현황판 opens on 개요 (no tab remembered)
 *  2. 개요 shows the counts, drawn in the mono face (.spec-count)
 *  3. FR-TRC-008 searched in 요구사항
 *  4. its detail shows 작업, 근거, 수용 and 최신 as four separate states, 수용 apart from 근거
 *  5. its graph neighbourhood (via 최근 본 요구사항 on the 개요) shows the Task, the commit and the job
 * Screenshots in agent-tycoon/artifacts/spec-p3-done/.
 *
 *   npx tsx agent-tycoon/test/run-spec-p3-done.ts [port 18296|18297]
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, openOfficeWindow, REPO_ROOT, startDaemon } from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]) || 18296;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/spec-p3-done');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 360_000;
const ID = 'FR-TRC-008';
const JOB = '1103-080000-unit';
const AT = '2026-11-03T08:00:00.000Z';
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

async function main() {
  if (port !== 18296 && port !== 18297) throw new Error('port 18296 or 18297');
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
  repo.write('docs/requirements/SRS.md', fs.readFileSync(path.join(REPO_ROOT, 'agent-tycoon/docs/requirements/SRS.md'), 'utf-8'));
  const old = new Date(Date.now() - 60_000); // settled: the scan reads it now
  fs.utimesSync(path.join(repo.folder, 'docs/requirements/SRS.md'), old, old);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS']);
  repo.git(['commit', '-q', '--allow-empty', '-m', `${ID}: show the four states apart`]);
  const sha = repo.git(['log', '--format=%H %s']).split('\n').find((l) => l.includes(`${ID}: show`))!.slice(0, 40);
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', { v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] });
  put('assignments.json', { v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] });
  put('tasks.json', { v: 2, tasks: [{ id: 'T-5', project: 'alpha', title: `${ID} 네 가지 상태 따로 보이기`, status: 'doing', source: 'reported', createdAt: AT, updatedAt: AT, history: [] }] });
  const jobs = path.join(home, '.local/state/agent-tycoon/jobs');
  fs.mkdirSync(jobs, { recursive: true });
  fs.writeFileSync(path.join(jobs, `${JOB}.log`), '');
  fs.writeFileSync(
    path.join(jobs, `${JOB}.json`),
    JSON.stringify({ id: JOB, pid: null, pstart: null, boot: 'x', project: 'alpha', cmd: 'npm test', desc: `unit ${ID}`, dir: repo.folder, tab: null, tty: false, log: path.join(jobs, `${JOB}.log`), started: AT, ended: AT, exit: 0, source: 'cli' }),
  );
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
    const api = async <T>(route: string): Promise<T> => {
      const r = await page.request.get(`http://127.0.0.1:${port}/api/agty/spec/alpha/${route}`);
      if (!r.ok()) throw new Error(`${route}: ${r.status()} ${await r.text()}`);
      return (await r.json()) as T;
    };
    const enabled = await page.evaluate(async () => (await fetch('/api/agty/spec/alpha/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docs: ['docs/requirements/SRS.md'] }) })).status);
    check(enabled === 200, `spec tracking on (${enabled})`);
    const items = (await api<{ items: Array<{ uid: string; displayId?: string }> }>('items')).items;
    const u = items.find((i) => i.displayId === ID)?.uid;
    check(u && items.length > 100, `the real SRS is tracked, ${ID} among its requirements`);

    /** The same five steps on a desktop window and on the phone; the first pass also makes the Task link, the acceptance. */
    const walk = async (p: Page, root: ReturnType<Page['locator']>, tag: string, touch: boolean, prior?: boolean): Promise<boolean> => {
      const press = (l: ReturnType<Page['locator']>) => (touch ? l.tap() : l.click());
      const tab = (name: string) => root.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name, exact: true });
      const shotN = (n: string) => p.screenshot({ path: path.join(OUT, `${tag}-${n}.png`) });

      // 1. opens on 개요
      await eventually(`${tag}: 개요`, async () => (await root.getByTestId('spec-cockpit').count()) === 1);
      check((await tab('개요').getAttribute('aria-pressed')) === 'true', `${tag} 1: the 현황판 opens on 개요`);

      // 2. the counts, in the mono face
      const sum = total;
      const reqs = root.getByTestId('ov-top-reqs');
      await eventually(`${tag}: counts`, async () => (await reqs.getAttribute('data-count')) === String(sum.items?.total));
      check(Number(await reqs.getAttribute('data-count')) > 100, `${tag} 2: 개요 counts the ${await reqs.getAttribute('data-count')} requirements`);
      const faces = await root.locator('.game-hud-v').first().evaluate((el) => [getComputedStyle(el).fontFamily, getComputedStyle(el.parentElement!).fontFamily]);
      check(/Galmuri11 ASCII|mono|Consolas|Menlo/i.test(faces[0]) && faces[0] !== faces[1], `${tag} 2: counts use the data face, the label the pixel font (${faces[0].slice(0, 40)} vs ${faces[1].slice(0, 30)})`);
      await shotN('1-overview');

      // 3. search the ID in 요구사항
      await press(tab('요구사항'));
      const search = root.getByTestId('spec-reqs-search');
      await search.fill(ID);
      const row = root.locator(`[data-testid="spec-item"][data-id="${ID}"]`);
      await eventually(`${tag}: row`, async () => (await row.count()) === 1);
      check(true, `${tag} 3: ${ID} found by its ID`);
      if (!prior) {
        // the Task link is confirmed, the acceptance recorded, in the UI (desktop pass)
        await press(row.getByRole('button'));
        const d = p.getByTestId('spec-detail');
        await eventually('detail', async () => (await d.getByTestId('spec-link').count()) >= 3);
        const link = (to: string) => d.locator(`[data-testid="spec-link"][data-to="${to}"]`);
        check((await link('T-5').getAttribute('data-status')) === 'observed' && (await link(sha).getAttribute('data-status')) === 'observed' && (await link(JOB).getAttribute('data-status')) === 'observed', 'setup: the Task (title), the commit (message) and the job (description) name it: observed, then confirmed');
        // Only a confirmed link counts as work or evidence (an observed one is a lead, SPT §4).
        for (const to of ['T-5', sha, JOB]) {
          await link(to).getByTestId('spec-link-confirm').click();
          await eventually(`${to} confirmed`, async () => (await link(to).getAttribute('data-status')) === 'confirmed');
        }
        await d.getByTestId('spec-accept-memo').fill('네 가지 상태가 따로 보인다');
        await d.locator('[data-testid="spec-accept-set"][data-state="accepted"]').click();
        await eventually('accepted', async () => (await d.getByTestId('spec-detail-acceptance').textContent())?.endsWith('수락'));
        await d.getByTestId('spec-detail-close').click();
        await eventually('row again', async () => (await row.count()) === 1);
      }
      await shotN('2-search');

      // 4. all four states, 수용 apart from 근거
      await press(row.getByRole('button'));
      const d = p.getByTestId('spec-detail');
      await eventually(`${tag}: detail`, async () => (await d.getByTestId('spec-detail-work').count()) === 1 && (await d.getByTestId('spec-detail-freshness').count()) === 1);
      const text = async (id: string) => ((await d.getByTestId(id).textContent()) ?? '').trim();
      const work = await text('spec-detail-work');
      const evidence = await text('spec-detail-evidence');
      const acceptance = await text('spec-detail-acceptance');
      const fresh = await text('spec-detail-freshness');
      check(/작업\s*1/.test(work) && work.includes('T-5'), `${tag} 4: 작업 counts the confirmed Task (${work})`);
      const axes = await d.locator('[data-axis]').evaluateAll((els) => els.map((e) => e.getAttribute('data-led')));
        check(axes.length === 5 && axes[0] === 'on' && axes[2] === 'on', `${tag} 4: 근거 lights 변경 (the commit) and 시험 (the job with exit 0) (${axes.join(' | ')})`);
      check(acceptance.endsWith('수락') && !evidence.includes('수락'), `${tag} 4: 수용 says 수락 and 근거 does not (${acceptance})`);
      check(fresh.endsWith('최신'), `${tag} 4: 최신 (${fresh})`);
      const parents = await d.locator('[data-testid="spec-detail-work"], [data-testid="spec-detail-evidence"], [data-testid="spec-detail-acceptance"], [data-testid="spec-detail-freshness"]').evaluateAll((els) => new Set(els.map((e) => e.getAttribute('data-testid'))).size);
      check(parents === 4, `${tag} 4: four separate rows`);
      const sourceText = d.getByTestId('spec-detail-text');
      check((await sourceText.getByTestId('spec-detail-row').count()) === 1 && (await sourceText.getByTestId('md-table').count()) === 0, `${tag} 4: 원문 of the table row reads as 'column: value' lines, not a table`);
      await shotN('3-detail');
      await d.getByTestId('spec-detail-close').click();

      // 5. the neighbourhood in the graph, via 최근 본 요구사항
      await press(tab('개요'));
      const viewed = root.locator(`[data-testid="ov-viewed"][data-uid="${u}"]`);
      await eventually(`${tag}: viewed`, async () => (await viewed.count()) === 1);
      await press(viewed);
      const list = root.getByTestId('spec-graph-list');
      await eventually(`${tag}: neighbourhood`, async () => (await root.getByTestId('spec-graph').getAttribute('data-level')) === 'neighbourhood' && (await list.locator('li[data-id]').count()) >= 3);
      const ids = await list.locator('li[data-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
      check(ids.includes('T-5') && ids.includes(sha) && ids.includes(JOB), `${tag} 5: the graph neighbourhood shows the Task, the commit and the job (${ids.map((i) => i?.slice(0, 12)).join(' ')})`);
      if (!touch) {
        const g = root.getByTestId('spec-graph');
        await eventually('edges drawn', async () => (await g.locator('.tg-e--confirmed').count()) >= 1 && (await g.locator('.react-flow__node').count()) >= 4);
      }
      await shotN('4-graph');
      return true;
    };

    const total = await api<{ items?: { total: number } }>('summary');
    // ── desktop ──
    await openOfficeWindow(page);
    const win = page.locator(DEV_WINDOW);
    await win.getByRole('button', { name: '프로젝트', exact: true }).click();
    const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
    await picker.selectOption('alpha');
    await win.getByTestId('hud-title-office').dblclick();
    const flow = await walk(page, win, 'desktop', false);
    const state = await ctx.storageState();
    await ctx.close();

    // ── phone: a new browser, no remembered tab ──
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
    await walk(phone, pw, 'phone', true, flow);
    check(
      await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      'phone: no horizontal scroll',
    );
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

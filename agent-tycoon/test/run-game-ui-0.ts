/**
 * GAME-UI-0 end to end on the REAL API: dist/cli.js in a temp HOME (the engine fake as `claude`, no real
 * agent), project `alpha` on a temp git repository holding this repository's SRS (the mock's 272
 * requirements). T-5 (doing, testsPassed reported) is confirmed to FR-TRC-008 and so is the commit naming
 * it; FR-ENG-001 has a unit job (exit 0) and a deploy job (exit 0, no 배포 확인) and is accepted.
 *  1. the 개요 as D2: HI-SCORE 0001 / 0272 once, 근거 counts per axis, T-5's lights on on half off with
 *     its reason line, the deploy job's LED half with its reason; a number still opens its filtered tab
 *  2. 요구사항: FR-TRC-008's row and detail as LEDs, each detail LED titled with its reason, the legend
 *  3. 게임 효과: the settings switch turns data-game-motion off and a stamp's animation with it; on again,
 *     the device's reduced motion turns it off too
 *  4. phone 390x844: the 개요 stacks, no horizontal scroll
 *  5. one picture beside the mock (variant-d2-desktop.png)
 * Screenshots in agent-tycoon/artifacts/game-ui-0/.
 *
 *   npx tsx agent-tycoon/test/run-game-ui-0.ts [port 18306|18307]
 */
import type { Browser, BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]) || 18306;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/game-ui-0');
const MOCK = path.join(REPO_ROOT, '../specs/ui-mock-1103/cockpit-variants/variant-d2-desktop.png');
const DEADLINE_MS = 360_000;
const ID = 'FR-TRC-008';
const UNIT = '1103-170000-unit';
const DEPLOY = '1103-160000-deploy';
const AT = new Date(Date.now() - 2 * 3600_000).toISOString();
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
async function eventually<T>(what: string, test: () => Promise<T | null | undefined | false>, timeout = 30_000): Promise<T> {
  for (const end = Date.now() + timeout; ; await wait(250)) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}
const leds = (l: Locator) => l.locator('[data-led]').evaluateAll((els) => els.map((e) => e.getAttribute('data-led')).join(' '));

async function main() {
  if (port !== 18306 && port !== 18307) throw new Error('port 18306 or 18307');
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
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(repo.folder, 'docs/requirements/SRS.md'), old, old);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS']);
  repo.git(['commit', '-q', '--allow-empty', '-m', `${ID}: show the four states apart`]);
  const sha = repo.git(['log', '--format=%H %s']).split('\n').find((l) => l.includes(`${ID}: show`))!.slice(0, 40);
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', { v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] });
  put('assignments.json', { v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] });
  put('tasks.json', {
    v: 2,
    tasks: [
      {
        id: 'T-5',
        project: 'alpha',
        title: '네 가지 상태 따로 보이기',
        status: 'doing',
        source: 'reported',
        createdAt: AT,
        updatedAt: AT,
        history: [],
        assignee: { assignmentId: 'a_aaaaaaaaaa', name: 'Ann' },
        testsPassed: { value: true, source: 'reported', at: AT },
      },
    ],
  });
  const jobs = path.join(home, '.local/state/agent-tycoon/jobs');
  fs.mkdirSync(jobs, { recursive: true });
  const job = (id: string, desc: string, cmd: string, ended: string) => {
    fs.writeFileSync(path.join(jobs, `${id}.log`), '');
    fs.writeFileSync(path.join(jobs, `${id}.json`), JSON.stringify({ id, pid: null, pstart: null, boot: 'x', project: 'alpha', cmd, desc, dir: repo.folder, tab: null, tty: false, log: path.join(jobs, `${id}.log`), started: ended, ended, exit: 0, source: 'cli' }));
  };
  job(UNIT, 'unit FR-ENG-001', 'npm test', AT);
  job(DEPLOY, 'deploy check', './deploy.sh', new Date(Date.now() - 3 * 3600_000).toISOString());
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal']);
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}, repo ${repo.folder}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  try {
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const call = (route: string, body?: object) =>
      page.evaluate(
        async ([r, b]) => {
          const res = await fetch(`/api/agty/spec/alpha/${r}`, b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : {});
          return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
        },
        [route, body] as const,
      );
    check((await call('enable', { docs: ['docs/requirements/SRS.md'] })).status === 200, 'spec tracking on');
    const uid = async (id: string) => ((await call(`items?q=${id}`)).json.items as Array<{ uid: string; displayId?: string }>).find((i) => i.displayId === id)!.uid;
    const [trc, eng] = [await uid(ID), await uid('FR-ENG-001')];
    for (const body of [
      { from: trc, to: 'T-5', rel: 'implements' },
      { from: trc, to: sha, rel: 'changes' },
      { from: eng, to: UNIT, rel: 'verifies', kind: 'unit' },
      { from: eng, to: DEPLOY, rel: 'verifies', kind: 'deploy' },
    ]) {
      const r = await call('links', body);
      check(r.status === 200, `link ${body.rel} ${body.to.slice(0, 12)} (${r.status})`);
    }
    const version = (await call(`item/${eng}`)).json.version as string;
    const acc = await call('acceptance', { uid: eng, state: 'accepted', version });
    check(acc.status === 200, `FR-ENG-001 accepted (${acc.status} ${JSON.stringify(acc.json).slice(0, 80)})`);
    const sum = (await call('summary')).json as { items: { total: number }; evidence: Record<string, number>; evidenceReported: Record<string, number> };

    // ── 1. the 개요 ──
    const win = page.locator(DEV_WINDOW);
    const icon = page.locator('[data-hud-id="icon:office"] button');
    await icon.waitFor();
    if (!(await win.isVisible())) await icon.click();
    await win.getByRole('button', { name: '프로젝트', exact: true }).click();
    const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
    await picker.selectOption('alpha');
    await win.getByTestId('hud-title-office').dblclick();
    const tab = (name: string) => win.getByRole('button', { name, exact: true });
    await tab('개요').click();
    const ov = win.getByTestId('spec-cockpit');
    const quest = ov.locator('[data-testid="ov-task"][data-id="T-5"]');
    const deployJob = ov.locator(`[data-testid="ov-job"][data-id="${DEPLOY}"]`);
    await eventually('the D2 개요', async () => (await ov.getAttribute('data-enabled')) === 'true' && (await quest.getByTestId('ov-chip').count()) === 1 && (await deployJob.count()) === 1);
    const hi = ov.getByTestId('ov-acc-accepted');
    check((await hi.innerText()).replace(/\s+/g, ' ').includes(`0001 / ${String(sum.items.total).padStart(4, '0')}`) && (await ov.getByText('HI-SCORE').count()) === 1, `1: HI-SCORE ${(await hi.innerText()).replace(/\s+/g, ' ')} once (${sum.items.total} requirements)`);
    const ev = Object.fromEntries(await Promise.all(['ev-integration', 'evr-integration', 'ev-test', 'evr-test', 'ev-deploy', 'evr-deploy'].map(async (id) => [id, Number(await ov.getByTestId(`ov-${id}`).getAttribute('data-count'))])));
    check(
      JSON.stringify(ev) === JSON.stringify({ 'ev-integration': sum.evidence.integration, 'evr-integration': sum.evidenceReported.integration, 'ev-test': sum.evidence.test, 'evr-test': sum.evidenceReported.test, 'ev-deploy': sum.evidence.deploy, 'evr-deploy': sum.evidenceReported.deploy }) && ev['evr-test'] === 1 && ev['evr-deploy'] === 1,
      `1: 근거 counts per axis, confirmed and reported-only (${JSON.stringify(ev)})`,
    );
    check((await leds(ov.getByTestId('ov-ev-test'))) === 'on' && (await leds(ov.getByTestId('ov-evr-test'))) === 'half', '1: each count beside its LED');
    check((await quest.getByTestId('ov-chip').textContent())?.includes(ID), `1: T-5 carries its requirement chip ${ID}`);
    check((await leds(quest.locator('.ov-evbar'))) === 'on on half off', `1: T-5's lights: 코드 변경 on, 통합 확인 on, 시험 half, 배포 off (${await leds(quest.locator('.ov-evbar'))})`);
    const why = await quest.getByTestId('ov-why').innerText();
    check(why.includes('시험 보고만') && why.includes('T-5') && why.includes('시험 통과를 보고함'), `1: the half light's reason is T-5's own report (${why})`);
    check((await leds(deployJob)) === 'half' && (await deployJob.innerText()).includes('배포 확인 없음'), `1: the deploy job's exit 0 is half, with why (${(await deployJob.innerText()).replace(/\s+/g, ' ')})`);
    check((await leds(ov.locator(`[data-testid="ov-job"][data-id="${UNIT}"]`))) === 'on', '1: the unit job with exit 0 is on');
    const zero = await ov.getByTestId('ov-top-blocked').locator('.game-hud-v').evaluate((el) => [el.hasAttribute('data-zero'), getComputedStyle(el).color, getComputedStyle(el).fontFamily]);
    check(zero[0] && /0\.5\)$/.test(zero[1] as string) && /Galmuri11 ASCII/.test(zero[2] as string), `1: a 0 counter is dimmed, in the data face (${zero.join(' | ')})`);
    const gold = await ov.locator('.ov-title').evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--score-gold)';
      document.body.append(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(el).color, want];
    });
    check(gold[0] === gold[1], `1: the project's name in --score-gold (${gold[0]})`);
    await wait(400);
    await shot(page, '01-overview-desktop');

    await ov.getByTestId('ov-evr-test').click();
    const reqs = win.getByTestId('spec-reqs');
    await eventually('the 시험 보고만 list', async () => (await reqs.getByTestId('spec-reqs-show').getAttribute('data-show').catch(() => null)) === 'evr:test' && (await reqs.getByTestId('spec-item').count()) === 1);
    check((await reqs.getByTestId('spec-reqs-show').innerText()).includes('시험 보고만'), "1: a 근거 number opens 요구사항 on that filter, its chip in words ('시험 보고만')");

    // ── 2. 요구사항 list and detail ──
    await reqs.getByTestId('spec-reqs-show').click();
    await reqs.getByTestId('spec-reqs-search').fill(ID);
    const row = reqs.locator(`[data-testid="spec-item"][data-id="${ID}"]`);
    await eventually('the row', async () => (await row.count()) === 1 && (await reqs.getByTestId('spec-item').count()) === 1);
    check((await leds(row.locator('[data-col="evidence"]'))) === 'on on half off', `2: the list's 근거 cell is four LEDs (${await leds(row.locator('[data-col="evidence"]'))})`);
    await row.getByRole('button').first().click();
    const detail = win.getByTestId('spec-detail');
    await eventually('the detail', async () => (await detail.getByTestId('spec-detail-id').textContent()) === ID);
    const axes = await detail.getByTestId('spec-detail-evidence').locator('[data-axis]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-axis'), e.getAttribute('data-led'), e.querySelector('[data-led]')?.getAttribute('title')]));
    check(axes.map((a) => a[1]).join(' ') === 'on on half off off', `2: the detail's 근거 row as LEDs (${axes.map((a) => `${a[0]}=${a[1]}`).join(' ')})`);
    const testTitle = axes.find((a) => a[0] === 'test')![2] ?? '';
    check(testTitle.startsWith('보고만') && testTitle.includes('시험 통과를 보고함'), `2: pointing at a LED shows why (${testTitle})`);
    check((await detail.getByTestId('game-legend').innerText()).includes('보고만 · 아직 직접 못 봄'), '2: the legend in words');
    await detail.getByTestId('spec-detail-evidence').locator('[data-axis="test"] [data-led]').hover();
    await wait(300);
    await shot(page, '02-reqs-list-detail-leds');
    const evidenceBox = await detail.getByTestId('spec-detail-evidence').boundingBox();
    if (evidenceBox) await page.screenshot({ path: path.join(OUT, '03-detail-evidence-zoom.png'), clip: { x: evidenceBox.x - 8, y: evidenceBox.y - 8, width: Math.min(evidenceBox.width + 16, 900), height: evidenceBox.height + 16 } });

    // ── 3. 게임 효과 ──
    await detail.getByTestId('spec-detail-close').click();
    await tab('개요').click();
    await ov.getByTestId('ov-top').waitFor();
    const motion = () => page.evaluate(() => document.documentElement.dataset.gameMotion);
    const stampAnimation = () =>
      page.evaluate(() => {
        const s = document.createElement('span');
        s.className = 'game-stamp';
        document.body.append(s);
        const name = getComputedStyle(s).animationName;
        s.remove();
        return name;
      });
    check((await motion()) === 'on' && (await stampAnimation()).includes('game-stamp-drop'), `3: on by default, a stamp drops (${await stampAnimation()})`);
    const settings = async (fn: (row: Locator) => Promise<void>) => {
      await page.locator('button[aria-label="설정"]').first().click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ timeout: 10_000 });
      await dialog.locator('#settings-tab-display').click();
      await fn(dialog.getByTestId('game-motion-option'));
      await dialog.locator('[data-modal-title] button').click();
      await dialog.waitFor({ state: 'detached', timeout: 10_000 });
    };
    await settings(async (r) => {
      await r.scrollIntoViewIfNeeded();
      await shotEl(r, '04-setting-on');
      await r.getByRole('button', { pressed: false }).click(); // 끔 | 켬: 끔
      check((await r.locator('[aria-pressed="true"]').textContent()) === '끔', '3: the 게임 효과 switch turns off');
      await shotEl(r, '05-setting-off');
    });
    check((await motion()) === 'off' && (await stampAnimation()) === 'none', `3: effects off: data-game-motion off, no stamp animation (${await stampAnimation()})`);
    await wait(300);
    await shot(page, '06-overview-effects-off');
    await settings(async (r) => r.getByRole('button', { pressed: false }).click());
    check((await motion()) === 'on', '3: on again');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await eventually('reduced motion', async () => (await motion()) === 'off');
    check((await stampAnimation()) === 'none', '3: the device reduces motion: off too, with the setting on');
    await page.emulateMedia({ reducedMotion: null });
    await eventually('motion back', async () => (await motion()) === 'on');
    const state = await ctx.storageState();
    await ctx.close();

    // ── 4. phone ──
    const pctx = await browser.newContext({ ...PHONE, storageState: state });
    const phone = await pctx.newPage();
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.locator('[data-dock="board"]').tap();
    const pw = phone.locator('[aria-label="현황판 화면"]');
    const dev = pw.getByRole('button', { name: '프로젝트', exact: true });
    if ((await dev.count()) && (await dev.getAttribute('aria-pressed')) !== 'true') await dev.tap();
    await pw.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name: '개요', exact: true }).tap();
    const pov = pw.getByTestId('spec-cockpit');
    await eventually('phone 개요', async () => (await pov.locator('[data-testid="ov-task"] [data-testid="ov-chip"]').count()) === 1);
    await wait(400);
    const top = await Promise.all(['ov-top', 'ov-col-issues', 'ov-col-reqs', 'ov-col-check'].map((id) => pov.getByTestId(id).boundingBox()));
    check(top.every((b) => b && b.width >= 330) && top[0]!.y < top[1]!.y && top[1]!.y < top[2]!.y && top[2]!.y < top[3]!.y, `4: the header and the panels stack on a phone (${top.map((b) => `${Math.round(b!.width)}@${Math.round(b!.y)}`).join(' ')})`);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '4: no horizontal page scroll at 390 px');
    const over = await pov.evaluate((el) => [...el.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).map((e) => e.className || e.tagName).slice(0, 5));
    check(over.length === 0, `4: nothing sticks out of the 개요 (${over.join(', ') || 'none'})`);
    await shot(phone, '07-overview-phone-top');
    await pov.getByTestId('ov-col-reqs').scrollIntoViewIfNeeded();
    await shot(phone, '08-overview-phone-reqs');
    await pov.getByTestId('ov-working').scrollIntoViewIfNeeded();
    await shot(phone, '09-overview-phone-working');
    await pov.getByTestId('ov-recent').scrollIntoViewIfNeeded();
    await shot(phone, '10-overview-phone-recent');
    await pctx.close();

    // ── 5. beside the mock ──
    const side = await browser.newPage({ viewport: { width: 1420, height: 520 } });
    const img = (f: string) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
    await side.setContent(
      `<body style="margin:0;font:14px sans-serif;display:flex;gap:20px;padding:0">` +
        `<figure style="margin:0;width:700px"><figcaption>mock D2 (variant-d2-desktop.png)</figcaption><img src="${img(MOCK)}" style="width:700px"></figure>` +
        `<figure style="margin:0;width:700px"><figcaption>GAME-UI-0 (01-overview-desktop.png)</figcaption><img src="${img(path.join(OUT, '01-overview-desktop.png'))}" style="width:700px"></figure></body>`,
    );
    await side.screenshot({ path: path.join(OUT, '11-beside-mock.png'), fullPage: true });
    await side.close();
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
const shotEl = (l: Locator, name: string) => l.screenshot({ path: path.join(OUT, `${name}.png`) });

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

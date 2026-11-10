/**
 * SPT-P1A visual check: dist/cli.js in a temp HOME (the engine fake as `claude`, no real agent),
 * one project `alpha` whose folder is a temp git repository with committed SRS-like, design and
 * decision documents, one modified document, one untracked and one git-ignored one.
 *  1. The 현황판's 개발 tab opens on 개요 (the default since SPT-P3-FINISH); 개요 with tracking off: the
 *     명세 추적 card counts the documents, no 허락/답하기 button anywhere on it.
 *  2. The 켜기 window: candidates grouped by kind with git-state tags; the ignored and the log
 *     document start unticked.
 *  3. Enable: the result summary.
 *  4. The 문서 tab: every document with a UID and its git state.
 *  5. A daemon restart: the same UIDs (read through the API); no repository byte changed
 *     (every file, .git/config and .git/index included, hashed before and after).
 *  6. The untracked document committed: its UID unchanged, its state committed.
 *  7. Phone 390x844: one tab row with 더보기, the 개요 and 문서 tabs.
 * Screenshots in agent-tycoon/artifacts/spec-p1a/.
 *
 *   npx tsx agent-tycoon/test/run-spec-p1a.ts [port 18278|18279]
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

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
import { SPEC_SCAN_MIN_MS } from '../../server/src/constants.js';

const port = Number(process.argv[2]) || 18278;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/spec-p1a');
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
async function eventually<T>(what: string, test: () => Promise<T | null | undefined | false>, timeout = 30_000): Promise<T> {
  for (const end = Date.now() + timeout; ; await wait(250)) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

/** sha256 of every file under `root`, `.git` included. */
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(root, { recursive: true }).map(String).sort()) {
    const abs = path.join(root, rel);
    if (fs.lstatSync(abs).isFile()) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  }
  return out;
}

type Doc = { uid: string; path: string; git: string };

async function main() {
  if (port !== 18278 && port !== 18279) throw new Error('port 18278 or 18279');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  };
  // The project folder: a temp repository with git's config pinned (no global or system config).
  const repo = makeTempRepo({ push: false });
  repo.write('.gitignore', 'private-plan.md\n');
  repo.write('docs/requirements/SRS.md', '# SRS\n\n| ID | 요구 | 상태 |\n|---|---|---|\n| FR-OFC-001 | 탭마다 방 | 완료 |\n| NFR-PERF-008 | 꺼지면 비용 0 | 진행 |\n');
  repo.write('docs/design/cockpit.md', '# Cockpit 설계\n');
  repo.write('docs/adr/0001-sidecar.md', '# ADR 0001\n');
  repo.write('HANDOFF.md', '# 인수인계\n');
  repo.write('README.md', '# alpha\n');
  repo.write('private-plan.md', '# 비공개 계획\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS, design, ADR']);
  repo.write('docs/design/cockpit.md', '# Cockpit 설계 v2\n'); // modified, not committed
  repo.write('docs/plan/TODO.md', '- [ ] 개요 탭\n'); // untracked
  // Older than the 5 s "being written" window, so the first scan reads them all.
  const old = new Date(Date.now() - 60_000);
  for (const rel of ['docs/design/cockpit.md', 'docs/plan/TODO.md']) fs.utimesSync(path.join(repo.folder, rel), old, old);
  const before = hashTree(repo.folder);

  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', {
    v: 2,
    projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }],
  });
  put('assignments.json', {
    v: 1,
    assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }],
  });
  const start = () =>
    startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal']);
  let daemon: Daemon = start();
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}, repo ${repo.folder}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  try {
    browser = await launchBrowser();
    const open = async (opts: BrowserContextOptions) => {
      const ctx = await browser!.newContext(opts);
      if (fs.existsSync(FONT)) await ctx.route('**/__sp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      return { ctx, page: await ctx.newPage() };
    };
    const hangul = (p: Page) => p.addStyleTag({ content: FONT_CSS });
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const api = async (p: Page, route: string) => {
      const r = await p.request.get(`http://127.0.0.1:${port}/api/agty/spec/alpha/${route}`);
      if (!r.ok()) throw new Error(`${route}: ${r.status()} ${await r.text()}`);
      return r.json();
    };

    // ── 1. 개요 with tracking off ──
    const { ctx: desk, page } = await open({ viewport: { width: 1400, height: 900 } });
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await hangul(page);
    await openOfficeWindow(page);
    const win = page.locator(DEV_WINDOW);
    await win.getByRole('button', { name: '프로젝트', exact: true }).click();
    const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
    await picker.selectOption('alpha');
    const tab = (name: string) => win.getByRole('button', { name, exact: true });
    check((await tab('개요').getAttribute('aria-pressed')) === 'true', '1: the 개발 tab opens on 개요 (SPT-P3-FINISH: the default since owner Q1)');
    const names = await win.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button').allTextContents();
    check(names.join(' ') === '개요 이슈 요구사항 그래프 문서 에이전트 변경', `1: tabs in order (${names.join(' ')})`);
    await tab('개요').click();
    const card = win.getByTestId('spec-card');
    await card.waitFor({ timeout: 15_000 });
    check((await card.getAttribute('data-enabled')) === 'false', '1: tracking is off');
    const found = await win.getByTestId('spec-card-found').textContent();
    check(found?.includes('4개'), `1: the card counts the spec documents by name (${found})`); // SRS, design, ADR, TODO
    // SPT-P3-OVERVIEW: the commits are 최근 근거's rows now.
    await eventually('the recent commits', async () => (await win.getByTestId('ov-commit').allTextContents()).some((x) => x.includes('docs: SRS')));
    const cockpit = win.getByTestId('spec-cockpit');
    for (const name of ['허락', '승인', '거절', '답하기'])
      check((await cockpit.getByRole('button', { name }).count()) === 0, `1: no ${name} button on the 개요`);
    check(await cockpit.getByTestId('spec-waiting').isVisible(), '1: 나를 기다림 is on the 개요');
    await shot(page, '01-cockpit-off');

    // ── 2. The 켜기 window ──
    await win.getByTestId('spec-turn-on').click();
    const wizard = page.getByTestId('spec-wizard');
    await eventually('candidates', async () => (await wizard.getByTestId('spec-candidate').count()) >= 7);
    const row = (p: string) => wizard.locator(`[data-testid="spec-candidate"][data-path="${p}"]`);
    const ticked = (p: string) => row(p).locator('input[type="checkbox"]').isChecked();
    check((await row('private-plan.md').getAttribute('data-git')) === 'ignored' && !(await ticked('private-plan.md')), '2: the git-ignored document starts unticked');
    check(!(await ticked('HANDOFF.md')), '2: the log document starts unticked');
    check(!(await ticked('README.md')), '2: other starts unticked');
    for (const [p, git, tag] of [
      ['docs/requirements/SRS.md', 'committed', '커밋됨'],
      ['docs/design/cockpit.md', 'modified', '수정됨'],
      ['docs/plan/TODO.md', 'untracked', '미추적'],
    ] as const)
      check((await row(p).getAttribute('data-git')) === git && (await ticked(p)) && (await row(p).textContent())?.includes(tag), `2: ${p} ticked, tagged ${tag}`);
    await shot(page, '02-wizard');

    // ── 3. Enable ──
    await wizard.getByTestId('spec-wizard-confirm').click();
    const done = await eventually('the result', async () => (await wizard.getByTestId('spec-wizard-done').count()) && wizard.getByTestId('spec-wizard-done').textContent());
    check(done.includes('4개'), `3: the result summary (${done})`);
    await shot(page, '03-enabled');
    await wizard.getByRole('button', { name: '닫기' }).click();
    await eventually('the card turns on', async () => (await card.getAttribute('data-enabled')) === 'true');
    await shot(page, '03b-cockpit-on');

    // ── 4. The 문서 tab ──
    await tab('문서').click();
    const docsList = win.getByTestId('spec-docs');
    await eventually('the documents', async () => (await docsList.getByTestId('spec-doc').count()) === 4);
    const first = (await api(page, 'docs')).docs as Doc[];
    check(first.every((d) => /^d_[a-z2-7]{10}$/.test(d.uid)), '4: every tracked document has a UID');
    const gitOf = Object.fromEntries(first.map((d) => [d.path, d.git]));
    check(
      gitOf['docs/requirements/SRS.md'] === 'committed' && gitOf['docs/design/cockpit.md'] === 'modified' && gitOf['docs/plan/TODO.md'] === 'untracked',
      `4: git states ${JSON.stringify(gitOf)}`,
    );
    const shownUid = await docsList.locator('[data-testid="spec-doc"][data-path="docs/plan/TODO.md"] .font-mono').textContent();
    const todoUid = first.find((d) => d.path === 'docs/plan/TODO.md')!.uid;
    check(shownUid && todoUid.startsWith(shownUid), `4: the row shows the short UID (${shownUid})`);
    await shot(page, '04-docs');
    const registry = path.join(cfg, 'spec', 'p_aaaaaaaaaa', 'registry.json');
    check((fs.statSync(registry).mode & 0o777) === 0o600 && !/비공개|Cockpit|FR-OFC/.test(fs.readFileSync(registry, 'utf-8')), '4: the Registry is 0600 and holds no text');

    // ── 5. Restart ──
    await desk.close();
    await daemon.stop();
    killFakeSessions(home);
    daemon = start();
    const { ctx: desk2, page: page2 } = await open({ viewport: { width: 1400, height: 900 } });
    await page2.goto(await daemon.loginUrl());
    await page2.waitForURL(`http://127.0.0.1:${port}/`);
    const afterRestart = (await api(page2, 'docs')).docs as Doc[];
    const uidMap = (ds: Doc[]) => JSON.stringify(Object.fromEntries(ds.map((d) => [d.path, d.uid])));
    check(uidMap(afterRestart) === uidMap(first), '5: the same UIDs after a daemon restart');
    const after = hashTree(repo.folder);
    const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
    check(changed.length === 0 && '.git/config' in after && '.git/index' in after, `5: no repository byte changed, .git/config and .git/index included (${changed.join(', ') || 'none'})`);

    // ── 6. Commit the untracked document ──
    repo.git(['add', 'docs/plan/TODO.md']);
    repo.git(['commit', '-q', '-m', 'plan: TODO']);
    await wait(SPEC_SCAN_MIN_MS + 500); // the next read scans again
    const committed = await eventually('committed', async () => {
      const d = ((await api(page2, 'docs')).docs as Doc[]).find((x) => x.path === 'docs/plan/TODO.md');
      return d?.git === 'committed' && d;
    });
    check(committed.uid === todoUid, '6: the committed document keeps its UID, now committed');
    await hangul(page2);
    await openOfficeWindow(page2);
    const win2 = page2.locator(DEV_WINDOW);
    await win2.getByRole('button', { name: '프로젝트', exact: true }).click();
    await win2.getByRole('button', { name: '문서', exact: true }).click();
    await eventually('the committed row', async () => (await win2.locator('[data-testid="spec-doc"][data-path="docs/plan/TODO.md"]').getAttribute('data-git')) === 'committed');
    await shot(page2, '05-docs-after-commit-restart');
    const phoneState = await desk2.storageState();
    await desk2.close();

    // ── 7. Phone ──
    const { page: phone } = await open({ ...PHONE, storageState: phoneState });
    await phone.goto(`http://127.0.0.1:${port}/`);
    await hangul(phone);
    await phone.locator('[data-dock="board"]').tap();
    const pw = phone.locator('[aria-label="현황판 화면"]');
    const dev = pw.getByRole('button', { name: '프로젝트', exact: true });
    if ((await dev.count()) && (await dev.getAttribute('aria-pressed')) !== 'true') await dev.tap();
    await pw.getByRole('button', { name: '개요', exact: true }).tap();
    await pw.getByTestId('spec-cockpit').waitFor({ timeout: 15_000 });
    const nav = pw.getByRole('navigation', { name: '개발 메뉴' });
    const phoneTabs = await nav.getByRole('button').allTextContents();
    check(phoneTabs.join(' ') === '개요 이슈 요구사항 그래프 문서 더보기', `7: phone tabs fold 에이전트 and 변경 under 더보기 (${phoneTabs.join(' ')})`);
    const wide = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check(wide, '7: no horizontal page scroll at 390 px');
    await shot(phone, '06-phone-cockpit');
    await pw.getByRole('button', { name: '문서', exact: true }).tap();
    await eventually('phone docs', async () => (await pw.getByTestId('spec-doc').count()) === 4);
    await shot(phone, '07-phone-docs');
    await nav.getByRole('button', { name: '더보기' }).tap();
    check((await nav.getByRole('button', { name: '에이전트', exact: true }).count()) === 1, '7: 더보기 shows 에이전트 and 변경');
    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
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

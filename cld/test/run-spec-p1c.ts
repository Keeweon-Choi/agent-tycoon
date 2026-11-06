/**
 * SPT-P1C visual check: dist/cli.js in a temp HOME (the engine fake as `claude`, no real agent),
 * one project `alpha` whose folder is a temp git repository with an SRS table, three OpenSpec-like
 * specs and one more spec whose common words are template text.
 *  1. Turn spec tracking on; the SRS renamed into another folder in a commit, one row edited: the
 *     same document and item UIDs (D1 from the commit).
 *  2. An uncommitted edit of a requirement: the same UID.
 *  3. A requirement moved out of its spec and pasted twice into another: two 같은 항목 확인
 *     questions with the old-text diff; 같아요 on the first gives it the old UID.
 *  4. A requirement's body replaced under the same title (a wrong match on purpose, T3 0.6-0.7):
 *     it shows in 확인 권장; 나누기 gives the item a new UID and retires the old one.
 *  5. A trace table repeating the SRS IDs: one grouped alert; 참조만 하는 표로 보기 clears it.
 *  6. Phone 390x844: the 문서 tab, no horizontal page scroll.
 * The daemon changes no repository byte (.git included) at any step. Screenshots in cld/artifacts/spec-p1c/.
 *
 *   npx tsx cld/test/run-spec-p1c.ts [port 18282|18283]
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
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
} from '../../server/src/cld/testHome.js';
import { SPEC_SCAN_MIN_MS } from '../../server/src/constants.js';

const port = Number(process.argv[2]) || 18282;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/spec-p1c');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 420_000;
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
const diff = (a: Record<string, string>, b: Record<string, string>) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);

type Item = { uid: string; displayId?: string; title: string; doc: string; state: string };
type Doc = { uid: string; path: string };

export const OS = (name: string, reqs: Array<[string, string]>) =>
  `# ${name} Specification\n\n## Purpose\nWhat ${name} does.\n\n## Requirements\n` +
  reqs.map(([t, b]) => `### Requirement: ${t}\n${b}\n\n#### Scenario: basic\n- **WHEN** it happens\n- **THEN** it works\n`).join('\n');
export const SRS =
  '# SRS\n\n## 3.1 사무실\n\n| ID | 요구 | 상태 |\n|---|---|---|\n| FR-OFC-001 | 오케스트레이터 탭마다 방이 있고 방마다 이름표가 붙는다 | 완료 |\n| FR-OFC-002 | 방 이름을 바꿀 수 있고 바꾼 이름은 재시작 뒤에도 남는다 | 진행 |\n| NFR-PERF-008 | 꺼진 프로젝트는 읽지도 세지도 않아 비용이 0이다 | 검토 |\n';
const LOGIN = 'The system SHALL allow a registered user to sign in with an email address and a password, and SHALL lock the account for 15 minutes after five failed attempts in a row.';
const RESET = 'The system SHALL email a single-use password reset link that expires after 30 minutes to the address on the account.';
const AUDIT = 'The system SHALL record every sign-in, sign-out and password change in an append-only audit log kept for 90 days.';
export const AUTH = OS('auth', [['User login', LOGIN], ['Audit log', AUDIT]]);
export const ADMIN = OS('admin', [['Password reset', RESET]]);
export const OFFICE = OS('office', [
  ['Room signs', 'The office SHALL show every project room with a sign that carries the project name and the number of agents at work.'],
  ['Night mode', 'The office SHALL dim the lights after the owner has been away for an hour and SHALL light them again on the next visit.'],
  ['Floor list', 'The office SHALL list the floors on the left with the rooms of each floor and SHALL scroll to the one the owner picks.'],
  ['Desk names', 'Every desk SHALL carry the name of the agent sitting at it, and the name SHALL follow the agent when it moves.'],
  ['Lobby clock', 'The lobby SHALL hang a clock that shows the host time and the time of the next scheduled job.'],
]);
const PURPOSE =
  '# Recovery Specification\n\n## Purpose\nThis document collects what the sign-in service must do for owners, guests and the help desk, how long it keeps what it learns, and which parts other teams may rely on when they build screens on top of it.\n\n## Requirements\n';
export const RECOVERY_BEFORE = `${PURPOSE}### Requirement: Account recovery\n비밀번호를 잊은 사람에게 한 번만 쓸 수 있는 재설정 링크를 계정의 메일 주소로 보내고, 링크는 삼십 분 뒤에 끝나며 이미 연 링크는 다시 받지 않는다. 링크를 연 기기와 시각은 계정 기록에 남기고, 같은 주소로 하루에 다섯 번 넘게 요청하면 그날은 더 보내지 않으며, 그 사실을 계정 주인에게 따로 알린다. 새 비밀번호는 지난 세 개와 달라야 하고 바뀐 뒤에는 다른 기기의 접속을 모두 끊는다.\n`;
export const RECOVERY_AFTER = `${PURPOSE}### Requirement: Account recovery\n상담원은 전화한 고객에게 개인 질문 두 개를 확인한 뒤 복구 번호를 읽어 줄 수 있고, 그런 통화는 담당자 이름과 시각과 함께 상담 일지에 남긴다. 일지는 매주 월요일 아침 팀장이 훑어보고 이상한 통화가 있으면 보안 담당에게 넘긴다. 주말과 공휴일에는 당직 한 명만 이 일을 하며, 당직표는 사내 게시판 맨 위에 붙여 둔다.\n`;
export const TRACE = '# 추적표\n\n| ID | 설계 | 시험 |\n|---|---|---|\n| FR-OFC-001 | office.md | TC-001 |\n| FR-OFC-002 | office.md | TC-002 |\n| NFR-PERF-008 | cost.md | TC-003 |\n';

async function main() {
  if (port !== 18282 && port !== 18283) throw new Error('port 18282 or 18283');
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
  const old = () => new Date(Date.now() - 60_000); // older than the 5 s "being written" window
  const write = (rel: string, text: string) => {
    repo.write(rel, text);
    fs.utimesSync(path.join(repo.folder, rel), old(), old());
  };
  write('docs/requirements/SRS.md', SRS);
  write('docs/specs/auth.md', AUTH);
  write('docs/specs/admin.md', ADMIN);
  write('docs/specs/recovery.md', RECOVERY_BEFORE);
  write('docs/specs/office.md', OFFICE);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS and specs']);

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
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal']);
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
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    const api = async (p: Page, route: string) => {
      const r = await p.request.get(`http://127.0.0.1:${port}/api/cld/spec/alpha/${route}`);
      if (!r.ok()) throw new Error(`${route}: ${r.status()} ${await r.text()}`);
      return r.json();
    };
    const items = async (p: Page, q = '') => (await api(p, `items?kind=&state=all${q}`)).items as Item[];
    /** The next scan, after the interval (any spec read asks for it). */
    const rescan = async (p: Page) => {
      await wait(SPEC_SCAN_MIN_MS + 500);
      await api(p, 'summary');
    };

    const { ctx: desk, page } = await open({ viewport: { width: 1400, height: 1000 } });
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

    // ── 1. Enable; rename the SRS in a commit with an edit ──
    await tab('개요').click();
    await win.getByTestId('spec-turn-on').click();
    const wizard = page.getByTestId('spec-wizard');
    await eventually('candidates', async () => (await wizard.getByTestId('spec-candidate').count()) === 5);
    await wizard.getByTestId('spec-wizard-confirm').click();
    await eventually('enabled', async () => (await wizard.getByTestId('spec-wizard-done').count()) > 0);
    await wizard.getByRole('button', { name: '닫기' }).click();
    const before = hashTree(repo.folder);
    const docs0 = (await api(page, 'docs')).docs as Doc[];
    const srsDoc = docs0.find((d) => d.path === 'docs/requirements/SRS.md')!.uid;
    const ids0 = Object.fromEntries((await items(page)).filter((i) => i.displayId).map((i) => [i.displayId!, i.uid]));
    check(Object.keys(ids0).length === 3, `1: three requirement IDs (${Object.keys(ids0).join(' ')})`);
    fs.mkdirSync(path.join(repo.folder, 'docs/reqs'));
    repo.git(['mv', 'docs/requirements/SRS.md', 'docs/reqs/SRS-v2.md']);
    write('docs/reqs/SRS-v2.md', SRS.replace('비용이 0이다', '비용이 0이고 타이머도 없다'));
    repo.git(['commit', '-q', '-am', 'SRS: moved to docs/reqs, NFR-PERF-008 sharpened']);
    let mine = hashTree(repo.folder);
    await rescan(page);
    const docs1 = (await api(page, 'docs')).docs as Doc[];
    const moved = docs1.find((d) => d.path === 'docs/reqs/SRS-v2.md');
    check(moved?.uid === srsDoc, `1: the renamed SRS keeps its document UID (${moved?.uid})`);
    const ids1 = Object.fromEntries((await items(page)).filter((i) => i.displayId && i.state === 'active').map((i) => [i.displayId!, i.uid]));
    check(JSON.stringify(ids1) === JSON.stringify(ids0), '1: every requirement keeps its UID through the rename and the edit');
    check(diff(mine, hashTree(repo.folder)).length === 0, '1: the daemon changed no repository byte (.git included)');
    await tab('문서').click();
    await eventually('the moved SRS row', async () => (await win.locator('[data-testid="spec-doc"][data-path="docs/reqs/SRS-v2.md"]').count()) === 1);
    await shot(page, '01-docs-after-rename');

    // ── 2. An uncommitted edit ──
    write('docs/reqs/SRS-v2.md', SRS.replace('비용이 0이다', '비용이 0이고 타이머도 없다').replace('이름표가 붙는다', '큰 이름표가 붙는다'));
    mine = hashTree(repo.folder);
    await rescan(page);
    const edited = (await items(page, '&q=FR-OFC-001')).find((i) => i.displayId === 'FR-OFC-001');
    check(edited?.uid === ids0['FR-OFC-001'] && edited.title.includes('큰 이름표'), `2: the uncommitted edit keeps the UID (${edited?.uid})`);
    const docGit = ((await api(page, 'docs')).docs as Array<Doc & { git: string }>).find((d) => d.uid === srsDoc)?.git;
    check(docGit === 'modified', `2: the document shows as modified (${docGit})`);

    // ── 3. Moved out and pasted twice: a question; 같아요 ──
    const audit = (await items(page, '&q=Audit')).find((i) => i.state === 'active')!.uid;
    write('docs/specs/auth.md', OS('auth', [['User login', LOGIN]]));
    write('docs/specs/admin.md', OS('admin', [['Password reset', RESET], ['Audit log', AUDIT], ['Audit log', AUDIT]]));
    await rescan(page);
    const asked = await eventually('two questions (API)', async () => {
      const q = (await api(page, 'questions')).questions as Array<{ kind: string; uid: string; cands: Array<{ uid: string }> }>;
      if (q.length !== 2) console.log(`  questions now: ${JSON.stringify(q.map((x) => [x.kind, x.uid, x.cands.map((c) => c.uid)]))}`);
      return q.length === 2 && q;
    }, SPEC_SCAN_MIN_MS * 3);
    check(asked.every((q) => q.kind === 'item' && q.cands.some((c) => c.uid === audit)), '3: both copies are asked, each naming the old requirement');
    await tab('개요').click();
    await tab('문서').click();
    const qs = win.getByTestId('spec-question');
    await eventually('two questions', async () => (await qs.count()) === 2);
    const q0 = qs.first();
    check((await q0.getByTestId('spec-q-cand').getAttribute('data-uid')) === audit, '3: the question names the old requirement as the candidate');
    const diffText = await q0.getByTestId('spec-q-diff').textContent();
    check(diffText?.includes('append-only audit log'), '3: the old text is shown for comparison');
    await shot(page, '02-docs-question');
    const askedUid = await q0.getAttribute('data-uid');
    await q0.getByTestId('spec-q-same').click();
    await eventually('one question left', async () => (await qs.count()) === 1);
    const copies = (await items(page, '&q=Audit')).filter((i) => i.state !== 'retired');
    check(copies.some((i) => i.uid === audit && i.state === 'active'), `3: 같아요 gives the first copy the old UID (${audit})`);
    check(!copies.some((i) => i.uid === askedUid), '3: the provisional UID is gone (an alias of the old one now)');
    await shot(page, '03-docs-answered');

    // ── 4. A wrong match on purpose: 확인 권장, then 나누기 ──
    const recovery = (await items(page, '&q=recovery')).find((i) => i.state === 'active')!.uid;
    write('docs/specs/recovery.md', RECOVERY_AFTER);
    await rescan(page);
    await tab('개요').click();
    const card = win.getByTestId('spec-card');
    const reviewCount = await eventually('the review count on the card', async () => card.getByTestId('spec-card-review').getAttribute('data-count'));
    check(reviewCount === '1', `4: the 개요 card counts one 확인 권장 (${reviewCount})`);
    await shot(page, '04-cockpit-counts');
    await tab('문서').click();
    const row = win.locator(`[data-testid="spec-review-row"][data-uid="${recovery}"]`);
    await eventually('the review row', async () => (await row.count()) === 1);
    await shot(page, '05-docs-review');
    await row.getByTestId('spec-review-split').click();
    await eventually('the review row gone', async () => (await row.count()) === 0);
    // A retired item has no title any more (titles are never stored): find it by UID, not by words.
    const fresh = (await items(page, '&q=recovery')).find((i) => i.state === 'active');
    const oldState = (await items(page)).find((i) => i.uid === recovery)?.state;
    check(fresh && fresh.uid !== recovery && oldState === 'retired', `4: 나누기 gives the item a new UID (${fresh?.uid}) and retires the old one (${oldState})`);
    const decision = win.locator(`[data-testid="spec-decision"][data-uid="${fresh!.uid}"]`);
    await eventually('the split in 최근 판정', async () => (await decision.getAttribute('data-how')) === 'owner-split');
    check(true, '4: 최근 판정 shows the split');
    await decision.scrollIntoViewIfNeeded();
    await shot(page, '06-docs-decisions');

    // ── 5. A trace table repeating the SRS IDs: one grouped alert; 참조만 하는 표 ──
    write('docs/specs/traceability.md', TRACE);
    await rescan(page);
    await tab('개요').click();
    await tab('문서').click();
    const alert = win.locator('[data-testid="spec-alert"][data-type="duplicateIds"]');
    await eventually('the grouped alert', async () => (await alert.count()) === 1);
    const alertText = await alert.textContent();
    check((await alert.getAttribute('data-count')) === '3' && alertText?.includes('traceability.md') && alertText.includes('SRS-v2.md'), `5: one alert for the three IDs (${alertText?.slice(0, 80)})`);
    await alert.scrollIntoViewIfNeeded();
    await shot(page, '07-docs-grouped-alert');
    await alert.getByTestId('spec-alert-refs').click();
    await eventually('the alert cleared', async () => (await alert.count()) === 0, SPEC_SCAN_MIN_MS * 2);
    const trace = win.locator('[data-testid="spec-doc"][data-path="docs/specs/traceability.md"]');
    check((await trace.getAttribute('data-mode')) === 'refs' && (await trace.getAttribute('data-items')) === '0', '5: the trace table is 참조만 and makes no items');
    await trace.scrollIntoViewIfNeeded();
    await shot(page, '08-docs-refs');
    const changed = diff(mine, hashTree(repo.folder)).filter((k) => !k.startsWith('docs/'));
    check(changed.length === 0, `5: the daemon changed no repository byte, .git included (${changed.join(', ') || 'none'})`);
    check(diff(before, hashTree(repo.folder)).every((k) => k.startsWith('docs/') || k.startsWith('.git/')), '5: only our own edits and commit changed the repository');
    const phoneState = await desk.storageState();
    await desk.close();

    // ── 6. Phone ──
    const { page: phone } = await open({ ...PHONE, storageState: phoneState });
    await phone.goto(`http://127.0.0.1:${port}/`);
    await hangul(phone);
    await phone.locator('[data-dock="board"]').tap();
    const pw = phone.locator('[aria-label="현황판 화면"]');
    const dev = pw.getByRole('button', { name: '프로젝트', exact: true });
    if ((await dev.count()) && (await dev.getAttribute('aria-pressed')) !== 'true') await dev.tap();
    const nav = pw.getByRole('navigation', { name: '개발 메뉴' });
    await nav.getByRole('button', { name: '문서', exact: true }).tap();
    await eventually('phone docs', async () => (await pw.getByTestId('spec-doc').count()) >= 5);
    await eventually('phone question', async () => (await pw.getByTestId('spec-question').count()) === 1);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '6: no horizontal page scroll on 문서 at 390 px');
    await shot(phone, '09-phone-docs');
    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    console.error(daemon.log.join('').split('\n').filter((l) => /spec/i.test(l)).slice(-20).join('\n'));
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

if (process.argv[1]?.endsWith('run-spec-p1c.ts')) main().catch((err) => {
  console.error(err);
  process.exit(1);
});

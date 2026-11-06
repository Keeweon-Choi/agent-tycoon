/**
 * RQ1-RQ3 visual and behaviour check: dist/cli.js in a temp HOME (the engine's fake `claude`, no real
 * agent), three projects whose folders are temp git repositories:
 *  - alpha: an SRS table, one Spec Kit feature (`specs/001-login/`), a PRD without IDs, a roadmap left
 *    unread, and a commit naming FR-TRC-002;
 *  - beta: no requirements document (empty: none found);
 *  - gamma: only the PRD without IDs, read (empty: zero requirements).
 * Checks: the three empty states (alpha before it reads, beta, gamma); the tree's three levels; the
 * detail (why, text, issues, what was seen); hide and sensitive in the ⚙ sheet; an issue made from a
 * requirement, which then shows linked. Photos in cld/artifacts/feat-reqs-merged-tab/: 모던 at
 * 1600x1000 and 1024x700, a phone at 390x844, one 픽셀 감성.
 *
 *   npx tsx cld/test/run-reqs-merged-tab.ts [port 19160-19169]
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo, type TempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import {
  assertPortFree,
  type Daemon,
  DEV_WINDOW,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openWorkbenchTab,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]) || 19160;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/feat-reqs-merged-tab');
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
async function eventually<T>(
  what: string,
  test: () => Promise<T | null | undefined | false>,
  timeout = 20_000,
): Promise<T> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

const SRS = [
  '# SRS',
  '',
  '### 3.1 사무실 화면(OFC)',
  '',
  '| ID | 요구사항 | 단계 | 검증 |',
  '|---|---|---|---|',
  '| FR-OFC-001 | 사무실은 에이전트를 캐릭터로 보인다 | 1 | E2E |',
  '',
  '### 3.21 명세 추적(TRC)',
  '',
  '| ID | 요구사항 | 단계 | 검증 |',
  '|---|---|---|---|',
  '| FR-TRC-001 | 요구사항 탭은 문서와 기능과 요구사항을 나무로 보인다 | 4 | E2E |',
  '| FR-TRC-002 | 에이전트는 MCP 읽기 도구로 요구사항과 관련 맥락을 조회한다 | 4 | 단위 |',
  '| FR-TRC-003 | 배포 근거는 배포 작업의 exit 0과 배포 확인을 나눠 보인다 | 4 | 단위 |',
  '',
  '### 4.1 성능',
  '',
  '| ID | 요구사항 | 단계 | 검증 |',
  '|---|---|---|---|',
  '| NFR-PERF-001 | 요구사항 탭은 1초 안에 열린다 | 4 | 단위 |',
  '',
].join('\n');
const KIT = [
  '# Feature Specification: Login',
  '',
  '## User Scenarios & Testing',
  '',
  '### User Story 1 - Sign in (Priority: P1)',
  '',
  'A user signs in with a passkey.',
  '',
  '**Acceptance Scenarios**:',
  '',
  '1. **Given** a passkey, **When** the user signs in, **Then** the office opens',
  '',
  '## Requirements',
  '',
  '- **FR-001**: System MUST sign a user in with a passkey',
  '- **FR-002**: System MUST keep the session for a week',
  '',
  '## Success Criteria',
  '',
  '- **SC-001**: A sign-in takes under ten seconds',
  '',
].join('\n');
const PRD = [
  '# PRD',
  '',
  '## 목표',
  '',
  '사장님이 요구사항을 쉽게 본다.',
  '',
  '## 범위',
  '',
  '요구사항 탭 하나.',
  '',
].join('\n');
const ROADMAP = ['# Roadmap', '', '- 다음 분기', ''].join('\n');

function repoWith(files: Record<string, string>, more?: (r: TempRepo) => void): TempRepo {
  const repo = makeTempRepo({ push: false });
  const old = new Date(Date.now() - 60_000);
  for (const [rel, text] of Object.entries(files)) {
    repo.write(rel, text);
    fs.utimesSync(path.join(repo.folder, rel), old, old);
  }
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: requirements']);
  more?.(repo);
  return repo;
}

async function main() {
  if (port < 19160 || port > 19169) throw new Error('port 19160-19169');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  };
  const alpha = repoWith(
    {
      'docs/requirements/SRS.md': SRS,
      'specs/001-login/spec.md': KIT,
      'docs/product/PRD.md': PRD,
      'docs/plan/roadmap.md': ROADMAP,
    },
    (r) => {
      r.write('src/agent.ts', 'export const tool = 1;\n');
      r.git(['add', '-A']);
      r.git(['commit', '-q', '-m', 'feat(brain): agent query tools (FR-TRC-002)']);
    },
  );
  const beta = repoWith({ 'README.md': '# beta\n' });
  const gamma = repoWith({ 'docs/product/PRD.md': PRD });
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const projects = [
    ['p_aaaaaaaaaa', 'alpha', alpha],
    ['p_bbbbbbbbbb', 'beta', beta],
    ['p_cccccccccc', 'gamma', gamma],
  ] as const;
  put('projects.json', {
    v: 2,
    projects: projects.map(([projectId, name, r], i) => ({
      projectId,
      name,
      folder: r.folder,
      room: '개발실',
      leadAssignmentId: `a_${'abc'[i].repeat(10)}`,
    })),
  });
  put('assignments.json', {
    v: 1,
    assignments: projects.map(([projectId], i) => ({
      assignmentId: `a_${'abc'[i].repeat(10)}`,
      projectId,
      role: 'lead',
      provider: 'claude',
      wantRunning: false,
    })),
  });
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, [
    '--engine',
    'on',
    '--allow-chat',
    '--allow-actions',
    '--no-terminal',
  ]);
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  try {
    browser = await launchBrowser();
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await ctx.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const api = (project: string, route: string, body?: object) =>
      page.evaluate(
        async ({ url, body }) => {
          const r = await fetch(
            url,
            body
              ? {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(body),
                }
              : {},
          );
          return { status: r.status, json: await r.json().catch(() => null) };
        },
        { url: `/api/cld/spec/${project}/${route}`, body },
      );
    const win = page.locator(DEV_WINDOW);

    // ── the three empty states ──
    await openWorkbenchTab(page, '요구사항', { project: 'alpha' });
    await win.getByTestId('hud-title-office').dblclick(); // maximized
    const names = await win
      .getByRole('navigation', { name: '개발 메뉴' })
      .getByRole('button')
      .allTextContents();
    check(
      !names.includes('문서') && names.includes('요구사항'),
      `the tabs, no 문서 (${names.join(' ')})`,
    );
    await win.getByTestId('reqs-empty-found').waitFor();
    check(
      /요구사항 · 설계 문서 \d+개를 찾았어요/.test(
        await win.getByTestId('reqs-empty-found').innerText(),
      ),
      'empty 1: off, documents found, says how many and what to do',
    );
    await shot(page, '01-empty-found-desktop');
    await win.getByRole('combobox', { name: '개발 프로젝트' }).selectOption('beta');
    await win.getByTestId('reqs-empty-none').waitFor();
    check(
      await win.getByTestId('reqs-empty-none').getByTestId('spec-turn-on').isVisible(),
      'empty 2: nothing found, [문서 직접 고르기]',
    );
    check(
      (await api('gamma', 'enable', { docs: ['docs/product/PRD.md'] })).status === 200,
      'gamma reads its PRD',
    );
    await win.getByRole('combobox', { name: '개발 프로젝트' }).selectOption('gamma');
    await win.getByTestId('reqs-empty-zero').waitFor();
    check(
      (await win.getByTestId('reqs-empty-zero').innerText()).includes('제목도 요구사항으로'),
      "empty 3: on, zero requirements, points at ⚙'s 제목도 요구사항으로",
    );

    // ── alpha reads its documents (the 켜기 window's way) ──
    const on = await api('alpha', 'enable', {
      docs: ['docs/requirements/SRS.md', 'specs/001-login/spec.md', 'docs/product/PRD.md'],
    });
    check(on.status === 200, `alpha reads three documents (${JSON.stringify(on.json)})`);
    await win.getByRole('combobox', { name: '개발 프로젝트' }).selectOption('alpha');
    const tree = win.getByTestId('reqs-tree');
    await tree.waitFor();
    const docRows = await tree
      .getByTestId('reqs-doc')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-label')));
    check(
      docRows.includes('SRS.md') && docRows.includes('specs/') && docRows.includes('PRD.md'),
      `level 1, documents: ${docRows.join(' · ')}`,
    );
    const srs = tree.locator('[data-testid="reqs-doc"][data-label="SRS.md"]');
    const feats = await srs
      .getByTestId('reqs-feature')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
    check(
      feats.includes('FR-TRC') && feats.includes('FR-OFC') && feats.at(-1) === 'common',
      `level 2, features (모든 기능 공통 last): ${feats.join(' · ')}`,
    );
    const trc = srs.locator('[data-testid="reqs-feature"][data-key="FR-TRC"]');
    if (!(await trc.getByTestId('reqs-item').count()))
      await trc.locator('button[aria-expanded]').first().click();
    const ids = await trc
      .getByTestId('reqs-item')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
    check(
      ids.join(' ') === 'FR-TRC-001 FR-TRC-002 FR-TRC-003',
      `level 3, requirements: ${ids.join(' ')}`,
    );
    const head = await win
      .getByTestId('reqs-head-count')
      .evaluateAll((els) =>
        els.map((e) => `${e.getAttribute('data-state')}=${e.getAttribute('data-count')}`),
      );
    check(
      !(await win.getByTestId('spec-reqs').innerText()).includes('%'),
      `the head counts three states, no percentage (${head.join(' ')})`,
    );
    const item2 = trc.locator('[data-testid="reqs-item"][data-id="FR-TRC-002"]');
    check(
      (await item2.getAttribute('data-state')) === 'doing',
      'FR-TRC-002 is 진행 중: a commit names it (글에 적힘)',
    );

    // ── the detail ──
    await item2.click();
    const detail = win.getByTestId('spec-detail');
    await detail.getByTestId('reqs-why').waitFor();
    check(
      (await detail.getByTestId('reqs-why').innerText()).startsWith('왜 진행 중인가요'),
      'the detail says why it is 진행 중',
    );
    check(
      (await detail.getByTestId('spec-detail-text').innerText()).includes('MCP 읽기 도구'),
      'the detail shows the text',
    );
    check(
      (await detail.getByTestId('spec-detail-verify').innerText()).includes('단위'),
      'the 검증 column is 확인 방법, not a criterion (RQ5)',
    );
    const seen = detail.getByTestId('reqs-seen-row').first();
    check(
      (await seen.getAttribute('data-status')) === 'observed' &&
        (await seen.getByTestId('reqs-src').allTextContents()).includes('글에 적힘'),
      'what was seen names its source (글에 적힘, 직접 봄)',
    );
    check(
      (await detail.getByTestId('reqs-issues').innerText()).includes('연결된 이슈가 없어요'),
      'no issue yet, and it says what to do',
    );
    await shot(page, '02-tree-detail-desktop');

    // ── RQ3: an issue from the requirement ──
    await detail.getByTestId('reqs-issue-make').click();
    const dialog = page.getByTestId('reqs-issue-dialog');
    check(
      (await dialog.getByTestId('reqs-issue-title').inputValue()).startsWith('FR-TRC-002 '),
      'the issue title starts with the display ID',
    );
    await dialog.getByTestId('reqs-issue-create').click();
    const issue = detail.getByTestId('reqs-issue').first();
    await eventually(
      'the issue shows linked',
      async () =>
        (await issue.count()) && (await issue.getAttribute('data-status')) === 'confirmed',
    );
    check(
      true,
      `the issue ${await issue.getAttribute('data-id')} shows linked, confirmed (no 글에 적힘 chip)`,
    );
    await shot(page, '03-issue-linked-desktop');

    // ── the ⚙ sheet: hide and sensitive ──
    await win.getByTestId('reqs-gear').click();
    const sheet = win.getByTestId('reqs-sheet');
    await sheet.waitFor();
    check(
      (
        await sheet
          .getByTestId('reqs-sheet-found')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))
      ).includes('docs/plan/roadmap.md'),
      'the sheet lists a document found but not read',
    );
    const prd = sheet.locator('[data-testid="reqs-sheet-doc"][data-path="docs/product/PRD.md"]');
    await prd.getByTestId('reqs-doc-more').click();
    await shot(page, '04-sheet-menu-desktop');
    await prd.getByTestId('reqs-menu-sensitive').click();
    await eventually(
      'PRD sensitive',
      async () => (await prd.getAttribute('data-sensitive')) === 'true',
    );
    check(true, '민감 sticks (registry sensitive: true)');
    await prd.getByTestId('reqs-doc-more').click();
    await prd.getByTestId('reqs-menu-hide').click();
    await eventually(
      'PRD hidden',
      async () =>
        (await sheet
          .locator('[data-testid="reqs-sheet-hidden"][data-path="docs/product/PRD.md"]')
          .count()) === 1,
    );
    check(
      !(await tree.locator('[data-testid="reqs-doc"][data-label="PRD.md"]').count()),
      '숨기기 moves it to 숨김 and out of the tree',
    );
    await sheet
      .locator('[data-testid="reqs-sheet-hidden"][data-path="docs/product/PRD.md"]')
      .getByTestId('reqs-sheet-again')
      .click();
    await eventually(
      'PRD back',
      async () =>
        (await tree.locator('[data-testid="reqs-doc"][data-label="PRD.md"]').count()) === 1,
    );
    check(true, '[다시 읽기] brings it back');
    await sheet.getByTestId('reqs-sheet-close').click();

    // ── 1024x700, 픽셀 감성 ──
    await page.setViewportSize({ width: 1024, height: 700 });
    await wait(300);
    await shot(page, '05-tree-detail-1024');
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      'no horizontal page scroll at 1024',
    );
    await page.evaluate(() => localStorage.setItem('cld.ui-theme', 'pixel'));
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.reload();
    await openWorkbenchTab(page, '요구사항', { project: 'alpha' });
    await win.getByTestId('reqs-tree').waitFor();
    const trc2 = win.locator('[data-testid="reqs-feature"][data-key="FR-TRC"]');
    if (!(await trc2.getByTestId('reqs-item').count()))
      await trc2.locator('button[aria-expanded]').first().click();
    await trc2.locator('[data-testid="reqs-item"][data-id="FR-TRC-002"]').click();
    await win.getByTestId('reqs-why').waitFor();
    check((await page.locator('html').getAttribute('data-ui-theme')) === 'pixel', '픽셀 감성 on');
    await shot(page, '06-pixel-desktop');
    await page.evaluate(() => localStorage.setItem('cld.ui-theme', 'modern'));
    const phoneState = await ctx.storageState();

    // ── the phone: the list, then the detail full screen ──
    const pctx = await browser.newContext({ ...PHONE, storageState: phoneState });
    const phone = await pctx.newPage();
    await phone.goto(`http://127.0.0.1:${port}/`);
    await openWorkbenchTab(phone, '요구사항', { project: 'alpha', tap: true });
    const pw = phone.locator(DEV_WINDOW);
    await pw.getByTestId('reqs-tree').waitFor();
    await pw.locator('[data-testid="reqs-doc"][data-key]').first().tap();
    await pw.locator('[data-testid="reqs-feature"][data-key="FR-TRC"]').tap();
    await pw.getByTestId('reqs-crumb').waitFor();
    check(
      await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      'phone: no horizontal scroll',
    );
    await shot(phone, '07-phone-list');
    await pw.locator('[data-testid="reqs-item"]').nth(1).tap();
    const pd = phone.getByTestId('spec-detail');
    await pd.getByTestId('reqs-why').waitFor();
    const box = await pd.boundingBox();
    check(
      box && box.width >= 389 && box.height >= 840,
      `phone: the detail is full screen (${box?.width}x${box?.height})`,
    );
    await shot(phone, '08-phone-detail');
    await pctx.close();
    console.log(`\n${oks} checks passed; photos in ${OUT}`);
  } catch (err) {
    console.error(
      daemon.log
        .join('')
        .split('\n')
        .filter((l) => /spec|error/i.test(l))
        .slice(-20)
        .join('\n'),
    );
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    for (const r of [alpha, beta, gamma]) r.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * T-183: the 개발실's 이슈 view. A Worker's issue with its own worktree, sent to review and back, is
 * listed under 하고 있는 일 and told as its steps from what is stored; the step buttons open the
 * existing 변경 and 대화 views on its worktree, and the tree view is still there, unchanged. The phone
 * opens the story from the list and goes back. Nobody runs: the project, the Worker, the Task, its
 * worktree and the commit are state made with `agty` and git before the page looks (as T-99 flow 12).
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Locator } from '@playwright/test';

import { makeTempRepo } from '../../../server/src/agent-tycoon/engine/git/testRepo';
import { expect, PHONE, type StandaloneContext, test } from '../../fixtures/standalone';

const TITLE = '장바구니 합계 분리';
const CART = 'export const sumPrice = (xs: number[]) => xs.reduce((a, b) => a + b, 0);';
const SHOTS = path.join(__dirname, '../../../agent-tycoon/artifacts/t183');
const OPTIONS = { standaloneOptions: { agents: [{ name: 'shop', running: false }] } };

/** shop's clone, its Worker, issue T-1 in its own worktree with one commit, then review and back to doing. */
async function seed(standalone: StandaloneContext): Promise<() => void> {
  const repo = makeTempRepo();
  const folder = standalone.agentFolder('shop');
  repo.git(['clone', '-q', repo.remote, folder], repo.root);
  const ok = async (args: string[]) => {
    const r = await standalone.agty(args);
    expect(r.code, `agty ${args.join(' ')}: ${r.stdout}${r.stderr}`).toBe(0);
    return r.json as Record<string, any>;
  };
  await ok(['worker', 'add', 'shop', 'web-worker']);
  const added = await ok(['task', 'add', TITLE, '--project', 'shop', '--assignee', 'web-worker', '--status', 'doing']);
  expect(added.task?.id).toBe('T-1');
  await ok(['worktree', 'new', '--task', 'T-1', '--assign', 'web-worker']);
  const wt = repo
    .git(['worktree', 'list', '--porcelain'], folder)
    .split('\n\n')
    .map((block) => block.match(/^worktree (.+)$/m)?.[1])
    .find((p) => p && p !== folder);
  expect(wt, 'the worktree folder').toBeTruthy();
  fs.mkdirSync(path.join(wt!, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wt!, 'src/cart.ts'), `${CART}\n`);
  repo.git(['add', '-A'], wt);
  repo.git(['commit', '-q', '-m', 'feat(shop): cart total'], wt);
  await ok(['task', 'update', 'T-1', '--status', 'review']);
  await ok(['task', 'update', 'T-1', '--status', 'doing']);
  return () => repo.cleanup();
}

/** The story's checks that hold on both screens (the phone folds all but the larger card: a tap opens one). */
async function expectStory(scope: Locator, phone = false) {
  const story = scope.getByTestId('issue-story');
  await expect(story).toHaveAttribute('data-task-id', 'T-1');
  await expect(story.getByTestId('issue-title')).toHaveText(TITLE);
  // The state sentence: a fixed template filled with the Worker and the round the history shows.
  await expect(story.getByTestId('issue-say')).toContainText('검토에서 돌아와 web-worker 가 다시 고치고 있어요 (2번째)');
  const step = (id: string) => story.locator(`[data-testid="issue-step"][data-step="${id}"]`);
  // Back from review to doing: the work round is the live one, 검사 is the larger card telling the return.
  await expect(story).toHaveAttribute('data-current', 'work');
  await expect(step('work')).toContainText('2번째');
  await expect(step('check')).toHaveAttribute('data-look', 'back');
  await expect(step('check').getByTestId('issue-move')).toContainText('검토에서 진행 중 상태로 돌아갔어요 · 2번째');
  await expect(step('assign')).toContainText('가 만듦');
  if (phone) await step('changes').getByTestId('issue-step-toggle').tap();
  await expect(step('changes').getByTestId('issue-files')).toContainText('src/cart.ts', { timeout: 30_000 });
  await expect(step('changes').getByTestId('issue-files')).toContainText('+1 -0');
  // 머지: the pre-check's own words once it answered.
  await expect(step('merge').getByTestId('issue-merge-reason')).not.toContainText('확인하는 중', { timeout: 30_000 });
  // No deploy is linked to an issue: the one fixed line, never a made-up state.
  await expect(step('deploy')).toHaveAttribute('data-look', 'dim');
  await expect(step('deploy')).toContainText('머지된 뒤의 배포는 아직 이슈와 이어서 기록하지 않아요');
}

test.describe('desktop', () => {
  // The mock-up's size: the 개발실 maximized on a 1600 x 1000 screen.
  test.use({ ...OPTIONS, viewport: { width: 1600, height: 1000 } });

  test('the issue view tells a worktree issue as its steps and opens the existing views @area:devroom', async ({ page, standalone }) => {
    test.slow();
    const cleanup = await seed(standalone);
    try {
      await page.locator('[data-hud-id="icon:devroom"]').getByRole('button').click();
      const win = page.locator('[data-hud-window="devroom"]');
      await win.getByRole('button', { name: '보여 줄 프로젝트' }).click();
      await win.getByRole('menuitemradio', { name: 'shop' }).click();
      const room = win.getByTestId('devroom');
      await expect(room).toHaveAttribute('data-view', 'tree');
      await expect(win.getByTestId('devroom-card')).toHaveCount(1, { timeout: 30_000 });

      // 이슈: the issue is listed with its id, and its story is shown.
      await win.locator('[data-testid="devroom-view"][data-view="issue"]').click();
      await expect(room).toHaveAttribute('data-view', 'issue');
      const row = win.getByTestId('issue-row');
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(TITLE);
      await expect(row).toContainText('T-1');
      await expect(row.getByTestId('issue-bar')).toHaveAttribute('data-position', '2');
      await expect(row.getByTestId('issue-row-return')).toBeVisible();
      await expectStory(win);
      // The recorded return, drawn from 검사 back up to 고치는 중.
      await expect(win.getByTestId('issue-return-line')).toBeVisible();

      // 바뀐 내용 보기: the tree view's 변경 tab on that worktree.
      await win.getByTestId('issue-open-changes').click();
      await expect(room).toHaveAttribute('data-view', 'tree');
      await expect(win.getByTestId('devroom-body')).toHaveAttribute('data-tab', 'changes');
      await expect(win.getByTestId('review-file-item').filter({ hasText: 'cart.ts' })).toBeVisible({ timeout: 30_000 });

      // 대화 보기: the 에이전트 tab, web-worker's pane on its conversation.
      await win.locator('[data-testid="devroom-view"][data-view="issue"]').click();
      await win.getByTestId('issue-open-chat').click();
      await expect(room).toHaveAttribute('data-view', 'tree');
      await expect(win.getByTestId('devroom-body')).toHaveAttribute('data-tab', 'terminal');
      await expect(win.locator('[data-testid="devroom-pane-view"][data-view="chat"][aria-selected="true"]')).toHaveCount(1);
      await expect(win.getByTestId('devroom-picked')).toContainText(TITLE);

      // The tree is as it was: the one card, its Worker and its chip.
      const card = win.getByTestId('devroom-card').filter({ hasText: TITLE });
      await expect(card).toHaveCount(1);
      await expect(card.getByTestId('devroom-who')).toHaveText('web-worker');
      await expect(win.getByTestId('devroom-rail')).toBeVisible();

      // The view is remembered on this device.
      await win.locator('[data-testid="devroom-view"][data-view="issue"]').click();
      await page.reload();
      // The open window comes back with the page (pressing its Dock icon now would minimize it).
      await expect(room).toBeVisible({ timeout: 30_000 });
      await expect(room).toHaveAttribute('data-view', 'issue');

      // The mock-up's frame: the 개발실 maximized, the story in.
      await win.getByRole('button', { name: '최대화' }).click();
      await expect(win.getByTestId('issue-move')).toBeVisible({ timeout: 30_000 });
      await expect(win.getByTestId('issue-files')).toContainText('+1 -0', { timeout: 30_000 });
      await expect(win.getByTestId('issue-merge-reason')).not.toContainText('확인하는 중', { timeout: 30_000 });
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, 'desktop-issue.png') });
    } finally {
      cleanup();
    }
  });
});

test.describe('phone', () => {
  test.use({ ...PHONE, ...OPTIONS });

  test('the phone lists the issue first and opens its story with a way back @area:devroom', async ({ page, standalone }) => {
    test.slow();
    const cleanup = await seed(standalone);
    try {
      await page.locator('[data-dock="devroom"]').tap();
      const phone = page.getByTestId('devroom-phone');
      await phone.locator('[data-testid="devroom-view"][data-view="issue"]').tap();
      const row = phone.getByTestId('issue-row');
      await expect(row).toContainText(TITLE, { timeout: 30_000 });
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, 'phone-list.png') });
      await row.tap();
      await expectStory(phone, true);
      await page.screenshot({ path: path.join(SHOTS, 'phone-story.png') });
      await phone.getByTestId('devroom-back').tap();
      await expect(phone.getByTestId('issue-row')).toBeVisible();
    } finally {
      cleanup();
    }
  });
});

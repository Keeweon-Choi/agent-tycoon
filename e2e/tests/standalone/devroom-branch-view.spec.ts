/**
 * T-184: the 개발실's branch view. Two Tasks with a worktree each; the view shows the base branch as the
 * trunk and one tip per unmerged worktree; picking a tip opens the dev room's own 변경 pane; once one
 * worktree is merged it leaves the tips and comes back as today's loop. Nobody runs: the project, its
 * Worker, the Tasks and the worktrees' commits are state made with `agty` and git, as in
 * devroom-worktree-merge.spec.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

import { makeTempRepo } from '../../../server/src/agent-tycoon/engine/git/testRepo';
import { expect, test } from '../../fixtures/standalone';

const FIRST = '장바구니 합계 분리';
const SECOND = '검색 결과 정렬';
const CART = 'export const sumPrice = (xs: number[]) => xs.reduce((a, b) => a + b, 0);';

// Shots go to the test's own output folder (git-ignored); the task's artifacts are copied from there by hand.
const shot = (name: string) => test.info().outputPath(name);

test.use({ standaloneOptions: { agents: [{ name: 'shop', running: false }] } });

test('the branch view draws the trunk, a tip per worktree and today\'s merge as a loop, and opens the picked one\'s panes @area:devroom', async ({
  page,
  standalone,
}) => {
  test.slow();
  const repo = makeTempRepo();
  try {
    const folder = standalone.agentFolder('shop');
    repo.git(['clone', '-q', repo.remote, folder], repo.root);
    // A committer for the merge pre-check's dry run (the temp HOME has no git identity).
    repo.git(['config', 'user.name', 'Owner'], folder);
    repo.git(['config', 'user.email', 'owner@example.invalid'], folder);
    const ok = async (args: string[]) => {
      const r = await standalone.agty(args);
      expect(r.code, `agty ${args.join(' ')}: ${r.stdout}${r.stderr}`).toBe(0);
      return r.json as Record<string, any>;
    };
    const worktrees = () => {
      const list = repo.git(['worktree', 'list', '--porcelain'], folder).split('\n\n');
      return list.map((block) => block.match(/^worktree (.+)$/m)?.[1]).filter((p): p is string => !!p && p !== folder);
    };
    const commit = (wt: string, file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
      fs.writeFileSync(path.join(wt, file), `${text}\n`);
      repo.git(['add', '-A'], wt);
      repo.git(['commit', '-q', '-m', `feat(shop): ${file}`], wt);
    };
    await ok(['worker', 'add', 'shop', 'web-worker']);
    await ok(['task', 'add', FIRST, '--project', 'shop', '--assignee', 'web-worker', '--status', 'doing']);
    await ok(['worktree', 'new', '--task', 'T-1', '--assign', 'web-worker']);
    const [first] = worktrees();
    expect(first, 'the first worktree').toBeTruthy();
    commit(first, 'src/cart.ts', CART);
    await ok(['task', 'update', 'T-1', '--status', 'review']);
    await ok(['task', 'add', SECOND, '--project', 'shop', '--status', 'doing']);
    await ok(['worktree', 'new', '--task', 'T-2']);
    const second = worktrees().find((p) => p !== first);
    expect(second, 'the second worktree').toBeTruthy();
    commit(second!, 'src/search.ts', 'export const byScore = 1;');
    // Its stored history goes from review back to work: the tip wears the 검토에서 돌려보냄 badge.
    await ok(['task', 'update', 'T-2', '--status', 'review']);
    await ok(['task', 'update', 'T-2', '--status', 'doing']);

    await page.locator('[data-hud-id="icon:devroom"]').getByRole('button').click();
    const win = page.locator('[data-hud-window="devroom"]');
    await win.getByRole('button', { name: '보여 줄 프로젝트' }).click();
    await win.getByRole('menuitemradio', { name: 'shop' }).click();
    await expect(win.getByTestId('devroom-card')).toHaveCount(2, { timeout: 30_000 });

    // 브랜치 in the title bar's view switch takes the dev room: the trunk with the base's name, one tip per worktree.
    await expect(win.locator('[data-testid="devroom-view"]')).toHaveText(['이슈', '브랜치', '워크트리']);
    await win.locator('[data-testid="devroom-view"][data-view="branch"]').click();
    const view = win.getByTestId('devbranch');
    await expect(win.getByTestId('devroom-rail')).toHaveCount(0);
    await expect(view.getByTestId('devbranch-base')).toHaveText('main');
    await expect(view.getByTestId('devbranch-headline')).toContainText('main 옆에서 2곳을 고치고 있어요.');
    const tips = view.getByTestId('devbranch-tip');
    await expect(tips).toHaveCount(2);
    const tip = tips.filter({ hasText: FIRST });
    await expect(tip).toContainText('T-1');
    // The state phrases are the 이슈 view's (T-183): 검토 중, and 다시 고치는 중 with 검토에서 돌려보냄 after a return.
    await expect(tip.getByTestId('devbranch-state')).toHaveText('검토 중 · web-worker', { timeout: 30_000 });
    await expect(tips.filter({ hasText: SECOND }).getByTestId('devbranch-state')).toHaveText('다시 고치는 중');
    await expect(tip.getByTestId('devbranch-files')).toContainText('파일 1개', { timeout: 30_000 });
    await expect(tips.filter({ hasText: SECOND }).getByTestId('devbranch-returned')).toHaveText('검토에서 돌려보냄');
    await expect(tip.getByTestId('devbranch-returned')).toHaveCount(0);
    await expect(view.getByTestId('devbranch-loop')).toHaveCount(0);

    // Picking the tip opens its panel on 바뀐 것: the file with its line counts, then the review's own diff.
    await tip.click();
    const panel = view.getByTestId('devbranch-panel');
    await expect(panel.getByTestId('devbranch-info')).toContainText(FIRST);
    await expect(panel.getByTestId('devbranch-say')).toHaveText('검토를 기다려요. 통과하면 main 에 머지할 수 있어요.');
    await expect(panel.getByTestId('devbranch-file').filter({ hasText: 'cart.ts' })).toContainText('+1', { timeout: 30_000 });
    await panel.getByTestId('devbranch-show-diff').click();
    await expect(win.getByTestId('review-file-item').filter({ hasText: 'cart.ts' })).toBeVisible({ timeout: 30_000 });

    // 바뀐 것's merge button opens 검사 (the dev room's 머지 pane); merged there, the tip comes back as today's loop.
    await panel.getByRole('tab', { name: '바뀐 것' }).click();
    await panel.getByTestId('devbranch-merge').click();
    await expect(panel.locator('[data-testid="merge-check"][data-check="dirty"]')).toHaveAttribute('data-ok', 'true', { timeout: 30_000 });
    await panel.getByTestId('merge-go').click();
    await expect(tips).toHaveCount(1, { timeout: 30_000 });
    await expect(tips).toContainText(SECOND);
    const loop = view.getByTestId('devbranch-loop');
    await expect(loop).toHaveCount(1, { timeout: 30_000 });
    await expect(loop).toContainText(FIRST);
    await expect(loop).toContainText('T-1');
    await expect(loop).toContainText(/\d\d:\d\d 머지됨/);
    await expect(view.getByTestId('devbranch-headline')).toContainText('오늘 1개가 main 에 머지됐어요.');
    await tips.click();
    await expect(view.getByTestId('devbranch-file').filter({ hasText: 'search.ts' })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByTestId('devbranch-merge')).toBeEnabled({ timeout: 30_000 });
    // The mock-up's size (1440x900), the dev room maximized.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('hud-title-devroom').getByRole('button', { name: '최대화' }).click();
    await page.screenshot({ path: shot('desktop.png') });

    await page.setViewportSize({ width: 1024, height: 700 });
    await expect(tips).toHaveCount(1);
    await page.screenshot({ path: shot('desktop-1024x700.png') });

    // The switch is the way back: 워크트리 gives the rail and the panes their place again.
    await win.locator('[data-testid="devroom-view"][data-view="tree"]').click();
    await expect(view).toHaveCount(0);
    await expect(win.getByTestId('devroom-rail')).toBeVisible();

    // The phone: the same tips and loops as a list, then the picked one's panel.
    await page.setViewportSize({ width: 390, height: 844 });
    const phone = page.getByTestId('devroom-phone');
    await expect(phone).toBeVisible({ timeout: 15_000 });
    await phone.locator('[data-testid="devroom-view"][data-view="branch"]').click();
    await expect(phone.getByTestId('devbranch-tip')).toHaveCount(1);
    await expect(phone.getByTestId('devbranch-loop')).toHaveCount(1);
    await page.screenshot({ path: shot('phone.png') });
  } finally {
    repo.cleanup();
  }
});

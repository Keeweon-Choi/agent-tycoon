/**
 * T-99 flow 12: a Worker's finished work waits in the 개발실; the owner reviews its changes and merges it.
 * Nobody runs: the project, its Worker, the Task and the worktree's commit are state made with `agty`
 * and git before the page looks at them.
 */
import fs from 'node:fs';
import path from 'node:path';

import { makeTempRepo } from '../../../server/src/agent-tycoon/engine/git/testRepo';
import { expect, test } from '../../fixtures/standalone';

const TITLE = '장바구니 합계 분리';
const CART = 'export const sumPrice = (xs: number[]) => xs.reduce((a, b) => a + b, 0);';

test.use({ standaloneOptions: { agents: [{ name: 'shop', running: false }] } });

test('a Worker worktree waiting for review is read and merged in the dev room @area:devroom', async ({
  page,
  standalone,
}) => {
  test.slow();
  // The project folder: a clone of a temp repository (its bare remote is origin).
  const repo = makeTempRepo();
  try {
    const folder = standalone.agentFolder('shop');
    repo.git(['clone', '-q', repo.remote, folder], repo.root);
    const ok = async (args: string[]) => {
      const r = await standalone.agty(args);
      expect(r.code, `agty ${args.join(' ')}: ${r.stdout}${r.stderr}`).toBe(0);
      return r.json as Record<string, any>;
    };
    await ok(['worker', 'add', 'shop', 'web-worker']);
    const added = await ok([
      'task',
      'add',
      TITLE,
      '--project',
      'shop',
      '--assignee',
      'web-worker',
      '--status',
      'doing',
    ]);
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

    // The dev room, narrowed to shop.
    await page.locator('[data-hud-id="icon:devroom"]').getByRole('button').click();
    const win = page.locator('[data-hud-window="devroom"]');
    await win.getByRole('button', { name: '보여 줄 프로젝트' }).click();
    await win.getByRole('menuitemradio', { name: 'shop' }).click();
    await expect(win.getByTestId('hud-title-devroom')).toContainText('개발실 / shop');

    const cards = win.getByTestId('devroom-card');
    await expect(cards).toHaveCount(1, { timeout: 30_000 });
    const card = cards.filter({ hasText: TITLE });
    await expect(card.getByTestId('devroom-who')).toHaveText('web-worker');
    await expect(card.getByTestId('devroom-chip')).toHaveText('● 검토 대기', { timeout: 30_000 });

    // 변경: the file and its added line.
    await card.click();
    await win.getByRole('tab', { name: '변경' }).click();
    await expect(win.getByTestId('review-file-item').filter({ hasText: 'cart.ts' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(win.getByTestId('review-main').getByText(CART).first()).toBeVisible();

    // 머지: a green pre-check and the commit it makes.
    await win.getByRole('tab', { name: '머지' }).click();
    const check = (id: string) => win.locator(`[data-testid="merge-check"][data-check="${id}"]`);
    await expect(check('dirty')).toHaveAttribute('data-ok', 'true', { timeout: 30_000 });
    await expect(check('dirty')).toContainText('커밋하지 않은 변경이 없어요');
    await expect(check('behind')).toHaveAttribute('data-ok', 'true');
    await expect(win.getByTestId('merge-subject')).toContainText('앞으로 감기 · 커밋 1개');
    await expect(win.getByTestId('merge-subject')).toContainText('web-worker');
    await win.getByRole('button', { name: '머지', exact: true }).click();

    // Automatic cleanup: the card leaves the rail.
    await expect(cards).toHaveCount(0, { timeout: 30_000 });

    // 파일 on shop: src/cart.ts is on main now.
    await page.locator('[data-hud-id="icon:files"]').getByRole('button').click();
    const explorer = page.locator('section[aria-label="파일 탐색"]');
    await explorer
      .locator('button[aria-pressed]')
      .filter({ hasText: /^shop$/ })
      .click();
    const tree = explorer.locator('[aria-label$="파일 탐색기"]');
    await expect(tree.getByRole('button', { name: '파일을 볼 워크트리' })).toContainText('main');
    await tree.getByRole('button', { name: 'src', exact: true }).click();
    await expect(tree.getByRole('button', { name: 'cart.ts', exact: true })).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    repo.cleanup();
  }
});

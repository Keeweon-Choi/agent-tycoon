/**
 * T-182: the 현황판's 차례대로 확인하기. Two issues wait in 검토 (state made with `agty` and git before the
 * page looks): the first has a written check (device, steps, expected result, what was wrong and what
 * changed, two pictures) and a worktree branch git does not see merged, so its card says confirming also
 * merges it; it is confirmed and leaves the queue as done. The second has nothing written: its slots show
 * their quiet fallbacks and no merge sentence; 아직 이상해요 with one line puts it back to doing with that
 * line as its note and sends the project's Lead a message from the owner. On a phone the answers stay in a
 * bar above the dock while the card and the queue scroll.
 */
import fs from 'node:fs';
import path from 'node:path';

import { makeTempRepo } from '../../../server/src/agent-tycoon/engine/git/testRepo';
import { REPO_ROOT } from '../../../server/src/agent-tycoon/testHome';
import { expect, PHONE, test } from '../../fixtures/standalone';
import { openConversation } from '../../helpers/messenger';
import { ringOf } from '../../helpers/office';
import type { StandaloneSession } from '../../helpers/standalone';

const FIRST = '설정의 모델 목록';
const SECOND = '긴 답이 4000자에서 잘림';
const THIRD = '공지를 누가 받았는지';
const LINE = '아직도 3999자에서 끊겨요';
const shot = (name: string) => test.info().outputPath(name);
/** A press on a card in its first moment is ignored on purpose (CONFIRM_PRESS_GUARD_MS, 600): wait past it. */
const GUARD_MS = 700;
/** Two pictures for the check, as a lead would leave them in the project (any two PNGs of the repository). */
const PICTURES = ['agent-tycoon/artifacts/art-floor/05-floors-phone.png', 'agent-tycoon/artifacts/art-floor/04-floors-phone-open.png'];

async function agty(standalone: StandaloneSession, args: string[]) {
  const r = await standalone.agty(args);
  expect(r.code, `agty ${args.join(' ')}: ${r.stdout}${r.stderr}`).toBe(0);
  return r.json as Record<string, any>;
}

/** The pictures under `<folder>/shots/` (before, after). */
function leavePictures(folder: string): void {
  fs.mkdirSync(path.join(folder, 'shots'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, PICTURES[0]), path.join(folder, 'shots/before.png'));
  fs.copyFileSync(path.join(REPO_ROOT, PICTURES[1]), path.join(folder, 'shots/after.png'));
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 }, standaloneOptions: { agents: [{ name: 'shop' }] } });

  test('issues in review are confirmed one at a time; still wrong goes back to the lead @area:board', async ({
    page,
    standalone,
  }) => {
    test.slow();
    const repo = makeTempRepo();
    try {
      // The Lead's folder as a repository with one commit on main.
      const folder = standalone.agentFolder('shop');
      repo.git(['init', '-q', '-b', 'main'], folder);
      repo.git(['commit', '-q', '--allow-empty', '-m', 'init'], folder);
      repo.git(['branch', 'dev'], folder); // not protected: a Task worktree on it merges by itself when done
      leavePictures(folder);
      /** Task `id`'s worktree (from `base`) with one commit of `file`. */
      const worktreeWithCommit = async (id: string, file: string, base?: string) => {
        const made = await agty(standalone, ['worktree', 'new', '--task', id, ...(base ? ['--base', base] : [])]);
        expect(made.path, 'the worktree folder').toBeTruthy();
        fs.writeFileSync(path.join(made.path, file), `${id}\n`);
        repo.git(['add', '-A'], made.path);
        repo.git(['commit', '-q', '-m', `feat: ${id}`], made.path);
      };

      await agty(standalone, ['task', 'add', FIRST, '--project', 'shop', '--status', 'doing', '--detail', '설정 화면에 모델 목록을 넣었어요']);
      await agty(standalone, [
        'task', 'update', 'T-1',
        '--check-device', 'pc',
        '--check-step', '설정을 열어요',
        '--check-step', '모델 칸을 눌러요',
        '--check-expect', '모델 목록이 보이면 고쳐진 거예요',
        '--check-minutes', '1',
        '--check-problem', '설정에서 고를 수 있는 모델이 보이지 않았어요.',
        '--check-change', '설정 화면이 엔진에게 모델 목록을 받아 보여 줘요.',
        '--check-before', 'shots/before.png',
        '--check-after', 'shots/after.png',
      ]);
      // T-1's worktree is on main (protected): confirming does not merge it.
      await worktreeWithCommit('T-1', 'models.ts');
      await agty(standalone, ['task', 'update', 'T-1', '--status', 'review', '--tests-passed', 'yes']);
      await agty(standalone, ['task', 'add', SECOND, '--project', 'shop', '--status', 'doing']);
      await agty(standalone, ['task', 'update', 'T-2', '--status', 'review', '--note', '잘리던 곳을 고쳤어요']);
      // T-3's worktree is on dev: confirming merges it.
      await agty(standalone, ['task', 'add', THIRD, '--project', 'shop', '--status', 'doing', '--check-device', 'pc']);
      await worktreeWithCommit('T-3', 'notice.ts', 'dev');
      await agty(standalone, ['task', 'update', 'T-3', '--status', 'review']);

      // The 자동 복구 turn first: a message sent before idle only queues.
      await expect(await ringOf(page, 'shop')).toHaveAttribute('data-ring', 'idle', { timeout: 45_000 });

      await page.locator('[data-hud-id="icon:office"]').getByRole('button').click();
      const win = page.locator('[data-hud-window="office"]');
      await win.getByRole('button', { name: '최대화', exact: true }).click();
      await win.getByRole('button', { name: '요약', exact: true }).click();
      const entry = win.getByTestId('confirm-entry');
      await expect(entry).toHaveAttribute('data-count', '3', { timeout: 15_000 });
      await entry.getByTestId('confirm-start').click();

      // The first card: what was written, the facts with their source, and that confirming will not merge.
      const flow = win.getByTestId('confirm-flow');
      const card = flow.getByTestId('confirm-card');
      await expect(card).toHaveAttribute('data-task', 'T-1');
      await expect(flow.getByTestId('confirm-count')).toHaveText('확인 1 / 3');
      await expect(card.getByTestId('confirm-problem')).toContainText('보이지 않았어요');
      await expect(card.getByTestId('confirm-change')).toContainText('목록을 받아');
      await expect(card.getByTestId('confirm-steps')).toContainText('모델 칸을 눌러요');
      await expect(card.getByTestId('confirm-expect')).toContainText('모델 목록이 보이면');
      await expect(card.getByTestId('confirm-look')).toHaveAttribute('data-pictures', '2');
      await expect(card.getByTestId('confirm-look').locator('img')).toHaveCount(2, { timeout: 15_000 });
      await expect(card.getByTestId('confirm-tests')).toContainText('통과');
      await expect(card.getByTestId('confirm-branch')).toHaveAttribute('data-merged', 'false', { timeout: 30_000 });
      await expect(card.getByTestId('confirm-merge')).toHaveAttribute('data-merge', 'manual');
      await expect(card.getByTestId('confirm-merge')).toContainText('머지되지 않아요');
      await expect(card.getByTestId('confirm-yes')).toHaveText('확인했어요');
      await expect(flow.getByTestId('confirm-queue-row')).toHaveCount(3);
      // The pictures have loaded before the picture is taken.
      await expect
        .poll(() => card.getByTestId('confirm-look').locator('img').evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0)))
        .toBe(true);
      await page.screenshot({ path: shot('confirm-desktop.png') });

      // A double click confirms the issue on screen only: the next card (T-3, with a worktree) stays in review.
      // The guard reads the page's Date.now(), so the page's clock is held still across the presses: T-1's
      // card is then well past its first moment, T-3's appears at that same instant and stays in it however
      // long this machine takes in between (real time and the timers keep running; only Date.now() stops).
      const mainBefore = repo.git(['rev-parse', 'main'], folder).trim();
      const still = Date.now() + 2 * GUARD_MS;
      await page.clock.setFixedTime(still);
      await card.getByTestId('confirm-yes').dblclick();
      await expect(card).toHaveAttribute('data-task', 'T-3');
      await expect.poll(async () => (await agty(standalone, ['task', 'show', 'T-1'])).task?.status).toBe('done');
      // A slower double tap: the second press lands on the new card in its first moment and is ignored.
      await card.getByTestId('confirm-yes').click();
      await expect(flow.getByTestId('confirm-count')).toHaveText('확인 2 / 3');
      expect((await agty(standalone, ['task', 'show', 'T-3'])).task?.status).toBe('review');
      expect(repo.git(['rev-parse', 'main'], folder).trim()).toBe(mainBefore);
      // Time runs again (setSystemTime clears the fixed time), from no earlier than the held instant.
      await page.clock.setSystemTime(Math.max(Date.now(), still));

      // T-3: its branch merges by itself when done, and the card and the button say so.
      await expect(card.getByTestId('confirm-merge')).toHaveAttribute('data-merge', 'auto', { timeout: 30_000 });
      await expect(card.getByTestId('confirm-merge')).toContainText('dev에 머지해요');
      await expect(card.getByTestId('confirm-yes')).toHaveText(/머지도 해요/);
      await page.waitForTimeout(GUARD_MS);
      await card.getByTestId('confirm-yes').click();
      await expect.poll(() => repo.git(['ls-tree', '--name-only', 'dev'], folder), { timeout: 30_000 }).toContain('notice.ts');

      // The last card: nothing written, so each slot says so; no worktree, so no merge sentence.
      await expect(card).toHaveAttribute('data-task', 'T-2');
      await expect(flow.getByTestId('confirm-count')).toHaveText('확인 3 / 3');
      await expect(flow.locator('[data-testid="confirm-queue-row"][data-task="T-1"]')).toHaveAttribute('data-mark', 'done');
      await expect(card.getByTestId('confirm-branch')).toHaveAttribute('data-merged', 'none', { timeout: 30_000 });
      await expect(card.getByTestId('confirm-merge')).toHaveCount(0);
      await expect(card.getByTestId('confirm-yes')).toHaveText('확인했어요');
      await expect(card.getByTestId('confirm-problem')).toHaveAttribute('data-written', 'no');
      await expect(card.getByTestId('confirm-steps')).toHaveAttribute('data-written', 'no');
      await expect(card.getByTestId('confirm-look')).toHaveAttribute('data-pictures', '0');
      await expect(card.getByTestId('confirm-note')).toContainText('잘리던 곳을 고쳤어요');

      await card.getByTestId('confirm-no').click();
      await card.getByRole('textbox', { name: '무엇이 이상한가요' }).fill(LINE);
      await page.waitForTimeout(GUARD_MS);
      await card.getByRole('button', { name: '보내기', exact: true }).click();
      await expect(flow.getByTestId('confirm-finished')).toBeVisible();
      await expect
        .poll(async () => {
          const t = (await agty(standalone, ['task', 'show', 'T-2'])).task;
          return [t?.status, String(t?.history?.at(-1)?.by).startsWith('gui:')];
        })
        .toEqual(['doing', true]);
      // His line, stamped, in front of the lead's earlier note, which is still there.
      const note = String((await agty(standalone, ['task', 'show', 'T-2'])).task?.note);
      expect(note).toMatch(new RegExp(`^\\[사장님 확인 · [^\\]]+\\] ${LINE}\\n\\n잘리던 곳을 고쳤어요$`));

      // The Lead got it as the owner's own message, naming the issue (the maximized 현황판 covers the dock).
      await win.getByRole('button', { name: '현황판 닫기' }).click();
      const conv = await openConversation(page, 'shop');
      const sent = conv.locator('[data-from="boss"]', { hasText: LINE }).first();
      await expect(sent).toBeVisible({ timeout: 15_000 });
      await expect(sent).toContainText('T-2');
      // Only his words and the id: the title an agent wrote does not travel as the owner's message.
      await expect(sent).not.toContainText(SECOND);
    } finally {
      repo.cleanup();
    }
  });
});

test.describe('phone', () => {
  test.use({ ...PHONE, standaloneOptions: { agents: [{ name: 'shop', running: false }] } });

  test('on a phone the answers stay above the dock while the card and the queue scroll @area:board', async ({ page, standalone }) => {
    leavePictures(standalone.agentFolder('shop'));
    await agty(standalone, ['task', 'add', '폰 터미널의 Face ID 단추', '--project', 'shop', '--status', 'doing']);
    await agty(standalone, [
      'task', 'update', 'T-1',
      '--status', 'review',
      '--tests-passed', 'yes',
      '--check-device', 'phone',
      '--check-step', '폰에서 메신저의 터미널을 열어요',
      '--check-step', "'Face ID로 확인'을 눌러요",
      '--check-expect', '패스키 창이 바로 뜨면 고쳐진 거예요',
      '--check-minutes', '1',
      '--check-problem', "'Face ID로 확인'을 눌러도 패스키 창이 뜨지 않았어요.",
      '--check-change', '단추를 누르면 그 자리에서 바로 패스키 창을 열게 했어요.',
      '--check-before', 'shots/before.png',
      '--check-after', 'shots/after.png',
    ]);
    await agty(standalone, ['task', 'add', '긴 답이 4000자에서 잘림', '--project', 'shop', '--status', 'review', '--check-device', 'phone']);
    await agty(standalone, ['task', 'add', '설정의 모델 목록', '--project', 'shop', '--status', 'review', '--check-device', 'pc']);
    await page.locator('[data-dock="board"]').tap();
    const entry = page.getByTestId('confirm-entry');
    await expect(entry).toHaveAttribute('data-count', '3', { timeout: 15_000 });
    await entry.getByTestId('confirm-start').tap();
    const card = page.getByTestId('confirm-card');
    await expect(card).toHaveAttribute('data-task', 'T-1');
    const bar = page.getByTestId('confirm-answers-bar');
    await expect(bar).toBeInViewport();
    await expect(card.getByTestId('confirm-answers-card')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect
      .poll(() => card.getByTestId('confirm-look').locator('img').evaluateAll((imgs) => imgs.length === 2 && imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0)))
      .toBe(true);
    await page.screenshot({ path: shot('confirm-phone.png') });
    // The queue under the card; the answers are still at the thumb.
    await page.getByTestId('confirm-queue').scrollIntoViewIfNeeded();
    await expect(bar).toBeInViewport();
    await page.screenshot({ path: shot('confirm-phone-queue.png') });
  });
});

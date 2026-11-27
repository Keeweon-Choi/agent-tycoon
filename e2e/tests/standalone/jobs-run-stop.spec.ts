/**
 * T-99 flow 9: a job an agent started from its folder shows on the 현황판, reads its log and
 * stops on the user's word. The jobs are started with the fixture's `agty()` in alpha's folder,
 * as the agent's own shell would (lead decision 2: no `.run` verb in the mock).
 */
import { openOfficeWindow } from '../../../server/src/agent-tycoon/testHome';
import { expect, test } from '../../fixtures/standalone';

const DESC = '모델 학습';
/** 60 s of tqdm-style progress lines, each redrawn in place with \r. */
const TRAIN = `for i in $(seq 1 300); do printf '\\rtrain:  %d%%|█▌ | %d/300 [00:0%d<00:30, 9.5it/s]' $((i/3)) $i $((i%10)); sleep 0.2; done; echo; echo finished`;

test.use({ standaloneOptions: { agents: [{ name: 'alpha', running: false }] } });

test('a job an agent started shows its progress and log, and stops when asked @area:jobs', async ({
  page,
  standalone,
}) => {
  const cwd = standalone.agentFolder('alpha');
  const long = await standalone.agty(['job', '-d', DESC, TRAIN], { cwd });
  expect(long.code, long.stderr).toBe(0);
  const short = await standalone.agty(['job', 'echo hello; exit 3'], { cwd });
  expect(short.code, short.stderr).toBe(0);

  // The 현황판's 실행 tab lists every job, narrowed here to alpha's.
  await openOfficeWindow(page);
  const win = page.locator('[data-hud-window="office"]');
  await win.getByRole('button', { name: '실행', exact: true }).click();
  await win.getByRole('combobox', { name: '실행을 볼 프로젝트' }).selectOption('alpha');

  const card = win.getByTestId('job-card').filter({ hasText: DESC });
  await expect(card.getByTestId('job-what')).toHaveText(DESC);
  await expect(card).toContainText('alpha · 엔진');
  await expect(card).not.toContainText('seq 1 300'); // named by -d, not by its command
  await expect(card).not.toContainText(String((long.json as { pid?: number }).pid));
  // The progress refresh (10 s) reads the percentage and the rate from the log.
  await expect(card).toContainText(/[1-9]\d*% · 9\.5it\/s/, { timeout: 25_000 });

  await card.getByRole('button', { name: /로그/ }).click();
  await expect(card.getByTestId('job-digest')).toBeVisible();
  await card.getByRole('button', { name: '원본 로그' }).click();
  const raw = card.locator('pre');
  await expect(raw).toContainText('train:');
  const trainLines = async () =>
    ((await raw.textContent()) ?? '').split('\n').filter((l) => l.includes('train:')).length;
  expect(await trainLines()).toBe(1); // each \r-redrawn line once

  await card.getByRole('button', { name: '멈추기', exact: true }).click();
  const ask = card.getByRole('alertdialog');
  await expect(ask).toContainText('작업을 멈출까요?');
  await ask.getByRole('button', { name: '멈추기', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '작업을 멈췄어요' })).toBeVisible();
  await expect(card).toContainText('멈춤(사용자가 멈춤)');

  const failed = win.getByTestId('job-card').filter({ hasText: 'echo 작업' });
  // Its state in words (실패), not as a code; the GAME OVER banner (GAME-UI-1) may still name the exit code.
  await expect(failed).toContainText(/실패 · /);
  await expect(failed).not.toContainText('종료 코드');

  await page.locator('[data-testid="notice-bell"], [data-testid="cc-seg-notices"]').first().click();
  const notices = page.getByTestId('notice-list');
  await expect(notices.getByText(`${DESC}이 멈췄어요`).first()).toBeVisible();
  await expect(notices.getByText('echo 작업이 실패했어요').first()).toBeVisible();
});

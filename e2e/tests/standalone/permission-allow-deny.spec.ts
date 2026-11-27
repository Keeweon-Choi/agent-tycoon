/**
 * T-99 flow 3: a permission request reaches the owner as a card in the messenger and is answered with its
 * buttons only (keys do nothing), allow then deny; the session's own --settings hook gets the answer.
 */
import { expect, test } from '../../fixtures/standalone';
import { permissionRequest } from '../../helpers/hooks';
import { openConversation, sendMessage } from '../../helpers/messenger';
import { claudeScenario } from '../../helpers/mock-claude';
import { ringOf } from '../../helpers/office';
import {
  buildAssistantTextRecord,
  buildAssistantToolUseRecord,
  buildTurnDurationRecord,
  buildUserToolResultRecord,
} from '../../helpers/team';

const DEPLOY = { command: 'npm run deploy -- --prod', description: '운영 배포' };

test.use({
  standaloneOptions: {
    agents: [{ name: 'alpha' }],
    scenarios: [
      claudeScenario('deploy turn')
        .forAgent('alpha')
        .onPrompt('배포')
        .at(300)
        .appendJsonl(buildAssistantToolUseRecord('tu-deploy', 'Bash', DEPLOY))
        .at(400)
        .emitHook(permissionRequest('{{sessionId}}', 'Bash', DEPLOY)) // waits for 허용 / 거부
        .at(600)
        .appendJsonl(buildUserToolResultRecord('tu-deploy', '{{permission}}'))
        .at(700)
        .appendJsonl(buildAssistantTextRecord('권한 결과: {{permission}}'))
        .at(800)
        .appendJsonl(buildTurnDurationRecord())
        .build(),
    ],
  },
});

test('a permission card is answered with 허용 and 거부, never with keys @area:messenger', async ({
  page,
  standalone,
}) => {
  expect(standalone.port).not.toBe(18240); // requesting the fixture is what starts the daemon
  const ring = await ringOf(page, 'alpha');
  // The engine's own 자동 복구 turn first: a message sent before it ends only waits in the queue.
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 30_000 });
  const conv = await openConversation(page, 'alpha');
  await page.waitForTimeout(4_000); // past RESYNC_QUIET_MS: a notice in it is history, not news

  // ── 허용 ──
  await sendMessage(page, 'alpha', '배포해 줘');
  const card = conv.getByTestId('permission-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  const call = card.getByTestId('permission-call');
  for (const part of ['Bash', DEPLOY.description, DEPLOY.command])
    await expect(call).toContainText(part, { timeout: 15_000 });
  await expect(card.getByRole('button', { name: '허용', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '거부', exact: true })).toBeVisible();

  await expect(ring).toHaveAttribute('data-ring', 'permission', { timeout: 15_000 });
  await expect(page.getByTestId('party-waiting')).toHaveAttribute('data-count', '1');
  await page.locator('[data-testid="notice-bell"], [data-testid="cc-seg-notices"]').first().click();
  await expect(
    page
      .getByTestId('notice-item')
      .filter({ hasText: '허락을 기다려요' })
      .filter({ hasText: 'alpha' })
      .first(),
  ).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');

  // Keys outside any field answer nothing (a letter typed elsewhere must never become an allow).
  await call.click();
  for (const key of ['y', '1', 'Enter']) await page.keyboard.press(key);
  await page.waitForTimeout(1_000); // settle before the negative assertion
  await expect(card.getByRole('button', { name: '허용', exact: true })).toBeEnabled();
  await expect(conv.getByText('권한 결과:')).toHaveCount(0);

  await card.getByRole('button', { name: '허용', exact: true }).click();
  await expect(conv.getByTestId('quest-record').filter({ hasText: '허용함' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(conv.getByText('권한 결과: allow').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('party-waiting')).toHaveCount(0, { timeout: 15_000 });
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 15_000 });

  // ── 거부 ──
  await sendMessage(page, 'alpha', '배포 한 번 더');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('permission-call')).toContainText(DEPLOY.command, {
    timeout: 15_000,
  });
  // A message sent while the card is up waits, and says why.
  await sendMessage(page, 'alpha', '메모 하나 남길게');
  const queued = conv.getByTestId('pending').filter({ hasText: '보냄(대기 중)' });
  await expect(queued).toContainText('확인 창에 먼저 답해 주세요', { timeout: 15_000 });
  await card.getByRole('button', { name: '거부', exact: true }).click();
  await expect(conv.getByTestId('quest-record').filter({ hasText: '거부함' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(conv.getByText('권한 결과: deny').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('party-waiting')).toHaveCount(0, { timeout: 15_000 });
  // ...and goes in once the turn the answer let finish is over.
  await expect(queued).toHaveCount(0, { timeout: 30_000 });
  await expect(conv.getByText('메모 하나 남길게').first()).toBeVisible();
});

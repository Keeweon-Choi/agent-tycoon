/**
 * T-99 flow 2: send a direct message to an engine agent and read its reply. The turn shows on
 * the contact, the nameplate and in the conversation; a reply to a closed conversation is
 * unread until it is opened; both exchanges survive a reload.
 */
import type { Locator, Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { openConversation, openMessenger, sendMessage } from '../../helpers/messenger';
import { claudeScenario } from '../../helpers/mock-claude';
import { nameplateOf, ringOf } from '../../helpers/office';
import {
  buildAssistantTextRecord,
  buildAssistantToolUseRecord,
  buildTurnDurationRecord,
  buildUserToolResultRecord,
} from '../../helpers/team';

const BUILD = { command: 'npm run build', description: '전체 빌드' };
const FIRST = '빌드 돌려 줘';
const FIRST_REPLY = '빌드 끝났어요. 경고는 없어요.';
const SECOND = '한 번 더 돌려 줘';
const SECOND_REPLY = '다시 돌렸어요. 이번에도 깨끗해요.';

test.use({
  standaloneOptions: {
    agents: [{ name: 'alpha' }],
    scenarios: [
      claudeScenario('dm turn')
        .forAgent('alpha')
        .onPrompt('빌드')
        .at(300)
        .appendJsonl(buildAssistantToolUseRecord('tu-build', 'Bash', BUILD))
        // Open 3 s: long enough to be seen (500 ms poll), short of the 7 s permission guess.
        .at(3_300)
        .appendJsonl(buildUserToolResultRecord('tu-build', 'built'))
        .at(3_500)
        .appendJsonl(buildAssistantTextRecord(FIRST_REPLY))
        .at(3_600)
        .appendJsonl(buildTurnDurationRecord())
        .onPrompt('한 번 더')
        .at(4_000)
        .appendJsonl(buildAssistantTextRecord(SECOND_REPLY))
        .build(),
    ],
  },
});

const contactOf = (messenger: Locator, name: string) =>
  messenger
    .getByRole('list', { name: '연락처' })
    .getByRole('button', { name: new RegExp(`^${name}`) });

/** My bubble holding `text` (after the transcript confirmed it). */
const mine = (conv: Locator, text: string) =>
  conv.locator('[data-from="boss"]', { hasText: text }).first();

async function expectBothExchanges(page: Page): Promise<void> {
  const conv = await openConversation(page, 'alpha');
  await expect(mine(conv, FIRST)).toBeVisible({ timeout: 15_000 });
  await expect(conv.getByText(FIRST_REPLY).first()).toBeVisible();
  await expect(mine(conv, SECOND)).toBeVisible();
  await expect(conv.getByText(SECOND_REPLY).first()).toBeVisible();
}

test('a direct message reaches the agent, its turn shows, the reply is read and kept @area:messenger', async ({
  page,
  standalone,
}) => {
  expect(standalone.port).not.toBe(18240); // the fixture starts the daemon only when asked for
  const ring = await ringOf(page, 'alpha');
  // Selected (its party portrait), the nameplate adds its activity line, the tool status as title.
  await page.locator('[data-testid="agent-card"][title="alpha"]').first().click();
  const activity = nameplateOf(page, 'alpha').getByTestId('plate-activity');
  await expect(activity).toBeVisible({ timeout: 10_000 });
  const messenger = await openMessenger(page);
  const contact = contactOf(messenger, 'alpha');
  // The engine's own recovery prompt is a turn too: wait it out, or the message is queued.
  await expect(contact.getByTitle('쉼')).toBeVisible({ timeout: 45_000 });
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 15_000 });

  // First exchange: a tool turn.
  const conv = await sendMessage(page, 'alpha', FIRST);
  // 보내는 중… / 보냄 last only until the transcript confirms the prompt (often under a poll), so
  // the lasting signal is asserted: my bubble with 받음.
  await expect(mine(conv, FIRST).getByText('받음')).toBeVisible({ timeout: 15_000 });

  await expect(contact.getByTitle('일하는 중')).toBeVisible({ timeout: 15_000 });
  await expect(ring).toHaveAttribute('data-ring', 'working');
  await expect(activity).toHaveAttribute('title', 'Running: npm run build');
  await expect(conv.locator('summary', { hasText: '전체 빌드' })).toBeVisible();

  await expect(conv.getByText(FIRST_REPLY).first()).toBeVisible({ timeout: 15_000 });
  await expect(contact.getByTitle('쉼')).toBeVisible({ timeout: 15_000 });
  await expect(ring).toHaveAttribute('data-ring', 'idle');

  // Second exchange: the reply lands while the conversation is closed.
  await sendMessage(page, 'alpha', SECOND);
  await messenger
    .getByRole('navigation', { name: '열린 대화' })
    .getByRole('button', { name: 'alpha 대화 닫기' })
    .click();
  await expect(conv).toBeHidden();
  await expect(messenger.getByRole('button', { name: 'alpha 안 읽음 1' })).toBeVisible({
    timeout: 20_000,
  });
  const dockUnread = page.getByRole('button', { name: '메신저 (안 읽음 1)' });
  await expect(dockUnread).toBeVisible();
  await expect(page.getByTestId('messenger-unread')).toHaveText('1');

  const reopened = await openConversation(page, 'alpha');
  await expect(reopened.getByText(SECOND_REPLY).first()).toBeVisible();
  await expect(messenger.getByRole('button', { name: 'alpha', exact: true })).toBeVisible();
  await expect(dockUnread).toHaveCount(0);
  await expect(page.getByTestId('messenger-unread')).toHaveCount(0);

  // A reload keeps both exchanges.
  await page.reload();
  await expectBothExchanges(page);
});

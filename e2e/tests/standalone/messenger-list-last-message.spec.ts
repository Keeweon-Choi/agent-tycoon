/**
 * T-186: the list of conversations goes by each conversation's last message, the agent on or off. alpha
 * answers first, beta later; beta is then stopped. Its row keeps its reply and the time, never the empty
 * preview, and stays above alpha, which runs with the older reply.
 */
import { engineButton } from '../../../agent-tycoon/test/engineRow';
import { expect, test } from '../../fixtures/standalone';
import { openMessenger, sendMessage } from '../../helpers/messenger';
import { claudeScenario } from '../../helpers/mock-claude';
import { ringOf } from '../../helpers/office';
import { buildAssistantTextRecord, buildTurnDurationRecord } from '../../helpers/team';

const ALPHA_REPLY = '알파가 먼저 답했어요.';
const BETA_REPLY = '베타가 나중에 답했어요.';

const reply = (agent: string, text: string) =>
  claudeScenario(`${agent} reply`)
    .forAgent(agent)
    .onPrompt('답해 줘')
    .at(300)
    .appendJsonl(buildAssistantTextRecord(text))
    .at(400)
    .appendJsonl(buildTurnDurationRecord())
    .build();

test.use({
  standaloneOptions: {
    agents: [{ name: 'alpha' }, { name: 'beta' }],
    scenarios: [reply('alpha', ALPHA_REPLY), reply('beta', BETA_REPLY)],
  },
});

test('a stopped agent keeps its last message and time in the list, which is ordered by it @area:messenger', async ({
  page,
  standalone,
}) => {
  expect(standalone.port).not.toBe(18240); // a daemon of our own, never the real one
  for (const name of ['alpha', 'beta'])
    await expect(await ringOf(page, name)).toHaveAttribute('data-ring', 'idle', { timeout: 45_000 });
  const alpha = await sendMessage(page, 'alpha', '답해 줘');
  await expect(alpha.getByText(ALPHA_REPLY).first()).toBeVisible({ timeout: 20_000 });
  const beta = await sendMessage(page, 'beta', '답해 줘');
  await expect(beta.getByText(BETA_REPLY).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '메신저 닫기', exact: true }).click(); // its window lies over the card

  // beta is stopped: its conversation is still its last session's.
  const dialog = page.getByRole('alertdialog');
  await (await engineButton(page, 'beta', '끄기')).click();
  await dialog.getByRole('button', { name: '끄기', exact: true }).click();
  await expect(await engineButton(page, 'beta', '켜기')).toBeVisible({ timeout: 15_000 });

  const contacts = (await openMessenger(page)).getByRole('list', { name: '연락처' });
  const row = (name: string) => contacts.locator('li', { has: page.getByText(name, { exact: true }) });
  await expect(row('beta')).toContainText(BETA_REPLY, { timeout: 15_000 });
  await expect(row('beta')).toContainText(/\d\d:\d\d/);
  await expect(row('beta')).not.toContainText('대화 없음');
  await expect(row('alpha')).toContainText(ALPHA_REPLY);
  // Newest last message first: the stopped beta above the running alpha.
  await expect(contacts.locator('li strong')).toHaveText(['beta', 'alpha']);
  await contacts.screenshot({ path: test.info().outputPath('t186-list.png') });
});

/**
 * T-99 P1 + P2 smoke: the office of today (engine on, the HUD) with one seeded engine agent whose
 * session plays a claudeScenario turn when the messenger's message reaches it.
 */
import { expect, test } from '../../fixtures/standalone';
import { sendMessage } from '../../helpers/messenger';
import { claudeScenario } from '../../helpers/mock-claude';
import { nameplateOf, ringOf } from '../../helpers/office';
import {
  buildAssistantTextRecord,
  buildAssistantToolUseRecord,
  buildTurnDurationRecord,
  buildUserToolResultRecord,
} from '../../helpers/team';

const BUILD = { command: 'npm run build', description: '전체 빌드' };

test.use({
  standaloneOptions: {
    agents: [{ name: 'alpha' }],
    scenarios: [
      claudeScenario('smoke turn')
        .forAgent('alpha')
        .onPrompt('빌드')
        .at(300)
        .appendJsonl(buildAssistantToolUseRecord('tu-build', 'Bash', BUILD))
        .at(3_300)
        .appendJsonl(buildUserToolResultRecord('tu-build', 'built'))
        .at(3_500)
        .appendJsonl(buildAssistantTextRecord('빌드 끝났어요. 경고는 없어요.'))
        .at(3_600)
        .appendJsonl(buildTurnDurationRecord())
        .build(),
    ],
  },
});

test('a seeded engine agent works through a scenario turn and answers @area:office', async ({
  page,
  standalone,
}) => {
  expect(standalone.port).not.toBe(18240);
  await expect(page.getByTestId('hud-menu')).toBeVisible(); // the HUD, not the plain office
  await expect(nameplateOf(page, 'alpha')).toBeVisible({ timeout: 30_000 });
  const ring = await ringOf(page, 'alpha');
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 30_000 });

  const conv = await sendMessage(page, 'alpha', '빌드 돌려 줘');
  await expect(ring).toHaveAttribute('data-ring', 'working', { timeout: 30_000 });
  // .first(): the conversation also reads each new line out in an sr-only copy.
  await expect(conv.getByText('빌드 끝났어요. 경고는 없어요.').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 15_000 });
});

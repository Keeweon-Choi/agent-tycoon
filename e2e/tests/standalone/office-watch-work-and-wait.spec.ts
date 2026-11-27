/**
 * T-99 flow 4: from the office, watch an agent work (its tool, its portrait), hand work to two sub-agents
 * and wait on its question; answer it from the conversation and see it rest again.
 */
import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { openConversation, sendMessage } from '../../helpers/messenger';
import { claudeScenario } from '../../helpers/mock-claude';
import { getAgentOverlays, nameplateOf, ringOf } from '../../helpers/office';
import {
  buildAssistantTextRecord,
  buildAssistantToolUseBatchRecord,
  buildAssistantToolUseRecord,
  buildTurnDurationRecord,
  buildUserToolResultBatchRecord,
  buildUserToolResultRecord,
} from '../../helpers/team';

const QUESTION = '테스트는 통과했어요. 배포할까요?';
const ANSWER = '배포를 시작했어요.';

/** A sub-agent's line in the Lead's own transcript (the shape of run-devroom.ts sub()). */
const sub = (parent: string, message: Record<string, unknown>) => ({
  type: 'progress',
  parentToolUseID: parent,
  data: { type: 'agent_progress', message },
});

test.use({
  standaloneOptions: {
    agents: [{ name: 'alpha' }],
    scenarios: [
      claudeScenario('work and wait')
        .forAgent('alpha')
        .onPrompt('테스트')
        // npm test open 2.5 s: long enough to be seen (500 ms polling), short of the 7 s permission guess.
        .at(300)
        .appendJsonl(buildAssistantToolUseRecord('tu-npm', 'Bash', { command: 'npm test' }))
        .at(2_800)
        .appendJsonl(buildUserToolResultRecord('tu-npm', '42 passed'))
        .at(3_000)
        .appendJsonl(
          buildAssistantToolUseBatchRecord([
            {
              toolId: 'tu-unit',
              toolName: 'Task',
              input: { description: '단위 테스트', prompt: 'run the unit tests' },
            },
            {
              toolId: 'tu-tsc',
              toolName: 'Task',
              input: { description: '타입 검사', prompt: 'tsc --noEmit' },
            },
          ]),
        )
        .at(3_200)
        .appendJsonl(
          sub(
            'tu-unit',
            buildAssistantToolUseRecord('tu-unit-1', 'Bash', { command: 'npm test -- unit' }),
          ),
        )
        .at(3_300)
        .appendJsonl(
          sub(
            'tu-tsc',
            buildAssistantToolUseRecord('tu-tsc-1', 'Bash', { command: 'tsc --noEmit' }),
          ),
        )
        // Each sub-tool open under 5 s.
        .at(7_000)
        .appendJsonl(sub('tu-unit', buildUserToolResultRecord('tu-unit-1', '30 passed')))
        .at(7_100)
        .appendJsonl(sub('tu-tsc', buildUserToolResultRecord('tu-tsc-1', 'no errors')))
        .at(7_500)
        .appendJsonl(
          buildUserToolResultBatchRecord([
            { toolUseId: 'tu-unit', content: 'unit tests pass' },
            { toolUseId: 'tu-tsc', content: 'types check' },
          ]),
        )
        .at(7_800)
        .appendJsonl(buildAssistantTextRecord(QUESTION))
        .at(7_900)
        .appendJsonl(buildTurnDurationRecord())
        .onPrompt('진행')
        .at(300)
        .appendJsonl(buildAssistantTextRecord(ANSWER))
        .build(),
    ],
  },
});

const portraitOf = (page: Page, name: string) =>
  page.locator(`[data-testid="agent-card"][title="${name}"]`).first();

test('watch an agent work, hand work to sub-agents and wait for an answer @area:office', async ({
  page,
  standalone,
}) => {
  expect(standalone.port).not.toBe(18240); // never the real daemon
  const plate = nameplateOf(page, 'alpha');
  await expect(plate).toBeVisible({ timeout: 30_000 }); // a started agent may take the 30 s poll to appear
  const ring = await ringOf(page, 'alpha');
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 30_000 }); // its 자동 복구 turn is over
  const portrait = portraitOf(page, 'alpha');

  // The portrait selects alpha: its nameplate is marked and its member card opens; 메시지 opens the conversation.
  const id = await portrait.getAttribute('data-agent-id');
  const card = page.locator(`[data-testid="inspector"][data-agent-id="${id}"]`);
  await portrait.click();
  await expect(card).toBeVisible();
  await expect(card.getByTestId('inspector-name')).toHaveText('alpha');
  await expect(page.locator(`[data-nameplate][data-agent-id="${id}"]`)).toHaveAttribute(
    'data-selected',
    'true',
  );
  await card.getByRole('button', { name: '메시지', exact: true }).click();
  const conv = page.getByRole('region', { name: 'alpha 대화' });
  await expect(conv).toBeVisible();

  await sendMessage(page, 'alpha', '테스트 돌려 줘');
  // Back to the office (the dock's 사무실) to watch.
  await page.locator('[data-hud-id="icon:home"] button').click();
  await expect(conv).toBeHidden();

  await expect(ring).toHaveAttribute('data-ring', 'working', { timeout: 30_000 });
  await expect(plate.getByTitle('Running: npm test', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(portrait).toHaveAttribute('data-state', 'work');

  // Two sub-agents come in: two more nameplates with negative ids, and +2 on alpha's portrait.
  await expect
    .poll(
      async () =>
        (
          await getAgentOverlays(page).evaluateAll((els) =>
            els.map((e) => Number(e.getAttribute('data-agent-id'))),
          )
        ).filter((n) => n < 0).length,
      { timeout: 15_000 },
    )
    .toBe(2);
  await expect(portrait.locator('.game-portrait-temps')).toHaveText('+2');

  // The turn ends on a question: alpha waits on the owner.
  await expect(page.getByTestId('party-waiting')).toHaveAttribute('data-count', '1', {
    timeout: 30_000,
  });
  await expect(portrait).toHaveAttribute('data-state', 'ask');
  await expect(ring).toHaveAttribute('data-ring', 'waiting');

  const reopened = await openConversation(page, 'alpha');
  const question = reopened.getByTestId('question-card');
  await expect(question.getByTestId('question-request')).toContainText('배포할까요?');

  await sendMessage(page, 'alpha', '네, 진행해');
  await expect(reopened.getByText(ANSWER).first()).toBeVisible({ timeout: 30_000 });
  await expect(question).toHaveCount(0);
  await expect(page.getByTestId('party-waiting')).toHaveCount(0);
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 20_000 });
});

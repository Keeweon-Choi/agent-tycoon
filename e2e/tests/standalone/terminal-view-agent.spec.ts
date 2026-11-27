/**
 * T-99 flow 14: open an agent's own terminal from its conversation. The screen is the engine fake's
 * live session (selectors of agent-tycoon/test/run-pty-agent.ts step 2); closing the tab leaves the
 * agent running. The page reads xterm's DOM rows: the fixture pins agty.terminal-renderer = dom.
 */
import { expect, test } from '../../fixtures/standalone';
import { openConversation, sendMessage } from '../../helpers/messenger';
import { claudeScenario } from '../../helpers/mock-claude';
import { nameplateOf, ringOf } from '../../helpers/office';
import {
  buildAssistantTextRecord,
  buildAssistantToolUseRecord,
  buildTurnDurationRecord,
  buildUserToolResultRecord,
} from '../../helpers/team';

const BUILD = { command: 'npm run build', description: '전체 빌드' };
const REPLY = '빌드 끝났어요. 경고는 없어요.';
const AGAIN_REPLY = '한 번 더 했어요.';

test.use({
  standaloneOptions: {
    agents: [{ name: 'alpha' }],
    scenarios: [
      claudeScenario('dm turn')
        .forAgent('alpha')
        .onPrompt('빌드')
        .at(300)
        .appendJsonl(buildAssistantToolUseRecord('tu-build', 'Bash', BUILD))
        .at(3_300)
        .appendJsonl(buildUserToolResultRecord('tu-build', 'built'))
        .at(3_500)
        .appendJsonl(buildAssistantTextRecord(REPLY))
        .at(3_600)
        .appendJsonl(buildTurnDurationRecord())
        .onPrompt('한 번 더')
        .at(500)
        .appendJsonl(buildAssistantTextRecord(AGAIN_REPLY))
        .at(600)
        .appendJsonl(buildTurnDurationRecord())
        .build(),
    ],
  },
});

test("the conversation opens the agent's own live terminal; closing the tab leaves it running @area:terminal", async ({
  page,
  standalone,
}) => {
  expect(standalone.port).not.toBe(18240); // asking for the fixture is what starts the daemon
  await expect(nameplateOf(page, 'alpha')).toBeVisible({ timeout: 30_000 });
  const ring = await ringOf(page, 'alpha');
  // Past the engine's 자동 복구 turn, so the first message is not queued.
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 30_000 });

  const conv = await openConversation(page, 'alpha');
  await conv.getByRole('button', { name: '터미널로 보기' }).click();

  const terminal = page.locator('[data-hud-window="terminal"]');
  await expect(terminal).toBeVisible();
  const tab = terminal.getByRole('tab', { name: /alpha/ });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await tab.click({ trial: true }); // in front: nothing covers its tab
  const screen = terminal.locator('.xterm-rows');
  await expect(screen).toContainText('fake Claude Code (pty) · alpha', { timeout: 15_000 });

  // Live, not a picture: the prompt sent from the messenger shows up on the screen.
  await sendMessage(page, 'alpha', '빌드 돌려 줘');
  await expect(screen).toContainText('빌드 돌려 줘', { timeout: 30_000 });
  await expect(conv.getByText(REPLY).first()).toBeVisible({ timeout: 30_000 });
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 15_000 });

  await terminal.getByRole('button', { name: 'alpha 터미널 닫기' }).click();
  await expect(tab).toHaveCount(0);

  // The agent lived on: the next message still gets its reply.
  await sendMessage(page, 'alpha', '한 번 더 해 줘');
  await expect(conv.getByText(AGAIN_REPLY).first()).toBeVisible({ timeout: 30_000 });
});

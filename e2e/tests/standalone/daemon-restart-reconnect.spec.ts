/**
 * T-99 flow 7: the daemon restarts on the same home and port while the page is open. The page
 * reconnects by itself, the open conversation and its unsent draft are still there, and the agent
 * (alive in the PTY host the whole time) answers the draft once it is sent.
 */
import { expect, test } from '../../fixtures/standalone';
import { openMessenger, sendMessage } from '../../helpers/messenger';
import { claudeScenario } from '../../helpers/mock-claude';
import { getAgentOverlays, nameplateOf, ringOf } from '../../helpers/office';
import {
  buildAssistantTextRecord,
  buildAssistantToolUseRecord,
  buildTurnDurationRecord,
  buildUserToolResultRecord,
} from '../../helpers/team';

const BUILD = { command: 'npm run build', description: '전체 빌드' };
const FIRST_REPLY = '빌드 끝났어요. 경고는 없어요.';
const DRAFT = '빌드 한 번 더 돌려 줘';
const BADGE = /Reconnecting|Disconnected/;
const RECONNECT_MS = 15_000;

test.use({
  standaloneOptions: {
    agents: [{ name: 'alpha' }],
    scenarios: [
      // `dm turn` of the plan: the session survives the restart, so its scenario does.
      claudeScenario('dm turn')
        .forAgent('alpha')
        .onPrompt('빌드')
        .at(300)
        .appendJsonl(buildAssistantToolUseRecord('tu-build', 'Bash', BUILD))
        .at(2_300)
        .appendJsonl(buildUserToolResultRecord('tu-build', 'built'))
        .at(2_500)
        .appendJsonl(buildAssistantTextRecord(FIRST_REPLY))
        .at(2_600)
        .appendJsonl(buildTurnDurationRecord())
        .build(),
    ],
  },
});

test('the daemon restarts and the page, the agent and the draft are still there @area:office', async ({
  page,
  standalone,
}) => {
  const ring = await ringOf(page, 'alpha');
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 30_000 });

  const conv = await sendMessage(page, 'alpha', '빌드 돌려 줘');
  // .first(): the conversation also reads each new line out in an sr-only copy.
  await expect(conv.getByText(FIRST_REPLY).first()).toBeVisible({ timeout: 30_000 });
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 15_000 });

  const box = conv.getByRole('textbox', { name: '보낼 글' });
  await box.fill(DRAFT);

  const openWindows = () =>
    page.$$eval('[data-hud-window]', (els) =>
      els
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) => e.getAttribute('data-hud-window'))
        .sort(),
    );
  const windowsBefore = await openWindows();
  // A reload would drop this mark: the page must reconnect, not load again.
  await page.evaluate(() => ((window as { __beforeRestart?: boolean }).__beforeRestart = true));
  await expect(page.getByText(BADGE)).toHaveCount(0);

  await standalone.stopHost();
  await expect(page.getByText(BADGE)).toBeVisible({ timeout: RECONNECT_MS });

  await standalone.startHost();
  await expect(page.getByText(BADGE)).toHaveCount(0, { timeout: RECONNECT_MS });

  // Same page, no login: still at `/`, the mark survived, the HUD is up.
  expect(new URL(page.url()).pathname).toBe('/');
  expect(await page.evaluate(() => (window as { __beforeRestart?: boolean }).__beforeRestart)).toBe(
    true,
  );
  await expect(page.getByTestId('hud-menu')).toBeVisible();

  // The messenger is still open on alpha with the draft, and no window opened or closed by itself.
  await expect(
    (await openMessenger(page)).getByRole('region', { name: 'alpha 대화' }),
  ).toBeVisible();
  await expect(box).toHaveValue(DRAFT);
  expect(await openWindows()).toEqual(windowsBefore);

  // alpha is still one nameplate, at rest.
  await expect(
    getAgentOverlays(page).filter({
      has: page.getByTestId('agent-name').getByText('alpha', { exact: true }),
    }),
  ).toHaveCount(1, { timeout: RECONNECT_MS });
  await expect(nameplateOf(page, 'alpha')).toBeVisible();
  await expect(await ringOf(page, 'alpha')).toHaveAttribute('data-ring', 'idle', {
    timeout: RECONNECT_MS,
  });
  await expect(conv.getByTitle('쉼').first()).toBeVisible({ timeout: RECONNECT_MS });

  // The sent draft gets its reply from the session that lived on; the first exchange is still there.
  const replies = conv.getByText(FIRST_REPLY);
  const repliesBefore = await replies.count();
  await conv.getByRole('button', { name: '보내기', exact: true }).click();
  await expect(box).toHaveValue('');
  await expect(conv.getByText(DRAFT).first()).toBeVisible();
  // The draft holds '빌드', so the same turn plays again: one more reply line.
  await expect.poll(() => replies.count(), { timeout: 30_000 }).toBeGreaterThan(repliesBefore);
  await expect(conv.getByText('빌드 돌려 줘', { exact: true }).first()).toBeVisible();
});

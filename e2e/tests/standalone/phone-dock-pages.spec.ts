/**
 * T-99 flow 6: the office on a phone. The Dock shows one page at a time, the messenger keeps the
 * open conversation across tabs, a permission card fits the screen and its 허용 tap brings the
 * reply, and the browser's Back walks conversation -> list -> office without leaving the app.
 * Selectors: agent-tycoon/test/run-mobile-dock.ts (Dock, page labels), run-perm-prompt.ts (card).
 */
import type { Page } from '@playwright/test';

import { expect, PHONE, test } from '../../fixtures/standalone';
import { permissionRequest } from '../../helpers/hooks';
import { openMessenger, sendMessage } from '../../helpers/messenger';
import { claudeScenario } from '../../helpers/mock-claude';
import { ringOf } from '../../helpers/office';
import {
  buildAssistantTextRecord,
  buildAssistantToolUseRecord,
  buildTurnDurationRecord,
  buildUserToolResultRecord,
} from '../../helpers/team';

const BUILD = { command: 'npm run build', description: '전체 빌드' };
const DEPLOY = { command: 'npm run deploy', description: '배포' };
const BUILD_REPLY = '빌드 끝났어요. 경고는 없어요.';

test.use({
  ...PHONE,
  standaloneOptions: {
    agents: [{ name: 'alpha' }],
    scenarios: [
      claudeScenario('phone dm and permission')
        .forAgent('alpha')
        .onPrompt('빌드')
        .at(300)
        .appendJsonl(buildAssistantToolUseRecord('tu-build', 'Bash', BUILD))
        .at(2_300)
        .appendJsonl(buildUserToolResultRecord('tu-build', 'built'))
        .at(2_500)
        .appendJsonl(buildAssistantTextRecord(BUILD_REPLY))
        .at(2_600)
        .appendJsonl(buildTurnDurationRecord())
        .onPrompt('배포')
        .at(300)
        .appendJsonl(buildAssistantToolUseRecord('tu-deploy', 'Bash', DEPLOY))
        .at(400)
        .emitHook(permissionRequest('{{sessionId}}', 'Bash', DEPLOY))
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

type Screen = 'office' | 'board' | 'files' | 'messenger' | 'notices';
/** What each Dock tab shows (run-mobile-dock.ts PAGE_LABEL); the office is its canvas. */
const pageOf = (page: Page, screen: Screen) =>
  screen === 'office'
    ? page.getByTestId('office-canvas')
    : screen === 'messenger'
      ? page.getByRole('region', { name: '메신저', exact: true })
      : page.locator(
          `[aria-label="${{ board: '현황판', files: '파일', notices: '알림' }[screen]} 화면"]`,
        );

/** The Dock marks `screen` and only it, its page is on screen, nothing is wider than the screen,
 *  and every Dock button is a 44 px target. */
async function expectOn(page: Page, screen: Screen): Promise<void> {
  const dock = page.getByTestId('mobile-dock');
  await expect(dock.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(dock.locator(`[data-dock="${screen}"]`)).toHaveAttribute('aria-current', 'page');
  await expect(pageOf(page, screen)).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  for (const box of await dock
    .locator('[data-dock]')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect()))) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
}

const tapDock = (page: Page, screen: Screen) => page.locator(`[data-dock="${screen}"]`).tap();

test('the phone Dock shows one page at a time, keeps the conversation, answers a permission and Back stays in the app @area:mobile', async ({
  page,
  standalone,
}) => {
  // The phone shell, not the desktop HUD dock.
  await expect(page.getByTestId('mobile-top-bar')).toBeVisible();
  await expect(page.getByTestId('mobile-dock')).toBeVisible();
  await expect(page.getByTestId('hud-dock')).toHaveCount(0);
  await expectOn(page, 'office');
  // The 자동 복구 turn first: a message sent before idle only queues.
  await expect(await ringOf(page, 'alpha')).toHaveAttribute('data-ring', 'idle', {
    timeout: 30_000,
  });

  await tapDock(page, 'messenger');
  await expectOn(page, 'messenger');
  const conv = await sendMessage(page, 'alpha', '빌드 돌려 줘');
  // .first(): the conversation also reads each new line out in an sr-only copy.
  await expect(conv.getByText(BUILD_REPLY).first()).toBeVisible({ timeout: 30_000 });

  for (const screen of ['board', 'files', 'notices', 'office'] as const) {
    await tapDock(page, screen);
    await expectOn(page, screen);
  }

  // Back on 메신저: the same conversation with its history, not the list.
  await tapDock(page, 'messenger');
  await expectOn(page, 'messenger');
  await expect(conv).toBeVisible();
  await expect(conv.getByText('빌드 돌려 줘').first()).toBeVisible();
  await expect(conv.getByText(BUILD_REPLY).first()).toBeVisible();

  await sendMessage(page, 'alpha', '배포해 줘');
  const card = conv.getByTestId('permission-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  const allow = card.getByRole('button', { name: '허용', exact: true });
  await expect(allow).toBeInViewport();
  await expect(card.getByRole('button', { name: '거부', exact: true })).toBeInViewport();
  await allow.tap();
  await expect(conv.getByText('권한 결과: allow').first()).toBeVisible({ timeout: 30_000 });

  // Back: conversation -> list -> office, never out of the app.
  await page.goBack();
  const messenger = await openMessenger(page);
  await expect(messenger.getByRole('list', { name: '연락처' })).toBeVisible();
  await expect(conv).toBeHidden();
  await page.goBack();
  await expectOn(page, 'office');
  expect(new URL(page.url()).origin).toBe(new URL(standalone.hostUrl).origin);
  await expect(page.getByTestId('mobile-top-bar')).toBeVisible();
});

/**
 * T-99 flow 10: switch the screen style and the language in 설정; both stick across a reload, the
 * messenger still sends and shows the reply in the other style and language, and both go back.
 * The one place English is asserted (plan pitfall 23).
 */
import type { Page } from '@playwright/test';

import { topBarButton } from '../../../server/src/agent-tycoon/testHome';
import { expect, test } from '../../fixtures/standalone';
import { claudeScenario } from '../../helpers/mock-claude';
import { ringOf } from '../../helpers/office';
import {
  buildAssistantTextRecord,
  buildAssistantToolUseRecord,
  buildTurnDurationRecord,
  buildUserToolResultRecord,
} from '../../helpers/team';

const REPLY = '빌드 끝났어요. 경고는 없어요.';
const KO_TABS = ['일반', '화면', '접속', '보안', '고급'];

test.use({
  standaloneOptions: {
    agents: [{ name: 'alpha' }],
    scenarios: [
      claudeScenario('dm turn')
        .forAgent('alpha')
        .onPrompt('빌드')
        .at(300)
        .appendJsonl(
          buildAssistantToolUseRecord('tu-build', 'Bash', {
            command: 'npm run build',
            description: '전체 빌드',
          }),
        )
        .at(2_300)
        .appendJsonl(buildUserToolResultRecord('tu-build', 'built'))
        .at(2_500)
        .appendJsonl(buildAssistantTextRecord(REPLY))
        .at(2_600)
        .appendJsonl(buildTurnDurationRecord())
        .build(),
    ],
  },
});

/** The tab buttons' names, without the desktop's icon glyph. */
const tabNames = (page: Page) =>
  page
    .getByTestId('settings-tabs')
    .getByRole('tab')
    .evaluateAll((els) => els.map((e) => e.lastChild?.textContent ?? ''));

const html = (page: Page) => page.locator('html');

test('the screen style and the language stick across a reload and the messenger works in them @area:settings', async ({
  page,
  standalone,
}) => {
  expect(standalone.port).not.toBe(18240); // the fixture's own daemon, never the real one
  // Seeded agents begin with the engine's own recovery turn: wait for 쉼 before messaging.
  const ring = await ringOf(page, 'alpha');
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 30_000 });

  // ≡ → 설정: five tabs.
  await topBarButton(page, '설정');
  await expect.poll(() => tabNames(page)).toEqual(KO_TABS);

  // 화면 → 화면 스타일 → 픽셀 감성: at once, and it is the pressed one.
  await page.getByRole('tab', { name: '화면', exact: true }).click();
  const style = page.getByTestId('ui-theme-option');
  await style.getByRole('button', { name: '픽셀 감성', exact: true }).click();
  await expect(html(page)).toHaveAttribute('data-ui-theme', 'pixel');
  await expect(style.locator('[data-ui-theme="pixel"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(style.locator('[data-ui-theme="modern"]')).toHaveAttribute('aria-pressed', 'false');

  // 일반 → 언어 → English.
  await page.getByRole('tab', { name: '일반', exact: true }).click();
  await page
    .getByTestId('language-option')
    .getByRole('button', { name: 'English', exact: true })
    .click();
  await expect(html(page)).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('tab', { name: 'General', exact: true })).toBeVisible();

  // Close and reload: both hold.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-tabs')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('hud-menu')).toBeVisible({ timeout: 30_000 });
  await expect(html(page)).toHaveAttribute('data-ui-theme', 'pixel');
  await expect(html(page)).toHaveAttribute('lang', 'en');
  const messengerButton = page.getByRole('button', { name: /^Messenger/ }).first();
  await expect(messengerButton).toBeVisible();

  // The messenger in this style and language: it sends and shows the reply.
  await messengerButton.click();
  const messenger = page.getByRole('region', { name: 'Messenger', exact: true });
  await messenger
    .getByRole('list', { name: 'Contacts' })
    .getByRole('button', { name: /^alpha/ })
    .click();
  const conv = messenger.getByRole('region', { name: 'Conversation with alpha' });
  const box = conv.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill('빌드 돌려 줘');
  await box.press('Enter');
  // .first(): the conversation also reads each new line out in an sr-only copy.
  await expect(conv.getByText(REPLY).first()).toBeVisible({ timeout: 30_000 });
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 15_000 });

  // 설정 again, by test ids where the names are English now: the last tab (일반) is remembered.
  await page.getByTestId('hud-menu').click();
  await page
    .getByTestId('hud-menu-list')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await expect(page.locator('#settings-tab-general')).toHaveAttribute('aria-selected', 'true');

  // Back to 모던 and 한국어.
  await page.locator('#settings-tab-display').click();
  await style.locator('[data-ui-theme="modern"]').click();
  await expect(html(page)).toHaveAttribute('data-ui-theme', 'modern');
  await page.locator('#settings-tab-general').click();
  await page
    .getByTestId('language-option')
    .getByRole('button', { name: 'Korean', exact: true })
    .click();
  await expect(html(page)).toHaveAttribute('lang', 'ko');
  await expect.poll(() => tabNames(page)).toEqual(KO_TABS);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^메신저/ }).first()).toBeVisible();
});

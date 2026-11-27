/**
 * T-99 flow 1: add an agent from the office (현황판 → 오케스트레이터 추가, a new folder made on the way), stop it,
 * start it again, remove it. No scenario: the engine fake idles. Selectors of agent-tycoon/test/run-engine.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { engineButton } from '../../../agent-tycoon/test/engineRow';
import { openOfficeWindow } from '../../../server/src/agent-tycoon/testHome';
import { expect, test } from '../../fixtures/standalone';
import { openMessenger } from '../../helpers/messenger';
import { nameplateOf, ringOf } from '../../helpers/office';

const NAME = 'demo-app';

const toast = (page: Page, text: string) =>
  expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible({
    timeout: 15_000,
  });

test('an agent added from the office starts, stops, starts again and is removed @area:office', async ({
  page,
  standalone,
}) => {
  const portrait = page.locator(`[data-testid="agent-card"][title="${NAME}"]`);
  const dialog = page.getByRole('alertdialog');

  await openOfficeWindow(page);
  await page
    .getByRole('complementary', { name: '현황판', exact: true })
    .getByRole('button', { name: '오케스트레이터 추가', exact: true })
    .click();
  const form = page.getByRole('form', { name: '오케스트레이터 추가' });
  const add = form.getByRole('button', { name: '추가', exact: true });

  // An empty 폴더 (the form starts at ~/projects) is refused in the form and adds nothing.
  await form.getByLabel('폴더').fill('');
  await add.click();
  await expect(form.getByText('폴더를 적어 주세요')).toBeVisible();
  await expect(page.getByTestId('agent-card')).toHaveCount(0);

  // A folder that does not exist yet: 이름 follows it, and the office asks before making it.
  const folder = path.join(standalone.tmpHome, 'projects', NAME);
  await form.getByLabel('폴더').fill(folder);
  await expect(form.getByLabel('이름')).toHaveValue(NAME);
  await add.click();
  await expect(dialog).toContainText('폴더가 없어요. 만들까요?');
  await expect(dialog).toContainText(folder);
  await expect(portrait).toHaveCount(0);
  expect(fs.existsSync(folder)).toBe(false);
  await dialog.getByRole('button', { name: '만들기', exact: true }).click();
  await toast(page, '추가했어요');
  expect(fs.statSync(folder).isDirectory()).toBe(true);

  // An office add is also the first 켜기 (engine.ts exec): the card offers 끄기, not 켜기.
  await expect(await engineButton(page, NAME, '끄기')).toBeVisible({ timeout: 15_000 });
  await expect(await engineButton(page, NAME, '켜기')).toHaveCount(0);
  await expect(nameplateOf(page, NAME)).toBeVisible({ timeout: 30_000 });
  await expect(await ringOf(page, NAME)).toHaveAttribute('data-ring', 'idle', { timeout: 30_000 });
  await expect(
    (await openMessenger(page))
      .getByRole('list', { name: '연락처' })
      .getByRole('button', { name: new RegExp(`^${NAME}`) }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '메신저 닫기', exact: true }).click(); // its window lies over the card

  // 끄기 warns first; afterwards 켜기 is back.
  await (await engineButton(page, NAME, '끄기')).click();
  await expect(dialog).toContainText('하던 일이 멈출 수 있어요.');
  await dialog.getByRole('button', { name: '끄기', exact: true }).click();
  await toast(page, '껐어요');
  await expect(await engineButton(page, NAME, '켜기')).toBeVisible({ timeout: 15_000 });
  await expect(await engineButton(page, NAME, '끄기')).toHaveCount(0);

  // 켜기 asks, then the agent stands in the office again.
  await (await engineButton(page, NAME, '켜기')).click();
  await expect(dialog).toContainText(new RegExp(`${NAME}[을를] 켤까요\\?`));
  await dialog.getByRole('button', { name: '켜기', exact: true }).click();
  await toast(page, '켰어요');
  await expect(await engineButton(page, NAME, '끄기')).toBeVisible({ timeout: 15_000 });
  await expect(await ringOf(page, NAME)).toHaveAttribute('data-ring', 'idle', { timeout: 30_000 });

  // ⋯ → 삭제: the portrait and the nameplate go, and stay gone after a reload.
  await (await engineButton(page, NAME, '삭제')).click();
  await expect(dialog).toContainText(new RegExp(`${NAME}[을를] 삭제할까요\\?`));
  await dialog.getByRole('button', { name: '삭제', exact: true }).click();
  await toast(page, '삭제했어요');
  await expect(portrait).toHaveCount(0, { timeout: 15_000 });
  await expect(nameplateOf(page, NAME)).toHaveCount(0, { timeout: 30_000 });

  await page.reload();
  await expect(page.getByTestId('hud-menu')).toBeVisible();
  await page.waitForTimeout(1_000); // settle before asserting absence (office.ts conventions)
  await expect(portrait).toHaveCount(0);
  await expect(nameplateOf(page, NAME)).toHaveCount(0);
});

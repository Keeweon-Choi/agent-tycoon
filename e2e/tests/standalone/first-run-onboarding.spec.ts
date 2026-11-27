/**
 * T-99 flow 13: the first open on a new PC asks how to connect, then (once) how new agents ask for
 * permission; the answer is kept, changeable in 설정 → 보안, and a new agent from 오케스트레이터 추가
 * starts with it. AGTY_TEST_REMOTE feeds the 접속 방식 screen fixed network facts (nothing real is probed).
 */
import fs from 'node:fs';
import path from 'node:path';

import { engineButton } from '../../../agent-tycoon/test/engineRow';
import {
  openOfficeWindow,
  REPO_ROOT,
  topBarButton,
  topBarReady,
} from '../../../server/src/agent-tycoon/testHome';
import { expect, test } from '../../fixtures/standalone';

const LOCAL_SWITCH = '원격 끄고 이 PC에서만 쓰기';
const ADD = '오케스트레이터 추가';

test.use({
  standaloneOptions: {
    firstRun: true,
    env: { AGTY_TEST_REMOTE: path.join(REPO_ROOT, 'e2e/fixtures/remote-facts.json') },
  },
});

test('a new PC asks how to connect and, once, how new agents ask for permission @area:access', async ({
  page,
  standalone,
}) => {
  // 1. The access screen comes first, over the office.
  const access = page.getByRole('dialog').filter({ hasText: '접속 방식 고르기' });
  await expect(access).toBeVisible({ timeout: 30_000 });
  // It covers the office: the middle of the screen is the access screen.
  expect(
    await access.evaluate((el) => {
      const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return !!hit && el.contains(hit);
    }),
  ).toBe(true);
  const local = page.getByTestId('access-card-local');
  await local.getByRole('button', { name: LOCAL_SWITCH }).click();
  await expect(local.getByText('이 PC에서만 열어요')).toBeVisible();
  await access.getByRole('button', { name: '나중에' }).click();
  await expect(access).toBeHidden();
  await topBarReady(page, 30_000);

  // 2. The permission step says the risk and the default; nothing is saved before the answer
  //    (the recommended answer is only highlighted).
  const bubble = page.getByRole('dialog').filter({ has: page.getByTestId('bypass-what') });
  await expect(bubble).toBeVisible({ timeout: 30_000 });
  await expect(bubble.getByTestId('bypass-what')).toContainText('기본으로는 위험할 수 있는 일마다');
  await expect(bubble.getByTestId('bypass-risk')).toContainText('되돌리지 못할 수도');
  await expect(bubble.getByTestId('bypass-saved')).toHaveCount(0);
  await expect(bubble.getByTestId('bypass-allow')).toContainText('추천');
  await bubble.getByTestId('bypass-ask').click();

  // 3. The remaining step, then finish.
  await expect(page.getByText('밖에서 쓰려면: 원격 접속 먼저, 그다음 폰').first()).toBeVisible({
    timeout: 15_000,
  });
  await page.getByTestId('intro-finish').click();
  await expect(page.getByTestId('intro-finish')).toHaveCount(0);

  // 4. Asked once: a reload asks neither question again.
  await page.reload();
  await topBarReady(page, 30_000);
  await page.waitForTimeout(3_000); // settle: both questions would arrive with the first messages
  await expect(page.getByText('접속 방식 고르기')).toHaveCount(0);
  await expect(page.getByTestId('bypass-what')).toHaveCount(0);

  // 5. 설정 → 보안 shows the choice (계속 물어보기) and changes it.
  await topBarButton(page, '설정');
  await page.getByRole('tab', { name: '보안', exact: true }).click();
  const option = page.getByTestId('bypass-option');
  const ask = option.getByRole('button', { name: '계속 물어보기' });
  const allow = option.getByRole('button', { name: /묻지 않고 실행/ });
  await expect(ask).toHaveAttribute('aria-pressed', 'true');
  await expect(allow).toHaveAttribute('aria-pressed', 'false');
  await allow.click();
  await expect(allow).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
  await expect(ask).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');

  // 6. A new agent from 오케스트레이터 추가 starts with that mode.
  const folder = standalone.agentFolder('gamma');
  fs.mkdirSync(folder, { recursive: true });
  await openOfficeWindow(page);
  const drawer = page.getByRole('complementary', { name: '현황판', exact: true });
  await drawer.getByRole('button', { name: ADD, exact: true }).click();
  const form = page.getByRole('form', { name: ADD });
  await form.getByLabel('폴더').fill(folder);
  await expect(form.getByLabel('이름')).toHaveValue('gamma');
  await form.getByRole('button', { name: '추가', exact: true }).click();
  await expect(form).toHaveCount(0, { timeout: 20_000 });
  await drawer.getByRole('button', { name: '현황판 닫기' }).click();

  // Its own settings (member card ⋯ → 설정) show the mode it started with.
  await (await engineButton(page, 'gamma', '설정')).click();
  const settings = page.getByRole('form', { name: '프로젝트 설정' });
  await expect(settings.getByLabel('권한 모드')).toHaveValue('bypassPermissions');
});

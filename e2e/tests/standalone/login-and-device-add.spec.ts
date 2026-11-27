/**
 * T-99 flow 5: the host's login link logs in, 기기 추가's code lets a second device in once, and
 * 다른 기기 모두 로그아웃 puts it back out on the login page. Selectors follow run-login.ts.
 */
import type { Browser, Page } from '@playwright/test';

import { pagePins, topBarButton, topBarReady } from '../../../server/src/agent-tycoon/testHome';
import { expect, test } from '../../fixtures/standalone';

const REFUSED = '코드가 맞지 않거나 만료됐어요';
/** The login page's title (it goes on with " · <host name>"). */
const LOGIN_TITLE = /^에이전트 타이쿤 로그인/;

/** Another device: a fresh context (no cookie, no device key) with the suite's locale and pins. */
async function newDevice(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'ko-KR' });
  await ctx.addInitScript((pairs) => {
    for (const [key, value] of pairs)
      try {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value);
      } catch {
        // No storage: defaults stay.
      }
  }, pagePins());
  return await ctx.newPage();
}

test('the host link logs in, a code adds a device, sign-out puts it back out @area:access', async ({
  page,
  browser,
  standalone,
}) => {
  const home = `${standalone.hostUrl}/`;

  // The host's link: in the office, no code left in the address, and a reload stays in.
  expect(page.url()).toBe(home);
  await page.reload();
  await topBarReady(page, 15_000);
  expect(page.url()).toBe(home);

  // A second device without a session: 401 and the login page, no office.
  const second = await newDevice(browser);
  const anonymous = await second.goto(home);
  expect(anonymous?.status()).toBe(401);
  await expect(second).toHaveTitle(LOGIN_TITLE);
  await expect(second.locator('#code')).toBeVisible();
  await expect(second.getByTestId('hud-menu')).toHaveCount(0);

  // 기기 추가 on the first: "1234 5678", a QR and a countdown.
  await topBarButton(page, '기기 추가');
  const codeBox = page.getByTestId('device-code');
  await expect(codeBox).toHaveText(/^\d{4} \d{4}$/);
  const code = ((await codeBox.textContent()) ?? '').trim();
  await expect(page.getByRole('img', { name: '로그인 QR 코드' })).toBeVisible();
  await expect(page.getByTestId('add-device')).toContainText(/\d:\d\d 뒤 만료/);

  // The second types it and is in.
  await second.locator('#code').fill(code);
  await second.getByRole('button', { name: '로그인', exact: true }).click();
  await second.waitForURL(home);
  await topBarReady(second, 30_000);

  // A third device with the same code is refused (one wrong code: the limit is per address).
  const third = await newDevice(browser);
  await third.goto(home);
  await third.locator('#code').fill(code);
  await third.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(third.getByText(REFUSED)).toBeVisible();
  await expect(third.getByTestId('hud-menu')).toHaveCount(0);

  // 보안: two devices; sign the other out, one is left.
  await page.getByRole('button', { name: 'x', exact: true }).click();
  await topBarButton(page, '보안');
  const security = page.getByTestId('security');
  await expect(security.getByTestId('session-row')).toHaveCount(2, { timeout: 15_000 });
  await expect(security.getByTestId('session-row').filter({ hasText: '이 기기' })).toHaveCount(1);
  await security.getByRole('button', { name: '다른 기기 모두 로그아웃', exact: true }).click();
  await expect(page.getByText('다른 기기를 모두 로그아웃했어요')).toBeVisible();
  await expect(security.getByTestId('session-row')).toHaveCount(1, { timeout: 15_000 });

  // The second goes to the login page by itself, and a reload keeps it there.
  await expect(second.locator('#code')).toBeVisible({ timeout: 15_000 });
  const after = await second.reload();
  expect(after?.status()).toBe(401);
  await expect(second).toHaveTitle(LOGIN_TITLE);

  await second.context().close();
  await third.context().close();
});

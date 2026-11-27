/**
 * T-142: on a phone, the agent terminal's "Face ID로 확인" (the remote attach step-up, T-127) did
 * nothing. iOS opens the passkey sheet only from the tap itself, and the tap first awaited the
 * options fetch. Here the page is a remote session's: the attach socket closes 4001 'proof' and the
 * device key cannot prove (/api/auth/me keyStepUp false), so the overlay asks for Face ID. The tap
 * must reach navigator.credentials.get inside the tap's own task (a stub records it), and a refused
 * sheet must show on the overlay, in both screen styles.
 */

import type { Page } from '@playwright/test';

import { expect, PHONE, test } from '../../fixtures/standalone';
import { openConversation } from '../../helpers/messenger';
import { ringOf } from '../../helpers/office';

// Shots go to this test's own output folder (test-results, git-ignored): the deploy gate runs this
// spec in the main checkout, and writing agent-tycoon/artifacts there left tracked files changed.
const shot = (name: string) => test.info().outputPath(name);

test.use({ ...PHONE, standaloneOptions: { agents: [{ name: 'alpha' }] } });

/** Every passkey sheet the page opened, and whether it opened inside the tap's own task. */
const sheets = (page: Page) =>
  page.evaluate(() => (window as unknown as { sheets: boolean[] }).sheets);

test('the terminal Face ID tap opens the passkey sheet at once and shows its refusal @area:terminal', async ({
  page,
  standalone,
}) => {
  expect(standalone.port).not.toBe(18240);

  // A remote session: the server refuses the attach for a missing step-up, the key cannot give one.
  await page.routeWebSocket(/\/agty\/attach\//, (ws) => ws.close({ code: 4001, reason: 'proof' }));
  await page.route('**/api/auth/me', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), keyStepUp: false } });
  });
  let primed = 0;
  await page.route('**/api/auth/passkeys/verify/options', (route) => {
    primed++;
    return route.fulfill({
      json: {
        ceremony: `c${String(primed)}`,
        options: { challenge: 'AAAA', rpId: 'localhost', allowCredentials: [], timeout: 60_000 },
      },
    });
  });
  // Routed sockets are the ones a page made after routing: load it again (the login cookie stays).
  await page.reload();
  const ring = await ringOf(page, 'alpha');
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 30_000 });
  // The sheet: records whether it was asked for before the tap's task ended, then the person cancels.
  await page.evaluate(() => {
    const w = window as unknown as { sheets: boolean[]; inTap: boolean };
    w.sheets = [];
    w.inTap = false;
    document.addEventListener(
      'click',
      () => {
        w.inTap = true;
        setTimeout(() => (w.inTap = false), 0);
      },
      true,
    );
    Object.defineProperty(navigator.credentials, 'get', {
      value: () => {
        w.sheets.push(w.inTap);
        return Promise.reject(new DOMException('The user cancelled.', 'NotAllowedError'));
      },
    });
  });

  const conv = await openConversation(page, 'alpha');
  await conv.getByRole('button', { name: '터미널로 보기' }).tap();

  const overlay = page.getByTestId('terminal-overlay');
  await expect(overlay).toContainText('이 기기를 확인해야 다시 연결할 수 있어요', {
    timeout: 15_000,
  });
  await expect.poll(() => primed).toBeGreaterThan(0); // options ready before the tap
  await page.screenshot({ path: shot('phone-overlay-modern.png') });

  const face = overlay.getByRole('button', { name: 'Face ID로 확인' });
  const reprimed = page.waitForResponse('**/api/auth/passkeys/verify/options');
  await face.tap();
  await expect.poll(() => sheets(page)).toEqual([true]);
  await expect(overlay).toContainText('패스키를 취소했어요');
  await page.screenshot({ path: shot('phone-overlay-refused-modern.png') });

  // 픽셀 감성: the same tap, on the options fetched again after the refusal.
  await reprimed;
  await page.evaluate(() => document.documentElement.setAttribute('data-ui-theme', 'pixel'));
  await expect(face).toBeEnabled();
  await face.tap();
  await expect.poll(() => sheets(page)).toEqual([true, true]);
  await expect(overlay).toContainText('패스키를 취소했어요');
  await page.screenshot({ path: shot('phone-overlay-pixel.png') });
});

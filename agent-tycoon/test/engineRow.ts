/**
 * Runner helper (no runner of its own): an engine project's actions live on its member card (FEAT-PARTY-V2,
 * webview-ui/src/agent-tycoon/party/MemberCard.tsx): 켜기 / 끄기 as big buttons, 재시작 / Lead 로 / 설정 / 삭제 (and 개발
 * 현황, 파일) in its ⋯ menu. The card opens beside the party (PC) or as the bottom sheet (phone) when the
 * party's portrait of `name` is selected.
 */
import type { Locator, Page } from '@playwright/test';

/** The ⋯ menu's actions (the rest are the card's big buttons). */
const MENU = new Set(['재시작', 'Lead 로', '설정', '삭제', '개발 현황', '파일', '꾸미기', '스탯 창']);

/** Selects the party portrait of `name` (unless its card is open) and returns its member card. */
export async function engineRow(page: Page, name: string): Promise<Locator> {
  const portrait = page.locator(`[data-testid="agent-card"][title="${name}"]`).first();
  await portrait.waitFor({ state: 'attached', timeout: 30_000 });
  const id = await portrait.getAttribute('data-agent-id');
  const card = page.locator(`[data-testid="inspector"][data-agent-id="${id}"]`);
  if (!(await card.count())) {
    // A phone: a page (the 현황판) covers the office and its party; the Dock's 사무실 minimizes it.
    const office = page.locator('[data-dock="office"]');
    if (!(await portrait.isVisible()) && (await office.count())) await office.tap();
    await portrait.waitFor({ timeout: 10_000 });
    await portrait.scrollIntoViewIfNeeded();
    if (await office.count()) await portrait.tap();
    else await portrait.click();
    await card.waitFor({ timeout: 10_000 });
  }
  return card;
}

/** One engine action of `name`'s card by its label: a big button, or ⋯'s item (opening ⋯ first). */
export async function engineButton(page: Page, name: string, label: string): Promise<Locator> {
  const card = await engineRow(page, name);
  if (!MENU.has(label)) return card.getByRole('button', { name: label, exact: true });
  const more = card.getByTestId('member-more');
  if ((await more.getAttribute('aria-expanded')) !== 'true') {
    if (await page.locator('[data-dock="office"]').count()) await more.tap();
    else await more.click();
  }
  return card.getByTestId('member-more-menu').getByRole('menuitem', { name: label, exact: true });
}

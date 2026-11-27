/**
 * Runner helper (no runner of its own): an engine project's actions live on its member card (FEAT-PARTY-V2,
 * webview-ui/src/agent-tycoon/party/MemberCard.tsx): 켜기 / 끄기 as big buttons, 재시작 / Lead 로 / 설정 / 삭제 (and 개발
 * 현황, 파일) in its ⋯ menu. The card opens beside the party (PC) or as the bottom sheet (phone) when the
 * party's portrait of `name` is selected.
 */
import type { Locator, Page } from '@playwright/test';

/** The ⋯ menu's actions (the rest are the card's big buttons). */
const MENU = new Set(['재시작', 'Lead 로', '설정', '삭제', '개발 현황', '파일', '꾸미기', '스탯 창']);

/** T-106: on the phone a tap on a portrait (or a character) only selects it; the member sheet opens by the
 *  selection chip above the walking pad (webview-ui/src/agent-tycoon/SelectionChip.tsx). Taps `portrait` until
 *  the chip is there (a press while the page settles can be lost; the chip shows the moment it selects, so a
 *  repeat on a selected portrait, which would slide to its terminal, does not happen), then taps the chip. */
export async function openPhoneSheet(page: Page, portrait: Locator): Promise<void> {
  const chip = page.getByTestId('selection-chip');
  for (let i = 0; i < 8 && !(await chip.isVisible()); i++) {
    await portrait.tap();
    await chip.waitFor({ timeout: 2_500 }).catch(() => undefined);
  }
  await chip.tap({ timeout: 5_000 });
}

/** Selects the party portrait of `name` (unless its card is open) and returns its member card. */
export async function engineRow(page: Page, name: string): Promise<Locator> {
  const portrait = page.locator(`[data-testid="agent-card"][title="${name}"]`).first();
  // A phone on a page (the 현황판) has no party mounted: the Dock's 사무실 brings the office back.
  const dock = page.locator('[data-dock="office"]');
  if (await dock.count()) {
    await portrait.waitFor({ state: 'attached', timeout: 3_000 }).catch(() => undefined);
    if (!(await portrait.count())) await dock.tap();
  }
  await portrait.waitFor({ state: 'attached', timeout: 30_000 });
  const id = await portrait.getAttribute('data-agent-id');
  const card = page.locator(`[data-testid="inspector"][data-agent-id="${id}"]`);
  if (!(await card.count())) {
    // A phone: a page (the 현황판) covers the office and its party; the Dock's 사무실 minimizes it.
    const office = page.locator('[data-dock="office"]');
    if (!(await portrait.isVisible()) && (await office.count())) await office.tap();
    await portrait.waitFor({ timeout: 10_000 });
    await portrait.scrollIntoViewIfNeeded();
    if (await office.count()) await openPhoneSheet(page, portrait);
    else {
      // The PC: a press while the page settles can be lost too; a repeat only selects it again.
      for (let i = 0; i < 8 && !(await card.isVisible()); i++) {
        await portrait.click();
        await card.waitFor({ timeout: 2_500 }).catch(() => undefined);
      }
    }
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

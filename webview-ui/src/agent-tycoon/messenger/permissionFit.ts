/**
 * PERM-CARD-FIT: how the permission card fits a phone. DOM-free: the component passes what it
 * knows, this decides. The command text gets its own scrolling box (a share of the visible
 * height on a phone), and a long command starts folded there so 허용 / 거부 never scroll away.
 */
export const PERM_FOLD_LINES = 4;
export const PERM_FOLD_CHARS = 200;
/** On a phone the command box may take this share of the visible height. */
export const PERM_PHONE_DETAIL_SHARE = 0.4;

export function permissionCommandIsLong(detail: string | undefined): boolean {
  if (!detail) return false;
  return detail.split('\n').length > PERM_FOLD_LINES || detail.length > PERM_FOLD_CHARS;
}

/** Long commands start folded on a phone; on a desktop the card starts open. */
export function permissionStartsFolded(detail: string | undefined, phone: boolean): boolean {
  return phone && permissionCommandIsLong(detail);
}

/** The command box's max height in px on a phone (the keyboard-aware visible height wins). */
export function permissionDetailMaxHeight(
  phone: boolean,
  visualViewportHeight: number | undefined,
  viewportHeight: number,
): number | undefined {
  if (!phone) return undefined;
  return Math.floor((visualViewportHeight ?? viewportHeight) * PERM_PHONE_DETAIL_SHARE);
}

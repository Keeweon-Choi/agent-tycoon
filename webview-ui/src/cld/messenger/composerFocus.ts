/**
 * A phone button beside a focused composer must not become the focused element:
 * iOS starts dismissing its keyboard during that focus transfer, moving the
 * composer before the following click can land.
 */
export function keepPhoneComposerFocus(
  phone: boolean,
  event: Pick<PointerEvent, 'preventDefault'>,
): void {
  if (phone) event.preventDefault();
}

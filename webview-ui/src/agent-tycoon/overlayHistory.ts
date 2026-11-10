/**
 * Full-screen overlays (the lobby board's full view, the attachment viewer) push one
 * history entry, so the browser's back closes them. Closing by ✕, Esc or a click
 * outside pops that entry only while it is still ours on top; otherwise back() would
 * leave the app (an installed app's window opened a blank tab, user 10-22 17:09) and
 * the overlay simply closes.
 */
export function closeOverlay(key: string, close: () => void): void {
  const state = history.state as Record<string, unknown> | null;
  if (state && state[key] === true) history.back();
  else close();
}

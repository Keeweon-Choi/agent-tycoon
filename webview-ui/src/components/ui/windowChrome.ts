/**
 * UI-AUDIT-DESKTOP: the one chrome of every window (cld/hud/HudWindow.tsx) and dialog
 * (ui/Modal.tsx): the title bar, and the room under it and at its sides. Buttons in the bar are
 * `Button size="icon_md"` (28 square, a 16 px glyph).
 */
export const TITLE_BAR =
  'shrink-0 flex items-center justify-between gap-8 px-10 py-4 border-b-2 border-border select-none';

/** Content starts 10 under the title bar and 10 from the sides and the bottom. A dialog's own
 *  content carries `px-10 pb-10` and its title bar `mb-10`; a window's body wrapper carries this. */
export const WINDOW_PAD = 'p-10';

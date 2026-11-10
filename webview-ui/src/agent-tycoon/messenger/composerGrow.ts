/**
 * T-0111: how tall the message box is. DOM-free: the component measures, this decides.
 * One line to start with, growing with its content up to 8 lines (desktop) or a third
 * of the screen height (phone), then scrolling inside; empty again (after sending) it is
 * one line again.
 */
export const COMPOSER_MAX_LINES = 8;
/** The inactive composer shows this many text lines. */
export const COMPOSER_COLLAPSED_LINES = 1;
/** On a phone the box may take this share of the screen (the keyboard takes more). */
export const PHONE_MAX_SCREEN_SHARE = 1 / 3;

export interface ComposerMetrics {
  /** The content's full height with padding and border (scrollHeight + border). */
  content: number;
  /** One line of text. */
  lineHeight: number;
  /** Padding and border around the text, top and bottom together. */
  extra: number;
  /** The visible part of a phone's viewport when its keyboard is open. */
  visualViewportHeight?: number;
  viewportHeight: number;
  phone: boolean;
  /** An inactive composer keeps its draft, but only shows its compact height. */
  collapsed?: boolean;
}

export function composerHeight(m: ComposerMetrics): { height: number; scrolls: boolean } {
  const oneLine = Math.round(m.lineHeight + m.extra);
  const collapsedHeight = Math.round(m.lineHeight * COMPOSER_COLLAPSED_LINES + m.extra);
  if (m.collapsed) return { height: collapsedHeight, scrolls: false };
  const viewportHeight = m.phone && m.visualViewportHeight !== undefined
    ? m.visualViewportHeight
    : m.viewportHeight;
  const max = Math.max(
    oneLine,
    m.phone
      ? Math.floor(viewportHeight * PHONE_MAX_SCREEN_SHARE)
      : Math.round(m.lineHeight * COMPOSER_MAX_LINES + m.extra),
  );
  return {
    height: Math.min(Math.max(Math.round(m.content), oneLine), max),
    scrolls: Math.round(m.content) > max,
  };
}

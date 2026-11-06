/**
 * FEAT-HUD-SUMMARY-STYLES 왼쪽 아래 요약 (owner 11-06 22:23): how the PC office's bottom-left summary looks, one
 * setting per browser like 화면 스타일 (uiTheme.ts): 'center' the control center (the default), 'cards' 카드 쌓기
 * (mockup A), 'line' 얇은 상태줄 (mockup B). Same data and actions in all three (ControlCenter.tsx). Junk or a
 * blocked store keeps the default; nothing older exists to migrate.
 */
import { useSyncExternalStore } from 'react';

export const SUMMARY_STYLES = ['center', 'cards', 'line'] as const;
export type SummaryStyle = (typeof SUMMARY_STYLES)[number];
export const DEFAULT_SUMMARY_STYLE: SummaryStyle = 'center';
export const SUMMARY_STYLE_KEY = 'cld.hud-summary';

export const parseSummaryStyle = (raw: string | null): SummaryStyle => SUMMARY_STYLES.find((s) => s === raw) ?? DEFAULT_SUMMARY_STYLE;

function read(): SummaryStyle {
  try {
    return parseSummaryStyle(localStorage.getItem(SUMMARY_STYLE_KEY));
  } catch {
    return DEFAULT_SUMMARY_STYLE;
  }
}
let style = read();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const summaryStyle = () => style;
export const useSummaryStyle = () => useSyncExternalStore(subscribe, summaryStyle, summaryStyle);

export function setSummaryStyle(next: string): void {
  style = parseSummaryStyle(next);
  try {
    localStorage.setItem(SUMMARY_STYLE_KEY, style);
  } catch {
    // Private mode or a locked-down webview: this visit still remembers it.
  }
  for (const l of listeners) l();
}

/** Tests: read the store again (after stubbing localStorage). */
export const reloadSummaryStyle = (): void => {
  style = read();
};

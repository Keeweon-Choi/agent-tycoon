/** OPTIONS-3A: what 설정's rows share with the window: the one hint line, and the arrow keys. */
import { createContext, type ReactNode } from 'react';

export interface SettingHint {
  id: string;
  title: ReactNode;
  help?: ReactNode;
}

interface HintSink {
  /** The row whose help shows (it is drawn picked). */
  picked: string | null;
  hover(hint: SettingHint | null): void;
  pick(hint: SettingHint): void;
  /** The phone: a control that does not fit goes under the name. */
  compact: boolean;
}

/** GameOptions provides it; a row outside 설정 has no hint line and draws as on a desktop. */
export const SettingHintContext = createContext<HintSink | null>(null);

const FOCUSABLE = 'button:not(:disabled), input:not([type=file]), select, textarea';

function focusRow(row: HTMLElement) {
  (row.querySelector<HTMLElement>('[aria-pressed="true"]:not(:disabled)') ?? row.querySelector<HTMLElement>(FOCUSABLE) ?? row).focus();
}

/**
 * The keys of a game options screen, inside `root` (the window's tabs and panels): on the tabs,
 * ↑/↓ (←/→ for the phone's row of tabs) change the tab and → goes into it; in a tab, ↑/↓ walk its
 * rows, ←/→ pick the next or previous choice, or step along a row's buttons. True when handled.
 */
export function settingsKey(key: string, root: HTMLElement): boolean {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const vertical = root.querySelector('[role="tablist"]')?.getAttribute('aria-orientation') === 'vertical';
  const rows = [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]:not([hidden]) [data-setting-row]')].filter(
    (r) => r.getClientRects().length > 0,
  );
  const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
  const onTab = active ? tabs.indexOf(active) : -1;
  if (onTab >= 0) {
    const [back, forth, into] = vertical ? ['ArrowUp', 'ArrowDown', 'ArrowRight'] : ['ArrowLeft', 'ArrowRight', 'ArrowDown'];
    if (key === into && rows[0]) {
      focusRow(rows[0]);
      return true;
    }
    const step = key === forth ? 1 : key === back ? -1 : 0;
    if (!step) return false;
    const next = tabs[(onTab + step + tabs.length) % tabs.length];
    next.click();
    next.focus();
    return true;
  }
  const at = rows.findIndex((r) => r.contains(active));
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (!rows.length) return false;
    const next = at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (key === 'ArrowDown' ? 1 : -1)));
    focusRow(rows[next]);
    return true;
  }
  if (at < 0 || (key !== 'ArrowLeft' && key !== 'ArrowRight')) return false;
  const step = key === 'ArrowRight' ? 1 : -1;
  const group = active?.closest('[data-choice]');
  if (group) {
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('button')];
    const from = buttons.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
    for (let i = (from < 0 ? buttons.indexOf(active as HTMLButtonElement) : from) + step; i >= 0 && i < buttons.length; i += step) {
      if (buttons[i].disabled) continue;
      buttons[i].click();
      buttons[i].focus();
      return true;
    }
    return true; // the end of the choice: stay
  }
  const controls = [...rows[at].querySelectorAll<HTMLElement>(FOCUSABLE)];
  const next = controls[controls.indexOf(active as HTMLElement) + step];
  if (next) next.focus();
  else if (step < 0 && vertical) tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.focus();
  return true;
}

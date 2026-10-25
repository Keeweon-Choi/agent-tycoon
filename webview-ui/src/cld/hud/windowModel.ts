/**
 * WINMODEL (owner 10-24 22:00): the one window/tab model both shells render from. Pure;
 * hudStore holds the state and runs these.
 *
 * PC: Windows-taskbar windows on the right icon column. A window is closed, front, behind or
 * minimized; a gray icon opens it in front, the front window's icon minimizes it, an icon of
 * one behind or minimized brings it to front as it was. Only its × closes it.
 *
 * Phone: a tab app. The Dock's buttons are tabs and exactly one page shows; the others stay
 * mounted and minimized, so a page comes back as it was (conversation, scroll, draft, tab).
 * There is no close: closing a page goes home, keeping it. Pressing the shown tab, and Back,
 * step inside the tab to its root first (the tab's own store knows its sub-route: the
 * messenger's conversation, the 작업실's tab, the 현황판's tab).
 */
import { HUD_MAXIMIZED_Z } from '../../constants.js';
import type { OfficePanel } from '../format.js';
import type { WindowId } from './layout.js';

/** The tabs of the 현황판 window: the terminal has its own window now. */
export type OfficeTab = Exclude<OfficePanel, 'terminal'>;
export type BoardTab = Exclude<OfficeTab, 'files'>;

export interface WinState {
  /** The phone shell: one page shows at a time. */
  phone: boolean;
  open: Record<WindowId, boolean>;
  /** Out of sight, still mounted (and on the PC, its icon still lit). */
  minimized: Partial<Record<WindowId, boolean>>;
  /** Last touched last: the z order. */
  order: readonly WindowId[];
  officeTab: OfficeTab;
  /** The last tab other than 파일: the 현황판 reopens on it after 파일 (owner 10-24). */
  boardTab: BoardTab;
}

export type WinStatus = 'closed' | 'front' | 'behind' | 'minimized';

/** The phone's tabs: the Dock's buttons ('office' is home) and 꾸미기 (CH-4, opened from a character). */
export type Tab =
  | 'office'
  | 'board'
  | 'workbench'
  | 'messenger'
  | 'files'
  | 'notices'
  | 'terminal'
  | 'looks';

/** The PC's icons: a window each, 파일 being the 현황판 window on its 파일 tab. */
export type Icon = Exclude<WindowId, 'looks'> | 'files';

/** A step plus, when the tab must go back to its root, which tab (its store does that). */
export interface Step {
  state: WinState;
  root?: Exclude<Tab, 'office'>;
}

const shown = (s: WinState): WindowId[] => s.order.filter((id) => s.open[id] && !s.minimized[id]);

const without = (m: WinState['minimized'], id: WindowId): WinState['minimized'] => {
  const rest = { ...m };
  delete rest[id];
  return rest;
};

export function status(s: WinState, id: WindowId): WinStatus {
  if (!s.open[id]) return 'closed';
  if (s.minimized[id]) return 'minimized';
  return shown(s).at(-1) === id ? 'front' : 'behind';
}

/**
 * WINDOW-LAYERS (owner 10-25): the HUD layer's z order, decided here and nowhere else. Normal
 * windows are 1..n by order (last touched on top), under the fixed panels (constants HUD_PANELS_Z: the card
 * bar, the icon dock, the elevator); a maximized window sits over them (HUD_MAXIMIZED_Z + order).
 */
export const windowZ = (s: Pick<WinState, 'order'>, id: WindowId, maximized: boolean): number =>
  (maximized ? HUD_MAXIMIZED_Z : 0) + s.order.indexOf(id) + 1;

/** 현황판 and 파일 share one window: each icon is lit only in its own mode. */
export function iconStatus(s: WinState, icon: Icon): WinStatus {
  if (icon !== 'office' && icon !== 'files') return status(s, icon);
  return (s.officeTab === 'files') === (icon === 'files') ? status(s, 'office') : 'closed';
}

/** The phone's page on screen; 'office' when none shows. */
export function activeTab(s: WinState): Tab {
  const top = shown(s).at(-1);
  if (top === undefined) return 'office';
  if (top === 'office') return s.officeTab === 'files' ? 'files' : 'board';
  return top;
}

/** Agent cards are useful only while the phone is on its office home screen. */
export const showsAgentCards = (tab: Tab, view: 'office' | 'terminal'): boolean =>
  tab === 'office' && view === 'office';

/** Open `id` in front (restored if minimized, never reset), on 현황판 tab `tab`. A phone shows it
 *  alone: whatever showed is minimized, kept as it was. */
export function openOrFocus(s: WinState, id: WindowId, tab?: OfficeTab): WinState {
  const sameTab = id !== 'office' || tab === undefined || tab === s.officeTab;
  if (sameTab && status(s, id) === 'front' && (!s.phone || shown(s).length === 1)) return s;
  const minimized = { ...without(s.minimized, id) };
  if (s.phone) for (const other of shown(s)) if (other !== id) minimized[other] = true;
  const next: WinState = {
    ...s,
    open: { ...s.open, [id]: true },
    minimized,
    order: [...s.order.filter((w) => w !== id), id],
  };
  if (id !== 'office' || tab === undefined) return next;
  return { ...next, officeTab: tab, boardTab: tab === 'files' ? s.boardTab : tab };
}

export const minimize = (s: WinState, id: WindowId): WinState =>
  s.minimized[id] ? s : { ...s, minimized: { ...s.minimized, [id]: true } };

/** The window's ×. A phone has no close: the page goes out of sight as it was (home). */
export function close(s: WinState, id: WindowId): WinState {
  if (s.phone) return s.open[id] ? minimize(s, id) : s;
  return { ...s, open: { ...s.open, [id]: false }, minimized: without(s.minimized, id) };
}

/** NOTICE-STACK (owner 10-25): a notice opened from the 알림 window. The PC leaves the window
 *  where it is (the target then opens or comes to front above it); a phone page goes out of
 *  sight as it was, the target showing alone. */
export const leaveNotices = (s: WinState): WinState => (s.phone ? close(s, 'notices') : s);

/** The phone's home: every page out of sight, each kept. */
export const home = (s: WinState): WinState =>
  shown(s).reduce((acc, id) => minimize(acc, id), s);

/** A PC icon: gray opens in front, the front one minimizes, one behind or minimized comes to front. */
export function iconPress(s: WinState, icon: Icon): WinState {
  const id = icon === 'files' ? 'office' : icon;
  const now = iconStatus(s, icon);
  if (now === 'front') return minimize(s, id);
  if (icon === 'files') return openOrFocus(s, id, 'files');
  // The 현황판 icon over the 파일 mode brings the board back, on its last tab.
  return openOrFocus(s, id, icon === 'office' && now === 'closed' ? s.boardTab : undefined);
}

/** The window behind a phone tab (현황판 and 파일 share one). */
const pageOf = (tab: Exclude<Tab, 'office'>): WindowId =>
  tab === 'board' || tab === 'files' ? 'office' : tab;

/** A Dock tab: another tab shows as it was; the shown one goes back to its root (like iOS). */
export function tabPress(s: WinState, tab: Tab): Step {
  const now = activeTab(s);
  if (tab === 'office') return { state: home(s) };
  if (tab === now) return { state: s, root: tab };
  const officeTab = tab === 'files' ? 'files' : tab === 'board' ? s.boardTab : undefined;
  return { state: openOrFocus(s, pageOf(tab), officeTab) };
}

/** The phone's Back: inside the tab to its root first (`atRoot`: the tab's store is there), then
 *  home. Never closes or resets anything else; at home it does nothing (the browser leaves). */
export function back(s: WinState, atRoot: boolean): Step {
  const now = activeTab(s);
  if (now === 'office') return { state: s };
  return atRoot ? { state: home(s) } : { state: s, root: now };
}

/** Crossing the breakpoint to the phone: only the front window stays in sight. */
export function withPhone(s: WinState, phone: boolean): WinState {
  if (s.phone === phone) return s;
  const top = shown(s).at(-1);
  const next = { ...s, phone };
  return phone && top !== undefined ? openOrFocus(next, top) : next;
}

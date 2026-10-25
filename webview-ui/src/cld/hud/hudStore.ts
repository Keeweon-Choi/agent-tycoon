/**
 * T-0077: the HUD's state. The layout (positions, window sizes, scale steps)
 * and which windows are open are remembered per device in localStorage under
 * one versioned key; which window was touched last lives only for this visit.
 * Which windows are open, minimized and in front (the messenger's too) follows
 * windowModel.ts (WINMODEL).
 */
import { type CSSProperties, useSyncExternalStore } from 'react';

import {
  applyPreset,
  emptyLayout,
  type Entry,
  type Layout,
  LAYOUT_KEY,
  migrateSavedWindowIds,
  parseLayout,
  type Place,
  type Preset,
  presetLayoutOnly,
  type ScaleStep,
  serializeLayout,
  type Size,
  type WindowId,
  withEntry,
  withNewIcons,
} from './layout.js';
import {
  back,
  close,
  home,
  type Icon,
  iconPress,
  leaveNotices,
  minimize,
  type OfficeTab,
  openOrFocus,
  type Step,
  type Tab,
  tabPress,
  type WinState,
  withPhone,
} from './windowModel.js';

export type { OfficeTab };

export interface HudSnapshot extends WinState {
  layout: Layout;
}

/** The floating windows whose open flags a desktop remembers (`looks` opens for one character). */
type HudOpenState = Omit<WinState['open'], 'looks'>;

const DEFAULT_OPEN: HudOpenState = {
  office: false,
  messenger: false,
  notices: false,
  terminal: false,
  workbench: false,
};

function loadSavedOpen(): HudOpenState {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_OPEN;
    const parsed: unknown = JSON.parse(raw);
    const data = migrateSavedWindowIds(parsed);
    if (JSON.stringify(data) !== JSON.stringify(parsed))
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(data));
    if (typeof data !== 'object' || data === null) return DEFAULT_OPEN;
    const { v, items } = data as { v?: unknown; items?: unknown };
    if (v !== 1 || typeof items !== 'object' || items === null || Array.isArray(items))
      return DEFAULT_OPEN;
    const saved = (data as { open?: unknown }).open;
    if (typeof saved !== 'object' || saved === null) {
      // An older saved layout predates open-state persistence.
      return { ...DEFAULT_OPEN, office: true };
    }
    const state = saved as Partial<HudOpenState>;
    return {
      office: typeof state.office === 'boolean' ? state.office : false,
      messenger: typeof state.messenger === 'boolean' ? state.messenger : false,
      notices: typeof state.notices === 'boolean' ? state.notices : false,
      terminal: typeof state.terminal === 'boolean' ? state.terminal : false,
      workbench: typeof state.workbench === 'boolean' ? state.workbench : false,
    };
  } catch {
    return DEFAULT_OPEN;
  }
}

function load(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return emptyLayout();
    const parsed: unknown = JSON.parse(raw);
    const data = migrateSavedWindowIds(parsed);
    if (JSON.stringify(data) !== JSON.stringify(parsed))
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(data));
    return withNewIcons(presetLayoutOnly(parseLayout(JSON.stringify(data))));
  } catch {
    return emptyLayout(); // storage blocked: defaults for this visit
  }
}

function save(layout: Layout): void {
  try {
    const current = localStorage.getItem(LAYOUT_KEY);
    let open: unknown;
    try {
      open = current ? (JSON.parse(current) as { open?: unknown }).open : undefined;
    } catch {
      open = undefined;
    }
    const saved = open === undefined ? layout : { ...layout, open };
    if (Object.keys(layout.items).length === 0 && open === undefined && !layout.preset)
      localStorage.removeItem(LAYOUT_KEY);
    else localStorage.setItem(LAYOUT_KEY, serializeLayout(saved));
  } catch {
    // Private mode: this visit still keeps it.
  }
}

/** A fresh desktop starts with icons only; stored window state follows the layout. The
 *  messenger's remembered flag is not restored (it never was). */
const savedOpen = loadSavedOpen();
let snapshot: HudSnapshot = {
  layout: load(),
  phone: false,
  open: { ...savedOpen, messenger: false, looks: false },
  officeTab: 'status',
  boardTab: 'status',
  order: ['office', 'messenger', 'notices', 'terminal', 'workbench', 'looks'],
  minimized: {},
};
const listeners = new Set<() => void>();

function update(next: Partial<HudSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

/** Run one windowModel step. */
function run(step: (s: WinState) => WinState): void {
  const next = step(snapshot);
  if (next !== snapshot) update(next);
}

export const hudSubscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const hudGetSnapshot = () => snapshot;
export const useHud = () => useSyncExternalStore(hudSubscribe, hudGetSnapshot);

// ── Windows (WINMODEL: the rules are windowModel.ts) ───────────

/** Open `id` in front, as it was (a minimized one comes back; on a phone, the only page). */
export const openWindow = (id: WindowId) => run((s) => openOrFocus(s, id));
/** The window's ×; on a phone, the page goes out of sight as it was. */
export const closeWindow = (id: WindowId) => run((s) => close(s, id));
export const leaveNoticesWindow = () => run(leaveNotices);
export const minimizeWindow = (id: WindowId) => run((s) => minimize(s, id));
/** A PC icon (taskbar rules). */
export const pressIcon = (icon: Icon) => run((s) => iconPress(s, icon));
/** The phone's home: every page out of sight, each kept. */
export const goHome = () => run(home);
/** The shell the windows render in (App, on every breakpoint crossing). */
export const setPhone = (phone: boolean) => run((s) => withPhone(s, phone));

/** A phone Dock tab, or Back (`atRoot` from the shown tab's store): the tab to take to its root, if any. */
export function pressTab(tab: Tab): Step['root'] {
  const step = tabPress(snapshot, tab);
  run(() => step.state);
  return step.root;
}
export function pressBack(atRoot: boolean): Step['root'] {
  const step = back(snapshot, atRoot);
  run(() => step.state);
  return step.root;
}

/** Open and not minimized: the messenger counts what is read by it. */
export const windowShown = (id: WindowId): boolean =>
  snapshot.open[id] && snapshot.minimized[id] !== true;

/** 최대화 / 원래 크기: the stored rect stays, a flag says it is filled. */
export function toggleMaximize(id: WindowId): void {
  change(id, { max: !snapshot.layout.items[id]?.max });
  openWindow(id);
}

/** A phone page's style: the last one touched is on top, a minimized one is out of sight (still mounted). */
export function usePageStyle(id: WindowId): CSSProperties {
  const { order, minimized } = useHud();
  return minimized[id] ? { display: 'none' } : { zIndex: 50 + order.indexOf(id) };
}

/** UI-C1: the tabs the window still has; a name from an older saved state (jobs, codex) is 현황판. */
export const OFFICE_TABS: readonly OfficeTab[] = ['status', 'hw', 'files'];
export const normalizeOfficeTab = (tab: unknown): OfficeTab =>
  OFFICE_TABS.find((id) => id === tab) ?? 'status';

/** Open the 현황판 window on `tab`, in front. */
export function showOffice(requested: OfficeTab): void {
  run((s) => openOrFocus(s, 'office', normalizeOfficeTab(requested)));
}

/** A phone starts on the office: no page restored from a stored desktop state. */
export function closePages(): void {
  update({
    open: {
      office: false,
      messenger: false,
      notices: false,
      terminal: false,
      workbench: false,
      looks: false,
    },
    minimized: {},
  });
}

// ── Layout ────────────────────────────────────────────────────

function change(id: string, entry: Partial<Entry>): void {
  const layout = withEntry(snapshot.layout, id, entry);
  save(layout);
  update({ layout });
}

export const setPlace = (id: string, place: Place | undefined) => change(id, { place });
export const setScale = (id: string, scale: ScaleStep) => change(id, { scale });
export const clearEntry = (id: string) => change(id, { place: undefined, scale: undefined });

// ── Presets (T-0111) ──────────────────────────────────────────

let hudBounds: Size | null = null;
/** The HUD layer reports its size, so a preset can place things for the screen it is on. */
export const setHudBounds = (size: Size | null) => void (hudBounds = size);

/**
 * 오른쪽 세로 / 아래 가로 / 작업용: icons and windows to where the preset puts them. Returns
 * which windows to open or close; nothing before the layer is measured.
 */
export function applyLayoutPreset(preset: Preset, icons: readonly string[]): void {
  if (!hudBounds) return;
  const result = applyPreset(snapshot.layout, preset, hudBounds, icons);
  save(result.layout);
  update({ layout: result.layout, minimized: {} });
  for (const [id, on] of Object.entries(result.open) as [WindowId, boolean | undefined][])
    if (on !== undefined) (on ? openWindow : closeWindow)(id);
}

/** 화면 배치 초기화: every position, size and scale back to the defaults. */
export function resetLayout(): void {
  const layout = emptyLayout();
  save(layout);
  update({ layout, minimized: {} });
}

/** Persist this device's floating-window open flags beside its layout. */
export function saveWindowState(open: WinState['open']): void {
  try {
    const layout = load();
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...layout, open }));
  } catch {
    // Private mode: this visit still remembers it.
  }
}

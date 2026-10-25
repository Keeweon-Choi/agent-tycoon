import { describe, expect, it } from 'vitest';

import { HUD_MAXIMIZED_Z, HUD_PANELS_Z } from '../../constants.js';
import {
  activeTab,
  back,
  close,
  home,
  iconPress,
  iconStatus,
  leaveNotices,
  minimize,
  openOrFocus,
  showsAgentCards,
  status,
  type Tab,
  tabPress,
  windowZ,
  type WinState,
  withPhone,
} from './windowModel.js';

const pc: WinState = {
  phone: false,
  open: {
    office: false,
    messenger: false,
    notices: false,
    terminal: false,
    workbench: false,
    looks: false,
  },
  minimized: {},
  order: ['office', 'messenger', 'notices', 'terminal', 'workbench', 'looks'],
  officeTab: 'status',
  boardTab: 'status',
};
const phone: WinState = { ...pc, phone: true };

const press = (s: WinState, ...icons: Parameters<typeof iconPress>[1][]) =>
  icons.reduce(iconPress, s);
const tabs = (s: WinState, ...ts: Tab[]) => ts.reduce((acc, t) => tabPress(acc, t).state, s);

describe('PC: window states', () => {
  it('closed, front, behind and minimized follow open, minimized and the z order', () => {
    const s = openOrFocus(openOrFocus(pc, 'office'), 'messenger');
    expect(status(s, 'notices')).toBe('closed');
    expect(status(s, 'messenger')).toBe('front');
    expect(status(s, 'office')).toBe('behind');
    const m = minimize(s, 'messenger');
    expect(status(m, 'messenger')).toBe('minimized');
    expect(status(m, 'office')).toBe('front'); // the next one down comes to front
  });

  it('opening one window keeps every other one as it was (owner 10-24: switching closed others)', () => {
    const s = openOrFocus(minimize(openOrFocus(pc, 'workbench'), 'workbench'), 'messenger');
    const t = openOrFocus(s, 'notices');
    expect(t.open).toMatchObject({ workbench: true, messenger: true, notices: true });
    expect(t.minimized).toEqual({ workbench: true });
    expect(status(t, 'messenger')).toBe('behind');
  });

  it('an already-front window is the same state (no re-render on every click into it)', () => {
    const s = openOrFocus(pc, 'notices');
    expect(openOrFocus(s, 'notices')).toBe(s);
  });

  it('close is the only way to closed, and it touches no other window', () => {
    const s = openOrFocus(openOrFocus(pc, 'office'), 'notices');
    const c = close(minimize(s, 'notices'), 'notices');
    expect(status(c, 'notices')).toBe('closed');
    expect(c.minimized).toEqual({});
    expect(status(c, 'office')).toBe('front');
  });
});

describe('PC: the icons are a Windows taskbar', () => {
  it('gray opens in front, filled minimizes, the next press restores the same state', () => {
    const open = press(pc, 'messenger');
    expect(iconStatus(open, 'messenger')).toBe('front');
    const min = press(open, 'messenger');
    expect(iconStatus(min, 'messenger')).toBe('minimized');
    expect(min.open.messenger).toBe(true); // still mounted: conversation and scroll kept
    const back = press(min, 'messenger');
    expect(iconStatus(back, 'messenger')).toBe('front');
    expect(back.open).toEqual(open.open);
  });

  it('an outline icon (open, behind) comes to front and nothing else changes', () => {
    const s = press(pc, 'messenger', 'notices');
    expect(iconStatus(s, 'messenger')).toBe('behind');
    const t = press(s, 'messenger');
    expect(iconStatus(t, 'messenger')).toBe('front');
    expect(iconStatus(t, 'notices')).toBe('behind'); // not closed, not minimized
  });

  it('no icon press ever closes a window', () => {
    let s = pc;
    for (const icon of ['office', 'files', 'messenger', 'notices', 'terminal', 'workbench'] as const)
      for (let i = 0; i < 4; i++) {
        s = iconPress(s, icon);
        expect(s.open[icon === 'files' ? 'office' : icon]).toBe(true);
      }
  });

  it('the board and files icons share one window, each lit only in its own mode', () => {
    const board = press(pc, 'office');
    expect(iconStatus(board, 'office')).toBe('front');
    expect(iconStatus(board, 'files')).toBe('closed');
    const files = press(board, 'files');
    expect(files.officeTab).toBe('files');
    expect(iconStatus(files, 'files')).toBe('front');
    expect(iconStatus(files, 'office')).toBe('closed');
    // The board icon over 파일 brings the board back on its last tab.
    const hw = openOrFocus(pc, 'office', 'hw');
    expect(press(hw, 'files', 'office').officeTab).toBe('hw');
    expect(press(hw, 'files', 'files').minimized.office).toBe(true);
  });
});

describe('phone: the Dock is a tab bar', () => {
  it('one page shows at a time; the others stay open, minimized, as they were', () => {
    const s = tabs(phone, 'messenger', 'workbench');
    expect(activeTab(s)).toBe('workbench');
    expect(s.open).toMatchObject({ messenger: true, workbench: true });
    expect(s.minimized).toEqual({ messenger: true });
    const t = tabs(s, 'messenger');
    expect(activeTab(t)).toBe('messenger');
    expect(t.minimized).toEqual({ workbench: true });
  });

  it('the shown tab pressed again goes to its root (like iOS); its state is the store`s to reset', () => {
    const s = tabs(phone, 'messenger');
    expect(tabPress(s, 'messenger')).toEqual({ state: s, root: 'messenger' });
    expect(tabPress(s, 'workbench').root).toBeUndefined();
  });

  it('the office tab is home: every page out of sight, none closed', () => {
    const s = tabs(phone, 'messenger', 'notices', 'office');
    expect(activeTab(s)).toBe('office');
    expect(s.open).toMatchObject({ messenger: true, notices: true });
    expect(tabPress(s, 'office').state).toBe(s);
  });

  it('board and files are two tabs of one window; the board comes back on its own tab', () => {
    const hw = openOrFocus(phone, 'office', 'hw');
    expect(activeTab(hw)).toBe('board');
    const files = tabs(hw, 'files');
    expect(activeTab(files)).toBe('files');
    expect(tabs(files, 'board').officeTab).toBe('hw');
  });

  it('a Dock press after another window keeps that window`s state (owner 10-24: Dock presses reset)', () => {
    const hw = openOrFocus(phone, 'office', 'hw');
    const s = tabs(hw, 'messenger', 'board');
    expect(s.officeTab).toBe('hw');
    expect(s.open.messenger).toBe(true);
  });

  it('close on a phone is home, never an unmount (no close on the phone)', () => {
    const s = tabs(phone, 'messenger');
    const c = close(s, 'messenger');
    expect(activeTab(c)).toBe('office');
    expect(c.open.messenger).toBe(true);
    expect(close(phone, 'notices')).toBe(phone);
  });

  it('a notice opening the messenger while the notice page closes keeps the messenger (owner 10-24)', () => {
    const notices = tabs(phone, 'notices');
    // Whichever order the two land in.
    const a = close(openOrFocus(notices, 'messenger'), 'notices');
    const b = openOrFocus(close(notices, 'notices'), 'messenger');
    for (const s of [a, b]) {
      expect(activeTab(s)).toBe('messenger');
      expect(s.open.messenger).toBe(true);
    }
  });

  it('the cards show only on the office home', () => {
    expect(showsAgentCards('office', 'office')).toBe(true);
    expect(showsAgentCards('office', 'terminal')).toBe(false);
    expect(showsAgentCards('messenger', 'office')).toBe(false);
    expect(activeTab(openOrFocus(phone, 'looks'))).toBe('looks');
  });
});

describe('phone: Back steps inside the tab, then home', () => {
  it('a conversation goes to the list, then the office home, then nothing (the browser leaves)', () => {
    const s = tabs(phone, 'notices', 'messenger');
    const inConversation = back(s, false);
    expect(inConversation).toEqual({ state: s, root: 'messenger' });
    const atList = back(inConversation.state, true);
    expect(activeTab(atList.state)).toBe('office');
    expect(atList.root).toBeUndefined();
    // Nothing else closed or reset: both pages come back as they were.
    expect(atList.state.open).toMatchObject({ messenger: true, notices: true });
    expect(back(atList.state, true)).toEqual({ state: atList.state });
  });
});

describe('crossing the breakpoint', () => {
  it('to the phone only the front window stays in sight; back to the PC nothing changes', () => {
    const s = openOrFocus(openOrFocus(pc, 'office'), 'messenger');
    const p = withPhone(s, true);
    expect(activeTab(p)).toBe('messenger');
    expect(p.minimized).toEqual({ office: true });
    expect(withPhone(p, false)).toEqual({ ...p, phone: false });
    expect(withPhone(pc, false)).toBe(pc);
    expect(home(pc)).toBe(pc);
  });
});

describe('window layers (WINDOW-LAYERS)', () => {
  const s: WinState = { ...pc, order: ['messenger', 'terminal', 'office'] };

  it('normal windows go by order, all under the fixed panels', () => {
    const z = (['messenger', 'terminal', 'office'] as const).map((id) => windowZ(s, id, false));
    expect(z).toEqual([1, 2, 3]);
    expect(Math.max(...z)).toBeLessThan(HUD_PANELS_Z);
  });

  it('a maximized window is over the panels, whatever its place in the order', () => {
    expect(windowZ(s, 'messenger', true)).toBeGreaterThan(HUD_PANELS_Z);
    expect(windowZ(s, 'messenger', true)).toBeGreaterThan(HUD_PANELS_Z + 5);
    expect(windowZ(s, 'messenger', true)).toBe(HUD_MAXIMIZED_Z + 1);
  });

  it('restoring puts the window back under the panels at its old place in the order', () => {
    expect(windowZ(s, 'terminal', false)).toBe(2);
  });
});

describe('NOTICE-STACK: opening from the notice window', () => {
  it('PC: the notice window stays where it is and the target opens on top of it', () => {
    const s = openOrFocus(openOrFocus(pc, 'messenger'), 'notices');
    const t = openOrFocus(leaveNotices(s), 'messenger');
    expect(status(t, 'notices')).toBe('behind');
    expect(status(t, 'messenger')).toBe('front');
    expect(windowZ(t, 'messenger', false)).toBeGreaterThan(windowZ(t, 'notices', false));
    const w = openOrFocus(leaveNotices(openOrFocus(pc, 'notices')), 'workbench'); // a closed target opens
    expect(status(w, 'notices')).toBe('behind');
    expect(status(w, 'workbench')).toBe('front');
  });

  it('phone: the page goes out of sight as it was and the target shows alone', () => {
    const s = openOrFocus(phone, 'notices');
    const t = openOrFocus(leaveNotices(s), 'messenger');
    expect(status(t, 'notices')).toBe('minimized');
    expect(activeTab(t)).toBe('messenger');
    expect(tabPress(t, 'notices').state.minimized.notices).toBeUndefined(); // its tab returns to it
  });
});

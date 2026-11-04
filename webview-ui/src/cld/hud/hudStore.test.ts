import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyPreset, LAYOUT_KEY, serializeLayout } from './layout.js';

/** A Map-backed localStorage for the store's load at import time. */
function seedStorage(entries: Record<string, string>): void {
  const map = new Map(Object.entries(entries));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('hudStore load (owner 10-24: the files icon)', () => {
  it('a bottom row saved before the files icon gets it right after the terminal icon', async () => {
    const old = applyPreset({ v: 1, items: {} }, 'bottom', { w: 1200, h: 800 }, [
      'office',
      'messenger',
      'notices',
      'terminal',
    ]).layout;
    seedStorage({ [LAYOUT_KEY]: serializeLayout(old) });
    const { hudGetSnapshot } = await import('./hudStore.js');
    const { items } = hudGetSnapshot().layout;
    const terminal = old.items['icon:terminal']!.place!;
    expect(items['icon:files']?.place).toEqual({
      corner: 'bl',
      dx: terminal.dx + 48,
      dy: terminal.dy,
    });
    expect(items['icon:terminal']).toEqual(old.items['icon:terminal']);
  });
});

describe('UI-DASH: the workbench is the status board dev tab', () => {
  it('a desktop saved with the workbench open opens the status board', async () => {
    seedStorage({ [LAYOUT_KEY]: JSON.stringify({ v: 1, items: {}, open: { workbench: true } }) });
    const { hudGetSnapshot } = await import('./hudStore.js');
    expect(hudGetSnapshot().open.office).toBe(true);
  });
});

describe('UI-C1: the status board window has status board, development and (from the folder icon) files', () => {
  it('a tab name from an older state (jobs, codex, hw) opens the status board', async () => {
    seedStorage({});
    const { hudGetSnapshot, showOffice, normalizeOfficeTab } = await import('./hudStore.js');
    // building-a-1104: the HW tab is gone (the lobby board's full H/W screen replaced it).
    for (const old of ['jobs', 'codex', 'hw', 'nope', undefined]) expect(normalizeOfficeTab(old)).toBe('status');
    for (const tab of ['status', 'dev', 'files'] as const) expect(normalizeOfficeTab(tab)).toBe(tab);
    showOffice('codex' as never);
    expect(hudGetSnapshot()).toMatchObject({ officeTab: 'status', boardTab: 'status' });
    showOffice('hw' as never); // a request from outside (old link, test hook, stored state)
    expect(hudGetSnapshot()).toMatchObject({ officeTab: 'status', boardTab: 'status' });
  });

  it('the board icon leaves the files mode for the last board tab; the front one minimizes', async () => {
    seedStorage({});
    const { hudGetSnapshot, showOffice, pressIcon } = await import('./hudStore.js');
    showOffice('dev');
    pressIcon('files');
    expect(hudGetSnapshot()).toMatchObject({ officeTab: 'files', open: { office: true } });
    pressIcon('office');
    expect(hudGetSnapshot()).toMatchObject({ officeTab: 'dev', open: { office: true } });
    pressIcon('office'); // in front: minimized, not closed, its tab kept
    expect(hudGetSnapshot()).toMatchObject({
      officeTab: 'dev',
      open: { office: true },
      minimized: { office: true },
    });
    pressIcon('office');
    expect(hudGetSnapshot().minimized.office).toBeUndefined();
  });
});

describe('WINMODEL: the store runs the model, the messenger included', () => {
  it('a window opened while another is minimized leaves it as it was; closing is the x only', async () => {
    seedStorage({});
    const { hudGetSnapshot, minimizeWindow, openWindow, closeWindow, showOffice } = await import(
      './hudStore.js'
    );
    showOffice('dev');
    openWindow('devroom');
    minimizeWindow('office');
    openWindow('notices');
    expect(hudGetSnapshot()).toMatchObject({
      open: { office: true, devroom: true, notices: true },
      minimized: { office: true },
    });
    openWindow('office');
    const snap = hudGetSnapshot();
    expect(snap.minimized.office).toBeUndefined();
    expect(snap.officeTab).toBe('dev');
    expect(snap.order.at(-1)).toBe('office');
    closeWindow('office');
    expect(hudGetSnapshot().open).toMatchObject({ office: false, devroom: true, notices: true });
  });

  it('a notice opening the messenger as the notice window closes keeps the messenger open', async () => {
    seedStorage({});
    const { hudGetSnapshot, openWindow, closeWindow } = await import('./hudStore.js');
    const { openMessenger, messengerGetSnapshot, messengerShowing } = await import(
      '../messenger/messengerStore.js'
    );
    openWindow('notices');
    openMessenger(7);
    closeWindow('notices');
    expect(hudGetSnapshot().open).toMatchObject({ messenger: true, notices: false });
    expect(messengerGetSnapshot().active).toBe(7);
    expect(messengerShowing(7)).toBe(true);
  });

  it('on a phone a Dock tab press keeps the conversation; the open tab goes to its list', async () => {
    seedStorage({});
    const { hudGetSnapshot, pressTab, setPhone } = await import('./hudStore.js');
    const { openMessenger, messengerGetSnapshot, messengerShowing } = await import(
      '../messenger/messengerStore.js'
    );
    setPhone(true);
    openMessenger(7);
    expect(pressTab('devroom')).toBeUndefined();
    expect(messengerShowing(7)).toBe(false); // out of sight: not being read
    expect(hudGetSnapshot()).toMatchObject({ open: { messenger: true }, minimized: { messenger: true } });
    expect(pressTab('messenger')).toBeUndefined();
    expect(messengerGetSnapshot().active).toBe(7);
    expect(messengerShowing(7)).toBe(true);
    expect(pressTab('messenger')).toBe('messenger'); // the caller shows the list
  });
});

describe('REDEPLOY-STATE: a reload opens no window by itself', () => {
  it('a window minimized before the reload comes back minimized, not in front', async () => {
    const map = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    });
    const first = await import('./hudStore.js');
    first.openWindow('devroom');
    first.showOffice('status');
    first.pressIcon('devroom'); // behind the board: to front
    first.pressIcon('devroom'); // in front: minimized
    first.saveWindowState(first.hudGetSnapshot().open, first.hudGetSnapshot().minimized);
    vi.resetModules();
    const { hudGetSnapshot } = await import('./hudStore.js');
    expect(hudGetSnapshot()).toMatchObject({
      open: { devroom: true, office: true },
      minimized: { devroom: true },
    });
    expect(hudGetSnapshot().minimized.office).toBeUndefined();
  });
});

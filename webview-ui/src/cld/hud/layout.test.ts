import { describe, expect, it } from 'vitest';

import {
  applyPreset,
  clampPlace,
  clampRect,
  cssAnchor,
  defaultWindowPlace,
  DRAG_THRESHOLD_PX,
  exceedsDragThreshold,
  FREE_PLACEMENT,
  GRID_PX,
  HANDLES,
  ICON_ROW_PX,
  keepTitleGrabbable,
  type Layout,
  maximizedPlace,
  migrateSavedWindowIds,
  moveRect,
  nearestCorner,
  parseLayout,
  placeFromRect,
  presetLayoutOnly,
  RAIL_PX,
  type Rect,
  rectFromPlace,
  resizeRect,
  serializeLayout,
  SNAP_EDGE_PX,
  snapMoveRect,
  snapResizeRect,
  snapToGrid,
  TITLE_BAR_PX,
  TITLE_GRAB_PX,
  WINDOW_MIN,
  windowIsFree,
  withEntry,
  withNewIcons,
} from './layout.js';

const screen = { w: 1280, h: 800 };

describe('saved HUD ids', () => {
  const legacyId = 'h' + 'ub';
  const legacyPlace = { corner: 'tl' as const, dx: 41, dy: 52, w: 403, h: 301 };

  it('moves every saved window field to office and drops the old key', () => {
    const saved = {
      v: 1,
      items: { [legacyId]: { place: legacyPlace } },
      open: { [legacyId]: true },
      minimized: { [legacyId]: true },
      order: [legacyId, 'terminal'],
    };
    const migrated = migrateSavedWindowIds(saved) as typeof saved;
    expect(migrated.items).toEqual({ office: { place: legacyPlace } });
    expect(migrated.open).toEqual({ office: true });
    expect(migrated.minimized).toEqual({ office: true });
    expect(migrated.order).toEqual(['office', 'terminal']);
    expect(parseLayout(JSON.stringify(saved)).items).toEqual({ office: { place: legacyPlace } });
    expect(legacyId in parseLayout(JSON.stringify(saved)).items).toBe(false);
  });

  it('keeps the office value when both current and legacy ids are stored', () => {
    const currentPlace = { corner: 'br' as const, dx: 7, dy: 8, w: 280, h: 190 };
    const layout = parseLayout(
      JSON.stringify({
        v: 1,
        items: { [legacyId]: { place: legacyPlace }, office: { place: currentPlace } },
      }),
    );
    expect(layout.items.office).toEqual({ place: currentPlace });
    expect(legacyId in layout.items).toBe(false);
  });
});

describe('corner anchoring', () => {
  it('stores a rect against the nearest corner of the screen', () => {
    const at = (x: number, y: number) => ({ x, y, w: 40, h: 40 });
    expect(nearestCorner(at(10, 10), screen)).toBe('tl');
    expect(nearestCorner(at(1200, 10), screen)).toBe('tr');
    expect(nearestCorner(at(10, 700), screen)).toBe('bl');
    expect(nearestCorner(at(1200, 700), screen)).toBe('br');
  });

  it('measures the distance to the same corner of the rect', () => {
    expect(placeFromRect({ x: 1200, y: 20, w: 40, h: 40 }, screen)).toEqual({
      corner: 'tr',
      dx: 40,
      dy: 20,
    });
    expect(placeFromRect({ x: 1200, y: 700, w: 40, h: 40 }, screen)).toEqual({
      corner: 'br',
      dx: 40,
      dy: 60,
    });
    expect(placeFromRect({ x: 100, y: 200, w: 300, h: 400 }, screen, true)).toEqual({
      corner: 'tl',
      dx: 100,
      dy: 200,
      w: 300,
      h: 400,
    });
  });

  it('round-trips through every corner', () => {
    for (const rect of [
      { x: 5, y: 6, w: 50, h: 60 },
      { x: 1100, y: 6, w: 50, h: 60 },
      { x: 5, y: 700, w: 50, h: 60 },
      { x: 1100, y: 700, w: 50, h: 60 },
    ]) {
      const place = placeFromRect(rect, screen);
      expect(rectFromPlace(place, rect, screen)).toEqual(rect);
    }
  });

  it('keeps a right-anchored thing against the right edge when the screen narrows', () => {
    const place = placeFromRect({ x: 1200, y: 20, w: 40, h: 40 }, screen);
    const narrow = { w: 800, h: 800 };
    expect(rectFromPlace(place, { w: 40, h: 40 }, narrow).x).toBe(720);
  });

  it('turns a place into CSS offsets on its corner', () => {
    expect(cssAnchor({ corner: 'br', dx: 8, dy: 9, w: 300, h: 200 })).toEqual({
      right: 8,
      bottom: 9,
      width: 300,
      height: 200,
    });
    expect(cssAnchor({ corner: 'tl', dx: 1, dy: 2 })).toEqual({ left: 1, top: 2 });
  });
});

describe('clamping into a smaller viewport', () => {
  it('pulls a rect back inside', () => {
    expect(clampRect({ x: 1000, y: 700, w: 100, h: 100 }, { w: 500, h: 400 })).toEqual({
      x: 400,
      y: 300,
      w: 100,
      h: 100,
    });
    expect(clampRect({ x: -50, y: -9, w: 100, h: 100 }, screen)).toMatchObject({ x: 0, y: 0 });
  });

  it('shrinks a window bigger than the room, but never below the minimum while there is room', () => {
    const big = { x: 0, y: 0, w: 900, h: 700 };
    expect(clampRect(big, { w: 600, h: 500 })).toEqual({ x: 0, y: 0, w: 600, h: 500 });
    expect(clampRect({ x: 0, y: 0, w: 100, h: 50 }, screen, { w: 280, h: 180 })).toMatchObject({
      w: 280,
      h: 180,
    });
    // A phone narrower than the minimum: the screen wins.
    expect(clampRect(big, { w: 200, h: 500 }, { w: 280, h: 180 }).w).toBe(200);
  });

  it('keeps a stored place on its corner and brings the offsets inside', () => {
    const stored = { corner: 'tr' as const, dx: 700, dy: 30, w: 360, h: 500 };
    const out = clampPlace(stored, { w: 0, h: 0 }, { w: 800, h: 400 });
    expect(out.corner).toBe('tr');
    const rect = rectFromPlace(out, { w: 0, h: 0 }, { w: 800, h: 400 });
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(800);
    expect(rect.y + rect.h).toBeLessThanOrEqual(400);
    expect(out.h).toBe(400);
  });

  it('leaves an icon (no stored size) at its measured size', () => {
    const out = clampPlace({ corner: 'br', dx: 900, dy: 5 }, { w: 40, h: 40 }, { w: 393, h: 852 });
    expect(out).toEqual({ corner: 'br', dx: 353, dy: 5 });
  });

  it('leaves a place that fits alone', () => {
    const stored = { corner: 'tl' as const, dx: 20, dy: 30, w: 300, h: 200 };
    expect(clampPlace(stored, { w: 0, h: 0 }, screen)).toEqual(stored);
  });
});

describe('moving and resizing', () => {
  it('moves a rect and stops at the screen edge', () => {
    const r = { x: 100, y: 100, w: 200, h: 100 };
    expect(moveRect(r, 50, -30, screen)).toMatchObject({ x: 150, y: 70 });
    expect(moveRect(r, 5000, 5000, screen)).toMatchObject({ x: 1080, y: 700 });
    expect(moveRect(r, -5000, -5000, screen)).toMatchObject({ x: 0, y: 0 });
  });

  it('grows from the bottom-right corner, the top-left stays', () => {
    const r = { x: 100, y: 100, w: 300, h: 200 };
    expect(resizeRect(r, 'se', 40, 60, screen)).toEqual({ x: 100, y: 100, w: 340, h: 260 });
  });

  it('resizes from the left and top edges with the opposite side fixed', () => {
    const r = { x: 100, y: 100, w: 300, h: 200 };
    expect(resizeRect(r, 'w', -50, 0, screen)).toEqual({ x: 50, y: 100, w: 350, h: 200 });
    expect(resizeRect(r, 'n', 0, 15, screen)).toEqual({ x: 100, y: 115, w: 300, h: 185 });
  });

  it('stops at the minimum size and at the screen', () => {
    const r = { x: 100, y: 100, w: 300, h: 200 };
    expect(resizeRect(r, 'se', -900, -900, screen)).toMatchObject({ w: 280, h: 180 });
    expect(resizeRect(r, 'w', 900, 0, screen)).toMatchObject({ x: 120, w: 280 });
    expect(resizeRect(r, 'se', 9000, 9000, screen)).toMatchObject({ w: 1180, h: 700 });
    expect(resizeRect(r, 'nw', -9000, -9000, screen)).toMatchObject({ x: 0, y: 0 });
  });
});

describe('drag threshold', () => {
  it('stays a click until the pointer travelled past the threshold', () => {
    expect(exceedsDragThreshold(0, 0)).toBe(false);
    expect(exceedsDragThreshold(DRAG_THRESHOLD_PX, 0)).toBe(false);
    expect(exceedsDragThreshold(4, 4)).toBe(false); // 5.7 px
    expect(exceedsDragThreshold(5, 5)).toBe(true); // 7.1 px
    expect(exceedsDragThreshold(0, -DRAG_THRESHOLD_PX - 1)).toBe(true);
  });
});

describe('stored layout', () => {
  const layout: Layout = {
    v: 1,
    items: {
      office: { place: { corner: 'tr', dx: 64, dy: 8, w: 360, h: 500 }, scale: 2 },
      'icon-bell': { place: { corner: 'bl', dx: 10, dy: 12 } },
    },
  };

  it('round-trips', () => {
    expect(parseLayout(serializeLayout(layout))).toEqual(layout);
  });

  it('gives the defaults for a missing or corrupt value', () => {
    const empty = { v: 1, items: {} };
    expect(parseLayout(null)).toEqual(empty);
    expect(parseLayout(undefined)).toEqual(empty);
    expect(parseLayout('')).toEqual(empty);
    expect(parseLayout('{not json')).toEqual(empty);
    expect(parseLayout('42')).toEqual(empty);
    expect(parseLayout('null')).toEqual(empty);
    expect(parseLayout('{"v":2,"items":{}}')).toEqual(empty);
    expect(parseLayout('{"v":1,"items":[]}')).toEqual(empty);
    expect(parseLayout('{"v":1}')).toEqual(empty);
  });

  it('drops a bad entry and keeps the good ones', () => {
    const raw = JSON.stringify({
      v: 1,
      items: {
        good: { place: { corner: 'tl', dx: 1, dy: 2 } },
        badCorner: { place: { corner: 'middle', dx: 1, dy: 2 } },
        nan: { place: { corner: 'tl', dx: 'x', dy: 2 } },
        huge: { place: { corner: 'tl', dx: 1e12, dy: 2 } },
        notObject: 7,
        badScale: { scale: 9 },
        scaleOnly: { scale: 0 },
        badSize: { place: { corner: 'tr', dx: 1, dy: 2, w: -5, h: 'a' } },
      },
    });
    expect(parseLayout(raw).items).toEqual({
      good: { place: { corner: 'tl', dx: 1, dy: 2 } },
      scaleOnly: { scale: 0 },
      badSize: { place: { corner: 'tr', dx: 1, dy: 2 } },
    });
  });

  it('changes one entry and drops it when nothing is left to remember', () => {
    const moved = withEntry(layout, 'office', { place: { corner: 'tl', dx: 5, dy: 5 } });
    expect(moved.items.office).toEqual({ place: { corner: 'tl', dx: 5, dy: 5 }, scale: 2 });
    expect(withEntry(layout, 'office', { scale: 1 }).items.office?.scale).toBeUndefined();
    const cleared = withEntry(withEntry(layout, 'icon-bell', { place: undefined }), 'office', {
      place: undefined,
      scale: undefined,
    });
    expect(cleared.items).toEqual({});
    expect(layout.items['icon-bell']).toBeDefined(); // the input is not mutated
  });
});

describe('default window places', () => {
  it('opens against the right edge beside the icon column, tall, inside the screen', () => {
    for (const id of ['office', 'messenger', 'notices', 'terminal'] as const) {
      const place = defaultWindowPlace(id, screen);
      const rect = rectFromPlace(place, { w: 0, h: 0 }, screen);
      expect(place.corner).toBe('tr');
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(screen.w - 56);
      expect(rect.y + rect.h).toBeLessThanOrEqual(screen.h);
    }
  });

  it('cascades the windows so a later one does not hide the earlier title bars', () => {
    const office = rectFromPlace(defaultWindowPlace('office', screen), { w: 0, h: 0 }, screen);
    const terminal = rectFromPlace(defaultWindowPlace('terminal', screen), { w: 0, h: 0 }, screen);
    expect(terminal.y).toBeGreaterThan(office.y);
    expect(terminal.y + terminal.h).toBeLessThanOrEqual(screen.h);
  });

  it('opens the \ud30c\uc77c tab wide and shrinks to a narrow screen', () => {
    expect(defaultWindowPlace('office', screen, true).w).toBeGreaterThan(
      defaultWindowPlace('office', screen).w!,
    );
    expect(defaultWindowPlace('terminal', { w: 500, h: 600 }).w).toBeLessThanOrEqual(500);
  });
});

describe('snapping (T-0111)', () => {
  const win = { w: 300, h: 200 };

  it('puts a moved rect on the 8 px grid', () => {
    const r = snapMoveRect({ x: 203, y: 317, ...win }, screen);
    expect(r.x % GRID_PX).toBe(0);
    expect(r.y % GRID_PX).toBe(0);
    expect(r).toMatchObject({ x: 200, y: 320, ...win });
    expect(snapToGrid(13)).toBe(16);
    expect(snapToGrid(11)).toBe(8);
  });

  it('sticks an edge to the screen edge within 12 px, and not beyond', () => {
    expect(snapMoveRect({ x: 10, y: 400, ...win }, screen).x).toBe(0);
    expect(snapMoveRect({ x: 1280 - 300 - 11, y: 400, ...win }, screen).x).toBe(980);
    expect(snapMoveRect({ x: 1, y: 797 - 200, ...win }, screen).y).toBe(600);
    // 13 px away is out of range: it takes the grid (16), not the edge
    expect(snapMoveRect({ x: SNAP_EDGE_PX + 1, y: 400, ...win }, screen).x).toBe(16);
  });

  it('prefers the edge over the grid when both are close', () => {
    // x = 5 is 3 px from the grid line 8 but 5 px from the edge: the edge wins
    expect(snapMoveRect({ x: 5, y: 400, ...win }, screen).x).toBe(0);
  });

  it('sticks to another window by either of its edges', () => {
    const other = { x: 500, y: 100, w: 200, h: 300 };
    // my right edge beside its left edge
    expect(snapMoveRect({ x: 193, y: 400, ...win }, screen, [other]).x).toBe(200);
    // my left edge against its right edge (700)
    expect(snapMoveRect({ x: 707, y: 400, ...win }, screen, [other]).x).toBe(700);
    // my top against its bottom (400)
    expect(snapMoveRect({ x: 600, y: 405, ...win }, screen, [other]).y).toBe(400);
  });

  it('keeps a snapped rect on screen', () => {
    const r = snapMoveRect({ x: -50, y: 900, ...win }, screen);
    expect(r.x).toBe(0);
    expect(r.y + r.h).toBeLessThanOrEqual(screen.h);
  });

  it('snaps only the edges a resize handle moves', () => {
    const from = { x: 100, y: 100, w: 300, h: 200 };
    const raw = resizeRect(from, 'se', 45, 37, screen);
    const r = snapResizeRect(raw, 'se', screen);
    expect(r.x).toBe(100);
    expect(r.y).toBe(100);
    expect((r.x + r.w) % GRID_PX).toBe(0);
    expect((r.y + r.h) % GRID_PX).toBe(0);
    expect(r.w).toBe(348); // right edge 445 -> 448
    expect(r.h).toBe(236); // bottom edge 337 -> 336
  });

  it('snaps a resized edge to the screen edge and to another window', () => {
    const from = { x: 100, y: 100, w: 300, h: 200 };
    expect(snapResizeRect({ ...from, w: 1275 - 100 }, 'e', screen).w).toBe(1180);
    const other = { x: 600, y: 0, w: 100, h: 800 };
    expect(snapResizeRect({ ...from, w: 497 }, 'e', screen, [other]).w).toBe(500);
    // from the west handle the right edge stays where it is
    const west = snapResizeRect({ x: 103, y: 100, w: 297, h: 200 }, 'w', screen);
    expect(west.x + west.w).toBe(400);
    expect(west.x).toBe(104);
  });

  it('lets the minimum size win over the grid', () => {
    const r = snapResizeRect({ x: 100, y: 100, w: 280, h: 180 }, 'se', screen);
    expect(r.w).toBeGreaterThanOrEqual(280);
    expect(r.h).toBeGreaterThanOrEqual(180);
    const tiny = snapResizeRect({ x: 100, y: 100, w: 200, h: 100 }, 'se', screen);
    expect(tiny.w).toBe(280);
    expect(tiny.h).toBe(180);
  });
});

describe('maximize (T-0111)', () => {
  it('maximizes to the whole room under the top bar (the panels draw over the window then)', () => {
    expect(maximizedPlace(screen)).toEqual({ corner: 'tl', dx: 0, dy: 0, w: screen.w, h: 800 });
    const r = rectFromPlace(maximizedPlace(screen), { w: 0, h: 0 }, screen);
    expect(r).toEqual({ x: 0, y: 0, w: screen.w, h: screen.h });
  });

  it('remembers a maximized window in the layout and drops the flag when it is undone', () => {
    const placed = withEntry(
      withEntry({ v: 1, items: {} }, 'office', {
        place: { corner: 'tl', dx: 5, dy: 5, w: 400, h: 300 },
      }),
      'office',
      { max: true },
    );
    expect(placed.items.office?.max).toBe(true);
    expect(placed.items.office?.place?.w).toBe(400); // the rect it returns to
    expect(parseLayout(serializeLayout(placed)).items.office?.max).toBe(true);
    const back = withEntry(placed, 'office', { max: false });
    expect(back.items.office?.max).toBeUndefined();
    expect(back.items.office?.place?.w).toBe(400);
    // maximized from the default place: undoing it leaves nothing stored
    expect(
      withEntry(withEntry({ v: 1, items: {} }, 'office', { max: true }), 'office', { max: false })
        .items,
    ).toEqual({});
  });

  it('ignores a malformed max flag', () => {
    const raw = JSON.stringify({ v: 1, items: { office: { max: 'yes' }, notices: { max: true } } });
    const layout = parseLayout(raw);
    expect(layout.items.office).toBeUndefined();
    expect(layout.items.notices?.max).toBe(true);
  });
});

describe('icons newer than a saved layout (owner 10-24: the files icon)', () => {
  const screen = { w: 1200, h: 800 };
  const old = ['office', 'messenger', 'notices', 'terminal'];

  it('a saved bottom row gets the files icon in the next slot, on the same line', () => {
    const saved = applyPreset({ v: 1, items: {} }, 'bottom', screen, old).layout;
    expect(saved.items['icon:files']).toBeUndefined();
    const loaded = withNewIcons(presetLayoutOnly(parseLayout(serializeLayout(saved))));
    const last = saved.items['icon:terminal']!.place!;
    expect(loaded.items['icon:files']?.place).toEqual({
      corner: 'bl',
      dx: last.dx + 48,
      dy: last.dy,
    });
    for (const id of old) expect(loaded.items[`icon:${id}`]).toEqual(saved.items[`icon:${id}`]);
  });

  it('W1: the workbench icon follows the files icon in a row saved without it', () => {
    const saved = applyPreset({ v: 1, items: {} }, 'bottom', screen, [...old, 'files']).layout;
    const loaded = withNewIcons(saved);
    expect(loaded.items['icon:workbench']?.place).toEqual({
      corner: 'bl',
      dx: saved.items['icon:files']!.place!.dx + 48,
      dy: saved.items['icon:files']!.place!.dy,
    });
  });

  it('a row that has it already, the right column and no preset are left alone (the icon flows in the column)', () => {
    const withFiles = applyPreset({ v: 1, items: {} }, 'bottom', screen, [
      ...old,
      'files',
      'workbench',
    ]).layout;
    expect(withNewIcons(withFiles)).toEqual(withFiles);
    const right = applyPreset({ v: 1, items: {} }, 'right', screen, old).layout;
    expect(withNewIcons(right)).toEqual(right);
    expect(withNewIcons({ v: 1, items: {} })).toEqual({ v: 1, items: {} });
  });
});

describe('layout presets (T-0111)', () => {
  const icons = ['office', 'messenger', 'notices', 'terminal'];
  const messy: Layout = {
    v: 1,
    items: {
      'icon:office': { place: { corner: 'bl', dx: 300, dy: 300 } },
      office: { place: { corner: 'tl', dx: 5, dy: 5, w: 400, h: 300 }, max: true },
      usage: { place: { corner: 'tr', dx: 9, dy: 9 } },
    },
  };

  it('\uc624\ub978\ucabd \uc138\ub85c is the default: every free placement goes back (U-29)', () => {
    const { layout, open } = applyPreset(messy, 'right', screen, icons);
    expect(layout).toEqual({ v: 1, items: {}, preset: 'right' });
    expect(open).toEqual({});
  });

  it('\uc544\ub798 \uac00\ub85c puts the icons in a row at the bottom centre, in the bottom strip', () => {
    const { layout } = applyPreset(messy, 'bottom', screen, icons);
    const rects = icons.map((id) => {
      const place = layout.items[`icon:${id}`]?.place;
      if (!place) throw new Error(`no place for ${id}`);
      return rectFromPlace(place, { w: 40, h: 40 }, screen);
    });
    expect(new Set(rects.map((r) => r.y)).size).toBe(1);
    expect(rects[0].y + 40).toBeGreaterThan(screen.h - ICON_ROW_PX);
    expect(rects[3].y + 40).toBeLessThanOrEqual(screen.h);
    for (let i = 1; i < rects.length; i++) expect(rects[i].x).toBe(rects[i - 1].x + 48);
    const left = rects[0].x;
    const right = rects[3].x + 40;
    expect(Math.abs(left + right - screen.w)).toBeLessThanOrEqual(GRID_PX); // centred
    expect(layout.items.office).toBeUndefined(); // the window is back at its default
    expect(layout.items.usage).toBeUndefined(); // a free placement of another widget goes (U-29)
    expect(layout.preset).toBe('bottom');
  });

  it('\uc544\ub798 \uac00\ub85c centres only the icons that exist', () => {
    const { layout } = applyPreset(messy, 'bottom', screen, ['office', 'notices']);
    expect(Object.keys(layout.items).sort()).toEqual(['icon:notices', 'icon:office']);
  });

  it('\uc791\uc5c5\uc6a9: messenger on the left third, terminal on the right half, \ud604\ud669\ud310 closed', () => {
    const { layout, open } = applyPreset(messy, 'work', screen, icons);
    const room = screen.w - RAIL_PX - 56 - 8;
    const work = { w: screen.w, h: screen.h - ICON_ROW_PX };
    const m = rectFromPlace(layout.items.messenger!.place!, { w: 0, h: 0 }, work);
    const t = rectFromPlace(layout.items.terminal!.place!, { w: 0, h: 0 }, work);
    expect(m.x).toBe(8);
    expect(Math.abs(m.x + m.w - room / 3)).toBeLessThanOrEqual(GRID_PX);
    expect(Math.abs(t.w - room / 2)).toBeLessThanOrEqual(GRID_PX);
    expect(t.x + t.w).toBe(room);
    expect(m.x + m.w).toBeLessThan(t.x);
    expect(m.y + m.h).toBeLessThanOrEqual(work.h);
    expect(open).toEqual({ office: false, messenger: true, terminal: true });
    expect(layout.items.office).toBeUndefined();
    expect(Object.keys(layout.items).some((k) => k.startsWith('icon:'))).toBe(false);
  });

  it('\uc791\uc5c5\uc6a9 opens only the windows whose icons exist', () => {
    const { open } = applyPreset(messy, 'work', screen, ['office', 'notices']);
    expect(open).toEqual({ office: false });
  });
});

describe('no free placement (U-29)', () => {
  const free: Layout = {
    v: 1,
    items: {
      'icon:office': { place: { corner: 'bl', dx: 300, dy: 300 }, scale: 2 },
      office: { place: { corner: 'tl', dx: 5, dy: 5, w: 400, h: 300 }, max: true },
      usage: { place: { corner: 'tr', dx: 9, dy: 9 } },
    },
  };
  it('placement stays switched off for the MVP', () => {
    expect(FREE_PLACEMENT).toBe(false);
  });
  it('a stored layout without a preset keeps no icon or widget place, only a window (U-38)', () => {
    expect(presetLayoutOnly(free)).toEqual({
      v: 1,
      items: { office: { place: { corner: 'tl', dx: 5, dy: 5, w: 400, h: 300 }, max: true } },
    });
  });
  it("a preset's own layout is kept, and survives a save and a parse", () => {
    const { layout } = applyPreset(free, 'work', screen, ['office', 'messenger', 'terminal']);
    expect(presetLayoutOnly(layout)).toEqual(layout);
    expect(parseLayout(serializeLayout(layout)).preset).toBe('work');
    expect(withEntry(layout, 'office', { max: true }).preset).toBe('work');
  });
});

describe('movable windows keep their title bar reachable (U-38)', () => {
  const WINDOWS = ['messenger', 'terminal', 'office', 'notices'];
  /** The title bar row (name and _ □ ×) is inside the room: nothing of it is off screen. */
  const inside = (r: { x: number; y: number; w: number; h: number }, b: { w: number; h: number }) =>
    r.x >= 0 && r.y >= 0 && r.x + r.w <= b.w && r.y + Math.min(TITLE_BAR_PX, r.h) <= b.h;
  const rooms = [screen, { w: 900, h: 500 }, { w: 400, h: 300 }, { w: 200, h: 120 }];

  it('exactly the four windows are free; icons and widgets stay fixed', () => {
    expect(WINDOWS.every(windowIsFree)).toBe(true);
    expect(['icon:office', 'usage', 'floors'].some(windowIsFree)).toBe(false);
  });

  it('a saved window place survives a load; a saved icon place does not', () => {
    const place = { corner: 'tr' as const, dx: 120, dy: 40, w: 500, h: 400 };
    const stored = parseLayout(
      serializeLayout({
        v: 1,
        items: Object.fromEntries([
          ...WINDOWS.map((id) => [id, { place }]),
          ['icon:messenger', { place: { corner: 'bl', dx: 3, dy: 3 } }],
        ]),
      }),
    );
    const loaded = presetLayoutOnly(stored);
    for (const id of WINDOWS) expect(loaded.items[id]?.place).toEqual(place);
    expect(loaded.items['icon:messenger']).toBeUndefined();
  });

  it('a drag, a resize and their snapping never take a window out of the room (so never under the top bar)', () => {
    for (const bounds of rooms) {
      const room = bounds;
      const start = rectFromPlace(defaultWindowPlace('messenger', bounds), { w: 0, h: 0 }, bounds);
      const from = clampRect(start, room, WINDOW_MIN);
      for (const d of [-5000, -300, -1, 0, 7, 300, 5000]) {
        for (const e of [-5000, -40, 0, 40, 5000]) {
          expect(inside(moveRect(from, d, e, room), room)).toBe(true);
          expect(inside(snapMoveRect(moveRect(from, d, e, room), room), room)).toBe(true);
          for (const h of HANDLES) {
            const sized = resizeRect(from, h, d, e, room);
            expect(inside(sized, room)).toBe(true);
            expect(inside(snapResizeRect(sized, h, room), room)).toBe(true);
          }
        }
      }
    }
  });

  it('a saved place from a bigger or odd screen is pulled in on load and after a browser resize', () => {
    const saved = [
      { corner: 'tl' as const, dx: 1100, dy: 700, w: 600, h: 500 },
      { corner: 'br' as const, dx: -900, dy: -900, w: 2000, h: 2000 },
      { corner: 'tr' as const, dx: 99999, dy: -99999 },
      { corner: 'tr' as const, dx: 0, dy: 0, w: 400, h: 300 }, // flush right: under the panels is fine
      { corner: 'bl' as const, dx: 0, dy: 1000, w: 300, h: 200 },
    ];
    for (const place of saved)
      for (const bounds of rooms) {
        const rect = rectFromPlace(
          clampPlace(place, { w: 0, h: 0 }, bounds, WINDOW_MIN),
          { w: 0, h: 0 },
          bounds,
        );
        expect(inside(rect, bounds)).toBe(true);
      }
  });

  it('the stored place itself is kept: a window returns when the screen grows back', () => {
    const place = { corner: 'tl' as const, dx: 700, dy: 500, w: 300, h: 250 };
    const at = (bounds: { w: number; h: number }) =>
      clampPlace(place, { w: 0, h: 0 }, bounds, WINDOW_MIN);
    expect(at({ w: 800, h: 400 })).not.toEqual(place);
    expect(at(screen)).toEqual(place);
  });
});

const inside = (r: { x: number; y: number; w: number; h: number }, b: { w: number; h: number }) =>
  r.x >= 0 && r.y >= 0 && r.x + r.w <= b.w && r.y + r.h <= b.h;

describe('a window may go under the fixed panels, its title bar stays grabbable (WINDOW-LAYERS)', () => {
  const cardBar = { x: 1160, y: 150, w: 120, h: 400 }; // right edge, centred
  const elevator = { x: 10, y: 250, w: 100, h: 200 };
  const dockRow = { x: 400, y: 740, w: 480, h: 48 }; // the 아래 가로 row along the bottom
  const room = { w: 1280, h: 800 };

  it('a short window flush right, level with the card bar, stays where it is', () => {
    const rect = { x: 900, y: 250, w: 380, h: 200 };
    expect(keepTitleGrabbable(rect, [cardBar], room)).toBe(rect);
  });

  it('a window may sit right over the dock row and over the elevator', () => {
    const low = { x: 300, y: 700, w: 600, h: 100 };
    expect(keepTitleGrabbable(low, [dockRow], room)).toBe(low);
    const left = { x: 0, y: 260, w: 400, h: 300 };
    expect(keepTitleGrabbable(left, [elevator], room)).toBe(left);
  });

  it('a title bar whose width is all under a panel is moved to the nearest place with a free stretch', () => {
    const rect = { x: 1170, y: 200, w: 100, h: 200 }; // narrow, wholly under the card bar
    const out = keepTitleGrabbable({ ...rect }, [cardBar], room);
    expect(freeTitle(out, [cardBar])).toBeGreaterThanOrEqual(TITLE_GRAB_PX);
    expect(out.y).toBe(rect.y);
    expect(out.w).toBe(rect.w);
  });

  it('a window under the whole dock row keeps a free stretch of its title bar', () => {
    const icons = Array.from({ length: 6 }, (_, i) => ({ x: 400 + i * 48, y: 744, w: 40, h: 40 }));
    const out = keepTitleGrabbable({ x: 380, y: 744, w: 300, h: 56 }, icons, room);
    expect(out.x).toBeLessThan(380); // moved off the row of icons (gaps are too thin to grab)
  });

  it('every spot keeps at least TITLE_GRAB_PX of the title bar free, on both screens', () => {
    for (const r of [{ w: 1280, h: 700 }, { w: 1920, h: 980 }]) {
      const panels = [
        { x: r.w - 120, y: 100, w: 120, h: r.h - 200 },
        { x: r.w - 190, y: 200, w: 40, h: 280 },
        { x: 10, y: 250, w: 100, h: 200 },
        { x: 600, y: r.h - 48, w: 480, h: 48 },
      ];
      for (let x = 0; x <= r.w - 280; x += 61)
        for (let y = 0; y <= r.h - 180; y += 47) {
          const out = keepTitleGrabbable({ x, y, w: 280 + (x % 120), h: 180 }, panels, r);
          expect(inside(out, r)).toBe(true);
          expect(freeTitle(out, panels)).toBeGreaterThanOrEqual(TITLE_GRAB_PX);
        }
    }
  });
});

/** Test-side count of the free title-bar stretch (the model's own is private). */
function freeTitle(rect: Rect, panels: readonly Rect[]): number {
  let best = 0;
  for (let x = rect.x; x < rect.x + rect.w; x++) {
    let run = 0;
    while (
      x + run < rect.x + rect.w &&
      !panels.some((p) => p.y < rect.y + TITLE_BAR_PX && p.y + p.h > rect.y && x + run >= p.x && x + run < p.x + p.w)
    )
      run++;
    best = Math.max(best, run);
    x += run;
  }
  return best;
}

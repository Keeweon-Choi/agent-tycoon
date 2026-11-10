/**
 * T-0077: a floating desktop window over the office. Drag it by the title
 * bar, resize it from any edge or corner, the last one touched is on top, ×
 * closes. Position and size are remembered per device (hudStore) against the
 * nearest corner and pulled back on screen when the room shrinks.
 *
 * U-38: all four windows move and resize again (layout.ts windowIsFree); the whole window stays
 * inside the room, so the title bar and its buttons are always reachable. Icons stay fixed (U-29).
 *
 * T-0111: moving and resizing snap to an 8 px grid and to the screen's and other
 * windows' edges (hold Alt to move freely); _ sends the window to its icon (it
 * stays mounted, only out of sight) and □ fills the office area, again to go back.
 */
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { Button } from '../../components/ui/Button.js';
import { TITLE_BAR, WINDOW_PAD } from '../../components/ui/windowChrome.js';
import { HUD_DOCK_HANDLE_PX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { RegionBoundary } from '../RegionBoundary.js';
import { useFixedPanels } from './fixedPanels.js';
import {
  BellGlyph,
  BoardGlyph,
  BubbleGlyph,
  CloseGlyph,
  MaximizeGlyph,
  MinimizeGlyph,
  RestoreGlyph,
  TerminalGlyph,
} from './glyphs.js';
import { minimizeWindow, openWindow, setPlace, toggleMaximize, useHud } from './hudStore.js';
import {
  clampPlace,
  clampWindowRect,
  cssAnchor,
  defaultWindowPlace,
  type Handle,
  HANDLES,
  keepTitleGrabbable,
  maximizedPlace,
  moveRect,
  placeFromRect,
  type Rect,
  rectFromPlace,
  resizeRect,
  type Size,
  snapMoveRect,
  snapResizeRect,
  TITLE_BAR_PX,
  WINDOW_MIN,
  type WindowId,
  windowIsFree,
  windowRoom,
} from './layout.js';
import { siblingRects, useBounds } from './useBounds.js';
import { layerZ } from './windowModel.js';

const HANDLE_SIZE_PX = 6;

/** UI-DEPTH: the head's icon, the same glyph as the window's dock icon (looks has none; the
 *  개발실's title draws its own). */
const HEAD_GLYPH: Partial<Record<WindowId, () => ReactNode>> = {
  office: () => <BoardGlyph />,
  messenger: () => <BubbleGlyph />,
  notices: () => <BellGlyph />,
  terminal: () => <TerminalGlyph />,
};
const CORNER_SIZE_PX = 14;

const handleStyle = (h: Handle): CSSProperties => {
  const edge = HANDLE_SIZE_PX;
  const corner = CORNER_SIZE_PX;
  const s: CSSProperties = {
    cursor: `${h}-resize`,
    position: 'absolute',
    touchAction: 'none',
  };
  if (h.length === 2) {
    Object.assign(s, {
      width: corner,
      height: corner,
      [h[0] === 'n' ? 'top' : 'bottom']: -edge / 2,
      [h[1] === 'w' ? 'left' : 'right']: -edge / 2,
    });
  } else if (h === 'n' || h === 's') {
    Object.assign(s, {
      left: corner,
      right: corner,
      height: edge,
      [h === 'n' ? 'top' : 'bottom']: -edge / 2,
    });
  } else {
    Object.assign(s, {
      top: corner,
      bottom: corner,
      width: edge,
      [h === 'w' ? 'left' : 'right']: -edge / 2,
    });
  }
  return s;
};

interface HudWindowProps {
  id: WindowId;
  title: string;
  closeLabel: string;
  onClose: () => void;
  /** Rendered as an <aside> named `title` (the 현황판 window; runners and screen readers find it). */
  landmark?: boolean;
  /** False keeps the window mounted but out of sight (display: none): the terminal's sockets live on. */
  open?: boolean;
  /** The 파일 tab opens wide. */
  wide?: boolean;
  /** Extra controls in the title bar, before ×. */
  bar?: ReactNode;
  children: ReactNode;
}

export function HudWindow({
  id,
  title,
  landmark,
  closeLabel,
  onClose,
  wide,
  open = true,
  bar,
  children,
}: HudWindowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hud = useHud();
  const { layout, minimized } = hud;
  const hidden = !open || minimized[id] === true;
  const bounds = useBounds(ref, hidden);
  const panels = useFixedPanels();
  const [live, setLive] = useState<Rect | null>(null);
  const stored = layout.items[id]?.place;
  const maximized = layout.items[id]?.max === true;
  const free = windowIsFree(id);
  // The title bar's real extent from the window's top (the screen style changes it): the one part of a dragged window that must stay on screen.
  const titleRef = useRef<HTMLDivElement>(null);
  const [titleH, setTitleH] = useState(TITLE_BAR_PX);
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el || hidden) return;
    const read = () => setTitleH(Math.ceil(el.getBoundingClientRect().bottom - (ref.current ?? el).getBoundingClientRect().top) || TITLE_BAR_PX); // down to the bar's foot, the window's border included
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hidden]);
  const fit = (r: Rect, b: Size, min?: Size) => clampWindowRect(r, b, min, titleH);

  // Until the room is measured the window stays out of sight rather than flashing at 0,0. The room
  // is the whole HUD box under the top bar; a panel pressed after the window draws over it (layerZ) and a window may go under
  // any of them, only part of its title bar always stays out (keepTitleGrabbable).
  // hud-v3 P0: a window OPENS above the dock's band (windowRoom); once the user moves it, or it is restored
  // after a resize, it may use the whole layer down to the screen's bottom (clampWindowRect); a maximized one fills it.
  const room = bounds && windowRoom(bounds);
  const rect: Rect | null =
    live ??
    (bounds && room
      ? maximized
        ? rectFromPlace(maximizedPlace(bounds), { w: 0, h: 0 }, bounds)
        : keepTitleGrabbable(
            rectFromPlace(
              clampPlace(
                stored ?? defaultWindowPlace(id, room, wide),
                { w: 0, h: 0 },
                bounds,
                WINDOW_MIN,
                fit,
              ),
              { w: 0, h: 0 },
              bounds,
            ),
            panels,
            bounds,
          )
      : null);

  /**
   * Drag the title bar (action 'move') or a handle (a resize), from a pointerdown. Cheap by design:
   * nothing is read from the layout and no store or React state changes while a move runs. The
   * pointer only records its latest position; once per frame the window is shifted with a transform
   * (its own compositor layer, no layout or repaint of the office under it) and the place is committed
   * to the store once, on drop. A resize changes the box itself, so it renders at most once per frame.
   */
  const begin = (e: ReactPointerEvent, action: 'move' | Handle) => {
    const el = ref.current;
    if (!el || !free || !bounds || !rect || maximized || (e.pointerType === 'mouse' && e.button !== 0))
      return;
    e.preventDefault();
    const others = siblingRects(el, '[data-hud-window]');
    const start = { x: e.clientX, y: e.clientY };
    const from = rect;
    let latest = { dx: 0, dy: 0, alt: false };
    let last: Rect = from;
    let frame = 0;
    // The rect the pointer asks for: on the grid and the edges (Alt: free), a title bar left grabbable.
    const target = (): Rect => {
      const { dx, dy, alt } = latest;
      if (action === 'move') {
        const moved = moveRect(from, dx, dy, bounds, fit);
        return keepTitleGrabbable(
          alt ? moved : snapMoveRect(moved, bounds, others, fit),
          panels,
          bounds,
        );
      }
      const sized = resizeRect(from, action, dx, dy, bounds);
      return alt ? sized : snapResizeRect(sized, action, bounds, others);
    };
    const paint = () => {
      frame = 0;
      last = target();
      if (action === 'move') el.style.transform = `translate(${last.x - from.x}px, ${last.y - from.y}px)`;
      else setLive(last);
    };
    if (action === 'move') el.style.willChange = 'transform';
    const onMove = (ev: PointerEvent) => {
      latest = { dx: ev.clientX - start.x, dy: ev.clientY - start.y, alt: ev.altKey };
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const end = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      if (frame) cancelAnimationFrame(frame);
      el.style.transform = '';
      el.style.willChange = '';
      if (commit && (latest.dx !== 0 || latest.dy !== 0)) {
        last = target();
        if (last.x !== from.x || last.y !== from.y || last.w !== from.w || last.h !== from.h)
          setPlace(id, placeFromRect(last, bounds, true));
      }
      setLive(null);
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const style: CSSProperties = hidden
    ? { display: 'none' }
    : rect && bounds
      ? { ...cssAnchor(placeFromRect(rect, bounds, true)), zIndex: layerZ(hud, id, maximized) }
      : { visibility: 'hidden', zIndex: 0 };
  const Frame = landmark ? 'aside' : 'div';
  return (
    <Frame
      ref={ref as never}
      aria-label={landmark ? title : undefined}
      data-hud-window={id}
      className="pixel-panel ui-window pointer-events-auto absolute flex flex-col min-h-0 min-w-0"
      style={style}
      // A click into a window behind brings it to front (WINMODEL).
      onPointerDownCapture={() => openWindow(id)}
    >
      <div
        ref={titleRef}
        data-testid={`hud-title-${id}`}
        className={`${TITLE_BAR} touch-none ${free ? 'cursor-move' : ''}`}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button,input,select,a')) return;
          begin(e, 'move');
        }}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest('button,input,select,a')) toggleMaximize(id);
        }}
      >
        <strong className="text-(length:--ui-win-title) flex items-center gap-8 min-w-0">
          {HEAD_GLYPH[id] && (
            <span className="ui-head-icon shrink-0" aria-hidden>
              {HEAD_GLYPH[id]()}
            </span>
          )}
          {title}
        </strong>
        <span className="flex items-center gap-4">
          {bar}
          <Button
            size="icon_md"
            aria-label={t('hud.minimize')}
            title={t('hud.minimize')}
            onClick={() => minimizeWindow(id)}
          >
            <MinimizeGlyph />
          </Button>
          <Button
            size="icon_md"
            aria-label={maximized ? t('hud.restoreSize') : t('hud.maximize')}
            title={maximized ? t('hud.restoreSize') : t('hud.maximize')}
            aria-pressed={maximized}
            onClick={() => toggleMaximize(id)}
          >
            {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
          </Button>
          <Button size="icon_md" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
            <CloseGlyph />
          </Button>
        </span>
      </div>
      {/* Maximized, the dock's handle floats over the window's foot: the body keeps its height clear. */}
      <div
        data-selectable
        className={`flex flex-col flex-1 min-h-0 ${WINDOW_PAD}`}
        style={maximized ? { paddingBottom: HUD_DOCK_HANDLE_PX } : undefined}
      >
        <RegionBoundary region={id} className="m-auto">
          {children}
        </RegionBoundary>
      </div>
      {free &&
        !maximized &&
        HANDLES.map((h) => (
          <div key={h} data-handle={h} style={handleStyle(h)} onPointerDown={(e) => begin(e, h)} />
        ))}
    </Frame>
  );
}

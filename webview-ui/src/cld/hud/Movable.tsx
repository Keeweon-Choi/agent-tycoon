/**
 * T-0077: an icon or small widget the user can move and size.
 *
 * Unmoved, it sits where its `className` puts it (in flow or absolute, the
 * caller's choice). Dragged, it is anchored to its nearest corner and
 * remembered (hudStore). A mouse press moves it after DRAG_THRESHOLD_PX, so a
 * click is still a click; a finger long-presses first (the card bar's
 * reorder feel) and then drags. Right-click, or a long-press released
 * without moving, opens the size menu: 작게 / 보통 / 크게 and 제자리로.
 *
 * T-0111: on a desktop a dragged thing lands on the 8 px grid and sticks to the
 * screen's and the open windows' edges (hold Alt to place it freely). A phone
 * keeps the free drag.
 */
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { CARD_REORDER_LONG_PRESS_MS } from '../../constants.js';
import { useIsMobile } from '../../hooks/useIsMobile.js';
import { t, type TranslationKey } from '../../i18n/index.js';
import { swallowNextClick, withinTapSlop } from '../../touch/touchPrimitives.js';
import { clearEntry, setPlace, setScale, useHud } from './hudStore.js';
import {
  clampPlace,
  cssAnchor,
  DEFAULT_SCALE,
  exceedsDragThreshold,
  FREE_PLACEMENT,
  moveRect,
  nearestCorner,
  type Place,
  placeFromRect,
  type Rect,
  SCALE_FACTORS,
  SCALE_LABELS,
  type ScaleStep,
  type Size,
  snapMoveRect,
} from './layout.js';
import { rectInParent, siblingRects, useBounds } from './useBounds.js';

interface PressState {
  pointerId: number;
  x: number;
  y: number;
  touch: boolean;
  /** Mouse: past the threshold. Finger: the long press fired. */
  lifted: boolean;
  moved: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  stop: () => void;
}

interface MovableProps {
  /** The key in the stored layout. */
  id: string;
  /** Accessible name of the size menu. */
  label: string;
  /** Where it sits until it is moved. */
  className?: string;
  /** z-index once moved (inside the HUD layer it is unnecessary). */
  z?: number;
  /** A bottom-preset dock item stays in the responsive row, not its old saved pixel slot. */
  flowInBottomPreset?: boolean;
  children: ReactNode;
}

export function Movable({
  id,
  label,
  className = '',
  z,
  flowInBottomPreset = false,
  children,
}: MovableProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hud = useHud();
  const entry = hud.layout.items[id];
  const bounds = useBounds(ref);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [live, setLive] = useState<Place | null>(null);
  const [lifted, setLifted] = useState(false);
  const [menu, setMenu] = useState<'tl' | 'tr' | 'bl' | 'br' | null>(null);
  const press = useRef<PressState | null>(null);
  const scale: ScaleStep = FREE_PLACEMENT ? (entry?.scale ?? DEFAULT_SCALE) : DEFAULT_SCALE;
  const mobile = useIsMobile();

  // Its own size, for clamping a stored place into a smaller screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () =>
      setSize((prev) =>
        prev.w === el.offsetWidth && prev.h === el.offsetHeight
          ? prev
          : { w: el.offsetWidth, h: el.offsetHeight },
      );
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (menu === null) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)
      )
        setMenu(null);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menu]);

  const placed =
    live ??
    ((!flowInBottomPreset || hud.layout.preset !== 'bottom') && entry?.place && bounds
      ? clampPlace(entry.place, size, bounds)
      : null);

  const openMenu = () => {
    const el = ref.current;
    const rect = el && rectInParent(el);
    if (rect && bounds) setMenu(nearestCorner(rect, bounds));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    // A portalled dialog (the 설정 modal sits in the usage bar's React tree) bubbles here too.
    if (!el || !el.contains(e.target as Node) || press.current || !bounds) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as HTMLElement).closest('input,textarea,select,[data-no-drag]')) return;
    const found = rectInParent(el);
    if (!found) return;
    const box: Rect = found;
    const room: Size = bounds;
    const touch = e.pointerType === 'touch';
    const others = mobile ? [] : siblingRects(el, '[data-hud-window]');
    const lift = () => {
      p.lifted = true;
      setLifted(true);
    };
    const p: PressState = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      touch,
      lifted: false,
      moved: false,
      timer: touch ? setTimeout(lift, CARD_REORDER_LONG_PRESS_MS) : null,
      stop: () => undefined,
    };
    let dropped: Place | null = null;
    const stop = () => {
      if (p.timer) clearTimeout(p.timer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      press.current = null;
      setLifted(false);
    };
    p.stop = stop;
    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== p.pointerId) return;
      const dx = ev.clientX - p.x;
      const dy = ev.clientY - p.y;
      if (!p.lifted) {
        // A finger that moves before the long press fires is not for us.
        if (touch) return withinTapSlop(dx, dy) ? undefined : stop();
        if (!exceedsDragThreshold(dx, dy)) return;
        lift();
      }
      p.moved = true;
      const moved = moveRect(box, dx, dy, room);
      dropped = placeFromRect(
        mobile || ev.altKey ? moved : snapMoveRect(moved, room, others),
        room,
      );
      setLive(dropped);
    }
    function onUp(ev: PointerEvent) {
      if (ev.pointerId !== p.pointerId) return;
      const wasLifted = p.lifted;
      stop();
      if (!wasLifted) return;
      swallowNextClick();
      if (dropped) setPlace(id, dropped);
      else if (touch) openMenu();
      setLive(null);
    }
    function onCancel(ev: PointerEvent) {
      if (ev.pointerId !== p.pointerId) return;
      stop();
      setLive(null);
    }
    press.current = p;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  // A drag still in flight when this unmounts must not leave listeners behind.
  useEffect(() => () => press.current?.stop(), []);

  const style = placed
    ? { position: 'absolute' as const, ...cssAnchor(placed), ...(z !== undefined && { zIndex: z }) }
    : undefined;
  return (
    <div
      ref={ref}
      data-hud-id={id}
      data-hud-fixed
      data-lifted={lifted || undefined}
      className={`pointer-events-auto touch-none select-none ${placed ? '' : className} ${lifted ? 'outline-2 outline-accent' : ''}`}
      style={style}
      // U-29: no free placement for the MVP (FREE_PLACEMENT): the handlers below stay unreachable.
      onPointerDown={FREE_PLACEMENT ? onPointerDown : undefined}
      // A selection range over an icon would start a native drag and cancel ours; the floor
      // panel's own draggable chips keep theirs.
      onDragStart={(e) => {
        if (!FREE_PLACEMENT) return;
        if (!(e.target as HTMLElement).closest?.('[draggable="true"]')) e.preventDefault();
      }}
      onContextMenu={(e) => {
        if (!FREE_PLACEMENT || !ref.current?.contains(e.target as Node)) return;
        e.preventDefault();
        // A finger's long press opens the menu on its release (above); the OS menu is just swallowed.
        if (!press.current?.touch) openMenu();
      }}
    >
      <div style={scale === DEFAULT_SCALE ? undefined : { zoom: SCALE_FACTORS[scale] }}>
        {children}
      </div>
      {menu && (
        <div
          role="group"
          aria-label={t('hud.sizeFor', { name: label })}
          data-no-drag
          className={`pixel-panel absolute z-50 flex gap-4 p-4 text-xs ${menu[0] === 'b' ? 'bottom-full mb-4' : 'top-full mt-4'} ${menu[1] === 'r' ? 'right-0' : 'left-0'}`}
        >
          {SCALE_LABELS.map((name, step) => (
            <button
              key={name}
              type="button"
              aria-pressed={scale === step}
              className={`border px-6 py-2 whitespace-nowrap pointer-coarse:min-h-44 ${scale === step ? 'border-accent text-accent-text' : 'border-border text-text-muted'}`}
              onClick={() => setScale(id, step as ScaleStep)}
            >
              {t(name as TranslationKey)}
            </button>
          ))}
          <button
            type="button"
            className="border border-border px-6 py-2 whitespace-nowrap text-text-muted pointer-coarse:min-h-44"
            onClick={() => {
              clearEntry(id);
              setMenu(null);
            }}
          >
            {t('hud.resetPosition')}
          </button>
        </div>
      )}
    </div>
  );
}

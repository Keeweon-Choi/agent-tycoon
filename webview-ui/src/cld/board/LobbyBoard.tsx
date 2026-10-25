/**
 * The lobby's 전광판 (T-0046): a DOM overlay on the LED_BOARD's screen,
 * placed through overlayProjection so it pans and zooms with the camera, and
 * a full-screen view a click on the board opens (Esc or back closes it).
 *
 * Cost: the pages turn and the data redraws only while the board is on the
 * shown floor, inside the view and big enough to read; otherwise it keeps a
 * static frame (or is not drawn at all off the view). The overlay lets the
 * pointer through to the office (pan, zoom, pinch); the tabs take clicks,
 * and a tap on the rest of the board opens the full view.
 */
import './board.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  BOARD_EM_WIDTH,
  BOARD_FULL_EM_PX,
  BOARD_FULL_MIN_EM_PX,
  BOARD_FULL_Z_INDEX,
  BOARD_MIN_EM_PX,
  BOARD_SCREEN,
  BOARD_TYPE,
  BOARD_Z_INDEX,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import { frameDue } from '../../office/engine/gameLoop.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { overlayProjection } from '../../office/projection.js';
import type { ToolActivity } from '../../office/types.js';
import { TILE_SIZE } from '../../office/types.js';
import { DRAG_THRESHOLD_PX } from '../camera.js';
import { isOfficeCanvasTarget } from '../canvasTarget.js';
import { currentRect, onFloor } from '../floors.js';
import { useCldStore, virtualAgentId } from '../officeStore.js';
import { closeOverlay } from '../overlayHistory.js';
import { type BoardPage, pickPage, rotate, startRotation } from './board.js';
import { type BoardMode, BoardModeContext } from './boardMode.js';
import { BoardView, type LookOf } from './BoardPages.js';

interface LobbyBoardProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  agentTools: Record<number, ToolActivity[]>;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Characters' palettes: a project's orchestrator's look, else one picked by its name. */
function useLookOf(officeState: OfficeState): LookOf {
  const { officeSnapshot } = useCldStore();
  return useMemo(() => {
    const ids = new Map(
      (officeSnapshot?.orchestrators ?? []).map((o) => [
        o.name,
        o.agentId ?? virtualAgentId(`orch:${o.name}`),
      ]),
    );
    return (project: string) => {
      const ch = officeState.characters.get(ids.get(project) ?? NaN);
      if (ch) return { palette: ch.palette, hueShift: ch.hueShift };
      let h = 0;
      for (const c of project) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      return { palette: h % 6, hueShift: 0 };
    };
  }, [officeSnapshot, officeState]);
}

/** The page shown, turning while live (rotate: paused under the pointer and after a tab pick). */
function usePages(live: boolean, hovering: React.RefObject<{ mini: boolean; full: boolean }>) {
  const [rot, setRot] = useState(() => startRotation(Date.now()));
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!live) return;
    const tick = () => {
      const now = Date.now();
      setNowSec(Math.floor(now / 1000));
      setRot((r) => rotate(r, now, hovering.current.mini || hovering.current.full));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [live, hovering]);
  const onPage = useCallback((page: BoardPage) => setRot(pickPage(page, Date.now())), []);
  return { page: rot.page, onPage, nowSec };
}

export function LobbyBoard({
  officeState,
  containerRef,
  zoom,
  panRef,
  agentTools,
}: LobbyBoardProps) {
  const snap = useCldStore();
  const lookOf = useLookOf(officeState);
  const [full, setFull] = useState(false);
  const close = useCallback(() => setFull(false), []);
  // Follow the camera on the canvas's frames.
  const [, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = (ts: number) => {
      if (frameDue(ts)) setTick((n) => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const rect = boardRect(officeState, containerRef.current, zoom, panRef.current);
  const em = rect ? rect.width / BOARD_EM_WIDTH : 0;
  const container = containerRef.current?.getBoundingClientRect();
  const inView =
    !!rect &&
    !!container &&
    rect.left < container.width &&
    rect.top < container.height &&
    rect.left + rect.width > 0 &&
    rect.top + rect.height > 0;
  const live = (inView && em >= BOARD_MIN_EM_PX) || full;
  // A mouse over the board (or the full view) holds its page.
  const hovering = useRef({ mini: false, full: false });
  const { page, onPage, nowSec } = usePages(live, hovering);
  const hoverFull = useCallback((on: boolean) => {
    hovering.current.full = on;
  }, []);

  // A tap on the board (not a drag) opens the full view; the canvas below still gets it.
  const rectRef = useRef<Rect | null>(null);
  rectRef.current = inView ? rect : null;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let down: { x: number; y: number } | null = null;
    const local = (e: PointerEvent) => {
      const box = el.getBoundingClientRect();
      return { x: e.clientX - box.left, y: e.clientY - box.top };
    };
    // Pointer events: the canvas's touch gestures may cancel the click a tap would make.
    const onDown = (e: PointerEvent) => {
      down = e.isPrimary && e.button === 0 ? local(e) : null;
    };
    const inside = (p: { x: number; y: number }) => {
      const r = rectRef.current;
      return (
        !!r && p.x >= r.left && p.x < r.left + r.width && p.y >= r.top && p.y < r.top + r.height
      );
    };
    const onUp = (e: PointerEvent) => {
      const p = local(e);
      const tap = down && Math.hypot(p.x - down.x, p.y - down.y) <= DRAG_THRESHOLD_PX;
      down = null;
      const target = e.target as Element;
      if (!tap || target.closest?.('.led-head')) return;
      // Only the canvas or the board itself: a panel or button over the board's rectangle keeps its click.
      if (!isOfficeCanvasTarget(target) && !target.closest?.('[data-testid="lobby-board"]')) return;
      if (inside(p)) setFull(true);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') hovering.current.mini = inside(local(e));
    };
    const onLeave = () => (hovering.current.mini = false);
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('pointerup', onUp, true);
    el.addEventListener('pointermove', onMove, true);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('pointerup', onUp, true);
      el.removeEventListener('pointermove', onMove, true);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [containerRef]);

  const view = (frozen: boolean, mode: BoardMode) => (
    <BoardModeContext.Provider value={mode}>
      <BoardView
        snap={snap}
        agentTools={agentTools}
        page={page}
        onPage={onPage}
        nowSec={nowSec}
        lookOf={lookOf}
        frozen={frozen}
      />
    </BoardModeContext.Provider>
  );
  return (
    <>
      {inView && rect && (
        <div
          className={`led-board led-mini ${live ? '' : 'led-frozen'}`}
          data-testid="lobby-board"
          data-live={live}
          style={{ ...rect, fontSize: em, zIndex: BOARD_Z_INDEX }}
          aria-label={t('board.wallOpen')}
        >
          {view(!live, 'mini')}
        </div>
      )}
      {full && (
        <FullBoard onClose={close} onHover={hoverFull}>
          {(narrow) => view(false, narrow ? 'narrow' : 'full')}
        </FullBoard>
      )}
    </>
  );
}

/** The board's screen in the office container's CSS px, or null (no board on this floor). */
function boardRect(
  officeState: OfficeState,
  el: HTMLDivElement | null,
  zoom: number,
  pan: { x: number; y: number },
): Rect | null {
  const layout = officeState.getLayout();
  const board = layout.furniture.find((f) => f.type === BOARD_TYPE);
  if (!el || !board) return null;
  const x = board.col * TILE_SIZE + BOARD_SCREEN.x;
  const y = board.row * TILE_SIZE + BOARD_SCREEN.y;
  if (!onFloor(currentRect(layout), (board.row + 4) * TILE_SIZE)) return null;
  const p = overlayProjection(
    layout,
    el.getBoundingClientRect(),
    zoom,
    pan,
    window.devicePixelRatio || 1,
  );
  const left = p.toScreenX(x);
  const top = p.toScreenY(y);
  return {
    left,
    top,
    width: p.toScreenX(x + BOARD_SCREEN.w) - left,
    height: p.toScreenY(y + BOARD_SCREEN.h) - top,
  };
}

/** The board full screen: the same pages, bigger. Esc, ✕, a click outside the board or the browser's back closes it. */
function FullBoard({
  onClose,
  onHover,
  children,
}: {
  onClose: () => void;
  onHover: (on: boolean) => void;
  children: (narrow: boolean) => React.ReactNode;
}) {
  useEffect(() => () => onHover(false), [onHover]);
  // The board's own shape, as big as the screen allows; a phone held upright
  // gets it as wide as the screen with the pages stacked.
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const tall = (BOARD_EM_WIDTH * BOARD_SCREEN.h) / BOARD_SCREEN.w;
  const fit = Math.floor(Math.min((vp.w - 48) / BOARD_EM_WIDTH, (vp.h - 120) / tall));
  const narrow = fit < BOARD_FULL_MIN_EM_PX;
  // Back closes it: an entry of our own while open, popped by the close button or Esc.
  useEffect(() => {
    history.pushState({ cldBoard: true }, '');
    const onPop = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeOverlay('cldBoard', onClose);
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  return createPortal(
    <div
      className="led-full-backdrop"
      style={{ zIndex: BOARD_FULL_Z_INDEX }}
      role="dialog"
      aria-modal="true"
      aria-label={t('board.label')}
      data-testid="board-full"
      // A click on the dark around the board closes it (user 10-22 14:20), not one on the board.
      onClick={(e) => e.target === e.currentTarget && closeOverlay('cldBoard', onClose)}
    >
      <div
        className={`led-board led-full ${narrow ? 'led-full-narrow' : ''}`}
        style={{ fontSize: narrow ? BOARD_FULL_EM_PX : fit }}
        onPointerEnter={(e) => e.pointerType === 'mouse' && onHover(true)}
        onPointerLeave={() => onHover(false)}
      >
        {children(narrow)}
      </div>
      <button
        type="button"
        className="led-close"
        aria-label={t('common.close')}
        data-testid="board-close"
        onClick={() => closeOverlay('cldBoard', onClose)}
      >
        ✕
      </button>
    </div>,
    document.body,
  );
}

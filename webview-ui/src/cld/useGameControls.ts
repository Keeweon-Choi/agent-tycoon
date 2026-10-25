import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';

import {
  BOARD_CLEAR_LEFT_PX,
  BOARD_SCREEN,
  BOARD_TYPE,
  CAMERA_FOLLOW_ZOOM_STEPS,
  HD_ZOOM_STEP,
  ZOOM_MAX,
} from '../constants.js';
import { defaultZoom } from '../hooks/useEditorActions.js';
import { t } from '../i18n/index.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { mapOffset } from '../office/projection.js';
import { getCharacterSprites } from '../office/sprites/spriteData.js';
import { TILE_SIZE, TileType } from '../office/types.js';
import { isTypingInTerminal } from '../terminal/terminalDom.js';
import { subjectWithParticle } from './actionText.js';
import type { CameraKey, Insets, Vec } from './camera.js';
import {
  cameraKey,
  centerPan,
  clampPan,
  clearLeft,
  easeVelocity,
  edgeDirection,
  fillZoom,
  framePan,
  glidePan,
  isDrag,
  keyDirection,
  officeBox,
  PAN_SPEED_PX_S,
  panelInset,
  stepZoom,
  usableView,
  wheelZoom,
  zoomAround,
} from './camera.js';
import {
  askFraming,
  cameraAsks,
  type CameraMode,
  cameraMode,
  isCameraManual,
  lastFraming,
  noteFraming,
  noteManualCamera,
  restoreManual,
} from './cameraMode.js';
import {
  cameraRect,
  currentRect,
  floorIndexAt,
  floorKey,
  floorRects,
  floorsSnapshot,
  goToFloor,
  onFloor,
  reducedMotion,
  sampleFloors,
  stackShifts,
} from './floors.js';
import { fixedPanels } from './hud/fixedPanels.js';
import { characterName } from './kinds.js';
import { cldGetSnapshot, cldToast } from './officeStore.js';
import { loadSavedCamera, saveCamera } from './savedCamera.js';
import { staffStep } from './staff.js';
import { holdWalkKey, releaseWalkKey } from './walk.js';

const EDGE_SCROLL_KEY = 'cld.edge-scroll';
let edgeScrollOn = (() => {
  try {
    return localStorage.getItem(EDGE_SCROLL_KEY) === 'on';
  } catch {
    return false;
  }
})();

/** Edge-scroll (a per-browser setting, off unless turned on). */
export const isEdgeScrollOn = () => edgeScrollOn;
export function setEdgeScroll(on: boolean): void {
  edgeScrollOn = on;
  try {
    localStorage.setItem(EDGE_SCROLL_KEY, on ? 'on' : 'off');
  } catch {
    // Private browsing or a locked-down webview: keep the in-memory choice.
  }
}

interface GameControlsOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  officeState: OfficeState;
  panRef: { current: Vec };
  zoom: number;
  onZoomChange: (zoom: number) => void;
  /** The editor owns left-drag and the keys it uses; the camera keeps the rest. */
  isEditMode: boolean;
  /** A character is under this viewport point: a drag there moves it, not the camera. */
  characterAt?: (clientX: number, clientY: number) => boolean;
  /** The phone shell: its default camera mode is focus (GFX). */
  phone?: boolean;
  /** ISO-PILOT: the isometric building is drawn, which frames itself (cld/iso/camera.ts):
   *  pans are clamped by this, and the top-down framing and floor camera stand aside. */
  isoClamp?: ((pan: Vec, zoom: number) => Vec) | null;
}

const PAN_KEYS: ReadonlySet<CameraKey> = new Set(['up', 'down', 'left', 'right']);

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable ||
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT');

/** The safe-area insets (CSS px of the viewport), read from a hidden probe. */
let safeProbe: HTMLDivElement | null = null;
export function safeArea(): Insets {
  if (!safeProbe) {
    safeProbe = document.createElement('div');
    safeProbe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;inset:0;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) ' +
      'env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.appendChild(safeProbe);
  }
  const s = getComputedStyle(safeProbe);
  return {
    top: parseFloat(s.paddingTop) || 0,
    right: parseFloat(s.paddingRight) || 0,
    bottom: parseFloat(s.paddingBottom) || 0,
    left: parseFloat(s.paddingLeft) || 0,
  };
}

/** Device px of the canvas that the fixed HUD panels (`data-hud-fixed`: card bar, icon dock,
 *  elevator) and the safe areas cover, per side. Read only when the view is framed. */
function coveredInsets(canvas: HTMLCanvasElement): Insets {
  const c = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const size = { w: c.width, h: c.height };
  const out: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const el of document.querySelectorAll<HTMLElement>('[data-hud-fixed]')) {
    if (el.offsetParent === null) continue;
    const b = el.getBoundingClientRect();
    const hit = panelInset(size, { x: b.left - c.left, y: b.top - c.top, w: b.width, h: b.height });
    if (hit) out[hit.side] = Math.max(out[hit.side], hit.px);
  }
  // The safe areas, against the canvas's part inside the window (a page sliding in has its
  // canvas partly off screen for a moment: that is no inset).
  const safe = safeArea();
  const [l, t, r, b] = [
    Math.max(0, c.left),
    Math.max(0, c.top),
    Math.min(window.innerWidth, c.right),
    Math.min(window.innerHeight, c.bottom),
  ];
  out.top = Math.max(out.top, safe.top - t);
  out.left = Math.max(out.left, safe.left - l);
  out.bottom = Math.max(out.bottom, b - (window.innerHeight - safe.bottom));
  out.right = Math.max(out.right, r - (window.innerWidth - safe.right));
  return {
    top: out.top * dpr,
    right: out.right * dpr,
    bottom: out.bottom * dpr,
    left: out.left * dpr,
  };
}

/** GFX: the mode the office is framed in now (the upstream surfaces have no cld office). */
const framingMode = (): CameraMode => (cldGetSnapshot().officeSnapshot ? cameraMode() : 'off');

/** The window fills the screen: the Fullscreen API, F11 in a browser, or the
 *  desktop app's own fullscreen (neither of the last two sets fullscreenElement). */
const isFullscreen = () =>
  !!document.fullscreenElement ||
  (Math.abs(window.innerWidth - screen.width) <= 1 &&
    Math.abs(window.innerHeight - screen.height) <= 1);

/**
 * The office camera as a game's (T-0025): left-drag on the floor pans (a
 * still click still selects; a drag from a character is T-0015's, which
 * moves it), the wheel / pinch zooms about the cursor in whole steps,
 * WASD / arrows pan with eased speed, +/- zoom, 0 resets, Esc stops following,
 * and the window edge scrolls in fullscreen when that is turned on. Keys work
 * with nothing focused, never while typing. Ctrl+wheel never zooms the page
 * and iOS never pinch-zooms it. Touch stays with useCanvasTouchGestures.
 *
 * Returns the per-frame step the game loop calls (stable).
 */
export function useGameControls(options: GameControlsOptions): (dt: number) => void {
  const latest = useRef(options);
  latest.current = options;
  const state = useRef({
    held: new Set<CameraKey>(),
    walkHeld: [] as CameraKey[],
    v: { x: 0, y: 0 } as Vec,
    wheel: 0,
    pointer: null as (Vec & { buttons: number }) | null,
    /** The layout and floor the camera last settled on (T-0027). */
    floorLayout: null as object | null,
    floorId: null as string | null,
    floorStacked: null as boolean | null,
    glide: null as Vec | null,
    glideFrom: null as Vec | null,
    floorCenter: { x: 0, y: 0 } as Vec,
    /** The one-floor camera's default last applied. */
    dflt: { x: 0, y: 0 } as Vec,
    followSeen: null as number | null,
    /** The floor the followed character was on (ELEVATOR: a ride takes the view along). */
    followFloor: -1,
    activeWalkHintFor: null as number | null,
    /** G1: the pan a refresh saved, applied once the first floor has settled. */
    restore: loadSavedCamera()?.pan ?? null,
    /** GFX: the saved view had been moved by hand (else a framing mode frames it again). */
    restoreManual: loadSavedCamera()?.manual === true,
    /** What the view was last framed for (mode, canvas, floor, map size, asks) and the panels. */
    frameKey: null as string | null,
    framePanels: null as readonly unknown[] | null,
    frameTiles: null as unknown,
    /** The follow the auto camera last zoomed in for (null: none). */
    followFramed: null as number | null,
  }).current;

  /** The pan clamp for the view drawn (the isometric one when it is on). */
  const clampFor = (pan: Vec, canvas: HTMLCanvasElement, zoom: number): Vec => {
    const { isoClamp, officeState } = latest.current;
    if (isoClamp) return isoClamp(pan, zoom);
    const layout = officeState.getLayout();
    return clampPan(pan, { w: canvas.width, h: canvas.height }, layout, zoom, cameraRect(layout));
  };

  // One zoom path for wheel and keys. flushSync commits the new zoom (and the
  // game loop re-created for it) before the pan for that zoom is written, so
  // no frame ever draws the old zoom at the new pan.
  const zoomBy = useRef((steps: number, at: Vec | null) => {
    const { canvasRef, officeState, panRef, zoom, onZoomChange } = latest.current;
    const canvas = canvasRef.current;
    const next = stepZoom(zoom, steps);
    if (!canvas || next === zoom) return;
    noteManualCamera();
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    // Following a character: zoom about the centre, where the follow holds it.
    const anchor =
      at && officeState.cameraFollowId === null
        ? {
            x: (at.x - rect.left) * dpr - canvas.width / 2,
            y: (at.y - rect.top) * dpr - canvas.height / 2,
          }
        : { x: 0, y: 0 };
    const pan = clampFor(zoomAround(panRef.current, anchor, zoom, next), canvas, next);
    flushSync(() => onZoomChange(next));
    panRef.current = pan;
  }).current;

  /** The camera's default for `rect` (null: the whole map): the floor centred,
   *  then, when the lobby's board is there and fits, moved right until its left
   *  end clears the elevator panel (T-0063). */
  const defaultPan = useRef(
    (
      layout: ReturnType<OfficeState['getLayout']>,
      zoom: number,
      rect: ReturnType<typeof currentRect>,
    ) => {
      const pan = centerPan(layout, zoom, rect);
      const canvas = latest.current.canvasRef.current;
      const board = layout.furniture.find((f) => f.type === BOARD_TYPE);
      if (!canvas || !board || (rect && !onFloor(rect, board.row * TILE_SIZE))) return pan;
      const { offsetX } = mapOffset(
        canvas.width,
        canvas.height,
        layout.cols,
        layout.rows,
        zoom,
        pan.x,
        pan.y,
      );
      const left = offsetX + (board.col * TILE_SIZE + BOARD_SCREEN.x) * zoom;
      return clearLeft(
        pan,
        { left, right: left + BOARD_SCREEN.w * zoom },
        canvas.width,
        BOARD_CLEAR_LEFT_PX * (window.devicePixelRatio || 1),
      );
    },
  ).current;

  /** Floors (T-0027), each frame: a follow that starts on another floor takes
   *  the elevator there; when the floor shown or the office changes the
   *  camera settles on that floor, and what was left on another floor stops
   *  being selected or followed; the floor badges are worked out. */
  const floorStep = useRef((dt: number) => {
    const { officeState, panRef, zoom } = latest.current;
    const layout = officeState.getLayout();
    sampleFloors(officeState.characters.values(), layout, dt);
    staffStep(officeState, dt); // T-0041: temps come and go, office hours
    const rects = floorRects(layout);
    const followId = officeState.cameraFollowId;
    const follow = followId !== null ? officeState.characters.get(followId) : undefined;
    const k = rects && follow ? floorIndexAt(rects, follow.tileRow) : -1;
    if (followId !== state.followSeen || k !== state.followFloor) {
      state.followSeen = followId;
      state.followFloor = k;
      const { current, doors } = floorsSnapshot();
      if (rects && k >= 0 && rects[k].id !== (doors?.target ?? current)) goToFloor(rects[k].id);
    }
    // ISO-PILOT: the isometric camera follows the floor itself; the floor store is the same.
    if (latest.current.isoClamp) {
      state.floorLayout = null;
      return;
    }
    const rect = currentRect(layout);
    const stacked = floorsSnapshot().stacked;
    if (
      layout === state.floorLayout &&
      rect?.id === state.floorId &&
      stacked === state.floorStacked
    )
      return;
    const toggled = state.floorStacked !== null && stacked !== state.floorStacked;
    state.floorStacked = stacked;
    state.glide = null;
    const [was, before] = [state.floorId, state.floorCenter];
    const switched = (rect?.id ?? null) !== was;
    state.floorLayout = layout;
    state.floorId = rect?.id ?? null;
    // Where the floor's centre is, in tiles from the map's: pan is kept
    // relative to it when the office around the floor changes.
    state.floorCenter = rect ? centerPan(layout, 1 / TILE_SIZE, rect) : { x: 0, y: 0 };
    if (!rect) {
      // One floor: the camera is upstream's, but a camera still at its default
      // (the layout arrived or changed under it) takes the new default.
      const p = panRef.current;
      if (was !== null || (p.x === state.dflt.x && p.y === state.dflt.y))
        panRef.current = state.dflt = defaultPan(layout, zoom, null);
      return;
    }
    const selected = officeState.selectedAgentId;
    const sel = selected !== null ? officeState.characters.get(selected) : undefined;
    if (sel && !onFloor(rect, sel.y)) officeState.selectedAgentId = null;
    const followed = !!follow && onFloor(rect, follow.y);
    if (follow && !followed) officeState.breakCameraFollow();
    const t = TILE_SIZE * zoom;
    if (!switched && !toggled) {
      panRef.current = {
        x: panRef.current.x + (state.floorCenter.x - before.x) * t,
        y: panRef.current.y + (state.floorCenter.y - before.y) * t,
      };
    } else if (toggled) {
      panRef.current = defaultPan(layout, zoom, rect);
    } else if (switched && stacked && was !== null && rects) {
      const from = rects.findIndex((r) => r.id === was);
      const to = rects.indexOf(rect);
      if (from >= 0) {
        panRef.current = {
          x: panRef.current.x,
          y: panRef.current.y + stackShifts(rects, from)[to] * zoom,
        };
        if (!followed) {
          const target = defaultPan(layout, zoom, rect);
          if (reducedMotion()) panRef.current = target;
          else {
            state.glide = target;
            state.glideFrom = panRef.current;
          }
        }
      } else {
        panRef.current = defaultPan(layout, zoom, rect);
      }
    } else if (followed) {
      // The doors open on the character (the follow would slide there otherwise).
      panRef.current = {
        x: (layout.cols * t) / 2 - follow!.x * zoom,
        y: (layout.rows * t) / 2 - follow!.y * zoom,
      };
    } else {
      panRef.current = defaultPan(layout, zoom, rect);
    }
  }).current;

  /** GFX, each frame. Auto: the office framed (the floor covering the view left by the panels,
   *  at the nearest whole zoom, an even one while an HD employee is on it), again whenever what
   *  it was framed for changes, unless the user moved the camera since or the editor is open; a
   *  follow (a click on a character) zooms in on it, its end (a click on the floor, Esc, 0)
   *  frames the office again. Free: nothing moves the camera, a click only selects. */
  const frameStep = useRef(() => {
    const { canvasRef, officeState, panRef, zoom, onZoomChange, isEditMode } = latest.current;
    const canvas = canvasRef.current;
    const mode = framingMode();
    if (mode === 'free' && officeState.cameraFollowId !== null) officeState.cameraFollowId = null;
    if (!canvas || !state.floorLayout || isEditMode || mode !== 'auto' || latest.current.isoClamp)
      return;
    const layout = officeState.getLayout();
    const rect = currentRect(layout);
    // HD characters on this floor: prefer zooms they divide into whole device px (owner 10-25).
    let density = 1;
    for (const ch of officeState.characters.values())
      if (!ch.cldAway && onFloor(rect, ch.y))
        // an HD64 character has its 32×64 copy for even zooms: it asks no more than HD does
        density = Math.max(
          density,
          Math.min(HD_ZOOM_STEP, getCharacterSprites(ch.palette, ch.hueShift).density),
        );
    // A follow starts: zoom in on the character (the follow itself pans to it); it ends without a
    // manual pan or zoom (a click on the floor, Esc): back to the framed office.
    const follow = officeState.cameraFollowId;
    if (follow !== state.followFramed) {
      const was = state.followFramed;
      state.followFramed = follow;
      if (follow !== null) {
        restoreManual(false);
        const base = lastFraming()?.zoom ?? zoom;
        const close = Math.min(
          ZOOM_MAX,
          Math.ceil((base + CAMERA_FOLLOW_ZOOM_STEPS) / density) * density,
        );
        if (close !== zoom) queueMicrotask(() => flushSync(() => onZoomChange(close)));
      } else if (was !== null && !isCameraManual()) askFraming();
    }
    if (follow !== null || officeState.greeterCameraTarget) return;
    const key = [
      density,
      canvas.width,
      canvas.height,
      rect?.id,
      floorsSnapshot().stacked,
      layout.cols,
      layout.rows,
      cameraAsks(),
    ].join('|');
    const panels = fixedPanels();
    // The tile map is rebuilt when the layout arrives or changes (floorStep has then moved the
    // camera its classic way): frame again.
    const tiles = officeState.tileMap;
    if (key === state.frameKey && panels === state.framePanels && tiles === state.frameTiles)
      return;
    state.frameKey = key;
    state.framePanels = panels;
    state.frameTiles = tiles;
    if (isCameraManual()) return;
    const box = officeBox(officeState.tileMap, TileType.VOID, rect) ?? {
      x: 0,
      y: 0,
      w: layout.cols * TILE_SIZE,
      h: layout.rows * TILE_SIZE,
    };
    const size = { w: canvas.width, h: canvas.height };
    const view = usableView(size, coveredInsets(canvas));
    const z = fillZoom(view, box, density);
    const pan = framePan(layout, z, size, view, box);
    noteFraming({ mode, zoom: z, view, box });
    // A framed view is no classic default: floorStep must not move it as one when the layout
    // object changes under it (a framed pan can equal the old default by chance).
    state.dflt = { x: NaN, y: NaN };
    if (z === zoom) {
      // A floor switch that glides keeps gliding, to the framed spot.
      if (state.glide) state.glide = pan;
      else panRef.current = pan;
      return;
    }
    state.glide = null;
    // After this frame is drawn (old zoom, old pan): flushSync re-creates the loop for the new
    // zoom before the pan for it is written, as zoomBy does.
    queueMicrotask(() => {
      flushSync(() => onZoomChange(z));
      panRef.current = pan;
    });
  }).current;

  const step = useRef((dt: number) => {
    const { canvasRef, officeState, panRef, zoom } = latest.current;
    floorStep(dt);
    if (state.restore && state.floorLayout && framingMode() === 'auto' && !state.restoreManual)
      state.restore = null; // a framed view is framed again for this screen
    if (state.restore && state.floorLayout) {
      restoreManual(state.restoreManual);
      const canvas = canvasRef.current;
      if (canvas && !latest.current.isoClamp) panRef.current = clampFor(state.restore, canvas, zoom);
      state.restore = null;
    }
    frameStep();
    if (state.glide) {
      if (panRef.current !== state.glideFrom) state.glide = null;
      else {
        const next = glidePan(panRef.current, state.glide, dt);
        if (next.x === state.glide.x && next.y === state.glide.y) state.glide = null;
        panRef.current = state.glideFrom = next;
      }
    }
    let dir = keyDirection(state.held);
    if (!dir.x && !dir.y && edgeScrollOn && state.pointer?.buttons === 0 && isFullscreen()) {
      dir = edgeDirection(state.pointer, { w: window.innerWidth, h: window.innerHeight });
    }
    const moving = dir.x !== 0 || dir.y !== 0;
    if (!moving && officeState.cameraFollowId !== null) {
      state.v = { x: 0, y: 0 }; // a follow took over: no coasting against it
      return;
    }
    const speed = PAN_SPEED_PX_S * (window.devicePixelRatio || 1);
    state.v = easeVelocity(state.v, { x: dir.x * speed, y: dir.y * speed }, dt);
    const canvas = canvasRef.current;
    if (!canvas || (!state.v.x && !state.v.y)) return;
    if (moving) {
      officeState.breakCameraFollow();
      noteManualCamera();
    }
    // The view moves right, so the map moves left.
    panRef.current = clampFor(
      { x: panRef.current.x - state.v.x * dt, y: panRef.current.y - state.v.y * dt },
      canvas,
      zoom,
    );
  }).current;

  const { canvasRef } = options;
  // G1: the view survives a refresh (before the first restore it still holds the saved one).
  useEffect(() => {
    const save = () => {
      if (!state.restore)
        saveCamera({
          zoom: latest.current.zoom,
          pan: latest.current.panRef.current,
          ...(isCameraManual() && { manual: true }),
        });
    };
    const onHide = () => document.visibilityState === 'hidden' && save();
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [state]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    /** The left press in flight on the canvas (not in the editor). */
    let press: { x: number; y: number; pan: Vec; panned: boolean } | null = null;

    const onDown = (e: MouseEvent) => {
      const { isEditMode, characterAt, panRef } = latest.current;
      press =
        e.button === 0 && !isEditMode && !characterAt?.(e.clientX, e.clientY)
          ? { x: e.clientX, y: e.clientY, pan: panRef.current, panned: false }
          : null;
    };
    const onMove = (e: MouseEvent) => {
      state.pointer = { x: e.clientX, y: e.clientY, buttons: e.buttons };
      if (!press || !(e.buttons & 1)) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      const { officeState, panRef, zoom } = latest.current;
      if (!press.panned) {
        if (!isDrag(dx, dy)) return;
        press.panned = true;
        officeState.breakCameraFollow();
        noteManualCamera();
      }
      const dpr = window.devicePixelRatio || 1;
      panRef.current = clampFor({ x: press.pan.x + dx * dpr, y: press.pan.y + dy * dpr }, canvas, zoom);
      canvas.style.cursor = 'grabbing'; // after the canvas's own hover cursor
    };
    const onUp = (e: MouseEvent) => {
      if (e.button === 0 && press?.panned) canvas.style.cursor = '';
    };
    // At the canvas, before the click bubbles to React's root listener.
    const onClick = (e: MouseEvent) => {
      const p = press;
      press = null;
      if (p && (p.panned || isDrag(e.clientX - p.x, e.clientY - p.y))) e.stopPropagation();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = wheelZoom(state.wheel, e.deltaY, e.deltaMode);
      state.wheel = r.acc;
      if (r.steps) zoomBy(r.steps, { x: e.clientX, y: e.clientY });
    };
    // Ctrl+wheel (and a trackpad pinch, which arrives as one) anywhere else in
    // the app must not zoom the page either.
    const noPageZoom = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    const noPinchZoom = (e: Event) => e.preventDefault(); // iOS Safari
    const onLeave = (e: MouseEvent) => {
      if (!e.relatedTarget) state.pointer = null; // left the window
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.isComposing ||
        isTyping(e.target) ||
        isTypingInTerminal(e.target instanceof Element ? e.target : null) ||
        latest.current.isEditMode
      )
        return;
      // 1-9: that floor of the building (T-0027).
      const floor = floorKey(e);
      if (floor !== null) {
        const id = floorsSnapshot().building?.floors[floor - 1]?.id;
        if (id) {
          e.preventDefault();
          if (!e.repeat) goToFloor(id);
        }
        return;
      }
      const action = cameraKey(e);
      if (!action) return;
      const { officeState, panRef, onZoomChange } = latest.current;
      if (PAN_KEYS.has(action)) {
        const wasHoldingWalkKey = state.walkHeld.length > 0;
        if (!e.repeat) state.walkHeld = holdWalkKey(state.walkHeld, action);
        officeState.setHeldWalkKeys(state.walkHeld);
        const result = officeState.walkSelectedStep(action, !e.repeat && !wasHoldingWalkKey);
        if (result !== 'unavailable') {
          e.preventDefault(); // selected characters own the direction keys
          const id = officeState.selectedAgentId;
          if (result === 'active' && id !== null && state.activeWalkHintFor !== id) {
            const ch = officeState.characters.get(id);
            const { officeSnapshot, codexTasks } = cldGetSnapshot();
            const name = ch ? characterName(ch, officeSnapshot, codexTasks) : t('action.character');
            cldToast(name, t('action.busyAtDesk', { name: subjectWithParticle(name) }), 'info');
            state.activeWalkHintFor = id;
          } else if (result !== 'active') {
            state.activeWalkHintFor = null;
          }
          return;
        }
        e.preventDefault(); // no scrolling whatever was clicked last
        state.held.add(action);
        return;
      }
      if (e.repeat) return;
      if (action === 'zoomIn' || action === 'zoomOut') {
        zoomBy(action === 'zoomIn' ? 1 : -1, null);
      } else if (action === 'reset' && framingMode() === 'auto') {
        officeState.breakCameraFollow(); // GFX: frame again in the mode chosen
        askFraming();
        state.v = { x: 0, y: 0 };
      } else if (action === 'reset') {
        officeState.breakCameraFollow();
        const zoom = defaultZoom();
        flushSync(() => onZoomChange(zoom));
        const layout = officeState.getLayout();
        panRef.current = state.dflt = defaultPan(layout, zoom, currentRect(layout)); // the floor shown
        state.v = { x: 0, y: 0 };
      } else {
        officeState.selectedAgentId = null; // Esc hands WASD/arrows back to the camera
        state.activeWalkHintFor = null;
        officeState.breakCameraFollow();
      }
    };
    // Release by key alone: a modifier pressed meanwhile must not strand it.
    const onKeyUp = (e: KeyboardEvent) => {
      const action = cameraKey({
        key: e.key,
        code: e.code,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
      });
      if (action) {
        state.held.delete(action);
        if (PAN_KEYS.has(action)) {
          state.walkHeld = releaseWalkKey(state.walkHeld, action);
          latest.current.officeState.setHeldWalkKeys(state.walkHeld);
        }
      }
    };
    const release = () => {
      state.held.clear(); // keyups that land elsewhere (alt-tab) never come
      state.walkHeld = [];
      latest.current.officeState.setHeldWalkKeys([]);
      state.pointer = null;
    };
    const onVisibility = () => {
      if (document.hidden) release();
    };

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('wheel', noPageZoom, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('mouseout', onLeave);
    document.addEventListener('gesturestart', noPinchZoom);
    return () => {
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('wheel', noPageZoom);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('mouseout', onLeave);
      document.removeEventListener('gesturestart', noPinchZoom);
    };
  }, [canvasRef, state, zoomBy, defaultPan]);

  return step;
}

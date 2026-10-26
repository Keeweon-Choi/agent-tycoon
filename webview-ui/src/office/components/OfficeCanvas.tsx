import { useCallback, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';

import { clampPan as clampCameraPan } from '../../cld/camera.js';
import { noteManualCamera } from '../../cld/cameraMode.js';
import { visitFloor } from '../../cld/elevator.js';
import {
  cameraRect,
  currentRect,
  endFloorDrag,
  floorClip,
  floorMovable,
  floorsSnapshot,
  floorView,
  goToFloor,
  onFloor,
  reducedMotion,
  stackedFloorAt,
  startFloorDrag,
} from '../../cld/floors.js';
import {
  backdropPlacement,
  backdropState,
  backdropStyle,
  useBackdrop,
} from '../../cld/gfx/backdrop.js';
import { isContextHandled, openContextMenu, registerContextTarget } from '../../cld/inputPolicy.js';
import { clampIsoPan, isoCameraStep, newIsoCam, stackCentre } from '../../cld/iso/camera.js';
import { useIsoView } from '../../cld/iso/isoView.js';
import {
  isoBusy,
  isoFeet,
  isoFrameReset,
  type IsoPick,
  isoPick,
  isoScene,
  renderIso,
  setSeatPoint,
} from '../../cld/iso/render.js';
import { isoSeatPoint } from '../../cld/iso/seatPoint.js';
import { restDropAt } from '../../cld/lounge.js';
import { drawOtherFloors } from '../../cld/otherFloors.js';
import { useGameControls } from '../../cld/useGameControls.js';
import {
  CAMERA_FOLLOW_LERP,
  CAMERA_FOLLOW_SNAP_THRESHOLD,
  OFFICE_CANVAS_TEST_ID,
} from '../../constants.js';
import { unlockAudio } from '../../notificationSound.js';
import { withinTapSlop } from '../../touch/touchPrimitives.js';
import { transport } from '../../transport/index.js';
import { furnitureAt } from '../editor/editorActions.js';
import { buildEditorRenderState } from '../editor/editorRenderState.js';
import type { EditorState } from '../editor/editorState.js';
import { startGameLoop } from '../engine/gameLoop.js';
import type { OfficeState } from '../engine/officeState.js';
import type {
  DeleteButtonBounds,
  EditorRenderState,
  RotateButtonBounds,
  SelectionRenderState,
} from '../engine/renderer.js';
import { renderFrame } from '../engine/renderer.js';
import { getCatalogEntry } from '../layout/furnitureCatalog.js';
import { EditTool, TILE_SIZE, TileType } from '../types.js';
import { computeNormalModeCursor } from './officeCanvasCursor.js';
import { useCanvasTouchGestures } from './useCanvasTouchGestures.js';

/**
 * Cursor for a furniture drag that has started moving: 'copy' — the platform's
 * own duplicate-drag affordance — while Alt makes the drop a copy, 'grabbing'
 * for a move. Set wherever dragDuplicate changes, so the cursor never claims a
 * move the drop would turn into a copy (or the reverse).
 */
function dragMoveCursor(editorState: EditorState): string {
  return editorState.dragDuplicate ? 'copy' : 'grabbing';
}

interface OfficeCanvasProps {
  officeState: OfficeState;
  onClick: (agentId: number) => void;
  isEditMode: boolean;
  editorState: EditorState;
  onEditorTileAction: (col: number, row: number) => void;
  onEditorEraseAction: (col: number, row: number) => void;
  onEditorSelectionChange: () => void;
  onDeleteSelected: () => void;
  onRotateSelected: () => void;
  /** A furniture drag released with the item's top-left over (col,row);
   *  `duplicate` when Alt was held. The handler decides what that commits. */
  onDrop: (uid: string, col: number, row: number, opts: { duplicate: boolean }) => void;
  editorTick: number;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  panRef: React.MutableRefObject<{ x: number; y: number }>;
  /** Whether the area overlay + labels should render (settings toggle OR active edit). */
  showAreas: boolean;
  /** Currently-selected area label in the editor (alpha-bumped overlay). null otherwise. */
  activeAreaLabel: string | null;
  /** Mobile two-step tap: the first tap on a character selects it (camera
   *  follow + status label), and only a second tap on the already-selected
   *  character fires onClick (opens its terminal). Desktop keeps single-click
   *  focus with tap-again-to-deselect. */
  tapSelectsFirst?: boolean;
  /** GFX: the cld office may show the night skyline in the void (its own setting decides). */
  backdrop?: boolean;
}

export function OfficeCanvas({
  officeState,
  onClick,
  isEditMode,
  editorState,
  onEditorTileAction,
  onEditorEraseAction,
  onEditorSelectionChange,
  onDeleteSelected,
  onRotateSelected,
  onDrop,
  editorTick: _editorTick,
  zoom,
  onZoomChange,
  panRef,
  showAreas,
  activeAreaLabel,
  tapSelectsFirst = false,
  backdrop: backdropAllowed = false,
}: OfficeCanvasProps) {
  const backdrop = useBackdrop();
  useEffect(() => {
    setSeatPoint((ch) => {
      const seat = ch.seatId ? officeState.seats.get(ch.seatId) : undefined;
      return isoSeatPoint(ch, seat, officeState.getLayout().furniture, getCatalogEntry);
    });
    return () => setSeatPoint(null);
  }, [officeState]);
  // ISO-PILOT: the isometric building replaces the top-down drawing (never in the editor).
  const iso = useIsoView() && !isEditMode;
  const isoCamRef = useRef(newIsoCam());
  /** GFX2: the camera the backdrop was last placed for. */
  const backdropKeyRef = useRef('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef({ x: 0, y: 0 });
  // Middle-mouse pan state (imperative, no re-renders)
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, panX: 0, panY: 0 });
  // Delete/rotate button bounds (updated each frame by renderer)
  const deleteButtonBoundsRef = useRef<DeleteButtonBounds | null>(null);
  const rotateButtonBoundsRef = useRef<RotateButtonBounds | null>(null);
  // Right-click erase dragging
  const isEraseDraggingRef = useRef(false);
  // cld-gui (T-0027): a movable character pressed with the left button and
  // dragged past the tap slop; the floor buttons can take it. A plain click
  // on it is still a click.
  const characterDragRef = useRef<{ id: number; x: number; y: number; moving: boolean } | null>(
    null,
  );
  const suppressClickRef = useRef(false);
  // Clamp pan so the map edge can't go past a margin inside the viewport
  // (cld-gui T-0025: the maths moved to cld/camera.ts, shared and tested).
  const clampPan = useCallback(
    (px: number, py: number): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: px, y: py };
      if (iso) return clampIsoPan({ x: px, y: py }, isoScene(officeState).stack, zoom);
      const layout = officeState.getLayout();
      return clampCameraPan(
        { x: px, y: py },
        { w: canvas.width, h: canvas.height },
        layout,
        zoom,
        cameraRect(layout), // the whole stack in the default view
      );
    },
    [officeState, zoom, iso],
  );
  /** ISO-PILOT: what the last isometric frame drew under a viewport point. */
  const isoAt = useCallback((clientX: number, clientY: number): IsoPick => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return isoPick((clientX - rect.left) * dpr, (clientY - rect.top) * dpr);
  }, []);
  // cld-gui (T-0025): left-drag pan, wheel zoom about the cursor, the camera
  // keys and edge-scroll; stepCamera runs in the game loop's update. A press
  // on a character is not a pan: dragging one moves it (T-0015).
  const stepCamera = useGameControls({
    canvasRef,
    officeState,
    panRef,
    zoom,
    onZoomChange,
    isEditMode,
    phone: tapSelectsFirst,
    characterAt: (clientX, clientY) => characterAt(clientX, clientY) !== null,
    isoClamp: iso
      ? (pan, z) => clampIsoPan(pan, isoScene(officeState).stack, z)
      : null,
  });

  // Resize canvas backing store to device pixels (no DPR transform on ctx)
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    // No ctx.scale(dpr) — we render directly in device pixels
    // GFX: the city around the office (its size and place follow the camera, in render).
    Object.assign(container.style, backdropStyle(backdropState().on && backdropAllowed));
    backdropKeyRef.current = '';
  }, [backdropAllowed]);
  // The setting changed: the same background, styled again.
  useEffect(() => resizeCanvas(), [resizeCanvas, backdrop]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    resizeCanvas();

    const observer = new ResizeObserver(() => resizeCanvas());
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    // cld-gui (T-0075): a camera that moved since the last frame, or anything
    // animating on the office, keeps the loop at the full rate.
    let lastPan = { ...panRef.current };
    const container = containerRef.current;
    const stop = startGameLoop(canvas, {
      busy: () => {
        const pan = panRef.current;
        const panned = pan.x !== lastPan.x || pan.y !== lastPan.y;
        lastPan = { x: pan.x, y: pan.y };
        return panned || officeState.isAnimating() || (iso && isoBusy());
      },
      update: (dt) => {
        officeState.update(dt);
        stepCamera(dt);
        if (iso) {
          // ISO-PILOT: frame the building or the floor in focus, glide to a new focus, follow.
          const { stack } = isoScene(officeState);
          const snap = floorsSnapshot();
          const focus = stack.floors.find((f) => f.id === snap.current) ?? stack.floors[0];
          const followCh =
            officeState.cameraFollowId !== null
              ? officeState.characters.get(officeState.cameraFollowId)
              : undefined;
          const feet = followCh ? isoFeet(stack, followCh) : null;
          const step = isoCameraStep(isoCamRef.current, {
            stack,
            level: focus.level,
            focusId: focus.id,
            building: snap.stacked,
            view: { w: canvas.width, h: canvas.height },
            dpr: window.devicePixelRatio || 1,
            zoom,
            pan: panRef.current,
            follow: feet && { x: feet.x, y: feet.y - TILE_SIZE },
            reduced: reducedMotion(),
            dt,
          });
          const next = step.zoom;
          if (next !== undefined && next !== zoom)
            queueMicrotask(() => {
              flushSync(() => onZoomChange(next));
              panRef.current = step.pan;
            });
          else panRef.current = step.pan;
        }
      },
      render: (ctx) => {
        // Canvas dimensions are in device pixels
        const w = canvas.width;
        const h = canvas.height;
        if (iso) {
          const { stack } = isoScene(officeState);
          renderIso(
            ctx,
            w,
            h,
            officeState,
            zoom,
            panRef.current,
            stackCentre(stack),
            floorsSnapshot().current,
            {
              selected: officeState.selectedAgentId,
              hovered: officeState.hoveredAgentId,
              follow: officeState.cameraFollowId,
            },
            performance.now(),
          );
          return;
        }
        isoFrameReset();

        const editorRender: EditorRenderState | undefined = isEditMode
          ? buildEditorRenderState(editorState, officeState.getLayout())
          : undefined;

        // Camera: smoothly center on the followed agent, or — while the greeter
        // is speaking the Intro — on the character+bubble center the IntroBubble
        // overlay feeds via greeterCameraTarget. An explicit follow (clicking an
        // agent) outranks the greeter target; a manual pan cancels both.
        const followCh =
          officeState.cameraFollowId !== null
            ? officeState.characters.get(officeState.cameraFollowId)
            : undefined;
        const cameraFocus = followCh ?? officeState.greeterCameraTarget;
        if (cameraFocus) {
          const layout = officeState.getLayout();
          const mapW = layout.cols * TILE_SIZE * zoom;
          const mapH = layout.rows * TILE_SIZE * zoom;
          const targetX = mapW / 2 - cameraFocus.x * zoom;
          const targetY = mapH / 2 - cameraFocus.y * zoom;
          const dx = targetX - panRef.current.x;
          const dy = targetY - panRef.current.y;
          if (
            Math.abs(dx) < CAMERA_FOLLOW_SNAP_THRESHOLD &&
            Math.abs(dy) < CAMERA_FOLLOW_SNAP_THRESHOLD
          ) {
            panRef.current = { x: targetX, y: targetY };
          } else {
            panRef.current = {
              x: panRef.current.x + dx * CAMERA_FOLLOW_LERP,
              y: panRef.current.y + dy * CAMERA_FOLLOW_LERP,
            };
          }
        }

        // Build selection render state
        const selectionRender: SelectionRenderState = {
          selectedAgentId: officeState.selectedAgentId,
          hoveredAgentId: officeState.hoveredAgentId,
          hoveredTile: officeState.hoveredTile,
          seats: officeState.seats,
          characters: officeState.characters,
        };

        const layout = officeState.getLayout();
        // The current floor stays opaque; other floors share a cached layer.
        const floor = currentRect(layout);
        const shown = floorView(officeState.tileMap, layout.areaTiles, floor, TileType.VOID);
        const clip = floorClip(floor, layout, { w, h }, zoom, panRef.current);
        if (clip) {
          ctx.clearRect(0, 0, w, h);
          drawOtherFloors(
            ctx,
            w,
            h,
            zoom,
            panRef.current,
            layout,
            officeState,
            showAreas,
            performance.now(),
          );
          ctx.save();
          ctx.beginPath();
          ctx.rect(clip.x, clip.y, clip.w, clip.h);
          ctx.clip();
        }
        const { offsetX, offsetY } = renderFrame(
          ctx,
          w,
          h,
          shown.tileMap,
          officeState.furniture,
          officeState.getCharacters(),
          zoom,
          panRef.current.x,
          panRef.current.y,
          selectionRender,
          editorRender,
          layout.tileColors,
          layout.cols,
          layout.rows,
          layout.carpetTiles,
          layout.areas,
          shown.areaTiles,
          showAreas,
          activeAreaLabel,
          officeState.pets,
        );
        if (clip) ctx.restore();
        offsetRef.current = { x: offsetX, y: offsetY };
        // GFX2: the city around the office moves and scales with it; written only when the
        // camera (or the floor) moved, so an idle office writes nothing.
        if (container && backdropAllowed && backdropState().on) {
          const centre = floor
            ? { x: (floor.cols * TILE_SIZE) / 2, y: (floor.row + floor.rows / 2) * TILE_SIZE }
            : { x: (layout.cols * TILE_SIZE) / 2, y: (layout.rows * TILE_SIZE) / 2 };
          const key = `${offsetX},${offsetY},${zoom},${centre.x},${centre.y}`;
          if (key !== backdropKeyRef.current) {
            backdropKeyRef.current = key;
            const at = backdropPlacement(
              { x: offsetX, y: offsetY },
              zoom,
              window.devicePixelRatio || 1,
              centre,
            );
            container.style.backgroundSize = at.size;
            container.style.backgroundPosition = at.position;
          }
        }

        // Store delete/rotate button bounds for hit-testing
        deleteButtonBoundsRef.current = editorRender?.deleteButtonBounds ?? null;
        rotateButtonBoundsRef.current = editorRender?.rotateButtonBounds ?? null;
      },
    });

    return () => {
      stop();
      observer.disconnect();
    };
  }, [
    officeState,
    resizeCanvas,
    backdropAllowed,
    isEditMode,
    editorState,
    _editorTick,
    zoom,
    panRef,
    showAreas,
    activeAreaLabel,
    stepCamera,
    iso,
    onZoomChange,
  ]);

  // Convert CSS mouse coords to world (sprite pixel) coords
  const pointToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      // CSS coords relative to canvas
      const cssX = clientX - rect.left;
      const cssY = clientY - rect.top;
      // Convert to device pixels
      const deviceX = cssX * dpr;
      const deviceY = cssY * dpr;
      // Convert to world (sprite pixel) coords
      const worldX = (deviceX - offsetRef.current.x) / zoom;
      const worldY = (deviceY - offsetRef.current.y) / zoom;
      return { worldX, worldY, screenX: cssX, screenY: cssY, deviceX, deviceY };
    },
    [zoom],
  );
  const screenToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const pos = pointToWorld(clientX, clientY);
      return pos && onFloor(currentRect(officeState.getLayout()), pos.worldY) ? pos : null;
    },
    [pointToWorld, officeState],
  );
  const otherFloorAt = useCallback(
    (clientX: number, clientY: number) => {
      if (iso) {
        const hit = isoAt(clientX, clientY);
        return hit?.kind === 'floor' ? hit.id : null;
      }
      const pos = pointToWorld(clientX, clientY);
      return pos ? stackedFloorAt(officeState.getLayout(), pos.worldX, pos.worldY) : null;
    },
    [pointToWorld, officeState, iso, isoAt],
  );
  /** The character under a viewport point (the isometric view: what it drew there). */
  const characterAt = useCallback(
    (clientX: number, clientY: number): number | null => {
      if (iso) {
        const hit = isoAt(clientX, clientY);
        return hit?.kind === 'character' ? hit.id : null;
      }
      const pos = screenToWorld(clientX, clientY);
      return pos ? officeState.getCharacterAt(pos.worldX, pos.worldY) : null;
    },
    [iso, isoAt, screenToWorld, officeState],
  );
  /** A point off the floor in focus (on another floor, or on nothing in the isometric view). */
  const offFloor = useCallback(
    (clientX: number, clientY: number): boolean =>
      iso ? isoAt(clientX, clientY)?.kind === 'floor' : !screenToWorld(clientX, clientY),
    [iso, isoAt, screenToWorld],
  );

  const screenToTile = useCallback(
    (clientX: number, clientY: number): { col: number; row: number } | null => {
      if (iso) {
        const hit = isoAt(clientX, clientY);
        return hit?.kind === 'tile' || hit?.kind === 'item' ? { col: hit.col, row: hit.row } : null;
      }
      const pos = screenToWorld(clientX, clientY);
      if (!pos) return null;
      const col = Math.floor(pos.worldX / TILE_SIZE);
      const row = Math.floor(pos.worldY / TILE_SIZE);
      const layout = officeState.getLayout();
      // In edit mode with floor/wall/erase tool, extend valid range by 1 for ghost border
      if (
        isEditMode &&
        (editorState.activeTool === EditTool.TILE_PAINT ||
          editorState.activeTool === EditTool.WALL_PAINT ||
          editorState.activeTool === EditTool.ERASE)
      ) {
        if (col < -1 || col > layout.cols || row < -1 || row > layout.rows) return null;
        return { col, row };
      }
      if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return null;
      return { col, row };
    },
    [screenToWorld, officeState, isEditMode, editorState, iso, isoAt],
  );

  // Check if device-pixel coords hit the delete button
  const hitTestDeleteButton = useCallback((deviceX: number, deviceY: number): boolean => {
    const bounds = deleteButtonBoundsRef.current;
    if (!bounds) return false;
    const dx = deviceX - bounds.cx;
    const dy = deviceY - bounds.cy;
    return dx * dx + dy * dy <= (bounds.radius + 2) * (bounds.radius + 2); // small padding
  }, []);

  // Check if device-pixel coords hit the rotate button
  const hitTestRotateButton = useCallback((deviceX: number, deviceY: number): boolean => {
    const bounds = rotateButtonBoundsRef.current;
    if (!bounds) return false;
    const dx = deviceX - bounds.cx;
    const dy = deviceY - bounds.cy;
    return dx * dx + dy * dy <= (bounds.radius + 2) * (bounds.radius + 2);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Handle middle-mouse panning
      if (isPanningRef.current) {
        const dpr = window.devicePixelRatio || 1;
        const dx = (e.clientX - panStartRef.current.mouseX) * dpr;
        const dy = (e.clientY - panStartRef.current.mouseY) * dpr;
        panRef.current = clampPan(panStartRef.current.panX + dx, panStartRef.current.panY + dy);
        return;
      }

      const characterDrag = characterDragRef.current;
      if (characterDrag && e.buttons === 0) characterDragRef.current = null; // let go elsewhere
      else if (characterDrag && !isEditMode) {
        characterDrag.moving ||= !withinTapSlop(
          e.clientX - characterDrag.x,
          e.clientY - characterDrag.y,
        );
        if (characterDrag.moving) {
          startFloorDrag(characterDrag.id); // cld-gui (T-0027): a floor button may take it
          if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
          return;
        }
      }

      if (isEditMode) {
        const tile = screenToTile(e.clientX, e.clientY);
        if (tile) {
          editorState.ghostCol = tile.col;
          editorState.ghostRow = tile.row;

          // Drag-to-move: check if cursor moved to different tile
          if (editorState.dragUid) {
            // Alt is sampled every move, so it can be pressed or released
            // part-way through a drag and the ghost follows.
            editorState.dragDuplicate = e.altKey;
            if (
              !editorState.isDragMoving &&
              (tile.col !== editorState.dragStartCol || tile.row !== editorState.dragStartRow)
            ) {
              editorState.isDragMoving = true;
            }
          }

          // Paint on drag (paint-style tools only, not during furniture drag).
          // Carpet + Area paint join the drag set so a single click-drag stamps
          // every tile under the cursor — stroke-based undo (one undo per
          // click-drag) lives in useEditorActions for floor/wall/erase/carpet;
          // area paint stays per-tile.
          if (
            editorState.isDragging &&
            (editorState.activeTool === EditTool.TILE_PAINT ||
              editorState.activeTool === EditTool.WALL_PAINT ||
              editorState.activeTool === EditTool.ERASE ||
              editorState.activeTool === EditTool.CARPET_PAINT ||
              editorState.activeTool === EditTool.AREA_PAINT) &&
            !editorState.dragUid
          ) {
            onEditorTileAction(tile.col, tile.row);
          }
          // Right-click erase drag — also extends over carpets/areas so right-
          // drag wipes them just like floor/wall.
          if (
            isEraseDraggingRef.current &&
            (editorState.activeTool === EditTool.TILE_PAINT ||
              editorState.activeTool === EditTool.WALL_PAINT ||
              editorState.activeTool === EditTool.ERASE ||
              editorState.activeTool === EditTool.CARPET_PAINT ||
              editorState.activeTool === EditTool.AREA_PAINT)
          ) {
            const layout = officeState.getLayout();
            if (
              tile.col >= 0 &&
              tile.col < layout.cols &&
              tile.row >= 0 &&
              tile.row < layout.rows
            ) {
              onEditorEraseAction(tile.col, tile.row);
            }
          }
        } else {
          editorState.ghostCol = -1;
          editorState.ghostRow = -1;
        }

        // Cursor: show grab during drag, pointer over delete button, crosshair otherwise
        const canvas = canvasRef.current;
        if (canvas) {
          if (editorState.isDragMoving) {
            canvas.style.cursor = dragMoveCursor(editorState);
          } else {
            const pos = screenToWorld(e.clientX, e.clientY);
            if (
              pos &&
              (hitTestDeleteButton(pos.deviceX, pos.deviceY) ||
                hitTestRotateButton(pos.deviceX, pos.deviceY))
            ) {
              canvas.style.cursor = 'pointer';
            } else if (
              (editorState.activeTool === EditTool.FURNITURE_PICK ||
                editorState.activeTool === EditTool.COLOR_PICK) &&
              tile
            ) {
              // Copy modes (type or colour): pointer over furniture, crosshair elsewhere
              const hit = furnitureAt(officeState.getLayout(), tile.col, tile.row);
              canvas.style.cursor = hit ? 'pointer' : 'crosshair';
            } else if (
              (editorState.activeTool === EditTool.SELECT ||
                (editorState.activeTool === EditTool.FURNITURE_PLACE &&
                  editorState.placing === null)) &&
              tile
            ) {
              // Check if hovering over furniture
              const hit = furnitureAt(officeState.getLayout(), tile.col, tile.row);
              canvas.style.cursor = hit ? 'grab' : 'crosshair';
            } else {
              canvas.style.cursor = 'crosshair';
            }
          }
        }
        return;
      }

      const pos = iso ? null : screenToWorld(e.clientX, e.clientY);
      if (offFloor(e.clientX, e.clientY)) {
        const canvas = canvasRef.current;
        if (canvas)
          canvas.style.cursor = otherFloorAt(e.clientX, e.clientY) ? 'pointer' : 'default';
        officeState.hoveredAgentId = null;
        officeState.hoveredTile = null;
        return;
      }
      const hitId = characterAt(e.clientX, e.clientY);
      // Only run pet hit-test if no character was hit (avoids redundant work). The isometric
      // pilot does not draw the pets.
      const petId = hitId === null && pos ? officeState.getPetAt(pos.worldX, pos.worldY) : null;
      const tile = screenToTile(e.clientX, e.clientY);
      officeState.hoveredTile = tile;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.style.cursor = computeNormalModeCursor({
          hitId,
          petId,
          selectedAgentId: officeState.selectedAgentId,
          tile,
          getSeatAtTile: (col, row) => officeState.getSeatAtTile(col, row),
          getSeat: (seatId) => officeState.seats.get(seatId),
          getCharacter: (id) => officeState.characters.get(id),
        });
      }
      officeState.hoveredAgentId = hitId;
    },
    [
      officeState,
      screenToWorld,
      otherFloorAt,
      characterAt,
      offFloor,
      iso,
      screenToTile,
      isEditMode,
      editorState,
      onEditorTileAction,
      onEditorEraseAction,
      panRef,
      hitTestDeleteButton,
      hitTestRotateButton,
      clampPan,
    ],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      unlockAudio();
      if (e.button >= 3) return e.preventDefault(); // side buttons: ignored (G1)
      // Middle mouse button (button 1) starts panning
      if (e.button === 1) {
        e.preventDefault();
        // Break camera follow + greeter centering on manual pan
        officeState.breakCameraFollow();
        noteManualCamera();
        isPanningRef.current = true;
        panStartRef.current = {
          mouseX: e.clientX,
          mouseY: e.clientY,
          panX: panRef.current.x,
          panY: panRef.current.y,
        };
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = 'grabbing';
        return;
      }

      // Right-click in edit mode for erasing
      if (e.button === 2 && isEditMode) {
        const tile = screenToTile(e.clientX, e.clientY);
        if (
          tile &&
          (editorState.activeTool === EditTool.TILE_PAINT ||
            editorState.activeTool === EditTool.WALL_PAINT ||
            editorState.activeTool === EditTool.ERASE ||
            editorState.activeTool === EditTool.CARPET_PAINT ||
            editorState.activeTool === EditTool.AREA_PAINT)
        ) {
          const layout = officeState.getLayout();
          if (tile.col >= 0 && tile.col < layout.cols && tile.row >= 0 && tile.row < layout.rows) {
            isEraseDraggingRef.current = true;
            onEditorEraseAction(tile.col, tile.row);
          }
        }
        return;
      }

      if (!isEditMode) {
        if (e.button === 0) {
          const hitId = characterAt(e.clientX, e.clientY);
          characterDragRef.current =
            hitId !== null && (floorMovable(hitId) || officeState.characters.get(hitId)?.cldRest)
              ? { id: hitId, x: e.clientX, y: e.clientY, moving: false }
              : null;
        }
        return;
      }

      // Check rotate/delete button hit first
      const pos = screenToWorld(e.clientX, e.clientY);
      if (pos && hitTestRotateButton(pos.deviceX, pos.deviceY)) {
        onRotateSelected();
        return;
      }
      if (pos && hitTestDeleteButton(pos.deviceX, pos.deviceY)) {
        onDeleteSelected();
        return;
      }

      const tile = screenToTile(e.clientX, e.clientY);

      // SELECT tool (or furniture tool with nothing selected): check for furniture hit to start drag
      const actAsSelect =
        editorState.activeTool === EditTool.SELECT ||
        (editorState.activeTool === EditTool.FURNITURE_PLACE && editorState.placing === null);
      if (actAsSelect && tile) {
        const hitFurniture = furnitureAt(officeState.getLayout(), tile.col, tile.row);
        if (hitFurniture) {
          // Start drag — record offset from furniture's top-left. Alt at press
          // time means "drag out a copy"; mousemove keeps it in sync after that.
          editorState.startDrag(
            hitFurniture.uid,
            tile.col,
            tile.row,
            tile.col - hitFurniture.col,
            tile.row - hitFurniture.row,
            e.altKey,
          );
          return;
        } else {
          // Clicked empty space — deselect
          editorState.clearSelection();
          onEditorSelectionChange();
        }
      }

      // Non-select tools: start paint drag
      editorState.isDragging = true;
      if (tile) {
        onEditorTileAction(tile.col, tile.row);
      }
    },
    [
      officeState,
      isEditMode,
      editorState,
      screenToTile,
      screenToWorld,
      onEditorTileAction,
      onEditorEraseAction,
      onEditorSelectionChange,
      onDeleteSelected,
      onRotateSelected,
      hitTestDeleteButton,
      hitTestRotateButton,
      panRef,
      characterAt,
    ],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (e.button >= 3) return e.preventDefault(); // side buttons: ignored (G1)
      if (e.button === 1) {
        isPanningRef.current = false;
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = isEditMode ? 'crosshair' : 'default';
        return;
      }
      const characterDrag = characterDragRef.current;
      characterDragRef.current = null;
      // cld-gui (ELEVATOR): let go over another floor (all floors shown), it rides there. The
      // floors' store holds what is carried: the canvas's own drag ends when the pointer
      // crosses a label or a bubble on the way.
      const carried = floorsSnapshot().dragging;
      if ((characterDrag?.moving || carried) && e.button === 0 && !isEditMode) {
        const floorId = otherFloorAt(e.clientX, e.clientY);
        const id = carried?.id ?? characterDrag?.id;
        const resting = id !== undefined ? officeState.characters.get(id) : undefined;
        if (resting?.cldRest) {
          // cld-gui (LOUNGE): a resting one goes where it is dropped (a seat, a tile, any floor).
          const hit = iso ? isoAt(e.clientX, e.clientY) : null;
          const pos = iso ? null : pointToWorld(e.clientX, e.clientY);
          if (hit?.kind === 'floor') visitFloor(officeState, resting.id, hit.id);
          else if (hit && (hit.kind === 'tile' || hit.kind === 'item'))
            restDropAt(officeState, resting, hit.col, hit.row);
          else if (pos)
            restDropAt(
              officeState,
              resting,
              Math.floor(pos.worldX / TILE_SIZE),
              Math.floor(pos.worldY / TILE_SIZE),
            );
        } else if (floorId && id !== undefined) visitFloor(officeState, id, floorId);
        endFloorDrag();
        suppressClickRef.current = true; // the click that ends a drag selects nothing
        if (canvasRef.current) canvasRef.current.style.cursor = 'default';
        return;
      }
      if (e.button === 2) {
        isEraseDraggingRef.current = false;
        // Close the in-progress stroke so the next stroke starts a fresh undo
        // entry instead of bundling into this one.
        editorState.endStroke();
        return;
      }

      // Handle drag-to-move completion
      if (editorState.dragUid) {
        if (editorState.isDragMoving) {
          onDrop(
            editorState.dragUid,
            editorState.ghostCol - editorState.dragOffsetCol,
            editorState.ghostRow - editorState.dragOffsetRow,
            { duplicate: editorState.dragDuplicate },
          );
        } else {
          // Click (no movement) — toggle selection. Selecting also collapses
          // the open tool tab, so the toolbar shows the item's own controls.
          if (editorState.selectedFurnitureUid === editorState.dragUid) {
            editorState.clearSelection();
          } else {
            editorState.selectPlacedFurniture(editorState.dragUid);
          }
        }
        editorState.clearDrag();
        onEditorSelectionChange();
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = 'crosshair';
        return;
      }

      editorState.isDragging = false;
      // Releasing the mouse ends the stroke, so the next click starts a fresh
      // undo entry — one click-drag collapses to a single undo.
      editorState.endStroke();
    },
    [
      editorState,
      isEditMode,
      onDrop,
      onEditorSelectionChange,
      officeState,
      otherFloorAt,
      iso,
      isoAt,
      pointToWorld,
    ],
  );

  // Shared by mouse click and touch tap — both resolve a viewport point to a
  // character / pet / seat interaction. `double`: the second click of a
  // double-click (cld-gui T-0025), which focuses and follows, never toggles off.
  const performTap = useCallback(
    (clientX: number, clientY: number, double = false) => {
      if (offFloor(clientX, clientY)) {
        const id = otherFloorAt(clientX, clientY);
        if (id) goToFloor(id);
        return;
      }
      const pos = iso ? null : screenToWorld(clientX, clientY);

      const hitId = characterAt(clientX, clientY);
      if (hitId !== null) {
        // Dismiss any active bubble on click
        officeState.dismissBubble(hitId);
        // Two-step (mobile): first tap selects + follows so the status label
        // shows; only a repeat tap on the same character opens its terminal.
        // Deselection is tapping empty floor, as ever.
        if (tapSelectsFirst) {
          if (officeState.selectedAgentId === hitId) {
            onClick(hitId);
          } else {
            officeState.selectedAgentId = hitId;
            officeState.cameraFollowId = hitId;
          }
          return;
        }
        // Toggle selection: click same agent deselects, different agent selects
        if (officeState.selectedAgentId === hitId && !double) {
          officeState.selectedAgentId = null;
          officeState.cameraFollowId = null;
        } else {
          officeState.selectedAgentId = hitId;
          officeState.cameraFollowId = hitId;
        }
        onClick(hitId); // still focus terminal
        return;
      }

      // Pet hit: toggle the heart bubble.
      const petId = pos ? officeState.getPetAt(pos.worldX, pos.worldY) : null;
      if (petId !== null) {
        const pet = officeState.pets.find((p) => p.id === petId);
        if (pet?.bubbleType) {
          officeState.dismissPetBubble(petId);
        } else {
          officeState.showPetBubble(petId);
        }
        return;
      }

      // No agent hit — check seat click while agent is selected
      if (officeState.selectedAgentId !== null) {
        const selectedCh = officeState.characters.get(officeState.selectedAgentId);
        // Skip seat reassignment for sub-agents
        if (selectedCh && !selectedCh.isSubagent) {
          const tile = screenToTile(clientX, clientY);
          if (tile) {
            const seatId = officeState.getSeatAtTile(tile.col, tile.row);
            if (seatId) {
              const seat = officeState.seats.get(seatId);
              if (seat && selectedCh) {
                if (selectedCh.seatId === seatId) {
                  // Clicked own seat — send agent back to it
                  officeState.sendToSeat(officeState.selectedAgentId);
                  officeState.selectedAgentId = null;
                  officeState.cameraFollowId = null;
                  return;
                } else if (!seat.assigned) {
                  // Clicked available seat — reassign
                  officeState.reassignSeat(officeState.selectedAgentId, seatId);
                  officeState.selectedAgentId = null;
                  officeState.cameraFollowId = null;
                  transport.send({
                    type: 'saveAgentSeats',
                    seats: officeState.getPersistableSeats(),
                  });
                  return;
                }
              }
            }
          }
        }
        // Clicked empty space — deselect
        officeState.selectedAgentId = null;
        officeState.cameraFollowId = null;
      }
    },
    [
      officeState,
      onClick,
      screenToWorld,
      otherFloorAt,
      screenToTile,
      tapSelectsFirst,
      offFloor,
      characterAt,
      iso,
    ],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isEditMode) return; // handled by mouseDown/mouseUp
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      performTap(e.clientX, e.clientY, e.detail >= 2);
    },
    [isEditMode, performTap],
  );

  const handleMouseLeave = useCallback((e: React.MouseEvent) => {
    isPanningRef.current = false;
    // cld-gui (LOUNGE): a character carried across its own nameplate (a DOM box over the canvas)
    // is still carried when the pointer comes back; only a released button ends it.
    if (!(e.buttons & 1)) characterDragRef.current = null;
    isEraseDraggingRef.current = false;
    editorState.isDragging = false;
    editorState.endStroke();
    editorState.clearDrag();
    editorState.ghostCol = -1;
    editorState.ghostRow = -1;
    officeState.hoveredAgentId = null;
    officeState.hoveredTile = null;

    // Reset cursor in non-edit mode so pointer doesn't get stuck after hovering a pet.
    if (!isEditMode) {
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.style.cursor = 'default';
      }
    }
  }, [officeState, editorState, isEditMode]);

  // Alt tapped or released with the mouse already down flips the in-flight drag
  // between move and copy without waiting for the next mouse move — the rAF
  // loop redraws the ghost from editorState every frame, so no re-render here.
  // The cursor flips with it: a stationary pointer gets no mouse move to do it.
  useEffect(() => {
    if (!isEditMode) return;
    const syncAlt = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || !editorState.dragUid) return;
      editorState.dragDuplicate = e.type === 'keydown';
      const canvas = canvasRef.current;
      if (canvas && editorState.isDragMoving) canvas.style.cursor = dragMoveCursor(editorState);
    };
    window.addEventListener('keydown', syncAlt);
    window.addEventListener('keyup', syncAlt);
    return () => {
      window.removeEventListener('keydown', syncAlt);
      window.removeEventListener('keyup', syncAlt);
    };
  }, [isEditMode, editorState]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (isEditMode || isContextHandled(e.nativeEvent)) return; // G1: a menu opened instead
      // Right-click to walk selected agent to tile
      if (officeState.selectedAgentId !== null) {
        const tile = screenToTile(e.clientX, e.clientY);
        if (tile) {
          officeState.walkToTile(officeState.selectedAgentId, tile.col, tile.row);
        }
      }
    },
    [isEditMode, officeState, screenToTile],
  );

  // The wheel (zoom about the cursor) is useGameControls' since T-0025.

  // G1: the character menu (CharacterMenu shows for the selected one) opens on right-click, a
  // long press and the Menu key; the first two select what is under the pointer, the key keeps
  // the selection it finds.
  useEffect(() => {
    return registerContextTarget('character', ({ target, x, y, keyboard }) => {
      if (isEditMode) return false;
      if (keyboard) return officeState.selectedAgentId !== null;
      const hitId = target === canvasRef.current ? characterAt(x, y) : null;
      if (hitId === null) return false;
      officeState.dismissBubble(hitId);
      officeState.selectedAgentId = hitId;
      officeState.cameraFollowId = hitId;
      return true;
    });
  }, [officeState, isEditMode, characterAt]);

  // Touch: one-finger pan, two-finger pinch zoom, short tap = click, hold = menu.
  useCanvasTouchGestures({
    canvasRef,
    enabled: !isEditMode,
    zoom,
    onZoomChange: (z: number) => {
      noteManualCamera(); // a pinch
      onZoomChange(z);
    },
    panRef,
    clampPan,
    onManualPan: () => {
      officeState.breakCameraFollow();
      noteManualCamera();
    },
    onTap: performTap,
    onLongPress: (x, y) => openContextMenu({ target: canvasRef.current, x, y, keyboard: false }),
  });

  // Prevent default middle-click browser behavior (auto-scroll); the mouse's side buttons
  // (back / forward) do nothing on the office (G1: Back belongs to the open panel).
  const handleAuxClick = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || e.button >= 3) e.preventDefault();
  }, []);

  return (
    // select-none (cld-gui T-0025): a drag on the office never selects text.
    <div ref={containerRef} className="w-full h-full relative overflow-hidden bg-bg select-none">
      <canvas
        ref={canvasRef}
        data-testid={OFFICE_CANVAS_TEST_ID}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        onAuxClick={handleAuxClick}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
        className="block touch-none"
      />
    </div>
  );
}

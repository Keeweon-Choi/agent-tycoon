/**
 * The elevator (T-0027): the floor panel on the office's left edge (desktop),
 * its 편집 mode (층 추가, 층 이름, 층 삭제, rooms and characters dragged to
 * another floor), the doors that play while the floor changes (both shells)
 * and the floor picker in the phone's top bar. Floor changes are cosmetic:
 * any logged-in client may make them; a read-only one only rides.
 */
import './floors.css';

import type {
  CSSProperties,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  TouchEvent,
} from 'react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { BuildingFloor } from '../../../core/src/messages.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { ELEVATOR_LIST_OPEN_STORAGE_KEY } from '../constants.js';
import { useIsMobile } from '../hooks/useIsMobile.js';
import { t, translate } from '../i18n/index.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { getCachedSprite } from '../office/sprites/spriteCache.js';
import { BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE } from '../office/sprites/spriteData.js';
import { findTouch } from '../touch/touchPrimitives.js';
import { transport } from '../transport/index.js';
import { CameraModeControl } from './CameraModeControl.js';
import { visitFloor } from './elevator.js';
import { interiorOn } from './features.js';
import type { FloorBadge } from './floors.js';
import {
  DOOR_CLOSE_MS,
  DOOR_HOLD_MS,
  DOOR_OPEN_MS,
  endFloorDrag,
  goToFloor,
  setFloorEditing,
  setStackedView,
  stepFloor,
  swipeStep,
  useFloors,
  wanderTiles,
} from './floors.js';
import { HudPanel } from './hud/fixedPanels.js';
import { useHud } from './hud/hudStore.js';
import { Movable } from './hud/Movable.js';
import { layerZ } from './hud/windowModel.js';
import { Icon } from './icons/Icon.js';
import { useIsoView } from './iso/isoView.js';
import { useCldStore } from './officeStore.js';
import { staffWander } from './staff.js';

const ROOM_TYPE = 'application/x-cld-room';
const CHARACTER_TYPE = 'application/x-cld-character';
/** Sprite px per CSS px for the badge bubbles: the office's own size at zoom 2. */
const BADGE_SCALE = 2;

const badgeText = (badge: FloorBadge): string => t(`floor.badge.${badge}`);

type Carried = { room: string } | { character: string };

const moveTo = (floorId: string, what: Carried) =>
  transport.send({ type: 'moveToFloor', floorId, ...what });

/** What an HTML drag carries, when it is ours (a room or character chip). */
function carriedBy(e: DragEvent): Carried | null {
  const room = e.dataTransfer.getData(ROOM_TYPE);
  if (room) return { room };
  const character = e.dataTransfer.getData(CHARACTER_TYPE);
  return character ? { character } : null;
}
const isOurs = (e: DragEvent) =>
  e.dataTransfer.types.includes(ROOM_TYPE) || e.dataTransfer.types.includes(CHARACTER_TYPE);

/** The bubble a character on that floor would show, as on the office (pixel-exact). */
function BadgeBubble({ kind }: { kind: FloorBadge }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const sprite = kind === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE;
  const scale = BADGE_SCALE * Math.max(1, Math.round(window.devicePixelRatio || 1));
  useEffect(() => {
    const canvas = ref.current;
    const cached = getCachedSprite(sprite, scale);
    if (!canvas) return;
    canvas.width = cached.width;
    canvas.height = cached.height;
    canvas.getContext('2d')?.drawImage(cached, 0, 0);
  }, [sprite, scale]);
  return (
    <canvas
      ref={ref}
      className="cld-floor-badge"
      data-badge={kind}
      aria-hidden="true"
      style={{ width: sprite[0].length * BADGE_SCALE, height: sprite.length * BADGE_SCALE }}
    />
  );
}

/** A pixel arrow (CSS), up or down. */
const Arrow = ({ down = false, className = '' }: { down?: boolean; className?: string }) => (
  <span className={`cld-arrow ${down ? 'cld-arrow-down' : ''} ${className}`} aria-hidden="true" />
);

/** The elevator's ▲ / ▼: the pixel arrow in 픽셀 감성, a Lucide chevron in 모던 (the doors' lamp colours it while riding). */
const StepArrow = ({ down = false, moving = false }: { down?: boolean; moving?: boolean }) => (
  <Icon
    name={down ? 'chevron-down' : 'chevron-up'}
    className={moving ? 'cld-moving' : ''}
    pixel={<Arrow down={down} className={moving ? 'cld-moving' : ''} />}
  />
);

/** The doors' CSS animation times, from the same numbers as the store's timers. */
const DOOR_TIMES = {
  '--cld-door-close': `${DOOR_CLOSE_MS}ms`,
  '--cld-door-hold': `${DOOR_HOLD_MS}ms`,
  '--cld-door-open': `${DOOR_OPEN_MS}ms`,
} as CSSProperties;

/** The doors over the office while the floor changes, under the frame's
 *  indicator: the way the car goes and the floor it goes to. */
function ElevatorDoors() {
  const { doors, building } = useFloors();
  if (!doors) return null;
  const floors = building?.floors ?? [];
  const k = floors.findIndex((f) => f.id === doors.target);
  return (
    <div
      key={doors.seq}
      className={`cld-doors cld-doors-${doors.phase}`}
      data-testid="elevator-doors"
      aria-hidden="true"
      style={DOOR_TIMES}
    >
      <div className="cld-door cld-door-left" />
      <div className="cld-door cld-door-right" />
      <div className="cld-door-lintel">
        <span className="cld-door-indicator">
          <Arrow down={doors.dir === -1} />
          {k + 1}F
        </span>
      </div>
    </div>
  );
}

/** "2층 연구동", or just "2층" while the floor keeps its default name. */
const floorName = (n: number, name: string): string =>
  name === translate('floor.number', { number: n }, 'ko')
    ? t('floor.number', { number: n })
    : name;
const floorTitle = (n: number, name: string): string =>
  name === translate('floor.number', { number: n }, 'ko')
    ? t('floor.number', { number: n })
    : t('floor.named', { number: n, name });

/** Floors top first, with their number (1 = floor 1). */
const topFirst = (floors: BuildingFloor[]) =>
  floors.map((floor, k) => ({ floor, n: k + 1 })).reverse();

/** 꾸미기 (T-0053): upstream's layout editor, whose saves the daemon keeps as decor. */
interface Decorate {
  on: boolean;
  toggle: () => void;
}

/** ISO-PILOT: the isometric building's one view toggle, the whole building or this floor
 *  (the floors store's stacked view, which the setting 층 보기 also sets). */
function IsoViewToggle({ className }: { className: string }) {
  const iso = useIsoView();
  const { stacked } = useFloors();
  if (!iso) return null;
  return (
    <button
      type="button"
      className={className}
      data-testid="iso-view-toggle"
      aria-pressed={!stacked}
      aria-label={`${t('iso.view.label')}: ${stacked ? t('iso.view.building') : t('iso.view.floor')}`}
      onClick={() => setStackedView(!stacked)}
    >
      {stacked ? t('iso.view.building') : t('iso.view.floor')}
    </button>
  );
}

/** The floor list's last state on this device (closed unless it was left open). */
function loadListOpen(): boolean {
  try {
    return localStorage.getItem(ELEVATOR_LIST_OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Another floor wants a look: a permission first (the floor badges). */
function floorAlarm(badges: Record<string, FloorBadge>): FloorBadge | null {
  const kinds = Object.values(badges);
  return kinds.includes('permission') ? 'permission' : kinds.length ? 'waiting' : null;
}

/**
 * PARTY-FRAME (owner 11-04 (나)): the elevator is a 40px ▲ 1F ▼ strip on the office's left edge; the
 * lamp opens the floor list (the floors, 건물/층, 편집, 인테리어) beside it, remembered per device. A
 * drag that may land on a floor opens the list while it lasts.
 */
function ElevatorPanel({
  canEdit,
  decorate,
  officeState,
}: {
  canEdit: boolean;
  decorate?: Decorate;
  officeState: OfficeState;
}) {
  const { building, current, doors, badges, dragging, editing } = useFloors();
  const [over, setOver] = useState<string | null>(null);
  const [carrying, setCarrying] = useState(false);
  const [listOpen, setListOpen] = useState(loadListOpen);
  // One floor: nothing to ride, so only the way to 층 추가 (none for a viewer); the camera buttons stay.
  const ride = !!building && (building.floors.length > 1 || canEdit);
  const floors = building?.floors ?? [];
  const shown = floors.findIndex((f) => f.id === (doors?.target ?? current));
  const takes = canEdit && floors.length > 1 && (dragging !== null || carrying);
  const showList = listOpen || takes;
  const alarm = floorAlarm(badges);
  const toggleList = () => {
    setListOpen(!listOpen);
    try {
      localStorage.setItem(ELEVATOR_LIST_OPEN_STORAGE_KEY, listOpen ? '0' : '1');
    } catch {
      // Storage blocked: the list stays as set for this page.
    }
  };
  // UI-BUGS-1104: drawn in the office's own layer (z 47), under the HUD layer's windows (48): a window
  // over it covers it, never the other way round. Not a HudPanel (the card bar and the dock are).
  return (
    <Movable id="floors" label={t('floor.panel')} className="cld-elevator-slot" z={47}>
      <div className="cld-elevator">
        <div
          className="cld-elevator-ride"
          onDragEnter={(e) => isOurs(e) && setCarrying(true)}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setCarrying(false);
          }}
          onDrop={() => setCarrying(false)}
        >
          <div className="cld-elevator-col">
            {ride && (
              <nav className="cld-elevator-strip" aria-label={t('floor.elevator')}>
                <button
                  type="button"
                  className="cld-elevator-step"
                  data-testid="elevator-up"
                  aria-label={t('floor.up')}
                  disabled={shown >= floors.length - 1}
                  onClick={() => stepFloor(1)}
                >
                  <StepArrow moving={!!doors && doors.dir !== -1} />
                </button>
                <button
                  type="button"
                  className="cld-elevator-display"
                  data-testid="elevator-display"
                  aria-expanded={showList}
                  aria-label={`${floorTitle(shown + 1, floors[shown]?.name ?? '')} · ${t('floor.listToggle')}`}
                  aria-live="polite"
                  onClick={toggleList}
                >
                  <span>
                    {shown + 1}
                    <span className="cld-lamp-f">F</span>
                  </span>
                  {alarm && !showList && <span className={`cld-dot ${alarm === 'permission' ? 'cld-permission' : ''}`} />}
                </button>
                <button
                  type="button"
                  className="cld-elevator-step"
                  data-testid="elevator-down"
                  aria-label={t('floor.down')}
                  disabled={shown <= 0}
                  onClick={() => stepFloor(-1)}
                >
                  <StepArrow down moving={doors?.dir === -1} />
                </button>
              </nav>
            )}
            {/* HUD-1B (owner 11-04): where to look, right under the floor (자동 / 내 캐릭터 / 로비). */}
            <CameraModeControl />
          </div>
          {ride && showList && (
            <nav className="cld-elevator-panel" aria-label={t('floor.list')} data-testid="elevator-list">
              {takes && dragging && <div className="cld-carry">{t('floor.carrying', { name: dragging.name })}</div>}
              <ol className={`cld-floor-buttons ${floors.length < 2 ? 'cld-none' : ''}`}>
                {topFirst(floors).map(({ floor, n }) => {
                  const badge = badges[floor.id];
                  const label = `${floorTitle(n, floor.name)}${badge ? ` · ${badgeText(badge)}` : ''}`;
                  return (
                    <li key={floor.id}>
                      <button
                        type="button"
                        className={`cld-floor-button ${takes ? 'cld-drop' : ''} ${takes && over === floor.id ? 'cld-drop-over' : ''}`}
                        data-floor-id={floor.id}
                        aria-current={floor.id === current}
                        aria-label={label}
                        onClick={() => goToFloor(floor.id)}
                        // A character carried off the canvas rides there and visits (ELEVATOR):
                        // only the character moves, its room stays (the editor moves rooms).
                        onMouseEnter={() => setOver(floor.id)}
                        onMouseLeave={() => setOver(null)}
                        onMouseUp={() => {
                          if (!dragging || !canEdit) return;
                          visitFloor(officeState, dragging.id, floor.id);
                          endFloorDrag();
                        }}
                        // A room or character chip from the floor editor.
                        onDragOver={(e) => {
                          if (!canEdit || !isOurs(e)) return;
                          e.preventDefault();
                          setOver(floor.id);
                        }}
                        onDrop={(e) => {
                          const what = canEdit && carriedBy(e);
                          if (!what) return;
                          e.preventDefault();
                          moveTo(floor.id, what);
                          setOver(null);
                        }}
                      >
                        {n}
                        {badge && <BadgeBubble kind={badge} />}
                        <span className="cld-floor-name" aria-hidden="true">
                          {floorName(n, floor.name)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              {floors.length > 1 && <IsoViewToggle className="cld-elevator-edit" />}
              {canEdit && (
                <button
                  type="button"
                  className="cld-elevator-edit"
                  aria-pressed={editing}
                  onClick={() => setFloorEditing(!editing)}
                >
                  {t('floor.edit')}
                </button>
              )}
              {canEdit && decorate && (
                <button
                  type="button"
                  className="cld-elevator-decorate"
                  aria-pressed={decorate.on}
                  onClick={decorate.toggle}
                >
                  {t('floor.decorate')}
                </button>
              )}
            </nav>
          )}
        </div>
        {canEdit && editing && <FloorEditor />}
      </div>
    </Movable>
  );
}

/** 층 편집: add, rename and remove floors; drag (or pick up and place) rooms
 *  and characters onto another floor. */
function FloorEditor() {
  const { building } = useFloors();
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<BuildingFloor | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [held, setHeld] = useState<Carried | null>(null);
  const [over, setOver] = useState<string | null>(null);
  useEffect(() => {
    // Esc: cancel the question, else put down what is held, else close the editor.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || renaming) return;
      if (resetting) setResetting(null);
      else if (removing) setRemoving(null);
      else if (held) setHeld(null);
      else setFloorEditing(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [renaming, resetting, removing, held]);
  if (!building) return null;
  const floors = building.floors;
  const rename = () => {
    if (renaming && renaming.name.trim())
      transport.send({ type: 'renameFloor', floorId: renaming.id, name: renaming.name.trim() });
    setRenaming(null);
  };
  const onRenameKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter') rename();
    if (e.key === 'Escape') {
      e.stopPropagation();
      setRenaming(null);
    }
  };
  const isHeld = (what: Carried) => JSON.stringify(what) === JSON.stringify(held);
  const chip = (what: Carried, text: string, title: string) => (
    <button
      key={'room' in what ? `r:${what.room}` : `c:${what.character}`}
      type="button"
      className={`cld-chip ${'character' in what ? 'cld-character' : ''}`}
      draggable
      title={title}
      aria-pressed={isHeld(what)}
      onDragStart={(e) => {
        if ('room' in what) e.dataTransfer.setData(ROOM_TYPE, what.room);
        else e.dataTransfer.setData(CHARACTER_TYPE, what.character);
        e.dataTransfer.setData('text/plain', text); // Firefox drags only with data
        e.dataTransfer.effectAllowed = 'move';
      }}
      // Without a mouse: pick it up here, then 여기로 on a floor.
      onClick={() => setHeld(isHeld(what) ? null : what)}
    >
      {text}
    </button>
  );
  return (
    <section
      className="cld-floor-editor"
      aria-label={t('floor.editor')}
      data-testid="floor-editor"
      data-no-drag
    >
      <h2>{t('floor.editor')}</h2>
      {topFirst(floors).map(({ floor, n }) => (
        <div
          key={floor.id}
          className={`cld-floor-row ${over === floor.id ? 'cld-drop-over' : ''}`}
          data-floor-row={floor.id}
          onDragOver={(e) => {
            if (!isOurs(e)) return;
            e.preventDefault();
            setOver(floor.id);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
          }}
          onDrop={(e) => {
            const what = carriedBy(e);
            setOver(null);
            if (!what) return;
            e.preventDefault();
            moveTo(floor.id, what);
          }}
        >
          <div className="cld-floor-row-head">
            <span className="cld-num">{n}</span>
            {renaming?.id === floor.id ? (
              <input
                autoFocus
                aria-label={t('floor.renameLabel', { number: n })}
                maxLength={24}
                value={renaming.name}
                onChange={(e) => setRenaming({ id: floor.id, name: e.target.value })}
                onKeyDown={onRenameKey}
                onBlur={rename}
              />
            ) : (
              <span className="cld-name">{floorName(n, floor.name)}</span>
            )}
            {held && !floor.rooms.some((r) => isHeld({ room: r })) ? (
              <button
                type="button"
                className="cld-small-button"
                onClick={() => {
                  moveTo(floor.id, held);
                  setHeld(null);
                }}
              >
                {t('floor.placeHere')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="cld-small-button"
                  onClick={() => setRenaming({ id: floor.id, name: floor.name })}
                >
                  {t('floor.rename')}
                </button>
                {n > 1 && (
                  <button
                    type="button"
                    className="cld-small-button cld-danger"
                    onClick={() => setRemoving(floor)}
                  >
                    {t('floor.delete')}
                  </button>
                )}
              </>
            )}
          </div>
          <div className="cld-chips">
            {floor.rooms.map((room) =>
              chip({ room }, room, t('floor.roomDrag', { name: room })),
            )}
            {floor.characters.map((name) =>
              chip({ character: name }, name, t('floor.characterAlone', { name })),
            )}
            {!floor.rooms.length && !floor.characters.length && (
              <span className="cld-empty">{t('floor.empty')}</span>
            )}
          </div>
        </div>
      ))}
      {!!building.decor?.length && (
        <div className="cld-decor" aria-label={t('floor.decor')}>
          <h3>{t('floor.decor')}</h3>
          {building.decor.map(({ room, stored }) => (
            <div key={room} className="cld-floor-row-head" data-decor-room={room}>
              <span className="cld-name">{room}</span>
              {stored > 0 && (
                <span
                  className="cld-empty"
                  title={t('floor.storedHelp')}
                >
                  {t('floor.stored', { count: stored })}
                </span>
              )}
              <button type="button" className="cld-small-button" onClick={() => setResetting(room)}>
                {t('floor.resetLayout')}
              </button>
            </div>
          ))}
        </div>
      )}
      <footer>
        <Button
          size="sm"
          variant={floors.length >= 9 ? 'disabled' : 'default'}
          disabled={floors.length >= 9}
          onClick={() => transport.send({ type: 'addFloor' })}
        >
          {t('floor.add')}
        </Button>
        <Button
          size="sm"
          variant={building.perProject ? 'active' : 'default'}
          aria-pressed={building.perProject}
          title={t('floor.perProjectHelp')}
          onClick={() => transport.send({ type: 'setFloorRule', perProject: !building.perProject })}
        >
          {t('floor.perProject')}
        </Button>
      </footer>
      {/* Portalled: the panel's transform would be its position:fixed box. */}
      {removing &&
        createPortal(
          <Modal isOpen onClose={() => setRemoving(null)} title={t('floor.delete')} zIndex={55}>
            <div className="px-10 pb-10 max-w-[420px] text-base">
              <p className="mb-8">{t('floor.deleteQuestion', { name: removing.name })}</p>
              <p className="mb-12 text-sm text-text-muted">
                {t('floor.deleteHelp')}
              </p>
              <div className="flex justify-end gap-8">
                <Button
                  size="sm"
                  variant="accent"
                  onClick={() => {
                    transport.send({ type: 'removeFloor', floorId: removing.id });
                    setRemoving(null);
                  }}
                >
                  {t('floor.deleteButton')}
                </Button>
                <Button size="sm" onClick={() => setRemoving(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          </Modal>,
          document.body,
        )}
      {resetting &&
        createPortal(
          <Modal isOpen onClose={() => setResetting(null)} title={t('floor.resetLayout')} zIndex={55}>
            <div className="px-10 pb-10 max-w-[420px] text-base">
              <p className="mb-12">
                {t('floor.resetQuestion', { name: resetting })}
              </p>
              <div className="flex justify-end gap-8">
                <Button
                  size="sm"
                  variant="accent"
                  onClick={() => {
                    transport.send({ type: 'resetRoomDecor', room: resetting });
                    setResetting(null);
                  }}
                >
                  {t('floor.resetButton')}
                </Button>
                <Button size="sm" onClick={() => setResetting(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          </Modal>,
          document.body,
        )}
    </section>
  );
}

/**
 * The building on the office (cld mode): the doors on both shells, the panel
 * on a desktop. Idle characters wander on their own floor, and a character
 * carried off the canvas is let go wherever the mouse is released.
 */
export function FloorLayer({
  officeState,
  decorate,
}: {
  officeState: OfficeState;
  decorate?: Decorate;
}) {
  const isMobile = useIsMobile();
  const { officeReadOnly } = useCldStore();
  const { dragging } = useFloors();
  useEffect(() => {
    officeState.wanderTiles = (ch) =>
      staffWander(ch) ?? wanderTiles(officeState.walkableTiles, officeState.getLayout(), ch);
    return () => {
      officeState.wanderTiles = null;
    };
  }, [officeState]);
  useEffect(() => {
    if (!dragging) return;
    // After a floor button's own mouseup (bubbling reaches the window last);
    // a release outside the window never comes, so leaving it ends the drag too.
    window.addEventListener('mouseup', endFloorDrag);
    window.addEventListener('blur', endFloorDrag);
    return () => {
      window.removeEventListener('mouseup', endFloorDrag);
      window.removeEventListener('blur', endFloorDrag);
    };
  }, [dragging]);
  return (
    <>
      <ElevatorDoors />
      {!isMobile && (
        <ElevatorLayer>
          <ElevatorPanel
            canEdit={!officeReadOnly}
            decorate={interiorOn ? decorate : undefined}
            officeState={officeState}
          />
        </ElevatorLayer>
      )}
    </>
  );
}

/** The phone's floor picker (top bar): tap for the list, swipe up or down
 *  for the next floor. Only with more than one floor. */
export function FloorPicker() {
  const isMobile = useIsMobile();
  const { building, current, doors, badges } = useFloors();
  // The list's top (px): fixed under the picker, across the screen inside the safe area.
  const [open, setOpen] = useState<number | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const touch = useRef<{ id: number; x: number; y: number; swiped: boolean } | null>(null);
  const floors = building?.floors ?? [];
  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!isMobile || floors.length < 2) return null;
  const shown = floors.findIndex((f) => f.id === (doors?.target ?? current));
  // Only other floors have badges: the dot says one of them wants a look.
  const alarm = floorAlarm(badges);
  const onTouchStart = (e: TouchEvent) => {
    const t = e.changedTouches[0];
    if (!touch.current && t)
      touch.current = { id: t.identifier, x: t.clientX, y: t.clientY, swiped: false };
  };
  const onTouchMove = (e: TouchEvent) => {
    const s = touch.current;
    const t = s && findTouch(e.changedTouches, s.id);
    if (!s || !t || s.swiped) return;
    const step = swipeStep(t.clientX - s.x, t.clientY - s.y);
    if (step) {
      s.swiped = true; // one floor per swipe
      setOpen(null);
      stepFloor(step);
    }
  };
  const onTouchEnd = (e: TouchEvent) => {
    const s = touch.current;
    if (!s || !findTouch(e.changedTouches, s.id)) return;
    touch.current = null;
    if (s.swiped) e.preventDefault(); // no click after a swipe
  };
  return (
    <div className="cld-floor-picker">
      <button
        ref={button}
        type="button"
        className="cld-floor-picker-button"
        data-testid="floor-picker"
        aria-haspopup="true"
        aria-expanded={open !== null}
        aria-label={t('floor.pickerLabel', { name: floorTitle(shown + 1, floors[shown]?.name ?? '') })}
        onClick={() =>
          setOpen(open === null ? (button.current?.getBoundingClientRect().bottom ?? 0) + 6 : null)
        }
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={() => (touch.current = null)}
      >
        <span className="cld-updown">
          <Arrow />
          <Arrow down />
        </span>
        {shown + 1}F
        {alarm && <span className={`cld-dot ${alarm === 'permission' ? 'cld-permission' : ''}`} />}
      </button>
      {open !== null && (
        <ul className="cld-floor-list" aria-label={t('floor.list')} style={{ top: open }}>
          {topFirst(floors).map(({ floor, n }) => {
            const badge = floor.id === current ? undefined : badges[floor.id];
            return (
              <li key={floor.id}>
                <button
                  type="button"
                  data-floor-id={floor.id}
                  aria-current={floor.id === current}
                  aria-label={`${floorTitle(n, floor.name)}${badge ? ` · ${badgeText(badge)}` : ''}`}
                  onClick={() => {
                    setOpen(null);
                    goToFloor(floor.id);
                  }}
                >
                  <span className="cld-num">{n}</span>
                  <span className="cld-name">{floorName(n, floor.name)}</span>
                  {badge && <BadgeBubble kind={badge} />}
                </button>
              </li>
            );
          })}
          <li>
            <IsoViewToggle className="cld-iso-view" />
          </li>
        </ul>
      )}
    </div>
  );
}

/**
 * WINDOW-LAYERS (owner 11-06 20:57): the elevator column takes its turn in front with the windows and the
 * other panels, so it lives in the HUD layer (the panel slot covers the same box as the office region). Its
 * box is not one of the fixed panels a window's title or the camera keeps clear of (data-hud-unmeasured):
 * it never was.
 */
function ElevatorLayer({ children }: { children: ReactNode }) {
  const z = layerZ(useHud(), 'elevator');
  return (
    <HudPanel>
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: z }}
        data-hud-panel="elevator"
        data-hud-unmeasured
      >
        {children}
      </div>
    </HudPanel>
  );
}

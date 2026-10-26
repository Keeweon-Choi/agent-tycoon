/**
 * T-0041: who is in the office, and when. Two kinds of staff (kinds.ts):
 * - permanent staff, the orchestrators: at their desks during office hours;
 *   after hours an idle one walks out of the door and its desk shows 퇴근,
 *   a working one stays on (야근), and they come back in at opening time;
 * - temps (sub-agents, teammates, Codex workers): they walk in from the door
 *   when their work starts, sit at a spare desk in their lead's room, linger
 *   in the lounge after it (temps.ts shouldGoHome) and walk out.
 *
 * Cosmetic only: nothing here touches an agent. The game loop calls
 * staffStep a few times a second; useExtensionMessages hands removals of
 * temps over (deferRemoval) so they can linger, and asks before seating a
 * Codex worker again (codexWanted). Off the cld office (no officeState) every
 * hook answers "as upstream".
 */
import { useSyncExternalStore } from 'react';

import type { CodexTask } from '../../../core/src/messages.js';
import {
  HOME_GRACE_MS,
  LEAVE_TIMEOUT_SEC,
  NEAR_SEAT_TILES,
  STAFF_HOLD_MAX_SEC,
  STAFF_SETTLE_SEC,
  STAFF_STEP_SEC,
  STAFF_VISUALS_WAIT_SEC,
} from '../constants.js';
import { t as tr } from '../i18n/index.js';
import { startMatrixEffect } from '../office/engine/matrixEffectState.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { findPath, isWalkable } from '../office/layout/tileMap.js';
import { type Character, CharacterState, TILE_SIZE, TileType } from '../office/types.js';
import { isBrowserRuntime, isE2E } from '../runtime.js';
import { employeeBusyElsewhere, employeeName, employeeOf, setSpawnLookup } from './employees.js';
import { characterRingOf, characterVisualOf } from './ez/visuals.js';
import { floorIndexAt, floorRects } from './floors.js';
import { isOff } from './format.js';
import { characterKind, characterName } from './kinds.js';
import { beginRest, endRest, isLoungeZone as isLounge } from './lounge.js';
import { modelBadge } from './modelBadges.js';
import { dutyFor, isOfficeOpen, officeHours } from './officeHours.js';
import { cldGetSnapshot, cldLocalEvent, virtualAgentId } from './officeStore.js';
import {
  codexTaskLine,
  homeLine,
  isFinishedCodex,
  shouldGoHome,
  taskLine,
  type TempKind,
  type TempPhase,
  type TempRow,
  workRefOf,
} from './temps.js';

type Tile = { col: number; row: number };

interface Rec {
  id: number;
  firstSeen: number;
  // Temps
  temp?: {
    kind: TempKind;
    label: string;
    model: string | null;
    arrivedAt: number;
    lastWorkAt: number;
    phase: TempPhase;
    /** It came in (or was found in) and has its place. */
    placed: boolean;
    /** Its spawn is over (sub-agents) or it was closed (teammates). */
    released: boolean;
    /** What really removes it, once it walked out (the upstream removal). */
    final?: () => void;
    /** Game time it set off for the door. */
    leavingSince: number;
    /** Where it may wander while lingering ([] while leaving). */
    wander: Tile[] | null;
  };
  // Permanent staff
  idleSince?: number;
  /** The door a temp's walk out was sent to: the only way out. */
  door?: Tile;
  /** Placed by a step (held out of sight before, while loading). */
  decided?: boolean;
  held?: boolean;
  /** Off duty (퇴근): resting in the building, ch.cldRest says where. */
  away?: boolean;
  wasActive?: boolean;
}

export interface StaffSnapshot {
  /** Office hours say open (always, with them off). */
  open: boolean;
  temps: TempRow[];
  /** Orchestrators gone home -> where their 퇴근 plate stands (world px). */
  away: Record<number, { x: number; y: number }>;
  /** Present after hours: working, idle in the grace, or on its way out. */
  overtime: number[];
}

let snap: StaffSnapshot = { open: true, temps: [], away: {}, overtime: [] };
let snapKey = '';
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const staffSnapshot = () => snap;
export const useStaff = () => useSyncExternalStore(subscribe, staffSnapshot);

const recs = new Map<number, Rec>();
/** Codex workers that went home this visit (they stay home until their task runs again). */
const goneCodex = new Set<number>();
/** A Codex worker's look, so the same task comes back as the same character. */
const codexLooks = new Map<number, { palette: number; hueShift: number }>();
let office: OfficeState | null = null;
/** TEMP-PLATES: a sub-agent character's spawn, for its roster employee. */
setSpawnLookup((id) => office?.subagentMeta.get(id)?.parentToolId);
/** Game time (s, the loop's dt: a fake page clock leaves it running) and when the office came up. */
let clock = 0;
let sinceStep = STAFF_STEP_SEC;
let lastMap: unknown = null;

/**
 * Loading: from the page's open, or a reconnect's resync (staffLoading),
 * until the first full state has settled: the office snapshot (the daemon sends
 * it last, after the agents' activity) and, a moment later, the rings
 * ToolOverlay works out from it. Meanwhile a character not seen before is
 * held out of sight; then everyone is put where the state says at once, with
 * no walk in or out (stepTemp/stepStaff `settling`).
 */
let loading: { since: number; office: unknown; settleAt: number | null } | null = {
  since: 0,
  office: null,
  settleAt: null,
};
/** In the browser the office is cld's: hold even before the first office snapshot. */
let holdWithoutOffice = isBrowserRuntime;

/** existingAgents (the page's first snapshot, or a resync after a reconnect). */
export function staffLoading(): void {
  loading = { since: clock, office: cldGetSnapshot().officeSnapshot, settleAt: null };
}

/** Whether a character is out of sight: home, or held while the office loads
 *  (also before the game loop's next look, for the DOM overlay). */
export function staffHides(ch: Character): boolean {
  if (ch.cldAway) return true;
  if (!loading || !(cldGetSnapshot().officeSnapshot || holdWithoutOffice)) return false;
  return !recs.get(ch.id)?.decided;
}

/** Out of sight until the state settles: characters this page has not placed yet. */
function hold(os: OfficeState): void {
  for (const ch of os.characters.values()) {
    if (ch.matrixEffect === 'despawn' && !ch.cldAway) continue;
    const rec = recs.get(ch.id) ?? newRec(ch.id);
    if (rec.decided) continue;
    rec.held = true;
    ch.cldAway = true;
    if (ch.matrixEffect === 'spawn') ch.matrixEffect = null; // not even its spawn is seen
  }
}

/** A temp on its way out of the door: it is leaving the office, so nothing (the 🤝 dotted line) may still point at it. */
export const tempLeaving = (id: number): boolean => recs.get(id)?.temp?.phase === 'leaving';

/** Both stand on the same floor of the building (always, in an office of one floor). */
export function sameFloor(a: Character, b: Character): boolean {
  const rects = office && floorRects(office.getLayout());
  return !rects || floorIndexAt(rects, a.tileRow) === floorIndexAt(rects, b.tileRow);
}

/** The director only runs in the cld office. */
const active = () => office !== null && cldGetSnapshot().officeSnapshot !== null;
const lingerMs = () => officeHours().lingerMin * 60_000;
/** The host's offset (T-0041 hostInfo), else this browser's. */
const hostOffset = () => cldGetSnapshot().hostInfo?.utcOffsetMin ?? -new Date().getTimezoneOffset();

// ── Hooks for useExtensionMessages ───────────────────────────

/**
 * A temp's removal (subagentClear, a sub-agent's turn-end clear, a teammate's
 * agentClosed): with the director on, it is kept to linger and `final` runs
 * once it walked out. False: remove it now, as upstream does.
 */
export function deferRemoval(id: number | null, final: () => void): boolean {
  if (id === null || !active()) return false;
  const ch = office!.characters.get(id);
  const rec = recs.get(id);
  if (!ch || !rec?.temp || rec.temp.kind === 'codex' || ch.matrixEffect === 'despawn') return false;
  rec.temp.final = final;
  if (rec.temp.released) return true; // a later turn end is nothing new for it
  rec.temp.released = true;
  rec.temp.lastWorkAt = Date.now();
  office!.setAgentTool(id, null);
  office!.setAgentActive(id, false);
  return true;
}

/**
 * A spawn about to get a sub-agent: a lingering one of the same lead with the
 * same task comes back as the same character (re-keyed to the new tool id).
 * Returns the tool id it was known by, when that changed.
 */
export function reviveSubagent(
  os: OfficeState,
  leadId: number,
  toolId: string,
  label: string,
  model: string | undefined,
): string | null {
  const same = os.getSubagentId(leadId, toolId);
  let found: number | null = same;
  if (found === null && label) {
    for (const [id, meta] of os.subagentMeta) {
      const t = recs.get(id)?.temp;
      if (meta.parentAgentId === leadId && t?.released && t.label === label) found = id;
    }
  }
  if (found === null) return null;
  const rec = recs.get(found);
  if (rec?.temp) {
    rec.temp.released = false;
    rec.temp.final = undefined;
    if (model) rec.temp.model = model;
  }
  const meta = os.subagentMeta.get(found)!;
  if (meta.parentToolId === toolId) return null;
  os.subagentIdMap.delete(`${leadId}:${meta.parentToolId}`);
  os.subagentIdMap.set(`${leadId}:${toolId}`, found);
  os.subagentMeta.set(found, { parentAgentId: leadId, parentToolId: toolId });
  return meta.parentToolId;
}

/** A sub-agent just created for a spawn: its task and the model it asked for. */
export function noteSubagent(id: number, label: string, model: string | undefined): void {
  const rec = recs.get(id) ?? newRec(id);
  rec.temp ??= newTemp('subagent', Date.now());
  rec.temp.label ||= label;
  if (model) rec.temp.model = model;
}

/** Whether a Codex task has a character: working, still lingering, or ended
 *  within the linger time (a page opened just after it finished). */
export function codexWanted(task: CodexTask, id: number, now = Date.now()): boolean {
  // The cld office only (asked before the game loop's first step, too).
  if (!cldGetSnapshot().officeSnapshot) return true;
  if (!isFinishedCodex(task.state)) {
    goneCodex.delete(id);
    return true;
  }
  if (goneCodex.has(id)) return false;
  if (recs.get(id)?.temp) return true;
  const ended = Date.parse(task.ended ?? '');
  return Number.isFinite(ended) && now - ended < lingerMs();
}
export const codexLook = (id: number) => codexLooks.get(id);

/** A row in a "+N" list was tapped: go to that character (floors follow, T-0027). */
export function staffFocus(id: number): void {
  office?.selectAndFollow(id);
}

/** Where a character may wander now (lounge, near its seat, nowhere while
 *  walking out), or null for the usual. */
export function staffWander(ch: Character): Tile[] | null {
  const rec = recs.get(ch.id);
  if (rec?.away) return []; // resting off duty: lounge.ts moves it
  return rec?.temp?.wander ?? null;
}

// ── Places ───────────────────────────────────────────────────

/** The rows of the floor tile row `row` is on (the whole map with one floor). */
function floorOf(os: OfficeState, row: number): { top: number; bottom: number } {
  const rects = floorRects(os.getLayout());
  const k = rects ? floorIndexAt(rects, row) : -1;
  return k >= 0
    ? { top: rects![k].row, bottom: rects![k].row + rects![k].rows }
    : { top: 0, bottom: os.tileMap.length };
}

let doorCache: { map: unknown; doors: Map<number, Tile[]> } | null = null;
/** A floor's doors: walkable tiles on its outer edge (next to the void). */
function doorsOn(os: OfficeState, top: number, bottom: number): Tile[] {
  if (doorCache?.map !== os.tileMap) doorCache = { map: os.tileMap, doors: new Map() };
  const cached = doorCache.doors.get(top);
  if (cached) return cached;
  const map = os.tileMap;
  const outside = (c: number, r: number) =>
    r < top || r >= bottom || c < 0 || c >= (map[r]?.length ?? 0) || map[r][c] === TileType.VOID;
  const doors: Tile[] = [];
  for (let r = top; r < bottom; r++)
    for (let c = 0; c < (map[r]?.length ?? 0); c++) {
      if (!isWalkable(c, r, map, os.blockedTiles)) continue;
      if (
        [outside(c - 1, r), outside(c + 1, r), outside(c, r - 1), outside(c, r + 1)].some(Boolean)
      )
        doors.push({ col: c, row: r });
    }
  doorCache.doors.set(top, doors);
  return doors;
}

/** Path from one tile to another; the target may be a seat (blocked to all but its sitter). */
function pathTo(os: OfficeState, from: Tile, to: Tile): Tile[] {
  const blocked = new Set(os.blockedTiles);
  blocked.delete(`${to.col},${to.row}`);
  return findPath(from.col, from.row, to.col, to.row, os.tileMap, blocked);
}

/** The nearest door on `at`'s floor with a way to `at`, or null. */
function doorFor(os: OfficeState, at: Tile): Tile | null {
  const { top, bottom } = floorOf(os, at.row);
  const dist = (t: Tile) => Math.abs(t.col - at.col) + Math.abs(t.row - at.row);
  for (const door of [...doorsOn(os, top, bottom)].sort((a, b) => dist(a) - dist(b))) {
    if (dist(door) === 0 || pathTo(os, door, at).length) return door;
  }
  return null;
}

const seatTile = (os: OfficeState, uid: string | null): Tile | null => {
  const seat = uid ? os.seats.get(uid) : undefined;
  return seat ? { col: seat.seatCol, row: seat.seatRow } : null;
};
const zoneAt = (os: OfficeState, t: Tile): string | null =>
  os.layout.areaTiles?.[t.row * os.layout.cols + t.col] ?? null;

/** A free seat in `zone` (not the lounge), nearest to `near`. */
function spareSeat(os: OfficeState, zone: string | null, near: Tile): string | null {
  if (!zone || isLounge(zone)) return null;
  let best: string | null = null;
  let bestD = Infinity;
  for (const [uid, seat] of os.seats) {
    if (seat.assigned || os.seatZone(uid) !== zone) continue;
    const d = Math.abs(seat.seatCol - near.col) + Math.abs(seat.seatRow - near.row);
    if (d < bestD) [best, bestD] = [uid, d];
  }
  return best;
}

/** The nearest free walkable tile to `near` on its floor. */
function nearestFreeTile(os: OfficeState, near: Tile, self: number): Tile | null {
  const { top, bottom } = floorOf(os, near.row);
  const taken = new Set(
    [...os.characters.values()]
      .filter((c) => c.id !== self)
      .map((c) => `${c.tileCol},${c.tileRow}`),
  );
  let best: Tile | null = null;
  let bestD = Infinity;
  for (const t of os.walkableTiles) {
    if (t.row < top || t.row >= bottom || taken.has(`${t.col},${t.row}`)) continue;
    const d = Math.abs(t.col - near.col) + Math.abs(t.row - near.row);
    if (d > 0 && d < bestD) [best, bestD] = [t, d];
  }
  return best;
}

function walk(ch: Character, path: Tile[]): void {
  ch.path = path;
  ch.moveProgress = 0;
  ch.state = CharacterState.WALK;
  ch.frame = 0;
  ch.frameTimer = 0;
}

function placeAt(ch: Character, t: Tile): void {
  ch.tileCol = t.col;
  ch.tileRow = t.row;
  ch.x = t.col * TILE_SIZE + TILE_SIZE / 2;
  ch.y = t.row * TILE_SIZE + TILE_SIZE / 2;
  ch.path = [];
  ch.moveProgress = 0;
}

const releaseSeat = (os: OfficeState, ch: Character) => {
  const seat = ch.seatId ? os.seats.get(ch.seatId) : undefined;
  if (seat) seat.assigned = false;
  ch.seatId = null;
};

// ── Who is who ───────────────────────────────────────────────

const newRec = (id: number): Rec => {
  const rec: Rec = { id, firstSeen: Date.now() };
  recs.set(id, rec);
  return rec;
};
const newTemp = (kind: TempKind, now: number): NonNullable<Rec['temp']> => ({
  kind,
  label: '',
  model: null,
  arrivedAt: now,
  lastWorkAt: now,
  phase: 'working',
  placed: false,
  released: false,
  leavingSince: 0,
  wander: null,
});

/** At work, as its ring says (ToolOverlay publishes it, EZ mode), else as
 *  the provider says (a character with no agent of its own never hears agent states), else
 *  as the FSM knows. */
function isWorking(ch: Character): boolean {
  const rows = cldGetSnapshot().officeSnapshot?.orchestrators;
  // RENEW-STUCK: a renewal (old turn over, new conversation coming) is work, not 퇴근.
  if (rows?.some((o) => o.renewing && (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === ch.id))
    return true;
  const ring = characterRingOf(ch.id);
  if (ring) return ring !== 'idle' && ring !== 'off';
  if (ch.id <= -1_000_000_000) {
    const row = rows?.find((o) => virtualAgentId(`orch:${o.name}`) === ch.id);
    return row?.busy === true;
  }
  return ch.isActive || ch.bubbleType === 'permission';
}

function codexTaskOf(id: number) {
  return cldGetSnapshot().codexTasks?.tasks.find(
    (t) => (t.agentId ?? virtualAgentId(`codex:${t.id}`)) === id,
  );
}

/** The temp's lead: a sub-agent's parent, a teammate's lead, a Codex task's orchestrator. */
function leadOf(os: OfficeState, ch: Character, kind: TempKind): number | null {
  if (kind === 'subagent') return os.subagentMeta.get(ch.id)?.parentAgentId ?? ch.parentAgentId;
  if (kind === 'teammate') return ch.leadAgentId ?? null;
  const task = codexTaskOf(ch.id);
  const orch = cldGetSnapshot().officeSnapshot?.orchestrators.find((o) => o.name === task?.project);
  const id = orch ? (orch.agentId ?? virtualAgentId(`orch:${orch.name}`)) : null;
  return id !== null && os.characters.has(id) ? id : null;
}

// ── Each step ────────────────────────────────────────────────

/** A temp comes in: from the door on its lead's floor when one leads to its
 *  place, else it appears there. Its place: a spare desk in its lead's room,
 *  the desk it has there already (a Codex contractor desk), else the nearest
 *  free tile to its lead. */
function arrive(
  os: OfficeState,
  ch: Character,
  leadId: number | null,
  how: 'door' | 'here' | 'walk',
): void {
  const lead = leadId !== null ? os.characters.get(leadId) : undefined;
  const leadAt = lead
    ? (seatTile(os, lead.seatId) ?? { col: lead.tileCol, row: lead.tileRow })
    : null;
  const zone = leadAt ? zoneAt(os, leadAt) : null;
  const own = seatTile(os, ch.seatId);
  const keep = own && !isLounge(zoneAt(os, own)) && (!zone || zoneAt(os, own) === zone);
  let target: Tile | null = keep ? own : null;
  if (!keep) {
    const near = leadAt ?? { col: ch.tileCol, row: ch.tileRow };
    const uid = spareSeat(os, zone, near);
    releaseSeat(os, ch);
    if (uid) {
      os.seats.get(uid)!.assigned = true;
      ch.seatId = uid;
      target = seatTile(os, uid);
    } else target = leadAt ? nearestFreeTile(os, leadAt, ch.id) : null;
  }
  target ??= { col: ch.tileCol, row: ch.tileRow };
  if (how === 'walk') {
    const path = pathTo(os, { col: ch.tileCol, row: ch.tileRow }, target);
    if (path.length) return walk(ch, path);
  }
  const door = how === 'door' ? doorFor(os, target) : null;
  if (door) {
    placeAt(ch, door);
    const path = pathTo(os, door, target);
    if (path.length) walk(ch, path);
  } else placeAt(ch, target);
  if (how === 'door') startMatrixEffect(ch, 'spawn');
  if (door || !ch.seatId || !ch.isActive) return;
  // Seated and at work already: sit down.
  ch.state = CharacterState.TYPE;
  ch.dir = os.seats.get(ch.seatId)!.facingDir;
}

/** Work is over: the lounge on its floor (a free sofa there if any), else stay near its seat. */
function linger(os: OfficeState, ch: Character, t: NonNullable<Rec['temp']>): void {
  const { top, bottom } = floorOf(os, ch.tileRow);
  const doors = new Set(doorsOn(os, top, bottom).map((d) => `${d.col},${d.row}`));
  const lounge = os.walkableTiles.filter(
    (w) =>
      w.row >= top && w.row < bottom && isLounge(zoneAt(os, w)) && !doors.has(`${w.col},${w.row}`),
  );
  if (lounge.length) {
    const sofa = [...os.seats].find(
      ([uid, s]) =>
        !s.assigned && s.seatRow >= top && s.seatRow < bottom && isLounge(os.seatZone(uid)),
    )?.[0];
    if (sofa) os.reassignSeat(ch.id, sofa);
    else {
      releaseSeat(os, ch);
      const to = lounge[Math.floor(Math.random() * lounge.length)];
      const path = pathTo(os, { col: ch.tileCol, row: ch.tileRow }, to);
      if (path.length) walk(ch, path);
    }
    t.wander = lounge;
    return;
  }
  const home = seatTile(os, ch.seatId) ?? { col: ch.tileCol, row: ch.tileRow };
  t.wander = os.walkableTiles.filter(
    (w) =>
      w.row >= top &&
      w.row < bottom &&
      Math.abs(w.col - home.col) + Math.abs(w.row - home.row) <= NEAR_SEAT_TILES,
  );
}

/** Out of the door (a path to it), or false when there is none. */
function walkOut(os: OfficeState, rec: Rec, ch: Character): boolean {
  const at = { col: ch.tileCol, row: ch.tileRow };
  const door = doorFor(os, at);
  if (!door) return false;
  rec.door = door;
  const path = pathTo(os, at, door);
  if (path.length) walk(ch, path);
  return true;
}

/**
 * Out once it stands at the door its walk out was sent to (ELEVATOR step 4: any walkable
 * tile on the office's edge used to count, so a character sent home that the user walked or
 * dropped elsewhere left wherever it stopped by the entrance or another edge). Stopped
 * anywhere else, it sets off for that door again.
 */
function atDoor(os: OfficeState, rec: Rec, ch: Character): boolean {
  const door = rec.door;
  if (!door || ch.path.length || ch.cldRide) return false;
  if (ch.tileCol === door.col && ch.tileRow === door.row) return true;
  const path = pathTo(os, { col: ch.tileCol, row: ch.tileRow }, door);
  if (path.length) walk(ch, path);
  return false;
}

function finishTemp(os: OfficeState, rec: Rec, ch: Character): void {
  const t = rec.temp!;
  const leadId = leadOf(os, ch, t.kind);
  const { officeSnapshot: officeState, codexTasks } = cldGetSnapshot();
  const lead = leadId !== null ? os.characters.get(leadId) : undefined;
  const name = tempName(ch, t, rec.id);
  cldLocalEvent(
    homeLine(name, Math.max(0, t.lastWorkAt - t.arrivedAt)),
    lead ? characterName(lead, officeState, codexTasks) : null,
  );
  recs.delete(rec.id);
  if (t.kind === 'codex') {
    codexLooks.set(rec.id, { palette: ch.palette, hueShift: ch.hueShift });
    goneCodex.add(rec.id);
    os.removeAgent(rec.id);
  } else if (t.final) t.final();
  else os.removeAgent(rec.id);
}

function tempName(ch: Character, t: NonNullable<Rec['temp']>, id: number): string {
  const employee = employeeOf(id);
  if (employee) return employeeName(employee);
  if (t.kind === 'codex') return `codex·${codexTaskOf(id)?.project ?? ''}`;
  if (t.kind === 'teammate') return ch.agentName ?? tr('staff.teammate');
  return t.label || tr('staff.subagent');
}

/** Gone without a word or a walk: a temp whose time was over before this page saw it. */
function vanish(os: OfficeState, rec: Rec, ch: Character): void {
  const t = rec.temp;
  recs.delete(rec.id);
  if (t?.kind === 'codex') {
    codexLooks.set(rec.id, { palette: ch.palette, hueShift: ch.hueShift });
    goneCodex.add(rec.id);
  }
  if (t?.final) t.final(); // the upstream removal (maps, rows); its despawn is skipped below
  releaseSeat(os, ch);
  os.characters.delete(rec.id);
}

/** A seated character sits at its desk now (no walk). */
function seatNow(os: OfficeState, ch: Character): void {
  const seat = ch.seatId ? os.seats.get(ch.seatId) : undefined;
  if (!seat) return;
  placeAt(ch, { col: seat.seatCol, row: seat.seatRow });
  ch.state = CharacterState.TYPE;
  ch.dir = seat.facingDir;
}

/**
 * A temp at load (`settling`): the steady state at once. Working: at its
 * desk. Finished: only inside its linger time by the data (a Codex task's
 * end), resting in the lounge; else not shown at all. Live: through the door.
 */
function stepTemp(
  os: OfficeState,
  rec: Rec,
  ch: Character,
  kind: TempKind,
  now: number,
  settling: boolean,
): void {
  const t = (rec.temp ??= newTemp(kind, now));
  const fresh = !t.placed;
  t.placed = true;
  const task = kind === 'codex' ? codexTaskOf(ch.id) : undefined;
  if (fresh && task) {
    t.model = task.model ?? null;
    // It arrives when it was asked for, even if its worker has not started Codex yet.
    const started = Date.parse(task.created ?? task.started ?? '');
    if (Number.isFinite(started)) t.arrivedAt = started;
    const ended = Date.parse(task.ended ?? '');
    if (Number.isFinite(ended)) t.lastWorkAt = ended;
  }
  const working = task ? !isFinishedCodex(task.state) : !t.released;
  if (kind === 'codex') ch.isActive = working; // nothing else drives a Codex worker
  const leadId = leadOf(os, ch, kind);
  if (settling || fresh) ch.cldAway = false;
  if (fresh && !working) {
    const ended = task ? Date.parse(task.ended ?? '') : NaN;
    if (!Number.isFinite(ended) || now - ended >= lingerMs()) return vanish(os, rec, ch);
    arrive(os, ch, leadId, 'here');
    t.phase = 'lingering';
    linger(os, ch, t);
    if (ch.seatId) seatNow(os, ch);
    else if (t.wander?.length) placeAt(ch, t.wander[Math.floor(Math.random() * t.wander.length)]);
    return;
  }
  if (fresh) return arrive(os, ch, leadId, settling ? 'here' : 'door');
  if (settling) {
    // A resync: what this page already knew, at once.
    if (working) {
      if (t.phase !== 'working') [t.phase, t.wander] = ['working', null];
      arrive(os, ch, leadId, 'here');
      return;
    }
    const lead = leadId !== null ? os.characters.get(leadId) : undefined;
    const leadEnded = !lead || lead.cldAway === true || !isWorking(lead);
    const due =
      shouldGoHome({ working, lastWorkAt: t.lastWorkAt }, leadEnded, now, lingerMs()) ||
      employeeBusyElsewhere(ch.id);
    if (t.phase === 'leaving' || due) return vanish(os, rec, ch);
    return;
  }
  if (working) {
    t.lastWorkAt = now;
    if (t.phase !== 'working') {
      t.phase = 'working';
      t.wander = null;
      arrive(os, ch, leadId, 'walk'); // back to a desk
    }
    // A walk cut short (a turn's pause clears the path): on to its desk.
    const desk = seatTile(os, ch.seatId);
    const away = desk && (desk.col !== ch.tileCol || desk.row !== ch.tileRow);
    if (away && !ch.path.length && !ch.matrixEffect && ch.state !== CharacterState.WALK) {
      const path = pathTo(os, { col: ch.tileCol, row: ch.tileRow }, desk);
      if (path.length) walk(ch, path);
    }
    return;
  }
  const lead = leadId !== null ? os.characters.get(leadId) : undefined;
  const leadEnded = !lead || lead.cldAway === true || !isWorking(lead);
  if (t.phase === 'working') {
    t.phase = 'lingering';
    linger(os, ch, t);
  }
  // Its employee went back to work as a newer execution: it leaves (one person, one character).
  if (
    t.phase === 'lingering' &&
    (shouldGoHome({ working, lastWorkAt: t.lastWorkAt }, leadEnded, now, lingerMs()) ||
      employeeBusyElsewhere(ch.id))
  ) {
    t.phase = 'leaving';
    t.leavingSince = clock;
    t.wander = [];
    releaseSeat(os, ch);
    if (!walkOut(os, rec, ch)) return finishTemp(os, rec, ch);
  }
  if (t.phase === 'leaving' && (atDoor(os, rec, ch) || clock - t.leavingSince > LEAVE_TIMEOUT_SEC))
    finishTemp(os, rec, ch);
}

/** Permanent staff: at the desk, on overtime, or off duty and resting in the lounge (LOUNGE:
 *  nobody leaves the building any more). At load (`settling`) the steady state at once: at the
 *  desk, or already resting. */
function stepStaff(
  os: OfficeState,
  rec: Rec,
  ch: Character,
  off: boolean,
  open: boolean,
  now: number,
  settling: boolean,
): 'desk' | 'overtime' | 'away' {
  const working = !off && isWorking(ch);
  if (working || open || settling) rec.idleSince = undefined;
  else rec.idleSince ??= now;
  // Live, idle a moment first: a turn's end is no reason to go off duty yet. The
  // grace only counts for what this page saw happen, never for the load.
  // One already off duty stays so: the grace never calls anyone back in.
  // An orchestrator that is off has nothing to wait for: no grace.
  const grace =
    !off && !rec.away && rec.idleSince !== undefined && now - rec.idleSince < HOME_GRACE_MS;
  // Still present after hours (working, or idle in its grace) is 야근 until it
  // goes off duty (then 퇴근); off is never at work.
  const due = dutyFor(open, working);
  const duty = due === 'home' && grace ? 'overtime' : due;
  if (settling) {
    ch.matrixEffect = null;
    ch.cldAway = false;
    if (duty === 'home') {
      if (!rec.away) rec.wasActive = ch.isActive;
      rec.away = true;
      ch.bubbleType = null;
      endRest(os, ch);
      beginRest(os, ch, { instant: true });
      return 'away';
    }
    if (rec.away) ch.isActive = rec.wasActive || ch.isActive;
    rec.away = false;
    endRest(os, ch);
    seatNow(os, ch);
    return duty;
  }
  if (rec.away) {
    if (duty === 'home') {
      if (!ch.cldRest) beginRest(os, ch); // its rest was cleared (a re-sent office): rest again
      return 'away';
    }
    // Back on duty: from where it rests, to its desk (by elevator if need be).
    rec.away = false;
    ch.isActive = rec.wasActive || ch.isActive;
    endRest(os, ch);
    os.sendToSeat(ch.id);
    return duty;
  }
  if (duty !== 'home') return duty;
  rec.wasActive = ch.isActive;
  ch.bubbleType = null;
  rec.away = true;
  beginRest(os, ch); // isActive false: or the FSM walks it back to its desk
  return 'away';
}

/** The game loop, every frame (cld/useGameControls.ts). */
export function staffStep(os: OfficeState, dt: number, now = Date.now()): void {
  if (office !== os) {
    office = os;
    recs.clear();
  }
  clock += dt;
  sinceStep += dt;
  // Every frame while loading: a character made since the last look is not drawn once.
  if (loading && (cldGetSnapshot().officeSnapshot || holdWithoutOffice)) hold(os);
  if (sinceStep < STAFF_STEP_SEC) return;
  sinceStep = 0;
  const { officeSnapshot: officeState, codexTasks } = cldGetSnapshot();
  let settling = false;
  if (loading) {
    const waited = clock - loading.since;
    if (officeState && officeState !== loading.office && loading.settleAt === null)
      loading.settleAt = clock + STAFF_SETTLE_SEC;
    if (!officeState && waited > STAFF_HOLD_MAX_SEC) {
      // No cld office after all (no office snapshot): let everyone be seen.
      for (const ch of os.characters.values()) if (recs.get(ch.id)?.held) ch.cldAway = false;
      recs.clear();
      loading = null;
      return;
    }
    const at = loading.settleAt;
    const visualsIn =
      !!officeState &&
      [...os.characters.values()].every(
        (ch) =>
          characterKind(ch, officeState, codexTasks) !== 'orchestrator' ||
          characterVisualOf(ch.id) !== undefined,
      );
    const due =
      (at !== null && clock >= at && (visualsIn || clock >= at + STAFF_VISUALS_WAIT_SEC)) ||
      (!!officeState && waited > STAFF_HOLD_MAX_SEC);
    if (!due) {
      if (officeState || holdWithoutOffice) hold(os);
      return;
    }
    settling = true;
    loading = null;
  }
  if (!officeState) return;
  if (os.tileMap !== lastMap) {
    // A new office (rooms resized, a floor added): lingerers find the lounge again.
    lastMap = os.tileMap;
    for (const rec of recs.values()) {
      const ch = os.characters.get(rec.id);
      if (ch && rec.temp?.phase === 'lingering') linger(os, ch, rec.temp);
    }
  }
  const open = isOfficeOpen(officeHours(), now, hostOffset());
  const temps: TempRow[] = [];
  const away: StaffSnapshot['away'] = {};
  const overtime: number[] = [];
  for (const ch of [...os.characters.values()]) {
    if (ch.matrixEffect === 'despawn' && !ch.cldAway) continue; // on its way out
    const kind = characterKind(ch, officeState, codexTasks);
    const rec = recs.get(ch.id) ?? newRec(ch.id);
    rec.held = false;
    rec.decided = true;
    if (kind === 'subagent' || kind === 'teammate' || kind === 'codex') {
      stepTemp(os, rec, ch, kind, now, settling);
      const t = rec.temp;
      if (!t || !recs.has(ch.id)) continue; // just went home
      if (!open && t.phase === 'working') overtime.push(ch.id);
      const visual = characterVisualOf(ch.id);
      const task = kind === 'codex' ? codexTaskOf(ch.id) : undefined;
      const name = tempName(ch, t, ch.id);
      const spawn = os.subagentMeta.get(ch.id);
      temps.push({
        id: ch.id,
        kind,
        leadId: leadOf(os, ch, kind),
        name,
        task: task
          ? codexTaskLine(task)
          : taskLine(name, {
              description: t.label,
              ez: visual && t.phase === 'working' ? `${visual.icon} ${visual.text}` : null,
              status: ch.currentTool,
            }),
        model: modelBadge(t.model),
        modelId: t.model,
        phase: t.phase,
        since: t.arrivedAt,
        work: workRefOf(kind, ch, {
          lead: spawn && { agentId: spawn.parentAgentId, toolId: spawn.parentToolId },
        }),
      });
      continue;
    }
    if (kind !== 'orchestrator') {
      if (settling) ch.cldAway = false;
      continue;
    }
    const row = officeState.orchestrators.find(
      (o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === ch.id,
    );
    const off = row ? isOff(row) : false;
    const at = stepStaff(os, rec, ch, off, open, now, settling);
    if (at === 'overtime') overtime.push(ch.id);
    if (rec.away) {
      const desk = seatTile(os, ch.seatId);
      away[ch.id] = desk
        ? { x: desk.col * TILE_SIZE + TILE_SIZE / 2, y: desk.row * TILE_SIZE + TILE_SIZE / 2 }
        : { x: ch.x, y: ch.y };
    }
  }
  for (const id of recs.keys()) if (!os.characters.has(id)) recs.delete(id);
  if (isE2E)
    (window as unknown as { __cldStaff?: unknown }).__cldStaff = [...recs.values()].map((r) => {
      const c = os.characters.get(r.id);
      return {
        id: r.id,
        phase: r.temp?.phase,
        seat: c?.seatId,
        at: [c?.tileCol, c?.tileRow],
        path: c?.path.length,
        active: c?.isActive,
        state: c?.state,
        rest: c?.cldRest?.phase,
      };
    });
  const next = { open, temps, away, overtime };
  const key = JSON.stringify(next);
  if (key === snapKey) return;
  snapKey = key;
  snap = next;
  listeners.forEach((l) => l());
}

/** Test helper: a fresh page (`holdWithoutOffice`: as in the browser). */
export function staffResetForTests(opts: { holdWithoutOffice?: boolean } = {}): void {
  recs.clear();
  goneCodex.clear();
  codexLooks.clear();
  office = null;
  clock = 0;
  loading = { since: 0, office: null, settleAt: null };
  holdWithoutOffice = opts.holdWithoutOffice ?? isBrowserRuntime;
  sinceStep = STAFF_STEP_SEC;
  snap = { open: true, temps: [], away: {}, overtime: [] };
  snapKey = '';
}

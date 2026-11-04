/** The office's floors, layout and seats: the generated plan, the decor on top of it, building messages. */
import { createHash } from 'crypto';

import { type Coded, koText, refused } from '../../../../core/src/cld/serverText.js';
import type { BuildingState, CodexTask } from '../../../../core/src/messages.js';
import type { AgentStateStore } from '../../agentStateStore.js';
import { readConfig } from '../../configPersistence.js';
import { readLayoutFromFile } from '../../layoutPersistence.js';
import type { BuildingData, BuildingStore, Change } from '../building.js';
import {
  addFloor,
  floorName,
  floorOfCharacter,
  floorOfRoom,
  isLayout,
  moveCharacter,
  moveRoom,
  removeFloor,
  renameFloor,
  setPerProject,
} from '../building.js';
import type { BaseFloor, DecorStore, FloorLayout, Footprints } from '../decor.js';
import { composeOffice, decorFromSave, resetDecorRoom } from '../decor.js';
import type { ClientMessageContext, WsSend } from '../hooks.js';
import type { RoomRect, RoomSpec } from '../layout.js';
import {
  codexLabel,
  contractorSeatUid,
  floorPrefix,
  generateLayout,
  LOUNGE_ROOM,
  PANTRY_ROOM,
  stackFloors,
} from '../layout.js';
import type { AgentEntry, World } from '../providers/types.js';
import { RoomSizer } from '../roomSizer.js';

/** Every floor's generated office (T-0027). */
export interface FloorPlan {
  stamp: string;
  floors: Array<{ id: string; own: boolean; rooms: RoomRect[] }>;
  /** Floor 1 first. */
  layouts: Array<Record<string, unknown>>;
  /** Character key -> seat (chair uid). */
  seats: Record<string, string>;
  /** Character key -> the room (area label) it sits in on its floor. */
  areaOf: Map<string, string>;
}

interface FloorsDeps {
  opts: {
    store: AgentStateStore;
    home?: string;
    defaultLayout?: Record<string, unknown> | null;
    catalog?: () => Footprints;
  };
  building: BuildingStore;
  decor: DecorStore;
  world(): World;
  /** An engine daemon with Codex: its projects draw a contractor desk. */
  hasCodex(): boolean;
  keyOf(agentId: number): string | undefined;
  codexKeyOf(agentId: number): string | undefined;
  codexTasks(): Array<Omit<CodexTask, 'agentId'>> | null;
  codexRoom(project: string): string | undefined;
}

export class OfficeFloors {
  private gen: { key: string; value: FloorPlan } | null = null;
  private readonly bases = new Map<string, FloorPlan>();
  /** Spare desks for temps per room (T-0041). */
  private readonly sizer = new RoomSizer();
  /** The office last broadcast after a building change (JSON). */
  private sentLayout = '';
  /** The floors last given to a client: they list the live world's rooms and characters. */
  sentFloors = '';

  constructor(private readonly deps: FloorsDeps) {}

  /** The building messages and resetRoomDecor; the first handler to claim a message wins. */
  onClientMessage(msg: Record<string, unknown>, ctx: ClientMessageContext): boolean {
    const { send, privileged } = ctx;
    if (this.onBuildingMessage(msg, send, privileged)) return true;
    if (msg.type === 'resetRoomDecor') {
      if (privileged && typeof msg.room === 'string') {
        const error = this.deps.decor.save(resetDecorRoom(this.deps.decor.data, msg.room));
        if (error) console.warn(`[cld] decor: ${error}`);
        else this.publishBuilding(true);
      }
      return true;
    }
    return false;
  }

  private everyone(): AgentEntry[] {
    return this.deps.world().agents;
  }

  roomSpecs(): RoomSpec[] {
    const all = this.everyone();
    const engineCodex = this.deps.hasCodex();
    return this.deps.world().rooms.map((r) => {
      const members = all.filter((a) => a.tab === r.name).sort((a, b) => a.order - b.order);
      return {
        label: r.name,
        members: members.map((a) => a.key),
        contractorDesk:
          r.kind === 'orch' && members.some((a) => engineCodex && a.key.startsWith('engine:')),
        spare: this.sizer.spareFor(r.name),
      };
    });
  }

  /** The rooms the office draws (with a character or a contractor desk), in order. */
  roomLabels(): string[] {
    return this.roomSpecs()
      .filter((r) => r.members.length || r.contractorDesk)
      .map((r) => r.label);
  }

  /**
   * Every floor's generated office (T-0027): a room on its floor with its
   * contractor desk; its characters placed on another floor sit in an annex
   * there ("2층 <room>"), and each floor has a lounge ("2층 휴게실" above the
   * first; floor 1 also has the 로비, T-0046), so no area label is on two floors. Seats stay `seat:<key>`
   * whichever floor a character is on.
   */
  plan(): FloorPlan {
    const b = this.deps.building.data;
    const specs = this.roomSpecs();
    const names = new Map(this.everyone().map((a) => [a.key, a.name]));
    const key = JSON.stringify([
      specs,
      b.floors.map((f) => [f.id, f.rooms, f.characters, f.layout]),
      [...names],
    ]);
    if (this.gen?.key === key) return this.gen.value;
    const seats: Record<string, string> = {};
    const areaOf = new Map<string, string>();
    const overflow: Array<[string, number]> = [];
    const floorPlans: FloorPlan['floors'] = [];
    const inputs = b.floors.map((floor, k) => {
      const rooms: RoomSpec[] = specs.map((spec) => {
        const home = floorOfRoom(b, spec.label).id === floor.id;
        const label = home ? spec.label : `${floorName(k + 1)} ${spec.label}`;
        const members = spec.members.filter(
          (m) => floorOfCharacter(b, names.get(m) ?? m, spec.label).id === floor.id,
        );
        for (const m of members) areaOf.set(m, label);
        return {
          label,
          members,
          contractorDesk: home && spec.contractorDesk,
          spare: home && members.length ? spec.spare : 0,
        };
      });
      const floor1 = k === 0;
      return [
        rooms,
        floor1 ? LOUNGE_ROOM : koText('room_lounge_floor', { floor: floorName(k + 1) }),
        floor1,
        floor1 ? PANTRY_ROOM : koText('room_pantry_floor', { floor: floorName(k + 1) }),
      ] as const;
    });
    // floors-fill-1104: every floor is the largest one's size (a floor's own layout counts too),
    // its rooms grown to fill it; a room more or less anywhere resizes them all alike.
    const sizes = b.floors.map((floor, k) =>
      k > 0 && isLayout(floor.layout)
        ? (floor.layout as { cols: number; rows: number })
        : generateLayout(...inputs[k]).layout,
    );
    const size = {
      cols: Math.max(...sizes.map((l) => l.cols)),
      rows: Math.max(...sizes.map((l) => l.rows)),
    };
    const layouts = b.floors.map((floor, k) => {
      const gen = generateLayout(...inputs[k], size);
      const own = k > 0 && isLayout(floor.layout);
      floorPlans.push({ id: floor.id, own, rooms: own ? [] : gen.rooms });
      Object.assign(seats, gen.seats);
      for (const label of gen.overflow) overflow.push([label, k]);
      return own ? floor.layout! : (gen.layout as unknown as Record<string, unknown>);
    });
    const stamp = createHash('sha1').update(key).digest('hex').slice(0, 12);
    this.gen = { key, value: { stamp, floors: floorPlans, layouts, seats, areaOf } };
    this.bases.delete(stamp);
    this.bases.set(stamp, this.gen.value);
    if (this.bases.size > 16) this.bases.delete(this.bases.keys().next().value!);
    if (overflow.length) queueMicrotask(() => this.spill(overflow));
    return this.gen.value;
  }

  /**
   * Rooms a floor had no room for (64 rows) go to the next floor, a new one
   * when it was the last: never shrunk (T-0041). Only a room on its home
   * floor moves; an annex follows its room.
   */
  private spill(overflow: Array<[string, number]>): void {
    const { changed } = this.deps.building.apply((b) => {
      let next: BuildingData = b;
      for (const [label, k] of overflow) {
        if (floorOfRoom(next, label).id !== next.floors[k]?.id) continue;
        if (!next.floors[k + 1]) {
          const grown = addFloor(next);
          if ('error' in grown) return next; // at the most floors: as it is
          next = grown;
        }
        const moved = moveRoom(next, label, next.floors[k + 1].id);
        if (!('error' in moved)) next = moved;
      }
      return next;
    });
    if (changed) {
      console.log(`[cld] building: ${overflow.length} room(s) spilled to the next floor`);
      this.publishBuilding();
    }
  }

  /** Temps per room now: sub-agent spawns and teammates under their lead,
   *  running Codex tasks in their project's room (T-0041). */
  private tempCounts(): Map<string, number> {
    const roomOf = new Map(this.everyone().map((a) => [a.key, a.tab]));
    const counts = new Map<string, number>();
    const add = (id: number, n: number) => {
      const room = roomOf.get(this.deps.keyOf(id) ?? '');
      if (room && n) counts.set(room, (counts.get(room) ?? 0) + n);
    };
    for (const a of this.deps.opts.store.values()) {
      if (a.leadAgentId !== undefined) {
        add(a.leadAgentId, 1);
        continue;
      }
      const spawns = new Set([
        ...a.activeSubagentToolNames.keys(),
        ...a.backgroundAgentToolIds,
        ...[...a.activeToolNames]
          .filter(([, n]) => n === 'Task' || n === 'Agent')
          .map(([id]) => id),
      ]);
      add(a.id, spawns.size);
    }
    for (const t of this.deps.codexTasks() ?? []) {
      const room = this.deps.codexRoom(t.project);
      if (room && (t.state === 'running' || t.state === 'limit'))
        counts.set(room, (counts.get(room) ?? 0) + 1);
    }
    return counts;
  }

  /** Count the temps; when a room's need crossed a step (at most every few
   *  minutes), the office is drawn again with its spare desks. */
  sampleRooms(now = Date.now()): void {
    this.sizer.note(this.tempCounts(), now);
    if (this.sizer.resize(now)) this.publishBuilding();
  }

  private baseFloors(p: FloorPlan): BaseFloor[] {
    return p.floors.map((f, k) => ({ ...f, layout: p.layouts[k] as FloorLayout }));
  }

  /** The user's decor first, the generated plan around it (T-0066), per floor. */
  layoutFor(): Record<string, unknown> {
    const p = this.plan();
    const { layouts, seats } = composeOffice(
      this.baseFloors(p),
      this.deps.decor.data,
      this.deps.opts.catalog?.() ?? [],
    );
    const office =
      layouts.length === 1
        ? layouts[0]
        : stackFloors(
            p.floors.map((f, k) => ({
              id: f.id,
              prefix: floorPrefix(f.id, k),
              layout: layouts[k],
            })),
          );
    // A chair the user removed: the webview seats its member at the chair named here (null: none).
    // Our tiles are the current format (VOID 255): without a revision the webview reads tile 8,
    // a floor pattern, as the old VOID and a painted floor came back as a hole.
    return {
      ...office,
      layoutRevision: Math.max(1, Number(office.layoutRevision) || 0),
      cldBase: p.stamp,
      ...(Object.keys(seats).length && { cldSeats: seats }),
    };
  }

  saveLayout(layout: Record<string, unknown>, send: WsSend): true {
    const base = typeof layout.cldBase === 'string' ? this.bases.get(layout.cldBase) : this.plan();
    if (!base) {
      console.warn('[cld] decor: an edit of an office no longer known; not kept');
      send({ type: 'layoutLoaded', layout: this.layoutFor() });
      return true;
    }
    const next = decorFromSave(
      layout,
      this.baseFloors(base),
      this.deps.decor.data,
      this.deps.opts.catalog?.() ?? [],
    );
    if (typeof next === 'string') {
      console.warn(`[cld] decor: ${next}; not kept`);
      return true;
    }
    const error = this.deps.decor.save(next);
    if (error) {
      console.warn(`[cld] decor: ${error}`);
      return true;
    }
    send({ type: 'layoutLoaded', layout: this.layoutFor() });
    this.publishBuilding();
    return true;
  }

  migrateLayoutJson(): void {
    if (this.deps.decor.exists()) return;
    const saved = readLayoutFromFile(this.deps.opts.home);
    const def = this.deps.opts.defaultLayout;
    const isDefault =
      !!saved &&
      !!def &&
      JSON.stringify(saved.tiles) === JSON.stringify(def.tiles) &&
      JSON.stringify(saved.furniture) === JSON.stringify(def.furniture);
    if (!saved || !isLayout(saved) || isDefault) return;
    const next = decorFromSave(
      saved,
      this.baseFloors(this.plan()),
      { version: 1, rooms: {} },
      this.deps.opts.catalog?.() ?? [],
    );
    const unrelated = typeof next === 'string';
    const data = unrelated ? { version: 1 as const, rooms: {} } : next;
    const error = this.deps.decor.save(data);
    if (error) console.warn(`[cld] decor: migration: ${error}`);
    else if (unrelated) console.log('[cld] decor: layout.json is not a cld office; no longer used');
    else
      console.log(`[cld] decor: layout.json converted (${Object.keys(data.rooms).length} rooms)`);
  }

  seatFor(agentId: number): string | undefined {
    const key = this.deps.keyOf(agentId);
    if (key) return this.plan().seats[key];
    // A contractor prefers its project's contractor desk.
    const task = this.deps.codexTasks()?.find(
      (t) => `codex:${t.id}` === this.deps.codexKeyOf(agentId),
    );
    const room = task && this.deps.codexRoom(task.project);
    return room ? contractorSeatUid(room) : undefined;
  }

  /** Character label -> its room on its floor (contractors `codex·<project>`
   *  -> the project's room, where the contractor desk is). */
  areaMappings(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    const { areaOf } = this.plan();
    for (const a of this.everyone()) {
      out[a.name] = [areaOf.get(a.key) ?? a.tab];
      if (this.deps.hasCodex() && a.key.startsWith('engine:')) out[codexLabel(a.name)] = [a.tab];
    }
    return out;
  }

  /** The floors, floor 1 first, with the rooms and characters on each (T-0027). */
  floorRows(): BuildingState['floors'] {
    const b = this.deps.building.data;
    const rooms = this.roomLabels();
    const names = new Set(this.everyone().map((a) => a.name));
    return b.floors.map((f) => ({
      id: f.id,
      name: f.name,
      rooms: rooms.filter((r) => floorOfRoom(b, r).id === f.id),
      characters: f.characters.filter((c) => names.has(c)),
    }));
  }

  /** Who sits in which room; the user's own mappings win, as at connect. */
  mappingsMessage(): Record<string, unknown> {
    return {
      type: 'areaMappingsLoaded',
      mappings: { ...this.areaMappings(), ...(readConfig().standalone.areaMappings ?? {}) },
    };
  }

  /** The floor list with the 보관함 counts; the floors it gives out are remembered. */
  buildingState(why?: Coded & { error?: string }): BuildingState {
    const { stored, held } = composeOffice(
      this.baseFloors(this.plan()),
      this.deps.decor.data,
      this.deps.opts.catalog?.() ?? [],
    );
    // 보관함: the user's items that do not fit, and generator items with no room left.
    const decorRows = Object.keys(this.deps.decor.data.rooms).map((room) => ({
      room,
      stored: (stored[room]?.furniture.length ?? 0) + (held[room]?.length ?? 0),
    }));
    const floors = this.floorRows();
    this.sentFloors = JSON.stringify(floors);
    return {
      type: 'buildingState',
      floors,
      perProject: this.deps.building.data.perProject,
      ...(decorRows.length && { decor: decorRows }),
      ...(why?.error && { error: why.error, ...(why.errorCode && { errorCode: why.errorCode, ...(why.errorParams && { errorParams: why.errorParams }) }) }),
    };
  }

  /** A building change reaches every client: the office first when it
   *  changed (it says which rows are which floor; a re-sent office seats every
   *  character anew, so a rename sends none), then the floor list. */
  publishBuilding(forceLayout = false): void {
    const store = this.deps.opts.store;
    const layout = this.layoutFor();
    const json = JSON.stringify(layout);
    if (forceLayout || json !== this.sentLayout) {
      this.sentLayout = json;
      store.broadcast({ type: 'layoutLoaded', layout });
      store.broadcast(this.mappingsMessage());
    }
    store.broadcast({ ...this.buildingState() });
  }

  /** addFloor, renameFloor, removeFloor, moveToFloor, setFloorRule (T-0027).
   *  Cosmetic: any logged-in client, also on a read-only daemon. */
  private onBuildingMessage(
    msg: Record<string, unknown>,
    send: WsSend,
    privileged: boolean,
  ): boolean {
    const id = typeof msg.floorId === 'string' ? msg.floorId : '';
    let change: (b: BuildingData) => Change;
    if (msg.type === 'addFloor') change = (b) => addFloor(b, msg.name);
    else if (msg.type === 'renameFloor') change = (b) => renameFloor(b, id, msg.name);
    else if (msg.type === 'removeFloor') change = (b) => removeFloor(b, id);
    else if (msg.type === 'moveToFloor') change = (b) => this.moveToFloor(b, msg, id);
    else if (msg.type === 'setFloorRule')
      change = (b) =>
        typeof msg.perProject === 'boolean'
          ? setPerProject(b, msg.perProject, this.roomLabels())
          : refused('floor_choose_toggle');
    else return false;
    if (!privileged) return true; // upstream refuses a read-only client before this
    const { changed, ...failure } = this.deps.building.apply((b) => {
      const next = change(b);
      return 'error' in next ? next : this.tidy(next);
    });
    if (failure.error) {
      console.warn(`[cld] ${msg.type}: ${failure.error}`);
      send({ ...this.buildingState(failure) });
    } else if (changed) {
      console.log(`[cld] building: ${msg.type} (${this.deps.building.data.floors.length} floors)`);
      this.publishBuilding();
    }
    return true;
  }

  /** A character placed on its own room's floor just follows its room. */
  private tidy(b: BuildingData): BuildingData {
    const roomOf = new Map(this.everyone().map((a) => [a.name, a.tab]));
    return {
      ...b,
      floors: b.floors.map((f) => ({
        ...f,
        characters: f.characters.filter((c) => {
          const room = roomOf.get(c);
          return room === undefined || floorOfRoom(b, room).id !== f.id;
        }),
      })),
    };
  }

  private moveToFloor(b: BuildingData, msg: Record<string, unknown>, floorId: string): Change {
    const { room, character } = msg;
    if (typeof room === 'string' && character === undefined) {
      if (!this.roomLabels().includes(room)) return refused('office_unknown');
      const members = this.everyone().filter((a) => a.tab === room);
      return moveRoom(
        b,
        room,
        floorId,
        members.map((a) => a.name),
      );
    }
    if (typeof character === 'string' && room === undefined) {
      const entry = this.everyone().find((a) => a.name === character);
      return entry ? moveCharacter(b, entry.name, entry.tab, floorId) : refused('character_unknown');
    }
    return refused('office_or_character');
  }
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import type { BuildingState } from '../../../core/src/messages.js';
import type { BuildingData, Change } from './building.js';
import {
  addFloor,
  BuildingStore,
  defaultBuilding,
  floorOfCharacter,
  floorOfRoom,
  loadBuilding,
  MAX_FLOORS,
  moveCharacter,
  moveRoom,
  parseBuilding,
  placeNewRooms,
  removeFloor,
  renameFloor,
  saveBuilding,
  setPerProject,
} from './building.js';
import { registryPath } from './engine/registry.js';
import type { FloorRect } from './layout.js';
import { FLOOR_GAP, generateLayout, stackFloors } from './layout.js';
import type { Office } from './office.js';
import { ROSTER, startEngineOffice } from './officeTestKit.js';

/** The change's data; fails the test on a refusal. */
const ok = (change: Change): BuildingData => {
  if ('error' in change) throw new Error(`refused: ${change.error}`);
  return change;
};
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cld-building-'));

describe('building model (T-0027)', () => {
  it('without building.json: one floor, every room and character on it', () => {
    const b = loadBuilding(path.join(tmpDir(), 'building.json'));
    expect(b).toEqual(defaultBuilding());
    expect(b.floors.map((f) => f.name)).toEqual(['1층']);
    expect(floorOfRoom(b, 'orch-alpha').id).toBe('1');
    expect(floorOfCharacter(b, 'alpha', 'orch-alpha').id).toBe('1');
  });

  it('addFloor names "<n>층" and stops at 9; renameFloor takes 1-24 characters', () => {
    let b = ok(addFloor(defaultBuilding()));
    expect(b.floors.map((f) => [f.id, f.name])).toEqual([
      ['1', '1층'],
      ['2', '2층'],
    ]);
    b = ok(addFloor(b, '  연구동 '.trim()));
    expect(b.floors[2].name).toBe('연구동');
    while (b.floors.length < MAX_FLOORS) b = ok(addFloor(b));
    expect(addFloor(b)).toMatchObject({ error: '층은 9개까지예요' });
    expect(ok(renameFloor(b, '2', ' 창고 ')).floors[1].name).toBe('창고');
    for (const bad of ['', '   ', 'x'.repeat(25), 'a\nb', 42]) {
      expect(renameFloor(b, '2', bad)).toHaveProperty('errorCode');
    }
    expect(renameFloor(b, 'nope', 'x')).toMatchObject({ error: '없는 층이에요' });
  });

  it('moveRoom puts a room on one floor; its characters placed there alone follow it again', () => {
    let b = ok(addFloor(ok(addFloor(defaultBuilding()))));
    b = ok(moveCharacter(b, 'alpha', 'orch-alpha', '3'));
    expect(floorOfCharacter(b, 'alpha', 'orch-alpha').id).toBe('3');
    b = ok(moveRoom(b, 'orch-alpha', '2', ['alpha', 'beta']));
    expect(floorOfRoom(b, 'orch-alpha').id).toBe('2');
    expect(floorOfCharacter(b, 'beta', 'orch-alpha').id).toBe('2');
    expect(floorOfCharacter(b, 'alpha', 'orch-alpha').id).toBe('3'); // placed alone, stays
    b = ok(moveRoom(b, 'orch-alpha', '3', ['alpha', 'beta']));
    expect(b.floors.map((f) => f.rooms)).toEqual([[], [], ['orch-alpha']]);
    expect(b.floors[2].characters).toEqual([]); // with its room again
    expect(moveRoom(b, 'orch-alpha', '9')).toMatchObject({ error: '없는 층이에요' });
  });

  it('moveCharacter places a character apart; on its room floor it follows the room', () => {
    let b = ok(addFloor(defaultBuilding()));
    b = ok(moveCharacter(b, 'gamma', 'orch-alpha', '2'));
    expect(b.floors[1].characters).toEqual(['gamma']);
    b = ok(moveCharacter(b, 'gamma', 'orch-alpha', '1'));
    expect(b.floors.flatMap((f) => f.characters)).toEqual([]);
    expect(floorOfCharacter(b, 'gamma', 'orch-alpha').id).toBe('1');
  });

  it('removeFloor moves its rooms and characters to floor 1 (the fallback)', () => {
    let b = ok(addFloor(ok(addFloor(defaultBuilding()))));
    b = ok(moveRoom(b, 'orch-alpha', '1'));
    b = ok(moveRoom(b, 'orch-beta', '2'));
    b = ok(moveRoom(b, 'orch-gamma', '3'));
    b = ok(moveCharacter(b, 'alpha', 'orch-alpha', '2'));
    // 프로젝트마다 층 on: a room left placed nowhere would get a floor of its own again.
    b = { ...b, perProject: true };
    b = ok(removeFloor(b, '2'));
    expect(b.floors.map((f) => f.id)).toEqual(['1', '3']);
    expect(b.floors[0].rooms).toEqual(['orch-alpha', 'orch-beta']);
    expect(b.floors[0].characters).toEqual(['alpha']);
    expect(floorOfRoom(b, 'orch-beta').id).toBe('1');
    expect(placeNewRooms(b, ['orch-alpha', 'orch-beta', 'orch-gamma'])).toEqual(b);
    expect(removeFloor(b, '1')).toMatchObject({ error: '1층은 지울 수 없어요' });
    expect(removeFloor(b, '2')).toMatchObject({ error: '없는 층이에요' });
  });

  it('프로젝트마다 층: each room placed nowhere gets a floor, the first an empty floor 1', () => {
    const rooms = ['orch-alpha', 'orch-beta', '관리실'];
    const b = setPerProject(defaultBuilding(), true, rooms);
    expect(b.floors.map((f) => [f.name, f.rooms])).toEqual([
      ['1층', ['orch-alpha']],
      ['orch-beta', ['orch-beta']],
      ['관리실', ['관리실']],
    ]);
    // A new room later; off places nothing.
    expect(placeNewRooms(b, [...rooms, 'new']).floors.at(-1)!.rooms).toEqual(['new']);
    const off = setPerProject(b, false, [...rooms, 'new']);
    expect(off.floors).toHaveLength(3);
    expect(floorOfRoom(off, 'new').id).toBe('1');
    // Past nine floors the rest stay on floor 1.
    const many = Array.from({ length: 12 }, (_, i) => `room-${i}`);
    const full = setPerProject(defaultBuilding(), true, many);
    expect(full.floors).toHaveLength(MAX_FLOORS);
    expect(floorOfRoom(full, 'room-11').id).toBe('1');
  });

  it('round-trips through building.json; a file that is no building is moved aside', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'cld-gui', 'building.json');
    let b = ok(addFloor(defaultBuilding(), '연구동'));
    b = ok(moveRoom(b, 'orch-beta', '2'));
    b = ok(moveCharacter(b, 'alpha', 'orch-alpha', '2'));
    b = { ...b, perProject: true };
    saveBuilding(file, b);
    expect(loadBuilding(file)).toEqual(b);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['building.json']); // no tmp left
    // Floor 1 uses the generated office plus decor; later floors may keep their own layout.
    const layout = generateLayout([]).layout;
    const withLayouts = { ...b, floors: b.floors.map((f) => ({ ...f, layout })) };
    const parsed = parseBuilding(JSON.stringify(withLayouts))!;
    expect(parsed.floors.map((f) => 'layout' in f)).toEqual([false, true]);
    for (const bad of ['{', '[]', '{"version":2,"floors":[]}', '{"version":1,"floors":[]}']) {
      expect(parseBuilding(bad)).toBeNull();
    }
    fs.writeFileSync(file, '{ not json');
    expect(loadBuilding(file)).toEqual(defaultBuilding());
    const files = fs.readdirSync(path.dirname(file));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^building\.json\.corrupt-\d+$/);
  });

  it('a change is kept only once written', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'blocker'), ''); // a file where the folder should be
    const store = new BuildingStore(path.join(dir, 'blocker', 'building.json'));
    expect(store.apply((b) => addFloor(b))).toMatchObject({ changed: false });
    expect(store.apply((b) => addFloor(b)).error).toMatch(/^저장하지 못했어요/);
    expect(store.data).toEqual(defaultBuilding());
    const good = new BuildingStore(path.join(dir, 'ok', 'building.json'));
    expect(good.apply((b) => renameFloor(b, '1', '1층'))).toEqual({ changed: false }); // nothing to write
    expect(fs.existsSync(path.join(dir, 'ok'))).toBe(false);
    expect(good.apply((b) => addFloor(b))).toEqual({ changed: true });
    expect(new BuildingStore(good.file).data.floors).toHaveLength(2);
  });
});

describe('stacked floors', () => {
  it('top to bottom, FLOOR_GAP void rows apart; seats keep their uid, the rest get the prefix', () => {
    const one = generateLayout([{ label: 'a', members: ['engine:a'] }]).layout;
    const two = generateLayout(
      [{ label: 'b', members: ['engine:b', 'engine:c'] }],
      '2층 휴게실',
      false,
      '2층 탕비실',
    ).layout;
    const s = stackFloors([
      { id: '1', prefix: '', layout: one as unknown as Record<string, unknown> },
      { id: '2', prefix: '2/', layout: two as unknown as Record<string, unknown> },
    ]) as typeof one & { cldFloors: FloorRect[] };
    expect(s.cldFloors).toEqual([
      { id: '1', row: 0, rows: one.rows, cols: one.cols },
      { id: '2', row: one.rows + FLOOR_GAP, rows: two.rows, cols: two.cols },
    ]);
    expect(s.cols).toBe(Math.max(one.cols, two.cols));
    expect(s.rows).toBe(one.rows + FLOOR_GAP + two.rows);
    expect(s.tiles).toHaveLength(s.cols * s.rows);
    // Floor 1's tiles are where they were; the gap is void; floor 2 is shifted down.
    for (let r = 0; r < one.rows; r++)
      for (let c = 0; c < one.cols; c++)
        expect(s.tiles[r * s.cols + c]).toBe(one.tiles[r * one.cols + c]);
    for (let r = one.rows; r < one.rows + FLOOR_GAP; r++)
      for (let c = 0; c < s.cols; c++) expect(s.tiles[r * s.cols + c]).toBe(255);
    const uids = s.furniture.map((f) => f.uid);
    expect(new Set(uids).size).toBe(uids.length);
    expect(uids).toContain('seat:engine:b');
    expect(uids).toContain('2/lounge:table');
    expect(uids).toContain('lounge:table');
    const seat = s.furniture.find((f) => f.uid === 'seat:engine:b')!;
    expect(seat.row).toBe(
      two.furniture.find((f) => f.uid === 'seat:engine:b')!.row + one.rows + FLOOR_GAP,
    );
    expect(s.areas.map((a) => a.label)).toEqual([
      'a',
      '휴게실',
      '로비',
      '탕비실',
      'b',
      '2층 휴게실',
      '2층 탕비실',
    ]);
  });
});

// ── The office with floors ───────────────────────────────────────

async function testOffice(home?: string, allowActions = false) {
  // readOnly without --allow-actions: floors still change, they are cosmetic
  const {
    office,
    messages,
    home: h,
    stop,
  } = await startEngineOffice({
    projects: home ? undefined : ROSTER,
    home,
    readOnly: !allowActions,
  });
  const sent: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) => sent.push(m);
  const last = (type: string) => [...messages].reverse().find((m) => m.type === type);
  const building = () => last('buildingState') as unknown as BuildingState;
  const ask = (msg: Record<string, unknown>, privileged = true) =>
    office.onClientMessage(msg, send, privileged);
  return { fake: { home: h }, office, messages, sent, ask, last, building, stop };
}

type Stacked = {
  cols: number;
  rows: number;
  tiles: number[];
  furniture: Array<{ uid: string; type: string; row: number; col: number }>;
  areas: Array<{ label: string }>;
  areaTiles: Array<string | null>;
  cldFloors?: FloorRect[];
};

/** Area labels on a floor's rows of a stacked layout. */
const labelsOn = (l: Stacked, rect: FloorRect) =>
  new Set(l.areaTiles.slice(rect.row * l.cols, (rect.row + rect.rows) * l.cols).filter(Boolean));

describe('office floors (T-0027, engine projects)', () => {
  it('a custom layout.json becomes decor once and no longer wins', async () => {
    const first = await testOffice();
    const home = first.fake.home;
    const generated = first.office.layoutFor() as unknown as Stacked & { tileColors: unknown[] };
    first.stop();
    const custom = structuredClone(generated);
    const i = custom.areaTiles.findIndex((v) => v === 'orch-gamma');
    custom.tiles[i] = 2;
    custom.tileColors[i] = { h: 120, s: 60, b: 0, c: 0 };
    const rect = first.office.plan().floors[0].rooms.find((r) => r.label === 'orch-gamma')!;
    custom.furniture.push({
      uid: 'migrated-plant',
      type: 'PLANT',
      col: rect.x + 1,
      row: rect.y + 2,
    });
    fs.mkdirSync(path.join(home, '.pixel-agents'), { recursive: true });
    const layoutFile = path.join(home, '.pixel-agents', 'layout.json');
    fs.writeFileSync(layoutFile, JSON.stringify(custom));
    const before = fs.readFileSync(layoutFile, 'utf-8');
    const { office, stop } = await testOffice(home);
    const decorFile = path.join(home, '.config/agent-tycoon/decor.json');
    const decor = JSON.parse(fs.readFileSync(decorFile, 'utf-8'));
    expect(fs.statSync(decorFile).mode & 0o777).toBe(0o600);
    expect(decor.rooms['orch-gamma'].tiles).toHaveLength(1);
    expect(decor.rooms['orch-gamma'].furniture).toHaveLength(1);
    expect(office.layoutFor().furniture).toContainEqual(
      expect.objectContaining({ uid: 'migrated-plant' }),
    );
    expect(office.layoutFor().cldBase).toMatch(/^[0-9a-f]{12}$/);
    expect(office.layoutFor().layoutRevision).toBeGreaterThanOrEqual(1); // tile 8 is a floor, not the old VOID
    expect(fs.readFileSync(layoutFile, 'utf-8')).toBe(before);
    const mtime = fs.statSync(decorFile).mtimeMs;
    stop();
    fs.writeFileSync(layoutFile, JSON.stringify({ ...custom, tiles: custom.tiles.map(() => 1) }));
    await testOffice(home);
    expect(fs.statSync(decorFile).mtimeMs).toBe(mtime);
    expect(JSON.parse(fs.readFileSync(decorFile, 'utf-8'))).toEqual(decor);
  });

  it('a bundled default layout.json is not converted', async () => {
    const home = tmpDir();
    fs.mkdirSync(path.join(home, '.pixel-agents'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.pixel-agents/layout.json'),
      JSON.stringify({ version: 1, cols: 1, rows: 1, tiles: [1], furniture: [] }),
    );
    await testOffice(home);
    expect(fs.existsSync(path.join(home, '.config/agent-tycoon/decor.json'))).toBe(false);
  });

  it('moveToFloor: a room goes with its characters; everyone gets the office and the floors', async () => {
    const { fake, office, ask, building, messages } = await testOffice();
    const registry = fs.readFileSync(registryPath(fake.home), 'utf-8');
    expect(building()).toBeUndefined(); // nothing broadcast before a change
    ask({ type: 'addFloor' });
    const id = building().floors[1].id;
    const n = messages.length;
    ask({ type: 'moveToFloor', floorId: id, room: 'orch-beta' });
    const after = messages.slice(n).map((m) => m.type);
    expect(after).toEqual(['layoutLoaded', 'areaMappingsLoaded', 'buildingState']);
    const b = building();
    expect(b.floors[1].rooms).toEqual(['orch-beta']);
    expect(b.floors[0].rooms).not.toContain('orch-beta');
    const l = (messages[n] as { layout: Stacked }).layout;
    const [f1, f2] = l.cldFloors!;
    expect(labelsOn(l, f2)).toEqual(new Set(['orch-beta', '2층 휴게실', '2층 탕비실']));
    expect(labelsOn(l, f1).has('orch-beta')).toBe(false);
    // delta's seat is on floor 2's rows, and the map says so.
    const seat = l.furniture.find((f) => f.uid === office.seatFor(agentOf(office, 'delta')))!;
    expect(seat.row).toBeGreaterThanOrEqual(f2.row);
    expect(seat.row).toBeLessThan(f2.row + f2.rows);
    expect(office.areaMappings()['delta']).toEqual(['orch-beta']);
    // A floor change is ours alone: no project's room changes.
    expect(fs.readFileSync(registryPath(fake.home), 'utf-8')).toBe(registry);
    const saved = JSON.parse(
      fs.readFileSync(path.join(fake.home, '.config/agent-tycoon/building.json'), 'utf-8'),
    );
    expect(saved.floors[1].rooms).toEqual(['orch-beta']);
  });

  it('a character placed alone sits in an annex of its room; on its room floor it follows the room', async () => {
    const { office, ask, building, last } = await testOffice();
    ask({ type: 'addFloor' });
    ask({ type: 'moveToFloor', floorId: '2', character: 'alpha' });
    expect(building().floors[1].characters).toEqual(['alpha']);
    expect(office.areaMappings()['alpha']).toEqual(['2층 orch-alpha']);
    expect(office.areaMappings()['beta']).toEqual(['orch-alpha']);
    const l = (last('layoutLoaded') as { layout: Stacked }).layout;
    expect(labelsOn(l, l.cldFloors![1])).toEqual(
      new Set(['2층 orch-alpha', '2층 휴게실', '2층 탕비실']),
    );
    // The contractor desk stays in the room's own floor.
    expect(l.furniture.find((f) => f.uid === 'seat:codex@orch-alpha')!.row).toBeLessThan(
      l.cldFloors![1].row,
    );
    ask({ type: 'moveToFloor', floorId: '1', character: 'alpha' });
    expect(building().floors[1].characters).toEqual([]);
    expect(office.areaMappings()['alpha']).toEqual(['orch-alpha']);
  });

  it('removeFloor brings its rooms back to floor 1; refusals answer the sender only', async () => {
    const { office, ask, building, sent, messages } = await testOffice();
    ask({ type: 'addFloor', name: '연구동' });
    ask({ type: 'moveToFloor', floorId: '2', room: 'orch-gamma' });
    ask({ type: 'moveToFloor', floorId: '2', character: 'alpha' });
    const m = messages.length;
    ask({ type: 'renameFloor', floorId: '2', name: '창고' });
    // A name changes no desk: no office is re-sent (it would seat everyone anew).
    expect(messages.slice(m).map((x) => x.type)).toEqual(['buildingState']);
    expect(building().floors[1]).toMatchObject({
      name: '창고',
      rooms: ['orch-gamma'],
      characters: ['alpha'],
    });
    ask({ type: 'removeFloor', floorId: '2' });
    expect(building().floors).toHaveLength(1);
    expect(building().floors[0].rooms).toContain('orch-gamma');
    // alpha came down to floor 1, where its room is: it just follows the room.
    expect(office.building.data.floors[0].characters).toEqual([]);
    expect(office.areaMappings()['alpha']).toEqual(['orch-alpha']);
    expect(office.areaMappings()['eta']).toEqual(['orch-gamma']);
    const n = messages.length;
    ask({ type: 'removeFloor', floorId: '1' });
    ask({ type: 'moveToFloor', floorId: '1', room: 'no-such-room' });
    ask({ type: 'moveToFloor', floorId: '1', room: 'orch-beta', character: 'alpha' });
    ask({ type: 'renameFloor', floorId: '1', name: '' });
    expect(messages.length).toBe(n); // nothing broadcast
    expect(sent.map((m) => m.error)).toEqual([
      '1층은 지울 수 없어요',
      '없는 사무실이에요',
      '사무실이나 캐릭터 하나를 골라 주세요',
      '층 이름은 1~24자로 써 주세요',
    ]);
  });

  it('a read-only connection changes nothing (upstream refuses it first; this holds too)', async () => {
    const { fake, ask, building } = await testOffice();
    ask({ type: 'addFloor' }, false);
    expect(building()).toBeUndefined();
    expect(fs.existsSync(path.join(fake.home, '.config/agent-tycoon/building.json'))).toBe(false);
  });

  it('saves decor, follows regeneration, and undoes against the old stamped base', async () => {
    const { fake, office, ask, building, sent, messages } = await testOffice();
    const original = structuredClone(office.layoutFor()) as Stacked & {
      cldBase: string;
      tileColors: unknown[];
    };
    const room = office.plan().floors[0].rooms.find((r) => r.label === 'orch-gamma')!;
    const edited = structuredClone(original);
    for (const x of [1, 2, 3]) {
      const i = (room.y + 1) * edited.cols + room.x + x;
      edited.tiles[i] = 2;
      edited.tileColors[i] = { h: 120, s: 60, b: 0, c: 0 };
    }
    edited.furniture.push({ uid: 't-plant', type: 'PLANT', col: room.x + 1, row: room.y + 2 });
    office.saveLayout(edited as unknown as Record<string, unknown>, (m) => sent.push(m));
    const decorFile = path.join(fake.home, '.config/agent-tycoon/decor.json');
    const decor = JSON.parse(fs.readFileSync(decorFile, 'utf-8'));
    expect(sent.at(-1)?.type).toBe('layoutLoaded');
    expect(decor.rooms['orch-gamma'].tiles).toHaveLength(3);
    expect(decor.rooms['orch-gamma'].furniture).toHaveLength(1);
    expect(fs.existsSync(path.join(fake.home, '.pixel-agents/layout.json'))).toBe(false);
    ask({ type: 'addFloor' });
    ask({ type: 'moveToFloor', floorId: building().floors[1].id, room: 'orch-alpha' });
    const next = office.layoutFor() as Stacked & { cldBase: string; tileColors: unknown[] };
    const moved = office.plan().floors[0].rooms.find((r) => r.label === 'orch-gamma')!;
    expect(next.cldBase).not.toBe(original.cldBase);
    expect({ x: moved.x, y: moved.y }).not.toEqual({ x: room.x, y: room.y });
    expect(next.tiles[(moved.y + 1) * next.cols + moved.x + 1]).toBe(2);
    expect(next.furniture).toContainEqual(
      expect.objectContaining({ uid: 't-plant', col: moved.x + 1, row: moved.y + 2 }),
    );
    office.saveLayout(original as unknown as Record<string, unknown>, (m) => sent.push(m));
    expect(office.decor.data.rooms['orch-gamma']).toBeUndefined();
    expect(office.layoutFor().furniture).not.toContainEqual(
      expect.objectContaining({ uid: 't-plant' }),
    );
    expect(messages.some((m) => m.type === 'buildingState')).toBe(true);
  });

  it('a removed chair reaches the webview as a seat hint (T-0066)', async () => {
    const { office } = await testOffice();
    const edited = structuredClone(office.layoutFor()) as Stacked & { cldSeats?: unknown };
    expect(edited.cldSeats).toBeUndefined();
    edited.furniture = edited.furniture.filter((f) => f.uid !== 'seat:engine:eta');
    office.saveLayout(edited as unknown as Record<string, unknown>, () => {});
    // No catalog in this office, so no other chair is known: the member gets none.
    expect((office.layoutFor() as { cldSeats?: unknown }).cldSeats).toEqual({
      'seat:engine:eta': null,
    });
  });

  it('refuses unknown stamps, gates reset, and counts stored furniture', async () => {
    const { fake, office, ask, messages } = await testOffice();
    const room = office.plan().floors[0].rooms.find((r) => r.label === 'orch-gamma')!;
    const desk = (office.plan().layouts[0] as unknown as Stacked).furniture.find(
      (f) => f.uid === 'desk:engine:eta',
    )!;
    const data = {
      version: 1 as const,
      rooms: {
        'orch-gamma': {
          tiles: [],
          removed: [],
          furniture: [
            // On the wall: never fits, so it waits in the 보관함.
            { uid: 'blocked', type: 'PLANT', x: 0, y: desk.row - room.y },
          ],
        },
      },
    };
    expect(office.decor.save(data)).toBeNull();
    expect(office.buildingState().decor).toContainEqual({ room: 'orch-gamma', stored: 1 });
    const file = path.join(fake.home, '.config/agent-tycoon/decor.json');
    const before = fs.readFileSync(file, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    office.saveLayout({ ...office.layoutFor(), cldBase: 'ffffffffffff' }, () => {});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no longer known'));
    warn.mockRestore();
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    ask({ type: 'resetRoomDecor', room: 'orch-gamma' }, false);
    expect(office.decor.data.rooms['orch-gamma']).toBeDefined();
    const n = messages.length;
    ask({ type: 'resetRoomDecor', room: 'orch-gamma' });
    expect(office.decor.data.rooms['orch-gamma']).toBeUndefined();
    expect(office.buildingState().decor).toBeUndefined();
    expect(messages.slice(n).map((m) => m.type)).toContain('layoutLoaded');
    expect(messages.slice(n).map((m) => m.type)).toContain('buildingState');
  });

  it('the building survives a restart', async () => {
    const first = await testOffice();
    first.ask({ type: 'addFloor', name: '연구동' });
    first.ask({ type: 'moveToFloor', floorId: '2', room: 'orch-beta' });
    const home = first.fake.home;
    first.stop();
    const again = await testOffice(home);
    expect(again.office.buildingState().floors.map((f) => [f.name, f.rooms])).toEqual([
      ['1층', ['orch-alpha', 'orch-gamma', '관리실']],
      ['연구동', ['orch-beta']],
    ]);
  });
});

function agentOf(office: Office, name: string): number {
  return office.officeState().orchestrators.find((o) => o.name === name)!.agentId!;
}

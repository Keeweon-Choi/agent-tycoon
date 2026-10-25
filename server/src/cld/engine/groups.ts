/**
 * Persistent group-room definitions.  The room transcript deliberately lives
 * elsewhere (`groups/<id>.jsonl`): this little file is only the editable
 * roster, so a damaged roster can never erase a room's history.
 */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { koText, type Refused, refused, type WithError } from '../../../../core/src/cld/serverText.js';
import { configDir } from './events.js';

export const ALL_GROUP_ID = 'all';
export const ALL_GROUP_NAME = koText('room_all');
export const GROUPS_VERSION = 1;
const NAME_MAX = 40;

export interface GroupRoom {
  id: string;
  name: string;
  members: string[];
  /** C4: the room's system lines (Task assigned, reported, …) are off. Absent: on. */
  systemLines?: boolean;
}

interface SavedGroups {
  v: number;
  groups: GroupRoom[];
}

export type GroupResult<T = GroupRoom> = { ok: true; value: T } | ({ ok: false } & WithError);

export const groupsPath = (home = os.homedir()): string => path.join(configDir(home), 'groups.json');
export const groupTimelineDir = (home = os.homedir()): string => path.join(configDir(home), 'groups');

/** A human room name: enough for Korean project rooms, never a control character or one
 *  that could close the `[… · 단톡방 '<방>' · …]` header it is written into. */
export function validGroupName(value: string): string | null {
  const name = value.trim();
  if (!name || name.length > NAME_MAX || /[\p{Cc}\[\]'"]/u.test(name)) return null;
  return name;
}

function uniqueMembers(members: string[], known: string[]): string[] | null {
  const available = new Set(known);
  const result = [...new Set(members)];
  return result.every((member) => available.has(member)) ? result : null;
}

function validSaved(value: unknown): value is SavedGroups {
  if (!value || typeof value !== 'object') return false;
  const saved = value as Partial<SavedGroups>;
  if (saved.v !== GROUPS_VERSION || !Array.isArray(saved.groups)) return false;
  const ids = new Set<string>();
  const names = new Set<string>();
  return saved.groups.every((room) => {
    if (!room || typeof room !== 'object') return false;
    const group = room as Partial<GroupRoom>;
    const name = typeof group.name === 'string' ? validGroupName(group.name) : null;
    if (
      !name ||
      typeof group.id !== 'string' ||
      !/^[a-z0-9]{8,32}$/.test(group.id) ||
      group.id === ALL_GROUP_ID ||
      !Array.isArray(group.members) ||
      !group.members.every((member) => typeof member === 'string') ||
      ids.has(group.id) ||
      names.has(name)
    )
      return false;
    ids.add(group.id);
    names.add(name);
    return true;
  });
}

/**
 * `전체` is generated at each read, rather than saved: project registration
 * and removal immediately change its membership.  A file we could not read
 * or validate puts the store in hold mode; no edit may replace it.
 */
export class GroupStore {
  private groups: GroupRoom[] = [];
  private safe = true;
  private problem: Refused | null = null;

  /**
   * `registered`: every name a room may hold (D3: each project's Lead and the
   * Workers). `everyone`: the members of `전체`, the projects (their Leads);
   * a Worker joins a room only by name, so `@전체` never wakes every Worker.
   */
  constructor(
    private readonly home: string,
    private readonly registered: () => string[],
    private readonly ids: () => string = () => randomBytes(8).toString('hex'),
    private readonly everyone: () => string[] = registered,
  ) {
    this.load();
  }

  get error(): string | null {
    return this.problem?.error ?? null;
  }

  /** Re-read without changing an unreadable/corrupt file. */
  load(): void {
    const file = groupsPath(this.home);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.groups = [];
        this.safe = true;
        this.problem = null;
      } else {
        this.safe = false;
        this.problem = refused('rooms_unreadable');
      }
      return;
    }
    try {
      const saved: unknown = JSON.parse(raw);
      if (!validSaved(saved)) throw new Error('invalid');
      this.groups = saved.groups.map((room) => ({
        id: room.id,
        name: room.name.trim(),
        members: [...new Set(room.members)],
        ...(room.systemLines === false && { systemLines: false as const }),
      }));
      this.safe = true;
      this.problem = null;
    } catch {
      this.safe = false;
      this.problem = refused('rooms_corrupt');
    }
  }

  list(): GroupRoom[] {
    return [
      { id: ALL_GROUP_ID, name: ALL_GROUP_NAME, members: this.names(this.everyone) },
      ...this.groups.map((room) => ({ ...room, members: [...room.members] })),
    ];
  }

  find(nameOrId: string): GroupRoom | null {
    return this.list().find((room) => room.id === nameOrId || room.name === nameOrId) ?? null;
  }

  create(name: string, members: string[]): GroupResult {
    const checked = validGroupName(name);
    if (!checked) return { ok: false, ...refused('room_name_bad') };
    if (checked === ALL_GROUP_NAME || this.groups.some((room) => room.name === checked))
      return { ok: false, ...refused('room_name_taken') };
    const selected = uniqueMembers(members, this.names());
    if (!selected) return { ok: false, ...refused('room_project_unregistered') };
    const room = { id: this.nextId(), name: checked, members: selected };
    const saved = [...this.groups, room];
    const failure = this.save(saved);
    if (failure) return { ok: false, ...failure };
    return { ok: true, value: { ...room, members: [...room.members] } };
  }

  rename(id: string, name: string): GroupResult {
    if (id === ALL_GROUP_ID) return { ok: false, ...refused('room_all_rename') };
    const checked = validGroupName(name);
    if (!checked) return { ok: false, ...refused('room_name_bad') };
    const room = this.groups.find((item) => item.id === id);
    if (!room) return { ok: false, ...refused('room_missing') };
    if (checked === ALL_GROUP_NAME || this.groups.some((item) => item.id !== id && item.name === checked))
      return { ok: false, ...refused('room_name_taken') };
    const saved = this.groups.map((item) => (item.id === id ? { ...item, name: checked } : item));
    const failure = this.save(saved);
    return failure ? { ok: false, ...failure } : { ok: true, value: { ...saved.find((x) => x.id === id)! } };
  }

  setMembers(id: string, members: string[]): GroupResult {
    if (id === ALL_GROUP_ID) return { ok: false, ...refused('room_all_members') };
    const selected = uniqueMembers(members, this.names());
    if (!selected) return { ok: false, ...refused('room_project_unregistered') };
    const room = this.groups.find((item) => item.id === id);
    if (!room) return { ok: false, ...refused('room_missing') };
    const saved = this.groups.map((item) => (item.id === id ? { ...item, members: selected } : item));
    const failure = this.save(saved);
    return failure ? { ok: false, ...failure } : { ok: true, value: { ...saved.find((x) => x.id === id)! } };
  }

  /** C4: turn a room's system lines on or off (`전체` has none: it is only the Leads). */
  setSystemLines(id: string, on: boolean): GroupResult {
    const room = this.groups.find((item) => item.id === id);
    if (!room) return { ok: false, ...refused('room_missing') };
    const next = { id: room.id, name: room.name, members: room.members, ...(!on && { systemLines: false as const }) };
    const failure = this.save(this.groups.map((item) => (item.id === id ? next : item)));
    return failure ? { ok: false, ...failure } : { ok: true, value: { ...next, members: [...next.members] } };
  }

  remove(id: string): GroupResult<null> {
    if (id === ALL_GROUP_ID) return { ok: false, ...refused('room_all_delete') };
    if (!this.groups.some((room) => room.id === id)) return { ok: false, ...refused('room_missing') };
    const failure = this.save(this.groups.filter((room) => room.id !== id));
    return failure ? { ok: false, ...failure } : { ok: true, value: null };
  }

  private names(from = this.registered): string[] {
    return [...new Set(from())].sort((a, b) => a.localeCompare(b, 'ko'));
  }

  private nextId(): string {
    let id = this.ids();
    while (!/^[a-z0-9]{8,32}$/.test(id) || this.groups.some((room) => room.id === id)) id = this.ids();
    return id;
  }

  private save(groups: GroupRoom[]): Refused | null {
    if (!this.safe) return this.problem ?? refused('rooms_unreadable');
    const file = groupsPath(this.home);
    const data = `${JSON.stringify({ v: GROUPS_VERSION, groups })}\n`;
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      fs.renameSync(tmp, file);
      this.groups = groups.map((room) => ({ ...room, members: [...room.members] }));
      return null;
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      return refused('rooms_save_failed');
    }
  }
}

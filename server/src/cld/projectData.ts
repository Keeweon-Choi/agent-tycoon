/**
 * Everything kept under one engine agent's name (a project's Lead, whose name is the project's,
 * or a Worker), as ONE list: `agty rename` moves it to the new name (moveProjectData), a remove
 * detaches it from the name (moved to the agent's gone name `~<assignment id>`, core goneAgent.ts)
 * or, with the purge box, deletes it (purgeProjectData), and the messenger's 대화방 지우기 deletes
 * what a removed agent left (deleteGoneConversation). A new agent that takes a name later inherits
 * none of it, unless the owner asks it to (계승, inheritProjectData: a removed agent of the same
 * folder, not purged, its chat not deleted, moves to the new agent's name). A move never overwrites: when the target name already has data in any store it
 * refuses and changes nothing (NameTaken). Each entry is one store; every write is tmp + rename; a
 * store that fails is logged and named in the result, the others still go.
 *
 * Inventory (grep of server/src, core and the config folder for stores keyed by an agent's or a
 * project's name, 11-01). <cfg> = configDirectory(home):
 *   characters.json        { <name>: look, $meta: { auto: { <name>: pin } } }       (CharacterPresets)
 *   levels.json            { levels: { "engine:<name>": { xp, rebirths, inherit? } } } (LevelStore: Lv/XP/환생/계승)
 *   pins.json              { keys: [<contact name> | "room:<id>"] }                   (PinStore)
 *   roster.json            { projects: { <project name>: { employees, executions } } } (RosterStore)
 *   building.json          { floors: [{ characters: [<name>] }] }                     (BuildingStore)
 *   groups.json            { groups: [{ members: [<name>] }] }                        (GroupStore: room membership)
 *   groups/<room>.<YYYY-MM>.jsonl[.gz], groups/<room>.jsonl
 *                          post.sender, post.targets[], post.delivery{<name>}, post.messageIds{<name>},
 *                          delivery.member                                            (the rooms' history)
 *   inbox/<name>/*.md      (+ <file>.meta.json { to })                                (Messenger inbox)
 *   queue/*.json           { to, from }                                               (Messenger queue)
 *   typed/<name>.json      the messenger's typing hints                               (Messenger)
 *   renewals/<encodeURIComponent(name)>.json[.failed]  { name, ... }                  (Renewals)
 *   revive-guard.json      { <name>: { attempts, gaveUp } }                           (ReviveGuard)
 *   rules-combined/<name>-<sha1>.md  written again at every start                     (agentRules)
 *   tasks.json             tasks[].project, tasks[].assignee.name                     (TaskStore)
 *   approvals.json         modes{<project>}, approvals[].project/.caller, newWorkers[].project
 *                          (ApprovalStore: delegation). newWorkers[].name is the daily new-Worker
 *                          count, noted BEFORE the Worker is made: not data kept under that name
 *                          (a rename still follows it, a purge drops the project's entries)
 *   tracking.json          { projects: { <project>: settings } }                      (TrackingSettingsStore)
 *   worktrees.json         [{ project, ... }]                                         (Worktrees)
 *   merge-history.json     { <project>: [...] }                                       (MergeHistory)
 *   review-notes.json      { notes: { "<project>\0<task>": [...] } }                  (ReviewNotes)
 *   protected-branches.json { <project>: [branch] }  the owner's list: merge and guard (merge.ts)
 *   name-history.json      this module's: former names and removed agents (below)
 *   rename-journal.json    this module's: a rename the engine committed but did not finish
 * Reserved, never a new agent's name (registry checkName): "owner" (the owner's look key), "사장"
 * (the boss's sender name), "cld-gui"/"agty" (system senders); `emp:`, `room:`, `engine:`, `$meta`
 * and `~` keys cannot be names (NAME_RE).
 * The engine itself keeps, and changes in the same step: projects.json + assignments.json (the
 * registry), agent-tokens.json (dropped; the restart issues a new token), the compaction counts
 * (memory only) and its revive-guard copy in memory (reloaded).
 * Checked again 11-01 (`grep -rn "\[project\]\|\[p.name\]\|\[name\]" server/src/cld` and every
 * <cfg> file): job-history.json is keyed by a job's label, layout seats are computed, devroom.json,
 * gpu.json, ez-rules.json, decor.json and the rest are global or keyed by ids.
 * Left as written (history or ids, not names): events.jsonl and audit.jsonl (append-only; old lines
 * keep the old name), lead-history.json (assignment ids), job-history.json and Codex task records
 * (the project's name at the time), the seats (character ids). The Claude transcripts under
 * ~/.claude/projects are never touched by a move or a purge (the messenger reads a removed agent's
 * conversation from them, as "(알 수 없음)"); only 대화방 지우기 deletes that agent's own ones.
 *
 * name-history.json `{v: 1, entries: [{name, until, as, gone?}]}`: until `until`, `name` meant `as`
 * (a rename's new name, or a removed agent's gone name with `gone` = what its contact needs). The
 * messenger reads a transcript's "[from <name>]" header through it (aliasOf), so a message an agent
 * sent before its rename shows the new name, one a removed agent sent shows "(알 수 없음)", and a
 * later agent of the same name owns only what came after.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

import { isGoneName } from '../../../core/src/cld/goneAgent.js';
import type { InheritableAgent } from '../../../core/src/messages.js';
import { configDirectory } from './configPath.js';
import { combinedRulesFile } from './engine/agentRules.js';
import { eventsPath } from './engine/events.js';
import { readLeadHistory } from './engine/leadSwap.js';
import { SESSION_ID_RE } from './engine/registry.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';
import { levelOf } from './levels.js';
import { transcriptPath } from './providers/claudeProvider.js';

type Json = Record<string, unknown>;

interface Store {
  id: string;
  /** `name` has data here: a move onto it is refused. */
  has(home: string, name: string): boolean;
  move(home: string, from: string, to: string): void;
  /** Delete `name`'s data; `gone` is its gone name, for the history that is kept. */
  purge(home: string, name: string, gone: string): void;
}

/** A move refused: the target name already has data in these stores (nothing was changed). */
export class NameTaken extends Error {
  constructor(readonly stores: string[]) {
    super(`data is already kept under that name (${stores.join(', ')})`);
  }
}

const cfg = (home: string, ...parts: string[]) => path.join(configDirectory(home), ...parts);

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o: unknown, key: string): boolean => isObj(o) && Object.hasOwn(o, key);

/** Re-key `from` (to `to`, or away when null) in `o`; true when it changed. */
function rekey(o: unknown, from: string, to: string | null): boolean {
  if (!isObj(o) || !Object.hasOwn(o, from) || from === to) return false;
  if (to !== null) o[to] = o[from];
  delete o[from];
  return true;
}

/** `from` replaced by `to` (or dropped when null) in a list of names, without duplicates. */
function renamed(list: unknown, from: string, to: string | null): string[] | null {
  if (!Array.isArray(list) || !list.includes(from)) return null;
  const out: string[] = [];
  for (const x of list) {
    const v = x === from ? to : x;
    if (v !== null && !out.includes(v)) out.push(v);
  }
  return out;
}

/** A JSON object file, or null when there is none (throws when it is not one). */
function readObj(file: string): Json | null {
  const j = readJson(file);
  if (j === null) return null;
  if (!isObj(j)) throw new Error(`${path.basename(file)}: not a JSON object`);
  return j;
}

/** Edit a JSON object file in place; written (atomically) only when `edit` says it changed. */
function editJson(file: string, edit: (j: Json) => boolean): void {
  const j = readObj(file);
  if (j && edit(j)) writeJsonAtomic(file, j);
}

/** Whether a JSON object file's contents say `test`. */
const holds = (file: string, test: (j: Json) => boolean): boolean => {
  const j = readObj(file);
  return !!j && test(j);
};

function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const list = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A name-keyed object file: `pick` finds the object that holds the names. */
const keyed = (file: string, pick: (j: Json) => unknown, key = (n: string) => n): Store => ({
  id: file,
  has: (home, name) => holds(cfg(home, file), (j) => has(pick(j), key(name))),
  move: (home, from, to) => editJson(cfg(home, file), (j) => rekey(pick(j), key(from), key(to))),
  purge: (home, name) => editJson(cfg(home, file), (j) => rekey(pick(j), key(name), null)),
});

/** A room-history record with every mention of `from` as `to`; null when it has none. */
function readdressRecord(r: Json, from: string, to: string): Json | null {
  let changed = false;
  if (r.kind === 'delivery' && r.member === from) {
    r.member = to;
    changed = true;
  }
  const p = r.kind === 'post' && isObj(r.post) ? r.post : null;
  if (p) {
    if (p.sender === from) {
      p.sender = to;
      changed = true;
    }
    const targets = renamed(p.targets, from, to);
    if (targets) {
      p.targets = targets;
      changed = true;
    }
    changed = rekey(p.delivery, from, to) || changed;
    changed = rekey(p.messageIds, from, to) || changed;
  }
  return changed ? r : null;
}

/** Every room log segment (plain and .gz) with `from` readdressed to `to`; `dry`: only whether
 *  one mentions `from`. */
function readdressRoomLogs(home: string, from: string, to: string, dry = false): boolean {
  if (from === to && !dry) return false;
  const dir = cfg(home, 'groups');
  let found = false;
  for (const f of list(dir)) {
    if (!/\.jsonl(\.gz)?$/.test(f)) continue;
    const file = path.join(dir, f);
    const gz = f.endsWith('.gz');
    const raw = fs.readFileSync(file);
    const text = gz ? zlib.gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
    if (!text.includes(JSON.stringify(from))) continue;
    let changed = false;
    const lines = text.split('\n').map((line) => {
      if (!line.includes(JSON.stringify(from))) return line;
      try {
        const r = readdressRecord(JSON.parse(line) as Json, from, to);
        if (!r) return line;
        changed = true;
        return JSON.stringify(r);
      } catch {
        return line; // a torn or foreign line stays as it is
      }
    });
    if (!changed) continue;
    found = true;
    if (dry) return true;
    writeAtomic(file, gz ? zlib.gzipSync(lines.join('\n')) : lines.join('\n'));
  }
  return found;
}

const renewalFile = (home: string, name: string, failed: boolean) =>
  cfg(home, 'renewals', `${encodeURIComponent(name)}.json${failed ? '.failed' : ''}`);

/** A list file whose items name `from` in `fields`: each such field as `to`. */
function renameFields(items: unknown[], fields: readonly string[], from: string, to: string): boolean {
  let changed = false;
  for (const x of items)
    for (const f of fields)
      if (isObj(x) && x[f] === from) {
        x[f] = to;
        changed = true;
      }
  return changed;
}
const mentions = (items: unknown[], fields: readonly string[], name: string): boolean =>
  items.some((x) => isObj(x) && fields.some((f) => x[f] === name));

/** The stores, in the order they are moved. */
export const PROJECT_STORES: readonly Store[] = [
  {
    id: 'characters.json',
    has: (home, name) =>
      holds(cfg(home, 'characters.json'), (j) => has(j, name) || (isObj(j.$meta) && has(j.$meta.auto, name))),
    move: (home, from, to) =>
      editJson(cfg(home, 'characters.json'), (j) => {
        const pinned = rekey(isObj(j.$meta) ? j.$meta.auto : undefined, from, to);
        return rekey(j, from, to) || pinned;
      }),
    purge: (home, name) =>
      editJson(cfg(home, 'characters.json'), (j) => {
        const pinned = rekey(isObj(j.$meta) ? j.$meta.auto : undefined, name, null);
        return rekey(j, name, null) || pinned;
      }),
  },
  keyed('levels.json', (j) => j.levels, (n) => `engine:${n}`),
  {
    id: 'pins.json',
    has: (home, name) => holds(cfg(home, 'pins.json'), (j) => arr(j.keys).includes(name)),
    move: (home, from, to) =>
      editJson(cfg(home, 'pins.json'), (j) => {
        const keys = renamed(j.keys, from, to); // a gone contact is keyed by its gone name too
        if (keys) j.keys = keys;
        return !!keys;
      }),
    purge: (home, name) =>
      editJson(cfg(home, 'pins.json'), (j) => {
        const keys = renamed(j.keys, name, null);
        if (keys) j.keys = keys;
        return !!keys;
      }),
  },
  keyed('roster.json', (j) => j.projects),
  ...(['building.json', 'groups.json'] as const).map((file): Store => {
    // building.json floors[].characters, groups.json groups[].members: a gone name is no member.
    const field = file === 'building.json' ? 'characters' : 'members';
    const items = (j: Json) => arr(file === 'building.json' ? j.floors : j.groups);
    const edit = (home: string, from: string, to: string | null) =>
      editJson(cfg(home, file), (j) => {
        let changed = false;
        for (const x of items(j)) {
          const next = isObj(x) ? renamed(x[field], from, to) : null;
          if (next && isObj(x)) {
            x[field] = next;
            changed = true;
          }
        }
        return changed;
      });
    return {
      id: file,
      has: (home, name) => holds(cfg(home, file), (j) => items(j).some((x) => isObj(x) && arr(x[field]).includes(name))),
      move: (home, from, to) => edit(home, from, isGoneName(to) ? null : to),
      purge: (home, name) => edit(home, name, null),
    };
  }),
  {
    // The rooms' history stays: a purge readdresses it to the gone name too.
    id: 'groups/',
    has: (home, name) => readdressRoomLogs(home, name, name, true),
    move: (home, from, to) => void readdressRoomLogs(home, from, to),
    purge: (home, name, gone) => void readdressRoomLogs(home, name, gone),
  },
  {
    id: 'inbox/',
    has: (home, name) => list(cfg(home, 'inbox', name)).length > 0,
    move: (home, from, to) => {
      const src = cfg(home, 'inbox', from);
      const files = list(src);
      if (!files.length) return;
      const dst = cfg(home, 'inbox', to);
      fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
      for (const f of files) {
        if (fs.existsSync(path.join(dst, f))) throw new Error(`inbox/${to}/${f} exists`);
        if (f.endsWith('.meta.json')) editJson(path.join(src, f), (j) => (j.to === from ? ((j.to = to), true) : false));
        fs.renameSync(path.join(src, f), path.join(dst, f));
      }
      fs.rmSync(src, { recursive: true, force: true });
    },
    purge: (home, name) => fs.rmSync(cfg(home, 'inbox', name), { recursive: true, force: true }),
  },
  {
    id: 'queue/',
    has: (home, name) =>
      list(cfg(home, 'queue')).some((f) => f.endsWith('.json') && holds(cfg(home, 'queue', f), (j) => j.to === name || j.from === name)),
    move: (home, from, to) => {
      for (const f of list(cfg(home, 'queue')))
        if (f.endsWith('.json'))
          editJson(cfg(home, 'queue', f), (j) => {
            const hit = j.to === from || j.from === from;
            if (j.to === from) j.to = to;
            if (j.from === from) j.from = to;
            return hit;
          });
    },
    purge: (home, name) => {
      for (const f of list(cfg(home, 'queue'))) {
        const file = cfg(home, 'queue', f);
        if (f.endsWith('.json') && (readJson(file) as Json | null)?.to === name) fs.rmSync(file, { force: true });
      }
    },
  },
  {
    id: 'typed/',
    has: (home, name) => fs.existsSync(cfg(home, 'typed', `${name}.json`)),
    move: (home, from, to) => {
      const src = cfg(home, 'typed', `${from}.json`);
      const dst = cfg(home, 'typed', `${to}.json`);
      if (fs.existsSync(dst)) throw new Error(`typed/${to}.json exists`);
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    },
    purge: (home, name) => fs.rmSync(cfg(home, 'typed', `${name}.json`), { force: true }),
  },
  {
    id: 'renewals/',
    has: (home, name) => [false, true].some((failed) => fs.existsSync(renewalFile(home, name, failed))),
    move: (home, from, to) => {
      for (const failed of [false, true]) {
        const src = renewalFile(home, from, failed);
        if (!fs.existsSync(src)) continue;
        if (fs.existsSync(renewalFile(home, to, failed))) throw new Error(`${path.basename(renewalFile(home, to, failed))} exists`);
        editJson(src, (j) => (j.name === from ? ((j.name = to), true) : false));
        fs.renameSync(src, renewalFile(home, to, failed));
      }
    },
    purge: (home, name) => {
      for (const failed of [false, true]) fs.rmSync(renewalFile(home, name, failed), { force: true });
    },
  },
  keyed('revive-guard.json', (j) => j),
  {
    // Named after the agent and written again at its next start: the old one only goes.
    id: 'rules-combined/',
    has: () => false,
    move: (home, from) => fs.rmSync(combinedRulesFile(home, from), { force: true }),
    purge: (home, name) => fs.rmSync(combinedRulesFile(home, name), { force: true }),
  },
  {
    // A removed project's Tasks go under its gone name (a purge too): work records stay. An
    // assignee is bound by its assignment id: its name follows a rename; a removed one keeps the
    // name it had (the board shows "(삭제됨) <name>"), which is no data of a new agent's.
    id: 'tasks.json',
    has: (home, name) => holds(cfg(home, 'tasks.json'), (j) => arr(j.tasks).some((t) => isObj(t) && t.project === name)),
    move: (home, from, to) => tasksMove(home, from, to),
    purge: (home, name, gone) => tasksMove(home, name, gone),
  },
  {
    id: 'approvals.json',
    has: (home, name) =>
      holds(cfg(home, 'approvals.json'), (j) =>
        has(j.modes, name) || mentions(arr(j.approvals), ['project', 'caller'], name) || mentions(arr(j.newWorkers), ['project'], name),
      ),
    move: (home, from, to) =>
      editJson(cfg(home, 'approvals.json'), (j) => {
        const mode = rekey(j.modes, from, to);
        const calls = renameFields(arr(j.approvals), ['project', 'caller'], from, to);
        return renameFields(arr(j.newWorkers), ['project', 'name'], from, to) || calls || mode;
      }),
    purge: (home, name) =>
      editJson(cfg(home, 'approvals.json'), (j) => {
        const before = JSON.stringify(j);
        rekey(j.modes, name, null);
        j.approvals = arr(j.approvals).filter((a) => !(isObj(a) && (a.project === name || a.caller === name)));
        j.newWorkers = arr(j.newWorkers).filter((w) => !(isObj(w) && w.project === name));
        return JSON.stringify(j) !== before;
      }),
  },
  keyed('tracking.json', (j) => j.projects),
  {
    id: 'worktrees.json',
    has: (home, name) => mentions(arr(readJson(cfg(home, 'worktrees.json'))), ['project'], name),
    move: (home, from, to) => {
      const j = readJson(cfg(home, 'worktrees.json'));
      if (Array.isArray(j) && renameFields(j, ['project'], from, to)) writeJsonAtomic(cfg(home, 'worktrees.json'), j);
    },
    purge: (home, name) => {
      const j = readJson(cfg(home, 'worktrees.json'));
      if (Array.isArray(j) && mentions(j, ['project'], name))
        writeJsonAtomic(cfg(home, 'worktrees.json'), j.filter((r) => !(isObj(r) && r.project === name)));
    },
  },
  keyed('merge-history.json', (j) => j),
  {
    id: 'review-notes.json',
    has: (home, name) => holds(cfg(home, 'review-notes.json'), (j) => Object.keys(isObj(j.notes) ? j.notes : {}).some((k) => k.startsWith(`${name}\0`))),
    move: (home, from, to) => reviewNotesMove(home, from, to),
    purge: (home, name) => reviewNotesMove(home, name, null),
  },
  // The owner's protected branches of a project: a rename must keep them (a merge or a guard
  // install of the new name would otherwise find none).
  keyed('protected-branches.json', (j) => j),
];

function reviewNotesMove(home: string, from: string, to: string | null): void {
  editJson(cfg(home, 'review-notes.json'), (j) => {
    let changed = false;
    for (const k of Object.keys(isObj(j.notes) ? j.notes : {}))
      if (k.startsWith(`${from}\0`)) changed = rekey(j.notes, k, to === null ? null : `${to}${k.slice(from.length)}`) || changed;
    return changed;
  });
}

function tasksMove(home: string, from: string, to: string): void {
  editJson(cfg(home, 'tasks.json'), (j) => {
    let changed = false;
    for (const t of arr(j.tasks)) {
      if (!isObj(t)) continue;
      if (t.project === from) {
        t.project = to;
        changed = true;
      }
      if (!isGoneName(to) && isObj(t.assignee) && t.assignee.name === from) {
        t.assignee.name = to;
        changed = true;
      }
    }
    return changed;
  });
}

/** The stores where `name` already has data (one that cannot be read counts: it might). */
export function takenBy(home: string, name: string): string[] {
  return PROJECT_STORES.filter((s) => {
    try {
      return s.has(home, name);
    } catch {
      return true;
    }
  }).map((s) => s.id);
}

function each(what: string, run: (s: Store) => void, log: (line: string) => void): string[] {
  const failed: string[] = [];
  for (const s of PROJECT_STORES) {
    try {
      run(s);
    } catch (err) {
      failed.push(s.id);
      log(`project data ${what}: ${s.id} not changed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return failed;
}

/**
 * Every store's `from` as `to` (a rename, or a remove's detach to the gone name); the stores that
 * did not follow. Refused with NameTaken, nothing changed, when `to` already has data anywhere.
 * `force` (a journal's roll-forward, where `to` holds what the cut-short move already did) skips
 * that check; a store whose own target exists still refuses on its own.
 */
export function moveProjectData(
  home: string,
  from: string,
  to: string,
  log: (line: string) => void = () => undefined,
  force = false,
): string[] {
  if (!force) {
    const taken = takenBy(home, to);
    if (taken.length) throw new NameTaken(taken);
  }
  return each(`${from} -> ${to}`, (s) => s.move(home, from, to), log);
}

/** Every store's data of `name` deleted (the room history and Tasks readdressed to `gone`); the
 *  stores that kept it. */
export function purgeProjectData(
  home: string,
  name: string,
  gone: string,
  log: (line: string) => void = () => undefined,
): string[] {
  return each(`purge ${name}`, (s) => s.purge(home, name, gone), log);
}

// ── name-history.json ─────────────────────────────────────────

/** What a removed agent's messenger contact needs. */
export interface GoneAgent {
  folder: string;
  transcript?: string;
  /** Its conversation when it was removed (대화방 지우기 starts from it). */
  sessionId?: string;
  /** 대화방 지우기 ran, or a new agent inherited it (`inherited`): no contact any more (the
   *  alias stays: its room posts read "(알 수 없음)", or the heir's name). */
  deleted?: true;
  /** Removed with the purge box: nothing of it is left to inherit. */
  purged?: true;
  /** INHERIT: the agent that took its records over. */
  inherited?: string;
}

export interface FormerName {
  name: string;
  until: number;
  as: string;
  gone?: GoneAgent;
}

export const NAME_HISTORY_VERSION = 1;
const historyFile = (home: string) => cfg(home, 'name-history.json');
let cached: { home: string; stamp: string; entries: FormerName[] } | null = null;

const optStr = (v: unknown) => v === undefined || typeof v === 'string';
const validEntry = (e: unknown): e is FormerName =>
  isObj(e) &&
  typeof e.name === 'string' &&
  typeof e.as === 'string' &&
  Number.isFinite(e.until) &&
  (e.gone === undefined ||
    (isObj(e.gone) &&
      typeof e.gone.folder === 'string' &&
      optStr(e.gone.transcript) &&
      optStr(e.gone.sessionId) &&
      optStr(e.gone.inherited) &&
      (e.gone.purged === undefined || e.gone.purged === true) &&
      (e.gone.deleted === undefined || e.gone.deleted === true)));

/** The entries, oldest first (read again only when the file changed). */
export function readNameHistory(home: string): FormerName[] {
  let stamp = '';
  try {
    const st = fs.statSync(historyFile(home));
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return [];
  }
  if (cached?.home === home && cached.stamp === stamp) return cached.entries;
  let entries: FormerName[] = [];
  try {
    const j = readJson(historyFile(home)) as Json | null;
    if (j?.v === NAME_HISTORY_VERSION && Array.isArray(j.entries)) entries = j.entries.filter(validEntry);
  } catch {
    /* unreadable: no aliases, as before the file existed */
  }
  cached = { home, stamp, entries };
  return entries;
}

function writeNameHistory(home: string, entries: FormerName[]): void {
  writeJsonAtomic(historyFile(home), { v: NAME_HISTORY_VERSION, entries });
  cached = null;
}

/** Add one entry (atomic); the same entry again (a journal's roll-forward) is not added twice. */
export function recordFormerName(home: string, entry: FormerName): void {
  const entries = readNameHistory(home);
  if (entries.some((e) => e.name === entry.name && e.as === entry.as && e.until === entry.until)) return;
  writeNameHistory(home, [...entries, entry]);
}

/** Who `name` was at `at`: the name it answers to now (a rename), a gone name (removed), or
 *  undefined when it is still itself. Each hop's `until` is later than the last one's, so an
 *  A -> B -> A history ends. */
export function aliasOf(entries: readonly FormerName[], name: string, at: number): string | undefined {
  let cur = name;
  let after = -Infinity;
  for (let hop = 0; hop < entries.length; hop++) {
    let next: FormerName | undefined;
    for (const e of entries)
      if (e.name === cur && at < e.until && e.until > after && (!next || e.until < next.until)) next = e;
    if (!next) break;
    cur = next.as;
    after = next.until;
  }
  return cur === name ? undefined : cur;
}

/** The removed agents whose conversation is still kept, oldest first, each with its gone name. */
export const goneAgents = (entries: readonly FormerName[]): Array<GoneAgent & { name: string; at: number }> =>
  entries.flatMap((e) => (e.gone && !e.gone.deleted && isGoneName(e.as) ? [{ ...e.gone, name: e.as, at: e.until }] : []));

// ── 계승 (INHERIT) ────────────────────────────────────────────

/** The removed agents of `folder` (`same` compares folders the engine's way) whose records are
 *  still kept: not purged, chat not deleted, not inherited already, something left under the gone
 *  name. Newest first, each with its Lv, 환생 and 계승 counts and its conversation files on disk. */
export function inheritable(home: string, folder: string, same: (a: string, b: string) => boolean): InheritableAgent[] {
  const entries = readNameHistory(home);
  let levels: Json = {};
  try {
    const j = readObj(cfg(home, 'levels.json'));
    if (j && isObj(j.levels)) levels = j.levels;
  } catch {
    /* unreadable: Lv 1 shown */
  }
  return entries
    .flatMap((e) => (e.gone && !e.gone.deleted && !e.gone.purged && isGoneName(e.as) && same(e.gone.folder, folder) ? [{ e, g: e.gone }] : []))
    .filter(({ e }) => takenBy(home, e.as).length > 0)
    .map(({ e, g }) => {
      const lv = isObj(levels[`engine:${e.as}`]) ? (levels[`engine:${e.as}`] as Json) : {};
      const num = (v: unknown) => (Number.isFinite(v) ? Math.max(0, v as number) : 0);
      return {
        key: e.as,
        name: e.name,
        removedAt: e.until,
        level: levelOf(num(lv.xp)),
        rebirths: num(lv.rebirths),
        inherit: num(lv.inherit),
        conversations: goneSessionIds(home, e.as, g).filter((id) => fs.existsSync(transcriptPath(g.folder, id, home))).length,
      };
    })
    .reverse();
}

/**
 * INHERIT: what a removed agent (`gone`, its gone name) left moves to the new agent `to`
 * (moveProjectData: refused with NameTaken when `to` has data of its own), its 계승 count is the
 * old one's plus 1 (levels.json, created at Lv 1 when it had none), and name-history says so:
 * its contact goes (`deleted`, `inherited`) and its messages read as `to`'s from now on (an alias
 * from the gone name to `to`). The stores that did not follow, and the new 계승 count.
 */
export function inheritProjectData(
  home: string,
  gone: string,
  to: string,
  log: (line: string) => void = () => undefined,
  now = Date.now(),
): { failed: string[]; count: number } {
  const failed = moveProjectData(home, gone, to, log);
  let count = 1;
  try {
    const file = cfg(home, 'levels.json');
    const j = readObj(file) ?? { v: 1 };
    if (!isObj(j.levels)) j.levels = {};
    const levels = j.levels as Json;
    const old = isObj(levels[`engine:${to}`]) ? (levels[`engine:${to}`] as Json) : { xp: 0, rebirths: 0 };
    count = (Number.isFinite(old.inherit) ? (old.inherit as number) : 0) + 1;
    levels[`engine:${to}`] = { ...old, inherit: count };
    writeJsonAtomic(file, j);
  } catch (err) {
    failed.push('levels.json');
    log(`inherit ${gone} -> ${to}: levels.json (${String(err)})`);
  }
  try {
    const entries = readNameHistory(home);
    writeNameHistory(home, [
      ...entries.map((e) => (e.as === gone && e.gone && !e.gone.deleted ? { ...e, gone: { ...e.gone, deleted: true as const, inherited: to } } : e)),
      { name: gone, until: now, as: to },
    ]);
  } catch (err) {
    failed.push('name-history.json');
    log(`inherit ${gone} -> ${to}: name-history.json (${String(err)})`);
  }
  return { failed, count };
}

// ── 대화방 지우기 ─────────────────────────────────────────────

/** A removed agent's own conversations: the one it had when removed, the ones a renew, rename,
 *  /clear or resume copy left behind it (events.jsonl orch_renew / orch_rename / orch_follow link
 *  each to the one before; a link from before orch_follow existed is not known), and its
 *  terms as a Lead (lead-history.json, by its assignment id). Nothing else. */
export function goneSessionIds(home: string, gone: string, g: GoneAgent): string[] {
  const own = new Set<string>();
  const first = g.sessionId ?? (g.transcript ? path.basename(g.transcript, '.jsonl') : undefined);
  if (first && SESSION_ID_RE.test(first)) own.add(first);
  for (const t of readLeadHistory(home)) if (`~${t.assignmentId}` === gone && SESSION_ID_RE.test(t.sessionId)) own.add(t.sessionId);
  const before = new Map<string, string>();
  let text = '';
  try {
    text = fs.readFileSync(eventsPath(home), 'utf-8');
  } catch {
    /* no events: only the ids above */
  }
  for (const line of text.split('\n')) {
    if (!line.includes('old_session_id')) continue;
    try {
      const e = JSON.parse(line) as Json;
      if (
        (e.type === 'orch_renew' || e.type === 'orch_rename' || e.type === 'orch_follow') &&
        typeof e.session_id === 'string' &&
        typeof e.old_session_id === 'string'
      )
        before.set(e.session_id, e.old_session_id);
    } catch {
      /* a torn line */
    }
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of [...own]) {
      const old = before.get(id);
      if (old && SESSION_ID_RE.test(old) && !own.has(old)) {
        own.add(old);
        grew = true;
      }
    }
  }
  return [...own];
}

/**
 * 대화방 지우기: a removed agent's one-to-one conversation, gone for good. Its own Claude
 * conversation files (goneSessionIds: each `<id>.jsonl` and its `<id>/` folder, only inside
 * ~/.claude/projects), then what is kept under its gone name (purgeProjectData; the rooms' logs
 * and its Tasks stay), then its contact (name-history: `deleted`). How many conversation files
 * were deleted, and the paths and stores that could not be; null when `gone` is no removed agent
 * with a conversation. `resumed`: the conversations registered agents have now, always kept.
 */
export function deleteGoneConversation(
  home: string,
  gone: string,
  log: (line: string) => void = () => undefined,
  resumed: readonly string[] = [],
): { deleted: number; failed: string[] } | null {
  if (!isGoneName(gone)) return null;
  const entries = readNameHistory(home);
  const entry = entries.find((e) => e.as === gone && e.gone && !e.gone.deleted);
  if (!entry?.gone) return null;
  const g = entry.gone;
  const failed: string[] = [];
  let deleted = 0;
  const root = path.join(home, '.claude', 'projects');
  for (const id of goneSessionIds(home, gone, g)) {
    // A registered agent resumes it (an heir whose 계승 did not mark this contact): never deleted.
    if (resumed.includes(id)) {
      log(`gone conversation ${gone}: ${id} kept (a registered agent resumes it)`);
      continue;
    }
    const file = transcriptPath(g.folder, id, home);
    // Only `<root>/<dir>/<id>.jsonl` and its `<id>/` folder (sub-agents); never anything else.
    if (path.dirname(path.dirname(file)) !== root || path.basename(file) !== `${id}.jsonl`) continue;
    if (fs.existsSync(file)) deleted++;
    for (const p of [file, path.join(path.dirname(file), id)])
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (err) {
        if (p === file) deleted--;
        failed.push(p);
        log(`gone conversation ${gone}: ${p} not deleted (${String(err)})`);
      }
  }
  failed.push(...purgeProjectData(home, gone, gone, log));
  const { transcript: _t, ...rest } = g;
  writeNameHistory(
    home,
    entries.map((e) => (e === entry ? { ...e, gone: { ...rest, deleted: true as const } } : e)),
  );
  return { deleted, failed };
}

// ── rename-journal.json ───────────────────────────────────────

/** A rename the engine committed (registry written) but may not have finished. */
export interface RenameJournal {
  v: 1;
  from: string;
  to: string;
  /** The assignment the rename is for. */
  assignmentId: string;
  at: number;
}
const journalFile = (home: string) => cfg(home, 'rename-journal.json');

export function writeRenameJournal(home: string, j: RenameJournal): void {
  writeJsonAtomic(journalFile(home), j);
}
export function clearRenameJournal(home: string): void {
  fs.rmSync(journalFile(home), { force: true });
}
/** The journal; null when there is none or it cannot be read (logged by the caller). */
export function readRenameJournal(home: string): RenameJournal | null {
  try {
    const j = readObj(journalFile(home));
    return j && j.v === 1 && typeof j.from === 'string' && typeof j.to === 'string' && typeof j.assignmentId === 'string' && Number.isFinite(j.at)
      ? (j as unknown as RenameJournal)
      : null;
  } catch {
    return null;
  }
}

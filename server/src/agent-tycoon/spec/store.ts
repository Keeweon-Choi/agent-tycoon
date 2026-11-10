/**
 * SPT §4.1-4.2 (ADR-0019): a project's spec Registry, the sidecar that holds its document UIDs,
 * in `<settings directory>/spec/<projectId>/registry.json` (folders 0700, the file 0600, written
 * through a temp file and a rename; the daemon is the only writer). Metadata only: paths, kinds,
 * git states, hashes and the decisions that gave each UID; never a document's text or title.
 * A file this store cannot read is `corrupt`: it is left exactly as it is and never written over.
 * Slice 1a holds document records, 1b item records (hashes and locators, no body, no title),
 * 1c the ladder's decisions and the open questions (candidates on the provisional records). The
 * text the ladder compares lives apart, in the match cache (cache.ts).
 */
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../configPath.js';
import { opaqueId, PROJECT_ID_RE } from '../engine/registry.js';
import { readJson, writeJsonAtomic } from '../jsonFile.js';
import { DOC_KINDS, type DocKind, GIT_STATES, type GitState } from './discover.js';
import { ITEM_SHAPES, type ItemShape } from './extract.js';

/** v2 (SPT-P4A): `components`. A v1 Registry is read as one without components. */
export const SPEC_VERSION = 2;
const READS: readonly unknown[] = [1, 2];
export const DOC_UID_RE = /^d_[a-z2-7]{10}$/;
export const ITEM_UID_RE = /^r_[a-z2-7]{10}$/;
export const COMP_UID_RE = /^c_[a-z2-7]{10}$/;
const HASH16 = /^[0-9a-f]{16}$/;
export const DOC_MODES = ['auto', 'headings', 'off', 'refs'] as const;
export type DocMode = (typeof DOC_MODES)[number];
/** How a document record got its UID (SPT §2.5): D0 path, D1 git rename, D2 front-matter id, D3 content, or the owner. */
export type DocHow = 'D0' | 'D1' | 'D2' | 'D3' | 'new' | 'unresolved' | 'owner-same' | 'owner-new';
/** Evidence a candidate is shown with in 같은 항목 확인. */
export type Why = 'text' | 'title' | 'sameDoc' | 'neighbours' | 'sameId' | 'retired' | 'content' | 'path';
/** One candidate of a question: an older record, its score and evidence. */
export interface Cand {
  uid: string;
  score: number;
  why: Why[];
}
export type State = 'active' | 'retired' | 'unresolved';
const STATES: readonly unknown[] = ['active', 'retired', 'unresolved'];
export interface Decision<H> {
  rev: string;
  how: H;
  by: 'engine' | 'owner';
  at?: string;
  score?: number;
  /** The text hash and display ID it had before this decision (나누기 puts them back). */
  was?: string;
  wasId?: string;
  /** Its document's first read (the enable): not shown in 최근 판정. */
  first?: true;
}

export interface DocRecord {
  /** Relative to the project folder (its last place). */
  path: string;
  kind: DocKind;
  mode: DocMode;
  /** The owner tracks it (the 켜기 window's tick, or the 문서 tab's switch). */
  tracked: boolean;
  /** retired: the file is gone (the UID is kept, and comes back if the path does); unresolved: 'same document?' is open. */
  state: State;
  git: GitState;
  /** The git blob id of the version last read (computed the same way when the folder is no repository). */
  blob: string;
  size: number;
  mtimeMs: number;
  /** When its content last changed (ISO). */
  changedAt: string;
  pathHistory: Array<{ path: string; rev: string; how: DocHow }>;
  decisions: Array<Decision<DocHow | 'retired' | 'kind' | 'tracked' | 'mode' | 'sensitive'>>;
  /** The front matter's `id:` (D2's evidence; a label, not text). */
  fmId?: string;
  /** 민감: the match cache keeps no text of it, only hashes (as for a document git ignores). */
  sensitive?: boolean;
  /** 'same document?': the older records it may be. */
  candidates?: Cand[];
  /** Provisional UIDs the owner answered into this one. */
  aliases?: string[];
  /** ID-less headings in the headings mode: down to this level (absent: SPEC_HEADING_DEPTH). */
  depth?: number;
  /** Tracked by itself: it appeared in a folder that holds tracked documents ('새 문서' until the owner looks). */
  fresh?: boolean;
  /** What its items were last taken from (blob, kind, mode, depth, ID rules), hashed: another one means extract and match again. */
  itemsKey?: string;
}

/** How an item kept or got its UID (SPT §2.5): T1 same text (T1n with its neighbours), T2 same ID (T2r reworded), T3 scored, or the owner. */
export type ItemHow =
  | 'T1'
  | 'T1n'
  | 'T2'
  | 'T2r'
  | 'T3'
  | 'new'
  | 'retired'
  | 'unresolved'
  | 'reuse'
  | 'owner-same'
  | 'owner-new'
  | 'owner-split'
  | 'owner-merge'
  | 'owner-ok';

/** SPT §4.2 without the body and the title (those stay in the document). */
export interface ItemRecord {
  doc: string;
  kind: ItemShape;
  /** retired: not seen any more, the UID never given to another item; unresolved: provisional, a question is open. */
  state: State;
  /** Display-ID history, the last one current ('' = it has none now). */
  displayIds: Array<{ id: string; rev: string }>;
  textHash: string;
  locator: { line: number; ordinal: number; parent: string; prev?: string; next?: string };
  firstRev: string;
  lastRev: string;
  decisions: Array<Decision<ItemHow>>;
  /** Open question on a provisional record: 'item' (같은 요구?) or 'reuse' (ID가 다시 쓰였나요?), with its candidates. */
  ask?: 'item' | 'reuse';
  candidates?: Cand[];
  aliases?: string[];
  /** 나뉨: the record it was split from. */
  splitFrom?: string;
  /** '어쩌면 같은 것' (SPT §2.5): made new while this retired record scored SPEC_LADDER.maybeLow..low; until the owner answers. */
  maybe?: Cand[];
}

/**
 * SPT-P4A (§8): a component read from a document (a flowchart node, a component-table row, a
 * sequence participant of its own). Its place and a hash of its label, never the label.
 */
export interface CompRecord {
  doc: string;
  /** Its block's place among the document's Mermaid blocks and component tables (0-based). */
  block: number;
  /** A hash of the Mermaid node or participant ID, or of `#<row>` for a table row (arch.ts nodeKey): never the ID itself. */
  node: string;
  /** sha256 of its normalised label, 16 hex. */
  fp: string;
  /** retired: not seen any more (a block that comes back with the same label takes it again). */
  state: 'active' | 'retired';
  firstRev: string;
  /** When it retired (ISO): the oldest go first past SPEC_ARCH_RETIRED_PER_DOC. */
  retired?: string;
}

export interface SpecRegistry {
  v: typeof SPEC_VERSION;
  projectId: string;
  /** Bumped on every save; `specChanged` carries it. */
  rev: number;
  enabled: boolean;
  /** Extra display-ID patterns for this project (core/src/agent-tycoon/spec/ids.ts checks them). */
  idPatterns: string[];
  shortIds: boolean;
  /**
   * SPT §2.8, a re-registration's evidence (1d): HEAD's first-parent root and every root, the
   * remotes (normalised, no credentials), the last HEAD and folder. None of it for a folder that
   * is no repository.
   */
  repo: { lastHead: string | null; branch: string | null; lastPath: string; lastSeenAt: string; firstParentRoot?: string; roots?: string[]; remotes?: string[] };
  /** The project's name when last saved: a label 이어받기 shows, never a key. */
  name?: string;
  /** 새로 시작: the orphaned Registries (projectIds) the owner said this project is not. */
  dismissed?: string[];
  docs: Record<string, DocRecord>;
  items: Record<string, ItemRecord>;
  /** SPT-P4A: the components read from the documents, by `c_` UID. */
  components: Record<string, CompRecord>;
  /** Documents the 켜기 window left unticked in a folder it tracks: never tracked by themselves. */
  declined?: string[];
}

export const createDocUid = (): string => opaqueId('d');
export const createItemUid = (): string => opaqueId('r');
export const createCompUid = (): string => opaqueId('c');
/** An item's display ID now, '' for none. */
export const currentId = (r: ItemRecord): string => r.displayIds.at(-1)?.id ?? '';

export const specDirectory = (home: string, projectId: string): string => path.join(configDirectory(home), 'spec', projectId);
export const registryFile = (home: string, projectId: string): string => path.join(specDirectory(home, projectId), 'registry.json');

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function validDoc(d: unknown): d is DocRecord {
  return (
    isObject(d) &&
    typeof d.path === 'string' &&
    (DOC_KINDS as readonly unknown[]).includes(d.kind) &&
    (DOC_MODES as readonly unknown[]).includes(d.mode) &&
    (GIT_STATES as readonly unknown[]).includes(d.git) &&
    STATES.includes(d.state) &&
    typeof d.tracked === 'boolean' &&
    typeof d.blob === 'string' &&
    Array.isArray(d.pathHistory) &&
    Array.isArray(d.decisions)
  );
}

function validItem(r: unknown): r is ItemRecord {
  return (
    isObject(r) &&
    typeof r.doc === 'string' &&
    (ITEM_SHAPES as readonly unknown[]).includes(r.kind) &&
    STATES.includes(r.state) &&
    Array.isArray(r.displayIds) &&
    typeof r.textHash === 'string' &&
    isObject(r.locator) &&
    Array.isArray(r.decisions)
  );
}

export type Loaded = { registry: SpecRegistry | null; corrupt: string | null };

/** The project's Registry; null when there is none yet; corrupt (why) when it cannot be read as one. */
export function readRegistry(file: string, projectId: string): Loaded {
  let raw: unknown;
  try {
    raw = readJson(file);
  } catch (err) {
    return { registry: null, corrupt: err instanceof Error ? err.message : String(err) };
  }
  if (raw === null) return { registry: null, corrupt: null };
  if (!isObject(raw) || !READS.includes(raw.v)) return { registry: null, corrupt: `not a v${SPEC_VERSION} spec registry` };
  if (raw.projectId !== projectId || !isObject(raw.docs) || typeof raw.enabled !== 'boolean' || !isObject(raw.repo))
    return { registry: null, corrupt: 'not this project’s spec registry' };
  for (const [uid, d] of Object.entries(raw.docs))
    if (!DOC_UID_RE.test(uid) || !validDoc(d)) return { registry: null, corrupt: `a bad document record (${uid.slice(0, 20)})` };
  raw.items ??= {}; // a 1a Registry: no items yet
  if (!isObject(raw.items)) return { registry: null, corrupt: 'not this project’s spec registry' };
  for (const [uid, r] of Object.entries(raw.items))
    if (!ITEM_UID_RE.test(uid) || !validItem(r)) return { registry: null, corrupt: `a bad item record (${uid.slice(0, 20)})` };
  tidy(raw);
  raw.v = SPEC_VERSION; // written as v2 from the next save
  return { registry: raw as unknown as SpecRegistry, corrupt: null };
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
/** Cand[] as written: anything else is dropped. */
const cands = (v: unknown): boolean =>
  Array.isArray(v) && v.every((c) => isObject(c) && typeof c.uid === 'string' && typeof c.score === 'number' && strings(c.why));

/**
 * The 1d fields (re-registration evidence, the label, 새로 시작, '어쩌면 같은 것') are optional
 * extras: a value of the wrong shape is dropped, never trusted and never a reason to refuse the
 * Registry (a hand edit or a bad restore must not make the 개요 card throw).
 */
function tidy(raw: Record<string, unknown>): void {
  const repo = raw.repo as Record<string, unknown>;
  for (const k of ['roots', 'remotes']) if (repo[k] !== undefined && !strings(repo[k])) delete repo[k];
  if (repo.firstParentRoot !== undefined && typeof repo.firstParentRoot !== 'string') delete repo.firstParentRoot;
  if (repo.lastHead !== null && typeof repo.lastHead !== 'string') repo.lastHead = null;
  if (repo.branch !== null && typeof repo.branch !== 'string') repo.branch = null;
  if (typeof repo.lastPath !== 'string') repo.lastPath = '';
  if (typeof repo.lastSeenAt !== 'string') repo.lastSeenAt = '';
  if (raw.name !== undefined && typeof raw.name !== 'string') delete raw.name;
  if (raw.dismissed !== undefined)
    if (Array.isArray(raw.dismissed)) raw.dismissed = raw.dismissed.filter((x) => typeof x === 'string' && PROJECT_ID_RE.test(x));
    else delete raw.dismissed;
  for (const r of Object.values(raw.items as Record<string, Record<string, unknown>>)) if (r.maybe !== undefined && !cands(r.maybe)) delete r.maybe;
  // Components are read again from the documents: a bad record is dropped (that component gets a new UID), never a reason to refuse.
  if (!isObject(raw.components)) raw.components = {};
  const comps = raw.components as Record<string, unknown>;
  for (const [uid, c] of Object.entries(comps)) if (!COMP_UID_RE.test(uid) || !validComp(c)) delete comps[uid];
}

const validComp = (c: unknown): c is CompRecord =>
  isObject(c) &&
  typeof c.doc === 'string' &&
  Number.isInteger(c.block) &&
  typeof c.node === 'string' &&
  HASH16.test(c.node) &&
  typeof c.fp === 'string' &&
  HASH16.test(c.fp) &&
  (c.retired === undefined || typeof c.retired === 'string') &&
  (c.state === 'active' || c.state === 'retired') &&
  typeof c.firstRev === 'string';

/** Write it (0600 via tmp + rename) with its folders 0700, also when they already existed. */
export function writeRegistry(file: string, registry: SpecRegistry): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(dir), 0o700);
  fs.chmodSync(dir, 0o700);
  writeJsonAtomic(file, registry, 0); // one line: 0.53 MB, not 0.85, for this repository's 1,326 items
}

export const emptyRegistry = (projectId: string, folder: string, now: Date): SpecRegistry => ({
  v: SPEC_VERSION,
  projectId,
  rev: 0,
  enabled: false,
  idPatterns: [],
  shortIds: false,
  repo: { lastHead: null, branch: null, lastPath: folder, lastSeenAt: now.toISOString() },
  docs: {},
  items: {},
  components: {},
});

/**
 * SPT-P1A/P1B/P1C: spec tracking's daemon side, slices 1a (document UIDs), 1b (items, the
 * duplicate-ID and 새 문서 alerts) and 1c (the full identity ladder over the whole project, the match
 * cache, 같은 항목 확인, 최근 판정 with 나누기/합치기, 확인 권장). Everything runs on a request:
 * no timer, no watcher. A project with tracking off is never scanned (its 개요 card counts names
 * only); one with tracking on is scanned when one of its spec routes is read, at most every
 * SPEC_SCAN_MIN_MS. A scan reads the tracked documents as the working tree has them (a file
 * changed in the last SPEC_SETTLE_MS waits for the next one), takes git's word as evidence only,
 * and writes nothing but the project's own Registry and match cache. No LLM, no agent, no repository write.
 * Item titles are never stored: the scan that reads a document keeps its items' masked titles in
 * memory for the list (gone when tracking goes off or the daemon stops; read again on the next scan).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  type Acceptance,
  ARCH_KINDS,
  type ArchKind,
  type ArchSkeletonAction,
  type LinkRel,
  type MapStructure,
  type NodeRef,
  TASK_SPEC_ID,
  type TraceArch,
  type TraceGraph,
  type TraceItem,
  type TraceMap,
  type TraceNodeType,
  type TracePick,
  type TraceRecent,
  type TraceResume,
  type TraceState,
  type TraceTaskReqs,
} from '../../../../core/src/cld/spec/trace.js';
import type { RepoMerge, SpecChanged } from '../../../../core/src/messages.js';
import {
  SPEC_ACCEPT_RECORDS_MAX,
  SPEC_ARCH_APPROVALS_MAX,
  SPEC_ARCH_HISTORY_MAX,
  SPEC_ARCH_PROJECT_COMPS_MAX,
  SPEC_ARCH_SKELETON_MAX,
  SPEC_CRITERIA_MAX,
  SPEC_DECISIONS_MAX,
  SPEC_DECISIONS_PAGE,
  SPEC_DECISIONS_PAGE_MAX,
  SPEC_ENABLE_DOCS_MAX,
  SPEC_FILE_MAX_BYTES,
  SPEC_FOLLOW_UP_MARGIN_MS,
  SPEC_FOLLOW_UP_READ_MS,
  SPEC_GIT_MAX_BYTES,
  SPEC_HEADING_DEPTH,
  SPEC_HEADING_DEPTH_MAX,
  SPEC_INHERIT_DOC_SHARE,
  SPEC_ITEM_TITLE_MAX,
  SPEC_ITEMS_PAGE,
  SPEC_ITEMS_PAGE_MAX,
  SPEC_KIT_CONSTITUTION,
  SPEC_LADDER,
  SPEC_LINK_BULK_MAX,
  SPEC_LINK_HISTORY_MAX,
  SPEC_LINK_NOTE_MAX,
  SPEC_LINK_TEXT_WORDS_MAX,
  SPEC_MAP_FEATURE_REQS_MAX,
  SPEC_MAP_IN_DEPTH_MAX,
  SPEC_MAP_MIN_MS,
  SPEC_MAP_PATHS_ON,
  SPEC_MAP_RECENT_MS,
  SPEC_MERGE_TARGETS_MAX,
  SPEC_MOVE_CANDIDATES_MAX,
  SPEC_PATH_HISTORY_MAX,
  SPEC_PATH_MAX,
  SPEC_QUERY_MAX,
  SPEC_QUESTION_TEXT_MAX,
  SPEC_RECENT_COMMITS,
  SPEC_RECENT_JOBS,
  SPEC_RECENT_MERGES,
  SPEC_REPEATER_SHARE,
  SPEC_SCAN_MIN_MS,
  SPEC_SETTLE_MS,
  SPEC_TITLE_MAX,
  SPEC_TRACE_COMMITS_MAX,
  SPEC_TRACE_DEPTH_MAX,
  SPEC_TRACE_IDLE_MS,
  SPEC_TRACE_PICK_COMMITS,
  SPEC_TRACE_PICK_JOBS,
  SPEC_TRACE_PICK_MAX,
} from '../../constants.js';
import { configDirectory } from '../configPath.js';
import { createGitRunner, type GitRunner, READ_ENV } from '../engine/git/gitRun.js';
import { PROJECT_ID_RE } from '../engine/registry.js';
import { relativeInside } from '../files/roots.js';
import { forbiddenFilePath } from '../files/security.js';
import { maskText } from '../mask.js';
import { idsOf } from '../tracking/docs.js';
import { ACCEPTANCE_STATES, type AcceptanceFile, acceptanceFile, type AcceptanceRecord, acceptanceWeek, type LoadedAcceptance, readAcceptance, writeAcceptance } from './acceptance.js';
import { archGraph, type DocArch, matchComponents, readArch, tooBigArch } from './arch.js';
import {
  aliasRoot,
  applyOwner,
  type ArchApproval,
  type ArchFile,
  archFile,
  archFits,
  type ArchFolder,
  BATCH_ID_RE,
  createBatchId,
  createRelId,
  foldersOf,
  knownComps,
  lastBatch,
  type LoadedArch,
  type OwnerComp,
  type OwnerRel,
  ownUid,
  readArchFile,
  REL_ID_RE,
  replacedBy,
  SKELETON_ACTIONS,
  type SkeletonDecision,
  versionsByDoc,
  walkFiles,
  writeArchFile,
} from './archOwner.js';
import { cacheFile, deleteCache, emptyCache, entryOf, hasherFor, type MatchCache, matOf, readCache, withoutText, writeCache } from './cache.js';
import { blockDetail, type ChainReq, featureChain, filesOn, lightCells, linkedCount, reqLinks, tagOnly } from './chain.js';
import { type ModRow, moduleRows, type TraceComp, wordsOf } from './compLinks.js';
import { designMap,type DesignModuleIn } from './design.js';
import {
  blobOf,
  classify,
  DOC_KINDS,
  type DocKind,
  type GitState,
  type GitView,
  headOf,
  preselected,
  readGitView,
  readRecentCommits,
  walkDocs,
} from './discover.js';
import { criteriaOf, extract, type Extracted, fmIdOf, type ItemShape, itemSource, refRows, verifyOf } from './extract.js';
import { isAncestor, readRenames, readRepoEvidence, type RepoEvidence } from './gitEvidence.js';
import { type Hasher, type Mat, matchSnapshot, sketchOf, type SnapDoc } from './identity.js';
import {
  createLinkId,
  END_OF,
  EVIDENCE_KINDS,
  LINK_ID_RE,
  LINK_RELS,
  type LinkAction,
  type LinkBy,
  type LinkFile,
  linkKey,
  linksFile,
  type LoadedLinks,
  readLinks,
  refId,
  type SpecLink,
  writeLinks,
} from './links.js';
import { codeKey, type CodeScan } from './mapWorker.js';
import { adrStatus, openspecOps, shapeOf, shapeOpt } from './shapes.js';
import { kitId, kitOf, kitOpt, readPlan, readResearch, readSpec, readTasks, STORY_ID } from './speckit.js';
import { codeIndex, kitBlock, kitCounts, type KitReads, storyTasks } from './speckitMap.js';
import {
  type Cand,
  COMP_UID_RE,
  createCompUid,
  createDocUid,
  createItemUid,
  currentId,
  DOC_MODES,
  DOC_UID_RE,
  type DocMode,
  type DocRecord,
  emptyRegistry,
  ITEM_UID_RE,
  type ItemHow,
  type ItemRecord,
  type Loaded,
  readRegistry,
  registryFile,
  specDirectory,
  type SpecRegistry,
  writeRegistry,
} from './store.js';
import { type Feature, type FeatureReq, featuresOf, structureOwned } from './structure.js';
import {
  ACCEPTANCE_FILTERS,
  type AcceptanceFilter,
  acceptanceIs,
  buildIndex,
  type CommitState,
  compReqs,
  deployReported,
  groupGraph,
  itemDetail,
  type ItemText,
  neighbourhood,
  overview,
  overviewCounts,
  type RefRow,
  reqsOf,
  SHOW_FILTERS,
  shows,
  taskRequirements,
  type TraceCommit,
  type TraceIndex,
  type TraceJob,
  type TraceTask,
} from './trace.js';

export interface SpecProject {
  name: string;
  /** Absolute. */
  folder: string;
  /** The engine's projectId: the Registry's key (a rename keeps it). */
  projectId: string;
}

export interface SpecDeps {
  home: string;
  projects: () => SpecProject[];
  broadcast: (msg: SpecChanged) => void;
  /** Default: the guarded runner (no hooks, fsmonitor, filters or transport). */
  run?: GitRunner;
  now?: () => number;
  /** The settle window's follow-up scan (default: an unref'd setTimeout). */
  later?: (fn: () => void, ms: number) => void;
  /** SPT-P2: the trace index's idle drop (default: an unref'd setTimeout). */
  idle?: (fn: () => void, ms: number) => void;
  /** SPT-P2: the Task Board's tasks (every project's; the trace keeps this project's). */
  tasks?: () => Array<TraceTask & { project: string }>;
  /** SPT-P2: the job records (every project's; the trace keeps this project's). */
  jobs?: () => Array<TraceJob & { project: string | null; kind?: string }>;
  /** SPT-P3-OVERVIEW: the project's last `n` merge records (merge-history.json), newest first. */
  merges?: (project: string, n: number) => RepoMerge[];
  /** SPT C1: the 지도's code scan, a short child process (the office: `cld-worker.js spec-map`); none: no structure. */
  specMap?: (folder: string) => Promise<CodeScan | null>;
  /** BRN K5: the project's Lead's latest renew handoff (the office: agentQueries.resumeHandoff), read
   *  on a 개요 read only; none: no handoff is shown. */
  resume?: (project: string) => TraceResume['handoff'];
  /** RQ3: a new issue on the Task Board (the board's own add, as its 새 이슈); none: no issue is made. */
  addTask?: (fields: { project: string; title: string; note?: string; owner?: string }, device: string) => { ok: true; id: string } | { ok: false };
}

export type SpecError = 'corrupt' | 'path' | 'tooMany' | 'off' | 'doc' | 'item' | 'stale' | 'value' | 'save' | 'boundary' | 'link' | 'full' | 'comp' | 'archFull';
export type SpecResult<T> = { ok: true; value: T } | { ok: false; error: SpecError };

export interface Candidate {
  path: string;
  kind: DocKind;
  git: GitState;
  size: number;
  changedAt: string;
  preselect: boolean;
  /** Its UID when the Registry already has it (tracking was on before). */
  uid?: string;
}

export interface DocRow {
  uid: string;
  path: string;
  kind: DocKind;
  mode: DocMode;
  tracked: boolean;
  state: DocRecord['state'];
  git: GitState;
  changedAt: string;
  /** For the file viewer's line (bytes, last modified), as last read. */
  size: number;
  mtimeMs: number;
  depth: number;
  /** '새 문서': it was tracked by itself (found in a tracked folder). */
  fresh: boolean;
  /** 민감: the match cache keeps no text of it. */
  sensitive: boolean;
  /** Its items there (active and provisional). */
  items: number;
}

export interface ItemRow {
  uid: string;
  displayId?: string;
  /** The current text of the document, masked and cut; '' for a retired item (it is no longer there). */
  title: string;
  /** The heading it sits under, the same way ('문서 · 절' when it has no display ID). */
  section: string;
  doc: string;
  docUid: string;
  /** Its document's kind (the 요구사항 tab's 종류). */
  kind: DocKind;
  shape: ItemShape;
  state: ItemRecord['state'];
  line: number;
  /** SPT-P2: its four states (`state` above is the item's own active/retired). */
  trace?: TraceState;
  /** RQ2: the feature it falls in (featuresOf; requirements documents only), for the 요구사항 tree. */
  feature?: { key: string; name: string; rule: Feature['rule'] | 'common'; changing?: true };
}

type DocRef = { uid: string; path: string };
/**
 * SPT §2.7's non-blocking alerts: display IDs defined in more than one place, one alert per set of
 * documents (traceability.md repeating 302 IDs of SRS.md is one line, not 302), the document that
 * looks like the repeating table as `repeater` (it may become 참조만 하는 표); a document tracked by itself.
 */
export type SpecAlert =
  | { type: 'duplicateIds'; docs: DocRef[]; repeater?: DocRef; count: number; ids: string[]; places: Array<{ uid: string; doc: string; line: number }> }
  | { type: 'newDoc'; uid: string; path: string }
  /** SPT-P1D: retired UIDs a scan took again (one alert, the first places listed). */
  | { type: 'revived'; count: number; places: Place[] }
  /** SPT-P1D '어쩌면 같은 것': a new item and the retired one that scored SPEC_LADDER.maybeLow..low. */
  | ({ type: 'maybeSame'; cand: Place & { score: number } } & Place);
type Place = { uid: string; displayId?: string; doc: string; line: number };

/** One candidate as 같은 항목 확인 shows it: where it was, its masked old text (none for a sensitive document). */
export interface QuestionCand extends Cand {
  displayId?: string;
  doc: string;
  line?: number;
  state: string;
  text?: string;
}
export type Question =
  | { kind: 'item' | 'reuse'; uid: string; displayId?: string; title: string; doc: string; docUid: string; line: number; text?: string; cands: QuestionCand[] }
  | { kind: 'doc'; uid: string; doc: string; items: number; cands: QuestionCand[] };
export interface ReviewRow {
  uid: string;
  displayId?: string;
  title: string;
  doc: string;
  line: number;
  score: number;
}
export interface DecisionRow {
  uid: string;
  how: ItemHow;
  score?: number;
  by: 'engine' | 'owner';
  at: string;
  displayId?: string;
  title: string;
  doc: string;
  line: number;
  state: ItemRecord['state'];
  canSplit: boolean;
  /** 합치기: the retired items it may be (the same document first). */
  mergeInto?: Array<{ uid: string; displayId?: string; doc: string; line: number }>;
}

export interface ItemQuery {
  kind?: unknown;
  doc?: unknown;
  q?: unknown;
  state?: unknown;
  limit?: unknown;
  offset?: unknown;
  /** SPT-P3-OVERVIEW: one of SHOW_FILTERS (a 개요 number's list). */
  show?: unknown;
  /** SPT-P3-ACCEPT: 수용▾, one of ACCEPTANCE_FILTERS; combines with `show`. */
  acceptance?: unknown;
}

/** One document's items as last read: their masked titles and sections and the IDs they name, by UID; a 참조만 하는 표's rows (memory only). */
/** SPT-P4A `arch`: the document's architecture as last read (masked), with its components' UIDs. */
/** SPT-P4C `held`: the last label and line of a component in a block (or a document) refused now, its record kept active. */
type Titles = { key: string; byUid: Map<string, ItemText>; rows?: RefRow[]; arch?: { arch: DocArch; uids: string[] }; mods?: ModRow[]; held?: Array<{ uid: string; label: string; line: number }> };

/** SPT §2.8: an orphaned Registry (its project removed without 데이터까지 지우기) this project may be. Offered, never applied by itself. */
export interface InheritOffer {
  /** The orphan's projectId. */
  from: string;
  /** Its project's name when last saved ('' when it never said). */
  name: string;
  items: number;
  docs: number;
  lastSeenAt: string;
  /** samePath: this very folder; moved: its old folder is gone; remote: a remote in common; history: its last HEAD is in this one's history (a clone or a fork may be); docs: no repository, documents unchanged here. */
  why: 'samePath' | 'moved' | 'remote' | 'history' | 'docs';
  /** docs: the share of its documents found here unchanged. */
  share?: number;
}

export interface GitSummary {
  branch: string | null;
  head: string | null;
  recent: Array<{ sha: string; subject: string; time: string }>;
}

const MD = /\.md$/i;
const count = <K extends string>(keys: K[]): Partial<Record<K, number>> => {
  const out: Partial<Record<K, number>> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
};
const push = <T>(list: T[], item: T, max: number) => {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
};
const shown = (s: string) => maskText(s).slice(0, SPEC_ITEM_TITLE_MAX);
/** SPT-P3-ACCEPT: the version an item's detail shows: its Registry hash and its own raw block on disk (itemSource), as one short token (an edit elsewhere in the document leaves it). */
const versionOf = (textHash: string, block: string) => crypto.createHash('sha256').update(`${textHash}|${block}`).digest('hex').slice(0, 16);
const VERSION_RE = /^[0-9a-f]{16}$/;
/** A tracked document that is there: its items count (in lists, counts and the duplicate check). */
const live = (d: DocRecord | undefined): d is DocRecord => !!d && d.tracked && d.state !== 'retired';
/** The match cache may keep this document's text (not git-ignored, not 민감). */
const textOk = (d: DocRecord | undefined) => !!d && !d.sensitive && d.git !== 'ignored';
/** K9: how each Spec Kit file of a feature folder is read, and the field of KitReads it fills. */
const KIT_PARSERS: Record<string, (text: string) => unknown> = { 'spec.md': readSpec, 'tasks.md': readTasks, 'plan.md': readPlan, 'research.md': readResearch };
const KIT_FIELDS: Record<string, keyof KitReads> = { 'spec.md': 'spec', 'tasks.md': 'tasks', 'plan.md': 'plan', 'research.md': 'research' };
/** A question's text: masked again, at most SPEC_QUESTION_TEXT_MAX bytes. */
const questionText = (s: string | undefined): string | undefined => {
  if (s === undefined) return undefined;
  const b = Buffer.from(maskText(s), 'utf-8');
  return b.length <= SPEC_QUESTION_TEXT_MAX ? b.toString('utf-8') : b.subarray(0, SPEC_QUESTION_TEXT_MAX).toString('utf-8').replace(/\uFFFD+$/, '');
};
/** Decisions 나누기 may undo: the engine (or the owner) took an older UID for what is there now. */
const SPLITTABLE: readonly ItemHow[] = ['T1', 'T1n', 'T2', 'T2r', 'T3', 'owner-same', 'owner-merge', 'owner-ok'];
const MERGEABLE: readonly ItemHow[] = ['new', 'owner-new', 'owner-split'];
const NAME_REPEATS = /trace|matrix|coverage|index|추적/i;
const intIn = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === 'string' && /^\d{1,6}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** What a document's items are taken from: its bytes and the switches that change extraction. */
const itemsKey = (reg: SpecRegistry, d: Pick<DocRecord, 'blob' | 'kind' | 'mode' | 'depth' | 'path'>): string =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([d.blob, d.kind, d.mode, d.depth ?? SPEC_HEADING_DEPTH, reg.shortIds, reg.idPatterns, ...(shapeOf(d.path) ? ['rq5'] : [])]))
    .digest('hex')
    .slice(0, 16);
/** SPT-P4C `words`: what a component's label is looked for in (a document that keeps no text: its title only). */
const titleOf = (i: Extracted, ok: boolean): ItemText => ({
  title: shown(i.title),
  section: shown(i.section),
  refs: i.refs,
  words: wordsOf(`${shown(i.title)} ${ok ? i.body : ''}`, SPEC_LINK_TEXT_WORDS_MAX).join(' '),
});

/** A document's first record: read on the next scan. */
const newDoc = (rel: string, rev: string, at: string, fresh = false, kind = classify(rel)): DocRecord => ({
  path: rel,
  kind,
  mode: 'auto',
  tracked: true,
  state: 'active',
  git: 'not-git',
  blob: '',
  size: -1,
  mtimeMs: -1,
  changedAt: at,
  pathHistory: [{ path: rel, rev, how: 'new' }],
  decisions: [{ rev, how: 'new', by: 'engine', at }],
  ...(fresh && { fresh }),
});

/** The Markdown files directly in `dir` (relative, '.' for the top), regular files only, nothing protected. */
function docsIn(folder: string, dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(folder, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && MD.test(e.name))
    .map((e) => (dir === '.' ? e.name : `${dir}/${e.name}`))
    .filter((rel) => !forbiddenFilePath(rel));
}

export class SpecService {
  private readonly run: GitRunner;
  private readonly loaded = new Map<string, Loaded>();
  private readonly scannedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly gitCache = new Map<string, { at: number; summary: GitSummary }>();
  private readonly countCache = new Map<string, { at: number; n: number }>();
  /** projectId → document UID → its items' titles as last read. */
  private readonly titles = new Map<string, Map<string, Titles>>();
  /** projectId → its match cache (cache.ts), loaded on its first scan. */
  private readonly caches = new Map<string, MatchCache>();
  /** The keyed 3-gram hash, made on the first scan. */
  private hasher: Hasher | null = null;
  /** projectId → when a route last asked for its scan; projects with a follow-up scan pending. */
  private readonly readAt = new Map<string, number>();
  private readonly followUps = new Set<string>();
  /** projectId → its 이어받기 offers, read at most every SPEC_SCAN_MIN_MS. */
  private readonly offerCache = new Map<string, { at: number; offers: InheritOffer[] }>();
  /** name → projectId, as last seen live (remember()). */
  private readonly lastIds = new Map<string, string>();
  /** Full scans since start (a test sees "no reader, no scan"). */
  scans = 0;
  /** SPT-P2: projectId → its links as last read or written. */
  private readonly linkFiles = new Map<string, LoadedLinks>();
  /** SPT-P3-ACCEPT: projectId → its acceptance records as last read or written. */
  private readonly acceptFiles = new Map<string, LoadedAcceptance>();
  /** projectId → its trace index (memory only, dropped SPEC_TRACE_IDLE_MS after its last read). */
  private readonly traces = new Map<string, { key: string; at: number; ix: TraceIndex; print: string }>();
  private readonly traceReadAt = new Map<string, number>();
  private readonly idleTimers = new Set<string>();
  /** projectId → HEAD's first-parent commits as read for that HEAD; confirmed commits outside them, checked once per HEAD. */
  private readonly commitCache = new Map<string, { head: string; commits: TraceCommit[] }>();
  private readonly shaCache = new Map<string, { key: string; known: Map<string, CommitState> }>();
  /** projectId → the Tasks' and jobs' print the held index was built from; bumped when a change alters it (specChanged). */
  private readonly sourceRevs = new Map<string, number>();
  /** The job records as last read (Jobs reads every record file): again after a jobs change or SPEC_TRACE_IDLE_MS. */
  private jobCache: { at: number; list: NonNullable<ReturnType<NonNullable<SpecDeps['jobs']>>> } | null = null;
  /** Trace index builds and commit-log reads since start (the cost tests). */
  traceBuilds = 0;
  commitScans = 0;
  /** SPT-P3-OVERVIEW: projectId → its 최근 근거 as last built (dropped with the index); builds since start. */
  private readonly recentCache = new Map<string, { key: string; at: number; value: TraceRecent }>();
  recentBuilds = 0;
  /** SPT-P4A: projectId → its architecture as last built for that Registry rev (dropped with the index); builds since start. */
  private readonly archCache = new Map<string, { rev: number; layers: Map<string, TraceArch> }>();
  archBuilds = 0;
  /** SPT-P4B: projectId → arch.json as last read or written; the folder skeleton as last listed (by HEAD; a folder that is no repository, per SPEC_SCAN_MIN_MS) and listings since start. */
  private readonly archFiles = new Map<string, LoadedArch>();
  private readonly skeletons = new Map<string, { key: string; folders: ArchFolder[] }>();
  skeletonBuilds = 0;
  /**
   * SPT C1: projectId → the last code scan with its key (HEAD, code files, latest mtime), when it ran
   * and when its key was last looked at, and what it said (a change is a new structRev: specChanged).
   * Kept past the idle drop (small: paths and index pairs, no text), so an unchanged repository is
   * never scanned again. Scans in flight; scans since start (the cost tests).
   */
  private readonly codeScans = new Map<string, { key: string; scan: CodeScan | null; ranAt: number; checkedAt: number; print: string }>();
  private readonly codeRuns = new Map<string, Promise<CodeScan | null>>();
  private readonly codeWaits = new Set<string>();
  /** The spec-map child processes, one after the other over every project. */
  private mapQueue: Promise<void> = Promise.resolve();
  private readonly structRevs = new Map<string, number>();
  mapScans = 0;

  constructor(private readonly deps: SpecDeps) {
    this.run = deps.run ?? createGitRunner();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  project(name: string): SpecProject | undefined {
    return this.remember().find((p) => p.name === name);
  }

  get home(): string {
    return this.deps.home;
  }

  /**
   * The engine's projects now, their names noted with their projectIds: a remove names the
   * project after its record is gone, and its sidecar is deleted by the projectId the name had
   * while live (SPT-P1D, never by a name). Called on every route, at the office's start and
   * after every rename or remove.
   */
  remember(): SpecProject[] {
    const list = this.deps.projects();
    for (const p of list) this.lastIds.set(p.name, p.projectId);
    return list;
  }

  /** The projectIds `names` had when last seen live (a name never seen: none). */
  idsOf(names: readonly string[]): Array<{ name: string; projectId: string }> {
    return names.flatMap((name) => {
      const projectId = this.lastIds.get(name);
      return projectId ? [{ name, projectId }] : [];
    });
  }

  /** The projectIds of the engine's projects now. */
  liveIds(): Set<string> {
    return new Set(this.deps.projects().map((p) => p.projectId));
  }

  /** A project removed without the purge box: its orphaned Registry carries the name it had at the end (the 이어받기 label). */
  relabel(projectId: string, name: string): void {
    const file = registryFile(this.deps.home, projectId);
    const reg = readRegistry(file, projectId).registry;
    if (!reg || reg.name === name) return;
    reg.name = name;
    try {
      writeRegistry(file, reg);
    } catch (err) {
      console.warn(`[Agent Tycoon] spec registry ${projectId} not relabelled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A removed project: nothing of it stays in memory (its files are projectData's). */
  forget(projectId: string): void {
    for (const m of [this.loaded, this.scannedAt, this.gitCache, this.countCache, this.titles, this.caches, this.readAt, this.offerCache, this.linkFiles, this.acceptFiles, this.traces, this.commitCache, this.shaCache, this.recentCache, this.archCache, this.archFiles, this.skeletons, this.codeScans]) m.delete(projectId);
    for (const [name, id] of this.lastIds) if (id === projectId) this.lastIds.delete(name);
  }

  private load(p: SpecProject): Loaded {
    let l = this.loaded.get(p.projectId);
    if (!l) this.loaded.set(p.projectId, (l = readRegistry(registryFile(this.deps.home, p.projectId), p.projectId)));
    return l;
  }

  private save(p: SpecProject, reg: SpecRegistry): boolean {
    if (this.load(p).corrupt) return false; // never written over
    reg.rev++;
    reg.name = p.name;
    try {
      writeRegistry(registryFile(this.deps.home, p.projectId), reg);
    } catch (err) {
      reg.rev--;
      console.warn(`[Agent Tycoon] spec registry of ${p.name} not saved: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.loaded.set(p.projectId, { registry: reg, corrupt: null });
    this.deps.broadcast({ type: 'specChanged', project: p.name, rev: this.revOf(p) });
    return true;
  }

  private enabled(p: SpecProject): SpecRegistry | null {
    const l = this.load(p);
    return !l.corrupt && l.registry?.enabled ? l.registry : null;
  }

  // ── Reads ─────────────────────────────────────────────

  async summary(p: SpecProject) {
    const l = this.load(p);
    const reg = this.enabled(p);
    if (reg) await this.scanIfDue(p);
    const docs = reg ? Object.values(reg.docs).filter(live) : [];
    const items = reg ? this.liveItems(reg).map(([, r]) => reg.docs[r.doc].kind) : [];
    return {
      project: p.name,
      enabled: !!reg,
      ...(l.corrupt && { corrupt: true }),
      scanning: this.inFlight.has(p.projectId),
      rev: l.registry?.rev ?? 0,
      ...(reg
        ? {
            docs: { total: docs.length, byKind: count(docs.map((d) => d.kind)), byGit: count(docs.map((d) => d.git)) },
            items: { total: items.length, byKind: count(items) },
            ...((a) => ({ alerts: a.length, newDocs: a.filter((x) => x.type === 'newDoc').length }))(this.alerts(reg)),
            questions: this.openQuestions(reg),
            review: this.reviewRows(reg).length,
            ...(await this.traceCounts(p, reg)),
            // GAME-UI-1: 이번 주 수락, counted on each read from the records (nothing kept).
            week: acceptanceWeek(this.acceptOf(p).file.records, new Date(this.now())),
          }
        : { candidates: this.cheapCount(p), ...(await this.offersField(p)) }),
      git: await this.gitSummary(p),
    };
  }

  /** Tracking off: the spec-kind Markdown names under the folder (no stat, no read, no git), at most every SPEC_SCAN_MIN_MS. */
  private cheapCount(p: SpecProject): number {
    const c = this.countCache.get(p.projectId);
    if (c && this.now() - c.at < SPEC_SCAN_MIN_MS) return c.n;
    const n = walkDocs(p.folder, false).files.filter((f) => preselected(classify(f.path), 'committed')).length;
    this.countCache.set(p.projectId, { at: this.now(), n });
    return n;
  }

  /** Branch, HEAD and the recent commits (read again only when HEAD moved), masked subjects. */
  private async gitSummary(p: SpecProject): Promise<GitSummary> {
    const c = this.gitCache.get(p.projectId);
    if (c && this.now() - c.at < SPEC_SCAN_MIN_MS) return c.summary;
    let summary: GitSummary = { branch: null, head: null, recent: [] };
    try {
      const r = await this.run(p.folder, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], { env: READ_ENV });
      const [head, branch] = r.stdout.toString('utf-8').trim().split('\n');
      if (r.code === 0 && head) {
        const recent =
          c?.summary.head === head
            ? c.summary.recent
            : (await readRecentCommits(this.run, p.folder, SPEC_RECENT_COMMITS)).map((x) => ({
                ...x,
                subject: maskText(x.subject).slice(0, SPEC_TITLE_MAX),
              }));
        summary = { branch: branch && branch !== 'HEAD' ? branch : null, head, recent };
      }
    } catch {
      /* git missing: no commits to show */
    }
    this.gitCache.set(p.projectId, { at: this.now(), summary });
    return summary;
  }

  /** The 켜기 window's list: the working tree's documents, kinds, git states, what starts ticked. */
  async candidates(p: SpecProject): Promise<{ docs: Candidate[]; capped: boolean }> {
    const { files, capped } = walkDocs(p.folder, true);
    const view = await readGitView(this.run, p.folder);
    await view.resolve(files.map((f) => f.path));
    const byPath = new Map(Object.entries(this.load(p).registry?.docs ?? {}).map(([uid, d]) => [d.path, uid]));
    return {
      capped,
      docs: files.map((f) => {
        const kind = classify(f.path, headOf(p.folder, f.path));
        const git = view.stateOf(f.path);
        const uid = byPath.get(f.path);
        return { path: f.path, kind, git, size: f.size, changedAt: new Date(f.mtimeMs).toISOString(), preselect: preselected(kind, git), ...(uid && { uid }) };
      }),
    };
  }

  async docs(p: SpecProject): Promise<{ enabled: boolean; rev: number; docs: DocRow[]; alerts: SpecAlert[] }> {
    if (this.enabled(p)) await this.scanIfDue(p);
    const reg = this.load(p).registry;
    return {
      enabled: !!reg?.enabled,
      rev: reg?.rev ?? 0,
      docs: Object.entries(reg?.docs ?? {})
        .map(([uid, d]) => this.row(reg!, uid, d))
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
      alerts: reg?.enabled ? this.alerts(reg) : [],
    };
  }

  private row(reg: SpecRegistry, uid: string, d: DocRecord): DocRow {
    const items = Object.values(reg.items).filter((r) => r.doc === uid && r.state !== 'retired').length;
    return {
      uid,
      path: d.path,
      kind: d.kind,
      mode: d.mode,
      tracked: d.tracked,
      state: d.state,
      git: d.git,
      changedAt: d.changedAt,
      size: Math.max(d.size, 0),
      mtimeMs: Math.max(d.mtimeMs, 0),
      depth: d.depth ?? SPEC_HEADING_DEPTH,
      fresh: !!d.fresh,
      sensitive: !!d.sensitive,
      items,
    };
  }

  /** The items (active and provisional) of the tracked documents that are there. */
  private liveItems(reg: SpecRegistry): Array<[string, ItemRecord]> {
    return Object.entries(reg.items).filter(([, r]) => r.state !== 'retired' && live(reg.docs[r.doc]));
  }

  /** SPT §2.7, the non-blocking ones: display IDs defined in more than one place (grouped by documents), documents tracked by themselves. */
  private alerts(reg: SpecRegistry): SpecAlert[] {
    const byId = new Map<string, Array<[string, ItemRecord]>>();
    const idsIn = new Map<string, Set<string>>();
    for (const [uid, r] of this.liveItems(reg)) {
      const id = currentId(r);
      if (!id) continue;
      byId.set(id, [...(byId.get(id) ?? []), [uid, r]]);
      idsIn.set(r.doc, (idsIn.get(r.doc) ?? new Set()).add(id));
    }
    const groups = new Map<string, { docs: string[]; ids: string[]; places: Array<{ uid: string; doc: string; line: number }> }>();
    for (const [id, list] of byId) {
      if (list.length < 2) continue;
      const docs = [...new Set(list.map(([, r]) => r.doc))].sort();
      const key = docs.join(' ');
      const g = groups.get(key) ?? { docs, ids: [], places: [] };
      g.ids.push(id);
      g.places.push(...list.map(([uid, r]) => ({ uid, doc: reg.docs[r.doc].path, line: r.locator.line })));
      groups.set(key, g);
    }
    const ref = (u: string): DocRef => ({ uid: u, path: reg.docs[u].path });
    const out: SpecAlert[] = [];
    for (const g of groups.values()) {
      // The repeating table, when it shows: the one named like one (traceability, matrix), else the only one nearly all of whose IDs repeat.
      // ponytail: a guess offered as a button only; no clear one, no button (the owner sets 참조만 on the 문서 row).
      const named = g.docs.filter((u) => NAME_REPEATS.test(path.posix.basename(reg.docs[u].path)));
      const whole = g.docs.filter((u) => g.ids.length / (idsIn.get(u)?.size ?? 1) >= SPEC_REPEATER_SHARE);
      const repeater = g.docs.length < 2 ? undefined : named.length === 1 ? named[0] : !named.length && whole.length === 1 ? whole[0] : undefined;
      out.push({
        type: 'duplicateIds',
        docs: g.docs.filter((u) => u !== repeater).map(ref),
        ...(repeater && { repeater: ref(repeater) }),
        count: g.ids.length,
        ids: g.ids.slice(0, SPEC_MERGE_TARGETS_MAX),
        places: g.places.slice(0, SPEC_MERGE_TARGETS_MAX),
      });
    }
    out.sort((a, b) => (b.type === 'duplicateIds' ? b.count : 0) - (a.type === 'duplicateIds' ? a.count : 0));
    const place = (uid: string): Place => {
      const w = this.where(reg, uid);
      return { uid, ...(w.displayId && { displayId: w.displayId }), doc: w.doc, line: w.line };
    };
    const revived = this.revived(reg);
    if (revived.length) out.push({ type: 'revived', count: revived.length, places: revived.slice(0, SPEC_MERGE_TARGETS_MAX).map(place) });
    for (const [uid, r] of this.liveItems(reg)) {
      const c = r.maybe?.[0];
      if (r.state === 'active' && c && reg.items[c.uid]?.state === 'retired') out.push({ type: 'maybeSame', ...place(uid), cand: { ...place(c.uid), score: c.score } });
    }
    for (const [uid, d] of Object.entries(reg.docs)) if (live(d) && d.fresh) out.push({ type: 'newDoc', uid, path: d.path });
    return out;
  }

  /** Items a scan took back from retirement, not looked at since (SPT §2.7: the UID is kept, the owner is told). */
  private revived(reg: SpecRegistry): string[] {
    return this.liveItems(reg)
      .filter(([, r]) => {
        const back = r.decisions.map((d) => d.how).lastIndexOf('retired');
        return r.state === 'active' && back >= 0 && back < r.decisions.length - 1 && r.decisions.slice(back + 1).every((d) => d.by === 'engine');
      })
      .map(([uid]) => uid);
  }

  /** The 요구사항 list: the items of the tracked documents, filtered, titles from the documents as last read. */
  async items(p: SpecProject, q: ItemQuery): Promise<SpecResult<{ enabled: boolean; rev: number; total: number; items: ItemRow[] }>> {
    const kind = q.kind === undefined || q.kind === '' ? null : q.kind;
    const doc = q.doc === undefined || q.doc === '' ? null : q.doc;
    const text = q.q === undefined ? '' : q.q;
    const limit = q.limit === undefined ? SPEC_ITEMS_PAGE : intIn(q.limit, 1, SPEC_ITEMS_PAGE_MAX);
    const offset = q.offset === undefined ? 0 : intIn(q.offset, 0, Number.MAX_SAFE_INTEGER);
    if (
      (kind !== null && !(DOC_KINDS as readonly unknown[]).includes(kind)) ||
      (doc !== null && (typeof doc !== 'string' || !DOC_UID_RE.test(doc))) ||
      typeof text !== 'string' ||
      text.length > SPEC_QUERY_MAX ||
      (q.state !== undefined && q.state !== 'active' && q.state !== 'all') ||
      (q.show !== undefined && !SHOW_FILTERS.includes(q.show as string)) ||
      limit === null ||
      offset === null ||
      (q.acceptance !== undefined && q.acceptance !== '' && !(ACCEPTANCE_FILTERS as readonly unknown[]).includes(q.acceptance))
    )
      return { ok: false, error: 'value' };
    if (this.enabled(p)) await this.scanIfDue(p);
    const reg = this.enabled(p);
    if (!reg) return { ok: true, value: { enabled: false, rev: this.load(p).registry?.rev ?? 0, total: 0, items: [] } };
    const titles = this.titles.get(p.projectId);
    const needle = text.trim().toLowerCase();
    const rows: ItemRow[] = [];
    const ix = await this.index(p, reg);
    const show = q.show as string | undefined;
    const acc = (q.acceptance || undefined) as AcceptanceFilter | undefined;
    for (const [uid, r] of Object.entries(reg.items)) {
      const d = reg.docs[r.doc];
      if (!live(d) || (kind && d.kind !== kind) || (doc && r.doc !== doc) || (r.state === 'retired' && q.state !== 'all') || (show && !shows(ix, uid, show)) || (acc && !acceptanceIs(ix, uid, acc))) continue;
      const t = r.state === 'active' ? titles?.get(r.doc)?.byUid.get(uid) : undefined;
      const id = currentId(r);
      if (needle && !id.toLowerCase().includes(needle) && !t?.title.toLowerCase().includes(needle)) continue;
      rows.push({ uid, ...(id && { displayId: id }), title: t?.title ?? '', section: t?.section ?? '', doc: d.path, docUid: r.doc, kind: d.kind, shape: r.kind, state: r.state, line: r.locator.line });
    }
    rows.sort((a, b) => (a.doc !== b.doc ? (a.doc < b.doc ? -1 : 1) : a.line - b.line));
    const page = rows.slice(offset, offset + limit);
    const feat = this.featureOf(p, reg, ix);
    for (const row of page) {
      row.trace = ix.states.get(row.uid);
      const f = feat(row.uid, row.displayId);
      if (f) row.feature = f;
    }
    return { ok: true, value: { enabled: true, rev: reg.rev, total: rows.length, items: page } };
  }

  // ── Writes ────────────────────────────────────────────

  /** A document path the owner picked: relative, inside the folder through no link, Markdown, a regular file, not protected, not too big. */
  private checkDoc(p: SpecProject, rel: unknown): string | null {
    if (typeof rel !== 'string' || !rel || rel.length > SPEC_PATH_MAX || /[\0\\]/.test(rel) || path.isAbsolute(rel)) return null;
    if (rel.split('/').some((s) => s === '..' || s === '.' || s === '') || forbiddenFilePath(rel) || !MD.test(rel)) return null;
    try {
      const root = fs.realpathSync(p.folder);
      const real = fs.realpathSync(path.join(root, rel));
      const st = fs.lstatSync(real);
      if (relativeInside(root, real) !== rel || !st.isFile() || st.size > SPEC_FILE_MAX_BYTES) return null;
    } catch {
      return null;
    }
    return rel;
  }

  /** Turn tracking on with the documents the owner ticked, then scan once. UIDs a past Registry gave stay. */
  async enable(p: SpecProject, picked: unknown): Promise<SpecResult<{ docs: number; byKind: Partial<Record<DocKind, number>> }>> {
    const l = this.load(p);
    if (l.corrupt) return { ok: false, error: 'corrupt' };
    if (!Array.isArray(picked)) return { ok: false, error: 'value' };
    if (picked.length > SPEC_ENABLE_DOCS_MAX) return { ok: false, error: 'tooMany' };
    const paths = [...new Set(picked.map((x) => this.checkDoc(p, x)))];
    if (paths.includes(null)) return { ok: false, error: 'path' };
    const chosen = new Set(paths as string[]);
    const now = new Date(this.now());
    const reg = l.registry ?? emptyRegistry(p.projectId, p.folder, now);
    const byPath = new Map(Object.values(reg.docs).map((d) => [d.path, d]));
    for (const d of Object.values(reg.docs)) d.tracked = chosen.has(d.path);
    for (const rel of chosen) {
      if (byPath.has(rel)) continue; // D0: the same path keeps its UID (also after a turn off and on)
      reg.docs[createDocUid()] = newDoc(rel, reg.repo.lastHead ?? 'worktree', now.toISOString(), false, classify(rel, headOf(p.folder, rel)));
    }
    // What the window left unticked beside a ticked document is never tracked by itself later.
    const dirs = new Set([...chosen].map((rel) => path.posix.dirname(rel)));
    reg.declined = [...dirs].flatMap((dir) => docsIn(p.folder, dir)).filter((rel) => !chosen.has(rel));
    reg.enabled = true;
    if (!this.save(p, reg)) return { ok: false, error: 'save' };
    await this.scan(p, true);
    const docs = Object.values(reg.docs).filter((d) => d.tracked && d.state === 'active');
    return { ok: true, value: { docs: docs.length, byKind: count(docs.map((d) => d.kind)) } };
  }

  /** Tracking off: nothing is read from now on; the Registry stays (turning it on again keeps every UID). */
  disable(p: SpecProject): SpecResult<null> {
    const l = this.load(p);
    if (l.corrupt) return { ok: false, error: 'corrupt' };
    if (!l.registry?.enabled) return { ok: true, value: null };
    l.registry.enabled = false;
    this.titles.delete(p.projectId);
    this.traces.delete(p.projectId);
    this.archCache.delete(p.projectId);
    // SPT §4.1: the match cache goes with tracking (the Registry stays; turning it on rebuilds it).
    this.caches.delete(p.projectId);
    try {
      deleteCache(cacheFile(this.deps.home, p.projectId));
    } catch (err) {
      console.warn(`[Agent Tycoon] spec match cache of ${p.name} not deleted: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.save(p, l.registry) ? { ok: true, value: null } : { ok: false, error: 'save' };
  }

  /** The 문서 tab's switches for one document: kind, extraction mode and depth, tracked; `seen` takes its 새 문서 flag off. */
  setDoc(
    p: SpecProject,
    uid: string,
    body: { kind?: unknown; mode?: unknown; depth?: unknown; tracked?: unknown; seen?: unknown; sensitive?: unknown },
  ): SpecResult<DocRow> {
    const l = this.load(p);
    if (l.corrupt) return { ok: false, error: 'corrupt' };
    const reg = this.enabled(p);
    if (!reg) return { ok: false, error: 'off' };
    const d = reg.docs[uid];
    if (!d) return { ok: false, error: 'doc' };
    const { kind, mode, depth, tracked, seen, sensitive } = body;
    if (
      (kind !== undefined && !(DOC_KINDS as readonly unknown[]).includes(kind)) ||
      (mode !== undefined && !(DOC_MODES as readonly unknown[]).includes(mode)) ||
      (depth !== undefined && intIn(depth, 1, SPEC_HEADING_DEPTH_MAX) === null) ||
      (tracked !== undefined && typeof tracked !== 'boolean') ||
      (seen !== undefined && seen !== true) ||
      (sensitive !== undefined && typeof sensitive !== 'boolean') ||
      [kind, mode, depth, tracked, seen, sensitive].every((v) => v === undefined)
    )
      return { ok: false, error: 'value' };
    const at = new Date(this.now()).toISOString();
    const rev = reg.repo.lastHead ?? 'worktree';
    if (kind !== undefined && kind !== d.kind) push(d.decisions, { rev, how: 'kind', by: 'owner', at }, SPEC_DECISIONS_MAX);
    const deeper = depth !== undefined && depth !== (d.depth ?? SPEC_HEADING_DEPTH);
    if ((mode !== undefined && mode !== d.mode) || deeper) push(d.decisions, { rev, how: 'mode', by: 'owner', at }, SPEC_DECISIONS_MAX);
    if (tracked !== undefined && tracked !== d.tracked) push(d.decisions, { rev, how: 'tracked', by: 'owner', at }, SPEC_DECISIONS_MAX);
    if (sensitive !== undefined && sensitive !== !!d.sensitive) push(d.decisions, { rev, how: 'sensitive', by: 'owner', at }, SPEC_DECISIONS_MAX);
    if (sensitive === true) d.sensitive = true;
    else if (sensitive === false) delete d.sensitive;
    if (kind !== undefined) d.kind = kind as DocKind;
    if (mode !== undefined) d.mode = mode as DocMode;
    if (depth !== undefined) d.depth = depth as number;
    if (tracked !== undefined) d.tracked = tracked as boolean;
    delete d.fresh; // the owner has looked at it
    if (!this.save(p, reg)) return { ok: false, error: 'save' };
    if (sensitive === true) {
      this.cacheOf(p); // loaded from disk when no scan has read it yet (a restart)
      this.saveCache(p, reg); // its text leaves the match cache now, not on the next scan
    }
    // Its items follow the new switches now, not on the next interval.
    if (kind !== undefined || mode !== undefined || depth !== undefined || tracked !== undefined) void this.scan(p, true);
    return { ok: true, value: this.row(reg, uid, d) };
  }

  // ── 이어받기 (SPT §2.8) ───────────────────────────────

  private async offersField(p: SpecProject): Promise<{ inherit?: InheritOffer[] }> {
    const offers = await this.offers(p);
    return offers.length ? { inherit: offers } : {};
  }

  /** The Registries on disk whose project is gone (removed without 데이터까지 지우기). */
  private orphans(): Array<{ projectId: string; reg: SpecRegistry }> {
    const live = this.liveIds();
    let names: string[];
    try {
      names = fs.readdirSync(path.join(configDirectory(this.deps.home), 'spec'));
    } catch {
      return [];
    }
    return names
      .filter((id) => PROJECT_ID_RE.test(id) && !live.has(id))
      .flatMap((projectId) => {
        const reg = readRegistry(registryFile(this.deps.home, projectId), projectId).registry;
        return reg ? [{ projectId, reg }] : [];
      });
  }

  /**
   * The orphans this project may be, for a project with no Registry of its own yet (or only its
   * 새로 시작 answers). git: the same first-parent root and one of: the old folder is gone, a remote
   * in common, the old HEAD in this history (R2 §5). No repository: SPEC_INHERIT_DOC_SHARE of its
   * documents here unchanged. Nothing to compare (no orphan): no git, no read.
   */
  /** Data of its own that 이어받기 would replace: an enabled Registry, documents, or the owner's architecture (arch.json, even with no document: SPT-P4B). */
  private hasOwnData(p: SpecProject): boolean {
    const reg = this.load(p).registry;
    return !!reg && (reg.enabled || Object.keys(reg.docs).length > 0) ? true : fs.existsSync(archFile(this.deps.home, p.projectId));
  }

  private async offers(p: SpecProject, fresh = false): Promise<InheritOffer[]> {
    const own = this.load(p);
    if (own.corrupt || this.hasOwnData(p)) return [];
    const c = this.offerCache.get(p.projectId);
    if (!fresh && c && this.now() - c.at < SPEC_SCAN_MIN_MS) return c.offers;
    const dismissed = new Set(own.registry?.dismissed ?? []);
    const orphans = this.orphans().filter((o) => !dismissed.has(o.projectId));
    const ev = orphans.some((o) => o.reg.repo.firstParentRoot) ? await readRepoEvidence(this.run, p.folder) : null;
    const out: InheritOffer[] = [];
    for (const { projectId, reg } of orphans) {
      let m: Awaited<ReturnType<typeof this.sameProject>> = null;
      try {
        m = await this.sameProject(p, reg, ev);
      } catch (err) {
        console.warn(`[Agent Tycoon] spec inherit check of ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!m) continue;
      out.push({
        from: projectId,
        name: reg.name ?? '',
        items: Object.values(reg.items).filter((r) => r.state !== 'retired').length,
        docs: Object.values(reg.docs).filter(live).length,
        lastSeenAt: reg.repo.lastSeenAt,
        ...m,
      });
    }
    this.offerCache.set(p.projectId, { at: this.now(), offers: out });
    return out;
  }

  private async sameProject(p: SpecProject, reg: SpecRegistry, ev: RepoEvidence | null): Promise<Pick<InheritOffer, 'why' | 'share'> | null> {
    const r = reg.repo;
    const real = (f: string) => {
      try {
        return fs.realpathSync(f);
      } catch {
        return null;
      }
    };
    const here = real(p.folder);
    const there = real(r.lastPath);
    const same = !!here && here === there;
    if (r.firstParentRoot) {
      if (!ev || ev.firstParentRoot !== r.firstParentRoot) return null;
      if (!there) return { why: 'moved' };
      if (r.remotes?.some((x) => ev.remotes.includes(x))) return { why: same ? 'samePath' : 'remote' };
      if (r.lastHead && (await isAncestor(this.run, p.folder, r.lastHead))) return { why: same ? 'samePath' : 'history' };
      return null;
    }
    // ponytail: a folder that is no repository reads its matching documents (same path and size) once per SPEC_SCAN_MIN_MS while an orphan is on disk.
    const docs = Object.values(reg.docs).filter((d) => live(d) && d.blob);
    if (!docs.length) return null;
    let hit = 0;
    for (const d of docs) {
      const rel = this.checkDoc(p, d.path);
      if (!rel) continue;
      try {
        const file = path.join(p.folder, rel);
        if (fs.lstatSync(file).size === d.size && blobOf(fs.readFileSync(file)) === d.blob) hit++;
      } catch {
        /* gone meanwhile */
      }
    }
    const share = Math.round((hit / docs.length) * 100) / 100;
    return share >= SPEC_INHERIT_DOC_SHARE ? { why: same ? 'samePath' : 'docs', share } : null;
  }

  /**
   * 이어받기 (accept): the orphan's folder becomes this project's (moved, `projectId` rewritten),
   * the same UIDs; the match cache is rebuilt on the next read. 새로 시작 (dismiss): this project
   * remembers it is not that one. Only an offer that still holds; never by itself.
   */
  inherit(p: SpecProject, body: { from?: unknown; answer?: unknown }): Promise<SpecResult<{ items: number }>> {
    const { from, answer } = body;
    if (typeof from !== 'string' || !PROJECT_ID_RE.test(from) || (answer !== 'accept' && answer !== 'dismiss')) return Promise.resolve({ ok: false, error: 'value' });
    return this.queued(p, () => this.inheritNow(p, from, answer));
  }

  /** `run` after the project's scan (and any earlier queued write) is done, before the next one: the project's one queue. */
  private queued<T>(p: SpecProject, run: () => Promise<T>): Promise<T> {
    const job = (this.inFlight.get(p.projectId) ?? Promise.resolve()).then(run);
    const done = job.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.set(p.projectId, done);
    void done.then(() => {
      if (this.inFlight.get(p.projectId) === done) this.inFlight.delete(p.projectId);
    });
    return job;
  }

  private async inheritNow(p: SpecProject, from: string, answer: 'accept' | 'dismiss'): Promise<SpecResult<{ items: number }>> {
    if (this.load(p).corrupt) return { ok: false, error: 'corrupt' };
    const offer = (await this.offers(p, true)).find((o) => o.from === from);
    // After the last await: an enable that ran meanwhile made this project's own Registry: no offer any more.
    const own = this.load(p);
    if (!offer || own.corrupt || this.hasOwnData(p)) return { ok: false, error: 'stale' };
    this.offerCache.delete(p.projectId);
    if (answer === 'dismiss') {
      const reg = own.registry ?? emptyRegistry(p.projectId, p.folder, new Date(this.now()));
      reg.dismissed = [...new Set([...(reg.dismissed ?? []), from])];
      return this.save(p, reg) ? { ok: true, value: { items: 0 } } : { ok: false, error: 'save' };
    }
    const reg = readRegistry(registryFile(this.deps.home, from), from).registry;
    if (!reg) return { ok: false, error: 'stale' };
    // ponytail: the move, then the rewrite; a crash between leaves this project's Registry naming the old id: shown as corrupt, never written over.
    try {
      fs.rmSync(specDirectory(this.deps.home, p.projectId), { recursive: true, force: true }); // only 새로 시작 answers in it (offers() checked)
      fs.renameSync(specDirectory(this.deps.home, from), specDirectory(this.deps.home, p.projectId));
    } catch (err) {
      console.warn(`[Agent Tycoon] spec inherit of ${p.name}: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: 'save' };
    }
    this.forget(from);
    for (const m of [this.scannedAt, this.titles, this.caches, this.linkFiles, this.acceptFiles, this.traces, this.archCache, this.archFiles, this.skeletons, this.codeScans]) m.delete(p.projectId);
    reg.projectId = p.projectId;
    reg.repo.lastPath = p.folder;
    delete reg.dismissed;
    this.loaded.set(p.projectId, { registry: reg, corrupt: null });
    return this.save(p, reg) ? { ok: true, value: { items: offer.items } } : { ok: false, error: 'save' };
  }

  // ── The scan ──────────────────────────────────────────

  private scanIfDue(p: SpecProject): Promise<void> {
    this.readAt.set(p.projectId, this.now());
    const last = this.scannedAt.get(p.projectId);
    if (last !== undefined && this.now() - last < SPEC_SCAN_MIN_MS) return this.inFlight.get(p.projectId) ?? Promise.resolve();
    // SPT C1: a scan while the 지도 is read (its index held, a code scan kept) looks at the code key too.
    const reg = this.traceReadAt.has(p.projectId) && this.codeScans.has(p.projectId) ? this.enabled(p) : null;
    return this.scan(p, false).then(() => void (reg && this.codeScan(p, reg).catch(() => undefined)));
  }

  /** One scan of a project with tracking on (one at a time per project). */
  private scan(p: SpecProject, force: boolean): Promise<void> {
    const running = this.inFlight.get(p.projectId);
    if (running && !force) return running;
    const job = (running ?? Promise.resolve())
      .then(() => this.scanNow(p))
      .catch((err) => console.warn(`[Agent Tycoon] spec scan of ${p.name}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        if (this.inFlight.get(p.projectId) === job) this.inFlight.delete(p.projectId);
      });
    this.inFlight.set(p.projectId, job);
    this.scannedAt.set(p.projectId, this.now());
    return job;
  }


  /** The project's match cache; a missing or unreadable one starts empty and every document is read again to rebuild it. */
  private hash(): Hasher {
    return (this.hasher ??= hasherFor(this.deps.home));
  }

  private cacheOf(p: SpecProject): MatchCache {
    let c = this.caches.get(p.projectId);
    if (!c) {
      // Missing, unreadable, or made under another key: the hashes in it are unusable; this scan matches by path, ID and text hash, and rebuilds it.
      c = readCache(cacheFile(this.deps.home, p.projectId), this.hash().kid) ?? undefined;
      if (!c) {
        c = emptyCache(this.hash().kid);
        this.titles.delete(p.projectId);
      }
      this.caches.set(p.projectId, c);
    }
    return c;
  }

  /** SPT §4.1 on what the cache holds: no text of an ignored or 민감 document, nothing of a record that is gone. True when it changed. */
  private enforce(reg: SpecRegistry, c: MatchCache): boolean {
    let changed = false;
    for (const [u, e] of Object.entries(c.items)) {
      const r = reg.items[u];
      if (!r) delete c.items[u];
      else if (e.b !== undefined && !textOk(reg.docs[r.doc])) c.items[u] = withoutText(this.hash(), e, currentId(r));
      else continue;
      changed = true;
    }
    for (const u of Object.keys(c.docs))
      if (!reg.docs[u]) {
        delete c.docs[u];
        changed = true;
      }
    return changed;
  }

  private saveCache(p: SpecProject, reg: SpecRegistry): void {
    const c = this.caches.get(p.projectId);
    if (!c || !reg.enabled) return;
    this.enforce(reg, c);
    try {
      writeCache(cacheFile(this.deps.home, p.projectId), c);
    } catch (err) {
      console.warn(`[Agent Tycoon] spec match cache of ${p.name} not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private readDoc(p: SpecProject, rel: string, st: fs.Stats): { text: string; blob: string; size: number; mtimeMs: number } | null {
    try {
      const bytes = fs.readFileSync(path.join(p.folder, rel));
      return { text: bytes.toString('utf-8'), blob: blobOf(bytes), size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }

  private async scanNow(p: SpecProject): Promise<void> {
    if (!this.enabled(p)) return;
    this.scans++;
    const view: GitView = await readGitView(this.run, p.folder);
    await view.resolve(Object.values(this.load(p).registry?.docs ?? {}).filter((d) => d.tracked).map((d) => d.path));
    const reg = this.enabled(p); // the same object, unless tracking went off meanwhile
    if (!reg) return;
    // SPT §2.8: the re-registration evidence, read again when HEAD moved (or never read yet).
    if (view.repo && view.head && (view.head !== reg.repo.lastHead || !reg.repo.roots)) {
      const ev = await readRepoEvidence(this.run, p.folder);
      if (ev) Object.assign(reg.repo, ev);
    }
    const state = () => JSON.stringify([reg.docs, reg.items, reg.components, reg.repo.lastHead, reg.repo.branch, reg.repo.firstParentRoot, reg.repo.roots, reg.repo.remotes]);
    const before = state();
    const now = this.now();
    const at = new Date(now).toISOString();
    const rev = view.head ?? 'worktree';
    const cache = this.cacheOf(p);
    let titles = this.titles.get(p.projectId);
    if (!titles) this.titles.set(p.projectId, (titles = new Map()));
    /** SPT-P4C: each document's architecture as last read (a re-read replaces its titles). */
    const archBefore = new Map([...titles].map(([u, t]) => [u, { arch: t.arch, held: t.held }]));
    const optsOf = (d: Pick<DocRecord, 'kind' | 'mode' | 'depth' | 'path'>) => ({ kind: d.kind, mode: d.mode, depth: d.depth ?? SPEC_HEADING_DEPTH, shortIds: reg.shortIds, idPatterns: reg.idPatterns, ...kitOpt(d.path), ...shapeOpt(d.path) });
    const settled = (st: fs.Stats) => st.size <= SPEC_FILE_MAX_BYTES && now - st.mtimeMs >= SPEC_SETTLE_MS;
    const lstat = (rel: string) => {
      try {
        const st = fs.lstatSync(path.join(p.folder, rel));
        return st.isFile() ? st : null;
      } catch {
        return null;
      }
    };

    // ── The snapshot: every tracked document there, read when its bytes or switches changed ──
    const snap: SnapDoc[] = [];
    type Read = { blob: string; size: number; mtimeMs: number; git: GitState; key: string };
    const reads = new Map<string, Read>();
    const byPlace: Array<{ uid: string; items: Extracted[]; uids: string[]; text: string }> = [];
    /** A 참조만 하는 표's rows, by path, as read now. */
    const rowsOf = new Map<string, RefRow[]>();
    /** SPT-P4A: each document's architecture, by path, as read now. */
    const archOf = new Map<string, DocArch>();
    /** SPT-P4C: each document's module rows, by path, as read now. */
    const modsOf = new Map<string, ModRow[]>();
    const missing: string[] = [];
    const h = this.hash();
    /** When the last file being written settles (0: none), for the follow-up scan. */
    let settleAt = 0;
    for (const [uid, d] of Object.entries(reg.docs)) {
      if (!d.tracked) continue;
      const st = lstat(d.path);
      if (!st) {
        if (d.state !== 'retired') missing.push(d.path);
        continue;
      }
      d.git = view.stateOf(d.path);
      const same = d.blob && st.mtimeMs === d.mtimeMs && st.size === d.size && d.state !== 'retired';
      if (!settled(st)) settleAt = Math.max(settleAt, st.mtimeMs + SPEC_SETTLE_MS);
      const r = !settled(st) || (same && titles.get(uid)?.key === itemsKey(reg, d)) ? null : this.readDoc(p, d.path, st);
      if (!r) {
        snap.push({ path: d.path, items: null }); // as last matched (or being written: the next scan reads it)
        continue;
      }
      const first = !d.blob;
      const items = extract(r.text, path.posix.basename(d.path), optsOf(d));
      archOf.set(d.path, readArch(r.text));
      if (d.mode === 'refs') rowsOf.set(d.path, refRows(r.text, path.posix.basename(d.path), optsOf(d)).map((x) => ({ ...x, path: d.path })));
      // A document that keeps no text (민감, git-ignored) sends no path of its as a reason.
      if (d.mode !== 'off' && textOk(d)) modsOf.set(d.path, moduleRows(r.text, path.posix.basename(d.path), optsOf(d)).map((x) => ({ ...x, path: d.path, ...(d.mode === 'refs' && { refs: true as const }) })));
      const key = itemsKey(reg, { ...d, blob: r.blob });
      reads.set(d.path, { ...r, git: d.git, key });
      const mine = Object.entries(reg.items)
        .filter(([, x]) => x.doc === uid && x.state !== 'retired')
        .sort(([, a], [, b]) => a.locator.ordinal - b.locator.ordinal)
        .map(([u]) => u);
      // The same bytes and switches as last matched (a restart): its records by place, no matching.
      if (d.itemsKey === key && mine.length === items.length && d.state !== 'retired') {
        snap.push({ path: d.path, items: null });
        byPlace.push({ uid, items, uids: mine, text: r.text });
      } else snap.push({ path: d.path, fmId: fmIdOf(r.text), sketch: sketchOf(r.text, h), items, ...(first && { first }) });
    }

    // ── Where else to look: new files beside tracked ones (새 문서), and for a missing document git's renames, else the tree ──
    const known = new Set([...Object.values(reg.docs).map((d) => d.path), ...(reg.declined ?? [])]);
    const fresh = this.freshPaths(p, reg, view, known);
    let renames: Map<string, string> | null = null;
    const extra = fresh.map((rel) => ({ rel, fresh: true }));
    /** The kinds of the documents read only as new places (their front matter counts). */
    const kinds = new Map<string, DocKind>();
    if (missing.length || fresh.length) {
      renames = (await readRenames(this.run, p.folder, reg.repo.lastHead, view)).renames;
      if (missing.length) {
        const taken = new Set([...known, ...fresh]);
        const viaGit = [...(renames ?? [])].filter(([n, o]) => missing.includes(o) && !taken.has(n) && this.checkDoc(p, n)).map(([n]) => n);
        const explained = new Set(renames?.values() ?? []);
        let moved = viaGit;
        if (missing.some((m) => !explained.has(m))) {
          // ponytail: at most SPEC_MOVE_CANDIDATES_MAX files read per scan, same names first; a bigger tree may miss a moved document (it retires, and comes back when it is beside tracked ones).
          const names = new Set(missing.map((m) => path.posix.basename(m)));
          const walked = walkDocs(p.folder, true).files.map((f) => f.path).filter((rel) => !taken.has(rel) && !viaGit.includes(rel));
          walked.sort((a, b) => Number(names.has(path.posix.basename(b))) - Number(names.has(path.posix.basename(a))));
          moved = [...viaGit, ...walked].slice(0, SPEC_MOVE_CANDIDATES_MAX);
        }
        extra.push(...moved.map((rel) => ({ rel, fresh: false })));
      }
    }
    await view.resolve(extra.map((x) => x.rel));
    for (const { rel, fresh: isFresh } of extra) {
      const st = lstat(rel);
      if (!st) continue;
      // A missing document's new place still being written: match next time, not retire it now.
      if (!settled(st)) {
        // Matched next time, not retired now; HEAD stays where the last full scan saw it (its renames are still to read).
        this.followUp(p, st.mtimeMs + SPEC_SETTLE_MS);
        return void this.finish(p, reg, before, state, view, at, false);
      }
      const r = this.readDoc(p, rel, st);
      if (!r) continue;
      const o = { kind: classify(rel, r.text), mode: 'auto' as const, depth: undefined, path: rel };
      kinds.set(rel, o.kind);
      const items = extract(r.text, path.posix.basename(rel), optsOf(o));
      archOf.set(rel, readArch(r.text));
      reads.set(rel, { ...r, git: view.stateOf(rel), key: itemsKey(reg, { ...o, blob: r.blob }) });
      snap.push({ path: rel, fmId: fmIdOf(r.text), sketch: sketchOf(r.text, h), items, ...(isFresh ? { fresh: true, first: true } : { moveOnly: true }) });
    }

    // ── Match ──
    let dirty = false;
    const setEntry = (u: string, e: ReturnType<typeof entryOf>) => {
      const old = cache.items[u];
      if (old && JSON.stringify(old) === JSON.stringify(e)) return;
      cache.items[u] = e;
      dirty = true;
    };
    if (snap.some((d) => d.items !== null) || missing.length) {
      const mats = new Map<string, Mat | null>();
      const res = matchSnapshot(reg, {
        docs: snap,
        renames,
        rev,
        at,
        hash: h,
        mat: (u) => {
          if (!mats.has(u)) mats.set(u, matOf(h, cache.items[u], currentId(reg.items[u])));
          return mats.get(u)!;
        },
        sketch: (u) => cache.docs[u] ?? null,
        newDoc: (sd, unresolved) => {
          // A D0 that did not hold: the provisional record keeps the owner's switches of the old one.
          const old = Object.values(reg.docs).find((x) => x.tracked && x.path === sd.path);
          const d = newDoc(sd.path, rev, at, !!sd.fresh && !unresolved, old?.kind ?? kinds.get(sd.path));
          if (old) Object.assign(d, { mode: old.mode, ...(old.depth && { depth: old.depth }), ...(old.sensitive && { sensitive: true }) });
          const uid = createDocUid();
          reg.docs[uid] = d;
          return uid;
        },
        newItem: createItemUid,
      });
      for (const sd of snap) {
        const uid = res.docOf.get(sd.path);
        const rd = reads.get(sd.path);
        if (!uid || !rd) continue;
        const d = reg.docs[uid];
        if (rd.blob !== d.blob) d.changedAt = new Date(rd.mtimeMs).toISOString();
        Object.assign(d, { blob: rd.blob, size: rd.size, mtimeMs: rd.mtimeMs, git: rd.git });
        if (sd.items === null) continue;
        // The key of what the items were taken by: a moved record with other switches is read again next time.
        d.itemsKey = rd.key;
        const uids = res.itemsOf.get(uid) ?? [];
        titles.set(uid, {
          key: rd.key,
          byUid: new Map(uids.map((u, i) => [u, titleOf(sd.items![i], textOk(d))])),
          ...(rowsOf.has(sd.path) && { rows: rowsOf.get(sd.path) }),
          ...(modsOf.get(sd.path)?.length && { mods: modsOf.get(sd.path) }),
        });
        uids.forEach((u, i) => setEntry(u, entryOf(h, sd.items![i], textOk(d))));
        if (sd.sketch) {
          cache.docs[uid] = sd.sketch;
          dirty = true;
        }
      }
      for (const [uid, d] of Object.entries(reg.docs)) if (d.state === 'retired') titles.delete(uid);
    }
    for (const b of byPlace) {
      const d = reg.docs[b.uid];
      const rd = reads.get(d.path)!;
      Object.assign(d, { size: rd.size, mtimeMs: rd.mtimeMs });
      titles.set(b.uid, {
        key: rd.key,
        byUid: new Map(b.uids.map((u, i) => [u, titleOf(b.items[i], textOk(d))])),
        ...(rowsOf.has(d.path) && { rows: rowsOf.get(d.path) }),
        ...(modsOf.get(d.path)?.length && { mods: modsOf.get(d.path) }),
      });
      b.uids.forEach((u, i) => setEntry(u, entryOf(h, b.items[i], textOk(d))));
      if (!cache.docs[b.uid]) {
        cache.docs[b.uid] = sketchOf(b.text, h);
        dirty = true;
      }
    }
    // ── SPT-P4A: the components of what was read keep their UIDs (and a gone document's retire) ──
    const archRead = new Map<string, DocArch>();
    const placed = new Set<string>();
    // An open 'same document?' leaves two records on one path: the settled one reads it.
    for (const [uid, d] of Object.entries(reg.docs).sort(([, x], [, y]) => Number(x.state === 'unresolved') - Number(y.state === 'unresolved'))) {
      const a = live(d) && !placed.has(d.path) ? archOf.get(d.path) : undefined;
      if (!a || !titles.has(uid)) continue;
      placed.add(d.path);
      archRead.set(uid, a);
    }
    // The project's cap: documents in path order, those read now and those held from earlier scans;
    // a read one past it shows as too big and keeps its records as they are.
    let total = 0;
    // ponytail: a document held from an earlier scan is counted, never refused afterwards (it was read under the cap); the query draws SPEC_ARCH_NODES_MAX anyway.
    for (const [uid] of Object.entries(reg.docs).filter(([, x]) => live(x)).sort(([, x], [, y]) => (x.path < y.path ? -1 : 1))) {
      const a = archRead.get(uid) ?? titles.get(uid)?.arch?.arch;
      if (!a) continue;
      total += a.comps.length;
      if (total > SPEC_ARCH_PROJECT_COMPS_MAX && archRead.has(uid)) archRead.set(uid, tooBigArch(1));
    }
    const compUids = matchComponents(reg, archRead, rev, createCompUid, at);
    for (const [uid, a] of archRead) {
      const t = titles.get(uid)!;
      const uids = compUids.get(uid)!;
      // SPT-P4C: a component of a block refused now (or of a document refused whole) is held active: it keeps its last label and line.
      const now = new Set(uids);
      const held = new Map<string, { label: string; line: number }>();
      const keep = (u: string, label: string, line: number) => {
        if (!now.has(u) && reg.components[u]?.state === 'active' && reg.components[u].doc === uid) held.set(u, { label, line });
      };
      const old = archBefore.get(uid);
      for (const h of old?.held ?? []) keep(h.uid, h.label, h.line);
      old?.arch?.arch.comps.forEach((c, i) => old.arch!.uids[i] && !c.tree && keep(old.arch!.uids[i], c.label, c.line));
      t.arch = { arch: a, uids };
      if (held.size) t.held = [...held].map(([u, h]) => ({ uid: u, ...h }));
      else delete t.held;
    }
    if (archRead.size) this.archCache.delete(p.projectId); // read again: built again on the next read, rev or not
    if (this.enforce(reg, cache)) dirty = true;
    this.finish(p, reg, before, state, view, at, true);
    if (dirty) this.saveCache(p, reg);
    if (settleAt) this.followUp(p, settleAt);
  }

  /** The scan's end: HEAD noted (only by a scan that matched everything), the Registry saved when anything in it changed. */
  private finish(p: SpecProject, reg: SpecRegistry, before: string, state: () => string, view: GitView, at: string, full: boolean): void {
    if (full) {
      reg.repo.lastHead = view.head;
      reg.repo.branch = view.branch;
    }
    if (state() === before) return;
    reg.repo.lastPath = p.folder;
    reg.repo.lastSeenAt = at;
    this.save(p, reg);
  }

  /**
   * A file was being written: one scan more once it settles, so a write is not left unread while
   * the 문서 tab stays open. One timer per project, only while tracking is on and a route asked
   * within SPEC_FOLLOW_UP_READ_MS (the follow-up itself does not count as a read).
   */
  private followUp(p: SpecProject, settleAt: number): void {
    const read = this.readAt.get(p.projectId);
    if (this.followUps.has(p.projectId) || read === undefined || this.now() - read > SPEC_FOLLOW_UP_READ_MS) return;
    this.followUps.add(p.projectId);
    const ms = Math.min(Math.max(settleAt - this.now(), 0), SPEC_SETTLE_MS) + SPEC_FOLLOW_UP_MARGIN_MS;
    const run = () => {
      this.followUps.delete(p.projectId);
      if (this.enabled(p)) void this.scan(p, true);
    };
    if (this.deps.later) this.deps.later(run, ms);
    else setTimeout(run, ms).unref();
  }

  /** SPT §2.2: new Markdown files beside tracked documents, to be tracked the same way and flagged 새 문서 (never one git ignores). */
  private freshPaths(p: SpecProject, reg: SpecRegistry, view: GitView, known: Set<string>): string[] {
    const out: string[] = [];
    const dirs = new Set(Object.values(reg.docs).filter(live).map((d) => path.posix.dirname(d.path)));
    for (const dir of dirs)
      for (const rel of docsIn(p.folder, dir)) {
        if (known.has(rel) || Object.keys(reg.docs).length + out.length >= SPEC_ENABLE_DOCS_MAX) continue;
        if (!this.checkDoc(p, rel) || !preselected(classify(rel, headOf(p.folder, rel)), view.stateOf(rel))) continue;
        out.push(rel);
        known.add(rel);
      }
    return out;
  }

  // ── 같은 항목 확인, 확인 권장, 최근 판정 ─────────────────────

  private openQuestions(reg: SpecRegistry): number {
    return (
      Object.values(reg.items).filter((r) => r.state === 'unresolved' && r.ask && live(reg.docs[r.doc])).length +
      Object.values(reg.docs).filter((d) => d.tracked && d.state === 'unresolved').length
    );
  }

  /** Accepted by T3 under SPEC_LADDER.reviewBelow, or kept by its ID though wholly rewritten (T2r), and not looked at since (SPT 0.3, non-blocking). */
  private reviewRows(reg: SpecRegistry, titles?: Map<string, Titles>): ReviewRow[] {
    const out: ReviewRow[] = [];
    for (const [uid, r] of this.liveItems(reg)) {
      const last = r.decisions.at(-1);
      const low = (last?.how === 'T3' && (last.score ?? 1) < SPEC_LADDER.reviewBelow) || last?.how === 'T2r';
      if (r.state !== 'active' || !low) continue;
      out.push({ uid, ...this.where(reg, uid, titles), score: last.score ?? 0 });
    }
    return out;
  }

  /** An item's display ID, current title, document and line, for a list. */
  private where(reg: SpecRegistry, uid: string, titles?: Map<string, Titles>) {
    const r = reg.items[uid];
    const id = currentId(r);
    return {
      ...(id && { displayId: id }),
      title: r.state === 'retired' ? '' : (titles?.get(r.doc)?.byUid.get(uid)?.title ?? ''),
      doc: reg.docs[r.doc]?.path ?? '',
      line: r.locator.line,
    };
  }

  /** The open questions with their candidates and (not for a sensitive document) the masked texts, and 확인 권장. */
  async questions(p: SpecProject): Promise<{ enabled: boolean; rev: number; questions: Question[]; review: ReviewRow[] }> {
    if (this.enabled(p)) await this.scanIfDue(p);
    const reg = this.enabled(p);
    if (!reg) return { enabled: false, rev: this.load(p).registry?.rev ?? 0, questions: [], review: [] };
    const titles = this.titles.get(p.projectId);
    const cache = this.caches.get(p.projectId);
    const textOf = (u: string) => {
      const r = reg.items[u];
      return r && textOk(reg.docs[r.doc]) ? questionText(cache?.items[u]?.b) : undefined;
    };
    const cand = (c: Cand): QuestionCand => {
      const r = reg.items[c.uid];
      if (!r) return { ...c, doc: '', state: 'gone' };
      const w = this.where(reg, c.uid, titles);
      return { ...c, ...(w.displayId && { displayId: w.displayId }), doc: w.doc, line: w.line, state: r.state, ...(textOf(c.uid) !== undefined && { text: textOf(c.uid) }) };
    };
    const out: Question[] = [];
    for (const [uid, d] of Object.entries(reg.docs))
      if (d.tracked && d.state === 'unresolved')
        out.push({
          kind: 'doc',
          uid,
          doc: d.path,
          items: Object.values(reg.items).filter((r) => r.doc === uid && r.state !== 'retired').length,
          cands: (d.candidates ?? []).map((c) => ({ ...c, doc: reg.docs[c.uid]?.path ?? '', state: reg.docs[c.uid]?.state ?? 'gone' })),
        });
    for (const [uid, r] of this.liveItems(reg)) {
      if (r.state !== 'unresolved' || !r.ask) continue;
      const w = this.where(reg, uid, titles);
      out.push({ kind: r.ask, uid, ...w, docUid: r.doc, ...(textOf(uid) !== undefined && { text: textOf(uid) }), cands: (r.candidates ?? []).map(cand) });
    }
    return { enabled: true, rev: reg.rev, questions: out, review: this.reviewRows(reg, titles) };
  }

  /** 최근 판정: each item's latest decision, newest first (the enable's own "new" left out). */
  async decisions(p: SpecProject, limitIn: unknown): Promise<SpecResult<{ enabled: boolean; rev: number; decisions: DecisionRow[] }>> {
    const limit = limitIn === undefined ? SPEC_DECISIONS_PAGE : intIn(limitIn, 1, SPEC_DECISIONS_PAGE_MAX);
    if (limit === null) return { ok: false, error: 'value' };
    if (this.enabled(p)) await this.scanIfDue(p);
    const reg = this.enabled(p);
    if (!reg) return { ok: true, value: { enabled: false, rev: this.load(p).registry?.rev ?? 0, decisions: [] } };
    const titles = this.titles.get(p.projectId);
    const rows = this.liveItems(reg)
      .map(([uid, r]) => ({ uid, r, last: r.decisions.at(-1)! }))
      .filter(({ last }) => last && last.at && !last.first && last.how !== 'retired')
      .sort((a, b) => (a.last.at! < b.last.at! ? 1 : a.last.at! > b.last.at! ? -1 : 0))
      .slice(0, limit);
    const retired = Object.entries(reg.items).filter(([, x]) => x.state === 'retired' && reg.docs[x.doc]?.tracked);
    return {
      ok: true,
      value: {
        enabled: true,
        rev: reg.rev,
        decisions: rows.map(({ uid, r, last }) => {
          const canMerge = r.state === 'active' && MERGEABLE.includes(last.how);
          return {
            uid,
            how: last.how,
            ...(last.score !== undefined && { score: last.score }),
            by: last.by ?? 'engine',
            at: last.at!,
            ...this.where(reg, uid, titles),
            state: r.state,
            canSplit: r.state === 'active' && SPLITTABLE.includes(last.how),
            ...(canMerge && {
              mergeInto: retired
                .sort(([, a], [, b]) => Number(b.doc === r.doc) - Number(a.doc === r.doc))
                .slice(0, SPEC_MERGE_TARGETS_MAX)
                .map(([u, x]) => ({ uid: u, ...(currentId(x) && { displayId: currentId(x) }), doc: reg.docs[x.doc]?.path ?? '', line: x.locator.line })),
            }),
          };
        }),
      },
    };
  }

  /** The owner's writes on decisions: checked, done in memory, saved with the cache. */
  private ownerWrite(p: SpecProject, write: (reg: SpecRegistry, cache: MatchCache, rev: string, at: string) => SpecError | null): SpecResult<null> {
    const l = this.load(p);
    if (l.corrupt) return { ok: false, error: 'corrupt' };
    const reg = this.enabled(p);
    if (!reg) return { ok: false, error: 'off' };
    const error = write(reg, this.cacheOf(p), reg.repo.lastHead ?? 'worktree', new Date(this.now()).toISOString());
    if (error) return { ok: false, error };
    if (!this.save(p, reg)) return { ok: false, error: 'save' };
    this.saveCache(p, reg);
    return { ok: true, value: null };
  }

  /** `from` (provisional, or a wrong new one) becomes an alias of `into`: `into` takes its place and is active again. */
  private mergeItem(p: SpecProject, reg: SpecRegistry, cache: MatchCache, from: string, into: string, how: ItemHow, rev: string, at: string): void {
    const P = reg.items[from];
    const T = reg.items[into];
    const id = currentId(P);
    push(T.decisions, { rev, how, by: 'owner', at, ...(T.textHash !== P.textHash && { was: T.textHash }), ...(currentId(T) !== id && { wasId: currentId(T) }) }, SPEC_DECISIONS_MAX);
    if (currentId(T) !== id) push(T.displayIds, { id, rev }, SPEC_DECISIONS_MAX);
    Object.assign(T, { doc: P.doc, kind: P.kind, state: 'active', textHash: P.textHash, locator: P.locator, lastRev: P.lastRev });
    T.aliases = [...(T.aliases ?? []), from, ...(P.aliases ?? [])];
    delete T.candidates;
    delete T.ask;
    delete reg.items[from];
    this.renameItem(p, reg, cache, from, into);
  }

  /** Every pointer to item `from` (neighbours, the cache, the titles) now to `to`. */
  private renameItem(p: SpecProject, reg: SpecRegistry, cache: MatchCache, from: string, to: string): void {
    for (const r of Object.values(reg.items)) {
      if (r.locator.prev === from) r.locator.prev = to;
      if (r.locator.next === from) r.locator.next = to;
    }
    if (cache.items[from]) cache.items[to] = cache.items[from];
    delete cache.items[from];
    for (const t of this.titles.get(p.projectId)?.values() ?? [])
      if (t.byUid.has(from)) {
        t.byUid.set(to, t.byUid.get(from)!);
        t.byUid.delete(from);
      }
  }

  /**
   * 같은 항목 확인's answers (SPT §2.7). An item question: `same` (as `target`: the provisional UID
   * becomes its alias, `target` active again), `new` (the provisional UID becomes a real one),
   * `split` (a real one, split from `target`). A document question: `same` or `new`. On a 확인 권장
   * row, `same` with itself as the target: the owner looked, it stays.
   */
  resolve(p: SpecProject, body: { uid?: unknown; answer?: unknown; target?: unknown }): SpecResult<null> {
    const { uid, answer, target } = body;
    if (typeof uid !== 'string' || !['same', 'new', 'split', 'seen'].includes(answer as string) || (target !== undefined && typeof target !== 'string'))
      return { ok: false, error: 'value' };
    return this.ownerWrite(p, (reg, cache, rev, at) => {
      // 되살아난 항목 확인: every revived item looked at (owner-ok); nothing else answers 'seen'.
      if (answer === 'seen') {
        if (uid !== 'revived') return 'value';
        const list = this.revived(reg);
        if (!list.length) return 'stale';
        for (const u of list) push(reg.items[u].decisions, { rev, how: 'owner-ok', by: 'owner', at }, SPEC_DECISIONS_MAX);
        return null;
      }
      if (DOC_UID_RE.test(uid)) {
        const d = reg.docs[uid];
        if (!d) return 'doc';
        if (d.state !== 'unresolved' || answer === 'split') return 'stale';
        const pending = Object.values(reg.items).filter((r) => r.doc === uid && r.state === 'unresolved' && !r.ask);
        if (answer === 'new') {
          d.state = 'active';
          delete d.candidates;
          push(d.decisions, { rev, how: 'owner-new', by: 'owner', at }, SPEC_DECISIONS_MAX);
        } else {
          const T = typeof target === 'string' ? reg.docs[target] : undefined;
          if (!T || !d.candidates?.some((c) => c.uid === target) || T.state !== 'retired') return 'stale';
          Object.assign(T, { path: d.path, blob: d.blob, size: d.size, mtimeMs: d.mtimeMs, git: d.git, changedAt: d.changedAt, itemsKey: d.itemsKey, fmId: d.fmId, state: 'active' });
          push(T.pathHistory, { path: d.path, rev, how: 'owner-same' }, SPEC_PATH_HISTORY_MAX);
          push(T.decisions, { rev, how: 'owner-same', by: 'owner', at }, SPEC_DECISIONS_MAX);
          T.aliases = [...(T.aliases ?? []), uid];
          for (const r of Object.values(reg.items)) if (r.doc === uid) r.doc = target as string;
          if (cache.docs[uid]) cache.docs[target as string] = cache.docs[uid];
          const t = this.titles.get(p.projectId);
          if (t?.has(uid)) t.set(target as string, t.get(uid)!);
          t?.delete(uid);
          delete reg.docs[uid];
        }
        for (const r of pending) {
          r.state = 'active';
          push(r.decisions, { rev, how: 'owner-new', by: 'owner', at }, SPEC_DECISIONS_MAX);
        }
        return null;
      }
      if (!ITEM_UID_RE.test(uid)) return 'item';
      const r = reg.items[uid];
      if (!r) return 'item';
      if (r.state === 'active' && answer === 'same' && target === uid) {
        push(r.decisions, { rev, how: 'owner-ok', by: 'owner', at }, SPEC_DECISIONS_MAX);
        return null;
      }
      // '어쩌면 같은 것': 같아요 makes this new UID an alias of the retired one, 아니요 keeps it new.
      if (r.state === 'active' && r.maybe?.length) {
        if (answer === 'new') {
          delete r.maybe;
          push(r.decisions, { rev, how: 'owner-new', by: 'owner', at }, SPEC_DECISIONS_MAX);
          return null;
        }
        if (answer !== 'same' || !r.maybe.some((c) => c.uid === target) || reg.items[target as string]?.state !== 'retired') return 'stale';
        delete r.maybe;
        this.mergeItem(p, reg, cache, uid, target as string, 'owner-merge', rev, at);
        return null;
      }
      if (r.state !== 'unresolved' || !r.ask) return 'stale';
      const inCands = typeof target === 'string' && !!r.candidates?.some((c) => c.uid === target) && !!reg.items[target];
      if (answer === 'same') {
        // One UID in two places is never an answer: a candidate still active elsewhere is a split.
        if (!inCands || reg.items[target as string].state === 'active') return 'stale';
        this.mergeItem(p, reg, cache, uid, target as string, 'owner-same', rev, at);
        return null;
      }
      if (answer === 'split' && !inCands) return 'stale';
      r.state = 'active';
      if (answer === 'split') r.splitFrom = target as string;
      delete r.candidates;
      delete r.ask;
      push(r.decisions, { rev, how: answer === 'split' ? 'owner-split' : 'owner-new', by: 'owner', at }, SPEC_DECISIONS_MAX);
      return null;
    });
  }

  /**
   * 최근 판정's undo (SPT §2.5). `split`: the item there now gets a new UID, and the old UID goes
   * back to what it was (retired, its previous text hash, display ID). `merge`: a wrong new item
   * becomes an alias of the retired `into`, which takes its place.
   */
  undo(p: SpecProject, body: { action?: unknown; uid?: unknown; into?: unknown }): SpecResult<{ uid: string }> {
    const { action, uid, into } = body;
    if ((action !== 'split' && action !== 'merge') || typeof uid !== 'string' || (into !== undefined && typeof into !== 'string'))
      return { ok: false, error: 'value' };
    let out = uid;
    const r = this.ownerWrite(p, (reg, cache, rev, at) => {
      if (!ITEM_UID_RE.test(uid) || !reg.items[uid]) return 'item';
      const U = reg.items[uid];
      const last = U.decisions.at(-1);
      if (U.state !== 'active' || !last) return 'stale';
      if (action === 'merge') {
        const T = typeof into === 'string' ? reg.items[into] : undefined;
        if (!MERGEABLE.includes(last.how) || !T || T.state !== 'retired' || into === uid) return 'stale';
        this.mergeItem(p, reg, cache, uid, into as string, 'owner-merge', rev, at);
        out = into as string;
        return null;
      }
      if (!SPLITTABLE.includes(last.how)) return 'stale';
      const fresh = createItemUid();
      const id = currentId(U);
      reg.items[fresh] = {
        doc: U.doc,
        kind: U.kind,
        state: 'active',
        displayIds: id ? [{ id, rev }] : [],
        textHash: U.textHash,
        locator: { ...U.locator },
        firstRev: rev,
        lastRev: rev,
        decisions: [{ rev, how: 'owner-split', by: 'owner', at }],
        splitFrom: uid,
      };
      this.renameItem(p, reg, cache, uid, fresh);
      // The old UID as it was: its own text hash (none when the match kept the text: then nothing may take it by T1), its display ID.
      U.state = 'retired';
      U.textHash = last.was ?? '';
      if (last.wasId !== undefined && last.wasId !== id) push(U.displayIds, { id: last.wasId, rev }, SPEC_DECISIONS_MAX);
      U.locator = { line: U.locator.line, ordinal: U.locator.ordinal, parent: U.locator.parent };
      push(U.decisions, { rev, how: 'owner-split', by: 'owner', at }, SPEC_DECISIONS_MAX);
      out = fresh;
      return null;
    });
    return r.ok ? { ok: true, value: { uid: out } } : r;
  }

  // ── SPT-P2: links, the trace index, its queries ─────────

  private linksOf(p: SpecProject): LoadedLinks {
    let l = this.linkFiles.get(p.projectId);
    if (!l) this.linkFiles.set(p.projectId, (l = readLinks(linksFile(this.deps.home, p.projectId))));
    return l;
  }

  private acceptOf(p: SpecProject): LoadedAcceptance {
    let a = this.acceptFiles.get(p.projectId);
    if (!a) this.acceptFiles.set(p.projectId, (a = readAcceptance(acceptanceFile(this.deps.home, p.projectId))));
    return a;
  }

  /** What specChanged carries: the Registry's rev plus the links' and the acceptance records' plus the source changes and the structure changes seen (each only grows, so the sum does). */
  // ponytail: the source and structure parts are memory only; after a restart one value may repeat once (that page then refetches on the next change).
  private revOf(p: SpecProject): number {
    return (
      (this.load(p).registry?.rev ?? 0) + this.linksOf(p).links.rev + this.acceptOf(p).file.rev + this.archOf(p).file.rev + (this.sourceRevs.get(p.projectId) ?? 0) + (this.structRevs.get(p.projectId) ?? 0)
    );
  }

  /** What of this project's Tasks and jobs the index reads, as one string (a change in it is a change in the trace). */
  private sourcePrint(p: SpecProject): string {
    return JSON.stringify([
      this.tasksOf(p).map((t) => [t.id, t.title, t.detail, t.goal, t.status, t.reportedDone?.value, t.reportedDone?.source, t.commits?.value, t.commits?.source, t.testsPassed?.value, t.testsPassed?.source]),
      this.jobsOf(p).map((j) => [j.id, j.desc, j.exit, j.ended]),
    ]);
  }

  /**
   * The Task Board or a job record changed (TaskStore's and Jobs' own change callbacks; nothing
   * polls). Only a project whose index someone holds is looked at: when what its index read
   * changed, the index goes and specChanged tells the open page to read again.
   */
  sourcesChanged(): void {
    this.jobCache = null;
    if (!this.traces.size) return;
    const byId = new Map(this.deps.projects().map((p) => [p.projectId, p]));
    for (const [id, t] of this.traces) {
      const p = byId.get(id);
      if (!p || this.sourcePrint(p) === t.print) continue;
      this.traces.delete(id);
      this.sourceRevs.set(id, (this.sourceRevs.get(id) ?? 0) + 1);
      this.deps.broadcast({ type: 'specChanged', project: p.name, rev: this.revOf(p) });
    }
  }

  private tasksOf(p: SpecProject): TraceTask[] {
    try {
      return (this.deps.tasks?.() ?? []).filter((t) => t.project === p.name);
    } catch {
      return [];
    }
  }

  private jobsOf(p: SpecProject): TraceJob[] {
    try {
      const now = this.now();
      if (!this.jobCache || now - this.jobCache.at >= SPEC_TRACE_IDLE_MS) this.jobCache = { at: now, list: this.deps.jobs?.() ?? [] };
      return this.jobCache.list.filter((j) => j.project === p.name && j.kind !== 'codex');
    } catch {
      return [];
    }
  }

  /** HEAD's first-parent commits (at most SPEC_TRACE_COMMITS_MAX), one git log per HEAD: masked subjects and the IDs each message names. */
  private async commitsOf(p: SpecProject, reg: SpecRegistry): Promise<TraceCommit[]> {
    const head = reg.repo.lastHead;
    if (!head) return [];
    const c = this.commitCache.get(p.projectId);
    if (c?.head === head) return c.commits;
    const ids = idsOf(reg.shortIds, reg.idPatterns);
    let commits: TraceCommit[] = [];
    this.commitScans++;
    // ponytail: first-parent only, so a merged side branch's own commits are not read: a Task's commits made there and merged are not suggested (the merge commit is, when its message names the Task). --no-first-parent with a cap when that matters.
    try {
      const r = await this.run(p.folder, ['log', '--first-parent', `-${SPEC_TRACE_COMMITS_MAX}`, '--no-show-signature', '--format=%H%x1f%cI%x1f%B%x1e', head, '--'], {
        env: READ_ENV,
        maxBytes: SPEC_GIT_MAX_BYTES,
      });
      if (r.code === 0 || r.capped) {
        const recs = r.stdout.toString('utf-8').split('\x1e');
        if (r.capped) recs.pop(); // cut in the middle of one
        commits = recs.flatMap((x) => {
          const [sha, time, msg = ''] = x.replace(/^\n+/, '').split('\x1f');
          return sha && /^[0-9a-f]{40,64}$/.test(sha) ? [{ sha, time, subject: maskText(msg.split('\n')[0]).slice(0, SPEC_TITLE_MAX), ids: ids.all(msg) }] : [];
        });
      }
    } catch {
      /* git gone: no commits */
    }
    this.commitCache.set(p.projectId, { head, commits });
    return commits;
  }

  /** The branch and tag tips, hashed: what a commit's reachability depends on besides HEAD (one git call). */
  private async refsPrint(p: SpecProject): Promise<string> {
    try {
      const r = await this.run(p.folder, ['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/tags'], { env: READ_ENV, maxBytes: SPEC_GIT_MAX_BYTES });
      return crypto.createHash('sha256').update(r.stdout).digest('hex').slice(0, 16);
    } catch {
      return '';
    }
  }

  /**
   * A confirmed or picked commit outside HEAD's first-parent log: a commit object of this repository
   * (an annotated tag's own SHA is not one), an ancestor of HEAD, and reachable from a branch or a
   * tag (a deleted branch's commit is not: its link's end is missing). Cached per HEAD and refs.
   */
  private async commitState(p: SpecProject, head: string | null, refs: string, sha: string): Promise<CommitState> {
    const key = `${head}|${refs}`;
    let c = this.shaCache.get(p.projectId);
    if (!c || c.key !== key) this.shaCache.set(p.projectId, (c = { key, known: new Map() }));
    const hit = c.known.get(sha);
    if (hit) return hit;
    const opts = { env: READ_ENV, maxBytes: SPEC_GIT_MAX_BYTES };
    let out: CommitState = { exists: false, ancestor: false, reachable: false };
    try {
      const type = await this.run(p.folder, ['cat-file', '-t', sha], opts);
      if (head && type.code === 0 && type.stdout.toString('utf-8').trim() === 'commit') {
        const ancestor = (await this.run(p.folder, ['merge-base', '--is-ancestor', sha, head], opts)).code === 0;
        const reachable =
          ancestor || (await this.run(p.folder, ['for-each-ref', '--contains', sha, '--count=1', '--format=%(refname)', 'refs/heads', 'refs/tags'], opts)).stdout.toString('utf-8').trim() !== '';
        out = { exists: true, ancestor, reachable };
      }
    } catch {
      /* git gone: not known */
    }
    c.known.set(sha, out);
    return out;
  }

  /**
   * SPT-P4C: the components a requirement may realize: this project's live components read from
   * its documents (doc path order, each once), with the label and the place the query shows.
   * 4b adds the owner's components and approved skeleton folders (`folder`) here.
   */
  private linkComps(p: SpecProject, reg: SpecRegistry): TraceComp[] {
    const out = new Map<string, TraceComp>();
    const docs = [...(this.titles.get(p.projectId) ?? [])].filter(([uid, t]) => t.arch && live(reg.docs[uid])).sort(([a], [b]) => (reg.docs[a].path < reg.docs[b].path ? -1 : 1));
    // BRN K8: a folder tree line is a design module only, never a link candidate.
    const trees = new Set<string>();
    for (const [uid, t] of docs)
      t.arch!.arch.comps.forEach((c, i) => {
        const id = t.arch!.uids[i];
        if (id && c.tree) trees.add(id);
        else if (id && !out.has(id) && reg.components[id]?.state === 'active') out.set(id, { uid: id, label: c.label, source: { path: reg.docs[uid].path, line: c.line } });
      });
    // Held ones (a block refused for a moment loses nothing): their last label, else their UID.
    const held = new Map([...(this.titles.get(p.projectId) ?? [])].flatMap(([doc, t]) => (t.held ?? []).map((h) => [h.uid, { ...h, doc }] as const)));
    for (const [id, c] of Object.entries(reg.components)) {
      if (out.has(id) || trees.has(id) || c.state !== 'active' || !live(reg.docs[c.doc])) continue;
      const h = held.get(id);
      out.set(id, { uid: id, label: h?.label ?? id, ...(h && { source: { path: reg.docs[c.doc].path, line: h.line } }) });
    }
    // SPT-P4B's: the components added by hand, the approved (or renamed) folders, and a folder merged
    // into a component (that component owns its paths). Labels masked like the arch query's.
    const a = this.archOf(p).file;
    for (const c of a.components) if (!out.has(c.uid)) out.set(c.uid, { uid: c.uid, label: c.label });
    for (const d of a.skeleton) if (d.uid && (d.action === 'approved' || d.action === 'renamed') && !out.has(d.uid)) out.set(d.uid, { uid: d.uid, label: d.label ?? maskText(d.path), folder: d.path });
    // A merged folder: one more entry of its component (same UID) that only owns the folder's paths.
    const merged = a.skeleton.flatMap((d) => (d.action === 'merged' && d.into && out.has(d.into) ? [{ uid: d.into, label: out.get(d.into)!.label, folder: d.path }] : []));
    return [...out.values(), ...merged];
  }

  /**
   * The project's trace index: built on a read, kept while the Registry's and the links' revs and
   * HEAD stay and for at most SPEC_SCAN_MIN_MS (Tasks and jobs change without a rev), dropped
   * SPEC_TRACE_IDLE_MS after the last read. Call after scanIfDue.
   */
  private async index(p: SpecProject, reg: SpecRegistry): Promise<TraceIndex> {
    const now = this.now();
    this.touchTrace(p, now);
    const links = this.linksOf(p).links;
    const accepted = this.acceptOf(p).file;
    // SPT-P4C: arch.json's rev too (owner components, approved folders and aliases change the links' ends).
    const arch = this.archOf(p).file;
    const key = `${reg.rev}|${links.rev}|${accepted.rev}|${arch.rev}|${reg.repo.lastHead ?? ''}`;
    const c = this.traces.get(p.projectId);
    if (c && c.key === key && now - c.at < SPEC_SCAN_MIN_MS) return c.ix;
    const commits = await this.commitsOf(p, reg);
    const inLog = new Set(commits.map((x) => x.sha));
    const known = new Map<string, CommitState>();
    const outside = links.links.filter((l) => l.status === 'confirmed' && l.to.t === 'commit' && !inLog.has(l.to.sha));
    const refs = outside.length ? await this.refsPrint(p) : '';
    for (const l of outside) known.set(refId(l.to), await this.commitState(p, reg.repo.lastHead, refs, refId(l.to)));
    const print = this.sourcePrint(p);
    const titles = this.titles.get(p.projectId);
    const refRowsNow = [...(titles ?? [])].flatMap(([uid, t]) => (live(reg.docs[uid]) && reg.docs[uid].mode === 'refs' ? (t.rows ?? []) : []));
    const ix = buildIndex({
      reg,
      text: (uid) => {
        const r = reg.items[uid];
        return r ? titles?.get(r.doc)?.byUid.get(uid) : undefined;
      },
      refRows: refRowsNow,
      links,
      acceptance: accepted.records,
      tasks: this.tasksOf(p),
      jobs: this.jobsOf(p),
      commits,
      known: (sha) => known.get(sha),
      ids: idsOf(reg.shortIds, reg.idPatterns),
      comps: this.linkComps(p, reg),
      aliases: new Map(arch.aliases.map((x) => [x.uid, x.into])),
      // A document marked 민감 since it was read sends no path either.
      modRows: [...(titles ?? [])].flatMap(([uid, t]) => (live(reg.docs[uid]) && textOk(reg.docs[uid]) ? (t.mods ?? []) : [])),
    });
    this.traceBuilds++;
    this.traces.set(p.projectId, { key, at: now, ix, print });
    return ix;
  }

  /** A read of the trace: the index stays until SPEC_TRACE_IDLE_MS pass without one (one timer per project). */
  private touchTrace(p: SpecProject, now: number): void {
    this.traceReadAt.set(p.projectId, now);
    if (this.idleTimers.has(p.projectId)) return;
    this.idleTimers.add(p.projectId);
    const later = (fn: () => void, ms: number) => (this.deps.idle ? this.deps.idle(fn, ms) : setTimeout(fn, ms).unref());
    const check = () => {
      const quiet = this.now() - (this.traceReadAt.get(p.projectId) ?? 0);
      if (quiet < SPEC_TRACE_IDLE_MS) return void later(check, SPEC_TRACE_IDLE_MS - quiet);
      this.idleTimers.delete(p.projectId);
      for (const m of [this.traces, this.commitCache, this.shaCache, this.traceReadAt, this.recentCache, this.archCache, this.skeletons, this.codeScans]) m.delete(p.projectId);
    };
    later(check, SPEC_TRACE_IDLE_MS);
  }

  /** Whether a trace index is held for the project now (the idle test). */
  traceHeld(p: SpecProject): boolean {
    return this.traces.has(p.projectId);
  }

  /** The tracked, scanned Registry and its index; off: the error. */
  private async traced(p: SpecProject): Promise<SpecResult<{ reg: SpecRegistry; ix: TraceIndex }>> {
    if (this.load(p).corrupt) return { ok: false, error: 'corrupt' };
    if (this.enabled(p)) await this.scanIfDue(p);
    const reg = this.enabled(p);
    if (!reg) return { ok: false, error: 'off' };
    return { ok: true, value: { reg, ix: await this.index(p, reg) } };
  }

  /** The 개요 card's counts: requirements with no confirmed or observed link, with link review, with an end missing; SPT-P3-OVERVIEW's (overviewCounts). */
  private async traceCounts(p: SpecProject, reg: SpecRegistry) {
    const ix = await this.index(p, reg);
    const states = ix.reqs.map((u) => ix.states.get(u));
    return {
      unlinked: ix.unlinked,
      linkReview: states.filter((s) => s?.linkReview).length,
      missing: states.filter((s) => s?.freshness === 'missing').length,
      ...overviewCounts(ix),
    };
  }

  /**
   * SPT-P3-OVERVIEW: 최근 근거. The tracked branch's last commits and this project's last ended jobs
   * with the requirements each is confirmed to or names (tracking on), and its last merge records.
   * Built from the trace index and the readers it already has; kept per HEAD and rev for at most
   * SPEC_SCAN_MIN_MS (merges and jobs move without one), dropped with the index when nobody reads.
   */
  /** BRN K5: the 개요's five lines' handoff part, tracking on or off (an unreadable one reads as none). */
  resume(p: SpecProject): TraceResume {
    try {
      return { handoff: this.deps.resume?.(p.name) ?? null };
    } catch {
      return { handoff: null };
    }
  }

  async recent(p: SpecProject): Promise<SpecResult<TraceRecent>> {
    if (this.load(p).corrupt) return { ok: false, error: 'corrupt' };
    if (this.enabled(p)) await this.scanIfDue(p);
    const reg = this.enabled(p);
    const now = this.now();
    this.touchTrace(p, now);
    const head = reg ? (reg.repo.lastHead ?? '') : ((await this.gitSummary(p)).head ?? '');
    const key = `${reg ? 'on' : 'off'}|${head}|${this.revOf(p)}`;
    const c = this.recentCache.get(p.projectId);
    if (c && c.key === key && now - c.at < SPEC_SCAN_MIN_MS) return { ok: true, value: c.value };
    const ix = reg ? await this.index(p, reg) : null;
    const chips = (id: string) => (ix ? reqsOf(ix, id) : []);
    const commits = reg
      ? (await this.commitsOf(p, reg)).slice(0, SPEC_RECENT_COMMITS).map((x) => ({ sha: x.sha, subject: x.subject, at: x.time, reqs: chips(x.sha) }))
      : (await this.gitSummary(p)).recent.map((x) => ({ sha: x.sha, subject: x.subject, at: x.time, reqs: [] }));
    const jobs = this.jobsOf(p)
      .filter((j): j is TraceJob & { ended: string } => !!j.ended)
      .sort((a, b) => (a.ended < b.ended ? 1 : a.ended > b.ended ? -1 : 0))
      .slice(0, SPEC_RECENT_JOBS)
      .map((j) => ({ id: j.id, desc: shown(j.desc || j.cmd), exit: j.exit, at: j.ended, reqs: chips(j.id), ...(ix && deployReported(ix, j.id, j.exit) && { reported: true as const }) }));
    let records: RepoMerge[] = [];
    try {
      records = this.deps.merges?.(p.name, SPEC_RECENT_MERGES) ?? [];
    } catch {
      /* an unreadable history: no merges to show */
    }
    const cut = (v: string) => maskText(v).slice(0, SPEC_TITLE_MAX);
    const merges = records.slice(0, SPEC_RECENT_MERGES).map((m) => ({
      ok: m.ok,
      at: m.at,
      target: cut(m.target),
      auto: m.auto,
      ...(m.task && { task: cut(m.task) }),
      ...(m.branch && { branch: cut(m.branch) }),
      ...(m.kind && { kind: cut(m.kind) }),
      ...(m.sha && /^[0-9a-f]{7,64}$/.test(m.sha) && { sha: m.sha }),
      ...(m.error && { error: cut(m.error) }),
    }));
    const value: TraceRecent = { commits, jobs, merges };
    this.recentBuilds++;
    this.recentCache.set(p.projectId, { key, at: now, value });
    return { ok: true, value };
  }

  /** traceQuery (SPT §4.5): `overview`, `group&group=`, `neighbourhood&center=&depth=` (types, confirmedOnly). The routes now, MCP in Phase 6. */
  async graph(p: SpecProject, q: { level?: unknown; group?: unknown; center?: unknown; depth?: unknown; types?: unknown; confirmedOnly?: unknown }): Promise<SpecResult<TraceGraph>> {
    const TYPES: readonly string[] = ['req', 'doc', 'task', 'commit', 'job', 'msg', 'comp'];
    const types = typeof q.types === 'string' && q.types ? q.types.split(',') : undefined;
    const depth = q.depth === undefined ? 1 : intIn(q.depth, 1, SPEC_TRACE_DEPTH_MAX);
    if (
      !['overview', 'group', 'neighbourhood'].includes(q.level as string) ||
      (q.level === 'group' && (typeof q.group !== 'string' || q.group.length > SPEC_PATH_MAX)) ||
      (q.level === 'neighbourhood' && (typeof q.center !== 'string' || !ITEM_UID_RE.test(q.center))) ||
      depth === null ||
      (types && !types.every((t) => TYPES.includes(t))) ||
      (q.confirmedOnly !== undefined && q.confirmedOnly !== 'true' && q.confirmedOnly !== 'false')
    )
      return { ok: false, error: 'value' };
    const t = await this.traced(p);
    if (!t.ok) return t;
    const { reg, ix } = t.value;
    if (q.level === 'overview') return { ok: true, value: overview(ix) };
    if (q.level === 'group') return { ok: true, value: groupGraph(ix, reg, q.group as string, (u) => this.titles.get(p.projectId)?.get(reg.items[u].doc)?.byUid.get(u)) };
    if (!ix.nodes.has(q.center as string)) return { ok: false, error: 'item' };
    return {
      ok: true,
      value: neighbourhood(ix, { center: q.center as string, depth, ...(types && { types: new Set(types as TraceNodeType[]) }), confirmedOnly: q.confirmedOnly === 'true' }),
    };
  }

  /**
   * SPT-P4A (§8): the architecture read from the tracked documents, `layer` composition (the
   * default) or interaction (the sequence messages too). Built from the scan's reads, kept per
   * Registry rev (a document's bytes change it) and dropped with the trace index when nobody reads.
   */
  async arch(p: SpecProject, q: { layer?: unknown }): Promise<SpecResult<TraceArch>> {
    const layer = q.layer ?? 'composition';
    if (layer !== 'composition' && layer !== 'interaction') return { ok: false, error: 'value' };
    if (this.load(p).corrupt) return { ok: false, error: 'corrupt' };
    if (this.enabled(p)) await this.scanIfDue(p);
    const reg = this.enabled(p);
    if (!reg) return { ok: false, error: 'off' };
    this.touchTrace(p, this.now());
    const owned = await this.archOwned(p, reg, layer);
    // SPT-P4C: each component's requirements, from the trace index (its own rev and cache).
    const ix = await this.index(p, reg);
    const last = lastBatch(this.archOf(p).file);
    return {
      ok: true,
      value: {
        ...owned,
        nodes: owned.nodes.map((n) => {
          const reqs = compReqs(ix, n.id);
          return reqs.count ? { ...n, reqs } : n;
        }),
        // [제안 모두 승인] and [되돌리기] (the design drawing's head, SPT C1).
        pending: {
          diagrams: owned.diagrams.filter((d) => d.standing === 'doc').map((d) => ({ doc: d.doc, block: d.block, version: d.version })),
          folders: owned.nodes.flatMap((n) => (n.standing === 'proposed' && n.folder ? [n.folder] : [])),
        },
        ...(last && { lastBatch: last }),
      },
    };
  }

  /** The architecture of a layer (built per Registry rev) with the owner's decisions over it, every read (linear, capped lists; a corrupt arch.json reads as none). */
  private async archOwned(p: SpecProject, reg: SpecRegistry, layer: TraceArch['layer']): Promise<TraceArch> {
    let c = this.archCache.get(p.projectId);
    if (!c || c.rev !== reg.rev) this.archCache.set(p.projectId, (c = { rev: reg.rev, layers: new Map() }));
    let arch = c.layers.get(layer);
    if (!arch) {
      const docs = new Map([...(this.titles.get(p.projectId) ?? [])].flatMap(([uid, t]) => (t.arch ? [[uid, t.arch] as const] : [])));
      c.layers.set(layer, (arch = archGraph(reg, docs, layer)));
      this.archBuilds++;
    }
    return applyOwner(arch, this.archOf(p).file, await this.skeletonOf(p, reg));
  }

  /**
   * BRN K8 (project-brain §7): the design modules of the live documents read and of arch.json, met
   * with the top fold of the code. Its paths: an approved folder or one merged into it (확인함), else
   * what the documents write (a tree line, a table's path cell, a label that is a path: 글에 적힘).
   * A tree line is a module of its own, the first of a path in document path order. Built on a map
   * read with `design=1` only: nobody asks, nothing is built.
   */
  private async designOf(p: SpecProject, reg: SpecRegistry, scan: CodeScan | null, code: MapStructure | null) {
    const owned = await this.archOwned(p, reg, 'composition');
    const docs = [...(this.titles.get(p.projectId) ?? [])].filter(([uid, t]) => t.arch && live(reg.docs[uid])).sort(([a], [b]) => (reg.docs[a].path < reg.docs[b].path ? -1 : 1));
    const written = new Map<string, string[]>();
    const mods: DesignModuleIn[] = [];
    const treePaths = new Set<string>();
    for (const [uid, t] of docs)
      t.arch!.arch.comps.forEach((c, i) => {
        const id = t.arch!.uids[i];
        if (!id || !c.path || reg.components[id]?.state !== 'active') return;
        if (!c.tree) return void (written.has(id) || written.set(id, [c.path]));
        if (treePaths.has(c.path)) return;
        treePaths.add(c.path);
        mods.push({ id, label: c.label, paths: [c.path], by: 'written', source: { path: reg.docs[uid].path, line: c.line } });
      });
    for (const n of owned.nodes) {
      if (n.standing === 'proposed') continue; // a folder proposed from the code is no design
      const mine = [...(n.folder ? [n.folder] : []), ...(n.folders ?? [])];
      const theirs = [n.id, ...(n.merged ?? []).map((m) => m.id)].flatMap((u) => written.get(u) ?? []);
      mods.push({ id: n.id, label: n.label, paths: mine.length ? mine : theirs, by: mine.length ? 'confirmed' : theirs.length ? 'written' : null, ...(n.sources[0] && { source: n.sources[0] }) });
    }
    const edges = owned.edges.filter((e) => e.layer === 'composition').map((e) => ({ from: e.from, to: e.to, ...(e.ends && { ends: e.ends }) }));
    const root = p.folder;
    // A planned path is the document's text: inside the project folder only, never followed.
    const exists = (rel: string) => {
      if (path.isAbsolute(rel) || rel.split('/').includes('..') || forbiddenFilePath(rel)) return false;
      try {
        fs.lstatSync(path.join(root, rel));
        return true;
      } catch {
        return false;
      }
    };
    return designMap(mods, edges, scan, code, exists);
  }

  /**
   * SPT C1-C2 (§6.8, §8): the 지도. The features from the trace index (no file read), the structure
   * and the links from the last code scan (a child process, run only when its key changed and
   * SPEC_MAP_MIN_MS passed). `feature`: that feature's requirements and chain; `block`: a cell's
   * detail; `in`: the cells entered ([한 단계 들어가기], `a>b`). Tracking off: an empty map, nothing
   * scanned, read or run. `hidden`: documents whose requirements are left out (BRN K3's 민감).
   */
  async map(p: SpecProject, q: { feature?: unknown; in?: unknown; block?: unknown; design?: unknown }, hidden: ReadonlySet<string> = new Set()): Promise<SpecResult<TraceMap>> {
    const { feature, block, in: into = '', design } = q;
    const bad = (v: unknown) => v !== undefined && (typeof v !== 'string' || v.length > SPEC_PATH_MAX);
    if (bad(feature) || bad(block) || typeof into !== 'string' || into.length > SPEC_PATH_MAX || (design !== undefined && design !== '1')) return { ok: false, error: 'value' };
    const chain = into ? into.split('>') : [];
    if (chain.length > SPEC_MAP_IN_DEPTH_MAX) return { ok: false, error: 'value' };
    if (this.load(p).corrupt) return { ok: false, error: 'corrupt' };
    const on = new Set(SPEC_MAP_PATHS_ON as TraceMap['pathsOn']);
    if (!this.enabled(p))
      return { ok: true, value: { enabled: false, features: [], common: [], reqTotal: 0, changed: 0, structure: null, linked: 0, pathsOn: [...on], commits: 0, tagOnly: 0 } };
    const t = await this.traced(p);
    if (!t.ok) return t;
    const { reg, ix } = t.value;
    // `hidden` (the agent tools' 민감 documents): their requirements make no feature, count or link.
    const reqs = this.featureReqs(p, reg, ix).filter((r) => !hidden.has(r.path));
    const scan = await this.codeScan(p, reg);
    const since = this.now() - SPEC_MAP_RECENT_MS;
    const kit = this.kitReads(p, reg);
    const links = scan ? reqLinks(scan, this.chainReqs(p, reg, ix, reqs, kit), since, this.taskTitles(ix, kit)) : null;
    // 진행: the scan's own commit read (every branch's commits, not only first-parent; none without a scan).
    if (links) for (const r of reqs) r.progress = !!links.reqs.get(r.uid)?.recent;
    const { features, common } = featuresOf(reqs);
    const owned = scan ? structureOwned(scan, chain, this.archLabels(p)) : null;
    if (scan && !owned) return { ok: false, error: 'comp' };
    const keyOf = new Map([...features, ...common].flatMap((f) => f.uids.map((u) => [u, f.key] as const)));
    if (links && owned) lightCells(links, owned.s, owned.owner, keyOf, on, since);
    const linked = (uids: readonly string[]) => (links ? linkedCount(links, uids, on) : 0);
    const value: TraceMap = {
      enabled: true,
      features: features.map(({ uids, source: _s, ...f }) => {
        const k = f.rule === 'speckit' ? kit.get(f.short) : undefined;
        return { ...f, ...(k?.spec?.title && { name: maskText(k.spec.title) }), linked: linked(uids), ...(k && { kit: kitCounts(k) }) };
      }),
      common: common.map(({ uids: _u, ...c }) => c),
      reqTotal: reqs.length,
      changed: reqs.filter((r) => r.changed).length,
      structure: owned?.s ?? null,
      linked: features.reduce((n, f) => n + linked(f.uids), 0),
      pathsOn: [...on],
      commits: links?.commits.length ?? 0,
      ...(scan?.links?.capped && { commitsCapped: true as const }),
      tagOnly: links ? links.commits.filter((c) => tagOnly(c, links.known)).length : 0,
    };
    if (block !== undefined) {
      const names = new Map([...features.map((f) => [f.key, { short: f.short, name: f.name }] as const), ...common.map((c) => [c.key, { short: c.key, name: c.key }] as const)]);
      const d = links && owned && scan ? blockDetail(links, scan, owned.s, owned.owner, block as string, names) : null;
      if (!d) return { ok: false, error: 'item' };
      value.block = d;
    }
    // BRN K8: the design and its drifts, against the top fold (`in` does not move them).
    if (design === '1') Object.assign(value, await this.designOf(p, reg, scan, chain.length ? (scan ? (structureOwned(scan, [], this.archLabels(p))?.s ?? null) : null) : (owned?.s ?? null)));
    if (feature === undefined) return { ok: true, value };
    const f = features.find((x) => x.key === feature) ?? common.find((x) => x.key === feature);
    if (!f) return { ok: false, error: 'item' };
    const changed = new Set(reqs.filter((r) => r.changed).map((r) => r.uid));
    const named = features.find((x) => x.key === feature);
    const fc = links && scan ? featureChain(links, f.uids, scan.files, on, since) : null;
    const reads = named?.rule === 'speckit' ? kit.get(named.short) : undefined;
    value.feature = {
      key: f.key,
      name: (reads?.spec?.title && maskText(reads.spec.title)) || (named?.name ?? f.key),
      ...(named?.source && { source: named.source }),
      reqs: f.uids.slice(0, SPEC_MAP_FEATURE_REQS_MAX).map((u) => {
        const n = ix.nodes.get(u);
        return {
          uid: u,
          label: n?.label ?? u,
          ...(n?.title && { title: n.title }),
          ...(ix.states.get(u) && { state: ix.states.get(u) }),
          ...(changed.has(u) && { changed: true as const }),
          ...fc?.perReq.get(u),
        };
      }),
      more: Math.max(0, f.uids.length - SPEC_MAP_FEATURE_REQS_MAX),
      chain: fc?.chain ?? { reqs: f.uids.length, tasks: 0, commits: 0, files: 0 },
      tasks: fc?.tasks ?? [],
      tasksMore: fc?.tasksMore ?? 0,
      week: fc?.week ?? 0,
      ...(reads && named && { kit: kitBlock(named.short, reads, scan ? codeIndex(scan.files) : null, this.hasConstitution(p)) }),
    };
    return { ok: true, value };
  }

  /**
   * SPT C2 (§8.4): what the links need of each requirement besides the scan: the task numbers its own
   * row names (the SRS 출처 칸), the Task Board Tasks linked to it (confirmed, observed), the folders of
   * the components it is confirmed to realize.
   */
  private chainReqs(p: SpecProject, reg: SpecRegistry, ix: TraceIndex, reqs: readonly FeatureReq[], kit: ReadonlyMap<string, KitReads>): ChainReq[] {
    const titles = this.titles.get(p.projectId);
    const folders = new Map<string, string[]>();
    for (const c of this.linkComps(p, reg)) if (c.folder) (folders.get(c.uid) ?? folders.set(c.uid, []).get(c.uid)!).push(c.folder);
    return reqs.map((r) => {
      const edges = (ix.adj.get(r.uid) ?? []).map((i) => ix.edges[i]).filter((e) => e.from === r.uid);
      const board = edges.filter((e) => e.rel === 'implements' && (e.status === 'confirmed' || e.status === 'observed')).map((e) => e.to);
      const row = (titles?.get(r.doc)?.byUid.get(r.uid)?.refs ?? []).filter((id) => TASK_SPEC_ID.test(id));
      // K9: a Spec Kit story's tasks.md lines (`[USn]`) are its tasks, the paths they write its files.
      const story = STORY_ID.exec(r.id);
      const own = story ? storyTasks(story[1], kit.get(story[1])?.tasks, Number(story[2])) : null;
      return {
        uid: r.uid,
        id: r.id,
        tasks: [...new Set([...row, ...board, ...(own?.ids ?? [])])],
        ...(own?.files.length && { written: own.files }),
        folders: edges.filter((e) => e.rel === 'realizes' && e.status === 'confirmed').flatMap((e) => folders.get(e.to) ?? []),
      };
    });
  }

  /** The Task Board Tasks' titles in the index (masked), by id. */
  private taskTitles(ix: TraceIndex, kit: ReadonlyMap<string, KitReads> = new Map()): Map<string, string> {
    const task = [...ix.nodes.values()].flatMap((n) => (n.type === 'task' && n.title ? [[n.id, n.title] as const] : []));
    // K9: a Spec Kit task is titled by its line (masked).
    const spec = [...kit].flatMap(([dir, r]) => (r.tasks?.tasks ?? []).map((t) => [kitId(dir, t.id), maskText(t.text)] as const));
    return new Map([...task, ...spec]);
  }

  /**
   * K9: per Spec Kit feature folder, what its tracked spec.md, tasks.md, plan.md and research.md say
   * (speckit.ts), read from disk now and parsed again only when a file's size or mtime changed. Only
   * documents the owner tracks (and keeps text for) are read, like every other reading here.
   */
  private kitReads(p: SpecProject, reg: SpecRegistry): Map<string, KitReads> {
    const out = new Map<string, KitReads>();
    for (const d of Object.values(reg.docs)) {
      const k = kitOf(d.path);
      if (!k || !d.tracked || d.state === 'retired' || d.mode === 'off' || d.mode === 'refs' || !textOk(d)) continue;
      const r = out.get(k.dir) ?? out.set(k.dir, {}).get(k.dir)!;
      if (k.file === 'data-model.md') r.dataModel = true;
      const parse = KIT_PARSERS[k.file];
      if (!parse) continue;
      const got = this.kitParsed(p, d.path, parse);
      if (got !== null) (r as Record<string, unknown>)[KIT_FIELDS[k.file]] = got;
    }
    return out;
  }

  private kitParsed(p: SpecProject, rel: string, parse: (text: string) => unknown): unknown {
    try {
      const abs = path.join(p.folder, rel);
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.size > SPEC_FILE_MAX_BYTES) return null;
      const key = `${st.size}:${st.mtimeMs}`;
      const hit = this.kitCache.get(`${p.projectId}|${rel}`);
      if (hit?.key === key) return hit.value;
      const value = parse(fs.readFileSync(abs, 'utf-8'));
      this.kitCache.set(`${p.projectId}|${rel}`, { key, value });
      return value;
    } catch {
      return null;
    }
  }
  /** ponytail: one parsed entry per Spec Kit file ever read, never evicted (a few kB each); bound it if projects with thousands of features appear. */
  private readonly kitCache = new Map<string, { key: string; value: unknown }>();

  /** `.specify/memory/constitution.md` exists: its principles are prose, which is not read. */
  private hasConstitution(p: SpecProject): boolean {
    try {
      return fs.lstatSync(path.join(p.folder, SPEC_KIT_CONSTITUTION)).isFile();
    } catch {
      return false;
    }
  }

  /** The requirement documents' live items with what the feature rows light up by: 막힘, 원문 바뀜 (SPT §6.8); 진행 is the code scan's (map()). */
  /** RQ2: each requirement's feature; a display ID repeated in another document falls in its first copy's feature. */
  private featureOf(p: SpecProject, reg: SpecRegistry, ix: TraceIndex): (uid: string, id?: string) => ItemRow['feature'] {
    const { features, common } = featuresOf(this.featureReqs(p, reg, ix));
    const byUid = new Map<string, NonNullable<ItemRow['feature']>>();
    for (const f of features) for (const u of f.uids) byUid.set(u, { key: f.key, name: f.name, rule: f.rule, ...(f.changing && { changing: true as const }) });
    for (const c of common) for (const u of c.uids) byUid.set(u, { key: c.key, name: c.key, rule: 'common' });
    const byId = new Map<string, NonNullable<ItemRow['feature']>>();
    for (const [u, f] of byUid) {
      const id = currentId(reg.items[u]);
      if (id && !byId.has(id)) byId.set(id, f);
    }
    return (uid, id) => byUid.get(uid) ?? (id ? byId.get(id) : undefined);
  }

  private featureReqs(p: SpecProject, reg: SpecRegistry, ix: TraceIndex): FeatureReq[] {
    const since = this.now() - SPEC_MAP_RECENT_MS;
    const titles = this.titles.get(p.projectId);
    return ix.reqs.flatMap((uid) => {
      const r = reg.items[uid];
      const d = reg.docs[r.doc];
      if (d.kind !== 'requirements') return [];
      const id = currentId(r);
      const tasks = (ix.adj.get(uid) ?? []).map((i) => ix.edges[i]).filter((e) => e.rel === 'implements' && (e.status === 'confirmed' || e.status === 'observed'));
      return [
        {
          uid,
          id,
          doc: r.doc,
          path: d.path,
          ...(d.fmId && { fmId: d.fmId }),
          section: titles?.get(r.doc)?.byUid.get(uid)?.section ?? '',
          line: r.locator.line,
          changed: r.decisions.some((x) => !x.first && x.was !== undefined && !!x.at && Date.parse(x.at) >= since),
          progress: false,
          blocked: tasks.some((e) => !!ix.nodes.get(e.to)?.state?.work?.byStatus?.blocked),
        },
      ];
    });
  }

  /** The owner's names for folders (arch.json's renamed skeleton folders), by folder without the slash: cells and bands take them. */
  private archLabels(p: SpecProject): Map<string, string> {
    return new Map(this.archOf(p).file.skeleton.flatMap((d) => (d.action === 'renamed' && d.label ? [[d.path.replace(/\/+$/, ''), d.label] as const] : [])));
  }

  /**
   * The last code scan, its key looked at once per SPEC_SCAN_MIN_MS (a listing and stats, no file
   * opened); run again only when the key changed and SPEC_MAP_MIN_MS passed since the last run (else
   * once when it has, while someone reads: that run skips the look's own interval). A failed run
   * (null) is kept under no key: tried again past SPEC_MAP_MIN_MS, the page says 세지 못함. A changed
   * answer is a new structure rev: specChanged once.
   */
  private codeScan(p: SpecProject, reg: SpecRegistry, due = false): Promise<CodeScan | null> {
    // One look at a time per project (a read and a scan's look may meet).
    let job = this.codeRuns.get(p.projectId);
    if (!job) {
      job = this.codeScanNow(p, reg, due).finally(() => this.codeRuns.delete(p.projectId));
      this.codeRuns.set(p.projectId, job);
    }
    return job;
  }

  private async codeScanNow(p: SpecProject, reg: SpecRegistry, due: boolean): Promise<CodeScan | null> {
    const spawnMap = this.deps.specMap;
    if (!spawnMap) return null;
    const id = p.projectId;
    const now = this.now();
    const c = this.codeScans.get(id);
    if (c && !due && now - c.checkedAt < SPEC_SCAN_MIN_MS) return c.scan;
    const key = `${reg.repo.lastHead ?? ''}|${await codeKey(p.folder, this.run)}`;
    if (c && c.key === key) {
      c.checkedAt = now;
      return c.scan;
    }
    // Changed but too soon: the old answer, and one run once the interval has passed (the look is not
    // recorded, so neither a read nor that run is held off by it).
    if (c && now - c.ranAt < SPEC_MAP_MIN_MS) {
      if (!this.codeWaits.has(id)) {
        this.codeWaits.add(id);
        const again = () => {
          this.codeWaits.delete(id);
          const held = this.traceReadAt.has(id) && this.enabled(p);
          if (held) void this.codeScan(p, held, true).catch(() => undefined);
        };
        const ms = SPEC_MAP_MIN_MS - (now - c.ranAt);
        if (this.deps.later) this.deps.later(again, ms);
        else setTimeout(again, ms).unref();
      }
      return c.scan;
    }
    this.mapScans++;
    // One child process at a time over every project (the daemon's memory and CPU): they queue.
    const run = this.mapQueue.then(() => spawnMap(p.folder)).catch(() => null);
    this.mapQueue = run.then(() => undefined);
    const scan = await run;
    const print = scan ? crypto.createHash('sha256').update(JSON.stringify([scan.files, scan.edges, scan.unresolved, scan.workspaces, scan.partial ?? '', scan.big])).digest('hex') : '';
    const before = this.codeScans.get(id);
    // A failure is held under no key: the next look past SPEC_MAP_MIN_MS runs it again.
    this.codeScans.set(id, { key: scan ? key : '', scan, ranAt: now, checkedAt: now, print });
    if (before && before.print !== print) {
      this.structRevs.set(id, (this.structRevs.get(id) ?? 0) + 1);
      this.deps.broadcast({ type: 'specChanged', project: p.name, rev: this.revOf(p) });
    }
    return scan;
  }

  /** One requirement's detail. */
  async item(p: SpecProject, uid: string): Promise<SpecResult<TraceItem>> {
    if (!ITEM_UID_RE.test(uid)) return { ok: false, error: 'item' };
    const t = await this.traced(p);
    if (!t.ok) return t;
    const d = itemDetail(t.value.ix, uid);
    if (!d) return { ok: false, error: 'item' };
    const r = t.value.reg.items[uid];
    // SPT-P3-ACCEPT: the text and 인수 기준 read now (never stored), masked once as one block; the
    // version the owner sees (the hash and the bytes on disk); the acceptance records newest first.
    const now = r.state === 'retired' ? null : this.docNow(p, t.value.reg, uid);
    // ponytail: reads and masks the whole document (≤ SPEC_FILE_MAX_BYTES, 2 MB) and the item's whole section per detail GET before keeping 4 KB; cut the section first if a detail read ever shows in a profile.
    const block = now ? maskText(itemSource(now.text, r.locator.line, r.kind)) : null;
    const criteria = block === null ? [] : criteriaOf(block, r.kind).slice(0, SPEC_CRITERIA_MAX).map(shown);
    const verify = block === null ? [] : verifyOf(block, r.kind).slice(0, SPEC_CRITERIA_MAX).map(shown);
    // RQ5: what the document's own shape adds: an OpenSpec delta's change, a decision's status.
    const doc = t.value.reg.docs[r.doc];
    const changing = now && shapeOf(doc.path)?.tool === 'openspec' ? openspecOps(now.text).get(r.locator.line) : undefined;
    const decision = now && doc.kind === 'decision' ? adrStatus(now.text) : undefined;
    const records = this.acceptOf(p).file.records.filter((a) => a.uid === uid).reverse();
    return {
      ok: true,
      value: {
        ...d,
        ...(now && block !== null && { text: questionText(block), version: versionOf(r.textHash, itemSource(now.text, r.locator.line, r.kind)) }),
        ...(criteria.length && { criteria }),
        ...(verify.length && { verify }),
        ...(changing && { changing }),
        ...(decision && { decision }),
        ...(records.length && {
          acceptance: records.map((a) => ({
            state: a.state,
            ...(a.note && { note: a.note }),
            by: a.by.kind === 'owner' ? { kind: 'owner' as const } : { kind: 'agent' as const, name: a.by.name },
            at: a.at,
            current: a.textHash === r.textHash,
          })),
        }),
      },
    };
  }

  /** SPT-P3-ISSUES: one Task's requirements; a Task that is not this project's is unknown; off: `enabled: false`. */
  async task(p: SpecProject, taskId: string): Promise<SpecResult<TraceTaskReqs>> {
    if (!this.tasksOf(p).some((x) => x.id === taskId)) return { ok: false, error: 'item' };
    const t = await this.traced(p);
    if (!t.ok) return t.error === 'off' ? { ok: true, value: { enabled: false, edges: [], nodes: [] } } : t;
    return { ok: true, value: { enabled: true, ...taskRequirements(t.value.ix, taskId) } };
  }

  // ── BRN K3: what the agent tools read besides the routes' reads ──

  /** The agent tools' answer head: the trace rev and HEAD as the 개요 has them (git read at most every SPEC_SCAN_MIN_MS). */
  async agentHead(p: SpecProject): Promise<{ rev: number; head: string | null }> {
    return { rev: this.revOf(p), head: (await this.gitSummary(p)).head };
  }

  /** The documents the owner marked 민감 (their paths) and the items they define (UIDs): the agent tools leave them out of every answer. */
  sensitive(p: SpecProject): { paths: Set<string>; uids: Set<string> } {
    const reg = this.load(p).registry;
    const docs = Object.entries(reg?.docs ?? {}).filter(([, d]) => d.sensitive);
    const ids = new Set(docs.map(([uid]) => uid));
    return {
      paths: new Set(docs.map(([, d]) => d.path)),
      uids: new Set(Object.entries(reg?.items ?? {}).flatMap(([uid, r]) => (ids.has(r.doc) ? [uid] : []))),
    };
  }

  /**
   * get_task_context's code: the files one Task's requirements reach by the 지도's paths on (the C2
   * chain, from the last code scan, the same child process as the 지도) and the top cells holding
   * them, most files first. `null`: no code scan (none wired, or it failed).
   */
  async taskCode(p: SpecProject, taskId: string, hidden: ReadonlySet<string> = new Set()): Promise<SpecResult<{ files: string[]; filesTotal: number; modules: Array<{ id: string; name: string; files: number }> } | null>> {
    const t = await this.traced(p);
    if (!t.ok) return t;
    const { reg, ix } = t.value;
    // A requirement of a document in `hidden` (the agent tools' 민감) reaches no file.
    const uids = new Set(taskRequirements(ix, taskId).nodes.filter((n) => !hidden.has(n.source?.path ?? '')).map((n) => n.id));
    const scan = await this.codeScan(p, reg);
    if (!scan) return { ok: true, value: null };
    const reqs = this.featureReqs(p, reg, ix).filter((r) => uids.has(r.uid));
    const kit = this.kitReads(p, reg);
    const links = reqLinks(scan, this.chainReqs(p, reg, ix, reqs, kit), this.now() - SPEC_MAP_RECENT_MS, this.taskTitles(ix, kit));
    if (!links) return { ok: true, value: null };
    const on = new Set(SPEC_MAP_PATHS_ON as TraceMap['pathsOn']);
    const hit = new Set<number>();
    for (const u of uids) for (const i of filesOn(links.reqs.get(u), on)) hit.add(i);
    const owned = structureOwned(scan, [], this.archLabels(p));
    const per = new Map<number, number>();
    if (owned) for (const i of hit) if (owned.owner[i] >= 0) per.set(owned.owner[i], (per.get(owned.owner[i]) ?? 0) + 1);
    const files = [...hit].map((i) => scan.files[i]).sort();
    return {
      ok: true,
      value: {
        files,
        filesTotal: files.length,
        modules: [...per].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ id: owned!.s.blocks[k].id, name: owned!.s.blocks[k].name, files: n })),
      },
    };
  }

  /** [연결 추가]'s pickers: this project's Tasks, HEAD's last commits, this project's last jobs; `q` matches the id or the title. */
  async picks(p: SpecProject, type: unknown, qIn: unknown): Promise<SpecResult<{ candidates: TracePick[] }>> {
    const q = qIn === undefined ? '' : qIn;
    if (!['task', 'commit', 'job', 'component'].includes(type as string) || typeof q !== 'string' || q.length > SPEC_QUERY_MAX) return { ok: false, error: 'value' };
    if (this.load(p).corrupt) return { ok: false, error: 'corrupt' };
    const reg = this.enabled(p);
    if (!reg) return { ok: false, error: 'off' };
    const needle = q.trim().toLowerCase();
    const hit = (c: TracePick) => !needle || c.id.toLowerCase().includes(needle) || c.label.toLowerCase().includes(needle) || !!c.title?.toLowerCase().includes(needle);
    let list: TracePick[];
    if (type === 'task') list = this.tasksOf(p).map((x) => ({ id: x.id, label: x.id, title: shown(x.title), ...(x.updatedAt && { at: x.updatedAt }) }));
    else if (type === 'job')
      list = this.jobsOf(p)
        .sort((a, b) => (a.started < b.started ? 1 : -1))
        .slice(0, SPEC_TRACE_PICK_JOBS)
        .map((j) => ({ id: j.id, label: j.id, title: shown(j.desc || j.cmd), at: j.started }));
    else if (type === 'component') {
      // One row per component: a merged one ('같은 구성요소') is picked as its root.
      const comps = this.linkComps(p, reg);
      const there = new Set(comps.map((c) => c.uid));
      const aliases = new Map(this.archOf(p).file.aliases.map((x) => [x.uid, x.into]));
      const seen = new Set<string>();
      list = comps.flatMap((c) => {
        if (seen.has(c.uid) || aliasRoot(aliases, c.uid, (u) => there.has(u)) !== c.uid) return [];
        seen.add(c.uid);
        return [{ id: c.uid, label: c.label, ...((c.source?.path ?? c.folder) && { title: c.source?.path ?? c.folder }) }];
      });
    }
    else {
      this.touchTrace(p, this.now());
      list = (await this.commitsOf(p, reg)).slice(0, SPEC_TRACE_PICK_COMMITS).map((c) => ({ id: c.sha, label: c.sha.slice(0, 7), title: c.subject, at: c.time }));
    }
    return { ok: true, value: { candidates: list.filter(hit).slice(0, SPEC_TRACE_PICK_MAX) } };
  }

  // ── Link writes: checked, on the project's queue, saved, audited by the route, specChanged ──

  /** The other end of a link, checked against this project: its Task, a commit of its repository, its job, its requirement. */
  private async endOf(p: SpecProject, reg: SpecRegistry, rel: LinkRel, to: unknown, memo: { comps?: Set<string> } = {}): Promise<NodeRef | SpecError> {
    if (typeof to !== 'string' || !to || to.length > SPEC_PATH_MAX) return 'value';
    switch (END_OF[rel]) {
      case 'task':
        return this.tasksOf(p).some((t) => t.id === to) ? { t: 'task', id: to } : 'boundary';
      case 'job':
        return this.jobsOf(p).some((j) => j.id === to) ? { t: 'job', id: to } : 'boundary';
      case 'req':
        return ITEM_UID_RE.test(to) && reg.items[to] ? { t: 'req', uid: to } : 'boundary';
      case 'commit': {
        if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(to)) return 'boundary';
        if ((await this.commitsOf(p, reg)).some((c) => c.sha === to)) return { t: 'commit', sha: to };
        const st = await this.commitState(p, reg.repo.lastHead, await this.refsPrint(p), to);
        return st.exists && st.reachable ? { t: 'commit', sha: to } : 'boundary';
      }
      case 'comp':
        // One list per write (a 500-edge confirm reads it once).
        memo.comps ??= new Set(this.linkComps(p, reg).map((c) => c.uid));
        return COMP_UID_RE.test(to) && memo.comps.has(to) ? { t: 'comp', uid: to } : 'boundary';
      default:
        return 'value'; // messages (Phase 5) are not linked yet
    }
  }

  /** One link key from a request: the requirement, the relation, the checked other end, the evidence kind. */
  private async keyOf(
    p: SpecProject,
    reg: SpecRegistry,
    b: { from?: unknown; to?: unknown; rel?: unknown; kind?: unknown },
    memo: { comps?: Set<string> } = {},
  ): Promise<SpecError | { from: string; to: NodeRef; rel: LinkRel; kind?: SpecLink['kind'] }> {
    const { from, rel, kind } = b;
    if (typeof from !== 'string' || !ITEM_UID_RE.test(from) || !(LINK_RELS as readonly unknown[]).includes(rel)) return 'value';
    if (kind !== undefined && (rel !== 'verifies' || !(EVIDENCE_KINDS as readonly unknown[]).includes(kind))) return 'value';
    if (!reg.items[from]) return 'boundary';
    const to = await this.endOf(p, reg, rel as LinkRel, b.to, memo);
    if (typeof to === 'string') return to;
    let f = from;
    let t: NodeRef = to;
    if (to.t === 'req') {
      if (to.uid === from) return 'value';
      if (to.uid < from) [f, t] = [to.uid, { t: 'req', uid: from }]; // the smaller UID is `from`
    }
    return { from: f, to: t, rel: rel as LinkRel, ...(rel === 'verifies' && { kind: (kind as SpecLink['kind']) ?? 'other' }) };
  }

  /** The links' write: checked, done on a copy, saved (0600, atomic), specChanged; the file is never written while corrupt. */
  private linkWrite<T>(p: SpecProject, write: (reg: SpecRegistry, file: LinkFile, at: string) => Promise<SpecError | T>): Promise<SpecResult<T>> {
    return this.queued(p, async () => {
      const l = this.linksOf(p);
      if (this.load(p).corrupt || l.corrupt) return { ok: false, error: 'corrupt' } as const;
      const reg = this.enabled(p);
      if (!reg) return { ok: false, error: 'off' } as const;
      const file: LinkFile = structuredClone(l.links);
      const out = await write(reg, file, new Date(this.now()).toISOString());
      if (typeof out === 'string') return { ok: false, error: out as SpecError } as const;
      file.rev++;
      if (file.history.length > SPEC_LINK_HISTORY_MAX) file.history.splice(0, file.history.length - SPEC_LINK_HISTORY_MAX);
      try {
        writeLinks(linksFile(this.deps.home, p.projectId), file);
      } catch (err) {
        console.warn(`[Agent Tycoon] spec links of ${p.name} not saved: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, error: 'save' } as const;
      }
      this.linkFiles.set(p.projectId, { links: file, corrupt: null });
      this.deps.broadcast({ type: 'specChanged', project: p.name, rev: this.revOf(p) });
      return { ok: true, value: out } as const;
    });
  }

  private static by(device: string): LinkBy {
    return { kind: 'owner', name: 'owner', device: maskText(device).slice(0, SPEC_TITLE_MAX) };
  }

  /** Confirm (or reject) each key: a decision on the same key replaces the earlier one; the basis is the requirement's version now. */
  private decide(reg: SpecRegistry, file: LinkFile, at: string, by: LinkBy, k: { from: string; to: NodeRef; rel: LinkRel; kind?: SpecLink['kind'] }, status: SpecLink['status'], action: LinkAction, note?: string): SpecLink {
    const key = linkKey(k.from, refId(k.to), k.rel);
    const old = file.links.findIndex((l) => linkKey(l.from.uid, refId(l.to), l.rel) === key);
    const r = reg.items[k.from];
    const link: SpecLink = {
      id: old >= 0 ? file.links[old].id : createLinkId(),
      from: { t: 'req', uid: k.from },
      to: k.to,
      rel: k.rel,
      status,
      by,
      at,
      basis: { textHash: r.textHash, docBlob: reg.docs[r.doc]?.blob ?? '', ...(note && { note }) },
      ...(k.kind && { kind: k.kind }),
    };
    if (old >= 0) file.links[old] = link;
    else file.links.push(link);
    file.history.push({ at, uid: k.from, action, detail: refId(k.to), by });
    if (k.to.t === 'req') file.history.push({ at, uid: k.to.uid, action, detail: k.from, by });
    return link;
  }

  private static note(v: unknown): string | undefined | null {
    if (v === undefined) return undefined;
    // Masked, then cut: masking may lengthen it (`token=a` → `token=***`) past what the stores read back.
    return typeof v === 'string' && v.length <= SPEC_LINK_NOTE_MAX ? maskText(v.trim()).slice(0, SPEC_LINK_NOTE_MAX) || undefined : null;
  }

  /** [연결 추가]: a confirmed link the owner made. */
  addLink(p: SpecProject, b: { from?: unknown; to?: unknown; rel?: unknown; kind?: unknown; note?: unknown }, device: string): Promise<SpecResult<SpecLink>> {
    return this.linkWrite(p, async (reg, file, at) => {
      const note = SpecService.note(b.note);
      if (note === null) return 'value';
      const k = await this.keyOf(p, reg, b);
      return typeof k === 'string' ? k : this.decide(reg, file, at, SpecService.by(device), k, 'confirmed', 'added', note);
    });
  }

  /**
   * RQ3 (RQW §2.5): 이 요구사항으로 이슈 만들기. The issue goes on the Task Board (its own add), then
   * one confirmed `implements` link. A link write that fails leaves the issue as it is: its title
   * names the display ID, so the trace reads it as 글에 적힘 (`linked: false` says so).
   */
  async createIssue(p: SpecProject, uid: string, b: { title?: unknown; note?: unknown; owner?: unknown }, device: string): Promise<SpecResult<{ task: string; linked: boolean }>> {
    if (!ITEM_UID_RE.test(uid)) return { ok: false, error: 'item' };
    if (this.load(p).corrupt) return { ok: false, error: 'corrupt' };
    const reg = this.enabled(p);
    if (!reg) return { ok: false, error: 'off' };
    const r = reg.items[uid];
    if (!r || r.state === 'retired' || !live(reg.docs[r.doc])) return { ok: false, error: 'item' };
    const str = (v: unknown, max: number) => (v === undefined ? '' : typeof v === 'string' && v.length <= max ? v.trim() : null);
    const title = str(b.title, SPEC_ITEM_TITLE_MAX);
    const note = str(b.note, SPEC_LINK_NOTE_MAX);
    const owner = str(b.owner, SPEC_TITLE_MAX);
    if (!title || note === null || owner === null || !this.deps.addTask) return { ok: false, error: 'value' };
    const made = this.deps.addTask({ project: p.name, title, ...(note && { note }), ...(owner && { owner }) }, device);
    if (!made.ok) return { ok: false, error: 'value' };
    this.traces.delete(p.projectId); // the new issue is read on the next trace, linked or not
    const link = await this.addLink(p, { from: uid, to: made.id, rel: 'implements' }, device).catch((err: unknown) => {
      console.warn(`[Agent Tycoon] spec link to ${made.id} of ${p.name} not saved: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false } as const;
    });
    return { ok: true, value: { task: made.id, linked: link.ok } };
  }

  /** 확인 / 모두 확인: each observed or suggested key becomes confirmed (all or none). */
  confirmLinks(p: SpecProject, b: { edges?: unknown }, device: string): Promise<SpecResult<SpecLink[]>> {
    return this.linkWrite(p, async (reg, file, at) => {
      if (!Array.isArray(b.edges) || !b.edges.length || b.edges.length > SPEC_LINK_BULK_MAX) return 'value';
      const keys = [];
      const memo = {};
      for (const e of b.edges as unknown[]) {
        const k = e && typeof e === 'object' ? await this.keyOf(p, reg, e as Record<string, unknown>, memo) : 'value';
        if (typeof k === 'string') return k;
        keys.push(k);
      }
      return keys.map((k) => this.decide(reg, file, at, SpecService.by(device), k, 'confirmed', 'confirmed'));
    });
  }

  /** 아님: stored, so the same observed or suggested link never comes back as new (it stays listed as rejected). */
  rejectLink(p: SpecProject, b: { from?: unknown; to?: unknown; rel?: unknown }, device: string): Promise<SpecResult<SpecLink>> {
    return this.linkWrite(p, async (reg, file, at) => {
      const k = await this.keyOf(p, reg, { from: b.from, to: b.to, rel: b.rel });
      if (typeof k === 'string') return k;
      const { kind: _kind, ...plain } = k; // a rejection keeps no evidence kind
      return this.decide(reg, file, at, SpecService.by(device), plain, 'rejected', 'rejected');
    });
  }

  /** 수정: a confirmed link's relation (one that names the same kind of end), evidence kind or note. */
  editLink(p: SpecProject, id: string, b: { rel?: unknown; kind?: unknown; note?: unknown }, device: string): Promise<SpecResult<SpecLink>> {
    return this.linkWrite(p, async (_reg, file, at) => {
      const l = LINK_ID_RE.test(id) ? file.links.find((x) => x.id === id) : undefined;
      if (!l) return 'link';
      const note = SpecService.note(b.note);
      const rel = b.rel ?? l.rel;
      if (
        note === null ||
        !(LINK_RELS as readonly unknown[]).includes(rel) ||
        END_OF[rel as LinkRel] !== l.to.t ||
        (b.kind !== undefined && (rel !== 'verifies' || !(EVIDENCE_KINDS as readonly unknown[]).includes(b.kind))) ||
        l.status !== 'confirmed' ||
        [b.rel, b.kind, b.note].every((v) => v === undefined)
      )
        return 'value';
      l.rel = rel as LinkRel;
      if (b.kind !== undefined) l.kind = b.kind as SpecLink['kind'];
      if (b.note !== undefined) {
        if (note) l.basis.note = note;
        else delete l.basis.note;
      }
      l.by = SpecService.by(device);
      l.at = at;
      file.history.push({ at, uid: l.from.uid, action: 'edited', detail: refId(l.to), by: l.by });
      return l;
    });
  }

  /** 해제: the record goes (a rejected one: the observed link is new again). */
  unlink(p: SpecProject, id: string, device: string): Promise<SpecResult<{ id: string }>> {
    return this.linkWrite(p, async (_reg, file, at) => {
      const i = LINK_ID_RE.test(id) ? file.links.findIndex((x) => x.id === id) : -1;
      if (i < 0) return 'link';
      const [l] = file.links.splice(i, 1);
      file.history.push({ at, uid: l.from.uid, action: 'unlinked', detail: refId(l.to), by: SpecService.by(device) });
      return { id };
    });
  }

  /** 연결 검토함 (SPT §5.4): every confirmed link of the requirement takes its version now as the basis. Acceptance is never touched (Phase 3). */
  reviewLinks(p: SpecProject, b: { uid?: unknown }, device: string): Promise<SpecResult<{ links: number }>> {
    return this.linkWrite(p, async (reg, file, at) => {
      const uid = b.uid;
      if (typeof uid !== 'string' || !ITEM_UID_RE.test(uid)) return 'value';
      const r = reg.items[uid];
      if (!r) return 'item';
      const mine = file.links.filter((l) => l.status === 'confirmed' && l.from.uid === uid && l.basis.textHash !== r.textHash);
      if (!mine.length) return 'stale';
      for (const l of mine) l.basis = { ...l.basis, textHash: r.textHash, docBlob: reg.docs[r.doc]?.blob ?? '' };
      file.history.push({ at, uid, action: 'reviewed', by: SpecService.by(device) });
      return { links: mine.length };
    });
  }

  /** 배포 확인: the owner's word that a verifies(deploy) job's deploy is live; the 배포 evidence becomes ✔. */
  deployConfirm(p: SpecProject, b: { jobId?: unknown; note?: unknown }, device: string): Promise<SpecResult<{ requirements: number }>> {
    return this.linkWrite(p, async (_reg, file, at) => {
      const note = SpecService.note(b.note);
      if (typeof b.jobId !== 'string' || note === null) return 'value';
      const jobId = b.jobId;
      const job = this.jobsOf(p).find((j) => j.id === jobId);
      if (!job) return 'boundary';
      if (job.exit !== 0) return 'value'; // a deploy that failed (or still runs) is never confirmed
      const reqs = file.links.filter((l) => l.status === 'confirmed' && l.rel === 'verifies' && l.kind === 'deploy' && l.to.t === 'job' && l.to.id === jobId).map((l) => l.from.uid);
      if (!reqs.length) return 'stale';
      const by = SpecService.by(device);
      file.deploys = [...file.deploys.filter((d) => d.job !== jobId), { job: jobId, by, at, ...(note && { note }) }];
      for (const uid of reqs) file.history.push({ at, uid, action: 'deployConfirmed', detail: jobId, by });
      return { requirements: reqs.length };
    });
  }

  // ── SPT-P3-ACCEPT: acceptance per requirement version ──

  /** The item's document as it is on disk now (checked path, regular file, size cap) and its mtime; null when gone. */
  private docNow(p: SpecProject, reg: SpecRegistry, uid: string): { text: string; mtimeMs: number } | null {
    const d = reg.docs[reg.items[uid]?.doc];
    const rel = live(d) ? this.checkDoc(p, d.path) : null;
    try {
      const file = rel ? path.join(p.folder, rel) : null;
      return file ? { mtimeMs: fs.statSync(file).mtimeMs, text: fs.readFileSync(file, 'utf-8') } : null;
    } catch {
      return null; // gone meanwhile
    }
  }

  /** The item's own block on disk now (itemSource) and the textHash extraction gives the item at its line (null: none there); null when the document is gone. */
  private blockNow(p: SpecProject, reg: SpecRegistry, uid: string): { raw: string; textHash: string | null; mtimeMs: number } | null {
    const r = reg.items[uid];
    const d = reg.docs[r.doc];
    const now = this.docNow(p, reg, uid);
    if (!now) return null;
    const opts = { kind: d.kind, mode: d.mode, depth: d.depth ?? SPEC_HEADING_DEPTH, shortIds: reg.shortIds, idPatterns: reg.idPatterns, ...kitOpt(d.path), ...shapeOpt(d.path) };
    const hit = extract(now.text, path.posix.basename(d.path), opts).find((x) => x.line === r.locator.line && x.shape === r.kind);
    return { raw: itemSource(now.text, r.locator.line, r.kind), textHash: hit?.textHash ?? null, mtimeMs: now.mtimeMs };
  }

  /**
   * 수용 판정 (SPT §5.3): one record appended for the requirement's text now, with its evidence now.
   * `version` is the detail's: the record lands only on the text the owner saw. The document is
   * scanned first (forced, after any queued write); when the item's own block on disk is not the
   * one the Registry's hash was taken from (still being written) or the version differs, it is
   * 'stale'. An edit elsewhere in the document is no reason. A settled edit the scan's unchanged
   * shortcut missed (the same size and mtime) gets that document read again once.
   * The requirement must be this project's and active; 반려 needs a note. Never touches links.
   */
  async accept(p: SpecProject, b: { uid?: unknown; state?: unknown; note?: unknown; version?: unknown }, device: string): Promise<SpecResult<AcceptanceRecord>> {
    if (this.enabled(p)) {
      await this.scan(p, true);
      const reg = this.enabled(p);
      const r = reg && typeof b.uid === 'string' && ITEM_UID_RE.test(b.uid) ? reg.items[b.uid] : undefined;
      const on = reg && r && r.state === 'active' && live(reg.docs[r.doc]) ? this.blockNow(p, reg, b.uid as string) : null;
      if (reg && r && on && on.textHash !== r.textHash && this.now() - on.mtimeMs >= SPEC_SETTLE_MS) {
        reg.docs[r.doc].mtimeMs = -1; // not 'unchanged' any more: the next scan reads it
        await this.scan(p, true);
      }
    }
    return this.queued(p, async () => {
      const a = this.acceptOf(p);
      if (this.load(p).corrupt || a.corrupt) return { ok: false, error: 'corrupt' } as const;
      const reg = this.enabled(p);
      if (!reg) return { ok: false, error: 'off' } as const;
      const { uid, state, version } = b;
      const note = SpecService.note(b.note);
      if (
        typeof uid !== 'string' ||
        !ITEM_UID_RE.test(uid) ||
        !(ACCEPTANCE_STATES as readonly unknown[]).includes(state) ||
        note === null ||
        (state === 'rejected' && !note) ||
        typeof version !== 'string' ||
        !VERSION_RE.test(version)
      )
        return { ok: false, error: 'value' } as const;
      const r = reg.items[uid];
      if (!r) return { ok: false, error: 'boundary' } as const;
      if (r.state !== 'active' || !live(reg.docs[r.doc])) return { ok: false, error: 'stale' } as const;
      const on = this.blockNow(p, reg, uid);
      if (!on || on.textHash !== r.textHash || versionOf(r.textHash, on.raw) !== version) return { ok: false, error: 'stale' } as const;
      if (a.file.records.length >= SPEC_ACCEPT_RECORDS_MAX) return { ok: false, error: 'full' } as const;
      const ix = await this.index(p, reg);
      const record: AcceptanceRecord = {
        uid,
        textHash: r.textHash,
        state: state as Acceptance,
        ...(note && { note }),
        by: SpecService.by(device),
        at: new Date(this.now()).toISOString(),
        evidence: ix.states.get(uid)?.evidence ?? { change: 'none', integration: 'none', test: 'none', deploy: 'none', reported: false },
      };
      const file: AcceptanceFile = { ...a.file, rev: a.file.rev + 1, records: [...a.file.records, record] };
      try {
        writeAcceptance(acceptanceFile(this.deps.home, p.projectId), file);
      } catch (err) {
        console.warn(`[Agent Tycoon] spec acceptance of ${p.name} not saved: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, error: 'save' } as const;
      }
      this.acceptFiles.set(p.projectId, { file, corrupt: null });
      this.deps.broadcast({ type: 'specChanged', project: p.name, rev: this.revOf(p) });
      return { ok: true, value: record } as const;
    });
  }

  // ── SPT-P4B: the owner's architecture (arch.json), checked, on the project's queue, saved, audited by the route, specChanged ──

  private archOf(p: SpecProject): LoadedArch {
    let a = this.archFiles.get(p.projectId);
    if (!a) this.archFiles.set(p.projectId, (a = readArchFile(archFile(this.deps.home, p.projectId))));
    return a;
  }

  /**
   * The folder skeleton: the top folders and one level below with their file counts, from `git
   * ls-files` (names only, capped at SPEC_GIT_MAX_BYTES) for a repository, else a bounded walk of
   * directory entries. No file is read. Listed when someone reads, kept by HEAD.
   */
  private async skeletonOf(p: SpecProject, reg: SpecRegistry): Promise<ArchFolder[]> {
    const head = reg.repo.lastHead;
    const key = head ?? `walk:${Math.floor(this.now() / SPEC_SCAN_MIN_MS)}`;
    const c = this.skeletons.get(p.projectId);
    if (c?.key === key) return c.folders;
    let folders: ArchFolder[] = [];
    try {
      if (head) {
        // The folders from the tree (small, never cut): the top ones, then those one level below; the
        // file counts from ls-files, which a very big repository cuts (then marked partial).
        const opts = { env: READ_ENV, maxBytes: SPEC_GIT_MAX_BYTES };
        const list = (r: { stdout: Buffer; code: number | null; capped?: boolean }) => (r.code === 0 || r.capped ? r.stdout.toString('utf-8').split('\0').filter(Boolean) : []);
        const tops = list(await this.run(p.folder, ['ls-tree', '-z', '-d', '--name-only', 'HEAD'], opts)).sort().slice(0, SPEC_ARCH_SKELETON_MAX);
        const subs = tops.length ? list(await this.run(p.folder, ['--literal-pathspecs', 'ls-tree', '-z', '-d', '--name-only', 'HEAD', '--', ...tops.map((t) => `${t}/`)], opts)) : [];
        const r = await this.run(p.folder, ['ls-files', '-z'], opts);
        const names = list(r);
        if (r.capped) names.pop(); // cut in the middle of one
        folders = foldersOf([...tops, ...subs], names, !!r.capped);
      } else {
        const w = walkFiles(p.folder);
        folders = foldersOf(w.dirs, w.files, w.capped);
      }
    } catch {
      /* git gone: no proposals */
    }
    this.skeletonBuilds++;
    this.skeletons.set(p.projectId, { key, folders });
    return folders;
  }

  /** An arch.json write: checked, done on a copy, history capped, size capped, saved (0600, atomic), specChanged; never while corrupt. */
  private archWrite<T>(p: SpecProject, device: string, write: (reg: SpecRegistry, a: ArchFile, log: (action: string, ...detail: string[]) => void) => SpecError | T): Promise<SpecResult<T>> {
    return this.queued(p, async () => {
      const l = this.archOf(p);
      if (this.load(p).corrupt || l.corrupt) return { ok: false, error: 'corrupt' } as const;
      const reg = this.enabled(p);
      if (!reg) return { ok: false, error: 'off' } as const;
      const file: ArchFile = structuredClone(l.file);
      const at = new Date(this.now()).toISOString();
      const by = SpecService.by(device);
      const out = write(reg, file, (action, ...detail) => file.history.push({ at, action, detail: detail.join(' ').slice(0, SPEC_PATH_MAX), by }));
      if (typeof out === 'string') return { ok: false, error: out as SpecError } as const;
      file.rev++;
      if (file.history.length > SPEC_ARCH_HISTORY_MAX) file.history.splice(0, file.history.length - SPEC_ARCH_HISTORY_MAX);
      if (!archFits(file)) return { ok: false, error: 'archFull' } as const;
      try {
        writeArchFile(archFile(this.deps.home, p.projectId), file);
      } catch (err) {
        console.warn(`[Agent Tycoon] spec arch of ${p.name} not saved: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, error: 'save' } as const;
      }
      this.archFiles.set(p.projectId, { file, corrupt: null });
      this.deps.broadcast({ type: 'specChanged', project: p.name, rev: this.revOf(p) });
      return { ok: true, value: out } as const;
    });
  }

  /** A label the owner typed: trimmed, masked, then cut to SPEC_ITEM_TITLE_MAX characters (masking may lengthen it); null when not one. */
  private static label(v: unknown): string | null {
    if (typeof v !== 'string' || v.length > SPEC_ITEM_TITLE_MAX) return null;
    return maskText(v.trim()).slice(0, SPEC_ITEM_TITLE_MAX) || null;
  }
  private static kind(v: unknown): ArchKind | null {
    return (ARCH_KINDS as readonly unknown[]).includes(v) ? (v as ArchKind) : null;
  }

  /**
   * [이 구조 승인] (SPT §8): records the diagram's version (its block's hash) the owner saw. The
   * documents are scanned first (forced, after any queued write); a block that is not that version
   * now (changed, gone, refused) is 'stale'. A document not this project's is 'boundary'.
   */
  async archApprove(p: SpecProject, b: { doc?: unknown; block?: unknown; version?: unknown }, device: string): Promise<SpecResult<ArchApproval>> {
    if (this.enabled(p)) await this.scan(p, true);
    return this.archWrite(p, device, (reg, a, log) => {
      const { doc, block, version } = b;
      if (typeof doc !== 'string' || !DOC_UID_RE.test(doc) || typeof block !== 'number' || !Number.isInteger(block) || block < 0 || typeof version !== 'string' || !VERSION_RE.test(version)) return 'value';
      if (!live(reg.docs[doc])) return 'boundary';
      const blocks = this.titles.get(p.projectId)?.get(doc)?.arch?.arch.blocks ?? [];
      const now = blocks.find((x) => x.block === block);
      if (!now || now.hash !== version) return 'stale';
      const approval: ArchApproval = { doc, block, version, at: new Date(this.now()).toISOString(), by: SpecService.by(device) };
      // Replaced: this place's approval only when no block has its version now (a diagram inserted
      // above an approved one keeps that approval). Pruned: the approvals of documents no longer tracked.
      const versionsNow = versionsByDoc(blocks.map((x) => ({ doc, version: x.hash })));
      a.approvals = [...a.approvals.filter((x) => live(reg.docs[x.doc]) && !replacedBy(x, doc, block, version, versionsNow)), approval];
      log('approved', doc, String(block), version);
      return approval;
    });
  }

  /** [구성요소 추가]: a component added by hand, with a `c_` UID from the Registry's generator. */
  archAddComp(p: SpecProject, b: { label?: unknown; kind?: unknown; note?: unknown }, device: string): Promise<SpecResult<OwnerComp>> {
    return this.archWrite(p, device, (_reg, a, log) => {
      const label = SpecService.label(b.label);
      const kind = SpecService.kind(b.kind ?? 'component');
      const note = SpecService.note(b.note);
      if (!label || !kind || note === null) return 'value';
      const c: OwnerComp = { uid: createCompUid(), label, kind, ...(note && { note }) };
      a.components.push(c);
      log('added', c.uid, kind);
      return c;
    });
  }

  /**
   * A component's label, kind or note. Added by hand: all three. An approved folder: its label and
   * kind. Read from a document: its kind only (its label is the document's). Unknown: 'comp'.
   */
  archEditComp(p: SpecProject, uid: string, b: { label?: unknown; kind?: unknown; note?: unknown }, device: string): Promise<SpecResult<{ uid: string }>> {
    return this.archWrite(p, device, (reg, a, log) => {
      if (!COMP_UID_RE.test(uid) || !knownComps(reg.components, a).has(uid)) return 'comp';
      if (b.label === undefined && b.kind === undefined && b.note === undefined) return 'value';
      const label = b.label === undefined ? undefined : SpecService.label(b.label);
      const kind = b.kind === undefined ? undefined : SpecService.kind(b.kind);
      const note = SpecService.note(b.note);
      if (label === null || kind === null || note === null) return 'value';
      const own = a.components.find((c) => c.uid === uid);
      const folder = a.skeleton.find((d) => d.uid === uid && (d.action === 'approved' || d.action === 'renamed'));
      if (own) {
        if (label) own.label = label;
        if (kind) own.kind = kind;
        if (b.note !== undefined) {
          if (note) own.note = note;
          else delete own.note;
        }
      } else {
        if (b.note !== undefined || (label && !folder)) return 'value';
        if (label && folder) Object.assign(folder, { action: 'renamed', label });
        // Pruned with it: the kinds of components no longer in the Registry or arch.json.
        if (kind) a.kinds = [...a.kinds.filter((k) => k.uid !== uid && (reg.components[k.uid] || ownUid(a, k.uid))), { uid, kind }];
      }
      log('edited', uid, ...(kind ? [kind] : []), ...(label ? ['label'] : []), ...(b.note !== undefined ? ['note'] : []));
      return { uid };
    });
  }

  /**
   * Deletes a component added by hand (only those), with its relations, its kind and the aliases
   * from or into it. A folder merged into it goes back: approved again under its own UID when it had
   * one, else proposed.
   */
  archDeleteComp(p: SpecProject, uid: string, device: string): Promise<SpecResult<{ uid: string }>> {
    return this.archWrite(p, device, (reg, a, log) => {
      if (!COMP_UID_RE.test(uid) || !knownComps(reg.components, a).has(uid)) return 'comp';
      if (!a.components.some((c) => c.uid === uid)) return 'value';
      a.components = a.components.filter((c) => c.uid !== uid);
      a.relations = a.relations.filter((r) => r.from !== uid && r.to !== uid);
      a.aliases = a.aliases.filter((x) => x.uid !== uid && x.into !== uid);
      a.kinds = a.kinds.filter((k) => k.uid !== uid);
      // ponytail: MAP-A's parents are read only since C1 but a delete still prunes them (a write); drop with the field after one release.
      a.parents = a.parents.filter((x) => x.uid !== uid && x.parent !== uid);
      a.skeleton = a.skeleton.flatMap((d): SkeletonDecision[] => (d.action !== 'merged' || d.into !== uid ? [d] : d.uid ? [{ path: d.path, action: 'approved', uid: d.uid }] : []));
      log('deleted', uid);
      return { uid };
    });
  }

  /** [관계 추가]: a composition relation between two of this project's components (the same pair again: its label replaced). */
  archAddRel(p: SpecProject, b: { from?: unknown; to?: unknown; label?: unknown }, device: string): Promise<SpecResult<OwnerRel>> {
    return this.archWrite(p, device, (reg, a, log) => {
      const { from, to } = b;
      if (typeof from !== 'string' || typeof to !== 'string' || !COMP_UID_RE.test(from) || !COMP_UID_RE.test(to) || from === to) return 'value';
      const label = b.label === undefined || b.label === '' ? undefined : SpecService.label(b.label);
      if (label === null) return 'value';
      const known = knownComps(reg.components, a);
      if (!known.has(from) || !known.has(to)) return 'boundary';
      const old = a.relations.find((r) => r.from === from && r.to === to);
      const r: OwnerRel = { id: old?.id ?? createRelId(), from, to, ...(label && { label }) };
      a.relations = [...a.relations.filter((x) => x !== old), r];
      log('related', r.id, from, to);
      return r;
    });
  }

  archDeleteRel(p: SpecProject, id: string, device: string): Promise<SpecResult<{ id: string }>> {
    return this.archWrite(p, device, (_reg, a, log) => {
      if (!REL_ID_RE.test(id) || !a.relations.some((r) => r.id === id)) return 'link';
      a.relations = a.relations.filter((r) => r.id !== id);
      log('unrelated', id);
      return { id };
    });
  }

  /** '같은 구성요소': `uid` is shown as `into` (both this project's; never into itself, directly or through other aliases). */
  archAlias(p: SpecProject, b: { uid?: unknown; into?: unknown }, device: string): Promise<SpecResult<{ uid: string; into: string }>> {
    return this.archWrite(p, device, (reg, a, log) => {
      const { uid, into } = b;
      if (typeof uid !== 'string' || typeof into !== 'string' || !COMP_UID_RE.test(uid) || !COMP_UID_RE.test(into) || uid === into) return 'value';
      const known = knownComps(reg.components, a);
      if (!known.has(uid) || !known.has(into)) return 'boundary';
      const others = new Map(a.aliases.filter((x) => x.uid !== uid).map((x) => [x.uid, x.into]));
      if (aliasRoot(others, into) === uid) return 'value'; // a cycle
      a.aliases = [...a.aliases.filter((x) => x.uid !== uid), { uid, into }];
      log('merged', uid, into);
      return { uid, into };
    });
  }

  /** Unmerge: the alias goes; the history keeps both. */
  archUnalias(p: SpecProject, uid: string, device: string): Promise<SpecResult<{ uid: string }>> {
    return this.archWrite(p, device, (_reg, a, log) => {
      const old = COMP_UID_RE.test(uid) ? a.aliases.find((x) => x.uid === uid) : undefined;
      if (!old) return 'comp';
      a.aliases = a.aliases.filter((x) => x !== old);
      log('unmerged', uid, old.into);
      return { uid };
    });
  }

  /**
   * MAP-A [제안 모두 승인]: in one write (one queue turn, one save, one specChanged), the diagrams
   * read from documents and never approved, at the versions the owner saw, and the folders proposed
   * now (approved under their own names, each with a new `c_` UID). Every record carries one batch
   * id; a diagram changed since it was shown, one approved at another version (재검토: looked at one
   * by one), or a folder no longer proposed makes the whole write 'stale'.
   */
  async archApproveAll(p: SpecProject, b: { diagrams?: unknown; folders?: unknown }, device: string): Promise<SpecResult<{ batch: string; diagrams: number; folders: number }>> {
    if (this.enabled(p)) await this.scan(p, true);
    const reg0 = this.enabled(p);
    const folders = reg0 && !this.load(p).corrupt ? await this.skeletonOf(p, reg0) : [];
    return this.archWrite(p, device, (reg, a, log) => {
      const { diagrams: ds, folders: fs_ } = b;
      if (!Array.isArray(ds) || !Array.isArray(fs_) || ds.length > SPEC_ARCH_APPROVALS_MAX || fs_.length > SPEC_ARCH_SKELETON_MAX || (!ds.length && !fs_.length)) return 'value';
      const batch = createBatchId();
      const at = new Date(this.now()).toISOString();
      const by = SpecService.by(device);
      const added: ArchApproval[] = [];
      for (const d of ds as unknown[]) {
        const { doc, block, version } = (d ?? {}) as { doc?: unknown; block?: unknown; version?: unknown };
        if (typeof doc !== 'string' || !DOC_UID_RE.test(doc) || typeof block !== 'number' || !Number.isInteger(block) || block < 0 || typeof version !== 'string' || !VERSION_RE.test(version)) return 'value';
        if (!live(reg.docs[doc])) return 'boundary';
        const blocks = this.titles.get(p.projectId)?.get(doc)?.arch?.arch.blocks ?? [];
        if (blocks.find((x) => x.block === block)?.hash !== version) return 'stale';
        if (added.some((x) => x.doc === doc && x.block === block)) continue;
        const now = versionsByDoc(blocks.map((x) => ({ doc, version: x.hash })));
        if (a.approvals.some((x) => replacedBy(x, doc, block, version, now))) return 'stale';
        added.push({ doc, block, version, at, by, batch });
      }
      const real = (asked: string) => folders.find((f) => f.path === asked) ?? folders.find((f) => maskText(f.path) === asked);
      const known = knownComps(reg.components, a);
      const decided: SkeletonDecision[] = [];
      for (const f of fs_ as unknown[]) {
        if (typeof f !== 'string' || f.length > SPEC_PATH_MAX) return 'value';
        const at_ = real(f)?.path;
        if (!at_) return 'stale';
        // A folder merged into a component that is gone is proposed again: its record may be overwritten (keeping its UID).
        const old = a.skeleton.find((x) => x.path === at_);
        if (old && !(old.action === 'merged' && old.into && !known.has(old.into))) return 'stale';
        if (!decided.some((x) => x.path === at_)) decided.push({ path: at_, action: 'approved', uid: old?.uid ?? createCompUid(), batch, at });
      }
      const paths = new Set(decided.map((d) => d.path));
      // Pruned like [이 구조 승인]'s: the approvals of documents no longer tracked.
      a.approvals = [...a.approvals.filter((x) => live(reg.docs[x.doc])), ...added];
      a.skeleton = [...a.skeleton.filter((x) => !paths.has(x.path)), ...decided];
      log('approved-all', batch, `d:${added.length}`, `f:${decided.length}`);
      return { batch, diagrams: added.length, folders: decided.length };
    });
  }

  /**
   * MAP-A [되돌리기]: one [제안 모두 승인] taken back. Its approvals go; its folders still approved
   * as it left them are proposed again (a folder renamed or merged since is the owner's own later
   * decision and stays), with the parents, kinds, aliases and relations that named them.
   */
  archUndoBatch(p: SpecProject, b: { batch?: unknown }, device: string): Promise<SpecResult<{ batch: string; kept: number }>> {
    return this.archWrite(p, device, (_reg, a, log) => {
      const { batch } = b;
      if (typeof batch !== 'string' || !BATCH_ID_RE.test(batch)) return 'value';
      const mine = a.skeleton.filter((d) => d.batch === batch && d.action === 'approved' && d.uid);
      if (!mine.length && !a.approvals.some((x) => x.batch === batch)) return 'stale';
      // A folder a later decision names (a kind, a parent, a relation, '같은 구성요소', a folder merged
      // into it, a confirmed requirement link) stays approved: taking it back would drop that decision.
      const named = new Set<string>([
        ...a.kinds.map((k) => k.uid),
        ...a.parents.flatMap((x) => [x.uid, x.parent]),
        ...a.relations.flatMap((r) => [r.from, r.to]),
        ...a.aliases.flatMap((x) => [x.uid, x.into]),
        ...a.skeleton.flatMap((d) => (d.action === 'merged' && d.into ? [d.into] : [])),
        ...this.linksOf(p).links.links.flatMap((l) => (l.status === 'confirmed' && l.to.t === 'comp' ? [l.to.uid] : [])),
      ]);
      const kept = mine.filter((d) => named.has(d.uid!));
      const gone = new Set(mine.filter((d) => !named.has(d.uid!)).map((d) => d.uid!));
      a.approvals = a.approvals.filter((x) => x.batch !== batch);
      a.skeleton = a.skeleton.flatMap((d): SkeletonDecision[] => {
        if (d.batch === batch && d.action === 'approved') {
          if (d.uid && gone.has(d.uid)) return [];
          const { batch: _b, at: _a, ...rest } = d; // kept: the owner's own approval from now on
          return [rest];
        }
        // As archDeleteComp does: a folder merged into one that goes is approved again under its own UID, else proposed.
        if (d.action === 'merged' && d.into && gone.has(d.into)) return d.uid ? [{ path: d.path, action: 'approved', uid: d.uid }] : [];
        return [d];
      });
      log('unapproved-all', batch, `kept:${kept.length}`, ...kept.map((d) => d.uid!));
      return { batch, kept: kept.length };
    });
  }

  /**
   * A skeleton folder's decision: [승인] (a component with a UID), [이름 바꾸기] (approved under a
   * label), [합치기] (into an existing component), [빼기] (hidden). The folder must be proposed now
   * or decided before (else 'stale'). A folder that had a UID keeps it through every decision.
   */
  async archSkeleton(p: SpecProject, b: { path?: unknown; action?: unknown; label?: unknown; into?: unknown }, device: string): Promise<SpecResult<SkeletonDecision>> {
    const reg = this.enabled(p);
    const folders = reg && !this.load(p).corrupt ? await this.skeletonOf(p, reg) : [];
    return this.archWrite(p, device, (regNow, a, log) => {
      const { path: asked, action } = b;
      if (typeof asked !== 'string' || asked.length > SPEC_PATH_MAX || !(SKELETON_ACTIONS as readonly unknown[]).includes(action)) return 'value';
      // The page shows folder names masked: a name that was masked is matched to the real one.
      const real = (list: Array<{ path: string }>) => list.find((x) => x.path === asked) ?? list.find((x) => maskText(x.path) === asked);
      const at = real(a.skeleton)?.path ?? real(folders)?.path;
      if (!at) return 'stale';
      const old = a.skeleton.find((d) => d.path === at);
      const uid = old?.uid;
      let d: SkeletonDecision;
      switch (action as ArchSkeletonAction) {
        case 'approved':
          d = { path: at, action: 'approved', uid: uid ?? createCompUid() };
          break;
        case 'renamed': {
          const label = SpecService.label(b.label);
          if (!label) return 'value';
          d = { path: at, action: 'renamed', uid: uid ?? createCompUid(), label };
          break;
        }
        case 'merged': {
          const into = b.into;
          if (typeof into !== 'string' || !COMP_UID_RE.test(into) || into === uid) return 'value';
          if (!knownComps(regNow.components, a).has(into)) return 'boundary';
          d = { path: at, action: 'merged', ...(uid && { uid }), into };
          break;
        }
        default:
          d = { path: at, action: 'removed', ...(uid && { uid }) };
      }
      a.skeleton = [...a.skeleton.filter((x) => x !== old), d];
      log(`skeleton-${d.action}`, at, ...(d.uid ? [d.uid] : []), ...(d.into ? [d.into] : []));
      return d;
    });
  }
}

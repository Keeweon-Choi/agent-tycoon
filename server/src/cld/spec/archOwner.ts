/**
 * SPT-P4B (SPT §8, §4.1): the owner's architecture, `<settings directory>/spec/<projectId>/arch.json`
 * (0600 in 0700, tmp + rename, `v:1`, at most SPEC_ARCH_FILE_MAX_BYTES; the daemon is the only
 * writer; backed up by name; purged with the project's spec folder). It holds the owner's decisions
 * only: approvals per diagram (the block's hash), kinds, components and relations added by hand,
 * '같은 구성요소' aliases, the folder skeleton's decisions, and an append-only, capped history. A file
 * this store cannot read is `corrupt`: left as it is, never written over, every write refused.
 *
 * Also here, pure: the folder skeleton (names and file counts from a path list, never a file's
 * contents) and applyOwner, which lays the owner's decisions over the architecture read from the
 * documents.
 */
import * as fs from 'fs';
import * as path from 'path';

import { ARCH_KINDS, type ArchEdge, type ArchKind, type ArchNode, type ArchSkeletonAction, type TraceArch } from '../../../../core/src/cld/spec/trace.js';
import {
  SPEC_ARCH_ALIASES_MAX,
  SPEC_ARCH_APPROVALS_MAX,
  SPEC_ARCH_DECISIONS_MAX,
  SPEC_ARCH_FILE_MAX_BYTES,
  SPEC_ARCH_HISTORY_MAX,
  SPEC_ARCH_KINDS_MAX,
  SPEC_ARCH_OWNER_COMPS_MAX,
  SPEC_ARCH_OWNER_RELS_MAX,
  SPEC_ARCH_PARENTS_MAX,
  SPEC_ARCH_SKELETON_MAX,
  SPEC_ITEM_TITLE_MAX,
  SPEC_LINK_NOTE_MAX,
  SPEC_PATH_MAX,
  SPEC_SKIP_DIRS,
  SPEC_WALK_DEPTH_MAX,
  SPEC_WALK_DIRS_MAX,
  SPEC_WALK_FILES_MAX,
} from '../../constants.js';
import { opaqueId } from '../engine/registry.js';
import { forbiddenFilePath } from '../files/security.js';
import { readJson } from '../jsonFile.js';
import { maskText } from '../mask.js';
import { SKIP_DIRS } from '../tracking/settings.js';
import { type LinkBy, writeSpecJson } from './links.js';
import { COMP_UID_RE, DOC_UID_RE, specDirectory } from './store.js';

export const ARCH_VERSION = 1;
export const REL_ID_RE = /^e_[a-z2-7]{10}$/;
/** MAP-A: one [제안 모두 승인]'s id, on each approval and folder decision it made ([되돌리기] takes them back). */
export const BATCH_ID_RE = /^b_[a-z2-7]{10}$/;
export const SKELETON_ACTIONS = ['approved', 'renamed', 'merged', 'removed'] as const satisfies readonly ArchSkeletonAction[];
const VERSION_RE = /^[0-9a-f]{16}$/;

export interface ArchApproval {
  doc: string;
  block: number;
  /** The block's hash when approved. */
  version: string;
  at: string;
  by: LinkBy;
  /** MAP-A: made by this [제안 모두 승인]. */
  batch?: string;
}
export interface OwnerComp {
  uid: string;
  label: string;
  kind: ArchKind;
  note?: string;
}
/** Composition only. */
export interface OwnerRel {
  id: string;
  from: string;
  to: string;
  label?: string;
}
/**
 * A skeleton folder's decision. `uid` is the folder's own component (approved or renamed; kept when
 * it is later removed or merged, so approving it again brings the same UID back); `into` is the
 * component a merged folder went into.
 */
export interface SkeletonDecision {
  path: string;
  action: ArchSkeletonAction;
  uid?: string;
  label?: string;
  into?: string;
  /** MAP-A: made by this [제안 모두 승인], at this time. */
  batch?: string;
  at?: string;
}
export interface ArchEvent {
  at: string;
  action: string;
  /** UIDs, ids, kinds and paths only: never a label or a note. */
  detail: string;
  by: LinkBy;
}
export interface ArchFile {
  v: typeof ARCH_VERSION;
  /** Bumped on every save; `specChanged` carries it with the Registry's, the links' and the acceptance records'. */
  rev: number;
  approvals: ArchApproval[];
  kinds: Array<{ uid: string; kind: ArchKind }>;
  components: OwnerComp[];
  relations: OwnerRel[];
  aliases: Array<{ uid: string; into: string }>;
  skeleton: SkeletonDecision[];
  /** MAP-A: the owner's parent of a component (both `c_` UIDs); over a document's subgraph and the folder skeleton. */
  parents: Array<{ uid: string; parent: string }>;
  history: ArchEvent[];
}
export type LoadedArch = { file: ArchFile; corrupt: string | null };

export const archFile = (home: string, projectId: string): string => path.join(specDirectory(home, projectId), 'arch.json');
export const createRelId = (): string => opaqueId('e');
export const createBatchId = (): string => opaqueId('b');
export const emptyArch = (): ArchFile => ({ v: ARCH_VERSION, rev: 0, approvals: [], kinds: [], components: [], relations: [], aliases: [], skeleton: [], parents: [], history: [] });

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const optStr = (v: unknown, max: number) => v === undefined || str(v, max);
const isKind = (v: unknown): v is ArchKind => (ARCH_KINDS as readonly unknown[]).includes(v);
const comp = (v: unknown) => typeof v === 'string' && COMP_UID_RE.test(v);
const batchOk = (v: unknown) => v === undefined || (typeof v === 'string' && BATCH_ID_RE.test(v));
const validBy = (b: unknown) => isObject(b) && (b.kind === 'owner' || b.kind === 'agent') && str(b.name, SPEC_ITEM_TITLE_MAX) && optStr(b.device, SPEC_ITEM_TITLE_MAX);
/** Each list: its record check and its cap. A record that fails, or a list past its cap, makes the file corrupt. */
const LISTS: Record<Exclude<keyof ArchFile, 'v' | 'rev'>, [(r: Record<string, unknown>) => boolean, number]> = {
  approvals: [(r) => str(r.doc, 16) && DOC_UID_RE.test(r.doc as string) && Number.isInteger(r.block) && (r.block as number) >= 0 && str(r.version, 16) && VERSION_RE.test(r.version as string) && str(r.at, 40) && validBy(r.by) && batchOk(r.batch), SPEC_ARCH_APPROVALS_MAX],
  kinds: [(r) => comp(r.uid) && isKind(r.kind), SPEC_ARCH_KINDS_MAX],
  components: [(r) => comp(r.uid) && str(r.label, SPEC_ITEM_TITLE_MAX) && !!r.label && isKind(r.kind) && optStr(r.note, SPEC_LINK_NOTE_MAX), SPEC_ARCH_OWNER_COMPS_MAX],
  relations: [(r) => str(r.id, 12) && REL_ID_RE.test(r.id as string) && comp(r.from) && comp(r.to) && optStr(r.label, SPEC_ITEM_TITLE_MAX), SPEC_ARCH_OWNER_RELS_MAX],
  aliases: [(r) => comp(r.uid) && comp(r.into), SPEC_ARCH_ALIASES_MAX],
  skeleton: [
    (r) => str(r.path, SPEC_PATH_MAX) && (SKELETON_ACTIONS as readonly unknown[]).includes(r.action) && (r.uid === undefined || comp(r.uid)) && (r.into === undefined || comp(r.into)) && optStr(r.label, SPEC_ITEM_TITLE_MAX) && batchOk(r.batch) && optStr(r.at, 40),
    SPEC_ARCH_DECISIONS_MAX,
  ],
  parents: [(r) => comp(r.uid) && comp(r.parent) && r.uid !== r.parent, SPEC_ARCH_PARENTS_MAX],
  history: [(r) => str(r.at, 40) && str(r.action, 40) && str(r.detail, SPEC_PATH_MAX) && validBy(r.by), SPEC_ARCH_HISTORY_MAX],
};

/** The project's architecture decisions (none yet: empty); corrupt (why) when the file is not one, then an empty view that is never saved. */
export function readArchFile(file: string): LoadedArch {
  let raw: unknown;
  try {
    // Never read a file past the cap into memory (a hand-made megabyte file is not ours).
    if (fs.statSync(file).size > SPEC_ARCH_FILE_MAX_BYTES) return { file: emptyArch(), corrupt: 'too big' };
    raw = readJson(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { file: emptyArch(), corrupt: null };
    return { file: emptyArch(), corrupt: err instanceof Error ? err.message : String(err) };
  }
  if (raw === null) return { file: emptyArch(), corrupt: null };
  if (!isObject(raw) || raw.v !== ARCH_VERSION || typeof raw.rev !== 'number') return { file: emptyArch(), corrupt: `not a v${ARCH_VERSION} arch file` };
  const out = emptyArch();
  out.rev = raw.rev;
  for (const [name, [valid, max]] of Object.entries(LISTS)) {
    const list = raw[name] ?? [];
    if (!Array.isArray(list) || list.length > max) return { file: emptyArch(), corrupt: `a bad ${name} list` };
    const bad = list.findIndex((r) => !isObject(r) || !valid(r));
    if (bad >= 0) return { file: emptyArch(), corrupt: `a bad ${name} record (#${bad})` };
    (out as unknown as Record<string, unknown[]>)[name] = list;
  }
  return { file: out, corrupt: null };
}

/**
 * False when `a` is something readArchFile would refuse (a record that fails its check, a list past
 * its cap) or past SPEC_ARCH_FILE_MAX_BYTES: the write is refused. Never write what read would reject.
 */
export function archFits(a: ArchFile): boolean {
  for (const [name, [valid, max]] of Object.entries(LISTS)) {
    const list = a[name as keyof typeof LISTS] as unknown[];
    if (list.length > max || !list.every((r) => isObject(r) && valid(r))) return false;
  }
  return Buffer.byteLength(JSON.stringify(a), 'utf-8') + 1 <= SPEC_ARCH_FILE_MAX_BYTES;
}
export const writeArchFile = (file: string, a: ArchFile): void => writeSpecJson(file, a);

// ── The folder skeleton: names and counts only ──

export interface ArchFolder {
  /** `server/` or `server/src/`. */
  path: string;
  files: number;
  /** The file listing was cut: `files` is at least that many. */
  partial?: true;
}
const SKIP = new Set([...SKIP_DIRS, ...SPEC_SKIP_DIRS]);
const skipped = (name: string) => name.startsWith('.') || SKIP.has(name);

/**
 * The top folders and one level below (`dirs`: `top` and `top/sub`, `/`-separated, relative to the
 * project folder), each with the files under it counted from `files` (`partial` when that listing
 * was cut). Hidden and skipped folders are left out. At most SPEC_ARCH_SKELETON_MAX: the top folders
 * first, then those below in path order; sorted by path.
 */
export function foldersOf(dirs: Iterable<string>, files: Iterable<string>, partial = false): ArchFolder[] {
  const tops: string[] = [];
  const subs: string[] = [];
  for (const d of dirs) {
    const parts = d.split('/');
    if (parts.length > 2 || parts.some((x) => !x || skipped(x)) || forbiddenFilePath(`${d}/`)) continue;
    (parts.length === 1 ? tops : subs).push(`${d}/`);
  }
  const top = [...new Set(tops)].sort().slice(0, SPEC_ARCH_SKELETON_MAX);
  const topSet = new Set(top);
  const sub = [...new Set(subs)].sort().filter((k) => topSet.has(`${k.split('/')[0]}/`)).slice(0, SPEC_ARCH_SKELETON_MAX - top.length);
  const count = new Map([...top, ...sub].map((k) => [k, 0]));
  const bump = (k: string) => count.has(k) && count.set(k, count.get(k)! + 1);
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length < 2) continue;
    bump(`${parts[0]}/`);
    if (parts.length >= 3) bump(`${parts[0]}/${parts[1]}/`);
  }
  return [...count.keys()].sort().map((k) => ({ path: k, files: count.get(k)!, ...(partial && { partial: true as const }) }));
}

/** The folders of a path list (each file's top folder and the one below it): for a list that is whole. */
export const dirsOf = (files: Iterable<string>): string[] =>
  [...files].flatMap((f) => {
    const parts = f.split('/');
    return parts.length < 2 ? [] : parts.length === 2 ? [parts[0]] : [parts[0], `${parts[0]}/${parts[1]}`];
  });

/**
 * A folder that is no repository: its top folders and one level below from their own directory
 * entries (never cut by the file cap), and its file paths from a bounded walk (SPEC_WALK_DIRS_MAX
 * folders, SPEC_WALK_FILES_MAX files, SPEC_WALK_DEPTH_MAX deep; `capped` when cut). No file is
 * opened, no link followed.
 */
export function walkFiles(folder: string): { dirs: string[]; files: string[]; capped: boolean } {
  const read = (rel: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(path.join(folder, rel), { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const tops = read('')
    .filter((e) => e.isDirectory() && !skipped(e.name))
    .map((e) => e.name)
    .sort()
    .slice(0, SPEC_ARCH_SKELETON_MAX);
  const dirs = [...tops, ...tops.flatMap((t) => read(t).filter((e) => e.isDirectory() && !skipped(e.name)).map((e) => `${t}/${e.name}`))];
  const files: string[] = [];
  let walked = 0;
  let capped = false;
  const walk = (rel: string, depth: number) => {
    if (capped) return;
    if (++walked > SPEC_WALK_DIRS_MAX) return void (capped = true);
    for (const e of read(rel)) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skipped(e.name) && depth < SPEC_WALK_DEPTH_MAX) walk(next, depth + 1);
      } else if (e.isFile() && rel) {
        if (files.length >= SPEC_WALK_FILES_MAX) return void (capped = true);
        files.push(next);
      }
      if (capped) return;
    }
  };
  walk('', 0);
  return { dirs, files, capped };
}

// ── The owner's decisions over what the documents say ──

/** The components the owner may name: active ones read from the documents, those added by hand, approved folders. */
export function knownComps(docComps: Record<string, { state: string }>, a: ArchFile): Set<string> {
  const out = new Set(Object.keys(docComps).filter((u) => docComps[u].state === 'active'));
  for (const c of a.components) out.add(c.uid);
  for (const d of a.skeleton) if (d.uid && (d.action === 'approved' || d.action === 'renamed')) out.add(d.uid);
  return out;
}

/** A UID arch.json itself gives: a component added by hand or a folder's. */
export const ownUid = (a: ArchFile, uid: string): boolean => a.components.some((c) => c.uid === uid) || a.skeleton.some((d) => d.uid === uid);

/**
 * Where `uid` ends after its aliases (itself when none): the last component along the chain that
 * `exists` (a link gone in the middle or at the end does not break the merge). A visited set ends a
 * cycle a hand-made file could hold.
 */
export function aliasRoot(aliases: ReadonlyMap<string, string>, uid: string, exists: (uid: string) => boolean = () => true): string {
  const seen = new Set<string>();
  let at = uid;
  let last = uid;
  while (aliases.has(at) && !seen.has(at) && seen.size < SPEC_ARCH_ALIASES_MAX) {
    seen.add(at);
    at = aliases.get(at)!;
    if (exists(at)) last = at;
  }
  return last;
}

/** Approvals of this document whose version no block of it has now (doc → those versions are gone). */
const goneVersion = (approval: { doc: string; version: string }, versionsNow: ReadonlyMap<string, ReadonlySet<string>>) => !versionsNow.get(approval.doc)?.has(approval.version);
/** Each document's block versions now. */
export function versionsByDoc(diagrams: ReadonlyArray<{ doc: string; version: string }>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const d of diagrams) {
    if (!out.has(d.doc)) out.set(d.doc, new Set());
    out.get(d.doc)!.add(d.version);
  }
  return out;
}
/** An approval a new one at (doc, block) replaces: the same place and a version no block of the document has now, or the same version. */
export const replacedBy = (x: { doc: string; block: number; version: string }, doc: string, block: number, version: string, versionsNow: ReadonlyMap<string, ReadonlySet<string>>): boolean =>
  x.doc === doc && (x.version === version || (x.block === block && goneVersion(x, versionsNow)));

/**
 * MAP-A: the newest [제안 모두 승인] whose records are still there, for [되돌리기]: read from the
 * records' own batch and time (never from the history, which keeps only its newest lines).
 */
export function lastBatch(a: ArchFile): { id: string; at: string; diagrams: number; folders: number } | undefined {
  const all = [...a.approvals.map((x) => ({ batch: x.batch, at: x.at, d: 1, f: 0 })), ...a.skeleton.map((x) => ({ batch: x.action === 'approved' ? x.batch : undefined, at: x.at ?? '', d: 0, f: 1 }))];
  let id: string | undefined;
  let at = '';
  for (const x of all) if (x.batch && x.at >= at) [id, at] = [x.batch, x.at];
  if (!id) return undefined;
  const mine = all.filter((x) => x.batch === id);
  return { id, at, diagrams: mine.reduce((n, x) => n + x.d, 0), folders: mine.reduce((n, x) => n + x.f, 0) };
}

/** A proposed folder's node id (it has no UID until approved). */
export const proposedId = (folder: string): string => `f:${folder}`;

/**
 * The architecture with the owner's decisions laid over it: each diagram's standing (approved: an
 * approval of this document has its version now; review: this block was approved at another
 * version; doc otherwise) and its components'; kinds; components added by hand; the skeleton's
 * folders (proposed, approved, merged into a component, removed); aliases (a component merged into
 * another: its node goes, its sources and edges move to the target); relations added by hand; the
 * counts. Linear in what it is given, every list of which is capped.
 */
export function applyOwner(base: TraceArch, a: ArchFile, folders: readonly ArchFolder[]): TraceArch {
  // review: an approval of this place whose version no block of the document has now (a diagram
  // inserted above an approved one moves it, it does not change it).
  const now = versionsByDoc(base.diagrams);
  const exact = new Map(a.approvals.map((x) => [`${x.doc}|${x.version}`, x]));
  const byBlock = new Map(a.approvals.filter((x) => goneVersion(x, now)).map((x) => [`${x.doc}|${x.block}`, x]));
  const diagrams = base.diagrams.map((d) => {
    const hit = exact.get(`${d.doc}|${d.version}`);
    const old = byBlock.get(`${d.doc}|${d.block}`);
    return hit ? { ...d, standing: 'approved' as const, approvedAt: hit.at } : old ? { ...d, standing: 'review' as const, approvedAt: old.at } : d;
  });
  const standingOf = new Map(diagrams.map((d) => [d.id, d.standing]));
  const kinds = new Map(a.kinds.map((k) => [k.uid, k.kind]));
  const nodes = new Map<string, ArchNode>();
  for (const n of base.nodes) nodes.set(n.id, { ...n, kind: kinds.get(n.id) ?? n.kind, standing: (n.diagram && standingOf.get(n.diagram)) || 'doc' });
  for (const c of a.components) nodes.set(c.uid, { id: c.uid, label: c.label, kind: c.kind, from: 'owner', standing: 'approved', sources: [], ...(c.note && { note: c.note }) });
  // The skeleton: a decided folder by its decision (an approved one shows even when the folder is gone); the rest proposed.
  const decided = new Map(a.skeleton.map((d) => [d.path, d]));
  const into: Array<[string, string]> = [];
  // Folder names are the repository's: masked like every text sent (the decisions keep the real path).
  const shown = (p: string) => maskText(p);
  for (const d of a.skeleton)
    if (d.uid && (d.action === 'approved' || d.action === 'renamed'))
      nodes.set(d.uid, { id: d.uid, label: d.label ?? shown(d.path), kind: kinds.get(d.uid) ?? 'component', from: 'folder', standing: 'approved', sources: [], folder: shown(d.path) });
    else if (d.action === 'merged' && d.into) into.push([d.into, d.path]);
  const byPath = new Map(folders.map((f) => [f.path, f]));
  const files = (p: string) => {
    const f = byPath.get(p);
    return f ? { files: f.files, ...(f.partial && { filesPartial: true as const }) } : {};
  };
  for (const d of a.skeleton) if (d.uid && nodes.get(d.uid)?.from === 'folder') Object.assign(nodes.get(d.uid)!, files(d.path));
  const removedTop = (p: string) => decided.get(`${p.split('/')[0]}/`)?.action === 'removed';
  const propose = (f: ArchFolder) => {
    if (!removedTop(f.path)) nodes.set(proposedId(shown(f.path)), { id: proposedId(shown(f.path)), label: shown(f.path), kind: 'component', from: 'folder', standing: 'proposed', sources: [], folder: shown(f.path), ...files(f.path) });
  };
  for (const f of folders) if (!decided.has(f.path)) propose(f);
  // '같은 구성요소': each alias to its root (the last component along its chain that is there), worked
  // out before any node goes; the root takes the sources, the label of what went in, and its edges.
  const aliasOf = new Map(a.aliases.map((x) => [x.uid, x.into]));
  const remap = new Map<string, string>();
  for (const { uid } of a.aliases) {
    const root = aliasRoot(aliasOf, uid, (u) => nodes.has(u));
    if (root !== uid && nodes.has(uid)) remap.set(uid, root);
  }
  for (const [uid, root] of remap) {
    const from = nodes.get(uid)!;
    const to = nodes.get(root)!;
    (to.merged ??= []).push({ id: uid, label: from.label });
    to.sources = [...to.sources, ...from.sources];
    if (from.folder) (to.folders ??= []).push(from.folder);
  }
  for (const uid of remap.keys()) nodes.delete(uid);
  // A folder merged into a component that is gone is proposed again (it can be decided anew).
  for (const [uid, p] of into) {
    const n = nodes.get(remap.get(uid) ?? uid);
    if (n) (n.folders ??= []).push(shown(p));
    else if (byPath.has(p)) propose(byPath.get(p)!);
  }
  const end = (id: string) => remap.get(id) ?? id;
  const there = new Set([...nodes.keys(), ...base.groups.map((g) => g.id)]);
  const edges = new Map<string, ArchEdge>();
  const add = (e: ArchEdge) => {
    const key = `${e.layer}|${e.from}|${e.to}`;
    if (e.from !== e.to && there.has(e.from) && there.has(e.to) && !edges.has(key)) edges.set(key, e);
  };
  for (const e of base.edges) add(e.from === end(e.from) && e.to === end(e.to) ? e : { ...e, from: end(e.from), to: end(e.to) });
  for (const r of a.relations) add({ id: r.id, from: end(r.from), to: end(r.to), layer: 'composition', ...(r.label && { label: r.label }), owner: true });
  const list = [...nodes.values()];
  const n = (s: ArchNode['standing']) => list.filter((x) => x.standing === s).length;
  return { ...base, nodes: list, edges: [...edges.values()], diagrams, // ponytail: the components past the drawing cap (`hidden`) count as read from documents whatever their diagram's standing; count them by diagram if a 200-node project ever approves.
    counts: { approved: n('approved'), proposed: n('proposed'), fromDocs: n('doc') + n('review') + (base.hidden ?? 0) } };
}

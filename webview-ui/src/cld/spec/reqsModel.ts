/**
 * RQ2 (RQW §2.2), pure: the merged 요구사항 tab's tree, 문서 → 기능 → 요구사항. Each row's state is
 * core's reqState (RQ1) on the list's trace; a feature is the daemon's featuresOf (the items'
 * `feature`); a tool's folders (Spec Kit `specs/`, OpenSpec, Kiro) make one document row. A display
 * ID in two documents shows in both (the document is the source) and counts once.
 */
import {
  reqState,
  reqStateCounts,
  type ReqStateView,
  type ReqStatus,
} from '../../../../core/src/cld/spec/reqState.js';
import type { TraceState } from '../../../../core/src/cld/spec/trace.js';

export type DocKind =
  'requirements' | 'design' | 'decision' | 'test' | 'task' | 'plan' | 'other' | 'log';
export type DocMode = 'auto' | 'headings' | 'off' | 'refs';
export type GitState = 'committed' | 'modified' | 'untracked' | 'ignored' | 'not-git';
export type FeatureRule = 'speckit' | 'fm' | 'prefix' | 'folder' | 'kiro' | 'openspec' | 'common';

export interface DocRow {
  uid: string;
  path: string;
  kind: DocKind;
  mode: DocMode;
  depth: number;
  tracked: boolean;
  state: 'active' | 'retired' | 'unresolved';
  git: GitState;
  changedAt: string;
  size: number;
  mtimeMs: number;
  fresh: boolean;
  sensitive: boolean;
  items: number;
}
export interface ItemRow {
  uid: string;
  displayId?: string;
  title: string;
  section: string;
  doc: string;
  docUid: string;
  kind: DocKind;
  shape?: string;
  state: 'active' | 'retired' | 'unresolved';
  line: number;
  trace?: TraceState;
  feature?: { key: string; name: string; rule: FeatureRule; changing?: true };
}

export interface TreeReq {
  row: ItemRow;
  view: ReqStateView;
}
export interface TreeFeature {
  key: string;
  name: string;
  /** What follows the name, muted: the prefix (`TRC`), the common prefixes (`NFR · IR · CON`). */
  tail: string;
  rule: FeatureRule;
  reqs: TreeReq[];
  counts: Record<ReqStatus, number>;
}
export interface TreeDoc {
  key: string;
  label: string;
  /** The documents behind the row (one, or a tool's feature folders). */
  docs: DocRow[];
  tool?: 'speckit' | 'openspec' | 'kiro';
  features: TreeFeature[];
  total: number;
  counts: Record<ReqStatus, number>;
}

const TOOLS = { speckit: 'specs/', openspec: 'openspec/', kiro: '.kiro/specs/' } as const;
type Tool = keyof typeof TOOLS;
const isTool = (r?: string): r is Tool => r === 'speckit' || r === 'openspec' || r === 'kiro';
export const COMMON_KEY = 'common';
export const NO_FEATURE_KEY = '';
export const baseName = (p: string) => p.split('/').pop() ?? p;
/** One requirement, however many documents repeat it. */
const once = (r: ItemRow) => r.displayId || r.uid;

/** Every row's state, by UID. */
export const viewsOf = (rows: readonly ItemRow[]) =>
  new Map(rows.map((r) => [r.uid, reqState(r.trace)] as const));

/** The head's counts: each requirement once. */
export function headCounts(
  rows: readonly ItemRow[],
  views: ReadonlyMap<string, ReqStateView>,
): { total: number } & Record<ReqStatus, number> {
  const seen = new Map<string, ReqStatus>();
  for (const r of rows)
    if (r.state !== 'retired' && !seen.has(once(r))) seen.set(once(r), views.get(r.uid)!.status);
  return { total: seen.size, ...reqStateCounts(seen.values()) };
}

/** The tree. `docs`: the tracked requirements documents, so one with no requirement still shows (its empty row says what to do). */
export function buildTree(
  rows: readonly ItemRow[],
  views: ReadonlyMap<string, ReqStateView>,
  docs: readonly DocRow[],
): TreeDoc[] {
  const docOf = new Map(docs.map((d) => [d.uid, d] as const));
  const out = new Map<string, TreeDoc>();
  const doc = (key: string, label: string, tool?: Tool) => {
    let d = out.get(key);
    if (!d)
      out.set(
        key,
        (d = {
          key,
          label,
          docs: [],
          ...(tool && { tool }),
          features: [],
          total: 0,
          counts: { todo: 0, doing: 0, done: 0 },
        }),
      );
    return d;
  };
  for (const d of docs)
    if (d.kind === 'requirements' && d.tracked && d.state !== 'retired')
      doc(d.uid, baseName(d.path));
  for (const row of rows) {
    const f = row.feature;
    const tool = isTool(f?.rule) ? f.rule : undefined;
    const d = tool ? doc(`tool:${tool}`, TOOLS[tool], tool) : doc(row.docUid, baseName(row.doc));
    const dr = docOf.get(row.docUid);
    if (dr && !d.docs.includes(dr)) d.docs.push(dr);
    const key = f?.rule === 'common' ? COMMON_KEY : (f?.key ?? NO_FEATURE_KEY);
    let feat = d.features.find((x) => x.key === key);
    if (!feat) {
      const tail = f?.rule === 'prefix' ? (f.key.split('-').pop() ?? '') : '';
      d.features.push(
        (feat = {
          key,
          name: f?.rule === 'common' ? '' : (f?.name ?? ''),
          tail,
          rule: f?.rule ?? 'folder',
          reqs: [],
          counts: { todo: 0, doing: 0, done: 0 },
        }),
      );
    }
    if (f?.rule === 'common' && !feat.tail.split(' · ').includes(f.key))
      feat.tail = [feat.tail, f.key].filter(Boolean).join(' · ');
    const view = views.get(row.uid)!;
    feat.reqs.push({ row, view });
    if (row.state !== 'retired') {
      feat.counts[view.status]++;
      d.counts[view.status]++;
      d.total++;
    }
  }
  for (const d of out.values()) {
    // 모든 기능 공통 and what has no feature go last, the rest in the documents' order.
    d.features.sort(
      (a, b) =>
        Number(a.key === COMMON_KEY || a.key === NO_FEATURE_KEY) -
        Number(b.key === COMMON_KEY || b.key === NO_FEATURE_KEY),
    );
    if (!d.docs.length) d.docs.push(...docs.filter((x) => x.uid === d.key));
  }
  // A tool folder's document shows under the tool's row only.
  const inTool = new Set(
    [...out.values()].flatMap((d) => (d.tool ? d.docs.map((x) => x.uid) : [])),
  );
  return [...out.values()]
    .filter((d) => d.tool || d.total || !inTool.has(d.key))
    .sort((a, b) => b.total - a.total);
}

/** Keep the rows `keep` says yes to; a feature or a document with none left goes. */
export function filterTree(tree: readonly TreeDoc[], keep: (r: TreeReq) => boolean): TreeDoc[] {
  return tree.flatMap((d) => {
    const features = d.features.flatMap((f) => {
      const reqs = f.reqs.filter(keep);
      return reqs.length ? [{ ...f, reqs }] : [];
    });
    return features.length ? [{ ...d, features }] : [];
  });
}

/** How a document is read (RQW §4's 읽는 법 tag): set by the owner, a tool's shape, else its items' most common shape. */
export type ReadHow =
  | 'headings'
  | 'refs'
  | 'speckit'
  | 'openspec'
  | 'kiro'
  | 'row'
  | 'heading'
  | 'check'
  | 'fm'
  | 'none';
export function readHow(d: TreeDoc | undefined, doc: DocRow | undefined): ReadHow {
  if (doc?.mode === 'headings' || doc?.mode === 'refs') return doc.mode;
  if (d?.tool) return d.tool;
  const n = new Map<string, number>();
  for (const f of d?.features ?? [])
    for (const r of f.reqs) if (r.row.shape) n.set(r.row.shape, (n.get(r.row.shape) ?? 0) + 1);
  const top = [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top === 'row' || top === 'check' || top === 'fm'
    ? top
    : top === 'heading' || top === 'reqhead'
      ? 'heading'
      : top === 'bullet'
        ? 'speckit'
        : 'none';
}

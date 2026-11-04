/**
 * SPT-P3-GRAPH: the one module that knows the spec trace API's URLs (spt-p2-engine §6-7) and the
 * shapes the contract (core/src/cld/spec/trace.ts) leaves open: the item detail, the pickers and
 * the items list's state. Fetched when shown and again on `specChanged` (useSpecRev), never polled.
 */
import { useEffect, useState } from 'react';

import type {
  Acceptance,
  ArchDiagram,
  ArchKind,
  ArchSkeletonAction,
  EvidenceKind,
  LinkRel,
  TraceArch,
  TracePick,
  TraceState,
} from '../../../../core/src/cld/spec/trace.js';
import { t } from '../../i18n/index.js';
import { serverText } from '../serverText.js';
import { useSpecRev } from './specStore.js';

/** The item detail's shapes are the contract's (SPT-P2 serves them). */
export type { TraceHistory, TraceItem } from '../../../../core/src/cld/spec/trace.js';

export const PICK_TYPES = ['task', 'commit', 'job', 'component'] as const;
export type PickType = (typeof PICK_TYPES)[number];
export type PickCandidate = TracePick;
/** The 요구사항 list's row state (P2 adds it to `…/items`; assumed field name `trace`). */
export type ItemTrace = TraceState;

/** Where the graph is: the three levels (SPT §7.1). */
export type Crumb =
  | { level: 'overview' }
  | { level: 'group'; group: string; label: string }
  | { level: 'neighbourhood'; center: string; label: string };
export type Depth = 1 | 2;

const base = (project: string) => `/api/cld/spec/${encodeURIComponent(project)}`;

export function graphPath(c: Crumb, depth: Depth): string {
  const q = new URLSearchParams({ level: c.level });
  if (c.level === 'group') q.set('group', c.group);
  if (c.level === 'neighbourhood') {
    q.set('center', c.center);
    q.set('depth', String(depth));
  }
  return `graph?${q}`;
}
export const itemPath = (uid: string) => `item/${encodeURIComponent(uid)}`;
export const candidatesPath = (type: PickType, q: string) =>
  `candidates?${new URLSearchParams({ type, q })}`;

async function request<T>(project: string, route: string, body?: object, method = body ? 'POST' : 'GET'): Promise<T> {
  const r = await fetch(`${base(project)}/${route}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    method,
    ...(body && {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const json = (await r.json().catch(() => ({}))) as T & { error?: string; errorCode?: string };
  if (!r.ok)
    throw Object.assign(new Error(serverText(json, t('spec.error', { why: r.status }))), {
      code: json.errorCode,
    });
  return json;
}

export const getCandidates = (project: string, type: PickType, q: string) =>
  request<{ candidates: PickCandidate[] }>(project, candidatesPath(type, q));

type LinkKey = { from: string; to: string; rel: LinkRel; kind?: EvidenceKind };
export const traceWrite = {
  add: (project: string, link: LinkKey & { note?: string }) => request(project, 'links', link),
  confirm: (project: string, edges: LinkKey[]) => request(project, 'links/confirm', { edges }),
  reject: (project: string, link: Omit<LinkKey, 'kind'>) => request(project, 'links/reject', link),
  review: (project: string, uid: string) => request(project, 'review', { uid }),
  deployConfirm: (project: string, jobId: string, note?: string) =>
    request(project, 'deploy-confirm', { jobId, ...(note && { note }) }),
  // SPT-P3-ACCEPT
  /** `version`: the detail's (TraceItem.version); another text by then is refused `spec_stale`. */
  accept: (project: string, uid: string, version: string, state: Acceptance, note?: string) =>
    request(project, 'acceptance', { uid, version, state, ...(note && { note }) }),
};

// ── SPT-P4B: the owner's architecture (arch.json) ──
type CompFields = { label?: string; kind?: ArchKind; note?: string };
const enc = encodeURIComponent;
export const archWrite = {
  /** The diagram's `version` as shown: another one by then is refused `spec_stale`. */
  approve: (project: string, d: ArchDiagram) => request(project, 'arch/approve', { doc: d.doc, block: d.block, version: d.version }),
  addComp: (project: string, c: CompFields) => request<{ uid: string }>(project, 'arch/components', c),
  editComp: (project: string, uid: string, c: CompFields) => request(project, `arch/components/${enc(uid)}`, c, 'PATCH'),
  deleteComp: (project: string, uid: string) => request(project, `arch/components/${enc(uid)}`, undefined, 'DELETE'),
  addRel: (project: string, from: string, to: string, label?: string) => request(project, 'arch/relations', { from, to, ...(label && { label }) }),
  deleteRel: (project: string, id: string) => request(project, `arch/relations/${enc(id)}`, undefined, 'DELETE'),
  alias: (project: string, uid: string, into: string) => request(project, 'arch/alias', { uid, into }),
  unalias: (project: string, uid: string) => request(project, `arch/alias/${enc(uid)}`, undefined, 'DELETE'),
  skeleton: (project: string, path: string, action: ArchSkeletonAction, more: { label?: string; into?: string } = {}) => request(project, 'arch/skeleton', { path, action, ...more }),
  /** [제안 모두 승인]: what the design drawing showed as pending; a diagram changed since is refused `spec_stale`. */
  approveAll: (project: string, pending: NonNullable<TraceArch['pending']>) => request(project, 'arch/approve-all', pending),
  undoAll: (project: string, batch: string) => request(project, 'arch/approve-all/undo', { batch }),
};
/** SPT C1: the 지도; `chain` the cells entered ([한 단계 들어가기]), `feature` a feature's requirements. */
export const mapPath = (chain: readonly string[], feature?: string, block?: string) =>
  `map?${new URLSearchParams({ ...(chain.length && { in: chain.join('>') }), ...(feature && { feature }), ...(block && { block }) })}`;

/** `route`'s answer while mounted, again on the project's `specChanged` and on `reload()`; `null` route = nothing. */
export function useTrace<T>(
  project: string,
  route: string | null,
): { data: T | null; error: string; reload: () => void } {
  const rev = useSpecRev(project);
  const [n, setN] = useState(0);
  const [state, setState] = useState<{ data: T | null; error: string; route: string | null }>({
    data: null,
    error: '',
    route,
  });
  useEffect(() => {
    if (!route) return;
    let live = true;
    request<T>(project, route).then(
      (data) => live && setState({ data, error: '', route }),
      (err: Error) => live && setState((s) => ({ ...s, error: err.message })),
    );
    return () => {
      live = false;
    };
  }, [project, route, rev, n]);
  // A new route shows nothing stale: the old answer belongs to another level or item.
  const fresh = state.route === route;
  return { data: fresh ? state.data : null, error: state.error, reload: () => setN((x) => x + 1) };
}

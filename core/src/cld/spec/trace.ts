/**
 * SPT Phase 2-3 contract: the shapes the spec trace API returns (server/src/cld/spec) and the
 * 현황판's 요구사항 detail and 그래프 read (webview-ui/src/cld/spec). Types only, no runtime code.
 * Design: cld/docs/design/spec-tracking.md §4.3-4.5 (links), §5 (four states), §7 (graph).
 */

/** A node of the trace graph. `group` is a cluster (document, section or display-ID prefix). */
export type TraceNodeType = 'req' | 'doc' | 'task' | 'commit' | 'job' | 'msg' | 'comp' | 'group';

/** What a link means, from the requirement's side (SPT §4.3). */
export type LinkRel = 'implements' | 'changes' | 'verifies' | 'discusses' | 'realizes' | 'refs';

/** confirmed: the owner confirmed it (stored). observed: the source names the display ID (computed,
 *  not a confirmed relation until the owner confirms). suggested: inferred without an ID (computed).
 *  rejected: the owner said no (stored, shown dimmed for observed ones). */
export type LinkStatus = 'confirmed' | 'observed' | 'suggested' | 'rejected';

/** ✔ observed, ◐ reported only, – none (SPT §5.2). A deploy job's exit 0 alone is 'reported'. */
export type EvidenceMark = 'observed' | 'reported' | 'none';

export type Freshness = 'current' | 'review' | 'missing' | 'unresolved';

export type Acceptance = 'none' | 'validate' | 'accepted' | 'rejected';

export type EvidenceKind = 'unit' | 'integration' | 'deploy' | 'other';

export interface TraceEvidence {
  /** 코드 변경 */
  change: EvidenceMark;
  /** 통합 확인: a linked commit is an ancestor of the tracked branch */
  integration: EvidenceMark;
  /** 시험: a verifies-linked job with exit 0, or a Task's testsPassed */
  test: EvidenceMark;
  /** 배포: 'observed' only with a deploy confirmation; a job's exit 0 alone is 'reported' */
  deploy: EvidenceMark;
  /** 완료 보고 (a linked Task's reportedDone) */
  reported: boolean;
}

export interface TraceState {
  work?: { total: number; byStatus: Record<string, number> };
  evidence?: TraceEvidence;
  /** SPT-P3-ACCEPT: the latest record on the current text (none: 'none'); `previous` the latest
   *  non-'none' record on an older text, when the current text has no record. */
  acceptance?: { current: Acceptance; previous?: { state: Acceptance; at: string } };
  freshness?: Freshness;
  /** 연결 재검토: a confirmed link's basis text differs from the requirement's current text */
  linkReview?: boolean;
  /** 수용 재검토: the latest non-'none' acceptance record is on an older text */
  acceptanceReview?: boolean;
}

export interface TraceSource {
  path?: string;
  line?: number;
  sha?: string;
  taskId?: string;
  jobId?: string;
  msgId?: string;
}

export interface TraceNode {
  /** UID for req/doc/comp, task id, full commit sha, job id, message id, or a group id */
  id: string;
  type: TraceNodeType;
  /** Display ID or a short title, masked and capped */
  label: string;
  /** Masked, capped at 200 characters */
  title?: string;
  state?: TraceState;
  /** The cluster this node sits in (overview and group levels) */
  group?: string;
  /** A folded node ('커밋 +23') or a group's size */
  count?: number;
  source?: TraceSource;
}

export interface TraceEdge {
  id: string;
  from: string;
  to: string;
  rel: LinkRel;
  status: LinkStatus;
  /** observed: where the ID is written; suggested: why it is inferred */
  reason?: string;
  by?: { kind: 'owner' | 'agent' | 'engine'; name?: string };
  at?: string;
  source?: TraceSource;
  /** for 'verifies' */
  kind?: EvidenceKind;
}

export interface TraceGraph {
  level: 'overview' | 'group' | 'neighbourhood';
  center?: string;
  nodes: TraceNode[];
  edges: TraceEdge[];
  /** node type → how many were folded into '+N' nodes */
  folded?: Partial<Record<TraceNodeType, number>>;
  /** filtered out by the request's filters ('숨긴 것 N개') */
  hidden?: number;
}

/** One requirement's detail (`GET …/item/:uid`): the node, its links with the other ends, history. */
export interface TraceItem {
  node: TraceNode;
  edges: TraceEdge[];
  /** The other ends of `edges` */
  nodes: TraceNode[];
  history?: TraceHistory[];
  /** SPT-P3-ACCEPT: the item's text read now from the working tree, masked, at most 4 KB (never stored); absent when the document is gone. */
  text?: string;
  /** The version `text` is: POST …/acceptance sends it back and is refused 'stale' (409) when the requirement's text is another by then. */
  version?: string;
  /** 인수 기준 (SPT §2.4: a table column or a Done when / Tests / 검증 / Scenario part), masked and capped. */
  criteria?: string[];
  /** Every acceptance record, newest first; `current`: on the requirement's text now. */
  acceptance?: TraceAcceptance[];
}
export interface TraceAcceptance {
  state: Acceptance;
  note?: string;
  by?: TraceEdge['by'];
  at: string;
  current: boolean;
}
/**
 * GAME-UI-1 (G2, 이번 주 수락): the summary's week from acceptance.json, in the host's local time.
 * A day counts the requirements whose last record that day is accepted (or rejected); a week is
 * the sum of its days. No goal: `best` is only the most of the past weeks.
 */
export interface TraceAcceptanceWeek {
  /** This week's Monday, YYYY-MM-DD. */
  start: string;
  /** Today, 0 = Monday. */
  today: number;
  /** Monday to Sunday. */
  days: Array<{ accepted: number; rejected: number }>;
  /** The past weeks' accepted sums, oldest first. */
  weeks: number[];
}
export interface TraceHistory {
  at: string;
  kind: 'identity' | 'link' | 'acceptance';
  /** identity: created, moved, renamed, textChanged; link: confirmed, rejected, added, edited, unlinked, reviewed, deployConfirmed; acceptance: the state recorded */
  action: string;
  by?: TraceEdge['by'];
  /** What it was about (a display ID, a Task, a commit), masked by the server */
  detail?: string;
}
/** A row of [연결 추가]'s pickers (`GET …/candidates?type=task|commit|job|component&q=`; SPT-P4C: a component's `id` is its `c_` UID, `title` its document). */
export interface TracePick {
  id: string;
  label: string;
  title?: string;
  at?: string;
}

// ── SPT-P3-ISSUES: a Task's requirements ──
/**
 * `GET …/task/:taskId`: the requirements linked to one Task of the project (confirmed, observed,
 * suggested and rejected `implements` edges, Task end last) and those requirements' nodes, from the
 * same trace index the graph reads. `enabled: false` when spec tracking is off (then nothing else).
 */
export interface TraceTaskReqs {
  enabled: boolean;
  edges: TraceEdge[];
  nodes: TraceNode[];
}

// ── SPT-P3-OVERVIEW: the 개요's 최근 근거 (`GET …/recent`), masked and capped by the server ──

/** A requirement a commit or a job names (observed) or is confirmed to. */
export interface TraceRecentReq {
  uid: string;
  label: string;
  status: 'confirmed' | 'observed';
}
export interface TraceRecent {
  /** The tracked branch's last commits (HEAD's first parents), newest first. */
  commits: Array<{ sha: string; subject: string; at: string; reqs: TraceRecentReq[] }>;
  /** This project's last ended jobs, newest first. */
  /** `reported`: a deploy job's exit 0 with no 배포 확인 yet (its LED half on, GAME-UI-0). */
  jobs: Array<{ id: string; desc: string; exit: number | null; at: string; reqs: TraceRecentReq[]; reported?: true }>;
  /** This project's last merge records (merge-history.json), newest first. */
  merges: Array<{ ok: boolean; at: string; target: string; auto: boolean; task?: string; branch?: string; kind?: string; sha?: string; error?: string }>;
}

// ── SPT-P4A: the architecture graph read from the documents (`GET …/arch?layer=composition|interaction`, SPT §8) ──

/** A component's kind. This slice reads `store` (Mermaid's cylinder `[( )]`) and `component` (the rest); the owner sets the others from 4b. */
export type ArchKind = 'system' | 'component' | 'interface' | 'store' | 'external';
/** composition: what relies on what (flowchart edges, a table's 의존 column); interaction: a sequence diagram's messages. */
export type ArchLayer = 'composition' | 'interaction';
export interface ArchSource {
  path: string;
  line: number;
}
export interface ArchNode {
  /** The component's `c_` UID. */
  id: string;
  /** Masked, capped at 200 characters; may hold line breaks (`<br>`). */
  label: string;
  kind: ArchKind;
  /** 'doc': read from a document; 'owner': added by hand (arch.json); 'folder': a skeleton folder (proposed, or approved with a UID). */
  from: 'doc' | 'owner' | 'folder';
  /** The innermost subgraph it sits in (an ArchGroup id). */
  group?: string;
  /** Where it is written: the node, row or participant line(s); none for one added by hand or a folder. */
  sources: ArchSource[];
  /** SPT-P4C: the requirements confirmed or observed to realize it (absent: none). */
  reqs?: ArchReqs;
  // SPT-P4B: the owner's architecture
  standing: ArchStanding;
  /** A document component's diagram (an ArchDiagram id). */
  diagram?: string;
  /** Added by hand only: the owner's note (masked). */
  note?: string;
  /** A folder's path (`server/`, `server/src/`) and its file count. */
  folder?: string;
  files?: number;
  /** The file listing was cut (a very big repository): `files` is at least that many. */
  filesPartial?: true;
  /** '같은 구성요소': the components merged into this one, and the skeleton folders merged into it. */
  merged?: Array<{ id: string; label: string }>;
  folders?: string[];
}
/** A flowchart subgraph: a group (a React Flow parent), never a component. */
export interface ArchGroup {
  id: string;
  label: string;
  parent?: string;
  source: ArchSource;
}
export interface ArchEdge {
  id: string;
  /** Component UIDs, or an ArchGroup id (a flowchart edge to a subgraph). */
  from: string;
  to: string;
  layer: ArchLayer;
  /** The edge label or the messages (joined with ' · '), masked and capped. */
  label?: string;
  /** Absent: an arrow to `to`; 'none': a plain line (`---`); 'both': arrows at both ends. */
  ends?: 'none' | 'both';
  /** Absent for a relation added by hand. */
  source?: ArchSource;
  /** SPT-P4B: a relation added by hand (its id is the relation's, for DELETE …/arch/relations/:id). */
  owner?: true;
}
/** A Mermaid block not drawn: another diagram type, or a line outside the supported subset. */
export interface ArchUnsupported {
  /** The document's path. */
  doc: string;
  /** The block's fence line. */
  line: number;
  /** 'flowchart', 'sequenceDiagram', 'erDiagram', … */
  type: string;
  /** The first line the subset does not read (a document line) and its text. */
  firstBlockedLine: number;
  text: string;
  /** The block's source, masked, at most 4 KB ('' for a whole document refused). */
  source: string;
  /** Refused for its size (a block past its node, edge or subgraph cap; type 'document': a document past its component or link cap). */
  big?: true;
}
export interface TraceArch {
  layer: ArchLayer;
  nodes: ArchNode[];
  groups: ArchGroup[];
  /** Composition edges; interaction ones too when `layer` is 'interaction'. */
  edges: ArchEdge[];
  unsupported: ArchUnsupported[];
  /** 승인한 구조 · 제안 · 문서에서 읽음: approved (approved diagrams, by hand, approved folders) · proposed folders · the rest read from documents ('doc' and 'review'). */
  counts: { approved: number; proposed: number; fromDocs: number };
  /** SPT-P4B: the diagrams and component tables drawn, each with its standing. */
  diagrams: ArchDiagram[];
  /** Components past the cap, left out. */
  hidden?: number;
  /** Edges of the layer past the cap, left out. */
  hiddenEdges?: number;
}

// ── SPT-P4C: requirement ↔ component (`realizes`, SPT §8) ──
/** A component's requirements in the 아키텍처 view: how many, and the first ten (confirmed first) as chips. */
export interface ArchReqs {
  count: number;
  list: TraceRecentReq[];
}

// ── SPT-P4B: the owner's architecture (arch.json: approval per diagram, kinds, by hand, '같은 구성요소', the folder skeleton) ──

export const ARCH_KINDS = ['system', 'component', 'interface', 'store', 'external'] as const;
/**
 * approved: from an approved diagram, added by hand, or an approved folder; doc: read from a document,
 * not approved; proposed: a skeleton folder not decided yet; review: its approved diagram changed since.
 */
export type ArchStanding = 'approved' | 'doc' | 'proposed' | 'review';
export type ArchSkeletonAction = 'approved' | 'renamed' | 'merged' | 'removed';
/** A Mermaid block or component table drawn: what [이 구조 승인] approves (POST …/arch/approve {doc, block, version}). */
export interface ArchDiagram {
  /** `<doc UID>:<block>` (ArchNode.diagram). */
  id: string;
  doc: string;
  block: number;
  /** The document's path and the block's first line. */
  path: string;
  line: number;
  type: 'flowchart' | 'sequence' | 'table';
  /** The block's hash now: the version an approval records. */
  version: string;
  standing: 'approved' | 'doc' | 'review';
  /** When it was last approved (any version). */
  approvedAt?: string;
}

// ── MAP-A: the 지도 tab's structure view (`GET …/map?uid=<module|root>`), one selected item at a time ──

/** Where a module, a parent or a relation comes from (provenance). `agent_suggested` has no source yet. */
export type MapOrigin = 'owner_confirmed' | 'document_explicit' | 'algorithm_suggested' | 'agent_suggested';
/** A module's parent: set by the owner (arch.json `parents`), a document's subgraph, or the folder skeleton. */
export type MapParentFrom = 'owner' | 'doc' | 'folder';
/** Requirements of a module and the modules under it, each counted once at its strongest status. */
export interface MapReqCounts {
  confirmed: number;
  observed: number;
  suggested: number;
}
export interface MapCard {
  /** A `c_` UID, a proposed folder (`f:…`) or a document subgraph (`g:…`). */
  id: string;
  label: string;
  /** 'group': a document subgraph. */
  kind: ArchKind | 'group';
  standing: ArchStanding;
  origin: MapOrigin;
  parentFrom?: MapParentFrom;
  reqs: MapReqCounts;
  /** Tasks in doing, review or blocked, confirmed to a requirement confirmed or observed for it (or below). */
  activeTasks: number;
  children: number;
}
export interface MapModule extends MapCard {
  parent?: string;
  /** Where it is written (capped). */
  sources: ArchSource[];
  note?: string;
  folder?: string;
}
/** A composition relation between two shown cards (relations below them lifted to them). */
export interface MapDep {
  from: string;
  to: string;
  label?: string;
  origin: 'owner_confirmed' | 'document_explicit';
  /** How many relations it stands for. */
  count: number;
}
export interface MapUncertain {
  id: string;
  label: string;
  /** review: approved, its document changed since; proposed: a folder proposal; doc: read from a document, not approved; suggested: only suggested requirement links; unlinked: no requirement. */
  why: 'review' | 'proposed' | 'doc' | 'suggested' | 'unlinked';
}
export interface MapReq {
  uid: string;
  label: string;
  title?: string;
  status: 'confirmed' | 'observed' | 'suggested';
  state?: TraceState;
}
export interface MapTreeRow {
  id: string;
  label: string;
  parent?: string;
  standing: ArchStanding;
  children: number;
}
export interface TraceMap {
  /** false: spec tracking is off (nothing else is filled; nothing was read). */
  enabled: boolean;
  /** The selected item; `id: 'root'` for the project itself. */
  selected: MapModule;
  /** The root first, the selected item last. */
  crumbs: Array<{ id: string; label: string }>;
  cards: MapCard[];
  /** Children past the card cap ('그 밖 N개'; the tree lists them). */
  more: number;
  deps: MapDep[];
  uncertain: MapUncertain[];
  uncertainMore: number;
  reqs: MapReq[];
  reqsMore: number;
  tree: MapTreeRow[];
  treeMore: number;
  /** The project's live requirements, linked to a module or not. */
  reqTotal: number;
  /** [제안 모두 승인]: the diagrams read from documents and never approved, and the folders proposed (masked paths), as shown now. */
  pending: { diagrams: Array<Pick<ArchDiagram, 'doc' | 'block' | 'version'>>; folders: string[] };
  /** The last [제안 모두 승인] still standing, for [되돌리기]. */
  lastBatch?: { id: string; at: string; diagrams: number; folders: number };
}

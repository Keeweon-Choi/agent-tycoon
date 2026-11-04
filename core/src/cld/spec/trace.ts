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
  /** [제안 모두 승인] (the arch read only): the diagrams read from documents and never approved, and the folders proposed (masked paths), as shown now. */
  pending?: { diagrams: Array<Pick<ArchDiagram, 'doc' | 'block' | 'version'>>; folders: string[] };
  /** The last [제안 모두 승인] still standing, for [되돌리기]. */
  lastBatch?: { id: string; at: string; diagrams: number; folders: number };
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

// ── SPT C1: the 지도 tab (`GET …/map?feature=&in=`), features × structure (SPT §6.8, §8) ──

/** A feature (SPT §8.1): the first boundary rule that fits its requirements. */
export interface MapFeature {
  /** `FR-ENG` (prefix), `fm:<doc UID>` (front-matter id), `sk:<folder>` (Spec Kit), `dir:<folder>` (document folder). */
  key: string;
  /** What the row says first: `ENG`, the front-matter id, the folder's name. */
  short: string;
  /** The defining section's name (`3.19 내장 엔진(ENG)` → 내장 엔진), else the front matter's id or the folder's name; masked. */
  name: string;
  rule: 'speckit' | 'fm' | 'prefix' | 'folder';
  reqs: number;
  /** 진행: a commit of the last 7 days names one of its requirements (or a Task linked to one). */
  progress: boolean;
  /** 막힘: a Task linked to one (confirmed or observed) is blocked on the Task Board. */
  blocked: boolean;
  /** 원문 바뀜: its requirements whose text changed in the last 7 days. */
  changed: number;
  /** SPT C2 (§8.4): its requirements that reach a code file by a path on by default (the bar: linked / reqs). */
  linked: number;
}
/** SPT C2 (§8.4): the four link paths from a requirement to files, counted apart. */
export type MapLinkPath = 'confirmed' | 'direct' | 'commit' | 'task';
/** 공통 기준: NFR-, IR-, CON- requirements by prefix (`NFR-PERF`), apart from the features. */
export interface MapCommon {
  key: string;
  reqs: number;
  changed: number;
}
/** One cell of the structure (SPT §8.2): a layer's rest, a unit folder, or a rail. */
export interface MapBlock {
  /** The folder (`server/src/cld/engine`, a layer `server`), or `tests` / `tools` for the rails. */
  id: string;
  /** The folder's last name, or the owner's name for it (arch.json); a rail's is the page's. */
  name: string;
  kind: 'layer' | 'unit' | 'rail';
  /** A layer cell that gave folders their own cells: its rest (`<name> 나머지`). */
  rest?: true;
  /** The layer (band) it sits in; none for a rail. */
  layer?: string;
  files: number;
  /** Its biggest parts: `git/` (a folder), `cld/*` (a folder's own files), `` (its own files), `cld/test` (a rail's). */
  inside: Array<{ name: string; n: number }>;
  /** Relative imports into it and out of it, from and to the other cells (rails included). */
  in: number;
  out: number;
  /** [한 단계 들어가기] would show more than one cell. */
  deeper: boolean;
  /** SPT C2: the features (and 공통 기준 prefixes) whose requirements reach it by a path on, with how many (요구 N), most first. */
  features: Array<{ key: string; reqs: number }>;
  /** Commits of the last 7 days that changed one of its files. */
  week: number;
}
/** A band: one layer, top to bottom in import order (who imports more sits higher). */
export interface MapBand {
  id: string;
  name: string;
  files: number;
  blocks: string[];
}
/** Two cells' imports, each way (a → b, b → a); listed once per pair, rails out. */
export interface MapPair {
  a: string;
  b: string;
  ab: number;
  ba: number;
}
export interface MapStructure {
  /** The `in` chain shown ([] at the top), each with its cell's name. */
  crumbs: Array<{ id: string; name: string }>;
  bands: MapBand[];
  blocks: MapBlock[];
  pairs: MapPair[];
  /** Imports from a lower band to a higher one, and the first file pairs of them. */
  violations: number;
  violationFiles: Array<[string, string]>;
  /** Code files counted, imports resolved between them, relative imports not resolved (css, json, pictures, aliases). */
  files: number;
  imports: number;
  unresolved: number;
  /** 일부만 셈: a cap cut the scan (files, bytes, time), or the listing was cut. */
  partial?: 'files' | 'bytes' | 'time' | 'list';
  /** Files over the per-file cap: counted, their imports not read. */
  big: number;
  /** When the child process scanned, how long it took and its peak RSS. */
  at: string;
  ms: number;
  rssKb: number;
}
export interface MapFeatureDetail {
  key: string;
  name: string;
  /** Where its name is defined (the section's document and line). */
  source?: { path: string; line: number };
  /** `paths`: [펼치기]'s files per path (every path, the ones off too), each count with its first files. */
  reqs: Array<{
    uid: string;
    label: string;
    title?: string;
    state?: TraceState;
    changed?: true;
    tasks?: string[];
    paths?: Partial<Record<MapLinkPath, { n: number; files: string[] }>>;
  }>;
  more: number;
  /** SPT C2 (§6.8): 요구 → 작업 → 커밋 → 파일 (files by the paths on). */
  chain: { reqs: number; tasks: number; commits: number; files: number };
  /** Its tasks (Task Board Tasks linked, task spec numbers pointing at one of its requirements), with how many of its requirements each names. */
  tasks: Array<{ id: string; title?: string; reqs: number }>;
  tasksMore: number;
  /** Commits of the last 7 days naming one of its requirements or tasks. */
  week: number;
}
/** SPT C2 (`?block=`): a cell's 닿은 기능, its last commits and head-comment tags, 꼬리표로만 이어진 커밋 (D3). */
export interface MapBlockDetail {
  id: string;
  features: Array<{ key: string; short: string; name: string; reqs: number }>;
  week: number;
  recent: Array<{ sha: string; at: string; subject: string; tags: string[] }>;
  tags: Array<{ tag: string; files: number }>;
  /** Commits that changed its files and name a head-comment tag but no requirement or task number (not linked to a feature: SPT §14 D3). */
  tagOnly: number;
}
export interface TraceMap {
  /** false: spec tracking is off (nothing else is filled; nothing was read or run). */
  enabled: boolean;
  features: MapFeature[];
  common: MapCommon[];
  /** Requirements of the requirement documents, and of those the ones whose text changed in the last 7 days. */
  reqTotal: number;
  changed: number;
  /** null: the scan could not run or failed (세지 못함: tried again shortly); no code file is a structure with no block. */
  structure: MapStructure | null;
  /** `?feature=`: that feature's (or common prefix's) requirements. */
  feature?: MapFeatureDetail;
  /** SPT C2: the feature requirements linked by a path on, the paths on by default, the commits read (and whether the log was cut), the 꼬리표로만 commits of them all. */
  linked: number;
  pathsOn: MapLinkPath[];
  commits: number;
  commitsCapped?: true;
  tagOnly: number;
  /** `?block=`: that cell of the structure shown. */
  block?: MapBlockDetail;
}

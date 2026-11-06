/**
 * RQ2 (RQW §2): the one 요구사항 tab in place of 요구사항 and 문서. Left the tree 문서 → 기능 →
 * 요구사항 with the three states (RQ1) and the filter chips, right the requirement's detail
 * (ReqDetail); a phone shows the list, then the detail full screen. The head's [확인할 것 N] holds
 * the old 문서 tab's questions (같은 항목 확인, 확인 권장, 최근 판단); the [⚙] sheet "요구사항을 읽어 올 문서"
 * holds its documents and their settings (읽는 중, 숨김, 민감, 읽는 법, 종류) and its alerts. Every
 * empty screen says what is empty and what fills it. Fetched when shown and on `specChanged`.
 */
import '../../i18n/specStrings.js';
import './reqs.css';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { REQ_STATUSES, type ReqStatus } from '../../../../core/src/cld/spec/reqState.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { SPEC_DEPTH_MAX, SPEC_DIALOG_Z, SPEC_REQS_TREE_MAX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { timeAgo } from '../format.js';
import { Icon } from '../icons/Icon.js';
import { cldToast } from '../officeStore.js';
import { tabFocus, useCanAct, useNow } from '../workbench/workbenchStore.js';
import { showText } from './overviewModel.js';
import { ReqDetail, ReqPill } from './ReqDetail.js';
import {
  buildTree,
  type DocKind,
  type DocMode,
  type DocRow,
  filterTree,
  headCounts,
  type ItemRow,
  readHow,
  type TreeDoc,
  type TreeFeature,
  type TreeReq,
  viewsOf,
} from './reqsModel.js';
import {
  type Alert,
  Alerts,
  call,
  type DecisionRow,
  Decisions,
  EnableDialog,
  GIT_KEY,
  InheritOffers,
  KINDS,
  kindText,
  type Question,
  Questions,
  Review,
  type ReviewRow,
  type Summary,
  useSettled,
  useSpec,
} from './SpecTabs.js';
import { WorkflowBlock, type WorkflowView } from './WorkflowBlock.js';

type Candidate = { path: string; kind: DocKind; git: DocRow['git']; uid?: string };
type DocBody =
  Partial<Pick<DocRow, 'kind' | 'tracked' | 'mode' | 'depth' | 'sensitive'>> | { seen: true };
const ACCEPTANCE_FILTERS = ['none', 'validate', 'accepted', 'rejected', 'review'] as const;
const DEPTHS = Array.from({ length: SPEC_DEPTH_MAX }, (_, i) => i + 1);
const HOW_MODES = ['auto', 'headings', 'refs'] as const satisfies readonly DocMode[];

/** The small tags beside a requirement: 삭제됨, 내용 바뀜, 원본 없음, 같은 요구사항인가요? (they never change the state). */
function ReqTags({ row }: { row: ItemRow }) {
  const f = row.trace?.freshness;
  return (
    <>
      {row.state === 'retired' && <span className="rq-tag">{t('reqs.tag.retired')}</span>}
      {f === 'review' && <span className="rq-tag">{t('reqs.tag.changed')}</span>}
      {f === 'missing' && row.state !== 'retired' && (
        <span className="rq-tag">{t('reqs.tag.missing')}</span>
      )}
      {(f === 'unresolved' || row.state === 'unresolved') && (
        <span className="rq-tag">{t('reqs.tag.unresolved')}</span>
      )}
    </>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} pixel={open ? '▾' : '▸'} />
);

/** A document's ⋯ menu (the tree's row and the sheet's): 숨기기, 민감, 읽는 법, 종류. */
function DocMenu({
  doc,
  onSet,
  onClose,
}: {
  doc: DocRow;
  onSet: (uid: string, body: DocBody) => void;
  onClose: () => void;
}) {
  const set = (body: DocBody) => (onSet(doc.uid, body), onClose());
  return (
    <div className="rq-menu" role="menu" data-testid="reqs-doc-menu">
      <button
        type="button"
        role="menuitem"
        onClick={() => set({ tracked: false })}
        data-testid="reqs-menu-hide"
      >
        <Icon name="eye" size={16} pixel="-" />
        {t('reqs.menu.hide')}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => set({ sensitive: !doc.sensitive })}
        data-testid="reqs-menu-sensitive"
        aria-pressed={doc.sensitive}
      >
        <Icon name="lock" size={16} pixel="#" />
        <span>
          {t(doc.sensitive ? 'reqs.menu.sensitiveOff' : 'reqs.menu.sensitive')}
          <span className="block rq-muted">{t('reqs.menu.sensitiveHint')}</span>
        </span>
      </button>
      <details>
        <summary>{t('reqs.menu.how')} ›</summary>
        <div className="rq-sub">
          {HOW_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitem"
              aria-pressed={doc.mode === m}
              onClick={() => set({ mode: m })}
              data-testid="reqs-menu-mode"
              data-mode={m}
            >
              {t(`reqs.menu.how.${m}`)}
            </button>
          ))}
          {doc.mode === 'headings' && (
            <label className="flex items-center gap-6 px-8 py-4">
              {t('reqs.menu.depth')}
              <select
                className="rq-field w-auto"
                value={doc.depth}
                onChange={(e) => set({ depth: Number(e.target.value) })}
                data-testid="reqs-menu-depth"
              >
                {DEPTHS.map((n) => (
                  <option key={n} value={n}>
                    {t('spec.docs.depthLevel', { level: n })}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </details>
      <details>
        <summary>{t('reqs.menu.kind')} ›</summary>
        <div className="rq-sub">
          <p className="rq-muted px-8">{t('reqs.menu.kindNote')}</p>
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="menuitem"
              aria-pressed={doc.kind === k}
              onClick={() => set({ kind: k })}
              data-testid="reqs-menu-kind"
              data-kind={k}
            >
              {kindText(k)}
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}

/** A ⋯ button with its menu under it (one open at a time is enough: a click elsewhere closes it). */
function MenuButton({
  doc,
  onSet,
  label,
}: {
  doc: DocRow;
  onSet: (uid: string, body: DocBody) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) =>
      !(e.target as Element).closest?.('.rq-menu, [data-menu-button]') && setOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <span className="relative shrink-0">
      <Button
        variant="ghost"
        size="icon_md"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-menu-button
        data-testid="reqs-doc-more"
      >
        <Icon name="ellipsis" size={16} pixel="…" />
      </Button>
      {open && <DocMenu doc={doc} onSet={onSet} onClose={() => setOpen(false)} />}
    </span>
  );
}

// ── the gear sheet (RQW §2.6) ──

function Sheet({
  project,
  mobile,
  docs,
  alerts,
  candidates,
  workflow,
  onSet,
  onClose,
  reload,
}: {
  project: string;
  mobile: boolean;
  docs: DocRow[];
  alerts: Alert[];
  candidates: Candidate[];
  workflow?: WorkflowView;
  onSet: (uid: string, body: DocBody) => void;
  onClose: () => void;
  reload: () => void;
}) {
  const canAct = useCanAct();
  const now = useNow();
  const reading = docs.filter((d) => d.tracked);
  const hidden = docs.filter((d) => !d.tracked && d.state !== 'retired');
  const known = new Set(docs.map((d) => d.path));
  const found = candidates.filter((c) => !known.has(c.path));
  const act = (route: string, body: object) =>
    void call(project, route, body).then(
      () => (cldToast(t('reqs.sheet.title'), t('spec.done'), 'ok'), reload()),
      (err: Error) => cldToast(t('reqs.sheet.title'), err.message, 'error'),
    );
  // A found document starts being read the 켜기 window's way: every document read now, plus it.
  const read = (path: string) =>
    act('enable', {
      docs: [...reading.filter((d) => d.state !== 'retired').map((d) => d.path), path],
    });
  const sheet = (
    <>
      <div
        className="rq-scrim"
        style={mobile ? { position: 'fixed', zIndex: SPEC_DIALOG_Z } : undefined}
        onClick={onClose}
      />
      <aside
        className="rq-sheet"
        data-mobile={mobile || undefined}
        style={mobile ? { zIndex: SPEC_DIALOG_Z + 1 } : undefined}
        aria-label={t('reqs.sheet.title')}
        data-testid="reqs-sheet"
      >
        <div className="flex items-start gap-8">
          <div className="rq-grow">
            <h3 className="rq-title" style={{ marginTop: 0 }}>
              {t('reqs.sheet.title')}
            </h3>
            <p className="rq-muted">{t('reqs.sheet.hint')}</p>
          </div>
          <Button
            variant="ghost"
            size="icon_md"
            aria-label={t('reqs.sheet.close')}
            onClick={onClose}
            data-testid="reqs-sheet-close"
          >
            <Icon name="x" size={16} pixel="x" />
          </Button>
        </div>
        <div className="mt-12">
          <Alerts
            project={project}
            alerts={alerts}
            docs={docs}
            onSeen={(uid) => onSet(uid, { seen: true })}
            onRefs={(uid) => onSet(uid, { mode: 'refs' })}
            act={act}
          />
        </div>
        <h4>{t('reqs.sheet.reading', { count: reading.length })}</h4>
        <ul>
          {reading.map((d) => (
            <li
              key={d.uid}
              className="rq-docrow"
              data-testid="reqs-sheet-doc"
              data-path={d.path}
              data-mode={d.mode}
              data-sensitive={d.sensitive}
              data-items={d.items}
            >
              <input
                type="checkbox"
                checked
                disabled={!canAct}
                aria-label={d.path}
                onChange={() => onSet(d.uid, { tracked: false })}
                data-testid="reqs-sheet-untrack"
              />
              <span className="rq-grow">
                <span className="block break-all">{d.path}</span>
                <span className="rq-muted">
                  {d.kind === 'requirements'
                    ? t('reqs.sheet.count', { count: d.items })
                    : t('reqs.sheet.kindNote', { kind: kindText(d.kind) })}
                  {' · '}
                  {t('reqs.sheet.changed', { when: timeAgo(d.changedAt, now) })}
                </span>
              </span>
              {d.fresh && <span className="rq-tag">{t('spec.docs.new')}</span>}
              {d.git !== 'committed' && <span className="rq-tag">{t(GIT_KEY[d.git])}</span>}
              {d.state === 'retired' && <span className="rq-tag">{t('reqs.sheet.retired')}</span>}
              {d.state === 'unresolved' && (
                <span className="rq-tag">{t('spec.docs.unresolved')}</span>
              )}
              {d.sensitive && <span className="rq-tag">{t('spec.docs.sensitive')}</span>}
              {d.mode === 'headings' || d.mode === 'refs' ? (
                <span className="rq-tag">{t(`reqs.how.${d.mode}`)}</span>
              ) : null}
              {canAct && (
                <MenuButton doc={d} onSet={onSet} label={t('reqs.tree.docMenu', { doc: d.path })} />
              )}
            </li>
          ))}
        </ul>
        <h4>{t('reqs.sheet.found', { count: found.length })}</h4>
        <ul>
          {found.map((c) => (
            <li
              key={c.path}
              className="rq-docrow"
              data-testid="reqs-sheet-found"
              data-path={c.path}
            >
              <input
                type="checkbox"
                checked={false}
                disabled={!canAct}
                aria-label={t('reqs.sheet.read', { path: c.path })}
                onChange={() => read(c.path)}
                data-testid="reqs-sheet-read"
              />
              <span className="rq-grow">
                <span className="block break-all">{c.path}</span>
                <span className="rq-muted">
                  {kindText(c.kind)}
                  {c.git !== 'committed' && ` · ${t(GIT_KEY[c.git])}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <h4>{t('reqs.sheet.hidden', { count: hidden.length })}</h4>
        <ul>
          {hidden.map((d) => (
            <li
              key={d.uid}
              className="rq-docrow"
              data-testid="reqs-sheet-hidden"
              data-path={d.path}
            >
              <span className="rq-grow break-all rq-muted">{d.path}</span>
              {canAct && (
                <Button
                  size="sm"
                  onClick={() => onSet(d.uid, { tracked: true })}
                  data-testid="reqs-sheet-again"
                >
                  {t('reqs.sheet.readAgain')}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {workflow && (
          <>
            <h4>{t('reqs.workflow.head')}</h4>
            <WorkflowBlock project={project} view={workflow} reload={reload} />
          </>
        )}
        {canAct && (
          <button
            type="button"
            className="rq-link mt-16 underline"
            onClick={() => act('disable', {})}
            data-testid="reqs-sheet-off"
          >
            {t('reqs.sheet.turnOff')}
          </button>
        )}
      </aside>
    </>
  );
  return mobile ? createPortal(sheet, document.body) : sheet;
}

/** [확인할 것 N]: the old 문서 tab's questions, the answers as they were; 최근 판단 folded under them. */
function CheckWindow({
  questions,
  review,
  decisions,
  act,
  onClose,
}: {
  questions: Question[];
  review: ReviewRow[];
  decisions: DecisionRow[];
  act: (route: string, body: object) => void;
  onClose: () => void;
}) {
  return (
    <Modal isOpen onClose={onClose} title={t('reqs.check.title')} zIndex={SPEC_DIALOG_Z}>
      <div
        className="flex flex-col gap-8 px-10 pb-10 w-[min(640px,calc(100vw-32px))] max-h-[75vh] overflow-y-auto text-xs"
        data-testid="reqs-check"
      >
        {!questions.length && !review.length && <p className="rq-muted">{t('reqs.check.none')}</p>}
        <Questions questions={questions} act={act} />
        <Review rows={review} act={act} />
        <details className="rq-fold" data-testid="reqs-check-decisions">
          <summary>{t('reqs.check.decisions')} ›</summary>
          <Decisions rows={decisions} act={act} />
        </details>
      </div>
    </Modal>
  );
}

// ── empty states (RQW §2.7) ──

function Empty({
  title,
  body,
  children,
  testId,
}: {
  title: string;
  body?: string;
  children?: ReactNode;
  testId: string;
}) {
  return (
    <div className="rq-empty" data-testid={testId}>
      <Icon name="list" size={28} pixel="≡" className="text-accent-text" />
      <h3>{title}</h3>
      {body && <p className="rq-muted">{body}</p>}
      {children}
    </div>
  );
}

/** Tracking off: what was found and the 켜기 window; an orphaned Registry this project may be is offered first. */
function OffState({ project, summary }: { project: string; summary: Summary | null }) {
  const canAct = useCanAct();
  const [wizard, setWizard] = useState(false);
  const [shape, setShape] = useState(false);
  const docs = useSpec<{ workflow?: WorkflowView }>(project, 'docs');
  const workflow = docs.data?.workflow;
  if (!summary) return <p className="rq-muted">{t('spec.wizard.loading')}</p>;
  if (summary.corrupt) return <Empty title={t('reqs.empty.corrupt')} testId="reqs-empty-corrupt" />;
  const n = summary.candidates ?? 0;
  return (
    <div className="rq" style={{ justifyContent: 'center' }}>
      {!!summary.inherit?.length && <InheritOffers project={project} offers={summary.inherit} />}
      <Empty
        title={t(n ? 'reqs.empty.found.title' : 'reqs.empty.none.title')}
        body={n ? t('reqs.empty.found.body', { count: n }) : t('reqs.empty.none.body')}
        testId={n ? 'reqs-empty-found' : 'reqs-empty-none'}
      >
        {canAct && (
          <Button
            size="sm"
            variant="accent"
            onClick={() => setWizard(true)}
            data-testid="spec-turn-on"
          >
            {t(n ? 'reqs.empty.found.pick' : 'reqs.empty.none.pick')}
          </Button>
        )}
        {workflow?.engine && (
          <div className="rq-empty-more" data-testid="reqs-empty-workflow">
            <p className="rq-muted">{t('reqs.workflow.emptyLead')}</p>
            {shape || workflow.on ? (
              <WorkflowBlock project={project} view={workflow} reload={docs.reload} open={shape} />
            ) : (
              canAct && (
                <Button size="sm" onClick={() => setShape(true)} data-testid="reqs-empty-workflow-open">
                  {t('reqs.workflow.emptyButton')}
                </Button>
              )
            )}
          </div>
        )}
      </Empty>
      {wizard && <EnableDialog project={project} onClose={() => setWizard(false)} />}
    </div>
  );
}

// ── the tab ──

export function ReqsTab({ project, mobile = false }: { project: string; mobile?: boolean }) {
  const canAct = useCanAct();
  // SPT-P3-OVERVIEW: a 개요 number opens it on a filter (`show:`, `acc:`), a requirement (`item:`), the sheet or 확인할 것.
  const [focus] = useState(() => tabFocus('reqs')?.key ?? '');
  const [open, setOpen] = useState<string | null>(
    focus.startsWith('item:') ? focus.slice(5) : null,
  );
  const [show, setShow] = useState(focus.startsWith('show:') ? focus.slice(5) : '');
  const [acceptance, setAcceptance] = useState(() => {
    const a = focus.startsWith('acc:') ? focus.slice(4) : '';
    return (ACCEPTANCE_FILTERS as readonly string[]).includes(a) ? a : '';
  });
  const [status, setStatus] = useState<ReqStatus | ''>('');
  const [text, setText] = useState('');
  const [gone, setGone] = useState(false);
  const [sheet, setSheet] = useState(focus === 'sheet');
  const [check, setCheck] = useState(focus === 'check');
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [at, setAt] = useState<{ doc?: string; feat?: string }>({});
  const q = useSettled(text.trim());
  const query = new URLSearchParams({
    kind: 'requirements',
    limit: String(SPEC_REQS_TREE_MAX),
    ...(q && { q }),
    ...(gone && { state: 'all' }),
    ...(show && { show }),
    ...(acceptance && { acceptance }),
  }).toString();
  const items = useSpec<{ enabled: boolean; total: number; items: ItemRow[] }>(
    project,
    `items?${query}`,
  );
  const docs = useSpec<{ enabled: boolean; docs: DocRow[]; alerts: Alert[]; workflow?: WorkflowView }>(project, 'docs');
  const qs = useSpec<{ enabled: boolean; questions: Question[]; review: ReviewRow[] }>(
    project,
    'questions',
  );
  const dec = useSpec<{ enabled: boolean; decisions: DecisionRow[] }>(project, 'decisions');
  const cands = useSpec<{ docs: Candidate[] }>(project, 'candidates');
  const summary = useSpec<Summary>(project, 'summary');
  const reloadAll = () => [items, docs, qs, dec, cands, summary].forEach((x) => x.reload());
  const onSet = (uid: string, body: DocBody) =>
    void call(project, `docs/${uid}`, body).then(reloadAll, (err: Error) =>
      cldToast(t('reqs.sheet.title'), err.message, 'error'),
    );
  const act = (route: string, body: object) =>
    void call(project, route, body).then(
      () => (cldToast(t('reqs.check.title'), t('spec.done'), 'ok'), reloadAll()),
      (err: Error) => cldToast(t('reqs.check.title'), err.message, 'error'),
    );
  const rows = useMemo(() => items.data?.items ?? [], [items.data]);
  const views = useMemo(() => viewsOf(rows), [rows]);
  const allDocs = useMemo(() => docs.data?.docs ?? [], [docs.data]);
  const tree = useMemo(() => buildTree(rows, views, allDocs), [rows, views, allDocs]);
  const shown = status ? filterTree(tree, (r) => r.view.status === status) : tree;
  const head = headCounts(rows, views);
  const checks = (qs.data?.questions.length ?? 0) + (qs.data?.review.length ?? 0);
  const known = new Set(allDocs.map((d) => d.path));
  const notRead = (cands.data?.docs ?? []).filter((c) => !known.has(c.path)).length;
  const searching = !!q;
  // Open: what the owner opened, else the first document and the feature of the requirement shown.
  const isOpen = (key: string, first: boolean) =>
    searching || opened.has(key) || (!shut.has(key) && first);
  const toggle = (key: string, now: boolean) => {
    const add = (s: Set<string>) => new Set(s).add(key);
    const del = (s: Set<string>) => {
      const n = new Set(s);
      n.delete(key);
      return n;
    };
    setOpened(now ? del : add);
    setShut(now ? add : del);
  };
  const openFeat = open
    ? tree.flatMap((d) =>
        d.features
          .filter((f) => f.reqs.some((r) => r.row.uid === open))
          .map((f) => `${d.key}|${f.key}`),
      )[0]
    : undefined;

  if (items.error)
    return (
      <p className="text-red-400 text-xs" role="alert">
        {items.error}
      </p>
    );
  if (!items.data) return <p className="rq-muted text-xs">{t('spec.wizard.loading')}</p>;
  if (!items.data.enabled) return <OffState project={project} summary={summary.data} />;

  const filtersOn = !!(q || status || show || acceptance);
  const clear = () => (setText(''), setStatus(''), setShow(''), setAcceptance(''));
  const zero = !rows.length && !filtersOn;
  const docRow = (d: TreeDoc) => (d.tool ? undefined : d.docs[0]);
  const onlyDoc = (d: TreeDoc) => d.docs.length === 1 && !d.tool;

  const reqRow = (r: TreeReq) => (
    <li key={r.row.uid}>
      <button
        type="button"
        className="rq-row"
        data-level="req"
        aria-current={open === r.row.uid}
        data-guess={r.view.guess || undefined}
        data-retired={r.row.state === 'retired' || undefined}
        onClick={() => setOpen(r.row.uid)}
        data-testid="reqs-item"
        data-uid={r.row.uid}
        data-id={r.row.displayId ?? ''}
        data-state={r.view.status}
      >
        <span className="rq-mono shrink-0">{r.row.displayId ?? r.row.section}</span>
        <span className="rq-ell rq-grow">{r.row.title || t('spec.reqs.gone')}</span>
        <span className="rq-end">
          <ReqTags row={r.row} />
          <ReqPill view={r.view} />
        </span>
      </button>
    </li>
  );
  const featName = (f: TreeFeature) =>
    f.key === 'common' ? t('reqs.tree.common') : f.key === '' ? t('reqs.tree.noFeature') : f.name;

  const desktopTree = (
    <ul aria-label={t('reqs.tree')} data-testid="reqs-tree">
      {shown.map((d, di) => {
        const dOpen = isOpen(
          d.key,
          di === 0 || d.features.some((f) => `${d.key}|${f.key}` === openFeat),
        );
        const dr = docRow(d);
        return (
          <li key={d.key} data-testid="reqs-doc" data-key={d.key} data-label={d.label}>
            <div className="rq-docline">
              <button
                type="button"
                className="rq-row"
                aria-expanded={dOpen}
                onClick={() => toggle(d.key, dOpen)}
              >
                <Chevron open={dOpen} />
                <span className="rq-b rq-ell">{d.label}</span>
                <span className="rq-muted shrink-0">{t('reqs.tree.reqs', { count: d.total })}</span>
                <span className="rq-end">
                  <span className="rq-tag" data-testid="reqs-doc-how">
                    {t(`reqs.how.${readHow(d, dr)}`)}
                  </span>
                  {dr?.sensitive && <span className="rq-tag">{t('spec.docs.sensitive')}</span>}
                </span>
              </button>
              {canAct && onlyDoc(d) && (
                <MenuButton
                  doc={d.docs[0]}
                  onSet={onSet}
                  label={t('reqs.tree.docMenu', { doc: d.label })}
                />
              )}
            </div>
            {dOpen && !d.total && <p className="rq-hint">{t('reqs.tree.emptyDoc')}</p>}
            {dOpen && (
              <ul>
                {d.features.map((f, fi) => {
                  const key = `${d.key}|${f.key}`;
                  const fOpen = isOpen(
                    key,
                    key === openFeat || (!openFeat && di === 0 && fi === 0),
                  );
                  return (
                    <li key={key} data-testid="reqs-feature" data-key={f.key}>
                      <button
                        type="button"
                        className="rq-row"
                        data-level="feat"
                        aria-expanded={fOpen}
                        onClick={() => toggle(key, fOpen)}
                      >
                        <Chevron open={fOpen} />
                        <span className="rq-ell">
                          {featName(f)} {f.tail && <span className="rq-muted">{f.tail}</span>}{' '}
                          {f.rule === 'folder' && f.key && (
                            <span className="rq-muted">{t('reqs.tree.byFolder')}</span>
                          )}
                        </span>
                        <span className="rq-end rq-muted">
                          {f.reqs.some((r) => r.row.feature?.changing) && (
                            <span className="rq-tag">{t('reqs.tag.changing')}</span>
                          )}
                          {fOpen ? t('reqs.tree.counts', f.counts) : f.reqs.length}
                        </span>
                      </button>
                      {fOpen && <ul>{f.reqs.map(reqRow)}</ul>}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );

  // The phone: one level at a time, with a crumb back (RQW §2.1).
  const pDoc = shown.find((d) => d.key === at.doc);
  const pFeat =
    pDoc?.features.find((f) => f.key === at.feat) ??
    (pDoc?.features.length === 1 ? pDoc.features[0] : undefined);
  const phoneReq = (r: TreeReq) => (
    <li key={r.row.uid}>
      <button
        type="button"
        className="rq-prow"
        data-guess={r.view.guess || undefined}
        data-retired={r.row.state === 'retired' || undefined}
        onClick={() => setOpen(r.row.uid)}
        data-testid="reqs-item"
        data-uid={r.row.uid}
        data-state={r.view.status}
      >
        <span className="flex items-center gap-6 min-w-0">
          <span className="rq-mono rq-grow rq-ell">{r.row.displayId ?? r.row.section}</span>
          <ReqTags row={r.row} />
          <ReqPill view={r.view} />
        </span>
        <span className="block rq-ell">{r.row.title || t('spec.reqs.gone')}</span>
      </button>
    </li>
  );
  const phoneTree = searching ? (
    <ul data-testid="reqs-tree">
      {shown.flatMap((d) => d.features.flatMap((f) => f.reqs)).map(phoneReq)}
    </ul>
  ) : (
    <div data-testid="reqs-tree">
      {pDoc && (
        <button
          type="button"
          className="rq-crumb w-full"
          onClick={() => setAt(pFeat && pDoc.features.length > 1 ? { doc: pDoc.key } : {})}
          aria-label={t('reqs.tree.up')}
          data-testid="reqs-crumb"
        >
          <Icon name="chevron-left" size={16} pixel="‹" />
          {[pDoc.label, pFeat && featName(pFeat)].filter(Boolean).join(' › ')}
        </button>
      )}
      <ul>
        {!pDoc &&
          shown.map((d) => (
            <li key={d.key} data-testid="reqs-doc" data-key={d.key}>
              <button type="button" className="rq-prow" onClick={() => setAt({ doc: d.key })}>
                <span className="flex items-center gap-6">
                  <span className="rq-b rq-grow rq-ell">{d.label}</span>
                  <span className="rq-tag">{t(`reqs.how.${readHow(d, docRow(d))}`)}</span>
                </span>
                <span className="rq-muted">{t('reqs.tree.counts', d.counts)}</span>
              </button>
            </li>
          ))}
        {pDoc &&
          !pFeat &&
          pDoc.features.map((f) => (
            <li key={f.key} data-testid="reqs-feature" data-key={f.key}>
              <button
                type="button"
                className="rq-prow"
                onClick={() => setAt({ doc: pDoc.key, feat: f.key })}
              >
                <span className="block rq-ell">
                  {featName(f)} <span className="rq-muted">{f.tail}</span>
                </span>
                <span className="rq-muted">{t('reqs.tree.counts', f.counts)}</span>
              </button>
            </li>
          ))}
        {pFeat && pFeat.reqs.map(phoneReq)}
      </ul>
    </div>
  );

  const nums = (
    <>
      <span className="rq-b" data-testid="reqs-total">
        {t('reqs.head.total', { count: head.total })}
      </span>
      {REQ_STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          className="rq-num"
          aria-pressed={status === s}
          title={t(`reqs.head.hint.${s}`, { count: head[s] })}
          onClick={() => setStatus(status === s ? '' : s)}
          data-testid="reqs-head-count"
          data-state={s}
          data-count={head[s]}
        >
          <span className="rq-dot" data-s={s} />
          {t(`reqs.state.${s}`)} {head[s]}
        </button>
      ))}
    </>
  );
  const checkBtn = (
    <Button
      size="sm"
      className={mobile ? 'w-full' : ''}
      onClick={() => setCheck(true)}
      data-testid="reqs-check-open"
      data-count={checks}
    >
      {t('reqs.check')}
      <span className="rq-count">{checks}</span>
    </Button>
  );
  const search = (
    <label className="rq-search">
      <Icon name="search" size={16} pixel="?" />
      <input
        type="search"
        aria-label={t('reqs.search')}
        placeholder={t('reqs.search')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        data-testid="reqs-search"
      />
    </label>
  );
  const gear = (
    <Button
      variant="default"
      size="icon_md"
      aria-label={t('reqs.gear')}
      title={t('reqs.gear')}
      onClick={() => setSheet(true)}
      data-testid="reqs-gear"
    >
      <Icon name="settings" size={16} pixel="⚙" />
    </Button>
  );
  const chips = (
    <div className="rq-filter" role="group" aria-label={t('reqs.filter')}>
      {(['', ...REQ_STATUSES] as const).map((s) => (
        <button
          key={s || 'all'}
          type="button"
          className="rq-chip"
          aria-pressed={status === s}
          onClick={() => setStatus(s)}
          data-testid="reqs-chip"
          data-state={s || 'all'}
        >
          {s ? t(`reqs.state.${s}`) : t('reqs.filter.all')}
        </button>
      ))}
      {show && (
        <button
          type="button"
          className="rq-chip"
          aria-pressed
          onClick={() => setShow('')}
          aria-label={t('spec.overview.clearShow', { what: showText(show) })}
          data-testid="spec-reqs-show"
          data-show={show}
        >
          {t('reqs.filter.from', { what: showText(show) })}
        </button>
      )}
      {acceptance && (
        <button
          type="button"
          className="rq-chip"
          aria-pressed
          onClick={() => setAcceptance('')}
          data-testid="spec-reqs-acceptance"
          data-acc={acceptance}
        >
          {t('reqs.filter.from', {
            what:
              acceptance === 'review'
                ? t('spec.accept.filterReview')
                : t(`spec.acc.${acceptance as 'none'}`),
          })}
        </button>
      )}
      <label className="rq-link ml-auto flex items-center gap-4 pointer-coarse:min-h-44">
        <input
          type="checkbox"
          checked={gone}
          onChange={(e) => setGone(e.target.checked)}
          data-testid="reqs-gone"
        />
        {t('reqs.filter.gone')}
      </label>
    </div>
  );
  const emptyFilter = (
    <Empty
      title={
        status && !q
          ? t('reqs.empty.filter.state', { state: t(`reqs.state.${status}`) })
          : t('reqs.empty.filter.search')
      }
      testId="reqs-empty-filter"
    >
      <Button size="sm" onClick={clear} data-testid="reqs-clear">
        {t('reqs.empty.filter.clear')}
      </Button>
    </Empty>
  );
  const capped = items.data.total > rows.length && (
    <p className="rq-muted">
      {t('reqs.tree.capped', { total: items.data.total, shown: rows.length })}
    </p>
  );
  const notReadLink = !!notRead && (
    <button
      type="button"
      className="rq-link mt-12"
      onClick={() => setSheet(true)}
      data-testid="reqs-not-read"
    >
      {t('reqs.tree.notRead', { count: notRead })} ›
    </button>
  );
  const detail = open && (
    <ReqDetail
      key={open}
      project={project}
      uid={open}
      mobile={mobile}
      pane={!mobile}
      section={rows.find((r) => r.uid === open)?.section}
      onClose={() => setOpen(null)}
      onChanged={reloadAll}
    />
  );
  const overlays = (
    <>
      {sheet && docs.data && (
        <Sheet
          project={project}
          mobile={mobile}
          docs={allDocs}
          alerts={docs.data.alerts}
          candidates={cands.data?.docs ?? []}
          workflow={docs.data.workflow}
          onSet={onSet}
          onClose={() => setSheet(false)}
          reload={reloadAll}
        />
      )}
      {check && (
        <CheckWindow
          questions={qs.data?.questions ?? []}
          review={qs.data?.review ?? []}
          decisions={dec.data?.decisions ?? []}
          act={act}
          onClose={() => setCheck(false)}
        />
      )}
    </>
  );

  if (mobile)
    return (
      <div className="rq" data-mobile data-testid="spec-reqs" data-enabled="true">
        <div className="flex items-center gap-8">
          <div className="rq-head rq-grow">{nums}</div>
          {gear}
        </div>
        {checkBtn}
        {search}
        {chips}
        {zero ? (
          <Empty
            title={t('reqs.empty.zero.title')}
            body={t('reqs.empty.zero.body')}
            testId="reqs-empty-zero"
          >
            <Button size="sm" onClick={() => setSheet(true)}>
              {t('reqs.empty.zero.open')}
            </Button>
          </Empty>
        ) : !shown.length ? (
          emptyFilter
        ) : (
          phoneTree
        )}
        {capped}
        {notReadLink}
        {detail}
        {overlays}
      </div>
    );
  return (
    <div className="rq" data-testid="spec-reqs" data-enabled="true">
      <div className="rq-head">
        {nums}
        <div className="rq-tools">
          {checkBtn}
          {search}
          {gear}
        </div>
      </div>
      {zero ? (
        <Empty
          title={t('reqs.empty.zero.title')}
          body={t('reqs.empty.zero.body')}
          testId="reqs-empty-zero"
        >
          <Button
            size="sm"
            variant="accent"
            onClick={() => setSheet(true)}
            data-testid="reqs-zero-gear"
          >
            {t('reqs.empty.zero.open')}
          </Button>
        </Empty>
      ) : (
        <div className="rq-cols">
          <div className="rq-panel rq-tree">
            {chips}
            {shown.length ? desktopTree : emptyFilter}
            {capped}
            {notReadLink}
          </div>
          <div className="rq-panel">
            {detail || <p className="rq-pane-empty">{t('reqs.empty.pickOne')}</p>}
          </div>
        </div>
      )}
      {overlays}
    </div>
  );
}

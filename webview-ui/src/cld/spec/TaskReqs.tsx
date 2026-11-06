/**
 * SPT-P3-ISSUES (SPT §6.3): the spec part of the 이슈 tab, loaded lazily by the TaskBoard. The
 * 요구사항 filter (pick a requirement from `…/items`, then its confirmed Tasks from `…/item/:uid`)
 * and a Task detail's 관련 요구사항 (`…/task/:taskId`, ReqDetail's chips, [확인]·[아님],
 * [요구사항 연결], a chip opens ReqDetail). Fetched only while shown, again on `specChanged`.
 */
import '../../i18n/specStrings.js';

import { useEffect, useState } from 'react';

import type { LinkStatus, TraceTaskReqs } from '../../../../core/src/cld/spec/trace.js';
import { Button } from '../../components/ui/Button.js';
import { SPEC_ISSUES_PICK_MAX, SPEC_SEARCH_WAIT_MS } from '../../constants.js';
import { useIsMobile } from '../../hooks/useIsMobile.js';
import { t } from '../../i18n/index.js';
import { cldToast } from '../officeStore.js';
import { type BoardRequirement, confirmedTasks } from '../taskboard/taskBoardState.js';
import { LinkChip, ReqDetail } from './ReqDetail.js';
import { itemPath, type TraceItem, traceWrite, useTrace } from './traceApi.js';

const muted = 'text-text-muted text-xs';
const inputCls =
  'bg-bg border-ui rounded-ui-card border-border px-4 py-2 text-xs pointer-coarse:min-h-44 min-w-0';
const ORDER: Record<LinkStatus, number> = { confirmed: 0, observed: 1, suggested: 2, rejected: 3 };

type ItemRow = { uid: string; displayId?: string; title: string; doc: string; line: number };
const labelOf = (r: ItemRow) => r.displayId ?? `${r.doc.split('/').pop()}:${r.line}`;

/** `value`, SPEC_SEARCH_WAIT_MS after it last changed (like the 요구사항 tab's search; theirs is SpecTabs-private). */
function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), SPEC_SEARCH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

/** Search the 요구사항 list (`…/items?q=`) by display ID or title and pick one. */
function ReqPicker({
  project,
  onPick,
  onClose,
}: {
  project: string;
  onPick: (r: ItemRow) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const q = useSettled(text.trim());
  const { data, error } = useTrace<{ enabled: boolean; items: ItemRow[] }>(
    project,
    `items?${new URLSearchParams({ ...(q && { q }), limit: String(SPEC_ISSUES_PICK_MAX) })}`,
  );
  return (
    <div
      className="border-ui rounded-ui-card border-border p-6 space-y-6 min-w-0 w-full"
      data-testid="spec-issues-picker"
    >
      <div className="flex gap-6 min-w-0">
        <input
          type="search"
          autoFocus
          aria-label={t('spec.issues.filterHint')}
          placeholder={t('spec.issues.filterHint')}
          className={`${inputCls} flex-1`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="spec-issues-search"
        />
        <Button size="sm" onClick={onClose}>
          {t('spec.issues.cancel')}
        </Button>
      </div>
      {error && (
        <p className="text-red-400 text-xs" role="alert">
          {error}
        </p>
      )}
      {data && !data.enabled && <p className={muted}>{t('spec.docs.off')}</p>}
      {data?.enabled && !data.items.length && <p className={muted}>{t('spec.issues.none')}</p>}
      <ul className="max-h-[12rem] overflow-y-auto">
        {data?.enabled &&
          data.items.map((r) => (
            <li key={r.uid}>
              <button
                type="button"
                className="w-full text-left px-4 py-2 border-b border-border min-w-0 text-xs pointer-coarse:min-h-44"
                onClick={() => onPick(r)}
                data-testid="spec-issues-pick"
                data-id={r.displayId ?? ''}
              >
                <span className="font-mono break-all">{labelOf(r)}</span>{' '}
                <span className="text-text-muted break-words">{r.title}</span>
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

/** The board's 요구사항 filter: the picker, then a chip with ✕ while its confirmed Tasks load and stay current. */
export function ReqFilter({
  project,
  value,
  onChange,
  onClose,
}: {
  project: string;
  value: BoardRequirement | null;
  onChange: (next: BoardRequirement | null) => void;
  onClose: () => void;
}) {
  const { data, error } = useTrace<TraceItem>(project, value ? itemPath(value.uid) : null);
  const tasks = data ? confirmedTasks(data.edges) : undefined;
  const key = tasks?.join('\n');
  // A new answer with the same Tasks changes nothing (`key` compares them).
  useEffect(() => {
    if (value && tasks && key !== value.tasks?.join('\n')) onChange({ ...value, tasks });
  }, [key, value, tasks, onChange]);
  if (!value)
    return (
      <ReqPicker
        project={project}
        onClose={onClose}
        onPick={(r) => onChange({ uid: r.uid, label: labelOf(r) })}
      />
    );
  return (
    <span
      className="flex items-center gap-4 border-ui rounded-ui-card border-accent px-4 text-xs min-w-0"
      data-testid="spec-issues-chip"
      data-uid={value.uid}
    >
      {/* The word in the UI font, the display ID in the code font (it has no Hangul). */}
      <span>{t('spec.issues.filter')}</span>
      <span className="font-mono break-all">{value.label}</span>
      {error && (
        <span className="text-red-400" role="alert">
          {error}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('spec.issues.clear')}
        onClick={() => (onChange(null), onClose())}
        data-testid="spec-issues-clear"
      >
        ✕
      </Button>
    </span>
  );
}

/** A Task detail's 관련 요구사항; nothing at all while spec tracking is off. */
export function TaskReqs({
  project,
  taskId,
  readOnly,
}: {
  project: string;
  taskId: string;
  readOnly: boolean;
}) {
  const { data, error, reload } = useTrace<TraceTaskReqs>(
    project,
    `task/${encodeURIComponent(taskId)}`,
  );
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const mobile = useIsMobile();
  const act = (p: Promise<unknown>) =>
    void p.then(
      () => (cldToast(t('spec.issues.title'), t('spec.done'), 'ok'), reload()),
      (err: Error) => cldToast(t('spec.issues.title'), err.message, 'error'),
    );
  if (error)
    return (
      <p className="text-red-400 text-xs" role="alert">
        {error}
      </p>
    );
  if (!data?.enabled) return null;
  const nodes = new Map(data.nodes.map((n) => [n.id, n] as const));
  const edges = [...data.edges].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  return (
    <section className="space-y-4 min-w-0" data-testid="spec-task-reqs">
      <p className="text-text-muted">{t('spec.issues.title')}</p>
      {!edges.length && <p className={muted}>{t('spec.issues.empty')}</p>}
      <ul className="space-y-4">
        {edges.map((e) => (
          <LinkChip
            key={e.id}
            project={project}
            e={e}
            other={nodes.get(e.from)}
            act={act}
            onOpen={() => setOpen(e.from)}
          />
        ))}
      </ul>
      {!readOnly && !picking && (
        <Button size="sm" onClick={() => setPicking(true)} data-testid="spec-issues-link">
          {t('spec.issues.link')}
        </Button>
      )}
      {picking && (
        <ReqPicker
          project={project}
          onClose={() => setPicking(false)}
          onPick={(r) => (
            setPicking(false),
            act(traceWrite.add(project, { from: r.uid, to: taskId, rel: 'implements' }))
          )}
        />
      )}
      {open && (
        <ReqDetail
          project={project}
          uid={open}
          mobile={mobile}
          onClose={() => setOpen(null)}
          onChanged={reload}
        />
      )}
    </section>
  );
}

/**
 * The review loop in a task worktree's diff (steps ③–④): click a numbered row (tap on the
 * phone: a bottom sheet) to add a note, shift-click a second row for a range, edit or delete;
 * notes sit under their last row and say 바뀜 when the file changed since; the bar counts
 * what waits. The send button and the header are TaskReview's (devroom/): one component for the
 * dev room's 변경 tab and the 작업실. Restyled to mockups-1101/review-loop-R1/R2 (P4-S3).
 */
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ReviewNote } from '../../../../core/src/messages.js';
import { useIsMobile } from '../../hooks/useIsMobile.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { enterSends, isTouchDevice } from '../messenger/sendKey.js';
import type { DiffView } from './repoStore.js';
import type { DiffKind, DiffRow } from './repoText.js';
import { diffCounts, diffRows } from './repoText.js';
import {
  inRange,
  lineRange,
  noteWhere,
  placeNotes,
  reviewAdd,
  reviewDelete,
  reviewEdit,
  reviewKey,
  useReviewStore,
} from './reviewStore.js';

const button =
  'border-2 border-border bg-btn-bg px-10 py-4 text-xs shadow-pixel hover:bg-btn-hover disabled:opacity-(--btn-disabled-opacity) disabled:cursor-default';
const primary = `${button} border-devroom-main-line bg-accent text-white hover:bg-accent-bright`;
const muted = 'text-text-muted text-xs';
const ROW_CLASS: Record<DiffKind, string> = {
  add: 'font-mono text-devroom-ok bg-review-add-bg',
  del: 'font-mono text-devroom-bad bg-review-del-bg',
  hunk: 'font-mono text-text-muted bg-bg-dark',
  meta: 'font-mono text-text-muted',
  ctx: 'font-mono',
};
type Sel = { startLine?: number; line: number };
const send = (msg: Parameters<typeof transport.send>[0]) => transport.send(msg);
const clock = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** A note's author: the owner, or the Lead that wrote it through `add_review_note` (`agent:<name>`). */
const authorOf = (by: string): string | null => (by.startsWith('agent:') ? by.slice('agent:'.length) : null);

function NoteCard({
  project,
  task,
  note,
  face,
}: {
  project: string;
  task: string;
  note: ReviewNote;
  face?: (author: string | null) => ReactNode;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const author = authorOf(note.by);
  const sent = !!note.sentAt;
  return (
    <div
      className={`sticky left-0 my-4 mx-10 ml-76 max-w-[56rem] border-2 p-8 text-xs whitespace-normal shadow-pixel ${sent ? 'border-review-sent-line bg-review-sent-bg' : 'border-devroom-review-line bg-devroom-main'}`}
      data-testid="review-note"
      data-sent={sent ? 'yes' : 'no'}
      data-fixed={note.fixed ? 'yes' : 'no'}
    >
      <div className="flex flex-wrap items-center gap-8">
        <span className="shrink-0 flex items-center justify-center size-22 bg-bg-dark border-2 border-border text-2xs" aria-hidden="true">
          {face?.(author) ?? [...(author ?? t('review.owner'))][0]}
        </span>
        <span className={`shrink-0 ${sent ? 'text-devroom-ok' : 'text-accent-text'}`}>{author ?? t('review.owner')}</span>
        {editing === null && (
          <span className="flex-1 min-w-0 break-words whitespace-pre-wrap" data-testid="review-note-body">
            {note.body}
          </span>
        )}
        {note.stale && (
          <span
            className="border-2 border-devroom-conf-line px-4 text-devroom-conf text-2xs"
            title={t('review.staleHint')}
            data-testid="review-stale"
          >
            {t('review.stale')}
          </span>
        )}
        <span className="ml-auto shrink-0 text-2xs">
          <span className="text-text-muted">{noteWhere(note)} · </span>
          <span className={sent ? 'text-devroom-ok' : 'text-text-muted'}>
            {note.fixed ? t('review.fixedTag') : sent ? t('review.sentAt', { time: clock(note.sentAt!) }) : t('review.unsent')}
          </span>
        </span>
      </div>
      {editing === null ? (
        !sent && (
          <div className="mt-4 flex justify-end gap-4">
            <button type="button" className={button} onClick={() => setEditing(note.body)}>
              {t('review.edit')}
            </button>
            <button
              type="button"
              className={button}
              onClick={() => reviewDelete(project, task, note.id, send)}
            >
              {t('review.delete')}
            </button>
          </div>
        )
      ) : (
        <Composer
          value={editing}
          onChange={setEditing}
          submitLabel={t('review.save')}
          onCancel={() => setEditing(null)}
          onSubmit={(body) => {
            reviewEdit(project, task, note.id, body, send);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (body: string) => void;
  onCancel: () => void;
  submitLabel: string;
  label?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = () => value.trim() && onSubmit(value);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') onCancel();
    else if (enterSends(e.nativeEvent, isTouchDevice())) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="mt-4 space-y-4">
      <textarea
        ref={ref}
        className="w-full min-h-[44px] bg-bg-dark border-2 border-border p-6 text-xs"
        rows={2}
        maxLength={4000}
        placeholder={t('review.placeholder')}
        aria-label={label ?? t('review.placeholder')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        data-testid="review-input"
      />
      <div className="flex justify-end gap-6">
        <button type="button" className={`${button} min-h-[44px] md:min-h-0`} onClick={onCancel}>
          {t('review.cancel')}
        </button>
        <button
          type="button"
          className={`${primary} min-h-[44px] md:min-h-0`}
          disabled={!value.trim()}
          data-testid="review-add"
          onClick={submit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

/** The phone's sheet stands on the review's send bar (R3), wherever the shell puts that bar. */
function sheetBottom(): number {
  const bar = document.querySelector('[data-testid="review-bar"]');
  return bar ? Math.max(0, window.innerHeight - bar.getBoundingClientRect().top) : 0;
}

/** One file of a task worktree's diff, as rows that take notes (its header bar first, R1). */
export function ReviewDiff({
  project,
  task,
  file,
  view,
  onMore,
  canWrite,
  face,
  caption,
  onCompose,
  hideSent,
}: {
  project: string;
  task: string;
  file: string;
  view: DiffView;
  onMore: () => void;
  canWrite: boolean;
  face?: (author: string | null) => ReactNode;
  /** The header bar's second text: `지난 검토 이후 바뀐 곳` in the 다시 보기 view (else +a −d). */
  caption?: string;
  /** The footer says "지금 쓰는 1개는 …" while a note is being written here. */
  onCompose?: (open: boolean) => void;
  /** 다시 보기 lists the sent notes beside the diff (R4), so they are not drawn on it again. */
  hideSent?: boolean;
}) {
  const { notes } = useReviewStore();
  const phone = useIsMobile();
  const [sel, setSel] = useState<Sel | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    setSel(null);
    setAnchor(null);
    setDraft('');
  }, [file]);
  const composing = sel !== null;
  useEffect(() => {
    onCompose?.(composing);
    return () => onCompose?.(false);
  }, [composing]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = diffRows(view.text);
  const { byRow, loose } = placeNotes(rows, (notes[reviewKey(project, task)]?.notes ?? []).filter((n) => !hideSent || !n.sentAt), file);
  const counts = diffCounts(view.text);
  const close = () => {
    setSel(null);
    setAnchor(null);
    setDraft('');
  };
  const add = (body: string) => {
    if (!sel) return;
    reviewAdd(project, task, { file, ...sel, body }, send);
    close();
  };
  const pick = (row: DiffRow, e: MouseEvent | KeyboardEvent) => {
    if (!canWrite || row.newNo === undefined) return;
    const range = e.shiftKey && !phone;
    setSel(range ? lineRange(anchor, row.newNo) : { line: row.newNo });
    if (!range) setAnchor(row.newNo);
  };
  const composer = sel && (
    <Composer
      value={draft}
      onChange={setDraft}
      onCancel={close}
      onSubmit={add}
      submitLabel={t('review.add')}
      label={`${file} · ${noteWhere(sel)}`}
    />
  );
  const selRowText = sel && sel.line > 0 ? rows.find((r) => r.newNo === sel.line)?.text : undefined;
  const noted = new Set(byRow.keys());
  return (
    <div className="min-w-0" data-testid="review-file" data-file={file}>
      <div className="flex items-center gap-8 min-h-30 px-10 py-2 bg-devroom-foot border-y-2 border-border text-xs">
        <b className="font-normal break-all">{file}</b>
        <span className="text-text-muted whitespace-nowrap">
          {caption ?? (
            <>
              <span className="text-devroom-ok">+{counts.add}</span> <span className="text-devroom-bad">-{counts.del}</span>
            </>
          )}
        </span>
        {canWrite && !phone && !caption && (
          <button
            type="button"
            className={`${button} ml-auto py-0`}
            data-testid="review-file-note"
            onClick={() => setSel({ line: 0 })}
          >
            {t('review.fileNote')}
          </button>
        )}
      </div>
      {loose.map((note) => (
        <NoteCard key={note.id} project={project} task={task} note={note} face={face} />
      ))}
      {!phone && sel?.line === 0 && (
        <div className="my-4 mx-10 ml-76 border-2 border-accent-text bg-devroom-main p-8 shadow-pixel">{composer}</div>
      )}
      {view.loading && !view.text && <p className={`${muted} p-8`}>{t('repo.diffLoading')}</p>}
      {view.error && <p className="text-xs text-devroom-bad p-8">{view.error}</p>}
      <div className={`whitespace-pre bg-devroom-term py-2 leading-[1.55] ${phone ? 'text-2xs' : 'text-xs'}`} aria-label="diff" data-testid="review-diff">
        {view.text === '' && !view.loading && !view.error && <p className={`${muted} p-8`}>{t('repo.diffEmpty')}</p>}
        {rows.map((row) => {
          if (row.kind === 'meta') return null;
          const clickable = canWrite && row.newNo !== undefined;
          const marked = inRange(row.newNo, sel) || noted.has(row.key);
          return (
            <div key={row.key}>
              <div
                className={`grid grid-cols-[3rem_3rem_1fr] min-w-max px-4 ${ROW_CLASS[row.kind]} ${clickable ? 'cursor-pointer hover:bg-active-bg' : ''} ${marked ? 'outline-2 outline-accent-text -outline-offset-2' : ''}`}
                data-testid="review-row"
                data-new={row.newNo ?? ''}
                {...(clickable && {
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': t('review.rowLabel', { line: row.newNo! }),
                  onClick: (e: MouseEvent) => pick(row, e),
                  onKeyDown: (e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      pick(row, e);
                    }
                  },
                })}
              >
                <span className="font-pixel text-right pr-4 text-text-muted tabular-nums">
                  {row.oldNo ?? ''}
                </span>
                <span className="font-pixel text-right pr-8 text-text-muted tabular-nums">
                  {row.newNo ?? ''}
                </span>
                <span className={ROW_CLASS[row.kind]}>{row.text}</span>
              </div>
              {byRow.get(row.key)?.map((note) => (
                <NoteCard key={note.id} project={project} task={task} note={note} face={face} />
              ))}
              {!phone && sel && sel.line > 0 && sel.line === row.newNo && (
                <div
                  className="sticky left-0 my-4 mx-10 ml-76 max-w-[56rem] border-2 border-accent-text bg-devroom-main p-8 shadow-pixel whitespace-normal"
                  data-testid="review-composer"
                >
                  <span className="text-2xs text-accent-text">{noteWhere(sel)}</span>
                  {composer}
                </div>
              )}
            </div>
          );
        })}
        {phone && canWrite && rows.length > 0 && <p className={`${muted} px-12 py-8 whitespace-normal`}>{t('review.hintPhone')}</p>}
      </div>
      {view.nextOffset !== undefined && (
        <div className="p-8 flex flex-wrap items-center gap-8">
          <button type="button" className={button} disabled={view.loading} onClick={onMore}>
            {view.loading ? t('messenger.loading') : t('messenger.showMore')}
          </button>
          <span className={muted}>
            {t('repo.diffShown', { amount: Math.round(view.nextOffset / 1024) })}
          </span>
        </div>
      )}
      {view.limited && <p className={`${muted} p-8`}>{t('repo.diffLimited')}</p>}
      {phone &&
        sel &&
        // Fixed inside the phone shell's transformed track would size to the track: the body.
        createPortal(
          <div
            className="fixed inset-x-0 z-50 border-t-2 border-accent-text bg-bg p-12 shadow-pixel"
            style={{ bottom: sheetBottom() }}
            role="dialog"
            aria-label={t('review.sheetTitle')}
            data-testid="review-sheet"
          >
            <div className="flex items-center justify-between gap-8">
              <span className="text-sm text-accent-text break-all">
                {file.split('/').pop()} · {noteWhere(sel)}
              </span>
              <button
                type="button"
                className={`${button} min-h-[44px] min-w-[44px]`}
                aria-label={t('review.cancel')}
                onClick={close}
              >
                ×
              </button>
            </div>
            {selRowText !== undefined && (
              <pre className="mt-4 overflow-hidden text-ellipsis whitespace-pre border-2 border-border bg-devroom-term p-4 font-mono text-xs">
                {selRowText}
              </pre>
            )}
            {composer}
            <p className={`${muted} mt-4`}>{t('review.sheetHint')}</p>
          </div>,
          document.body,
        )}
    </div>
  );
}

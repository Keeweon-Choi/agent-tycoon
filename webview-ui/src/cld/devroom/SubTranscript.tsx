/**
 * DEVROOM-SUBVIEW: an agent's sub-agents on the 터미널 board. A `서브 n` chip on its card and its
 * pane opens their list (what each does, running or done, how long, its last step); the one picked
 * reads like a messenger in that pane (DEVROOM-SUBCHAT, subChat.ts): the lead's task a folded card
 * on top, what the sub-agent said as bubbles, its tool calls folded between them into one summary
 * line (a failed one stays visible). 명령 모두 보기 turns it back into the terminal-like list: every
 * call with its arguments and folded result. Newest at the bottom, following while it runs unless
 * the reader scrolled up. Read-only. Only that one is streamed (the work view, T-0056: `workView`
 * while shown, nothing after).
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ChatItem } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { DEVROOM_RESULT_LINES } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { elapsedDuration } from '../kinds.js';
import { Line } from '../messenger/Line.js';
import { useCldStore } from '../officeStore.js';
import { applyContent, viewMessage, type WorkSnapshot } from '../work/workStore.js';
import { SMALL } from './devroomData.js';
import { lineText, type SubRow } from './subagents.js';
import { countSteps, failedSteps, failureHint, foldTranscript, outputsOf, type Step } from './subChat.js';

const subState = (s: SubRow): string => t(s.running ? 'devroom.sub.running' : 'devroom.sub.done');
const subElapsed = (s: SubRow, now: number): string => elapsedDuration((s.endedAt ?? now) - s.since);

/** The `서브 n` chip: n sub-agents running. */
export function SubChip({ subs, open, onClick }: { subs: readonly SubRow[]; open?: boolean; onClick: () => void }) {
  // DEVROOM-BOARD2 (owner 11-03 11:51): only a sign of activity, n running; gone when none runs.
  const running = subs.filter((s) => s.running).length;
  if (!running) return null;
  return (
    <button
      type="button"
      className={`shrink-0 px-6 h-22 pointer-coarse:min-h-36 border-2 ${SMALL} border-devroom-review-line text-devroom-review ${open ? 'bg-devroom-review-bg' : 'bg-transparent'}`}
      aria-expanded={open}
      data-testid="devroom-sub-chip"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {t('devroom.sub.chip', { n: running })}
    </button>
  );
}

/** The list a chip opens: one row per sub-agent, the newest step in one line. */
export function SubList({ subs, now, onPick }: { subs: readonly SubRow[]; now: number; onPick: (key: string) => void }) {
  return (
    <ul className="flex flex-col" data-testid="devroom-sub-list">
      {subs.map((s) => {
        const last = s.lines.at(-1);
        return (
          <li key={s.key}>
            <button
              type="button"
              className="w-full text-left px-10 py-6 pointer-coarse:min-h-44 hover:bg-btn-hover border-b-2 border-border flex flex-col gap-2 min-w-0"
              data-testid="devroom-sub-row"
              data-running={s.running || undefined}
              onClick={() => onPick(s.key)}
            >
              <span className={`flex items-center gap-6 min-w-0 ${SMALL}`}>
                <span className={`size-6 shrink-0 ${s.running ? 'bg-status-active' : 'bg-status-success'}`} />
                <strong className="min-w-0 flex-1 truncate text-text" title={s.desc}>
                  {s.desc || t('devroom.sub.noDesc')}
                </strong>
                <span className="shrink-0 text-text-muted">
                  {subState(s)} · {subElapsed(s, now)} · {t('devroom.sub.steps', { n: s.lines.length })}
                </span>
              </span>
              {last && <span className={`block truncate text-text-muted font-transcript ${SMALL}`}>❯ {lineText(last)}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The work view of one sub-agent while `on`: its items as they come (nothing once it is off). */
function useWorkView(sub: SubRow, on: boolean): WorkSnapshot {
  const [snap, setSnap] = useState<WorkSnapshot>({ open: null, items: null, title: null, error: null });
  const { agentId, parent } = sub;
  useEffect(() => {
    if (!on) return;
    const ref = { kind: 'subagent' as const, agentId, id: parent };
    setSnap({ open: { ref, kind: 'subagent', name: '', leadId: agentId, model: null, modelId: null }, items: null, title: null, error: null });
    const off = transport.onMessage((m) => {
      if (m.type === 'workContent') setSnap((s) => applyContent(s, m));
    });
    transport.send(viewMessage(ref, true));
    return () => {
      off();
      transport.send(viewMessage(ref, false));
    };
  }, [agentId, parent, on]);
  return snap;
}

/** A tool's result: its first lines, the rest behind a press. */
function Result({ text, failed }: { text: string; failed?: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const more = lines.length - DEVROOM_RESULT_LINES;
  return (
    <div className={`pl-16 flex gap-6 ${failed ? 'text-danger' : 'text-text-muted'}`} data-testid="devroom-sub-result" data-failed={failed || undefined}>
      <span className="shrink-0 font-transcript">└</span>
      <div className="min-w-0">
        <pre className="font-transcript whitespace-pre-wrap break-words m-0">{open || more <= 0 ? text : lines.slice(0, DEVROOM_RESULT_LINES).join('\n')}</pre>
        {more > 0 && (
          <button type="button" className="text-accent-text hover:underline" onClick={() => setOpen(!open)}>
            {open ? t('devroom.sub.fold') : t('devroom.sub.more', { n: more })}
          </button>
        )}
      </div>
    </div>
  );
}

function Item({ item }: { item: ChatItem }) {
  if (item.kind === 'user')
    return (
      <pre className="font-transcript whitespace-pre-wrap break-words m-0 px-8 py-6 bg-bg border-l-2 border-devroom-main-line text-accent-text" data-testid="devroom-sub-prompt">
        {item.text}
      </pre>
    );
  if (item.kind === 'result') return <Result text={item.text} failed={item.failed} />;
  if (item.kind === 'tool')
    return (
      <div className="font-transcript break-words" data-testid="devroom-sub-tool">
        <span className="text-devroom-ok">● </span>
        <strong className="font-transcript text-text">{item.toolName}</strong>
        <span className="font-transcript text-text whitespace-pre-wrap">({item.args ?? item.text})</span>
        {item.desc && <span className="font-transcript text-text-muted"> · {item.desc}</span>}
      </div>
    );
  return (
    <div className="flex gap-6">
      <span className="shrink-0 font-transcript text-text">●</span>
      <pre className="font-transcript whitespace-pre-wrap break-words m-0 text-text">{item.text}</pre>
    </div>
  );
}

/** The lead's task, one folded card: the first line closed, the whole task open. */
function TaskCard({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-2 border-devroom-main-line bg-bg" data-testid="devroom-sub-task">
      <button
        type="button"
        className="w-full flex items-center gap-6 px-8 py-4 pointer-coarse:min-h-36 text-left min-w-0"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="shrink-0 text-accent-text">{open ? '▾' : '▸'}</span>
        <strong className="shrink-0 text-accent-text">{t('devroom.sub.task')}</strong>
        {!open && <span className="min-w-0 flex-1 truncate text-text-muted">{item.text.split('\n')[0]}</span>}
      </button>
      {open && <pre className="font-transcript whitespace-pre-wrap break-words m-0 px-8 pb-6 text-text">{item.text}</pre>}
    </div>
  );
}

/** Tool calls between two sayings: one summary line (kinds and counts); a failed call stays a line of its own. */
function StepsRun({ steps }: { steps: Step[] }) {
  const [open, setOpen] = useState(false);
  const failed = failedSteps(steps);
  const summary = countSteps(steps)
    .map(([kind, n]) => t(`devroom.sub.kind.${kind}`, { n }))
    .join(' · ');
  return (
    <div className="flex flex-col gap-2" data-testid="devroom-sub-steps" data-failed={failed.length || undefined}>
      <button
        type="button"
        className="self-start max-w-full flex items-center gap-6 px-6 py-2 pointer-coarse:min-h-36 border-l-2 border-border text-text-muted hover:text-text text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="shrink-0">{open ? '▾' : '▸'}</span>
        <span className="min-w-0 truncate">🔧 {summary}</span>
      </button>
      {open
        ? steps.map((s) => (
            <div key={s.call.id} className="flex flex-col gap-2 pl-8">
              <Item item={s.call} />
              {s.result && <Item item={s.result} />}
            </div>
          ))
        : failed.map((s) => (
            <p key={s.call.id} className="pl-8 m-0 text-danger break-words line-clamp-2" data-testid="devroom-sub-failed">
              ⚠ {t('devroom.sub.failed', { what: `${s.call.toolName ?? ''}(${s.call.args ?? s.call.desc ?? ''})` })}
              {s.result?.text && <span className="text-text-muted"> · {failureHint(s.result.text)}</span>}
            </p>
          ))}
    </div>
  );
}

/** The ids of the items there when the view first had any: a later saying is fresh (it may type in). */
function useFreshAfterFirst(key: string, items: ChatItem[] | null): ReadonlySet<string> | null {
  const first = useRef<{ key: string; ids: ReadonlySet<string> } | null>(null);
  if (items && first.current?.key !== key) first.current = { key, ids: new Set(items.map((i) => i.id)) };
  return first.current?.key === key ? first.current.ids : null;
}

/** One sub-agent's transcript, read-only, filling its pane. Without the work view (chat off) its steps. */
export function SubTranscript({ sub, on, now, onBack }: { sub: SubRow; on: boolean; now: number; onBack: () => void }) {
  const chat = useCldStore().officeSnapshot?.chat === true;
  const w = useWorkView(sub, on && chat);
  const [raw, setRaw] = useState(false); // 명령 모두 보기
  const list = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const before = useFreshAfterFirst(sub.key, w.items);
  const folded = useMemo(() => (w.items ? foldTranscript(w.items) : null), [w.items]);
  const outputs = useMemo(() => (folded ? outputsOf(folded.blocks) : []), [folded]);
  useEffect(() => {
    const el = list.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight; // follows its newest line, unless read further up
  }, [w.items, sub.lines]);
  const newest = w.items?.filter((i) => i.kind === 'assistant').at(-1);
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="devroom-sub-view" data-sub={sub.key} data-mode={raw ? 'raw' : 'chat'}>
      <div className={`shrink-0 flex items-center gap-8 px-8 py-4 bg-devroom-review-bg border-b-2 border-devroom-review-line min-w-0 ${SMALL}`}>
        <Button size="sm" className="text-2xs" data-testid="devroom-sub-back" onClick={onBack}>
          {t('devroom.sub.back')}
        </Button>
        <strong className="min-w-0 flex-1 truncate text-devroom-review" title={sub.desc}>
          {sub.desc || t('devroom.sub.noDesc')}
        </strong>
        <span className="shrink-0 text-text-muted">
          {subState(sub)} · {subElapsed(sub, now)}
        </span>
        {chat && (
          <Button size="sm" className="text-2xs shrink-0" aria-pressed={raw} data-testid="devroom-sub-raw" onClick={() => setRaw(!raw)}>
            {t('devroom.sub.raw')}
          </Button>
        )}
      </div>
      <div
        ref={list}
        className={`flex-1 min-h-0 overflow-y-auto px-10 py-8 flex flex-col gap-6 leading-relaxed ${SMALL}`}
        data-testid="devroom-sub-body"
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!chat ? (
          <>
            <p className="text-text-muted">{t('devroom.sub.chatOff')}</p>
            {sub.lines.map((l) => (
              <p key={l.toolId} className="font-transcript break-words text-text">
                ● {lineText(l)}
              </p>
            ))}
          </>
        ) : w.error ? (
          <p className="text-danger" role="alert">
            {w.error}
          </p>
        ) : w.items === null || folded === null ? (
          <p className="text-text-muted">{t('messenger.loading')}</p>
        ) : w.items.length === 0 ? (
          <p className="text-text-muted">{t('work.empty')}</p>
        ) : raw ? (
          w.items.map((item) => <Item key={item.id} item={item} />)
        ) : (
          <>
            {folded.prompt && <TaskCard item={folded.prompt} />}
            {folded.blocks.map((b) =>
              b.kind === 'steps' ? (
                <StepsRun key={b.id} steps={b.steps} />
              ) : (
                <Line key={b.item.id} item={b.item} received={false} fresh={b.item.id === newest?.id && !!before && !before.has(b.item.id)} />
              ),
            )}
            {outputs.length > 0 && (
              <div className="flex flex-wrap items-center gap-4" data-testid="devroom-sub-outputs">
                <span className="text-text-muted">{t('devroom.sub.outputs')}</span>
                {outputs.map((c) => (
                  <span key={`${c.kind}:${c.title}`} className="border-2 border-border px-6 max-w-full truncate text-text" title={c.title} data-kind={c.kind}>
                    {c.kind === 'commit' ? '⎇' : '📄'} {c.label}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
        {sub.running && <p className="font-transcript text-devroom-review">{t('devroom.sub.working')}</p>}
      </div>
      <p className={`shrink-0 m-0 px-10 py-4 border-t-2 border-border text-text-muted truncate ${SMALL}`} data-testid="devroom-sub-readonly">
        {t('devroom.sub.readOnly')}
      </p>
    </div>
  );
}

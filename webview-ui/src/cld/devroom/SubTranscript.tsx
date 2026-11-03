/**
 * DEVROOM-SUBVIEW: an agent's sub-agents on the 터미널 board. A `서브 n` chip on its card and its
 * pane opens their list (what each does, running or done, how long, its last step); the one picked
 * reads like a terminal session in that pane: its prompt, its text, every tool call with its
 * arguments and its folded result, newest at the bottom, following while it runs. Only that one
 * is streamed (the work view, T-0056: `workView` while shown, nothing after).
 */
import { useEffect, useRef, useState } from 'react';

import type { ChatItem } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { DEVROOM_RESULT_LINES } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { elapsedDuration } from '../kinds.js';
import { useCldStore } from '../officeStore.js';
import { applyContent, viewMessage, type WorkSnapshot } from '../work/workStore.js';
import { SMALL } from './devroomData.js';
import { lineText, type SubRow } from './subagents.js';

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
function Result({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const more = lines.length - DEVROOM_RESULT_LINES;
  return (
    <div className="pl-16 flex gap-6 text-text-muted" data-testid="devroom-sub-result">
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
  if (item.kind === 'result') return <Result text={item.text} />;
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

/** One sub-agent's transcript, read-only, filling its pane. Without the work view (chat off) its steps. */
export function SubTranscript({ sub, on, now, onBack }: { sub: SubRow; on: boolean; now: number; onBack: () => void }) {
  const chat = useCldStore().officeSnapshot?.chat === true;
  const w = useWorkView(sub, on && chat);
  const list = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useEffect(() => {
    const el = list.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight; // follows its newest line
  }, [w.items, sub.lines]);
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="devroom-sub-view" data-sub={sub.key}>
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
        ) : w.items === null ? (
          <p className="text-text-muted">{t('messenger.loading')}</p>
        ) : w.items.length === 0 ? (
          <p className="text-text-muted">{t('work.empty')}</p>
        ) : (
          w.items.map((item) => <Item key={item.id} item={item} />)
        )}
        {sub.running && <p className="font-transcript text-devroom-review">{t('devroom.sub.working')}</p>}
      </div>
    </div>
  );
}

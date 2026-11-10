/**
 * BRN K5: "where was I?" in five lines (resumeModel.ts), at the top of the overview and of the
 * phone devroom. Each line is one row cut to its width; a tap opens it (native <details>) to every
 * item in full with where it comes from. The handoff part is `…/resume`, fetched when shown, on
 * `specChanged` and when the Lead's conversation changes (a renew); never polled. Handoff text is
 * plain text here (masked and cut by the daemon), never markup.
 */
import '../../i18n/specStrings.js';
import './overview.css';

import { useMemo } from 'react';

import type { HandoffTag, TraceResume } from '../../../../core/src/agent-tycoon/spec/trace.js';
import { SPEC_OVERVIEW_REFETCH_MS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { useEngineStore } from '../engineStore.js';
import { characterVisualOf } from '../ez/visuals.js';
import { timeAgo } from '../format.js';
import { DataText, PixelIcon } from '../game/parts.js';
import { useAgtyStore } from '../officeStore.js';
import { useWaitReasons } from '../waiting.js';
import { approvalsFor, useApprovals } from '../workbench/approvals.js';
import { teamOf } from '../workbench/workbenchState.js';
import { useNow } from '../workbench/workbenchStore.js';
import { type ResumeItem, type ResumeLine, resumeLines } from './resumeModel.js';
import { useSpec } from './SpecTabs.js';

/** An untagged handoff line reads as 'unverified' (K1's rule), marked as untagged in its title. */
function Tag({ tag }: { tag?: HandoffTag }) {
  return (
    <span
      className="brs-tag"
      data-tag={tag ?? 'untagged'}
      title={tag ? undefined : t('brainResume.tag.untagged')}
    >
      {t(`brainResume.tag.${tag ?? 'unverified'}`)}
    </span>
  );
}

function Src({ item, at, now }: { item: ResumeItem; at?: string; now: number }) {
  return (
    <span className="brs-src" data-src={item.src}>
      <DataText text={t(`brainResume.src.${item.src}`)} />
      {item.src === 'handoff' && (
        <span className="brs-ago">
          <DataText text={t('brainResume.src.ago', { ago: timeAgo(at, now) })} />
        </span>
      )}
    </span>
  );
}

function Item({ item }: { item: ResumeItem }) {
  if (item.src === 'handoff')
    return (
      <span className="brs-item">
        <Tag tag={item.tag} /> <DataText text={item.text} />
      </span>
    );
  if (item.src === 'board')
    return (
      <span className="brs-item">
        <span className="ov-d">{item.task.id}</span> <DataText text={item.task.title} />
        <span className="ov-muted">
          {' '}
          <DataText text={`${t(`tasks.status.${item.task.status}`)}${item.who ? ` · ${item.who}` : ''}`} />
        </span>
      </span>
    );
  const text =
    item.kind === 'activity'
      ? t('brainResume.activity', { name: item.who, text: item.text })
      : item.kind === 'approval'
        ? t('brainResume.approval', { name: item.who, title: item.text })
        : item.kind === 'wait'
          ? t(`brainResume.wait.${item.reason}`, { name: item.who })
          : t('brainResume.member', {
              name: item.who,
              state: t(`brainResume.state.${item.state}`),
            });
  return (
    <span className="brs-item" data-state={item.kind === 'member' ? item.state : undefined}>
      <DataText text={text} />
    </span>
  );
}

/** One line: the label, then its items in a row, a source mark where the source changes. */
function Line({ line, at, now }: { line: ResumeLine; at?: string; now: number }) {
  const note = line.note && <span className="brs-note">{t(`brainResume.note.${line.note}`)}</span>;
  return (
    <li>
      <details
        className="brs-line"
        data-testid="brs-line"
        data-key={line.key}
        data-count={line.items.length}
        data-note={line.note}
      >
        <summary className="brs-row">
          <span className="brs-k">{t(`brainResume.line.${line.key}`)}</span>
          <span className="brs-sum">
            {!line.items.length && (
              <span className="ov-muted">{t(`brainResume.empty.${line.key}`)} </span>
            )}
            {line.items.map((x, i) => (
              <span key={i}>
                {i > 0 && (line.items[i - 1].src === x.src ? ' · ' : ' ')}
                {(i === 0 || line.items[i - 1].src !== x.src) && <Src item={x} at={at} now={now} />}
                <Item item={x} />
              </span>
            ))}
            {note && <> {note}</>}
          </span>
        </summary>
        <ul className="brs-full">
          {line.items.map((x, i) => (
            <li key={i} data-testid="brs-item" data-src={x.src}>
              <Src item={x} at={at} now={now} /> <Item item={x} />
            </li>
          ))}
          {line.more > 0 && (
            <li className="ov-muted">{t('brainResume.more', { count: line.more })}</li>
          )}
          {!line.items.length && <li className="ov-muted">{t(`brainResume.empty.${line.key}`)}</li>}
          {note && <li>{note}</li>}
        </ul>
      </details>
    </li>
  );
}

export function ResumeLines({ project }: { project: string }) {
  const { taskBoard, officeSnapshot } = useAgtyStore();
  const engine = useEngineStore().state?.projects;
  const waiting = useWaitReasons();
  const { approvals } = useApprovals();
  const now = useNow();
  const team = useMemo(
    () => teamOf(project, officeSnapshot, engine),
    [project, officeSnapshot, engine],
  );
  const lead = officeSnapshot?.orchestrators.find((o) => o.name === project);
  // A renew starts a new conversation: its session id in the route reads the handoff again.
  const { data } = useSpec<TraceResume>(
    project,
    `resume?s=${encodeURIComponent(lead?.sessionId ?? '')}`,
    SPEC_OVERVIEW_REFETCH_MS,
  );
  const visual = lead?.agentId != null ? characterVisualOf(lead.agentId) : undefined;
  const lines = resumeLines({
    project,
    tasks: taskBoard?.tasks ?? [],
    handoff: data ? data.handoff : undefined,
    team,
    waiting,
    approvals: approvalsFor(approvals, project),
    leadActivity: visual?.ring === 'working' ? visual.text : null,
  });
  return (
    <section
      className="ov-panel brs"
      data-testid="brain-resume"
      data-handoff={data ? !!data.handoff : undefined}
    >
      <h3>
        <PixelIcon name="flag" />
        {t('brainResume.title')}
        <small className="brs-sub">{t('brainResume.subtitle')}</small>
      </h3>
      <ul className="brs-lines">
        {lines.map((l) => (
          <Line key={l.key} line={l} at={data?.handoff?.at} now={now} />
        ))}
      </ul>
    </section>
  );
}

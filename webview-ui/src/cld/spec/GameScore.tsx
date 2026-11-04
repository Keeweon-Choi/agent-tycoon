/**
 * GAME-UI-1 G2 (specs/ui-mock-1103 cockpit 11, agents 08): the 수락 HI-SCORE's digit cells (the
 * 개요's big one and the tab row's copy, TabHiScore) and 이번 주 수락 (WeekPanel, the 개요's 요구사항
 * side). Both draw the summary as it is: a number that rose since it was shown rolls up one place
 * after the other (the ones first), a new cell drops onto today's column; with 게임 효과 off or
 * reduced motion, the end state at once. Its own small chunk: the tab row loads only this.
 */
import '../../i18n/specStrings.js';
import './score.css';

import { type CSSProperties, useState } from 'react';

import type { TraceAcceptanceWeek } from '../../../../core/src/cld/spec/trace.js';
import { GAME_ROLL_STEP_MS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { useGameMotion } from '../game/gameMotion.js';
import { DataText, PixelIcon } from '../game/parts.js';
import { openTab } from '../workbench/workbenchStore.js';
import { padScore, rollDigits, weekView } from './overviewModel.js';
import type { Summary } from './SpecTabs.js';
import { useTrace } from './traceApi.js';

/** `value`'s digit cells; a rise since the last render rolls (re-keyed per change so it plays once), '+n' shows briefly, and the new score is read out once. */
export function HiScore({ value, total, big = false }: { value: number; total: number; big?: boolean }) {
  const motion = useGameMotion();
  const [shown, setShown] = useState({ value, from: value, run: 0 });
  if (shown.value !== value) setShown({ value, from: shown.value, run: shown.run + 1 });
  const rolling = motion && value > shown.from;
  const cells = rollDigits(rolling ? shown.from : value, value);
  return (
    <span className="hi-v" data-big={big || undefined}>
      {/* The cells draw their digits as ::before/::after (data-was, data-now); the number's one text is .hi-text, so it reads 0010, not 0 0 1 0. */}
      <span className="hi-digits" key={shown.run} data-testid="hi-digits" data-value={value}>
        {cells.map((c, i) => (
          <i key={i} data-lead={c.lead || undefined} aria-hidden="true">
            {rolling && c.roll !== undefined ? (
              <b data-roll data-was={c.was} data-now={c.now} style={{ '--roll-delay': `${c.roll * GAME_ROLL_STEP_MS}ms` } as CSSProperties} />
            ) : (
              <b data-now={c.now} />
            )}
          </i>
        ))}
        <span className="hi-text">{padScore(value)}</span>
      </span>
      <span className="hi-of">/ {padScore(total)}</span>
      {rolling && (
        <span className="hi-plus" key={`p${shown.run}`} aria-hidden="true">
          +{value - shown.from}
        </span>
      )}
      <span className="sr-only" aria-live="polite">
        {shown.run > 0 ? t('game.ov.hiScoreName', { count: value, total }) : ''}
      </span>
    </span>
  );
}

/** The tab row's HI-SCORE (every tab but the 개요, which has the big one): opens 요구사항 on 수락. */
export function TabHiScore({ project }: { project: string }) {
  const { data: s } = useTrace<Summary>(project, 'summary');
  const accepted = s?.acceptance?.accepted;
  const total = s?.items?.total;
  if (!s?.enabled || s.corrupt || accepted === undefined || total === undefined) return null;
  return (
    <button
      type="button"
      className="hi-tab"
      onClick={() => openTab('reqs', 'acc:accepted')}
      data-testid="tab-hi-score"
      data-count={accepted}
      aria-label={t('game.ov.hiScoreName', { count: accepted, total })}
    >
      <PixelIcon name="star" />
      {t('spec.acc.accepted')} <span className="hi-name">{t('game.ov.hiScore')}</span>
      <HiScore value={accepted} total={total} />
    </button>
  );
}

const dateOf = (start: string, plus: number) => {
  const [y, m, d] = start.split('-').map(Number);
  return new Date(y, m - 1, d + plus);
};

/** 이번 주 수락: the days' columns (accepted, rejected on top), this week against the best past week, the past five. */
export function WeekPanel({ week }: { week: TraceAcceptanceWeek }) {
  const v = weekView(week);
  const names = t('game.week.days').split(',');
  const today = week.days[week.today]?.accepted ?? 0;
  const [seen, setSeen] = useState({ today, drop: 0 });
  if (seen.today !== today) setSeen({ today, drop: today > seen.today ? seen.drop + 1 : seen.drop });
  const day = (i: number) => {
    const d = dateOf(week.start, i);
    return t('game.week.date', { month: d.getMonth() + 1, day: d.getDate(), name: names[i] ?? '' });
  };
  return (
    <section className="wk" data-testid="ov-week" data-total={v.total} data-best={v.best} data-record={v.record || undefined}>
      <h4 className="wk-h">
        <PixelIcon name="star" />
        {t('game.week.title')}
        <span className="wk-range">
          <DataText text={t('game.week.range', { from: day(0), to: day(6) })} />
        </span>
      </h4>
      <div className="wk-body">
        <div className="wk-days">
          {v.days.map((d, i) => (
            <div key={i} className="wk-day" data-today={d.today || undefined} data-future={d.future || undefined} data-testid="ov-week-day" data-accepted={d.accepted} data-rejected={d.rejected}>
              <span className="wk-stack" aria-hidden="true">
                {!d.future &&
                  Array.from({ length: d.cells }, (_, c) => (
                    <i key={d.today && c === d.cells - 1 ? `n${seen.drop}` : c} data-new={(d.today && seen.drop > 0 && c === d.cells - 1) || undefined} />
                  ))}
                {!d.future && Array.from({ length: d.rejectedCells }, (_, c) => <i key={`r${c}`} data-rej />)}
              </span>
              <span className="wk-n" data-zero={!d.accepted || undefined}>
                {d.future ? '' : d.accepted}
              </span>
              <span className="wk-w">{names[i]}</span>
            </div>
          ))}
        </div>
        <div className="wk-side">
          <div className="wk-tile" data-record={v.record || undefined} data-testid="ov-week-total">
            <span className="wk-k">
              {v.record && <PixelIcon name="trophy" />}
              {t(v.record ? 'game.week.record' : 'game.week.now')}
            </span>
            <span className="wk-v" data-zero={!v.total || undefined}>
              +{v.total}
              <small> {t(v.record ? 'game.week.prevBest' : 'game.week.best', { count: v.best })}</small>
            </span>
          </div>
          <div className="wk-tile">
            <span className="wk-k">{t('game.week.past', { count: week.weeks.length })}</span>
            <span className="wk-weeks" role="img" aria-label={t('game.week.pastName', { weeks: week.weeks.join(', '), now: v.total })}>
              {v.bars.map((h, i) => (
                <i key={i} style={{ height: h }} data-now={i === v.bars.length - 1 || undefined} />
              ))}
            </span>
          </div>
        </div>
      </div>
      <p className="wk-foot">
        <span>
          <i className="wk-sw" />
          {t('spec.acc.accepted')}
        </span>
        <span>
          <i className="wk-sw" data-rej />
          {t('spec.acc.rejected')}
        </span>
        <span>{t('game.week.noGoal')}</span>
      </p>
    </section>
  );
}

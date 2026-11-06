/**
 * GAME-UI-1 G2 (specs/ui-mock-1103 cockpit 11, agents 08): 이번 주 수락 (WeekPanel, the 개요's 요구사항
 * side), drawn as the summary is: a new cell drops onto today's column; with 게임 효과 off or reduced
 * motion, the end state at once. (The HI-SCORE is gone, owner 11-06 17:23: the game feel goes into
 * the office scene.)
 */
import '../../i18n/specStrings.js';
import './score.css';

import { useState } from 'react';

import type { TraceAcceptanceWeek } from '../../../../core/src/cld/spec/trace.js';
import { t } from '../../i18n/index.js';
import { DataText, PixelIcon } from '../game/parts.js';
import { weekView } from './overviewModel.js';

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

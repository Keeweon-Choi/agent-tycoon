/**
 * STAT-CARD: what a character's summary popover and its detail view say, as plain data.
 * The numbers are the office's own (level, fatigue, context, model); this file only words and
 * orders them, so the big tiles (layout E) and the sectioned list (layout C) never disagree.
 */
import type {
  CompactionRecord,
  ContextLimitBasis,
  EngineProject,
  OfficeLevel,
  OfficeOrchestrator,
} from '../../../../core/src/messages.js';
import { STAT_DETAIL_FULL_STORAGE_KEY } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { sessionActions } from '../engine.js';
import { stateLabel } from '../format.js';
import { offDutyFacts } from '../offDuty.js';
import type { CompactionLog, FatigueLook } from './fatigueState.js';
import { basisHint, contextPctText } from './fatigueState.js';
import { levelLook } from './level.js';

export interface StatTokens {
  used: number;
  max: number;
  /** Where `max` comes from: `unknown` means the count is all that is said. */
  basis: ContextLimitBasis;
}

/** What only an orchestrator has (the old 퇴근 sheet's facts), worded; a field the office lacks is null. */
export interface StatPlace {
  /** "Gone home / off" and its state word; null while it works. */
  state: string | null;
  /** Home or off: the wake-up help line applies. */
  sleeping: boolean;
  provider: string;
  room: string;
  folder: string | null;
  session: string | null;
  /** The engine's own words when it gave up reviving the session, already worded for the viewer. */
  downNote: string | null;
  needsTrust: boolean;
}

export interface StatFacts {
  name: string;
  kind: string | null;
  lead: string | null;
  /** A temp's task. */
  task: string | null;
  level: OfficeLevel | null;
  /** The rank in words. */
  rank: string | null;
  fatigue: FatigueLook | null;
  /** The context behind the fatigue, when the character has reported it. */
  tokens: StatTokens | null;
  /** The compactions the daemon counted in its transcript (the count also covers an engine row's), or null: none. */
  rests: CompactionLog | null;
  /** What it does now (the status icon and words), and how long it has been at it. */
  activity: string | null;
  elapsed: string | null;
  model: string | null;
  effort: string | null;
  /** A roster employee's note: the same game character, never the same AI session. */
  employee: string | null;
  place: StatPlace | null;
}

export interface StatRow {
  id: string;
  label: string;
  value: string;
  /** More words on hover: where a number comes from. */
  hint?: string;
}

export interface StatSection {
  id: 'now' | 'fatigue' | 'growth' | 'run' | 'place';
  title: string;
  rows: StatRow[];
}

export const kTokens = (n: number): string => `${Math.round(n / 1000)}k`;

/** "25% (252k / 1000k)": fatigue IS the context fill, so the percent and the tokens are said once. */
export const fatigueLine = (look: FatigueLook, tokens: StatTokens | null): string =>
  tokens
    ? t('stat.fatigueLine', {
        pct: contextPctText(look.value, look.basis),
        used: kTokens(tokens.used),
        max: kTokens(tokens.max),
      })
    : t('stat.fatigueShort', { pct: contextPctText(look.value, look.basis) });

/** N of M rests, or just N when nothing says M; "≥N" when the daemon saw only part of the conversation. */
export const restValue = ({ compactions, partial, threshold }: FatigueLook): string =>
  `${partial ? '≥' : ''}${threshold === null ? compactions : `${compactions}/${threshold}`}`;

const hhmm = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "14:02 · auto · 412k → 38k": one compaction, saying only what its record carried. */
export function compactionLine(c: CompactionRecord): string {
  const span =
    c.preTokens !== undefined && c.postTokens !== undefined
      ? t('ctxsrc.tokenSpan', { pre: kTokens(c.preTokens), post: kTokens(c.postTokens) })
      : c.postTokens !== undefined
        ? t('ctxsrc.tokenAfter', { post: kTokens(c.postTokens) })
        : c.preTokens !== undefined
          ? t('ctxsrc.tokenBefore', { pre: kTokens(c.preTokens) })
          : null;
  return [hhmm(c.at), c.trigger ? t(`ctxsrc.trigger.${c.trigger}`) : null, span]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

const row = (id: string, label: string, value: string | null | undefined, hint?: string): StatRow[] =>
  value ? [{ id, label, value, ...(hint && { hint }) }] : [];

/** Layout C: every number labelled, a section only when it has something to say. */
export function statSections(f: StatFacts): StatSection[] {
  const { fatigue, level, place } = f;
  const sections: StatSection[] = [
    {
      id: 'now',
      title: t('stat.sec.now'),
      rows: [
        ...row('state', t('stat.state'), place?.state),
        ...row('activity', t('stat.activity'), f.activity),
        ...row('since', t('stat.since'), f.elapsed),
        ...row('down', t('stat.down'), place?.downNote),
        ...row('trust', t('stat.trust'), place?.needsTrust ? t('stat.trustNeeded') : null),
      ],
    },
    {
      id: 'fatigue',
      title: t('stat.sec.fatigue'),
      rows: [
        ...(fatigue
          ? row('fatigue', t('stat.fatigue'), `${contextPctText(fatigue.value, fatigue.basis)}%`, basisHint(fatigue.basis))
          : []),
        ...row(
          'rest',
          t('stat.rest'),
          fatigue ? restValue(fatigue) : f.rests && `${f.rests.partial ? '≥' : ''}${f.rests.count}`,
          f.rests?.partial ? t('ctxsrc.partialHint') : undefined,
        ),
        ...(f.tokens
          ? row(
              'tokens',
              t('stat.tokens'),
              f.tokens.basis === 'unknown'
                ? t('ctxsrc.tokensOnly', { tokens: kTokens(f.tokens.used) })
                : t('stat.tokensOf', { used: kTokens(f.tokens.used), max: kTokens(f.tokens.max) }),
              basisHint(f.tokens.basis),
            )
          : []),
        ...(f.rests?.recent.length
          ? row(
              'lastRest',
              t('ctxsrc.lastRest'),
              compactionLine(f.rests.recent[f.rests.recent.length - 1]),
              [t('ctxsrc.recentRests'), ...f.rests.recent.map(compactionLine)].join('\n'),
            )
          : []),
      ],
    },
    {
      id: 'growth',
      title: t('stat.sec.growth'),
      rows: [
        ...(level
          ? [
              ...row('level', t('stat.level'), t('character.level', { level: level.level })),
              ...row('xp', t('stat.xp'), `${level.xp}`),
              ...row('next', t('stat.nextLevel'), `${levelLook(level).remaining}`),
            ]
          : []),
        ...row('rank', t('stat.rank'), f.rank),
        ...(level ? row('rebirth', t('stat.rebirth'), t('stat.rebirthCount', { count: level.rebirths })) : []),
        ...(level?.inherit ? row('inherit', t('inherit.stat'), t('inherit.statCount', { count: level.inherit })) : []),
      ],
    },
    {
      id: 'run',
      title: t('stat.sec.run'),
      rows: [
        ...row('kind', t('stat.kind'), f.kind),
        ...row('lead', t('stat.lead'), f.lead),
        ...row('task', t('stat.task'), f.task),
        ...row('employee', t('stat.employee'), f.employee),
        ...row('model', t('stat.model'), f.model),
        ...row('effort', t('stat.effort'), f.effort),
      ],
    },
    {
      id: 'place',
      title: t('stat.sec.place'),
      rows: place
        ? [
            ...row('provider', t('stat.provider'), place.provider),
            ...row('room', t('stat.room'), place.room),
            ...row('folder', t('stat.folder'), place.folder),
            ...row('session', t('stat.session'), place.session),
          ]
        : [],
    },
  ];
  return sections.filter((s) => s.rows.length > 0);
}

/** 켜기 shows for a project that is not live (asleep, off, retired) and a viewer who may act. */
export const canStartProject = (p: EngineProject | undefined, canAct: boolean): p is EngineProject =>
  canAct && !!p && sessionActions(p).includes('start');

/** The place facts of an orchestrator row, worded; the old 퇴근 sheet's content. */
export function placeOf(row: OfficeOrchestrator, project: EngineProject | undefined, away: boolean): StatPlace {
  const facts = offDutyFacts(row, project, away);
  const sleeping = facts.away || facts.off;
  return {
    state: sleeping ? `${facts.away ? t('offDuty.away') : t('offDuty.off')} · ${stateLabel(row.state, row.busy)}` : null,
    sleeping,
    provider: (row.provider ?? (project ? 'engine' : 'claude')) === 'engine' ? t('status.engineBadge') : t('offDuty.claude'),
    room: facts.room,
    folder: facts.folder,
    session: facts.session,
    downNote: facts.downNote,
    needsTrust: facts.needsTrust,
  };
}

/** Per viewer: did this one open the full list? Works without storage (the big tiles). */
export function readStatFull(): boolean {
  try {
    return localStorage.getItem(STAT_DETAIL_FULL_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeStatFull(full: boolean): void {
  try {
    localStorage.setItem(STAT_DETAIL_FULL_STORAGE_KEY, full ? '1' : '0');
  } catch {
    // no storage: the choice lasts until the view closes
  }
}

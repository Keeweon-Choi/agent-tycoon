/**
 * FEAT-PARTY-V2 (owner 11-06 17:49, 17:53, 18:14): the member card, the mockup's "에이전트 정보"
 * (specs/ui-mock-1104/hud-v3/base/ref-pc.png): a head (face, name, state, Lv and rank, the XP bar), the tabs
 * 개요 · 능력치 · 기록, and at most three big buttons; the rest waits in ⋯ (memberCard.ts decides). Real data
 * only: the activity line (no progress or ETA), the Tasks it works on, the context fill as 피로도, the
 * notices about it. Every row sits on one grid (label left, value right, the same paddings). On the PC it
 * draws into the party's slot beside the portrait (Inspector frame), on the phone as a bottom sheet.
 */
import { type ReactNode, useRef, useState } from 'react';

import type { EngineProject } from '../../../../core/src/messages.js';
import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import { MEMBER_CARD_LOG_ROWS, MEMBER_CARD_TASK_ROWS, STAT_DETAIL_FACE_PX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { transport } from '../../transport/index.js';
import { openLooks } from '../characters/looks.js';
import { chatTarget } from '../chat.js';
import { sessionActions } from '../engine.js';
import { EngineNotes } from '../EngineControls.js';
import { engineAsk, engineOpenForm, useEngineStore } from '../engineStore.js';
import { levelLook } from '../ez/level.js';
import { statSections } from '../ez/statCardRows.js';
import { openStatDetail } from '../ez/statDetail.js';
import { statFactsOf } from '../ez/statFacts.js';
import { openProjectFiles } from '../files/explorerState.js';
import { timeAgo } from '../format.js';
import { useMember } from '../game/gameLooks.js';
import { PixelIcon } from '../game/parts.js';
import { Inspector } from '../hud/Inspector.js';
import { Icon, type LucideName } from '../icons/Icon.js';
import { openMessenger } from '../messenger/messengerStore.js';
import { useNotices } from '../notify/notices.js';
import { useCldStore } from '../officeStore.js';
import { taskWho } from '../panels/dashboardModel.js';
import { useStaff } from '../staff.js';
import { TempSummary } from '../TempList.js';
import { useCanAct } from '../useCanAct.js';
import { openWork } from '../work/workStore.js';
import { PromoteButton } from '../workbench/AgentActions.js';
import { openWorkbench } from '../workbench/workbenchStore.js';
import { type MemberAction, memberActions, memberTasks } from './memberActions.js';
import { useDismiss } from './useDismiss.js';

type Tab = 'overview' | 'stats' | 'log' | 'team';
const TABS: { id: Tab; icon: LucideName; pixel: 'person' | 'bolt' | 'scroll' | 'case' }[] = [
  { id: 'overview', icon: 'user', pixel: 'person' },
  { id: 'stats', icon: 'zap', pixel: 'bolt' },
  { id: 'log', icon: 'scroll-text', pixel: 'scroll' },
  // 관계: only with real data, the temps it leads (T-0041's team list).
  { id: 'team', icon: 'users', pixel: 'case' },
];

/** A big button's look (the mockup's icon over its word). */
const MAIN: Partial<Record<MemberAction, { icon: LucideName; pixel: 'ask' | 'play' | 'stop' | 'eye' }>> = {
  chat: { icon: 'message-square-text', pixel: 'ask' },
  start: { icon: 'play', pixel: 'play' },
  stop: { icon: 'circle-stop', pixel: 'stop' },
  work: { icon: 'eye', pixel: 'eye' },
};

export interface MemberCardProps {
  id: number;
  name: string;
  palette: number;
  hueShift: number;
  /** The status words and icon (characterVisualOf), and the raw tool line behind them. */
  activity: { icon: string; text: string; ring: string };
  rawActivity: string;
  /** The rank in words and its icon. */
  rankText: string;
  rankIcon: ReactNode;
  lookName: string | undefined;
  characters: OfficeState['characters'];
  /** The party's slot (PC), or null: the bottom sheet (phone). */
  into: HTMLElement | null;
  onClose: () => void;
}

export function MemberCard(p: MemberCardProps) {
  const store = useCldStore();
  const staff = useStaff();
  const engineState = useEngineStore();
  const canAct = useCanAct();
  const { state } = useMember(p.id);
  const [tab, setTab] = useState<Tab>('overview');
  const projects = engineState.state?.projects;
  const facts = statFactsOf(p.id, p.characters, store, staff, projects);
  const project = projects?.find((x) => x.name === p.name);
  const temp = staff.temps.find((x) => x.id === p.id);
  const team = staff.temps.filter((x) => x.leadId === p.id);
  const { main, more } = memberActions({
    chat: !!chatTarget(p.id, store.officeSnapshot),
    work: !!temp?.work,
    looks: p.lookName !== undefined,
    engine: project ? { actions: sessionActions(project), worker: !!project.role && !!project.project } : null,
    canAct,
  });
  const busy = project ? engineState.busy[project.name] !== undefined : false;
  const run = (a: MemberAction) => {
    if (a === 'chat') openMessenger(p.id);
    else if (a === 'work' && temp) openWork(temp, (m) => transport.send(m));
    else if (a === 'looks' && p.lookName !== undefined) openLooks(p.lookName);
    else if (a === 'stats') openStatDetail(p.id);
    else if (a === 'dev') openWorkbench(p.name);
    else if (a === 'files') openProjectFiles(p.name);
    else if (a === 'edit' && project) engineOpenForm(project.name);
    // 켜기 / 끄기 / 재시작 / 삭제: the engine's own ask-first handler (its confirmation, the remote step-up).
    else if ((a === 'start' || a === 'stop' || a === 'restart' || a === 'remove') && project) engineAsk(a, project.name);
  };
  const level = facts.level;
  const xp = level ? levelLook(level) : null;
  return (
    <Inspector
      into={p.into}
      agentId={p.id}
      name={p.name}
      onClose={p.onClose}
      tools={
        more.length > 0 && (
          <MoreMenu actions={more} name={p.name} project={project} busy={busy} onRun={run} />
        )
      }
      footer={
        main.length > 0 && (
          <div className="mc-actions" data-count={main.length} data-testid="member-actions">
            {main.map((a) => (
              <button
                key={a}
                type="button"
                className="mc-act ui-raise"
                data-action={a}
                data-testid={`member-${a}`}
                disabled={(a === 'start' || a === 'stop') && busy}
                onClick={() => run(a)}
              >
                <Icon name={MAIN[a]!.icon} size={20} pixel={<PixelIcon name={MAIN[a]!.pixel} size={16} />} />
                <span>{t(`partyV2.act.${a}`)}</span>
              </button>
            ))}
          </div>
        )
      }
    >
      <div className="mc-who" data-testid="member-head">
        <span className="mc-face" data-testid="stat-face">
          <CharacterMugShot palette={p.palette} hueShift={p.hueShift} size={STAT_DETAIL_FACE_PX} />
        </span>
        <div className="mc-who-lines">
          <strong className="mc-name" data-testid="inspector-name">
            {p.name}
          </strong>
          <span className="mc-state" data-state={state} data-testid="member-state">
            <i className="mc-dot" aria-hidden="true" />
            {t(`game.party.state.${state}`)}
          </span>
          {(level || p.rankText) && (
            <span className="mc-rank" data-testid="level" data-level={level?.level} data-rebirths={level?.rebirths} data-xp={level?.xp}>
              {level && <b>{t('character.level', { level: level.level })}</b>}
              <span className="mc-rank-text text-yellow-300" data-testid="rank-text">
                {p.rankIcon}
                {p.rankText}
              </span>
            </span>
          )}
          {xp && (
            <span className="mc-bar-row" title={t('character.xpToNext', { count: xp.remaining })}>
              <span className="mc-label">{t('partyV2.card.xp')}</span>
              <Bar pct={xp.pct} testId="member-xp" />
              <span className="mc-value">{xp.pct}%</span>
            </span>
          )}
        </div>
      </div>
      <div className="mc-tabs ui-subtabs" role="tablist" aria-label={t('partyV2.card.tabs')}>
        {TABS.filter((x) => x.id !== 'team' || team.length > 0).map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            className="ui-tab mc-tab"
            aria-selected={tab === x.id}
            data-testid={`member-tab-${x.id}`}
            onClick={() => setTab(x.id)}
          >
            <Icon name={x.icon} size={14} pixel={<PixelIcon name={x.pixel} size={12} />} />
            {t(`partyV2.tab.${x.id}`)}
          </button>
        ))}
      </div>
      <div className="mc-body" role="tabpanel" data-tab={tab}>
        {tab === 'overview' && <Overview p={p} project={project} fatigue={facts.fatigue} elapsed={facts.elapsed} />}
        {tab === 'stats' &&
          // 지금 하는 일 is 개요's; the rest of the 스탯 rows.
          statSections(facts)
            .filter((s) => s.id !== 'now')
            .map((s) => (
            <Section key={s.id} title={s.title} testId="stat-section">
              {s.rows.map((r) => (
                <div key={r.id} className="mc-kv" data-row={r.id} title={r.hint}>
                  <span className="mc-label">{r.label}</span>
                  <span className="mc-value">{r.value}</span>
                </div>
              ))}
            </Section>
          ))}
        {tab === 'log' && <Log id={p.id} name={p.name} />}
        {tab === 'team' && team.length > 0 && (
          <Section title={t('partyV2.card.team')} count={team.length} testId="member-team">
            <TempSummary rows={team} project={project?.name ?? null} />
          </Section>
        )}
      </div>
    </Inspector>
  );
}

function Section({ title, count, testId, children }: { title: string; count?: number; testId?: string; children: ReactNode }) {
  return (
    <section className="mc-sec" data-testid={testId}>
      <h3 className="mc-sec-title">
        {title}
        {count !== undefined && <span className="mc-count">({count})</span>}
      </h3>
      {children}
    </section>
  );
}

function Bar({ pct, testId, tone }: { pct: number; testId?: string; tone?: string }) {
  return (
    <span className="mc-bar" data-testid={testId} data-tone={tone} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  );
}

function Overview({
  p,
  project,
  fatigue,
  elapsed,
}: {
  p: MemberCardProps;
  project: EngineProject | undefined;
  fatigue: { value: number; tone: string } | null;
  elapsed: string | null;
}) {
  const { taskBoard } = useCldStore();
  const tasks = memberTasks(taskBoard?.tasks ?? [], p.name, taskWho);
  const shown = tasks.slice(0, MEMBER_CARD_TASK_ROWS);
  return (
    <>
      <Section title={t('partyV2.card.now')}>
        <p className="mc-now" title={p.rawActivity} data-testid="activity-text" data-ring={p.activity.ring}>
          <span aria-hidden="true">{p.activity.icon}</span> {p.activity.text}
        </p>
        {elapsed && <p className="mc-note">{elapsed}</p>}
        {project && <EngineNotes project={project} />}
      </Section>
      <Section title={t('partyV2.card.issues')} count={tasks.length} testId="member-issues">
        {shown.length === 0 && <p className="mc-note">{t('partyV2.card.noIssues')}</p>}
        {shown.map((task) => (
          <div key={task.id} className="mc-kv mc-item" data-testid="member-issue" title={task.title}>
            <span className="mc-issue">{task.title}</span>
            <span className="mc-pill" data-status={task.status}>
              {t(`tasks.status.${task.status}`)}
            </span>
          </div>
        ))}
        {tasks.length > shown.length && <p className="mc-note">{t('partyV2.card.moreIssues', { count: tasks.length - shown.length })}</p>}
      </Section>
      <Section title={t('partyV2.card.state')}>
        <div className="mc-bar-row" data-testid="fatigue" data-tone={fatigue?.tone}>
          <span className="mc-label">{t('activity.fatigue')}</span>
          {fatigue ? <Bar pct={fatigue.value} tone={fatigue.tone} /> : <span className="mc-bar" data-empty="" />}
          <span className="mc-value">{fatigue ? `${Math.round(fatigue.value)}%` : t('activity.fatigueUnknown')}</span>
        </div>
        <p className="mc-note">{t('partyV2.card.fatigueNote')}</p>
      </Section>
    </>
  );
}

function Log({ id, name }: { id: number; name: string }) {
  const { items } = useNotices();
  const rows = items.filter((n) => n.agentId === id || n.name === name).slice(0, MEMBER_CARD_LOG_ROWS);
  return (
    <Section title={t('partyV2.card.log')} testId="member-log">
      {rows.length === 0 && <p className="mc-note">{t('partyV2.card.noLog')}</p>}
      {rows.map((n) => (
        <div key={n.id} className="mc-kv mc-item" title={n.text}>
          <span className="mc-issue">{n.text}</span>
          <span className="mc-value mc-time">{timeAgo(new Date(n.at).toISOString())}</span>
        </div>
      ))}
    </Section>
  );
}

/** ⋯: everything that is not a big button, on the same handlers. Kept mounted (hidden) while closed, so a
 *  dialog it opened (Lead 로's) outlives the fold. */
function MoreMenu({
  actions,
  name,
  project,
  busy,
  onRun,
}: {
  actions: MemberAction[];
  name: string;
  project: EngineProject | undefined;
  busy: boolean;
  onRun: (a: MemberAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  return (
    <div ref={ref} className="mc-more">
      <button
        type="button"
        className="mc-icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('partyV2.card.more')}
        title={t('partyV2.card.more')}
        data-testid="member-more"
        onClick={() => setOpen(!open)}
      >
        <Icon name="ellipsis" size={16} pixel={<span aria-hidden="true">⋯</span>} />
      </button>
      <div className="mc-menu party-menu ui-window pixel-panel" role="menu" hidden={!open} data-testid="member-more-menu">
        {actions.map((a) =>
          a === 'promote' && project?.project ? (
            <PromoteButton key={a} name={name} project={project.project} role="menuitem" className="party-row ui-row" />
          ) : (
            <button
              key={a}
              type="button"
              role="menuitem"
              className={`party-row ui-row ${a === 'remove' ? 'party-danger' : ''}`}
              data-action={a}
              data-testid={`member-more-${a}`}
              disabled={busy && (a === 'restart' || a === 'edit' || a === 'remove')}
              onClick={() => {
                setOpen(false);
                onRun(a);
              }}
            >
              {t(`partyV2.act.${a}`)}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * T-71 (owner 11-06 23:12, 23:15): the party's team pieces. SubIcons: a small icon per live sub-agent under a
 * Lead's portrait (an owner-composed party only); Relations: the 관계 tab's list (a Lead's Workers and
 * sub-agents, a Worker's Lead and the rest of its team); SubCardHost: the small card a sub-agent icon opens
 * (task, state and just that tab). A Worker opens its devroom terminal, a sub-agent its read-only transcript,
 * a Lead its messenger.
 */
import { PARTY_SUB_ICONS_MAX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { useMember } from '../game/gameLooks.js';
import { PixelIcon } from '../game/parts.js';
import { Inspector } from '../hud/Inspector.js';
import { useInspectorSlot } from '../hud/inspectorSlot.js';
import { Icon } from '../icons/Icon.js';
import { openMessenger } from '../messenger/messengerStore.js';
import type { Relation, TeamSub } from './teamTree.js';
import { setSubCard, type Team, useSubCard, useTeam } from './useTeam.js';

const subTask = (s: TeamSub) => s.desc || t('partyTeam.subTask');
const subState = (s: TeamSub) => t(`devroomSide.dot.${s.dot}`);

/** One sub-agent's icon (the mascot's place); its dot colours it. */
function SubGlyph() {
  return <Icon name="sparkles" size={12} pixel={<PixelIcon name="bolt" size={8} />} />;
}

export function SubIcons({ subs }: { subs: readonly TeamSub[] }) {
  if (subs.length === 0) return null;
  const shown = subs.length > PARTY_SUB_ICONS_MAX ? subs.slice(0, PARTY_SUB_ICONS_MAX - 1) : subs;
  const hidden = subs.slice(shown.length);
  return (
    <div className="party-subs" role="group" aria-label={t('partyTeam.cardTitle')} data-testid="party-subs" data-count={subs.length}>
      {shown.map((s) => (
        <button
          key={s.key}
          type="button"
          className="party-sub"
          data-dot={s.dot}
          data-testid="party-sub"
          title={t('partyTeam.subIcon', { task: subTask(s), state: subState(s) })}
          aria-label={t('partyTeam.subIcon', { task: subTask(s), state: subState(s) })}
          onClick={() => setSubCard(s.key)}
        >
          <SubGlyph />
        </button>
      ))}
      {hidden.length > 0 && (
        <button
          type="button"
          className="party-sub party-sub-more"
          data-testid="party-sub-more"
          title={t('partyTeam.subMore', { count: hidden.length })}
          aria-label={t('partyTeam.subMore', { count: hidden.length })}
          onClick={() => setSubCard(hidden[0].key)}
        >
          +{hidden.length}
        </button>
      )}
    </div>
  );
}

function AgentRel({ rel, team }: { rel: Extract<Relation, { agent: unknown }>; team: Team }) {
  const { state } = useMember(rel.agent.id);
  const lead = rel.kind === 'lead';
  const label = lead ? t('partyTeam.openLead', { name: rel.agent.name }) : t('partyTeam.openWorker', { name: rel.agent.name });
  return (
    <button
      type="button"
      className="mc-kv mc-item mc-rel ui-row"
      data-testid="member-rel"
      data-kind={rel.agent.role}
      title={label}
      aria-label={label}
      onClick={() => (lead ? openMessenger(rel.agent.id) : team.openAgent(rel.agent.id))}
    >
      <span className="mc-issue">
        {rel.agent.name} <small className="mc-note">{t(`devroomSide.role.${rel.agent.role}`)}</small>
      </span>
      <span className="mc-pill" data-state={state}>
        {t(`game.party.state.${state}`)}
      </span>
    </button>
  );
}

/** The 관계 tab's rows (teamTree.relationsOf); `self` is the sub-agent whose card this is. */
export function Relations({ id, self, team }: { id: number; self?: string; team: Team }) {
  const rows = team.relations(id, self);
  return (
    <section className="mc-sec" data-testid="member-relations">
      <h3 className="mc-sec-title">
        {t('partyTeam.related')}
        <span className="mc-count">({rows.length})</span>
      </h3>
      {rows.length === 0 && <p className="mc-note">{t('partyTeam.none')}</p>}
      {rows.map((r) =>
        r.kind === 'sub' ? (
          <button
            key={r.sub.key}
            type="button"
            className="mc-kv mc-item mc-rel ui-row"
            data-testid="member-rel"
            data-kind="sub"
            data-dot={r.sub.dot}
            title={t('partyTeam.openSub')}
            aria-label={`${subTask(r.sub)} · ${t('partyTeam.openSub')}`}
            onClick={() => team.openSub(r.sub.key)}
          >
            <span className="mc-issue">
              {subTask(r.sub)} <small className="mc-note">{t('devroomSide.role.sub')}</small>
            </span>
            <span className="mc-pill">{subState(r.sub)}</span>
          </button>
        ) : (
          <AgentRel key={`${r.kind}${r.agent.id}`} rel={r} team={team} />
        ),
      )}
    </section>
  );
}

/** The small card of the sub-agent whose icon was pressed: its task and state, the 관계 tab and the transcript button. */
export function SubCardHost() {
  const key = useSubCard();
  const into = useInspectorSlot();
  const team = useTeam(into === null);
  const sub = key === null ? undefined : team.subs.find((s) => s.key === key);
  if (!sub) return null;
  const lead = team.agents.find((a) => a.id === sub.agentId);
  return (
    <Inspector
      into={into}
      agentId={sub.agentId}
      name={subTask(sub)}
      onClose={() => setSubCard(null)}
      footer={
        <div className="mc-actions" data-count={1}>
          <button type="button" className="mc-act ui-raise" data-testid="sub-open" onClick={() => team.openSub(sub.key)}>
            <Icon name="eye" size={20} pixel={<PixelIcon name="eye" size={16} />} />
            <span>{t('partyTeam.openSub')}</span>
          </button>
        </div>
      }
    >
      <div className="mc-who" data-testid="sub-card-head">
        <span className="mc-face party-sub-face" data-dot={sub.dot}>
          <SubGlyph />
        </span>
        <div className="mc-who-lines">
          <strong className="mc-name" data-testid="sub-card-task">
            {subTask(sub)}
          </strong>
          <span className="mc-state" data-dot={sub.dot} data-testid="sub-card-state">
            <i className="mc-dot" aria-hidden="true" />
            {subState(sub)}
          </span>
          {lead && <span className="mc-note">{t('partyTeam.of', { name: lead.name })}</span>}
        </div>
      </div>
      <div className="mc-tabs ui-subtabs" role="tablist" aria-label={t('partyV2.card.tabs')}>
        <button type="button" role="tab" className="ui-tab mc-tab" aria-selected data-testid="member-tab-team">
          <Icon name="users" size={14} pixel={<PixelIcon name="case" size={12} />} />
          {t('partyV2.tab.team')}
        </button>
      </div>
      <div className="mc-body" role="tabpanel" data-tab="team">
        <Relations id={sub.agentId} self={sub.key} team={team} />
      </div>
    </Inspector>
  );
}

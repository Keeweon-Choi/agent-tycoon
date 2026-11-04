/**
 * GAME-UI-1 G3, 05: the party roster window over the office. One card per card-bar
 * agent: its figure, Lv and rank, Lead/Worker and model, 컨텍스트 남음 as 10 cells (amber at 20% and under;
 * Codex does not report it: empty and '—'), the four status effects and what it does now. The one
 * account-wide number, Claude's weekly usage left, is one party bar: nothing is split per agent.
 * A card opens the stat detail; the lit state icon opens the conversation.
 */
import type { CardInfo } from '../../components/cardBar.js';
import { Modal } from '../../components/ui/Modal.js';
import { GAME_PARTY_FIGURE_ZOOM, GAME_PARTY_SEGMENTS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { chatTarget } from '../chat.js';
import { employeeOf } from '../employees.js';
import { useEngineStore } from '../engineStore.js';
import { kTokens, restValue } from '../ez/statCardRows.js';
import { openStatDetail } from '../ez/statDetail.js';
import { characterVisualOf } from '../ez/visuals.js';
import { resetCountdown } from '../format.js';
import { openMessenger } from '../messenger/messengerStore.js';
import { modelBadge, modelName } from '../modelBadges.js';
import { fatigueFor, identityForAgent, useCldStore, virtualAgentId } from '../officeStore.js';
import { rankName, rankOfLevel } from '../rank.js';
import { GameFigure } from './GameFigure.js';
import { STATE_ICON, useChangeKey, useGameLooks, useMember } from './gameLooks.js';
import { contextTone, PARTY_STATES, windowLeft } from './gameState.js';
import { PixelIcon, SegBar } from './parts.js';
import { StateIcon } from './Party.js';

const NO_LOOK = { palette: 0, hueShift: 0 };

function MemberCard({ id, name, onClose }: { id: number; name: string; onClose: () => void }) {
  const store = useCldStore();
  const looks = useGameLooks();
  const projects = useEngineStore().state?.projects;
  const { state, left } = useMember(id);
  const refill = useChangeKey(left, (a, b) => a !== null && b !== null && b > a);
  const office = store.officeSnapshot;
  const row = office?.orchestrators.find((o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === id);
  const engine = row ? projects?.find((p) => p.name === row.name) : undefined;
  const level = identityForAgent(id, office, store.codexTasks)?.level ?? employeeOf(id, store)?.level ?? null;
  const rank = rankOfLevel(level?.level);
  const role = engine ? (engine.role ? t('game.party.worker') : t('game.party.lead')) : null;
  const codex = (engine?.provider ?? row?.provider) === 'codex';
  const model = engine?.model ? (modelName(modelBadge(engine.model), engine.model) ?? engine.model) : codex ? 'Codex' : null;
  const sample = store.contexts[id];
  const fatigue = fatigueFor(id, store);
  const doing = characterVisualOf(id)?.text ?? null;
  const word = t(`game.party.state.${state}`);
  const chat = !!chatTarget(id, office);
  return (
    <article
      className="game-party-card"
      data-state={state}
      data-testid="party-card"
      data-agent-id={id}
      role="button"
      tabIndex={0}
      aria-label={t('game.party.openStat', { name })}
      onClick={() => openStatDetail(id)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openStatDetail(id))}
    >
      <div className="game-party-top">
        <span className="game-party-pit">
          <GameFigure look={looks?.getAppearance(id) ?? NO_LOOK} zoom={GAME_PARTY_FIGURE_ZOOM} />
        </span>
        <div className="game-party-who">
          <span className="game-party-nm">{name}</span>
          {level && (
            <span className="game-party-lv">
              <span className="game-data">{t('game.party.lv')}</span> <span className="game-data">{level.level}</span>{' '}
              {rank && rankName(rank)}
            </span>
          )}
        </div>
      </div>
      {(role || model) && (
        <span className="game-party-tags">
          {role && (
            <span className="game-party-tag" data-lead={!engine?.role || undefined}>
              {role}
            </span>
          )}
          {model && <span className="game-party-tag game-data">{model}</span>}
        </span>
      )}
      <div className="game-party-stat" data-testid="party-context" data-left={left ?? undefined}>
        <span className="game-party-k">
          {left === null ? t('game.party.context') : t('game.party.contextLeft')}
          <b className="game-data" data-zero={left === null || undefined}>
            {left === null ? '—' : `${left}%`}
          </b>
        </span>
        <SegBar
          value={left ?? 0}
          max={100}
          segments={GAME_PARTY_SEGMENTS}
          tone={contextTone(left)}
          refill={refill}
          className="game-seg-fill"
          label={t('game.party.contextLeft')}
        />
        <span className="game-party-sub">
          {left === null ? (
            <span>{codex ? t('game.party.codexNote') : ''}</span>
          ) : (
            <span className="game-data">{sample ? `${kTokens(sample.tokens)} / ${kTokens(sample.max)}` : ''}</span>
          )}
          {fatigue && <span>{t('game.party.rests', { value: restValue(fatigue) })}</span>}
        </span>
      </div>
      <div className="game-party-fx">
        {PARTY_STATES.map((s) =>
          s === state && chat ? (
            <button
              key={s}
              type="button"
              data-on=""
              data-fx={s}
              title={t('game.party.openChat', { name, state: word })}
              aria-label={t('game.party.openChat', { name, state: word })}
              onClick={(e) => {
                e.stopPropagation();
                openMessenger(id);
                onClose();
              }}
            >
              <StateIcon state={s} />
            </button>
          ) : (
            <span key={s} data-on={s === state ? '' : undefined} data-fx={s} title={t(`game.party.state.${s}`)}>
              {s === state ? <StateIcon state={s} /> : <PixelIcon name={STATE_ICON[s]} />}
            </span>
          ),
        )}
        <em>{word}</em>
      </div>
      <div className="game-party-act">{doing ?? '—'}</div>
    </article>
  );
}

/** Claude's weekly usage left: the whole account's, one bar for the party. */
function PartyEnergy() {
  const claude = useCldStore().usageState?.providers.find((p) => p.id === 'claude');
  const week = claude?.windows.find((w) => w.id === '7d');
  if (!week) return null;
  const left = windowLeft(week);
  return (
    <div className="game-party-energy" data-testid="party-energy" data-left={left ?? undefined}>
      <span className="game-party-ek">
        <PixelIcon name="bolt" />
        {t('game.party.energy')}
      </span>
      <SegBar value={left ?? 0} max={100} segments={GAME_PARTY_SEGMENTS} className="game-seg-energy" />
      <span className="game-data">{left === null ? '—' : `${left}%`}</span>
      {!week.isReset && <span className="game-muted">{resetCountdown(week.resetAt)}</span>}
      <span className="game-party-note">{t('game.party.energyNote')}</span>
    </div>
  );
}

export function PartyWindow({
  ids,
  describeCard,
  onClose,
}: {
  ids: number[];
  describeCard?: (id: number) => CardInfo | undefined;
  onClose: () => void;
}) {
  const members = ids.map((id) => ({ id, name: describeCard?.(id)?.name ?? `#${id}` }));
  return (
    <Modal
      isOpen
      onClose={onClose}
      className="game-party w-[min(1170px,100%)]"
      title={
        <span className="game-party-title" data-testid="party-window">
          <PixelIcon name="heart" />
          {t('game.party.title')} <span className="game-data">{members.length}</span>
        </span>
      }
    >
      <div className="game-party-body">
        <PartyEnergy />
        {members.length === 0 ? (
          <p className="game-muted">{t('game.party.empty')}</p>
        ) : (
          <div className="game-party-cards">
            {members.map((m) => (
              <MemberCard key={m.id} id={m.id} name={m.name} onClose={onClose} />
            ))}
          </div>
        )}
        <div className="game-party-legend">
          <span>{t('game.party.legend')}</span>
          {PARTY_STATES.map((s) => (
            <span key={s}>
              <PixelIcon name={STATE_ICON[s]} />
              {t(`game.party.state.${s}`)}
            </span>
          ))}
          <span>{t('game.party.legendNote')}</span>
        </div>
      </div>
    </Modal>
  );
}

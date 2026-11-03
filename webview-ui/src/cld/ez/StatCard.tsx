/**
 * STAT-CARD / STAT-2: a character's 스탯 view. One component for the office menu's 스탯, a card tap
 * on a character that is home or off, and the orchestrator panel (a modal over the page). Big tiles (the current activity on top, then growth,
 * fatigue and the run) by default; 자세히 swaps them for the full sectioned list, every number
 * labelled. The choice is remembered per viewer. The numbers are the office's own, placed by
 * statCard.ts.
 */
import { useEffect, useState } from 'react';

import type { EngineProject } from '../../../../core/src/messages.js';
import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import {
  FATIGUE_BAR_COLORS,
  OWNER_CHARACTER_ID,
  STAT_DETAIL_FACE_PX,
  STAT_REFRESH_MS,
  STAT_TILE_RING,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { openLooks } from '../characters/looks.js';
import { chatTarget } from '../chat.js';
import { ChatAction } from '../ChatAction.js';
import { employeeFatigue, employeeOf } from '../employees.js';
import { engineLabel } from '../engine.js';
import { engineAsk, useEngineProject, useEngineStore } from '../engineStore.js';
import { activityElapsed, characterKind, characterName, elapsedText, kindLabel } from '../kinds.js';
import { modelName } from '../modelBadges.js';
import { fatigueFor, identityForAgent, useCldStore, virtualAgentId } from '../officeStore.js';
import { rankName, rankOfLevel } from '../rank.js';
import { staffSnapshot, useStaff } from '../staff.js';
import { useCanAct } from '../useCanAct.js';
import { LevelRing } from './Fatigue.js';
import { fatigueRules } from './fatigueState.js';
import { ringOf } from './nameplate.js';
import { OwnerStatBody } from './OwnerStatCard.js';
import {
  canStartProject,
  fatigueLine,
  placeOf,
  readStatFull,
  restValue,
  type StatFacts,
  statSections,
  writeStatFull,
} from './statCardRows.js';
import { openStatDetail, useStatDetailId } from './statDetail.js';
import { characterVisualOf } from './visuals.js';

/** The facts behind character `id`'s detail view, from the stores the office already keeps. */
function useStatFacts(
  id: number,
  officeState: OfficeState,
): StatFacts & { palette: number; hueShift: number; project: EngineProject | undefined } {
  const store = useCldStore();
  // The office's characters change without the store (a look applied, a palette set): look again now and then.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), STAT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  const office = store.officeSnapshot;
  const ch = officeState.characters.get(id);
  const identity = identityForAgent(id, office, store.codexTasks);
  // An orchestrator at home or off has no character, only its row.
  const row = office?.orchestrators.find((o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === id);
  const away = !!useStaff().away[id];
  const name = ch ? characterName(ch, office, store.codexTasks) : (identity?.label ?? row?.name ?? '');
  const engine = useEngineProject(name);
  const kind = ch ? characterKind(ch, office, store.codexTasks) : null;
  const employee = employeeOf(id, store);
  const temp = staffSnapshot().temps.find((x) => x.id === id);
  const level = identity?.level ?? employee?.level ?? null;
  const rankId = rankOfLevel(level?.level);
  const sample = store.contexts[id];
  const fatigue =
    fatigueFor(id, store) ??
    (employee ? employeeFatigue(employee, fatigueRules(store.ezRules?.fatigue)) : null);
  const leadId = temp?.leadId ?? ch?.leadAgentId;
  const lead = leadId !== undefined && leadId !== null ? officeState.characters.get(leadId) : undefined;
  const visual = characterVisualOf(id);
  const activity = visual ? `${visual.icon} ${visual.text}` : null;
  return {
    name,
    kind: kind ? kindLabel(kind) : null,
    lead: lead ? characterName(lead, office, store.codexTasks) : null,
    task: temp?.task || null,
    level,
    rank: rankId ? rankName(rankId) : null,
    fatigue,
    tokens: sample ? { used: sample.tokens, max: sample.max } : null,
    activity,
    elapsed: activity ? elapsedText(activityElapsed(id, activity)) : null,
    model: temp?.model ? modelName(temp.model, temp.modelId) : (engine?.model ?? null),
    effort: engine?.effort ?? null,
    employee: employee ? t('character.tempEmployee') : null,
    place: row ? placeOf(row, engine, away) : null,
    project: engine,
    palette: ch?.palette ?? 0,
    hueShift: ch?.hueShift ?? 0,
  };
}

const TILE = 'border-2 border-border bg-bg-dark shadow-pixel p-8 flex flex-col gap-4 min-w-0';
const LABEL = 'text-2xs text-text-muted';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4" data-testid="stat-section">
      <h3 className="text-xs text-accent-text">{title}</h3>
      {children}
    </section>
  );
}

/** Layout E: big tiles. */
function StatTiles({ f }: { f: StatFacts }) {
  const ring = ringOf(f.level ?? undefined);
  return (
    <div className="flex flex-col gap-8" data-testid="stat-tiles">
      {f.activity && (
        <Section title={t('stat.sec.now')}>
          <div className="border-2 border-accent bg-active-bg shadow-pixel p-8 text-sm leading-snug">
            <span data-testid="stat-activity">{f.activity}</span>
            {f.elapsed && <div className="text-2xs text-text-muted mt-2">{f.elapsed}</div>}
          </div>
        </Section>
      )}
      {(ring || f.rank) && (
        <Section title={t('stat.sec.growth')}>
          <div className="grid grid-cols-2 gap-8">
            {ring && f.level && (
              <div className={TILE} data-testid="stat-level">
                <span className={LABEL}>{t('stat.level')}</span>
                <span className="flex items-center gap-8 text-xl leading-none">
                  <LevelRing ring={ring} sizes={STAT_TILE_RING} />
                  {t('character.level', { level: f.level.level })}
                </span>
                <span className={LABEL}>
                  {t('character.xpToNext', { count: Math.max(0, f.level.next - f.level.xp) })}
                </span>
              </div>
            )}
            {f.rank && (
              <div className={TILE} data-testid="stat-rank">
                <span className={LABEL}>{t('stat.rank')}</span>
                <span className="text-xl leading-none text-yellow-300">{f.rank}</span>
              </div>
            )}
          </div>
          {f.level && (
            <div className={`${TILE} flex-row items-center justify-between`} data-testid="stat-rebirth">
              <span className={LABEL}>{t('stat.rebirth')}</span>
              <span className="text-lg leading-none">{t('stat.rebirthCount', { count: f.level.rebirths })}</span>
            </div>
          )}
          {!!f.level?.inherit && (
            <div className={`${TILE} flex-row items-center justify-between`} data-testid="stat-inherit">
              <span className={LABEL}>{t('inherit.stat')}</span>
              <span className="text-lg leading-none">{t('inherit.statCount', { count: f.level.inherit })}</span>
            </div>
          )}
        </Section>
      )}
      {f.fatigue && (
        <Section title={t('stat.sec.fatigue')}>
          <div className={TILE} data-testid="stat-fatigue" data-tone={f.fatigue.tone}>
            <span className="text-lg leading-none">{fatigueLine(f.fatigue, f.tokens)}</span>
            <span className="block h-12 border-2 border-border bg-bg">
              <span
                className="block h-full"
                style={{ width: `${f.fatigue.value}%`, background: FATIGUE_BAR_COLORS[f.fatigue.tone] }}
              />
            </span>
            <span className={LABEL}>
              {t('stat.rest')} {restValue(f.fatigue)}
            </span>
          </div>
        </Section>
      )}
      {f.employee && (
        <p className="text-2xs text-text-muted" data-testid="temp-employee">
          {f.employee}
        </p>
      )}
      {(f.model || f.effort) && (
        <Section title={t('stat.sec.run')}>
          <div className="flex flex-wrap gap-8" data-testid="stat-run">
            {f.model && (
              <span className="border-2 border-accent px-8 py-4 text-sm text-accent-text">{f.model}</span>
            )}
            {f.effort && (
              <span className="border-2 border-border px-8 py-4 text-sm">
                {t('stat.effortChip', { effort: f.effort })}
              </span>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

/** Layout C: the sectioned list, every number labelled. */
function StatList({ f }: { f: StatFacts }) {
  return (
    <div className="flex flex-col gap-8" data-testid="stat-list">
      {statSections(f).map((s) => (
        <Section key={s.id} title={s.title}>
          <dl className="border-2 border-border bg-bg-dark shadow-pixel p-8 flex flex-col gap-4 text-xs">
            {s.rows.map((r) => (
              <div key={r.id} className="flex justify-between gap-8" data-row={r.id}>
                <dt className="text-text-muted whitespace-nowrap">{r.label}</dt>
                <dd
                  className="text-right min-w-0 break-words"
                  data-testid={r.id === 'employee' ? 'temp-employee' : undefined}
                >
                  {r.value}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      ))}
    </div>
  );
}

function StatBody({ id, officeState, readOnly }: { id: number; officeState: OfficeState; readOnly: boolean }) {
  const f = useStatFacts(id, officeState);
  const [full, setFull] = useState(readStatFull);
  const { busy } = useEngineStore();
  const canAct = useCanAct();
  const { place, project } = f;
  const canChat = !!chatTarget(id, useCldStore().officeSnapshot);
  return (
    <div className="px-10 pb-10 flex flex-col gap-8" data-testid="stat-detail" data-agent-id={id}>
      <div className="flex flex-wrap items-center gap-8">
        <span className="shrink-0 border-2 border-border">
          <CharacterMugShot palette={f.palette} hueShift={f.hueShift} size={STAT_DETAIL_FACE_PX} />
        </span>
        <div className="flex-1 min-w-[130px] flex flex-col gap-4">
          <span className="text-lg text-accent-text break-words" data-testid="stat-name">
            {f.name}
          </span>
          {f.kind && <span className="self-start max-w-full truncate whitespace-nowrap border-2 border-border px-4 text-2xs">{f.kind}</span>}
        </div>
        <div className="flex gap-4 shrink-0 items-center">
          <ChatAction agentId={id} variant="card" onOpen={() => openStatDetail(null)} />
          {!readOnly && canStartProject(project, canAct) && (
            <Button
              variant="accent"
              size="sm"
              className="text-xs"
              data-testid="stat-start"
              disabled={busy[project.name] !== undefined}
              onClick={() => engineAsk('start', project.name)}
            >
              {engineLabel('start')}
            </Button>
          )}
          {!readOnly && f.name && (
            <Button
              size="sm"
              className="text-xs"
              onClick={() => {
                openStatDetail(null);
                openLooks(f.name);
              }}
            >
              {t('looks.open')}
            </Button>
          )}
        </div>
      </div>
      {!full && place?.state && (
        <p className="text-xs text-text-muted" data-testid="stat-state">
          {place.state}
        </p>
      )}
      {!full && place?.downNote && (
        <p className="text-xs text-yellow-300 break-words" data-testid="stat-down">
          {place.downNote}
        </p>
      )}
      {!full && place?.needsTrust && (
        <p className="text-xs text-yellow-300 break-words">{t('stat.trustNeeded')}</p>
      )}
      {place?.sleeping && canChat && (
        <p className="text-xs text-text-muted" data-testid="stat-wake-hint">
          {t('stat.wakeHint')}
        </p>
      )}
      {full ? <StatList f={f} /> : <StatTiles f={f} />}
      <Button
        size="sm"
        className="self-start text-xs"
        aria-pressed={full}
        data-testid="stat-toggle"
        onClick={() => {
          writeStatFull(!full);
          setFull(!full);
        }}
      >
        {full ? t('stat.less') : t('stat.more')}
      </Button>
    </div>
  );
}

/** The modal, mounted once in the app; openStatDetail(id) shows it. */
export function StatDetailSheet({ officeState }: { officeState: OfficeState }) {
  const id = useStatDetailId();
  const { officeReadOnly } = useCldStore();
  if (id === null) return null;
  return (
    <Modal isOpen onClose={() => openStatDetail(null)} title={t('stat.open')} className="w-[min(640px,100%)]">
      {id === OWNER_CHARACTER_ID ? (
        <OwnerStatBody officeState={officeState} />
      ) : (
        <StatBody id={id} officeState={officeState} readOnly={officeReadOnly} />
      )}
    </Modal>
  );
}

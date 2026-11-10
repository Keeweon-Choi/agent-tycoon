/** STAT-CARD: the facts behind a character's 스탯 (the detail view, and the member card's 능력치 tab). */
import type { EngineProject } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { employeeFatigue, employeeOf } from '../employees.js';
import { activityElapsed, characterKind, characterName, elapsedText, kindLabel } from '../kinds.js';
import { modelName } from '../modelBadges.js';
import { type AgtySnapshot, fatigueFor, identityForAgent, restsOf, virtualAgentId } from '../officeStore.js';
import { rankName, rankOfLevel } from '../rank.js';
import type { staffSnapshot } from '../staff.js';
import { fatigueRules } from './fatigueState.js';
import { placeOf, type StatFacts } from './statCardRows.js';
import { characterVisualOf } from './visuals.js';

export type StatFactsPlus = StatFacts & { palette: number; hueShift: number; project: EngineProject | undefined };

/** The facts behind character `id`'s detail view, from the stores the office already keeps (the member card's
 *  능력치 tab too, FEAT-PARTY-V2). */
export function statFactsOf(
  id: number,
  characters: OfficeState['characters'],
  store: AgtySnapshot,
  staff: ReturnType<typeof staffSnapshot>,
  projects: readonly EngineProject[] | undefined,
): StatFactsPlus {
  const office = store.officeSnapshot;
  const ch = characters.get(id);
  const identity = identityForAgent(id, office, store.codexTasks);
  // An orchestrator at home or off has no character, only its row.
  const row = office?.orchestrators.find((o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === id);
  const away = !!staff.away[id];
  const name = ch ? characterName(ch, office, store.codexTasks) : (identity?.label ?? row?.name ?? '');
  const engine = projects?.find((p) => p.name === name);
  const kind = ch ? characterKind(ch, office, store.codexTasks) : null;
  const employee = employeeOf(id, store);
  const temp = staff.temps.find((x) => x.id === id);
  const level = identity?.level ?? employee?.level ?? null;
  const rankId = rankOfLevel(level?.level);
  const sample = store.contexts[id];
  const fatigue =
    fatigueFor(id, store) ??
    (employee ? employeeFatigue(employee, fatigueRules(store.ezRules?.fatigue)) : null);
  const leadId = temp?.leadId ?? ch?.leadAgentId;
  const lead = leadId !== undefined && leadId !== null ? characters.get(leadId) : undefined;
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
    tokens: sample ? { used: sample.tokens, max: sample.max, basis: sample.basis } : null,
    rests: restsOf(id, store),
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

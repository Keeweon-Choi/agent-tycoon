/**
 * T-0036: a character's DOM overlay in the cld office (EZ mode). A named
 * character carries a small RPG nameplate (charpack v3 §6A): the status icon,
 * its rank icon, its name and its level in an XP ring, the 피로도 bar below;
 * an unnamed one only the status icon the canvas draws above its head.
 * Hovering (desktop) or tapping (phone; a tap selects) opens the plate on the
 * details: kind, Lv / 환생, the lead, Task, rank and model, the activity in
 * words and how long it has been at it.
 */
import { Button } from '../../components/ui/Button.js';
import {
  CHARACTER_SITTING_OFFSET_PX,
  NAMEPLATE_EDGE_MARGIN_PX,
  OFF_OVERLAY_ALPHA,
  OVERLAY_LABEL_SELECTED_Z_INDEX,
  OVERLAY_LABEL_Z_INDEX,
  STATUS_DETAILS_RISE_PX,
  STATUS_ICON_OFFSET_X,
  STATUS_ICON_RISE_PX,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { OverlayProjection } from '../../office/projection.js';
import type { Character } from '../../office/types.js';
import { CharacterState } from '../../office/types.js';
import { transport } from '../../transport/index.js';
import { employeeOf } from '../employees.js';
import { useEngineProject } from '../engineStore.js';
import { activityElapsed, type CharacterKind, elapsedText, kindLabel } from '../kinds.js';
import { modelEffortLabel, modelName, rankModelLabel } from '../modelBadges.js';
import { openOffDuty } from '../offDuty.js';
import { OfficeBadges } from '../OfficeBadges.js';
import type { OfficeIdentity } from '../officeStore.js';
import { getRankStyle, rankName, rankOfLevel } from '../rank.js';
import { staffHides, staffSnapshot } from '../staff.js';
import { TempRank } from '../TempList.js';
import { nameplateSizes, useUiScale } from '../uiScale.js';
import { openWork } from '../work/workStore.js';
import {
  animationClock,
  LEAD_SPRITE,
  PHASE_PER_ID,
  statusIconAlpha,
  statusIconFrame,
} from './drawVisuals.js';
import { FatigueBar, LevelRing, RestBubble, UnknownFatigue } from './Fatigue.js';
import type { FatigueLook } from './fatigue.js';
import { levelText } from './level.js';
import { clampPlate, nameMaxPx, offAlpha, rankIcon, ringOf } from './nameplate.js';
import { PixelSprite } from './PixelSprite.js';
import { rankSprite } from './rankSprites.js';
import { nameplatesOn } from './useNameplates.js';
import { type CharacterVisual, ringWord, statusIcon } from './visuals.js';

/**
 * The status icon in the DOM: the canvas icon's sprite, or the activity emoji.
 * On the nameplate it hangs off the top-left corner, so it never takes the name's width.
 */
function StatusIconNode({
  visual,
  phase,
  scale,
}: {
  visual: CharacterVisual;
  phase: number;
  scale: number;
}) {
  const icon = statusIcon(visual.ring);
  if (!icon) return null;
  const t = animationClock();
  return (
    <span
      className="absolute bottom-full left-0 -mb-6 flex items-end leading-none text-2xs"
      style={{ opacity: statusIconAlpha(icon, t) }}
      data-testid="status-icon"
      data-icon={icon}
      role="img"
      aria-label={`${ringWord(visual.ring)}: ${visual.text}`}
    >
      {icon === 'activity' ? (
        visual.icon
      ) : (
        <PixelSprite sprite={statusIconFrame(icon, t + phase)} scale={scale} />
      )}
    </span>
  );
}

export interface CharacterLabelProps {
  ch: Character;
  kind: CharacterKind;
  name: string;
  /** Whether the nameplate shows without a hover (showsNameLabel). */
  named: boolean;
  /** The lead's name, for sub-agents and teammates. */
  leadName: string | null;
  visual: CharacterVisual;
  /** The raw tool status behind the friendly words: the activity line's tooltip. */
  rawActivity: string;
  fatigue: FatigueLook | null;
  identity: OfficeIdentity | null;
  hovered: boolean;
  selected: boolean;
  /** A close button on the selected character (not a sub-agent, not read-only). */
  canClose: boolean;
  onClose: () => void;
  project: OverlayProjection;
  /** The overlay's size at the last overlap pass, to keep it on screen. */
  plateSize: { w: number; h: number } | undefined;
  /** The office's size on screen (CSS px). */
  bounds: { width: number; height: number };
}

export function CharacterLabel({
  ch,
  kind,
  name,
  named,
  leadName,
  visual,
  rawActivity,
  fatigue,
  identity,
  hovered,
  selected,
  canClose,
  onClose,
  project,
  plateSize,
  bounds,
}: CharacterLabelProps) {
  // UI-SCALE: the plate's sizes are the 화면 크기 step's, never the screen width's.
  const sizes = nameplateSizes(useUiScale());
  // T-0041: gone home: only the 퇴근 plate on its desk.
  const staff = staffSnapshot();
  const engineProject = useEngineProject(name);
  const orchestratorModel = modelEffortLabel(engineProject?.model, engineProject?.effort);
  const plate = staff.away[ch.id];
  if (plate)
    return (
      <button
        type="button"
        className="absolute -translate-x-1/2 -translate-y-full pointer-events-auto cursor-pointer bg-bg border border-border px-4 text-xs leading-tight text-text-muted pointer-coarse:min-h-44"
        style={{ left: project.toScreenX(plate.x), top: project.toScreenY(plate.y) }}
        data-testid="off-duty-plate"
        data-agent-id={ch.id}
        title={t('offDuty.open')}
        onClick={(e) => {
          e.stopPropagation();
          openOffDuty(ch.id);
        }}
      >
        {t('temp.offDuty')}
      </button>
    );
  if (staffHides(ch)) return null; // held out of sight while the office loads
  const temp = staff.temps.find((t) => t.id === ch.id);
  // TEMP-PLATES: a sub-agent or Codex temporary is a roster employee, with its own level.
  const employee = employeeOf(ch.id);
  const level = identity?.level ?? employee?.level;
  const overtime = staff.overtime.includes(ch.id);
  const sit = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
  // The readable rank/model at the feet: when no plate carries it, and always with nameplates off (as before them).
  const feetRank = !named || !nameplatesOn();
  const details = hovered || selected;
  const icon = statusIcon(visual.ring);
  const elapsed = activityElapsed(ch.id, `${visual.icon} ${visual.text}`);
  // Every character's status, at the head icon's spot (where the canvas draws
  // it for a name-less one): tests find it here, and screen readers too when
  // no name label speaks for the character.
  const iconAnchor = (
    <span
      className="absolute pointer-events-none"
      style={{
        left: project.toScreenX(ch.x + STATUS_ICON_OFFSET_X),
        top: project.toScreenY(ch.y + sit - STATUS_ICON_RISE_PX),
      }}
      data-testid="status-icon-anchor"
      data-agent-id={ch.id}
      data-kind={kind}
      data-icon={icon ?? ''}
      data-emoji={visual.icon}
      data-prop={visual.prop ?? ''}
      data-ring={visual.ring}
      data-phase={temp?.phase ?? ''}
      role={named || !icon ? undefined : 'img'}
      aria-hidden={named || !icon ? true : undefined}
      aria-label={`${name}: ${ringWord(visual.ring)}`}
    />
  );
  // T-0041: at the feet, the temp's readable rank/model and 야근 after hours.
  const feet =
    (temp && feetRank) || overtime ? (
      <span
        className="absolute -translate-x-1/2 flex items-center gap-2 pointer-events-none"
        style={{ left: project.toScreenX(ch.x), top: project.toScreenY(ch.y + sit + 1) }}
        data-testid="feet-badges"
        data-agent-id={ch.id}
      >
        {temp && feetRank && <TempRank level={level?.level} badge={temp.model} modelId={temp.modelId} />}
        {overtime && (
          <span
            className="bg-bg border border-border px-4 text-xs leading-tight whitespace-nowrap"
            data-testid="overtime-badge"
          >
            {t('temp.overtime')}
          </span>
        )}
      </span>
    ) : null;
  if (!named && !details)
    return (
      <>
        {iconAnchor}
        {feet}
      </>
    );

  const ring = ringOf(level);
  const rank = rankIcon(kind, level);
  const rankId = rankOfLevel(level?.level);
  // The rank in words (the level's; an orchestrator's icon is the crown but its rank is written too).
  const rankText = temp
    ? rankModelLabel(level?.level, temp.model, temp.modelId)
    : [rankId ? rankName(rankId) : kindLabel(kind), orchestratorModel].filter(Boolean).join(' · ');
  // Bottom centre of the whole overlay, kept on screen (its size from the last overlap pass).
  const at = clampPlate(
    project.toScreenX(ch.x),
    project.toScreenY(ch.y + sit - (named ? TOOL_OVERLAY_VERTICAL_OFFSET : STATUS_DETAILS_RISE_PX)),
    plateSize,
    bounds,
    NAMEPLATE_EDGE_MARGIN_PX,
  );
  return (
    <>
      {iconAnchor}
      {feet}
      <div
        // w-max: near the right edge an absolute box would shrink to the room left of it.
        className="absolute w-max flex flex-col items-center -translate-x-1/2 -translate-y-full"
        style={{
          left: at.x,
          top: at.y,
          pointerEvents: selected ? 'auto' : 'none',
          opacity: offAlpha(!!identity?.off, details, OFF_OVERLAY_ALPHA),
          zIndex: details ? OVERLAY_LABEL_SELECTED_Z_INDEX : OVERLAY_LABEL_Z_INDEX,
        }}
        data-testid="agent-overlay"
        data-agent-id={ch.id}
        data-kind={kind}
      >
        {fatigue?.rest && <RestBubble className="mb-4" />}
        {identity && <OfficeBadges identity={identity} />}
        {/* charpack v3 §6A: the nameplate; the overlap pass (useNameplates.ts) dims it by its data-nameplate. */}
        <div
          className="relative flex items-start border-border px-4 pt-2 pb-4 gap-4 pixel-panel max-w-2xs"
          data-nameplate=""
          data-agent-id={ch.id}
          data-focus={details ? '' : undefined}
        >
          {named && (
            <StatusIconNode visual={visual} phase={Math.abs(ch.id) * PHASE_PER_ID} scale={sizes.status} />
          )}
          <div className="flex flex-col gap-3 min-w-0">
            <span className="flex items-center gap-3 whitespace-nowrap">
              {rank && (
                <span
                  className="shrink-0"
                  role="img"
                  aria-label={rankText}
                  title={rankText}
                  data-testid="rank-icon"
                  data-rank={rank}
                >
                  <PixelSprite
                    sprite={rank === 'lead' ? LEAD_SPRITE : rankSprite(getRankStyle(), rank)}
                    scale={sizes.rank}
                  />
                </span>
              )}
              <span
                className={`font-bold text-accent-text leading-tight ${details ? 'whitespace-normal break-words min-w-0' : 'truncate'}`}
                style={{ maxWidth: nameMaxPx(sizes, details), fontSize: sizes.name }}
                data-name={name}
                data-testid="agent-name"
              >
                {name}
              </span>
              {ring && <LevelRing ring={ring} sizes={sizes} />}
            </span>
            {fatigue ? (
              <FatigueBar look={fatigue} compact={sizes} />
            ) : (
              employee && <UnknownFatigue compact={sizes} />
            )}
            {details && (
              <div
                className="flex flex-col gap-2 text-2xs leading-tight"
                data-testid="agent-details"
              >
                <span className="text-text-muted" data-testid="agent-kind">
                  {kindLabel(kind)}
                </span>
                {(identity?.engine || identity?.background) && (
                  // The owner's call (10-24): technical states, in the details only.
                  <span data-testid="agent-session">
                    {[
                      identity.engine && t('character.engineSession'),
                      identity.background && t('character.attachable'),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
                {employee && (
                  // The owner's condition: a returning employee is the same game character, never the same AI session.
                  <span data-testid="temp-employee" data-employee={employee.employeeId}>
                    {t('character.tempEmployee')}
                  </span>
                )}
                {level && (
                  <span
                    data-testid="level"
                    data-level={level.level}
                    data-rebirths={level.rebirths}
                    data-xp={level.xp}
                  >
                    {levelText(level)}
                  </span>
                )}
                {leadName && <span className="truncate">{t('character.leader', { name: leadName })}</span>}
                {temp?.task && (
                  <span className="truncate" data-testid="temp-task">
                    {t('character.task', { task: temp.task })}
                  </span>
                )}
                {rankId && <span data-testid="rank-text">{t('character.rank', { rank: rankName(rankId) })}</span>}
                {temp?.model && <span>{t('character.model', { model: modelName(temp.model, temp.modelId) ?? '' })}</span>}
                {orchestratorModel && <span>{t('character.launch', { model: orchestratorModel })}</span>}
                <span
                  className="whitespace-nowrap truncate"
                  title={rawActivity}
                  data-testid="activity-text"
                >
                  {visual.icon} {visual.text}
                </span>
                {ch.contextTokens > 0 && !ch.isSubagent && (
                  // The raw gauge's numbers (the old 자세히 mode's tooltip): the bar above is the same fill.
                  <span
                    data-testid="context-numbers"
                    data-context-pct={Math.round((ch.contextTokens / ch.maxContextTokens) * 100)}
                  >
                    {t('character.context', {
                      pct: Math.round((ch.contextTokens / ch.maxContextTokens) * 100),
                      used: Math.round(ch.contextTokens / 1000),
                      max: Math.round(ch.maxContextTokens / 1000),
                    })}
                  </span>
                )}
                <span className="text-text-muted">{elapsedText(elapsed)}</span>
                {selected && identity?.off && (
                  // U-10: an off orchestrator's facts and its chat, from its label.
                  <button
                    type="button"
                    className="self-start border border-border px-4 py-1 pointer-events-auto hover:bg-btn-hover pointer-coarse:min-h-44"
                    data-testid="off-duty-open"
                    data-agent-id={ch.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      openOffDuty(ch.id);
                    }}
                  >
                    {t('offDuty.open')}
                  </button>
                )}
                {selected && temp?.work && (
                  // T-0056: the click selects; this opens what the temp is doing.
                  <button
                    type="button"
                    className="self-start border border-border px-4 py-1 pointer-events-auto hover:bg-btn-hover pointer-coarse:min-h-44"
                    data-testid="work-open"
                    data-agent-id={ch.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      openWork(temp, (m) => transport.send(m));
                    }}
                  >
                    {t('temp.workOpen')}
                  </button>
                )}
              </div>
            )}
          </div>
          {selected && canClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              title="Close agent"
              className="ml-2 shrink-0 leading-none"
            >
              ×
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

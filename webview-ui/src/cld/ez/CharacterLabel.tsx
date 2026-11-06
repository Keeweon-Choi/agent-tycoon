/**
 * T-0036: a character's DOM overlay in the cld office (EZ mode). A named
 * character carries a small RPG nameplate (charpack v3 §6A): the status icon,
 * its rank icon, its name and its level in an XP ring, the 피로도 bar below;
 * an unnamed one only the status icon the canvas draws above its head.
 * Tapping on the phone (a tap selects) opens the plate on the details: kind,
 * Lv / 환생, the lead, Task, rank and model, the activity in words. On the PC
 * (hud-v3 P0) a hover or the selection only adds the activity line to the
 * plate (and the selection its accent); the details go to the inspector beside
 * the party (hud/Inspector.tsx), from this same render.
 */
import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import {
  CHARACTER_SITTING_OFFSET_PX,
  NAMEPLATE_EDGE_MARGIN_PX,
  OFF_OVERLAY_ALPHA,
  OVERLAY_LABEL_SELECTED_Z_INDEX,
  OVERLAY_LABEL_Z_INDEX,
  PHONE_CARD_OTHERS_ALPHA,
  STAT_SUMMARY_BAR_PX,
  STAT_SUMMARY_FACE_PX,
  STAT_SUMMARY_MAX_PX,
  STATUS_DETAILS_RISE_PX,
  STATUS_ICON_OFFSET_X,
  STATUS_ICON_RISE_PX,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { Bind } from '../../office/components/overlayPlacer.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import type { Character } from '../../office/types.js';
import { CharacterState } from '../../office/types.js';
import { transport } from '../../transport/index.js';
import { employeeOf } from '../employees.js';
import { useEngineProject } from '../engineStore.js';
import { useInspectorSlot } from '../hud/inspectorSlot.js';
import { activityElapsed, type CharacterKind, kindLabel } from '../kinds.js';
import { modelEffortLabel, rankModelLabel } from '../modelBadges.js';
import { OfficeBadges } from '../OfficeBadges.js';
import type { OfficeIdentity } from '../officeStore.js';
import { MemberCard } from '../party/MemberCard.js';
import { getRankStyle, rankName, rankOfLevel } from '../rank.js';
import { staffHides, staffSnapshot } from '../staff.js';
import { TempRank } from '../TempList.js';
import { nameplateSizes, useUiScale } from '../uiScale.js';
import { useUiTheme } from '../uiTheme.js';
import { openWork } from '../work/workStore.js';
import {
  animationClock,
  LEAD_SPRITE,
  PHASE_PER_ID,
  statusIconAlpha,
  statusIconFrame,
} from './drawVisuals.js';
import { FatigueBar, LevelRing, RestBubble, UnknownFatigue } from './Fatigue.js';
import type { FatigueLook } from './fatigueState.js';
import { clampPlate, offAlpha, plateLook, rankIcon, ringOf } from './nameplate.js';
import { PixelSprite } from './PixelSprite.js';
import { rankSprite } from './rankSprites.js';
import { RebirthMark } from './RebirthMark.js';
import { nameplatesOn, type PlateSizes } from './useNameplates.js';
import { type CharacterVisual, type RingState, ringWord, statusIcon } from './visuals.js';

/** 모던: the plate's state dot on its left line (index.css .ui-status-dot tones); grey when resting or off. */
const DOT_TONE: Record<RingState, string | undefined> = {
  working: 'ok',
  neutral: 'ok',
  waiting: 'warn',
  permission: 'bad',
  idle: undefined,
  off: undefined,
};

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
  visual: CharacterVisual;
  /** The raw tool status behind the friendly words: the activity line's tooltip. */
  rawActivity: string;
  fatigue: FatigueLook | null;
  identity: OfficeIdentity | null;
  hovered: boolean;
  selected: boolean;
  /** hud-v3 P0: the inspector's ×, clearing the office's selection. */
  onDeselect: () => void;
  /** Binds an element to a spot on this character, moved every frame without a render (overlayPlacer.ts). */
  bind: Bind;
  /** Each overlay's size at the last overlap pass (read when placing), to keep it on screen. */
  plateSizes: PlateSizes;
  /** The office's size on screen (CSS px); read when placing, so a resize needs no render. */
  bounds: { width: number; height: number };
  /** SHEET-IMPORT: how much taller than a classic figure it stands (world px): what sits over
   *  its head rises by it; what sits at its feet stays. */
  lift?: number;
  /** UI-PHONE: another character's card is open on the phone: this one steps back. */
  dim?: boolean;
  /** hud-v3 P0: the selected agent's look name (the member card's 꾸미기). */
  lookName?: string;
  /** FEAT-PARTY-V2: the office's characters (the member card's 능력치: its lead's name). */
  characters: OfficeState['characters'];
}

/** How far a seated (typing) character sits lower; read when placing, as the state changes between renders. */
const seat = (ch: Character) => (ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0);

export function CharacterLabel({
  ch,
  kind,
  name,
  named,
  visual,
  rawActivity,
  fatigue,
  identity,
  hovered,
  selected,
  onDeselect,
  bind,
  plateSizes,
  bounds,
  lift = 0,
  dim = false,
  lookName,
  characters,
}: CharacterLabelProps) {
  // UI-SCALE: the plate's sizes are the 화면 크기 step's, never the screen width's.
  const sizes = nameplateSizes(useUiScale());
  // FEAT-OFFICE-NAMEPLATE-MODERN: the plate follows the screen style; only 모던 adds the state dot (the mockups').
  const theme = useUiTheme();
  const modern = theme === 'modern';
  const staff = staffSnapshot();
  const engineProject = useEngineProject(name);
  const orchestratorModel = modelEffortLabel(engineProject?.model, engineProject?.effort);
  // hud-v3 P0: with an inspector slot (the cld desktop), the plate stays short and the inspector shows the rest.
  const inspector = useInspectorSlot();
  // LOUNGE: off duty it is still in the building, resting: its own label, with 퇴근 at its feet.
  const offDuty = !!staff.away[ch.id];
  if (staffHides(ch)) return null; // held out of sight while the office loads
  const temp = staff.temps.find((t) => t.id === ch.id);
  // TEMP-PLATES: a sub-agent or Codex temporary is a roster employee, with its own level.
  const employee = employeeOf(ch.id);
  const level = identity?.level ?? employee?.level;
  const overtime = staff.overtime.includes(ch.id);
  // The readable rank/model at the feet: when no plate carries it, and always with nameplates off (as before them).
  const feetRank = !named || !nameplatesOn();
  const details = hovered || selected;
  // FEAT-PARTY-V2: the selected one's details are the member card (beside the party, or the phone's sheet);
  // the plate opens in place only on a hover without the party's slot.
  const card = details && inspector === null && !selected;
  const icon = statusIcon(visual.ring);
  // Starts the activity's clock for every plate, so the detail view (StatCard) can say how long it has run.
  activityElapsed(ch.id, `${visual.icon} ${visual.text}`);
  // Every character's status, at the head icon's spot (where the canvas draws
  // it for a name-less one): tests find it here, and screen readers too when
  // no name label speaks for the character.
  const iconAnchor = (
    <span
      ref={bind('icon', (at) => ({
        x: at.toScreenX(ch.x + STATUS_ICON_OFFSET_X),
        y: at.toScreenY(ch.y + seat(ch) - STATUS_ICON_RISE_PX - lift),
      }))}
      className="absolute left-0 top-0 pointer-events-none"
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
    (temp && feetRank) || overtime || offDuty ? (
      <span
        ref={bind('feet', (at) => ({
          x: at.toScreenX(ch.x),
          y: at.toScreenY(ch.y + seat(ch) + 1),
        }))}
        className="absolute left-0 top-0 -translate-x-1/2 flex items-center gap-2 pointer-events-none"
        data-testid="feet-badges"
        data-agent-id={ch.id}
      >
        {temp && feetRank && <TempRank level={level?.level} badge={temp.model} modelId={temp.modelId} />}
        {offDuty && (
          <span
            className="bg-bg border border-border rounded-ui-chip px-4 text-xs leading-tight whitespace-nowrap text-text-muted"
            data-testid="off-duty-badge"
            data-agent-id={ch.id}
          >
            {t('temp.offDuty')}
          </span>
        )}
        {overtime && (
          <span
            className="bg-bg border border-border rounded-ui-chip px-4 text-xs leading-tight whitespace-nowrap"
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
  // T-67: one width for every plate; a long name ends in … and shows whole while hovered or selected.
  const look = plateLook(sizes.card[theme], details, card);
  const rankId = rankOfLevel(level?.level);
  // The rank in words (the level's; an orchestrator's icon is the crown but its rank is written too).
  const rankText = temp
    ? rankModelLabel(level?.level, temp.model, temp.modelId)
    : [rankId ? rankName(rankId) : kindLabel(kind), orchestratorModel].filter(Boolean).join(' · ');
  // Bottom centre of the whole overlay, kept on screen (its size from the last overlap pass).
  const plateAt = bind('plate', (at) =>
    clampPlate(
      at.toScreenX(ch.x),
      at.toScreenY(
        ch.y + seat(ch) - lift - (named ? TOOL_OVERLAY_VERTICAL_OFFSET : STATUS_DETAILS_RISE_PX),
      ),
      plateSizes.get(ch.id),
      bounds,
      NAMEPLATE_EDGE_MARGIN_PX,
    ),
  );
  // The rank icon: beside the name on the plate; inside the rank chip once the summary is open.
  const rankIconNode = rank && (
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
  );
  return (
    <>
      {iconAnchor}
      {feet}
      <div
        ref={plateAt}
        // w-max: near the right edge an absolute box would shrink to the room left of it.
        // FEAT-OFFICE-NAMEPLATE-MODERN (owner 11-06): the plate is UI, so it follows the screen style (no .ui-world).
        className="absolute left-0 top-0 w-max flex flex-col items-center -translate-x-1/2 -translate-y-full"
        style={{
          pointerEvents: selected && card ? 'auto' : 'none',
          opacity: Math.min(
            offAlpha(!!identity?.off, details, OFF_OVERLAY_ALPHA),
            dim ? PHONE_CARD_OTHERS_ALPHA : 1,
          ),
          zIndex: details ? OVERLAY_LABEL_SELECTED_Z_INDEX : OVERLAY_LABEL_Z_INDEX,
        }}
        data-testid="agent-overlay"
        data-agent-id={ch.id}
        data-kind={kind}
        // Off duty or asleep: the crowd pass (nameplate.ts crowdPlates) may shrink or move it for a working one;
        // hovered or selected it holds where it is (useNameplates.ts), so a hover never moves it from under the pointer.
        data-rest={offDuty || visual.ring === 'idle' || visual.ring === 'off' ? '' : undefined}
      >
        {fatigue?.rest && <RestBubble className="mb-4" />}
        {identity && <OfficeBadges identity={identity} />}
        {/* charpack v3 §6A: the nameplate; the overlap pass (useNameplates.ts) dims it by its data-nameplate. */}
        <div
          className={`relative flex items-start gap-4 pixel-panel rounded-ui-card max-w-2xs ${selected && !card ? 'border-accent' : 'border-border'} ${details ? 'px-4 pt-2 pb-4' : 'px-3 pt-2 pb-3'}`}
          style={card ? { maxWidth: STAT_SUMMARY_MAX_PX } : { width: look.width }}
          data-nameplate=""
          data-agent-id={ch.id}
          data-focus={details ? '' : undefined}
          data-selected={selected || undefined}
        >
          {named && (
            <StatusIconNode visual={visual} phase={Math.abs(ch.id) * PHASE_PER_ID} scale={sizes.status} />
          )}
          {card && (
            // The face, and the rank chip under it.
            <div className="flex flex-col items-start gap-3 shrink-0">
              <span className="border-ui border-border rounded-ui-card overflow-hidden" data-testid="stat-face">
                <CharacterMugShot palette={ch.palette} hueShift={ch.hueShift} size={STAT_SUMMARY_FACE_PX} />
              </span>
              {rankId && (
                <span
                  className="flex items-center gap-2 border-ui border-border rounded-ui-chip px-4 text-2xs leading-tight text-yellow-300"
                  data-testid="rank-text"
                >
                  {rankIconNode}
                  {rankName(rankId)}
                </span>
              )}
            </div>
          )}
          <div className={`flex flex-col min-w-0 ${card ? '' : 'flex-1'} ${details ? 'gap-3' : 'gap-2'}`}>
            <span
              className="flex items-center gap-3 min-w-0 whitespace-nowrap"
              // STAT-CARD: the short summary; the numbers behind it are in the 스탯 view.
              data-testid={card ? 'level' : undefined}
              data-level={card ? level?.level : undefined}
              data-rebirths={card ? level?.rebirths : undefined}
              data-xp={card ? level?.xp : undefined}
            >
              {modern && !card && (
                // Centred on the plate's left line, its margins cancelling its width and the gap: no wider a plate.
                <span
                  className="ui-status-dot rounded-ui-pill border-ui border-surface-body w-10 h-10 -ml-9 -mr-4"
                  data-tone={DOT_TONE[visual.ring]}
                  data-testid="plate-dot"
                  aria-hidden
                />
              )}
              {!card && rankIconNode}
              <span
                className={`font-bold text-accent-text leading-tight min-w-0 ${card ? '' : 'flex-1'} ${look.name === 'cut' ? 'truncate' : card ? 'whitespace-normal break-words' : 'whitespace-normal break-all'}`}
                style={{ fontSize: `max(${sizes.name}px, var(--ui-text-floor))` }}
                title={name}
                data-name={name}
                data-cut={look.name === 'cut' || undefined}
                data-testid="agent-name"
              >
                {name}
              </span>
              {ring && <LevelRing ring={ring} sizes={sizes} />}
              {card && level && <RebirthMark count={level.rebirths} scale={sizes.rank} />}
            </span>
            {fatigue ? (
              <FatigueBar look={fatigue} compact={sizes} barPx={card ? STAT_SUMMARY_BAR_PX : undefined} />
            ) : (
              employee && <UnknownFatigue compact={sizes} />
            )}
            {details && !card && (
              // hud-v3 P0, PC: a hover or the selection adds the current state, one line.
              <span className="truncate text-2xs leading-tight" title={rawActivity} data-testid="plate-activity">
                {visual.icon} {visual.text}
              </span>
            )}
            {card && (
              <div
                className="flex flex-col gap-3 text-2xs leading-tight"
                data-testid="agent-details"
              >
                <span
                  className="line-clamp-2 break-words"
                  title={rawActivity}
                  data-testid="activity-text"
                >
                  {visual.icon} {visual.text}
                </span>
                {selected && temp?.work && (
                  // T-0056: the click selects; this opens what the temp is doing.
                  <button
                    type="button"
                    className="self-start border border-border rounded-ui-chip px-4 py-1 pointer-events-auto hover:bg-btn-hover pointer-coarse:min-h-44"
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
        </div>
      </div>
      {selected && (
        <MemberCard
          id={ch.id}
          name={name}
          palette={ch.palette}
          hueShift={ch.hueShift}
          activity={{ icon: visual.icon, text: visual.text, ring: visual.ring }}
          rawActivity={rawActivity}
          rankText={rankText}
          rankIcon={rankIconNode}
          lookName={lookName}
          characters={characters}
          into={inspector}
          onClose={onDeselect}
        />
      )}
    </>
  );
}

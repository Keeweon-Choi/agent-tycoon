import { useState } from 'react';

import type { OfficeLevel } from '../../../../core/src/messages.js';
import {
  FATIGUE_BAR_COLORS,
  LEVEL_BAR_COLOR,
  LEVEL_RING_EMPTY_COLOR,
  NAMEPLATE_RING_STROKE_PX,
  REST_BUBBLE_BG,
  REST_BUBBLE_BORDER,
  REST_BUBBLE_TEXT,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { NameplateSizes } from '../uiScale.js';
import { EFFECT_SPRITES } from './drawVisuals.js';
import { compactionText, type FatigueLook, fatigueText } from './fatigue.js';
import { levelLook, levelText } from './level.js';
import { type Ring, ringDash } from './nameplate.js';
import { PixelSprite } from './PixelSprite.js';

/**
 * DNF-style stamina bar, "피로도 72%": green, then yellow when tired, red from the yawns.
 * `compact`: the nameplate's second row, "피로도 [bar] 72% · 휴식 1/2" in one line
 * the plate's width (the bar takes what the words leave), at the 화면 크기 step's sizes.
 */
export function FatigueBar({ look, compact }: { look: FatigueLook; compact?: NameplateSizes }) {
  if (compact)
    return (
      <span
        className="flex items-center gap-4 w-full leading-none whitespace-nowrap text-text-muted"
        style={{ fontSize: compact.fatigue }}
        role="meter"
        aria-label={t('activity.fatigue')}
        aria-valuetext={fatigueText(look)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={look.value}
        data-testid="fatigue"
        data-tone={look.tone}
      >
        <span aria-hidden data-testid="fatigue-label">
          {t('activity.fatigue')}
        </span>
        <span
          className="block flex-1 border border-border bg-bg-dark"
          style={{ minWidth: compact.barMin, height: compact.barHeight }}
        >
          <span
            className="block h-full"
            style={{ width: `${look.value}%`, background: FATIGUE_BAR_COLORS[look.tone] }}
          />
        </span>
        <span aria-hidden className="text-text" data-testid="fatigue-pct">
          {look.value}%
        </span>
        <span aria-hidden>·</span>
        <span
          aria-hidden
          className={look.renew ? 'font-bold text-yellow-300' : undefined}
          data-testid="compaction-text"
          data-renew={look.renew}
        >
          {compactionText(look)}
        </span>
      </span>
    );
  return (
    <span
      className="flex items-center gap-4 leading-none"
      role="meter"
      aria-label={t('activity.fatigue')}
      aria-valuetext={fatigueText(look)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={look.value}
      data-testid="fatigue"
      data-tone={look.tone}
    >
      <span className="block w-40 h-6 border border-border bg-bg-dark shrink-0">
        <span
          className="block h-full"
          style={{ width: `${look.value}%`, background: FATIGUE_BAR_COLORS[look.tone] }}
        />
      </span>
      <span className="text-2xs whitespace-nowrap" data-testid="fatigue-text">
        {t('activity.fatigue')} {look.value}% ·{' '}
        <span
          className={look.renew ? 'font-bold text-yellow-300' : undefined}
          data-testid="compaction-text"
          data-renew={look.renew}
        >
          {compactionText(look)}
        </span>
      </span>
    </span>
  );
}

/** TEMP-PLATES: the plate's 피로도 row when no verified context exists (a Codex run): "피로도 미확인", never a guess. */
export function UnknownFatigue({ compact }: { compact: NameplateSizes }) {
  return (
    <span
      className="flex items-center gap-4 w-full leading-none whitespace-nowrap text-text-muted"
      style={{ fontSize: compact.fatigue }}
      data-testid="fatigue-unknown"
    >
      {t('activity.fatigue')} <span className="text-text">{t('activity.fatigueUnknown')}</span>
    </span>
  );
}

/** U-15: "Lv 3 · 환생 1회", the XP bar and "다음 레벨까지 45" (the server's numbers, only placed here). */
export function LevelBar({ level }: { level: OfficeLevel }) {
  const look = levelLook(level);
  return (
    <span
      className="flex flex-col gap-2 leading-none"
      role="meter"
      aria-label={t('character.xp', { xp: level.xp })}
      aria-valuetext={levelText(level)}
      aria-valuemin={level.floor}
      aria-valuemax={level.next}
      aria-valuenow={Math.min(level.xp, level.next)}
      data-testid="level"
      data-level={level.level}
      data-rebirths={level.rebirths}
      data-xp={level.xp}
    >
      <span className="text-2xs whitespace-nowrap" data-testid="level-text">
        <span className="font-bold" data-testid="level-lv">{t('character.level', { level: level.level })}</span>
        {' · '}
        <span data-testid="level-rebirths">{t('character.rebirths', { count: level.rebirths })}</span>
      </span>
      <span className="flex items-center gap-4">
        <span className="block w-40 h-6 border border-border bg-bg-dark shrink-0" data-testid="xp-bar">
          <span className="block h-full" style={{ width: `${look.pct}%`, background: LEVEL_BAR_COLOR }} />
        </span>
        <span className="text-2xs whitespace-nowrap" data-testid="xp-next">
          {t('character.xpToNext', { count: look.remaining })}
        </span>
      </span>
    </span>
  );
}

/**
 * charpack v3 §6A: the level inside a ring of its XP to the next level,
 * filled clockwise from the top (the server's numbers, placed by ringOf).
 */
export function LevelRing({ ring, sizes }: { ring: Ring; sizes: NameplateSizes }) {
  const size = sizes.ring;
  const stroke = NAMEPLATE_RING_STROKE_PX;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const [filled, empty] = ringDash(ring.pct, c);
  return (
    <span
      className="relative shrink-0 flex items-center justify-center leading-none"
      style={{ width: size, height: size }}
      role="img"
      aria-label={t('character.levelRing', { level: ring.level, pct: ring.pct })}
      title={t('character.levelRing', { level: ring.level, pct: ring.pct })}
      data-testid="level-ring"
      data-level={ring.level}
      data-pct={ring.pct}
    >
      <svg className="absolute inset-0" width={size} height={size} aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={LEVEL_RING_EMPTY_COLOR}
          strokeWidth={stroke}
        />
        {filled > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={LEVEL_BAR_COLOR}
            strokeWidth={stroke}
            strokeDasharray={`${filled} ${empty}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            data-testid="level-ring-fill"
          />
        )}
      </svg>
      <span className="relative font-bold" style={{ fontSize: sizes.level }}>
        {ring.level}
      </span>
    </span>
  );
}

/**
 * 휴식이 필요해요. A suggestion only: a tap says what to do about it, and
 * nothing ever runs by itself.
 */
export function RestBubble({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className={`pointer-events-auto flex items-center gap-4 border-2 px-6 py-2 text-2xs leading-tight text-left shadow-pixel ${className}`}
      style={{
        background: REST_BUBBLE_BG,
        borderColor: REST_BUBBLE_BORDER,
        color: REST_BUBBLE_TEXT,
      }}
      aria-expanded={open}
      data-testid="rest-bubble"
      onClick={(event) => {
        event.stopPropagation();
        setOpen((shown) => !shown);
      }}
    >
      <PixelSprite sprite={EFFECT_SPRITES.zz.frames[0]} scale={2} />
      <span>
        {t('activity.restNeeded')}
        {open && <span className="block">{t('activity.handoffRecommended')}</span>}
      </span>
    </button>
  );
}

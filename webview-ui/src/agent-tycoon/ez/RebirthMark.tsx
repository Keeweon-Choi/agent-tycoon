/**
 * STAT-2: a character's rebirths as a small pixel soul flame with "×N" (a stepped flicker and
 * sparkle, still under prefers-reduced-motion). The words "환생 N회" stay for screen readers.
 */
import { t } from '../../i18n/index.js';
import { PixelSprite } from './PixelSprite.js';
import { REBIRTH_FLAME_A, REBIRTH_FLAME_B, REBIRTH_SPARK } from './rebirthSprites.js';

export function RebirthMark({ count, scale }: { count: number; scale: number }) {
  const text = t('character.rebirths', { count });
  return (
    <span
      className="flex items-center gap-2 border-2 border-border px-4"
      title={text}
      aria-label={text}
      role="img"
      data-testid="rebirth-chip"
    >
      <span className="sr-only">{text}</span>
      <span aria-hidden className={`rebirth-mark relative flex ${count > 0 ? '' : 'opacity-50'}`} data-lit={count > 0}>
        <span className="rebirth-flame-a">
          <PixelSprite sprite={REBIRTH_FLAME_A} scale={scale} />
        </span>
        <span className="rebirth-flame-b absolute inset-0">
          <PixelSprite sprite={REBIRTH_FLAME_B} scale={scale} />
        </span>
        <span className="rebirth-spark absolute -top-2 -right-4">
          <PixelSprite sprite={REBIRTH_SPARK} scale={scale} />
        </span>
      </span>
      <span aria-hidden>×{count}</span>
    </span>
  );
}

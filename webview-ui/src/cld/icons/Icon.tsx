/**
 * FEAT-UI-MODERN-THEME: one icon, two styles. 모던 draws the Lucide outline (lucide.ts, 24 grid,
 * currentColor, 2 wide), 픽셀 감성 draws `pixel`, the pixel glyph that stood there before
 * (hud/glyphs.tsx, game/parts.tsx PixelIcon), so that style stays exactly as it was.
 */
import { createElement, type ReactNode } from 'react';

import { useUiTheme } from '../uiTheme.js';
import { LUCIDE, type LucideName } from './lucide.js';

export type { LucideName };

export function Icon({
  name,
  pixel,
  size = 16,
  className,
}: {
  name: LucideName;
  /** What 픽셀 감성 draws (null: nothing). */
  pixel: ReactNode;
  /** The outline's box in CSS px. */
  size?: number;
  className?: string;
}) {
  if (useUiTheme() === 'pixel') return <>{pixel}</>;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {LUCIDE[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

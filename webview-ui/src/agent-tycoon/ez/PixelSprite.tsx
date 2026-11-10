import { useEffect, useRef } from 'react';

import { getCachedSprite } from '../../office/sprites/spriteCache.js';
import type { SpriteData } from '../../office/types.js';

/** A sprite in the DOM at whole device pixels per sprite pixel, like the office canvas. */
export function PixelSprite({
  sprite,
  scale,
  className = '',
}: {
  sprite: SpriteData;
  /** CSS px per sprite pixel (rounded to whole device pixels). */
  scale: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = window.devicePixelRatio || 1;
  const zoom = Math.max(1, Math.round(scale * dpr));
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const source = getCachedSprite(sprite, zoom);
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext('2d')?.drawImage(source, 0, 0);
  }, [sprite, zoom]);
  return (
    <canvas
      ref={ref}
      aria-hidden
      className={`block shrink-0 ${className}`}
      style={{ width: (sprite[0].length * zoom) / dpr, height: (sprite.length * zoom) / dpr }}
    />
  );
}

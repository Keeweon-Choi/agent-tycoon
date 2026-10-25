import { useEffect, useRef } from 'react';

import {
  CLASSIC_FIGURE_RISE,
  MUGSHOT_CROP_LEFT_COL,
  MUGSHOT_CROP_SIDE_PX,
  MUGSHOT_CROP_TOP_ROW,
  MUGSHOT_DISPLAY_PX,
  MUGSHOT_RENDER_ZOOM,
} from '../constants.js';

/** A classic frame's half width, and the world px a taller figure's crop leaves over its head. */
const FRAME_HALF_W = 8;
const MUGSHOT_HEAD_MARGIN = 1;
import { getCachedSprite } from '../office/sprites/spriteCache.js';
import {
  characterLift,
  getCharacterSprites,
  getCustomMugshot,
  spritesAtZoom,
} from '../office/sprites/spriteData.js';
import { Direction } from '../office/types.js';

interface CharacterMugShotProps {
  palette: number;
  hueShift: number;
  /** On-screen side length in CSS px. Defaults to MUGSHOT_DISPLAY_PX. */
  size?: number;
}

/**
 * A square "mug shot" — the head region of an agent's front-facing sprite,
 * scaled up crisply. Used as the terminal tab's identity in place of a label.
 *
 * Reuses the office sprite cache: the full front sprite is rendered once per
 * palette:hueShift, and we blit just the head square out of it.
 */
export function CharacterMugShot({
  palette,
  hueShift,
  size = MUGSHOT_DISPLAY_PX,
}: CharacterMugShotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // HD64: the copy the card's zoom divides (its 32×64), never a fractional fill
    const sprites = spritesAtZoom(getCharacterSprites(palette, hueShift), MUGSHOT_RENDER_ZOOM);
    const front = sprites.walk[Direction.DOWN][0];
    const full = getCachedSprite(front, MUGSHOT_RENDER_ZOOM / sprites.density); // HD: same crop, more detail

    const side = MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM;
    canvas.width = side;
    canvas.height = side;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, side, side);
    // cld-gui (T-0017): a photo character shows its own portrait, centred.
    const portrait = getCustomMugshot(palette);
    if (portrait) {
      // an HD portrait (CHAR-FACTORY: twice the pixels) fills the same square at a smaller zoom
      const face = getCachedSprite(portrait, Math.max(1, Math.floor(side / portrait.length)));
      ctx.drawImage(face, (side - face.width) / 2, (side - face.height) / 2);
      return;
    }
    // SHEET-IMPORT: a taller figure (a wider, taller frame) is cropped in proportion, round its
    // head and the frame's middle, and fills the same square
    const lift = characterLift(palette, hueShift);
    const k = 1 + lift / CLASSIC_FIGURE_RISE;
    const frameW = front[0].length / sprites.density;
    const frameH = front.length / sprites.density;
    const [cropX, cropY] = lift
      ? [
          frameW / 2 - (FRAME_HALF_W - MUGSHOT_CROP_LEFT_COL) * k,
          Math.max(0, frameH - 1 - CLASSIC_FIGURE_RISE - lift - MUGSHOT_HEAD_MARGIN * k),
        ]
      : [MUGSHOT_CROP_LEFT_COL, MUGSHOT_CROP_TOP_ROW];
    if (lift) ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      full,
      cropX * MUGSHOT_RENDER_ZOOM,
      cropY * MUGSHOT_RENDER_ZOOM,
      side * k,
      side * k,
      0,
      0,
      side,
      side,
    );
  }, [palette, hueShift]);

  return (
    <canvas
      ref={canvasRef}
      width={MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM}
      height={MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM}
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
    />
  );
}

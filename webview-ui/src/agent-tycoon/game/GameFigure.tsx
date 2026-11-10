/** GAME-UI-1 G3: a character's whole figure from its office sprites (the look the office shows), crisp. */
import type { AgentAppearance } from '../../components/AgentCard.js';
import { getCharacterSprites } from '../../office/sprites/spriteData.js';
import { Direction } from '../../office/types.js';
import { Frame } from '../characters/LooksWindow.js';

/** Standing (`step` undefined) or the walk's frame `step`, facing `dir`, at `zoom` css px per world px. */
export function GameFigure({
  look,
  zoom,
  dir = Direction.DOWN,
  step,
}: {
  look: AgentAppearance;
  zoom: number;
  dir?: Direction;
  step?: number;
}) {
  const sprites = getCharacterSprites(look.palette, look.hueShift);
  const walk = sprites.walk[dir];
  const sprite = step === undefined ? (sprites.stand?.[dir] ?? walk[1]) : walk[step % walk.length];
  return <Frame sprite={sprite} zoom={zoom} density={sprites.density} />;
}

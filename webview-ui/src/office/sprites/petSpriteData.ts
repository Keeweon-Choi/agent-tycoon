import { MASCOT_SPECIES } from '../../../../core/src/agent-tycoon/looks.js';
import type { MascotSpecies } from '../../../../core/src/messages.js';
import { composeMascot, MASCOTS } from '../../agent-tycoon/characters/compose.js';
import { t } from '../../i18n/index.js';
import type { SpriteData } from '../types.js';

/**
 * Resolved per-pet sprite frames. Each entry is a 3-frame animation array
 * (walk: PET_WALK_SEQUENCE [0,1,0,2], so frame 0 is the standing pose).
 */
export interface PetSpriteFrames {
  walkDown: [SpriteData, SpriteData, SpriteData];
  idleDown: [SpriteData, SpriteData, SpriteData];
  walkUp: [SpriteData, SpriteData, SpriteData];
  idleUp: [SpriteData, SpriteData, SpriteData];
  walkRight: [SpriteData, SpriteData, SpriteData];
  walkLeft: [SpriteData, SpriteData, SpriteData];
  idleRight: [SpriteData, SpriteData, SpriteData];
  idleLeft: [SpriteData, SpriteData, SpriteData];
}

/** The pets are the mascots (11-04: our own art replaces the upstream pet sheets); petType = index here. */
export const PET_SPECIES: readonly MascotSpecies[] = MASCOT_SPECIES;

const flip = (s: SpriteData): SpriteData => s.map((row) => [...row].reverse());

let loadedPets: PetSpriteFrames[] | null = null;

/** A mascot sheet row (walk1 walk2 walk3 ...) as the pet's walk [stand, step, step] and idle. */
function petOf(species: MascotSpecies): PetSpriteFrames {
  const { sheet } = composeMascot({ species }, MASCOTS[species]);
  const walk = (row: SpriteData[]): [SpriteData, SpriteData, SpriteData] => [
    row[1],
    row[0],
    row[2],
  ];
  const idle = (s: SpriteData): [SpriteData, SpriteData, SpriteData] => [s, s, s];
  const walkRight = walk(sheet.right);
  return {
    walkDown: walk(sheet.down),
    idleDown: idle(sheet.down[1]),
    walkUp: walk(sheet.up),
    idleUp: idle(sheet.up[1]),
    walkRight,
    walkLeft: [flip(walkRight[0]), flip(walkRight[1]), flip(walkRight[2])],
    idleRight: idle(walkRight[0]),
    idleLeft: idle(flip(walkRight[0])),
  };
}

function pets(): PetSpriteFrames[] {
  return (loadedPets ??= PET_SPECIES.map(petOf));
}

/** Returns the resolved frames for a petType, or null if out of range. */
export function getPetSprites(petIndex: number): PetSpriteFrames | null {
  return pets()[petIndex] ?? null;
}

/** Number of pets the editor offers. */
export function getPetCount(): number {
  return PET_SPECIES.length;
}

/** Display name for a petType: the mascot's name. */
export function getPetName(petIndex: number): string {
  const species = PET_SPECIES[petIndex];
  return species ? t(`looks.species.${species}`) : `Pet ${petIndex + 1}`;
}

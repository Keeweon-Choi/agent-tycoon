/**
 * CH-1: which built-in sheet a look is drawn on, shared by the daemon (the palette a character is
 * made with) and the webview (the fallback for a look it cannot draw yet). Pure, no DOM.
 */
import { CHAR_COUNT } from '../assets/constants.js';
import type {
  CharacterAccessory,
  CharacterChoice,
  CharacterColors,
  LookExpression,
  MascotGear,
  MascotSpecies,
} from '../messages.js';

/** A v1 palette look as it is; a v2 humanoid on its \`base\` sheet with its \`hue\` (the webview
 *  draws its colours and accessories, CH-5); null for anything else (a preset is drawn from its sheet; a
 *  mascot, until CH-3, as the character's own palette): never an invisible sheet. */
export function paletteOfLook(
  choice: CharacterChoice | undefined,
): { palette: number; hueShift: number } | null {
  if (choice?.palette !== undefined)
    return { palette: choice.palette, hueShift: choice.hueShift ?? 0 };
  if (choice?.kind === 'humanoid') return { palette: choice.base ?? 0, hueShift: choice.hue ?? 0 };
  return null;
}

/** CH-3: the mascots in their picker order and the provider each one is recommended for. */
export const MASCOT_SPECIES = [
  'tori',
  'coral',
  'byte',
  'puff',
] as const satisfies readonly MascotSpecies[];

/** The mascot faces and headgear, in their picker order. */
export const MASCOT_EXPRESSIONS = [
  'smile',
  'happy',
  'focus',
  'sleepy',
] as const satisfies readonly LookExpression[];
export type MascotExpression = (typeof MASCOT_EXPRESSIONS)[number];
export const MASCOT_GEARS = [
  'headset',
  'beanie',
  'sprout',
  'crown',
] as const satisfies readonly MascotGear[];
/** A humanoid's hue turns in these steps up to HUMANOID_HUE_MAX (the stored range). */
export const HUMANOID_HUE_STEP = 15;
export const HUMANOID_HUE_MAX = 345;

/** §3.3 item 2: Claude → Coral, Codex → Byte, any other (or unknown) provider → Tori. */
export function mascotOfProvider(provider: string | null | undefined): MascotSpecies {
  return provider === 'claude' ? 'coral' : provider === 'codex' ? 'byte' : 'tori';
}

/* eslint-disable pixel-agents/no-inline-colors -- stored look colours: data, not UI styling */
/** The fixed body colours per species (§5.4, `chosen-variants.png`): the first is the default; a
 *  new name gets the least used one among the same species' looks. */
export const MASCOT_COLORS: Readonly<Record<MascotSpecies, readonly string[]>> = {
  coral: ['#ea7d55', '#6b9cf0', '#b07ef0', '#f2cf4a'],
  byte: ['#3d8fdc', '#f08450', '#8fd050', '#b4b4c4'],
  puff: ['#6fd39a', '#f58ab4', '#7fb6f0', '#f5b450'],
  tori: ['#dda05c', '#c8ac80', '#d97a68', '#a0a0a0'],
};

/** CH-5: a person's parts and accessories, in their picker order. */
export const HUMANOID_PARTS = [
  'skin',
  'hair',
  'top',
  'bottom',
  'shoes',
] as const satisfies readonly (keyof CharacterColors)[];
export const HUMANOID_ACCESSORIES = [
  'glasses',
  'headset',
  'cap',
] as const satisfies readonly CharacterAccessory[];
/** The fixed part colours (skin 6, hair 8, clothes 10 for top, bottom and shoes), lower case as
 *  the daemon stores them; 🎲 picks only from these. */
export const HUMANOID_SWATCHES = {
  skin: ['#ffdcc2', '#f1c09a', '#e9a384', '#c68a64', '#9a6040', '#6b4128'],
  hair: ['#1f1b1c', '#4a2f1e', '#8f6439', '#d9b062', '#b5452f', '#b9b6b4', '#4f6fd0', '#e07ab0'],
  clothes: [
    '#1164a9',
    '#0d2a4a',
    '#2b2b2b',
    '#e8e8e8',
    '#c0392b',
    '#e67e22',
    '#f1c40f',
    '#27ae60',
    '#8e44ad',
    '#7f5539',
  ],
} as const;
/* eslint-enable pixel-agents/no-inline-colors */

/** The swatches a part picks from. */
export const swatchesOf = (part: keyof CharacterColors): readonly string[] =>
  part === 'skin' || part === 'hair' ? HUMANOID_SWATCHES[part] : HUMANOID_SWATCHES.clothes;

/** The colour from MASCOT_COLORS least used by \`looks\` of that species (ties: list order). */
export function leastUsedMascotColor(
  species: MascotSpecies,
  looks: Iterable<CharacterChoice | undefined>,
): string {
  const colors = MASCOT_COLORS[species];
  const used = colors.map(() => 0);
  for (const look of looks) {
    if (look?.kind !== 'mascot' || look.species !== species) continue;
    const i = colors.indexOf(look.color ?? colors[0]);
    if (i >= 0) used[i]++;
  }
  return colors[used.indexOf(Math.min(...used))];
}

/** CHAR-HUMAN / CHAR-FACTORY: the person's slots, colours and ids live in the registry. */
export {
  MAX_PERSON_ACC,
  PART_ID,
  PART_SLOTS,
  type PartSlot,
  PERSON_COLORS,
} from './partRegistry.js';

/** Rerolls before a random look may equal one already in the office (§6.4). */
export const RANDOM_LOOK_TRIES = 8;

const pick = <T>(list: readonly T[], rand: () => number): T =>
  list[Math.min(list.length - 1, Math.floor(rand() * list.length))];

/**
 * CH-4 🎲: a random look of `kind` from the fixed options only (a species' own colours, the
 * faces, the headgear or none; CH-5: a built-in body, a swatch per part and each accessory one
 * time in three), rerolled while it equals a look in `taken` (compared by `key`). Always a look
 * the daemon stores as it is.
 */
export function randomLook(
  kind: 'mascot' | 'humanoid',
  taken: ReadonlySet<string>,
  key: (look: CharacterChoice) => string,
  rand: () => number = Math.random,
): CharacterChoice {
  let look: CharacterChoice = {};
  for (let i = 0; i < RANDOM_LOOK_TRIES; i++) {
    if (kind === 'mascot') {
      const species = pick(MASCOT_SPECIES, rand);
      const gear = pick([undefined, ...MASCOT_GEARS], rand);
      look = {
        v: 2,
        kind: 'mascot',
        species,
        color: pick(MASCOT_COLORS[species], rand),
        expr: pick(MASCOT_EXPRESSIONS, rand),
        ...(gear && { gear }),
      };
    } else {
      const acc = HUMANOID_ACCESSORIES.filter(() => rand() < 1 / 3);
      look = {
        v: 2,
        kind: 'humanoid',
        base: pick([...Array(CHAR_COUNT).keys()], rand),
        colors: Object.fromEntries(
          HUMANOID_PARTS.map((part) => [part, pick(swatchesOf(part), rand)]),
        ),
        ...(acc.length && { acc }),
      };
    }
    if (!taken.has(key(look))) break;
  }
  return look;
}

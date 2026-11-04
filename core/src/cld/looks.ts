/**
 * CH-1: which built-in sheet a look is drawn on, shared by the daemon (the palette a character is
 * made with) and the webview (the fallback for a look it cannot draw yet). Pure, no DOM.
 */
import { CHAR_COUNT } from '../assets/constants.js';
import type {
  CharacterChoice,
  CharacterColors,
  LookExpression,
  MascotGear,
  MascotSpecies,
} from '../messages.js';

/** OWNER-AVATAR: the look key the owner keeps for themself (the lobby's counter, their office
 *  character); the daemon accepts it like a character's name. */
export const OWNER_LOOK_KEY = 'owner';

/** A v1 palette look as it is; a v2 humanoid on its \`base\` sheet with its \`hue\` (CHARS-1104:
 *  its colours and accessories are no longer drawn); null for anything else (a preset is drawn from its sheet; a
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
  'kwak',
  'bugi',
  'moka',
  'mungge',
  'boo',
  'gasi',
  'mora',
  'shoo',
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
/** A v2 humanoid's stored hue range (read for one release, CHARS-1104). */
export const HUMANOID_HUE_MAX = 345;

/** §3.3 item 2: Claude → Coral, Codex → Byte, any other (or unknown) provider → Tori. */
export function mascotOfProvider(provider: string | null | undefined): MascotSpecies {
  return provider === 'claude' ? 'coral' : provider === 'codex' ? 'byte' : 'tori';
}

/* eslint-disable agent-tycoon/no-inline-colors -- stored look colours: data, not UI styling */
/** The fixed body colours per species (§5.4, `chosen-variants.png`): the first is the default; a
 *  new name gets the least used one among the same species' looks. */
export const MASCOT_COLORS: Readonly<Record<MascotSpecies, readonly string[]>> = {
  coral: ['#ea7d55', '#6b9cf0', '#b07ef0', '#f2cf4a'],
  byte: ['#3d8fdc', '#f08450', '#8fd050', '#b4b4c4'],
  puff: ['#6fd39a', '#f58ab4', '#7fb6f0', '#f5b450'],
  tori: ['#dda05c', '#c8ac80', '#d97a68', '#a0a0a0'],
  kwak: ['#ffd84a', '#ff9ec4', '#8ad4ff', '#b8e86a'],
  bugi: ['#e8504a', '#4a8ae8', '#f0b030', '#58c070'],
  moka: ['#56c4b4', '#e88aa8', '#f2c94c', '#9a8cf0'],
  mungge: ['#b4dcff', '#ffc8dc', '#d4c4ff', '#a8b0c0'],
  boo: ['#efeaff', '#b8f0d8', '#ffc4dc', '#c4d8ff'],
  gasi: ['#86c95e', '#5ec9a8', '#c9c45e', '#c98ad0'],
  mora: ['#8a68d8', '#d8a050', '#5a9ae0', '#d86890'],
  shoo: ['#dfe3ee', '#f2d860', '#7ec8f0', '#f08ab0'],
};

/** The fixed part colours of a person of parts (skin 6, hair 8, clothes 10), lower case as the
 *  daemon stores them; 🎲 picks only from these. */
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
/* eslint-enable agent-tycoon/no-inline-colors */

/** The swatches a part picks from. */
export const swatchesOf = (part: keyof CharacterColors): readonly string[] =>
  part === 'skin' || part === 'hair' ? HUMANOID_SWATCHES[part] : HUMANOID_SWATCHES.clothes;

/**
 * Decision 9 (CHARS-1104): the (species, colour) of every species × its MASCOT_COLORS that
 * \`looks\` use least; ties go to the provider's recommended species first (Claude → Coral, Codex →
 * Byte, else Tori), then the picker order, each species' colours in their order.
 */
export function leastUsedMascot(
  provider: string | null | undefined,
  looks: Iterable<CharacterChoice | undefined>,
): { species: MascotSpecies; color: string } {
  const used = new Map<string, number>();
  for (const look of looks) {
    if (look?.kind !== 'mascot' || !look.species) continue;
    const key = `${look.species}:${(look.color ?? MASCOT_COLORS[look.species]?.[0] ?? '').toLowerCase()}`;
    used.set(key, (used.get(key) ?? 0) + 1);
  }
  const first = mascotOfProvider(provider);
  let best = { species: first, color: MASCOT_COLORS[first][0], n: Infinity };
  for (const species of [first, ...MASCOT_SPECIES.filter((s) => s !== first)])
    for (const color of MASCOT_COLORS[species]) {
      const n = used.get(`${species}:${color}`) ?? 0;
      if (n < best.n) best = { species, color, n };
    }
  return { species: best.species, color: best.color };
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
 * faces, the headgear or none; CHARS-1104 `humanoid`: one of the built-in people), rerolled while it equals a look in `taken` (compared by `key`). Always a look
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
    } else look = { palette: pick([...Array(CHAR_COUNT).keys()], rand), hueShift: 0 };
    if (!taken.has(key(look))) break;
  }
  return look;
}

/**
 * CHAR-FACTORY: the slot and layer registry (the orchestrator's char-pack-format.md, 10-25). The
 * compositor, the importer, the daemon's look check and the looks window read this table; a new
 * costume is parts in these slots (a pack or an import), never compositor code. Pure data.
 */
import type {
  CharacterBody,
  CharacterColors,
  CharacterPartSlot,
  LookExpression,
} from '../messages.js';

export type PartSlot = CharacterPartSlot;
export type ColorKey = keyof CharacterColors;

export interface SlotInfo {
  /** `sheet`: 112×96 on the body grid; `head`: the head canvas, placed at each frame's head. */
  kind: 'sheet' | 'head';
  /** The look colour its ramp takes (null: drawn as it is). */
  color: ColorKey | null;
  /** A person always has one (an unknown or missing id draws the built-in), unless `clearedBy`. */
  required?: boolean;
  /** Up to this many at once (accessories). */
  many?: number;
  /** Choosing a part in this slot empties these (a full-body suit replaces top and bottom). */
  clears?: readonly PartSlot[];
  /** A face: it may carry expressions. */
  expressions?: boolean;
}

export const SLOT_REGISTRY: Readonly<Record<PartSlot, SlotInfo>> = {
  back: { kind: 'sheet', color: 'back' }, // tail, cape, wings
  body: { kind: 'sheet', color: 'skin', required: true },
  face: { kind: 'head', color: null, required: true, expressions: true },
  legwear: { kind: 'sheet', color: 'legwear' },
  bottom: { kind: 'sheet', color: 'bottom', required: true },
  shoes: { kind: 'sheet', color: 'shoes' },
  top: { kind: 'sheet', color: 'top', required: true },
  fullbody: { kind: 'sheet', color: 'fullbody', clears: ['top', 'bottom'] },
  outer: { kind: 'sheet', color: 'outer' },
  neck: { kind: 'sheet', color: 'neck' },
  wrist: { kind: 'sheet', color: 'wrist' },
  hair: { kind: 'head', color: 'hair' },
  acc: { kind: 'head', color: 'acc', many: 3 },
};

/** The slots in the looks window's order (the registry's order). */
export const PART_SLOTS = Object.keys(SLOT_REGISTRY) as readonly PartSlot[];

/** Draw order, bottom to top, per view (`back` behind the body from the front and side, over the
 *  clothes from behind; hair stays above it). The reading paper goes over all of it. */
export const LAYER_ORDER: Readonly<Record<'down' | 'up' | 'right', readonly PartSlot[]>> = {
  down: [
    'back',
    'body',
    'face',
    'legwear',
    'bottom',
    'shoes',
    'top',
    'fullbody',
    'outer',
    'neck',
    'wrist',
    'hair',
    'acc',
  ],
  right: [
    'back',
    'body',
    'face',
    'legwear',
    'bottom',
    'shoes',
    'top',
    'fullbody',
    'outer',
    'neck',
    'wrist',
    'hair',
    'acc',
  ],
  up: [
    'body',
    'face',
    'legwear',
    'bottom',
    'shoes',
    'top',
    'fullbody',
    'outer',
    'neck',
    'wrist',
    'back',
    'hair',
    'acc',
  ],
};

/** The look colours a person picks: one per slot that recolours. */
export const PERSON_COLORS = [
  ...new Set(PART_SLOTS.map((s) => SLOT_REGISTRY[s].color).filter((c): c is ColorKey => !!c)),
] as readonly ColorKey[];

/** A face's expressions; a face without the chosen one shows neutral. */
export const FACE_EXPRESSIONS = [
  'neutral',
  'smile',
  'wink',
  'shy',
  'surprised',
  'sleepy',
  'playful',
  'happy',
] as const satisfies readonly LookExpression[];
export type CharacterExpression = (typeof FACE_EXPRESSIONS)[number];

/** Body variants, independent of gender, each its own silhouette (never a stretched one). A part
 *  drawn only for standard fits a variant that lies inside standard's silhouette (slim); a wider
 *  one (curvy, plus) needs its own drawing, else the part is shown as not available. */
export const BODY_VARIANTS = [
  'standard',
  'slim',
  'curvy',
  'plus',
] as const satisfies readonly CharacterBody[];
export const BODY_FITS_STANDARD: Readonly<Record<CharacterBody, boolean>> = {
  standard: true,
  slim: true,
  curvy: false,
  plus: false,
};

/** A part id: built-in (`hair-0`), the owner's (`p-hair-bob`) or a pack's (`<pack>/<part>`). */
export const PART_ID = /^[a-z0-9][a-z0-9_-]{0,63}(?:\/[a-z0-9][a-z0-9_-]{0,63})?$/;
/** A person wears at most this many accessories. */
export const MAX_PERSON_ACC = SLOT_REGISTRY.acc.many ?? 1;

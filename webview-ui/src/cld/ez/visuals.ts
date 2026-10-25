/**
 * T-0026: what a character shows for its EZ activity class (describeActivity's
 * emoji): a pixel prop beside it (props.json) and a status ring under it. Pure
 * apart from the per-frame hand-off below, so the mapping is unit-tested.
 */
import { FATIGUE_WALK_PACE } from '../../constants.js';
import { t, type TranslationKey } from '../../i18n/index.js';
import type { Character } from '../../office/types.js';
import { CharacterState } from '../../office/types.js';
import type { ActivityDescription } from './activity.js';
import type { FatigueLook } from './fatigueState.js';
import { PHRASES } from './rules.js';

/** The ring's state, coloured by ACTIVITY_RING_COLORS (constants.ts). */
export type RingState = 'working' | 'waiting' | 'permission' | 'idle' | 'off' | 'neutral';

/** A sprite in props.json. */
export type PropId =
  | 'book'
  | 'keys'
  | 'paper'
  | 'magnifier'
  | 'flask'
  | 'hammer'
  | 'box'
  | 'globe'
  | 'link'
  | 'robot'
  | 'dumbbell'
  | 'hand'
  | 'lock'
  | 'mug'
  | 'gear';

export interface CharacterVisual {
  /** Head badge emoji. */
  icon: string;
  /** The activity in words: the tooltip and the badge's accessible name. */
  text: string;
  prop: PropId | null;
  ring: RingState;
  /** 피로도, once the character has reported its context (never for sub-agents). */
  fatigue?: FatigueLook | null;
  /** T-0036: the canvas draws the status icon above the head (false while a
   *  name label carries it instead). */
  headIcon?: boolean;
  /** A canvas speech bubble whose dots advance only while this visual is live. */
  thinkingDots?: boolean;
}

/**
 * T-0036: the small status icon above a character's head (or beside its name):
 * an animated zzz when idle, the activity emoji while working, "!" waiting for
 * an answer, a blinking lock for permission; nothing when off.
 */
export type StatusIcon = 'zzz' | 'alert' | 'lock' | 'activity';

export function statusIcon(ring: RingState): StatusIcon | null {
  if (ring === 'off') return null;
  if (ring === 'idle') return 'zzz';
  if (ring === 'waiting') return 'alert';
  if (ring === 'permission') return 'lock';
  return 'activity';
}

interface ClassVisual {
  prop: PropId | null;
  ring: RingState;
  /** Legend wording. */
  label: string;
}

/**
 * Every EZ class -> prop and ring. A null prop leaves the activity to the head
 * badge alone (classes the T-0026 prop list does not name).
 */
export const ACTIVITY_VISUALS: Readonly<Record<string, ClassVisual>> = {
  '📖': { prop: 'book', ring: 'working', label: 'activity.readVisual' },
  '✏️': { prop: 'keys', ring: 'working', label: 'activity.editVisual' },
  '📝': { prop: 'paper', ring: 'working', label: 'activity.writeVisual' },
  '🔎': { prop: 'magnifier', ring: 'working', label: 'activity.searchVisual' },
  '🧪': { prop: 'flask', ring: 'working', label: 'activity.testVisual' },
  '🔨': { prop: 'hammer', ring: 'working', label: 'activity.buildVisual' },
  '📥': { prop: 'box', ring: 'working', label: 'activity.installVisual' },
  '🌐': { prop: 'globe', ring: 'working', label: 'activity.webVisual' },
  '🤝': { prop: 'link', ring: 'working', label: 'activity.delegating' },
  '🤖': { prop: 'robot', ring: 'working', label: 'activity.delegatingCodex' },
  '🏋️': { prop: 'dumbbell', ring: 'working', label: 'activity.trainVisual' },
  '✋': { prop: 'hand', ring: 'waiting', label: 'activity.waitingForYou' },
  '🔐': { prop: 'lock', ring: 'permission', label: 'activity.waitingApproval' },
  '☕': { prop: 'mug', ring: 'idle', label: 'activity.resting' },
  '🤔': { prop: null, ring: 'working', label: 'activity.thinking' },
  '⚙️': { prop: 'gear', ring: 'working', label: 'activity.otherWork' },
  '🗒️': { prop: null, ring: 'working', label: 'activity.planning' },
  '💬': { prop: null, ring: 'working', label: 'activity.messagingPeer' },
  '📚': { prop: null, ring: 'working', label: 'activity.instructionVisual' },
  '⏰': { prop: null, ring: 'working', label: 'activity.waitVisual' },
  '⏳': { prop: null, ring: 'working', label: 'activity.jobVisual' },
  '📦': { prop: null, ring: 'working', label: 'activity.commitVisual' },
  '🌿': { prop: null, ring: 'working', label: 'activity.checkingHistory' },
  '🔌': { prop: null, ring: 'working', label: 'activity.remoteAccess' },
  '🐳': { prop: null, ring: 'working', label: 'activity.containerWork' },
  '🌡️': { prop: null, ring: 'working', label: 'activity.checkingHardware' },
  '💻': { prop: null, ring: 'working', label: 'activity.commandVisual' },
};

/** The ring states in words, for the legend and screen readers. */
export const RING_WORDS: Readonly<Record<RingState, string>> = {
  working: 'activity.working',
  waiting: 'activity.waitingAnswer',
  permission: 'activity.permissionRequired',
  idle: 'activity.resting',
  off: 'activity.off',
  neutral: 'activity.unknownWork',
};

export const ringWord = (ring: RingState): string => t(RING_WORDS[ring] as TranslationKey);

/** A character's visual: off wins; an unknown class falls back to ⚙️ with a neutral ring. */
export function characterVisual(activity: ActivityDescription, off = false): CharacterVisual {
  if (off) return { icon: '💤', text: t('activity.off'), prop: null, ring: 'off' };
  const known = ACTIVITY_VISUALS[activity.emoji];
  return known
    ? {
        icon: activity.emoji,
        text: activity.text,
        prop: known.prop,
        ring: known.ring,
        thinkingDots: activity.emoji === PHRASES.thinking.emoji,
      }
    : { icon: '⚙️', text: activity.text, prop: 'gear', ring: 'neutral' };
}

// ToolOverlay works out each character's visual every frame (it has the tool
// rows); the canvas renderer reads it here. Nothing published: the office
// looks as upstream draws it (자세히 mode, or no cld office).
const published = new Map<number, CharacterVisual>();

export function publishCharacterVisual(id: number, visual: CharacterVisual | undefined): void {
  if (visual) published.set(id, visual);
  else published.delete(id);
}

export function characterVisualOf(id: number): CharacterVisual | undefined {
  return published.get(id);
}

// The ring of every character, the floor shown or not (`published` holds only the floor shown, for
// drawing). Who is at work is the office's own fact, never which floor this browser looks at.
const rings = new Map<number, RingState>();

export function publishCharacterRing(id: number, ring: RingState | undefined): void {
  if (ring) rings.set(id, ring);
  else rings.delete(id);
}

export function characterRingOf(id: number): RingState | undefined {
  return rings.get(id);
}

/** dt scale for the character FSM (officeState): a tired character walks slower. */
export function cldWalkPace(ch: Character): number {
  return ch.state === CharacterState.WALK && published.get(ch.id)?.fatigue?.sweat
    ? FATIGUE_WALK_PACE
    : 1;
}

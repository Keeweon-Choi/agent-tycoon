import { beforeEach, describe, expect, it } from 'vitest';

import {
  ACTIVITY_RING_COLORS,
  FATIGUE_WALK_PACE,
  FATIGUE_YAWN_EVERY_SEC,
  FATIGUE_YAWN_SEC,
  THINKING_DOT_COLOR,
  THINKING_DOT_FRAME_SEC,
} from '../../constants.js';
import { setLanguage } from '../../i18n/index.js';
import { BUBBLE_THINKING_SPRITES } from '../../office/sprites/spriteData.js';
import type { Character } from '../../office/types.js';
import { CharacterState } from '../../office/types.js';
import { type ActivityInput, describeActivity } from './activity.js';
import { cldDrawSpeechLinks, EFFECT_SPRITES, thinkingFrame, yawnFrame } from './drawVisuals.js';
import { fatigueLook } from './fatigueState.js';
import propData from './props.json';
import { COMMAND_RULES, PHRASES, TOOL_RULES } from './rules.js';

beforeEach(() => setLanguage('ko'));
import {
  ACTIVITY_VISUALS,
  characterVisual,
  cldWalkPace,
  type PropId,
  publishCharacterVisual,
  RING_WORDS,
  type RingState,
} from './visuals.js';

const bash = (command: string): ActivityInput => ({ toolName: 'Bash', command });
const visualOf = (input: ActivityInput) => characterVisual(describeActivity(input));

// The T-0026 prop list: activity -> its prop and ring.
const SPEC: Array<[string, ActivityInput, PropId | null, RingState]> = [
  ['📖 reading', { toolName: 'Read' }, 'book', 'working'],
  ['✏️ editing', { toolName: 'Edit' }, 'keys', 'working'],
  ['📝 writing', { toolName: 'Write' }, 'paper', 'working'],
  ['🔎 searching', { toolName: 'Grep' }, 'magnifier', 'working'],
  ['🧪 tests', bash('npm test'), 'flask', 'working'],
  ['🔨 build', bash('npm run build'), 'hammer', 'working'],
  ['📥 install', bash('npm install'), 'box', 'working'],
  ['🌐 web', { toolName: 'WebFetch' }, 'globe', 'working'],
  ['🤝 subagent', { toolName: 'Task' }, 'link', 'working'],
  ['🤖 Codex', bash('codex exec fix'), 'robot', 'working'],
  ['🏋️ training', bash('python3 train.py'), 'dumbbell', 'working'],
  ['✋ waiting', { waitingInput: true }, 'hand', 'waiting'],
  ['🔐 permission', { permission: true }, 'lock', 'permission'],
  ['☕ idle', { idle: true }, 'mug', 'idle'],
  ['🤔 thinking (busy, no tool)', { idle: true, busy: true }, null, 'working'],
];

// Every phrase the EZ rules can produce: the built-in tables, the fixed states.
const EVERY_PHRASE: Array<{ emoji: string; text: string }> = [
  ...TOOL_RULES,
  ...COMMAND_RULES,
  ...Object.values(PHRASES),
];

describe('activity visuals', () => {
  it.each(SPEC)('%s', (_name, input, prop, ring) => {
    const visual = visualOf(input);
    expect(visual.prop).toBe(prop);
    expect(visual.ring).toBe(ring);
  });

  it('gives each listed activity its own prop', () => {
    const props = SPEC.map(([, input]) => visualOf(input).prop);
    expect(new Set(props).size).toBe(SPEC.length);
    expect(props).not.toContain('gear');
  });

  it.each(EVERY_PHRASE.map((p) => [`${p.emoji} ${p.text}`, p] as const))(
    'maps the EZ phrase %s',
    (_name, phrase) => {
      expect(ACTIVITY_VISUALS[phrase.emoji], phrase.emoji).toBeDefined();
      const visual = characterVisual(phrase);
      expect(visual.icon).toBe(phrase.emoji);
      expect(visual.text).toBe(phrase.text);
      expect(visual.ring).not.toBe('neutral');
    },
  );

  it('falls back to ⚙️ with a neutral ring for an unknown activity', () => {
    const visual = characterVisual({ emoji: '🦄', text: '\uc0c8 \uaddc\uce59' });
    expect(visual).toEqual({
      icon: '⚙️',
      text: '\uc0c8 \uaddc\uce59',
      prop: 'gear',
      ring: 'neutral',
    });
  });

  it('marks only a live thinking activity for the animated dot bubble', () => {
    expect(visualOf({ idle: true, busy: true }).thinkingDots).toBe(true);
    expect(visualOf({ toolName: 'Read' }).thinkingDots).toBe(false);
    expect(
      BUBBLE_THINKING_SPRITES.map(
        (frame) => frame.flat().filter((p) => p === THINKING_DOT_COLOR).length,
      ),
    ).toEqual([0, 1, 2, 3]);
  });

  it('the thinking bubble widens with its dots and keeps its tail on the anchor column', () => {
    expect(BUBBLE_THINKING_SPRITES.map((frame) => frame[0].length)).toEqual([5, 7, 9, 11]);
    for (const frame of BUBBLE_THINKING_SPRITES) {
      expect(frame).toHaveLength(13);
      const mid = Math.floor(frame[0].length / 2);
      expect(frame[11][mid]).not.toBe(''); // the tail's tip
      expect(frame[10].filter((p) => p !== '')).toHaveLength(3);
      expect(frame[3].every((p) => p !== '')).toBe(true); // a closed outline
      expect(frame[0].every((p) => p === '')).toBe(true);
    }
    // The dots sit one pixel apart inside the body.
    const columns = BUBBLE_THINKING_SPRITES[3][6].flatMap((p, col) => (p === THINKING_DOT_COLOR ? [col] : []));
    expect(columns).toEqual([3, 5, 7]);
  });

  it('shows an off character as off, whatever it last did', () => {
    expect(characterVisual(describeActivity({ toolName: 'Read' }), true)).toEqual({
      icon: '💤',
      text: '\uaebc\uc838 \uc788\uc74c',
      prop: null,
      ring: 'off',
    });
  });

  it('never relies on colour alone: each ring state has its own words and icon or prop', () => {
    const states: RingState[] = ['working', 'waiting', 'permission', 'idle', 'off', 'neutral'];
    expect(new Set(states.map((state) => RING_WORDS[state])).size).toBe(states.length);
    for (const state of states) expect(ACTIVITY_RING_COLORS[state].rim).toMatch(/^#/);
    const marks = [
      visualOf({ toolName: 'Read' }),
      visualOf({ waitingInput: true }),
      visualOf({ permission: true }),
      visualOf({ idle: true }),
      characterVisual({ emoji: '📖', text: '' }, true),
      characterVisual({ emoji: '🦄', text: '' }),
    ].map(({ icon, prop }) => `${icon}:${prop}`);
    expect(new Set(marks).size).toBe(states.length);
  });

  it('has a 16x16 sprite on the shared palette for every prop', () => {
    const props = propData.props as Record<string, { at: number[]; frames: string[][] }>;
    const used = new Set(Object.values(ACTIVITY_VISUALS).map((visual) => visual.prop));
    used.delete(null);
    used.add('gear');
    for (const prop of used) {
      const sprite = props[prop as string];
      expect(sprite, prop as string).toBeDefined();
      expect(sprite.at).toHaveLength(2);
      for (const frame of sprite.frames) {
        expect(frame).toHaveLength(16);
        for (const row of frame) {
          expect(row).toHaveLength(16);
          for (const key of row) if (key !== '.') expect(propData.palette).toHaveProperty(key);
        }
      }
    }
    expect(Object.keys(props).sort()).toEqual([...used].sort());
  });

  it('draws the effects on the same palette, every frame the same size', () => {
    const effects = propData.effects as Record<string, { at: number[]; frames: string[][] }>;
    expect(Object.keys(effects).sort()).toEqual(['sweat', 'yawn', 'zz']);
    for (const [name, { at, frames }] of Object.entries(effects)) {
      expect(at, name).toHaveLength(2);
      for (const frame of frames) {
        expect(frame).toHaveLength(frames[0].length);
        for (const row of frame) {
          expect(row).toHaveLength(frames[0][0].length);
          for (const key of row) if (key !== '.') expect(propData.palette).toHaveProperty(key);
        }
      }
    }
  });
});

describe('the tired look', () => {
  const walker = (id: number, state: CharacterState = CharacterState.WALK) =>
    ({ id, state }) as Character;
  const visual = (pct: number) => ({
    ...characterVisual({ emoji: '📖', text: '\uc790\ub8cc \uc77d\ub294 \uc911' }),
    fatigue: fatigueLook(pct, 0),
  });

  it('a tired character walks slower; sitting, idling or fresh ones do not change pace', () => {
    publishCharacterVisual(101, visual(75));
    publishCharacterVisual(102, visual(20));
    expect(cldWalkPace(walker(101))).toBe(FATIGUE_WALK_PACE);
    expect(cldWalkPace(walker(101, CharacterState.TYPE))).toBe(1);
    expect(cldWalkPace(walker(102))).toBe(1);
    expect(cldWalkPace(walker(103))).toBe(1); // nothing published: upstream's pace
    publishCharacterVisual(101, undefined);
    expect(cldWalkPace(walker(101))).toBe(1);
  });

  it('yawns now and then, through every frame', () => {
    const shown = Array.from({ length: 140 }, (_, i) => yawnFrame(i * 0.1));
    expect(shown.filter((f) => f).length / shown.length).toBeCloseTo(
      FATIGUE_YAWN_SEC / FATIGUE_YAWN_EVERY_SEC,
      1,
    );
    expect(new Set(shown.filter((f) => f))).toEqual(new Set(EFFECT_SPRITES.yawn.frames));
  });
});

describe('the 🤝 dotted line (U-26)', () => {
  const link = { icon: '🤝', text: '', prop: 'link', ring: 'working' } as const;
  const lead = { id: 1, x: 40, y: 40, state: CharacterState.IDLE } as Character;
  const sub = { id: -1, x: 100, y: 100, isSubagent: true, parentAgentId: 1 } as Character;
  const dots = (characters: Character[]) => {
    let n = 0;
    const ctx = {
      fillRect: () => n++,
      set fillStyle(_v: string) {},
    } as unknown as CanvasRenderingContext2D;
    cldDrawSpeechLinks(ctx, characters, 0, 0, 1);
    return n;
  };
  it('draws for a working lead and its sub, never for one gone home or off', () => {
    publishCharacterVisual(1, { ...link });
    expect(dots([lead, sub])).toBeGreaterThan(0);
    expect(dots([{ ...lead, cldAway: true } as Character, sub])).toBe(0);
    expect(dots([lead, { ...sub, cldAway: true } as Character])).toBe(0);
    publishCharacterVisual(1, { ...link, ring: 'off' });
    expect(dots([lead, sub])).toBe(0);
    publishCharacterVisual(1, undefined);
  });
});

describe('thinkingFrame (the dots go 0, 1, 2, 3, then round again)', () => {
  it('steps one dot per frame and never skips', () => {
    const step = THINKING_DOT_FRAME_SEC;
    const seen = Array.from({ length: 9 }, (_, i) => thinkingFrame(i * step + step / 2));
    expect(seen).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0]);
  });
  it('holds a frame for its whole step', () => {
    expect(thinkingFrame(0)).toBe(0);
    expect(thinkingFrame(THINKING_DOT_FRAME_SEC - 0.001)).toBe(0);
    expect(thinkingFrame(THINKING_DOT_FRAME_SEC)).toBe(1);
  });
});

/** CHAR-HUMAN: v1/v2 looks whose composed sheets must stay pixel-identical (hashes in lookHashes.json). */
import type { CharacterChoice } from '../../../core/src/messages.js';

/* eslint-disable pixel-agents/no-inline-colors -- stored look colours */
export const LOOK_SAMPLES: CharacterChoice[] = [
  { palette: 0 },
  { palette: 2, hueShift: 45 },
  { palette: 5, hueShift: 300 },
  { v: 2, kind: 'humanoid', base: 0 },
  { v: 2, kind: 'humanoid', base: 1, hue: 90 },
  { v: 2, kind: 'humanoid', base: 3, acc: ['glasses', 'cap'] },
  {
    v: 2,
    kind: 'humanoid',
    base: 4,
    colors: {
      skin: '#9a6040',
      hair: '#b5452f',
      top: '#27ae60',
      bottom: '#2b2b2b',
      shoes: '#e8e8e8',
    },
    acc: ['headset'],
  },
  { v: 2, kind: 'humanoid', base: 2, colors: { top: '#8e44ad' }, acc: ['glasses'] },
  { v: 2, kind: 'mascot', species: 'coral' },
  { v: 2, kind: 'mascot', species: 'byte', color: '#8fd050', expr: 'sleepy', gear: 'crown' },
  { v: 2, kind: 'mascot', species: 'tori', expr: 'happy', gear: 'headset' },
];

import { describe, expect, it } from 'vitest';

import { parseSavedCamera } from './savedCamera.js';

describe('parseSavedCamera', () => {
  it('reads a saved view back', () => {
    const cam = { zoom: 3, pan: { x: -12.5, y: 40 } };
    expect(parseSavedCamera(JSON.stringify(cam))).toEqual(cam);
  });
  it('refuses missing, malformed and out-of-range values', () => {
    for (const raw of [
      null,
      'nope',
      '{}',
      '{"zoom":2.5,"pan":{"x":0,"y":0}}',
      '{"zoom":999,"pan":{"x":0,"y":0}}',
      '{"zoom":3,"pan":{"x":"a","y":0}}',
      '{"zoom":3}',
    ])
      expect(parseSavedCamera(raw)).toBeNull();
  });
});

describe('parseSavedCamera (GFX)', () => {
  it('keeps the manual mark, and reads an older save as framed', () => {
    expect(parseSavedCamera('{"zoom":3,"pan":{"x":1,"y":2},"manual":true}')?.manual).toBe(true);
    expect(parseSavedCamera('{"zoom":3,"pan":{"x":1,"y":2}}')?.manual).toBeUndefined();
    expect(
      parseSavedCamera('{"zoom":3,"pan":{"x":1,"y":2},"manual":"yes"}')?.manual,
    ).toBeUndefined();
  });
});

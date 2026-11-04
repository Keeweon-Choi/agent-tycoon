import { describe, expect, it } from 'vitest';

import { createPlacer } from '../office/components/overlayPlacer.js';
import { overlayProjection } from '../office/projection.js';
import type { Character } from '../office/types.js';

const el = () => ({ style: {} as Record<string, string> }) as unknown as HTMLElement;
const ch = (x: number, y: number) => ({ id: 7, x, y }) as unknown as Character;
const layout = { cols: 10, rows: 10 };
const frame = (zoom: number, pan = { x: 0, y: 0 }, dpr = 1) =>
  overlayProjection(layout, { width: 800, height: 600 }, zoom, pan, dpr);

describe('overlayPlacer', () => {
  it('places an element where the projection puts its character, and moves it with the frame', () => {
    const p = createPlacer();
    const c = ch(32, 48);
    const e = el();
    const at = (zoom: number) => frame(zoom).toScreenX(32);
    p.frame(frame(2), layout, 1);
    p.bind('7:a', c, (pr) => ({ x: pr.toScreenX(c.x), y: pr.toScreenY(c.y - 10) }))(e);
    const first = frame(2);
    expect(e.style.transform).toBe(`translate(${first.toScreenX(32)}px,${first.toScreenY(38)}px)`);
    // a new zoom + pan on the next canvas frame: the same element, no re-render
    p.frame(frame(3, { x: 10, y: -4 }), layout, 1);
    p.run();
    const next = frame(3, { x: 10, y: -4 });
    expect(e.style.transform).toBe(`translate(${next.toScreenX(32)}px,${next.toScreenY(38)}px)`);
    expect(at(3)).not.toBe(at(2));
  });

  it('snaps to the device pixel grid like the paint of left/top did', () => {
    const p = createPlacer();
    const c = ch(1.3, 2.7);
    const e = el();
    p.frame(frame(1, { x: 0, y: 0 }, 2), layout, 2);
    p.bind('7:a', c, () => ({ x: 10.3, y: 4.8 }))(e);
    expect(e.style.transform).toBe('translate(10.5px,5px)');
  });

  it('writes opacity only when given, and skips unchanged writes', () => {
    const p = createPlacer();
    const c = ch(0, 0);
    const e = el();
    let o: number | undefined = 0.5;
    p.frame(frame(1), layout, 1);
    p.bind('7:a', c, () => ({ x: 1, y: 2, opacity: o }))(e);
    expect(e.style.opacity).toBe('0.5');
    o = undefined;
    e.style.opacity = '1';
    p.run();
    expect(e.style.opacity).toBe('1');
  });

  it('forgets an unmounted element', () => {
    const p = createPlacer();
    const c = ch(0, 0);
    const e = el();
    p.frame(frame(1), layout, 1);
    const ref = p.bind('7:a', c, () => ({ x: 1, y: 2 }));
    ref(e);
    ref(null);
    e.style.transform = '';
    p.run();
    expect(e.style.transform).toBe('');
  });
});

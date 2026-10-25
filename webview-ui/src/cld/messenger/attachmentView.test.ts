import { describe, expect, it, vi } from 'vitest';

import {
  canInlineText,
  canOfferFileActions,
  clampPan,
  clampScale,
  doubleTapScale,
  fitScale,
  fitView,
  isDoubleTap,
  isViewerTap,
  isZoomed,
  linkedFileProblem,
  nearestImagePoint,
  opensInline,
  pinchView,
  readTextPreview,
  sizeLabel,
  stepIndex,
  swipeStep,
  tapZoomView,
  wheelFactor,
  zoomAround,
  zoomLabel,
} from './attachmentView.js';

const vp = { w: 400, h: 800 };
const img = { w: 1600, h: 1200 };
const fit = fitScale(img, vp, 0); // 0.25

describe('fit', () => {
  it('shows a big image whole and never enlarges a small one', () => {
    expect(fit).toBe(0.25);
    expect(fitScale({ w: 100, h: 50 }, vp, 0)).toBe(1);
    expect(fitScale({ w: 0, h: 0 }, vp)).toBe(1);
  });
  it('clamps the scale between fit and the maximum', () => {
    expect(clampScale(0.01, fit)).toBe(fit);
    expect(clampScale(50, fit)).toBe(8);
    expect(clampScale(2, fit)).toBe(2);
  });
  it('knows zoomed from fitted', () => {
    expect(isZoomed(fit, fit)).toBe(false);
    expect(isZoomed(fit * 1.01, fit)).toBe(false);
    expect(isZoomed(fit * 1.5, fit)).toBe(true);
  });
});

describe('pan bounds', () => {
  it('keeps an axis the image does not fill centred', () => {
    expect(clampPan({ scale: fit, x: 90, y: -90 }, img, vp)).toEqual({ scale: fit, x: 0, y: 0 });
  });
  it('lets an overfilled axis slide until the edge meets the viewport', () => {
    // 1600 * 0.5 = 800 wide in a 400 viewport: 200 either way; 1200 * .5 = 600 high in 800: centred.
    expect(clampPan({ scale: 0.5, x: 999, y: 999 }, img, vp)).toEqual({ scale: 0.5, x: 200, y: 0 });
    expect(clampPan({ scale: 0.5, x: -999, y: 5 }, img, vp)).toEqual({ scale: 0.5, x: -200, y: 0 });
  });
});

describe('zoom around a point', () => {
  it('keeps the image point under the pointer where it was', () => {
    const start = { scale: 1, x: 0, y: 0 };
    const at = { x: 100, y: 50 };
    const view = zoomAround(start, 2, at, img, vp, fit);
    // The image point under `at` before: (at - pan) / scale; after must be the same.
    expect((at.x - view.x) / view.scale).toBeCloseTo((at.x - start.x) / start.scale);
    expect((at.y - view.y) / view.scale).toBeCloseTo((at.y - start.y) / start.scale);
    expect(view.scale).toBe(2);
  });
  it('zooming out to fit recentres', () => {
    const view = zoomAround({ scale: 1, x: 120, y: 40 }, 0.01, { x: 5, y: 5 }, img, vp, fit);
    expect(view).toEqual({ scale: fit, x: 0, y: 0 });
  });
  it('is clamped to the maximum', () => {
    expect(zoomAround({ scale: 4, x: 0, y: 0 }, 100, { x: 0, y: 0 }, img, vp, fit).scale).toBe(8);
  });
});

describe('click / tap zoom', () => {
  it('doubles fit and keeps an image point under the click', () => {
    const at = { x: 100, y: 50 };
    const start = { scale: fit, x: 0, y: 0 };
    const view = tapZoomView(start, at, img, fit);
    expect(view.scale).toBe(fit * 2);
    expect((at.x - view.x) / view.scale).toBeCloseTo((at.x - start.x) / start.scale);
    expect((at.y - view.y) / view.scale).toBeCloseTo((at.y - start.y) / start.scale);
    expect(tapZoomView(view, at, img, fit)).toEqual(fitView(fit));
  });
  it('uses the nearest image edge for a click in the fitted margin', () => {
    const start = { scale: fit, x: 0, y: 0 };
    const outside = { x: 280, y: 50 };
    const anchor = nearestImagePoint(outside, start, img);
    const view = tapZoomView(start, outside, img, fit);
    expect(anchor).toEqual({ x: 200, y: 50 });
    expect((anchor.x - view.x) / view.scale).toBeCloseTo((anchor.x - start.x) / start.scale);
    expect((anchor.y - view.y) / view.scale).toBeCloseTo((anchor.y - start.y) / start.scale);
  });
  it('never exceeds the 800% zoom clamp', () => {
    expect(tapZoomView(fitView(8), { x: 0, y: 0 }, img, 8).scale).toBe(8);
  });
  it('distinguishes a click from a drag with the shared tap slop', () => {
    expect(isViewerTap(4, 3)).toBe(true);
    expect(isViewerTap(20, 0)).toBe(false);
  });
});

describe('pinch', () => {
  it('scales with the finger distance around the midpoint', () => {
    const start = { scale: 1, x: 0, y: 0 };
    const view = pinchView(start, { x: 10, y: 0 }, 100, { x: 10, y: 0 }, 200, img, vp, fit);
    expect(view.scale).toBe(2);
    expect((10 - view.x) / 2).toBeCloseTo(10); // the point under the fingers stayed
  });
  it('moving both fingers pans', () => {
    const start = { scale: 1, x: 0, y: 0 };
    const view = pinchView(start, { x: 0, y: 0 }, 100, { x: 30, y: 0 }, 100, img, vp, fit);
    expect(view).toEqual({ scale: 1, x: 30, y: 0 });
  });
  it('ignores a zero starting distance', () => {
    const start = { scale: 1, x: 3, y: 4 };
    expect(pinchView(start, { x: 0, y: 0 }, 0, { x: 0, y: 0 }, 50, img, vp, fit)).toBe(start);
  });
});

describe('double tap', () => {
  it('cycles fit, 100%, fit', () => {
    expect(doubleTapScale(fit, fit)).toBe(1);
    expect(doubleTapScale(1, fit)).toBe(fit);
    expect(doubleTapScale(3, fit)).toBe(fit);
  });
  it('an image already at 100% when fitted goes to 200%', () => {
    expect(doubleTapScale(1, 1)).toBe(2);
  });
  it('needs two taps close in time and place', () => {
    const a = { at: 1000, x: 10, y: 10 };
    expect(isDoubleTap(null, a)).toBe(false);
    expect(isDoubleTap(a, { at: 1200, x: 20, y: 12 })).toBe(true);
    expect(isDoubleTap(a, { at: 1500, x: 10, y: 10 })).toBe(false);
    expect(isDoubleTap(a, { at: 1100, x: 200, y: 10 })).toBe(false);
  });
});

describe('prev / next', () => {
  it('wraps round both ways', () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(1, 1, 3)).toBe(2);
  });
  it('has nowhere to go with nothing loaded', () => {
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
  it('a swipe must be long and mostly horizontal', () => {
    expect(swipeStep(-100, 10)).toBe(1);
    expect(swipeStep(100, 10)).toBe(-1);
    expect(swipeStep(-20, 0)).toBe(0);
    expect(swipeStep(-100, 90)).toBe(0);
  });
});

describe('new tab', () => {
  it('only for what the server previews inline', () => {
    expect(opensInline('application/pdf')).toBe(true);
    expect(opensInline('text/html')).toBe(true);
    expect(opensInline('text/plain')).toBe(false);
    expect(opensInline('application/zip')).toBe(false);
  });
});

describe('linked files', () => {
  it('withholds actions until a linked file receives a ticket', () => {
    expect(canOfferFileActions(true, true, '')).toBe(false);
    expect(canOfferFileActions(true, false, 'missing')).toBe(false);
    expect(canOfferFileActions(true, false, '')).toBe(true);
    expect(canOfferFileActions(false, false, 'missing')).toBe(true);
  });
  it('uses the localized missing-file state for a ticket 404 and preserves other reasons', () => {
    expect(linkedFileProblem(Object.assign(new Error('generic'), { status: 404 }))).toEqual({
      missing: true,
      reason: '',
    });
    expect(linkedFileProblem(new Error('forbidden'))).toEqual({
      missing: false,
      reason: 'forbidden',
    });
  });
});

describe('text preview', () => {
  it('only previews supported text files up to 200 KB', () => {
    expect(canInlineText('source.ts', 200 * 1024)).toBe(true);
    expect(canInlineText('source.ts', 200 * 1024 + 1)).toBe(false);
    expect(canInlineText('notes.md', 12)).toBe(true);
    expect(canInlineText('archive.zip', 12)).toBe(false);
  });
  it('refuses and cancels a response whose Content-Length exceeds the cap', async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      body: { cancel },
      headers: new Headers({ 'content-length': String(200 * 1024 + 1) }),
    } as unknown as Response;
    await expect(readTextPreview(response, 'source.ts')).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('refuses a response that exceeds the cap when Content-Length is absent', async () => {
    const response = new Response('x'.repeat(200 * 1024 + 1));
    await expect(readTextPreview(response, 'source.ts')).resolves.toBeNull();
  });
});

describe('labels and wheel', () => {
  it('rounds the zoom to a percent', () => {
    expect(zoomLabel(1.25)).toBe('125%');
    expect(zoomLabel(0.3333)).toBe('33%');
  });
  it('sizes in KB then MB', () => {
    expect(sizeLabel(12)).toBe('12 KB');
    expect(sizeLabel(2048)).toBe('2.0 MB');
  });
  it('the wheel zooms in on up, out on down, symmetrically', () => {
    expect(wheelFactor(-100, 0, 0.002)).toBeGreaterThan(1);
    expect(wheelFactor(100, 0, 0.002)).toBeLessThan(1);
    expect(wheelFactor(-100, 0, 0.002) * wheelFactor(100, 0, 0.002)).toBeCloseTo(1);
    expect(wheelFactor(-3, 1, 0.002)).toBeCloseTo(wheelFactor(-48, 0, 0.002));
  });
});

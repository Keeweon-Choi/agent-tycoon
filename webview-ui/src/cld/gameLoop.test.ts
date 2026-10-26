import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A fake browser for startGameLoop: 60 Hz rAF stamps driven by hand, an
 *  IntersectionObserver the test triggers, and a clock that follows the stamps. */
function fakeBrowser() {
  let now = 0;
  let queue: Array<(t: number) => void> = [];
  let io: ((entries: Array<{ intersectionRatio: number }>) => void) | null = null;
  const listeners = () => ({ addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('document', { hidden: false, ...listeners() });
  vi.stubGlobal('window', listeners());
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => queue.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: typeof io) {
        io = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  return {
    /** Run `n` vsyncs of a `hz` screen. */
    tick(n = 1, hz = 60) {
      for (let i = 0; i < n; i++) {
        now += 1000 / hz;
        const run = queue;
        queue = [];
        for (const cb of run) cb(now);
      }
    },
    visible(ratio: number) {
      io!([{ intersectionRatio: ratio }]);
    },
  };
}

const canvas = {
  getContext: () => ({ imageSmoothingEnabled: false }),
  parentElement: null,
} as unknown as HTMLCanvasElement;

describe('startGameLoop (T-0075)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  async function start() {
    const browser = fakeBrowser();
    const { startGameLoop, wakeOffice, setOfficeCovered } = await import('../office/engine/gameLoop.js');
    const dts: number[] = [];
    let renders = 0;
    let busy = false;
    const stop = startGameLoop(canvas, {
      update: (dt) => dts.push(dt),
      render: () => renders++,
      busy: () => busy,
    });
    browser.tick(120); // two seconds: whatever settles, settles
    return {
      browser,
      wakeOffice,
      setOfficeCovered,
      stop,
      dts,
      renders: () => renders,
      setBusy: (b: boolean) => (busy = b),
      /** Tick until a frame was drawn: the next idle one is a whole interval away. */
      afterRender() {
        const n = renders;
        while (renders === n) browser.tick(1);
      },
    };
  }

  it('idle: renders at the idle rate', async () => {
    const loop = await start();
    const before = loop.renders();
    loop.browser.tick(60);
    expect(loop.renders() - before).toBeLessThanOrEqual(11);
    loop.stop();
  });

  it('returns to the idle rate after warming finishes', async () => {
    const loop = await start();
    const { warmOnce, warmPending } = await import('../office/sprites/smoothSprite.js');
    warmOnce({}, 1, () => [() => undefined]);
    loop.browser.tick(2);
    expect(warmPending()).toBe(0);
    const before = loop.renders();
    loop.browser.tick(60);
    expect(loop.renders() - before).toBeLessThanOrEqual(11);
    loop.stop();
  });

  it('the first update after input covers one frame, not the idle interval', async () => {
    const loop = await start();
    loop.afterRender();
    loop.browser.tick(3); // part way into an idle interval
    const n = loop.dts.length;
    loop.wakeOffice();
    loop.browser.tick(1);
    // A walk or a glide that the input starts must not jump by the time the
    // office spent idle (up to 1/OFFICE_IDLE_FPS s).
    expect(loop.dts.slice(n).every((dt) => dt <= 1 / 60 + 1e-6)).toBe(true);
    expect(loop.dts.length).toBeGreaterThan(n);
    loop.stop();
  });

  it('motion that starts without input (a server event) renders on the next frame', async () => {
    const loop = await start();
    loop.afterRender();
    const before = loop.renders();
    loop.setBusy(true);
    loop.browser.tick(2);
    expect(loop.renders() - before).toBeGreaterThanOrEqual(1);
    loop.stop();
  });

  it('input on a fast screen keeps the 60 fps cap (pointer moves come every vsync)', async () => {
    const loop = await start();
    const before = loop.renders();
    for (let i = 0; i < 240; i++) {
      loop.wakeOffice();
      loop.browser.tick(1, 240);
    }
    expect(loop.renders() - before).toBeLessThanOrEqual(61);
    expect(loop.renders() - before).toBeGreaterThanOrEqual(55);
    loop.stop();
  });

  it('off screen: nothing is drawn, but the world keeps time (the cards read it)', async () => {
    const loop = await start();
    loop.browser.visible(0);
    const renders = loop.renders();
    const updates = loop.dts.length;
    loop.browser.tick(60);
    expect(loop.renders()).toBe(renders);
    const time = loop.dts.slice(updates).reduce((s, dt) => s + dt, 0);
    expect(time).toBeGreaterThan(0.9);
    loop.browser.visible(1);
    loop.browser.tick(2);
    expect(loop.renders()).toBeGreaterThan(renders);
    loop.stop();
  });

  it('covered by a phone page: nothing is drawn, the world keeps time, and it draws again once uncovered', async () => {
    const loop = await start();
    loop.setOfficeCovered(true);
    const renders = loop.renders();
    const updates = loop.dts.length;
    loop.browser.tick(60);
    expect(loop.renders()).toBe(renders);
    expect(loop.dts.length).toBeGreaterThan(updates);
    loop.setOfficeCovered(false);
    loop.browser.tick(2);
    expect(loop.renders()).toBeGreaterThan(renders);
    loop.stop();
  });
});

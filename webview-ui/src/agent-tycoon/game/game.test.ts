// GAME-UI-0: the game parts (Led, LedLegend, HudCounter, SegBar, Stamp) and the game effects switch.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { setLanguage } from '../../i18n/index.js';
import { ko } from '../../i18n/ko.js';
import { gameEffects, gameMotion, reloadGameMotion, setGameEffects } from './gameMotion.js';
import { DataText, HudCounter, Led, LedLegend, SegBar, Stamp } from './parts.js';

const html = (el: ReactElement) => renderToStaticMarkup(el);
beforeAll(() => setLanguage('ko'));

describe('Led', () => {
  it('draws on and half with an inner light, off without one; its word and reason are its name and title', () => {
    const on = html(createElement(Led, { state: 'on' }));
    expect(on).toContain('data-led="on"');
    expect(on).toContain('role="img"');
    expect(on).toContain(`aria-label="${ko['game.led.on']}"`);
    expect(on.match(/<span/g)).toHaveLength(2);
    const half = html(createElement(Led, { state: 'half', reason: 'T-5 tests' }));
    expect(half).toContain('data-led="half"');
    expect(half.match(/<span/g)).toHaveLength(2); // two spans, no gradient
    expect(half).not.toContain('gradient');
    expect(half).toContain(`aria-label="${ko['game.led.half']}: T-5 tests"`);
    expect(half).toContain(`title="${ko['game.led.half']}: T-5 tests"`);
    const off = html(createElement(Led, { state: 'off' }));
    expect(off).toContain(`aria-label="${ko['game.led.off']}"`);
    expect(off.match(/<span/g)).toHaveLength(1);
  });

  it('the legend uses the mock wording', () => {
    expect([ko['game.led.on'], ko['game.legend.halfShort'], ko['game.led.off']]).toEqual(['\uD655\uC778\uD568', '\uBCF4\uACE0\uB9CC \u00B7 \uC544\uC9C1 \uC9C1\uC811 \uBABB \uBD04', '\uC5C6\uC74C']);
    const line = html(createElement(LedLegend, { compact: true }));
    for (const k of ['game.led.on', 'game.legend.halfShort', 'game.led.off'] as const) expect(line).toContain(ko[k]);
    const full = html(createElement(LedLegend, {})).replace(/<span class="game-data">([^<]*)<\/span>/g, '$1');
    for (const k of ['game.legend.title', 'game.led.on', 'game.led.half', 'game.led.off', 'game.legend.on', 'game.legend.half', 'game.legend.off'] as const) expect(full).toContain(ko[k]);
    expect(full.match(/data-led=/g)).toHaveLength(3);
  });
});

describe('HudCounter', () => {
  it('dims 0 and an unknown value, not the others', () => {
    expect(html(createElement(HudCounter, { label: 'a', value: 0 }))).toContain('data-zero="true"');
    expect(html(createElement(HudCounter, { label: 'a', value: undefined }))).toContain('data-zero="true"');
    const one = html(createElement(HudCounter, { label: 'a', value: 3, icon: 'bell' }));
    expect(one).not.toContain('data-zero');
    expect(one).toContain('data-icon="bell"');
  });

  it('is a named button with onClick, a plain box without', () => {
    const onClick = vi.fn();
    const el = HudCounter({ label: 'Blocked', value: 2, onClick, testId: 'x' });
    expect(isValidElement(el) && el.type).toBe('button');
    const props = (el as ReactElement<{ onClick: () => void; 'aria-label': string; 'data-count': number }>).props;
    expect([props['aria-label'], props['data-count']]).toEqual(['Blocked 2', 2]);
    props.onClick();
    expect(onClick).toHaveBeenCalledOnce();
    expect(HudCounter({ label: 'Blocked', value: 2 }).type).toBe('div');
    expect(HudCounter({ label: 'Blocked', value: undefined, onClick }).type).toBe('div'); // nothing to open yet
    expect(html(createElement(HudCounter, { label: 'W', value: 1, active: true, onClick }))).toContain('data-active="true"');
  });
});

describe('SegBar and Stamp', () => {
  it('lights ceil(value / max) of the segments', () => {
    const bar = html(createElement(SegBar, { value: 2, max: 272 }));
    expect(bar).toContain('data-lit="1"');
    expect(bar.match(/<i/g)).toHaveLength(24);
    expect(html(createElement(SegBar, { value: 9, max: 8, segments: 4 }))).toContain('data-lit="4"');
    expect(html(createElement(SegBar, { value: 0, max: 0 }))).toContain('data-lit="0"');
  });
  it('marks one cell (where a failed job stopped)', () => {
    const bar = html(createElement(SegBar, { value: 2, max: 10, segments: 10, mark: 2 }));
    expect(bar.match(/data-mark/g)).toHaveLength(1);
    expect(bar).toMatch(/<i data-mark="true"><\/i>/);
  });
  it('DataText puts the ASCII runs in the data face', () => {
    expect(html(createElement(DataText, { text: 'T-5\uAC00 exit 0' })).match(/class="game-data"/g)).toHaveLength(3);
  });
  it('a stamp carries its tone', () => {
    expect(html(createElement(Stamp, { tone: 'gold', sub: '11.03', children: 'OK' }))).toContain('data-tone="gold"');
  });
});

describe('game effects (gameMotion)', () => {
  const store = new Map<string, string>();
  const stub = (reduce: boolean) => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    vi.stubGlobal('matchMedia', () => ({ matches: reduce, addEventListener: () => {} }));
    vi.stubGlobal('document', { documentElement: { dataset: {} as Record<string, string> } });
    reloadGameMotion();
  };
  const attr = () => (document.documentElement.dataset as Record<string, string>).gameMotion;
  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it('is on by default; off, or reduced motion on the device, turns every animation off', () => {
    stub(false);
    expect([gameEffects(), gameMotion(), attr()]).toEqual([true, true, 'on']);
    setGameEffects(false);
    expect([gameEffects(), gameMotion(), attr(), store.get('agty.game-effects')]).toEqual([false, false, 'off', 'off']);
    setGameEffects(true);
    stub(true); // the device asks for reduced motion
    expect([gameEffects(), gameMotion(), attr()]).toEqual([true, false, 'off']);
  });

  it('game.css animates only under :root[data-game-motion=on]', () => {
    const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'game.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, , body]) => /\banimation\b/.test(body));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector] of rules) for (const s of selector.split(',')) expect(s.trim()).toMatch(/^:root\[data-game-motion='on'\] /);
  });
});

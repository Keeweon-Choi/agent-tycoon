import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NAMEPLATE_SIZES, STAT_SUMMARY_BAR_PX } from '../../constants.js';
import { FatigueBar } from './Fatigue.js';
import { fatigueLook } from './fatigueState.js';

const look = fatigueLook(72, 1, undefined, 2, 'estimated');
const html = (barPx?: number) =>
  renderToStaticMarkup(createElement(FatigueBar, { look, compact: NAMEPLATE_SIZES.medium, barPx }));

describe('the nameplate fatigue row: at rest and opened', () => {
  it('at rest is the label, a fixed-length bar and the rests (T-67), no percent', () => {
    const rest = html();
    expect(rest).toContain('data-slim');
    expect(rest).not.toContain('fatigue-pct');
    const label = rest.indexOf('data-testid="fatigue-label"');
    const bar = rest.indexOf(`width:${NAMEPLATE_SIZES.medium.bar}px`);
    const rests = rest.indexOf('data-testid="compaction-text"');
    expect(label).toBeGreaterThan(-1);
    expect(bar).toBeGreaterThan(label);
    expect(rests).toBeGreaterThan(bar);
    expect(rest).toContain('width:72%');
  });

  it('at rest the bar is one length whatever the value', () => {
    const other = renderToStaticMarkup(
      createElement(FatigueBar, { look: fatigueLook(5, 0, undefined, null, 'reported'), compact: NAMEPLATE_SIZES.medium }),
    );
    expect(other).toContain(`width:${NAMEPLATE_SIZES.medium.bar}px`);
  });

  it('at rest keeps the meter value (percent and compactions) for readers', () => {
    const rest = html();
    expect(rest).toContain('role="meter"');
    expect(rest).toContain('aria-valuenow="72"');
    expect(rest).toContain('aria-valuetext=');
    expect(rest).toContain('data-tone=');
  });

  it('opened shows the percent (≈ when estimated) and the compactions beside the bar', () => {
    const open = html(STAT_SUMMARY_BAR_PX);
    expect(open).not.toContain('data-slim');
    expect(open).toContain('data-testid="fatigue-pct"');
    expect(open).toContain('≈72%');
    expect(open).toContain('data-testid="compaction-text"');
  });
});

// STALE-CLI (T-82): the band, the card mark and the usage line show only for a session the daemon
// found older than the installed CLI (`cliUpdate`); the band's one button follows the wait.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineProject, EngineState } from '../../../../core/src/messages.js';

let StaleCliBand: typeof import('./StaleCliBand.js').StaleCliBand;
let EngineNotes: typeof import('../EngineControls.js').EngineNotes;
let staleSessions: typeof import('../engine.js').staleSessions;
let engineHandleMessage: typeof import('../engineStore.js').engineHandleMessage;
let engineResetForTests: typeof import('../engineStore.js').engineResetForTests;
let agtyHandleMessage: typeof import('../officeStore.js').agtyHandleMessage;
let agtyResetForTests: typeof import('../officeStore.js').agtyResetForTests;
let setLanguage: typeof import('../../i18n/index.js').setLanguage;

beforeAll(async () => {
  vi.stubGlobal('window', {
    location: { protocol: 'http:', host: 'localhost', search: '?agtyMock=1' },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  ({ StaleCliBand } = await import('./StaleCliBand.js'));
  ({ EngineNotes } = await import('../EngineControls.js'));
  ({ staleSessions } = await import('../engine.js'));
  ({ engineHandleMessage, engineResetForTests } = await import('../engineStore.js'));
  ({ agtyHandleMessage, agtyResetForTests } = await import('../officeStore.js'));
  ({ setLanguage } = await import('../../i18n/index.js'));
});

const project = (o: Partial<EngineProject> = {}): EngineProject => ({
  name: 'alpha',
  folder: '/w/alpha',
  room: 'alpha',
  wantRunning: true,
  live: true,
  bgId: 'bg1',
  ...o,
});
const OLD = { cli: 'claude', running: '2.1.319', installed: '2.1.322', waitMin: 45 };
const state = (...projects: EngineProject[]): EngineState => ({ type: 'engineState', projects });

beforeEach(() => {
  engineResetForTests();
  agtyResetForTests();
  setLanguage('en');
  agtyHandleMessage({ type: 'officeSnapshot', readOnly: false, tabs: [], orchestrators: [] });
  agtyHandleMessage({ type: 'officeAccess', readOnly: false });
});

const band = () => renderToStaticMarkup(createElement(StaleCliBand, { name: 'alpha' }));
const notes = (p: EngineProject) => renderToStaticMarkup(createElement(EngineNotes, { project: p }));

describe('STALE-CLI: shown only for an older running session', () => {
  it('the same or an unknown version: no band, no mark, no usage line', () => {
    const p = project();
    engineHandleMessage(state(p));
    expect(band()).toBe('');
    expect(notes(p)).not.toContain('stale-cli-mark');
    expect(staleSessions(state(p), 'claude')).toBeNull();
  });

  it('older: the band with its versions and one Restart, the card mark, the usage line', () => {
    const p = project({ cliUpdate: OLD });
    engineHandleMessage(state(p, project({ name: 'beta', cliUpdate: { ...OLD, running: '2.1.300' } }), project({ name: 'gamma' })));
    const html = band();
    expect(html).toContain('Update installed · restart for the new version (2.1.319 → 2.1.322)');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('>Restart<');
    expect(html).toContain('waits up to 45 minutes'); // the button's title: the daemon's limit
    expect(notes(p)).toContain('2.1.319 → 2.1.322');
    expect(staleSessions(engineStateNow(), 'claude')).toEqual({ count: 2, version: '2.1.300, 2.1.319' });
    expect(staleSessions(engineStateNow(), 'codex')).toBeNull();
  });

  it('waiting: says so and offers Cancel; past the limit: says it did not restart and offers Restart again', () => {
    engineHandleMessage(state(project({ cliUpdate: OLD, restartWhenIdle: 'waiting' })));
    expect(band()).toContain('waiting');
    expect(band()).toContain('>Cancel<');
    engineHandleMessage(state(project({ cliUpdate: OLD, restartWhenIdle: 'timedOut' })));
    expect(band()).toContain('Still working after 45 minutes, so it did not restart'); // the daemon's limit, not a typed one
    expect(band()).toContain('>Restart<');
  });

  it('a viewer that may not act sees the band without its button', () => {
    agtyHandleMessage({ type: 'officeAccess', readOnly: true });
    engineHandleMessage(state(project({ cliUpdate: OLD })));
    expect(band()).toContain('2.1.319 → 2.1.322');
    expect(band()).not.toContain('<button');
  });
});

let engineStateNow: () => EngineState;
beforeAll(async () => {
  const { engineGetSnapshot } = await import('../engineStore.js');
  engineStateNow = () => engineGetSnapshot().state!;
});

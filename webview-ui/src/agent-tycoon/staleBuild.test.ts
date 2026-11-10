import { describe, expect, it } from 'vitest';

import {
  busyForStaleBuild,
  isStale,
  ownBuild,
  reloadDecision,
  requestStaleRecheck,
  shouldRecheckStaleBuild,
  staleBuildBannerMessage,
  subscribeStaleRecheck,
  typingForStaleBuild,
} from './staleBuild.js';

describe('ownBuild', () => {
  it('normalizes the module script source from a document-like object', () => {
    const doc = {
      querySelector: (selector: string) => {
        expect(selector).toBe('script[type="module"]');
        return { getAttribute: (name: string) => (name === 'src' ? './assets/index-ABC.js' : null) };
      },
    };

    expect(ownBuild(doc)).toBe('assets/index-ABC.js');
  });

  it('returns undefined without a module source', () => {
    expect(ownBuild({ querySelector: () => null })).toBeUndefined();
  });
});

describe('isStale', () => {
  it.each([
    ['matching builds', 'assets/index-A.js', 'assets/index-A.js', false],
    ['a newer server build', 'assets/index-A.js', 'assets/index-B.js', true],
    ['an unknown page build', undefined, 'assets/index-B.js', false],
    ['an unknown server build', 'assets/index-A.js', undefined, false],
  ])('%s', (_name, own, server, expected) => {
    expect(isStale(own, server)).toBe(expected);
  });
});

describe('typingForStaleBuild', () => {
  it.each([
    ['a focused input with text', { tagName: 'INPUT', value: 'draft' }, true],
    ['a focused textarea with text', { tagName: 'TEXTAREA', value: 'draft' }, true],
    ['a focused contenteditable with text', { isContentEditable: true, textContent: 'draft' }, true],
    ['a focused empty input', { tagName: 'INPUT', value: '' }, false],
    ['a focused empty textarea', { tagName: 'TEXTAREA', value: '' }, false],
    ['a focused empty contenteditable', { isContentEditable: true, textContent: '' }, false],
    ['no focused field, even when a saved draft exists elsewhere', null, false],
  ])('%s', (_name, active, expected) => {
    expect(typingForStaleBuild(active)).toBe(expected);
  });
});

describe('shouldRecheckStaleBuild', () => {
  const field = { tagName: 'TEXTAREA', value: 'draft' };
  const emptyField = { tagName: 'TEXTAREA', value: '' };

  it.each([
    ['a text field loses focus', 'focusout', field, null, true],
    ['a text field blurs', 'blur', field, null, true],
    ['a focused field is cleared', 'input', emptyField, emptyField, true],
    ['a focused field still has text', 'input', field, field, false],
    ['a non-focused field changes', 'input', emptyField, field, false],
    ['a non-text control loses focus', 'focusout', { tagName: 'BUTTON' }, null, false],
  ] as const)('%s', (_name, event, target, active, expected) => {
    expect(shouldRecheckStaleBuild(event, target, active)).toBe(expected);
  });
});

describe('reloadDecision', () => {
  it.each([
    ['not stale', false, true, null, undefined, 'assets/index-B.js', 'none'],
    ['hidden', true, false, null, undefined, 'assets/index-B.js', 'none'],
    ['busy terminal', true, true, 'terminal', undefined, 'assets/index-B.js', 'banner'],
    ['already reloaded for this build', true, true, null, 'assets/index-B.js', 'assets/index-B.js', 'banner'],
    ['a different prior reload', true, true, null, 'assets/index-A.js', 'assets/index-B.js', 'reload'],
    ['ready to refresh', true, true, null, undefined, 'assets/index-B.js', 'reload'],
  ] as const)('%s', (_name, stale, visible, busy, reloadedFor, server, expected) => {
    expect(reloadDecision({ stale, visible, busy, reloadedFor, server })).toBe(expected);
  });
});

describe('busyForStaleBuild', () => {
  const idle = { typing: false, terminal: false, unsaved: false, dialog: false, upload: false };

  it.each([
    ['typing', { ...idle, typing: true }, 'typing'],
    ['terminal', { ...idle, terminal: true }, 'terminal'],
    ['unsaved editor', { ...idle, unsaved: true }, 'unsaved'],
    ['dialog', { ...idle, dialog: true }, 'dialog'],
    ['upload', { ...idle, upload: true }, 'upload'],
    ['nothing', idle, null],
  ])('%s', (_name, state, expected) => {
    expect(busyForStaleBuild(state)).toBe(expected);
  });
});

describe('requestStaleRecheck', () => {
  it('notifies active subscribers and stops after unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribeStaleRecheck(() => calls++);
    requestStaleRecheck();
    unsubscribe();
    requestStaleRecheck();
    expect(calls).toBe(1);
  });
});

describe('staleBuildBannerMessage', () => {
  it.each([
    ['already reloaded', 'assets/index-B.js', 'assets/index-B.js', 'typing', 'build.stale.reloaded'],
    ['a terminal wait', undefined, 'assets/index-B.js', 'terminal', 'build.stale.busy.terminal'],
    ['the generic message', undefined, 'assets/index-B.js', null, 'build.stale.message'],
  ] as const)('%s', (_name, reloadedFor, server, busy, expected) => {
    expect(staleBuildBannerMessage(reloadedFor, server, busy)).toBe(expected);
  });
});

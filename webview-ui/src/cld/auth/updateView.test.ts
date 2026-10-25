import { describe, expect, it } from 'vitest';

import {
  noticePhase,
  resultKey,
  showInstall,
  signatureLines,
  type UpdateView,
} from './updateView.js';

const view = (over: Partial<UpdateView> = {}): UpdateView => ({
  managed: true,
  current: '0.1.0',
  available: { version: '0.2.0', notes: null },
  signature: { canVerify: true, release: 'verified', officialKey: false, osCodeSigning: false },
  facts: { sessions: 1, jobs: 0, worktrees: 0, merging: false },
  canInstall: true,
  terminalOnly: false,
  command: 'agty update --from x',
  install: null,
  ...over,
});

describe('signatureLines', () => {
  it('keeps "this build can verify" apart from "this release is signed"; only a verified release gets the tick', () => {
    const lines = signatureLines(view().signature);
    expect(lines.map((l) => l.key)).toEqual([
      'update.sig.canVerify',
      'update.sig.verified',
      'update.sig.noOfficialKey',
      'update.sig.noOsSigning',
    ]);
    expect(lines.filter((l) => l.tick).map((l) => l.key)).toEqual(['update.sig.verified']);
  });
  it('an unverified release has no tick, however capable the build is', () => {
    const lines = signatureLines({
      canVerify: true,
      release: 'unknown',
      officialKey: false,
      osCodeSigning: false,
    });
    expect(lines.some((l) => l.tick)).toBe(false);
    expect(lines[1].key).toBe('update.sig.unknown');
  });
  it('the "no official key / no OS signing" notes go away only when the daemon says they exist', () => {
    const keys = signatureLines({
      canVerify: true,
      release: 'verified',
      officialKey: true,
      osCodeSigning: true,
    }).map((l) => l.key);
    expect(keys).toEqual(['update.sig.canVerify', 'update.sig.verified']);
  });
});

describe('noticePhase', () => {
  it('a newer version shows the notice; same or older (no available) shows nothing', () => {
    expect(noticePhase(view(), null)).toBe('notice');
    expect(noticePhase(view({ available: null }), null)).toBe('none');
    expect(noticePhase(null, null)).toBe('none');
    expect(noticePhase(view({ managed: false }), null)).toBe('none');
  });
  it('a running install is shown always; a finished one until it is dismissed', () => {
    const done = { state: 'done' as const, to: '0.2.0', message: '' };
    expect(noticePhase(view({ install: { ...done, state: 'running' } }), resultKey(done))).toBe(
      'result',
    );
    expect(noticePhase(view({ install: done, available: null }), null)).toBe('result');
    expect(noticePhase(view({ install: done, available: null }), resultKey(done))).toBe('none');
  });
});

describe('showInstall', () => {
  it('a read-only or terminal-only client sees no button', () => {
    expect(showInstall(view())).toBe(true);
    expect(showInstall(view({ canInstall: false }))).toBe(false);
  });
});

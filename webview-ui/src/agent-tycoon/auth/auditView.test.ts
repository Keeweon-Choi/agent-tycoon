import { describe, expect, it } from 'vitest';

import { en } from '../../i18n/en.js';
import { translate } from '../../i18n/index.js';
import { ko } from '../../i18n/ko.js';
import { type AuditRow, auditWhat, auditWho, mergeNewest } from './auditView.js';

const tEn = ((key, vars) => translate(key, vars, 'en')) as typeof import('../../i18n/index.js').t;

describe('O3 security record view', () => {
  it('says every kind the daemon writes, in both languages', () => {
    const rows: AuditRow[] = [
      { at: 1, kind: 'deviceRegistered', detail: 'new' },
      { at: 1, kind: 'deviceRegistered', detail: 'replaced' },
      { at: 1, kind: 'deviceRegistered', detail: 'passkey' },
      { at: 1, kind: 'deviceRegistered', detail: 'unknown' },
      { at: 1, kind: 'inviteCreated' },
      { at: 1, kind: 'inviteUsed', detail: 'short' },
      { at: 1, kind: 'inviteRefused', detail: 'expired' },
      { at: 1, kind: 'inviteRefused', detail: 'cancelled' },
      { at: 1, kind: 'loginCodeCreated', detail: 'link' },
      { at: 1, kind: 'loginCodeUsed', detail: 'link' },
      { at: 1, kind: 'loginCodeUsed', detail: 'move' },
      { at: 1, kind: 'moveCodeCreated', detail: 'auto' },
      { at: 1, kind: 'moveCodeCreated', detail: 'manual' },
      { at: 1, kind: 'moveRefused', detail: 'changed' },
      { at: 1, kind: 'handoffCodeCreated', detail: 'https://outside.example' },
      { at: 1, kind: 'approvalAnswered', detail: 'approved' },
      { at: 1, kind: 'approvalAnswered', detail: 'refused' },
      { at: 1, kind: 'deviceRevoked' },
      { at: 1, kind: 'revokeOthers', detail: 3 },
      { at: 1, kind: 'passkeyRemoved' },
      { at: 1, kind: 'passkeyRequired', detail: 'on' },
      { at: 1, kind: 'passkeyRequired', detail: 'off' },
      { at: 1, kind: 'stepUpPassed', detail: 'key' },
      { at: 1, kind: 'stepUpFailed', detail: 4 },
      { at: 1, kind: 'exposure', detail: 'tailscale funnel on' },
      { at: 1, kind: 'exposure', detail: 'lan off' },
      { at: 1, kind: 'connector', detail: 'local>direct' },
      { at: 1, kind: 'allowedHosts', detail: 2 },
      { at: 1, kind: 'tokenRotated', detail: 'host' },
      { at: 1, kind: 'tokenRotated', detail: 'path' },
      { at: 1, kind: 'lockout', detail: 'short' },
      { at: 1, kind: 'lockout', detail: 'direct' },
    ];
    const seen = new Set<string>();
    for (const row of rows) {
      const text = auditWhat(row, tEn);
      expect(text, row.kind).not.toBe(row.kind);
      expect(text).not.toMatch(/\{\w+\}/);
      seen.add(text);
      const korean = auditWhat(row, ((key, vars) => translate(key, vars, 'ko')) as typeof tEn);
      expect(korean).not.toBe(text);
    }
    expect(seen.size).toBe(rows.length);
    expect(auditWhat({ at: 1, kind: 'revokeOthers', detail: 3 }, tEn)).toContain('3');
    expect(auditWhat({ at: 1, kind: 'connector', detail: 'local>direct' }, tEn)).toBe(
      'Connection changed: this PC → direct internet',
    );
    expect(auditWhat({ at: 1, kind: 'somethingNew' }, tEn)).toBe('somethingNew');
  });

  it('names the device, the actor when it is someone else, and how it came in', () => {
    expect(
      auditWho(
        { at: 1, kind: 'deviceRevoked', device: { id: 'a', label: 'iPhone', kind: 'phone' }, by: 'Mac', via: 'lan', peer: '192.168.0.9' },
        tEn,
      ),
    ).toBe('iPhone · Phone · by Mac · LAN · 192.168.0.9');
    expect(auditWho({ at: 1, kind: 'x', device: { id: 'a', label: 'iPhone' }, by: 'iPhone', via: 'weird' }, tEn)).toBe(
      'iPhone · Outside',
    );
    expect(auditWho({ at: 1, kind: 'x', by: 'host', via: 'local' }, tEn)).toBe('by the host · This PC');
  });

  it('has the same keys in both languages', () => {
    const own = (o: Record<string, string>) => Object.keys(o).filter((k) => k.startsWith('auth.audit.')).sort();
    expect(own(ko as Record<string, string>)).toEqual(own(en as Record<string, string>));
  });

  it('puts new lines on top and keeps the pages already opened', () => {
    const row = (n: number): AuditRow => ({ at: n, kind: 'lockout', detail: n });
    const loaded = [row(5), row(4), row(3)];
    // Two lines were written since the record was 5 long.
    const merged = mergeNewest(loaded, 5, { lines: [row(7), row(6), row(5), row(4), row(3)], total: 7 });
    expect(merged.rows.map((r) => r.at)).toEqual([7, 6, 5, 4, 3]);
    expect(merged.since).toBe(7);
    expect(mergeNewest(loaded, 5, { lines: [row(5), row(4)], total: 5 }).rows).toEqual(loaded);
    // Nothing loaded yet, or numbers that do not add up: start from the page.
    expect(mergeNewest([], 0, { lines: [row(2)], total: 2 }).rows).toEqual([row(2)]);
    expect(mergeNewest(loaded, 9, { lines: [row(2)], total: 2 }).rows).toEqual([row(2)]);
  });
});

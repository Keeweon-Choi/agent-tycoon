import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { idAtStartPattern, idPattern, idPatternError, idSource } from '../../../../core/src/agent-tycoon/spec/ids.js';
import { idsOf, parseDoc } from '../tracking/docs.js';

const REPO = path.resolve(__dirname, '../../../..');
/** docs-check.mjs's REQUIREMENT. */
const DOCS_CHECK = /\b(?:(?:FR|NFR|IR)-[A-Z]{2,5}-\d{3}|CON-\d{3})\b/g;

describe('the display-ID grammar', () => {
  // The public export drops agent-tycoon/docs (release/exclude.txt): this reads the private tree's SRS.
  it.skipIf(!fs.existsSync(path.join(REPO, 'agent-tycoon/docs/requirements/SRS.md')))('reads every SRS id docs-check accepts, whole', () => {
    const srs = fs.readFileSync(path.join(REPO, 'agent-tycoon/docs/requirements/SRS.md'), 'utf-8');
    const ids = [...new Set(srs.match(DOCS_CHECK) ?? [])];
    expect(ids.length).toBeGreaterThan(100);
    const start = idAtStartPattern(false);
    expect(ids.filter((id) => start.exec(id)?.[0] !== id)).toEqual([]);
  });

  it('the shapes projects write, and not the words around them', () => {
    const all = (s: string, short = false) => s.match(idPattern(short)) ?? [];
    expect(all('see FR-OFC-001, NFR-PERF-008, T-0050, R-01, D-001, U-48 and T001')).toEqual([
      'FR-OFC-001', 'NFR-PERF-008', 'T-0050', 'R-01', 'D-001', 'U-48', 'T001',
    ]);
    expect(all('x-FR-1 FR-1a fr-1 2026-11-03')).toEqual([]);
    expect(all('D5 and C3a', false)).toEqual([]);
    expect(all('D5 and C3a', true)).toEqual(['D5', 'C3a']);
  });

  it('a project pattern is checked: short, compiles, no capture, lookaround or backreference, never empty', () => {
    expect(idPatternError('REQ\\d{3}')).toBeNull();
    expect(idPatternError('[A-Z]{2,4}_\\d{3,5}')).toBeNull();
    expect(idPatternError('(?:REQ|SPEC)_\\d+')).toBe('unsafe'); // two patterns instead
    expect(idPatternError('')).toBe('length');
    expect(idPatternError('A'.repeat(61))).toBe('length');
    expect(idPatternError(3)).toBe('type');
    expect(idPatternError('(a)')).toBe('syntax');
    expect(idPatternError('(?=a)')).toBe('syntax');
    expect(idPatternError('a\\1')).toBe('syntax');
    expect(idPatternError('[')).toBe('syntax');
    expect(idPatternError('a*')).toBe('empty');
    expect(idSource(false, ['[', 'REQ\\d{3}'])).toContain('REQ\\d{3}');
    expect(idSource(false, ['['])).not.toContain('[|');
    expect('REQ001'.match(idPattern(false, ['REQ\\d{3}']))).toEqual(['REQ001']);
  });

  it('the safe subset only: no group, alternation, unbounded or big repeat; a megabyte stays fast', () => {
    for (const evil of ['X(?:A+)+B', '(?:A|AA){1,9}B', 'A+B', 'A*B', '\\w{1,9}', '[^ ]{1,9}', 'A{1,99}', '\\d{1,9}\\d{1,9}\\d{1,9}', 'A.B'])
      expect([evil, idPatternError(evil)]).toEqual([evil, evil === 'A{1,99}' ? 'unsafe' : expect.stringMatching(/unsafe|syntax/)]);
    // The worst the subset allows, on 1 MB of text that nearly matches everywhere.
    const worst = '[A-Z0-9]{0,9}[A-Z0-9]{0,5}X';
    expect(idPatternError(worst)).toBeNull();
    const ids = idsOf(false, [worst]);
    for (const text of ['A'.repeat(1 << 20), 'AAAAAAAAAAAAAAAAAAAA '.repeat(50_000), `${'1-'.repeat(2_000)}\n`.repeat(250)]) {
      const t0 = performance.now();
      ids.all(text);
      expect(performance.now() - t0).toBeLessThan(500);
    }
    // The evil one, had it got in, would not reach a reader: idSource drops it.
    expect(idSource(false, ['X(?:A+)+B'])).not.toContain('A+');
  });

  it('fixes the old defect: an SRS table row FR-OFC-001 is an entry', () => {
    const d = parseDoc('| ID | 요구 | 상태 |\n|---|---|---|\n| FR-OFC-001 | 탭마다 방 | 완료 |\n', 'SRS.md', false);
    expect(d !== 'unreadable' && d.entries.map((e) => e.id)).toEqual(['FR-OFC-001']);
  });
});

import { describe, expect, it } from 'vitest';

import { tableRowLines } from './tableRow.js';

describe('SPT-P3-FINISH: tableRowLines', () => {
  it('turns header, separator and row into column/value pairs, skipping empty cells', () => {
    const text = '| ID | Requirement | Pri | Verify |\n|---|---|:-:|---|\n| FR-X-001 | Shows A | 4 |  |';
    expect(tableRowLines(text)).toEqual([
      { column: 'ID', value: 'FR-X-001' },
      { column: 'Requirement', value: 'Shows A' },
      { column: 'Pri', value: '4' },
    ]);
  });

  it('keeps an escaped pipe in its cell and turns <br> into a line break', () => {
    const text = '| ID | Text |\n| --- | --- |\n| A-1 | a \\| b<br>c |';
    expect(tableRowLines(text)).toEqual([
      { column: 'ID', value: 'A-1' },
      { column: 'Text', value: 'a | b\nc' },
    ]);
  });

  it('leaves everything else to the Markdown view', () => {
    expect(tableRowLines('## Heading\n\ntext')).toBeNull();
    expect(tableRowLines('| lone | row |')).toBeNull();
    expect(tableRowLines('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |')).toBeNull();
    expect(tableRowLines('| a | b |\n| x | y |\n| 1 | 2 |')).toBeNull();
    expect(tableRowLines('')).toBeNull();
  });
});

/**
 * Review notes as the text an agent receives (step 4 of the review loop).
 * Ported from Orca `src/shared/diff-comments-format.ts` (MIT); only the note
 * shape changed (our `file`/`line` fields, no markdown source).
 *
 * MIT License
 *
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export interface FormattableNote {
  file: string;
  /** New-side line; zero is a file-level note. */
  line: number;
  startLine?: number;
  body: string;
}

// Keep the pasted review-note contract deterministic and quote-safe across clients/agents.
export function formatDiffComment(c: FormattableNote): string {
  const escaped = c.body
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  const locationLabel =
    c.line === 0
      ? 'Scope: file'
      : c.startLine !== undefined && c.startLine !== c.line
        ? `Lines: ${c.startLine}-${c.line}`
        : `Line: ${c.line}`;
  return [`File: ${c.file}`, locationLabel, `User comment: "${escaped}"`].join('\n');
}

export function formatDiffComments(comments: readonly FormattableNote[]): string {
  return comments.map(formatDiffComment).join('\n\n');
}

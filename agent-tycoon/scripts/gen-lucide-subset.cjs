// FEAT-UI-MODERN-THEME: writes webview-ui/src/agent-tycoon/icons/lucide.ts, the Lucide subset as path data (no package).
// Unpack lucide-static (npm pack lucide-static@0.468.0) somewhere outside the repo, then:
//   node agent-tycoon/scripts/gen-lucide-subset.cjs <unpacked package dir> webview-ui/src/agent-tycoon/icons/lucide.ts <name...>
// with every name already in the file plus the new one (the list is the LUCIDE keys).
const fs = require('fs');
const [dir, out, ...names] = process.argv.slice(2);
const nodes = JSON.parse(fs.readFileSync(`${dir}/icon-nodes.json`, 'utf8'));
const version = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8')).version;
const uniq = [...new Set(names)].sort();
const missing = uniq.filter((n) => !nodes[n]);
if (missing.length) throw new Error('missing: ' + missing.join(' '));
const body = uniq
  .map((n) => {
    const parts = nodes[n].map(([tag, attrs]) => {
      const a = Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'key'));
      return `[${JSON.stringify(tag)}, ${JSON.stringify(a)}]`;
    });
    return `  ${JSON.stringify(n)}: [${parts.join(', ')}],`;
  })
  .join('\n');
fs.writeFileSync(
  out,
  `/**
 * FEAT-UI-MODERN-THEME: the outline icons of the 모던 style, a subset of Lucide ${version}
 * (https://lucide.dev, npm lucide-static ${version}, icon-nodes.json), as path data so no package is added.
 * Each icon is drawn on a 24 grid, stroke currentColor, 2 wide, round caps (agent-tycoon/icons/Icon.tsx).
 * Regenerate with agent-tycoon/scripts/gen-lucide-subset.cjs (every name below plus the new one).
 *
 * ISC License
 *
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All
 * other copyright (c) for Lucide are held by Lucide Contributors 2022.
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee
 * is hereby granted, provided that the above copyright notice and this permission notice appear in all
 * copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE
 * INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE
 * FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
 * ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
// prettier-ignore
export const LUCIDE = {
${body}
} as const satisfies Record<string, ReadonlyArray<readonly [string, Readonly<Record<string, string>>]>>;
export type LucideName = keyof typeof LUCIDE;
`,
);
console.log(uniq.length, 'icons');

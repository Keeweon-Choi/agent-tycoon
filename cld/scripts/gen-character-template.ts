/**
 * Regenerate webview-ui/src/cld/characters/template.generated.json from the
 * six built-in character sheets (T-0017; CH-5: one template per sheet). Run after
 * changing a char_N.png or REGIONS_BY_BASE:
 *
 *   npx tsx cld/scripts/gen-character-template.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { computeTemplate, regionCounts } from '../../webview-ui/src/cld/characters/template.js';

const root = path.resolve(__dirname, '../..');
const sheets = [0, 1, 2, 3, 4, 5].map((i) =>
  PNG.sync.read(
    fs.readFileSync(path.join(root, `webview-ui/public/assets/characters/char_${i}.png`)),
  ),
);
const templates = sheets.map((_, i) => computeTemplate(sheets, i));
const out = path.join(root, 'webview-ui/src/cld/characters/template.generated.json');
fs.writeFileSync(out, JSON.stringify(templates) + '\n');
templates.forEach((t, i) => console.log(`char_${i}: ${JSON.stringify(regionCounts(t))}`));
console.log(path.relative(root, out));

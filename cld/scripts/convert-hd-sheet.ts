/**
 * CHAR-FACTORY: an HD preset sheet (224×192, density 2) from a generator's labelled sheet of frame
 * boxes (server/src/cld/hdSheet.ts). Writes <outDir>/<id>.png and <id>.json ({label}); copy them
 * into ~/.config/cld-gui/characters/ to use the look. Prints what the source lacks.
 *
 *   npx tsx cld/scripts/convert-hd-sheet.ts <in.png> <outDir> <id> [--label <text>] [--mirror-side]
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { hdSheetFromBoxes } from '../../server/src/cld/hdSheet.js';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const label = option('--label');
const mirrorSide = args.includes('--mirror-side');
const [input, outDir, id] = args.filter((a) => a !== '--mirror-side');
if (!input || !outDir || !id || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id)) {
  console.error('usage: convert-hd-sheet.ts <in.png> <outDir> <id> [--label <text>] [--mirror-side]');
  process.exit(1);
}
const src = PNG.sync.read(fs.readFileSync(input));
const r = hdSheetFromBoxes(
  { width: src.width, height: src.height, data: src.data },
  { mirror: [false, false, mirrorSide] },
);
if ('error' in r) {
  console.error(r.error);
  process.exit(2);
}
const out = new PNG({ width: r.width, height: r.height });
out.data = Buffer.from(r.data);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${id}.png`), PNG.sync.write(out, { colorType: 6 }));
fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify({ label: label ?? id }, null, 2) + '\n');
console.log(`${id}.png ${r.width}x${r.height} from ${r.report.boxes} boxes`);
console.log(`frames (source box per frame, per row): ${JSON.stringify(r.report.frames)}`);
console.log(`not in the source, the standing frame stands in: ${r.report.missing.join(', ')}`);

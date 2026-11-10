// Agent Tycoon speech-bubble art (drawn 2026-11-04): writes the three 11x13 bubble JSONs the office reads
// (permission = amber padlock, waiting = green check, pet = heart). Hand-placed pixels, violet outline.
//   node agent-tycoon/scripts/gen-bubbles.cjs
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', '..', 'webview-ui', 'src', 'office', 'sprites');
const W = 11;
const H = 13;
const COMMON = { _: '', B: '#2b2340', F: '#f4efff', S: '#d3c8f4' }; // outline, fill, lower inner shade

// Body: corners cut, shade on the last inner row, a centred two-row tail (tip at column 5).
function bubble() {
  const g = Array.from({ length: H }, () => Array(W).fill('_'));
  for (let y = 0; y <= 9; y++)
    for (let x = 0; x < W; x++) {
      const edge = y === 0 || y === 9 || x === 0 || x === W - 1;
      const corner = (y === 0 || y === 9) && (x === 0 || x === W - 1);
      if (corner) continue;
      g[y][x] = edge ? 'B' : y === 8 ? 'S' : 'F';
    }
  g[9][5] = 'F';
  g[10][4] = 'B';
  g[10][5] = 'F';
  g[10][6] = 'B';
  g[11][5] = 'B';
  return g;
}
// art: rows from y0, '.' = leave, other chars = palette keys; x0 is the first column
function stamp(g, x0, y0, art) {
  art.forEach((row, dy) =>
    [...row].forEach((c, dx) => {
      if (c !== '.') g[y0 + dy][x0 + dx] = c;
    }),
  );
  return g;
}
function write(name, description, extraPalette, art, x0, y0) {
  const g = stamp(bubble(), x0, y0, art);
  const used = new Set(g.flat());
  const palette = Object.fromEntries(
    Object.entries({ ...COMMON, ...extraPalette }).filter(([k]) => used.has(k)),
  );
  const rows = g.map((r) => '    ' + JSON.stringify(r)).join(',\n');
  const json = `{\n  "name": "${name}",\n  "description": "${description}",\n  "width": ${W},\n  "height": ${H},\n  "palette": ${JSON.stringify(palette)},\n  "pixels": [\n${rows}\n  ]\n}\n`;
  fs.writeFileSync(path.join(OUT, `${name}.json`), json);
}

// Padlock: shackle J (dark amber), body A (amber), keyhole B
write(
  'bubble-permission',
  'Permission bubble: amber padlock on a violet-outlined bubble with a tail (11x13)',
  { J: '#a8680c', A: '#f0a91c' },
  ['.JJJ.', 'J...J', 'AAAAA', 'AABAA', 'AABAA', 'AAAAA'],
  3,
  2,
);
// Check: thick two-pixel stroke in green, darker on the long arm's edge
write(
  'bubble-waiting',
  'Waiting bubble: green check on a violet-outlined bubble with a tail (11x13)',
  { G: '#35c07a', D: '#1c8a55' },
  ['.....GD', '....GGD', 'G..GGD.', 'GGGGD..', '.GGD...', '..D....'],
  2,
  2,
);
// Heart: red, darker rim, one highlight
write(
  'bubble-pet',
  'Heart bubble: shown when a pet is petted (11x13)',
  { R: '#c2335a', H: '#ff6f91', L: '#ffd1dc' },
  ['.RR.RR.', 'RHLHHHR', 'RHHHHHR', '.RHHHR.', '..RHR..', '...R...'],
  2,
  2,
);

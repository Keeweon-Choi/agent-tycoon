/**
 * A TrueType file as WOFF2 with no table transforms (glyf/loca "null transform", version 3): every
 * table as it is, one Brotli stream. WebKit's WOFF2 decoder refuses Galmuri's own WOFF2 (its glyf
 * transform: FontFace.load() rejects with a NetworkError in Playwright's WebKit, while the same
 * release's TTF and Pretendard's transformed WOFF2 load), so 픽셀 감성's Hangul fell to the first
 * face's .notdef boxes. The untransformed file decodes everywhere and costs ~5% in size.
 *
 *   node scripts/woff2-untransformed.mjs <in.ttf> <out.woff2>
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const [src, out] = process.argv.slice(2);
const ttf = fs.readFileSync(src);
const n = ttf.readUInt16BE(4);
const tables = [];
for (let i = 0; i < n; i++) {
  const o = 12 + i * 16;
  tables.push({ tag: ttf.toString('latin1', o, o + 4), off: ttf.readUInt32BE(o + 8), len: ttf.readUInt32BE(o + 12) });
}
tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
// UIntBase128: 7 bits a byte, high bit on all but the last.
const base128 = (v) => {
  const a = [];
  do {
    a.unshift(v & 0x7f);
    v = Math.floor(v / 128);
  } while (v);
  return a.map((x, i) => (i < a.length - 1 ? x | 0x80 : x));
};
const directory = Buffer.from(
  tables.flatMap((t) => [
    ((t.tag === 'glyf' || t.tag === 'loca' ? 3 : 0) << 6) | 63, // transform version, an explicit tag
    ...Buffer.from(t.tag, 'latin1'),
    ...base128(t.len),
  ]),
);
const stream = Buffer.concat(tables.map((t) => ttf.subarray(t.off, t.off + t.len)));
const P = zlib.constants;
const packed = zlib.brotliCompressSync(stream, {
  params: { [P.BROTLI_PARAM_QUALITY]: 11, [P.BROTLI_PARAM_LGWIN]: 24, [P.BROTLI_PARAM_MODE]: P.BROTLI_MODE_FONT, [P.BROTLI_PARAM_SIZE_HINT]: stream.length },
});
const body = Buffer.concat([Buffer.alloc(48), directory, packed]);
const file = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
file.write('wOF2', 0, 'latin1');
file.writeUInt32BE(ttf.readUInt32BE(0), 4); // flavor
file.writeUInt32BE(file.length, 8);
file.writeUInt16BE(n, 12);
file.writeUInt32BE(ttf.length, 16); // totalSfntSize
file.writeUInt32BE(packed.length, 20);
file.writeUInt16BE(1, 24); // version 1.0
fs.writeFileSync(out, file);
console.log(`${out}: ${file.length} bytes`);

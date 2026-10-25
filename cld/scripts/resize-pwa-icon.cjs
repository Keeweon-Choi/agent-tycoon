// Resize the app's 512px PWA icon with bilinear filtering (pngjs only).
const fs = require('node:fs');
const { PNG } = require('pngjs');

const [source, destination, sizeText] = process.argv.slice(2);
const size = Number(sizeText);
if (!source || !destination || !Number.isInteger(size) || size < 1) {
  throw new Error('Usage: node resize-pwa-icon.cjs input.png output.png size');
}
const input = PNG.sync.read(fs.readFileSync(source));
if (input.width !== input.height) throw new Error('Source icon must be square');
const output = new PNG({ width: size, height: size });
for (let y = 0; y < size; y++) {
  const sy = ((y + 0.5) * input.height) / size - 0.5;
  const y0 = Math.max(0, Math.floor(sy));
  const y1 = Math.min(input.height - 1, y0 + 1);
  const fy = Math.max(0, sy - y0);
  for (let x = 0; x < size; x++) {
    const sx = ((x + 0.5) * input.width) / size - 0.5;
    const x0 = Math.max(0, Math.floor(sx));
    const x1 = Math.min(input.width - 1, x0 + 1);
    const fx = Math.max(0, sx - x0);
    for (let c = 0; c < 4; c++) {
      const a = input.data[(y0 * input.width + x0) * 4 + c];
      const b = input.data[(y0 * input.width + x1) * 4 + c];
      const d = input.data[(y1 * input.width + x0) * 4 + c];
      const e = input.data[(y1 * input.width + x1) * 4 + c];
      output.data[(y * size + x) * 4 + c] = Math.round(
        (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy,
      );
    }
  }
}
fs.writeFileSync(destination, PNG.sync.write(output));

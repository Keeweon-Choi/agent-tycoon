#!/usr/bin/env node
// A QR code for a link, in terminal block characters (uqr, pinned in the repo's
// package.json). uqr draws the light modules, so it reads as dark-on-light on a
// dark terminal. Used by cld-gui-login --qr and the installer's last step.
import { renderUnicodeCompact } from 'uqr';

const text = process.argv[2];
if (!text) {
  console.error('usage: cld-gui-qr.mjs <link>');
  process.exit(2);
}
process.stdout.write(`${renderUnicodeCompact(text, { ecc: 'M', border: 2 })}\n`);

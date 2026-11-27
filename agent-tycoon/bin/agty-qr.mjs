#!/usr/bin/env node
// A QR code for a link, in terminal block characters (uqr, pinned in the repo's
// package.json). uqr draws the light modules, so it reads as dark-on-light on a
// dark terminal. Used by agty login --qr and the installer's last step.
import { renderUnicodeCompact } from 'uqr';

// The link comes on stdin, never argv: a process list shows argv to every local account.
const text = (
  await new Promise((resolve) => {
    let data = '';
    process.stdin
      .setEncoding('utf8')
      .on('data', (chunk) => (data += chunk))
      .on('end', () => resolve(data));
  })
).trim();
if (!text) {
  console.error('usage: printf %s <link> | agty-qr.mjs');
  process.exit(2);
}
process.stdout.write(`${renderUnicodeCompact(text, { ecc: 'M', border: 2 })}\n`);

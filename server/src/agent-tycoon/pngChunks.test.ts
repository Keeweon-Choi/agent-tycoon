import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import * as zlib from 'zlib';

import { importHeaderIssue, pngHeaderIssue } from '../../../core/src/agent-tycoon/sheetCheck.js';

// S3.1: pngjs decodes with the LAST IHDR it meets, the size checks read the first.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function ihdr(w: number, h: number, interlace = 0): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d[8] = 8;
  d[9] = 6;
  d[12] = interlace;
  return chunk('IHDR', d);
}

const idat = (w: number, h: number) =>
  chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 4 + 1) * h)));
const iend = () => chunk('IEND', Buffer.alloc(0));
const png = (...chunks: Buffer[]) => Buffer.concat([SIGNATURE, ...chunks]);

describe('PNG chunk order before decoding (S3.1)', () => {
  it('accepts a plain PNG', () => {
    const ok = png(ihdr(112, 96), idat(112, 96), iend());
    expect(pngHeaderIssue(ok, 112, 96)).toBeNull();
    expect(importHeaderIssue(ok)).toBeNull();
    expect(PNG.sync.read(ok).width).toBe(112);
  });

  it('refuses a second IHDR that hides a big image behind a small first one', () => {
    const bomb = png(ihdr(112, 96), ihdr(3000, 3000), idat(3000, 3000), iend());
    expect(pngHeaderIssue(bomb, 112, 96)).not.toBeNull();
    expect(importHeaderIssue(bomb)).not.toBeNull();
  });

  it('refuses a second IHDR that turns on interlacing', () => {
    const bomb = png(ihdr(112, 96), ihdr(112, 96, 1), idat(112, 96), iend());
    expect(pngHeaderIssue(bomb, 112, 96)?.code).toBe('notPng');
    expect(importHeaderIssue(bomb)?.code).toBe('notPng');
  });

  it('refuses IDAT chunks that are not consecutive and a PLTE after the data', () => {
    const body = zlib.deflateSync(Buffer.alloc((112 * 4 + 1) * 96));
    const half = body.length >> 1;
    const split = png(
      ihdr(112, 96),
      chunk('IDAT', body.subarray(0, half)),
      chunk('tEXt', Buffer.from('a\0b')),
      chunk('IDAT', body.subarray(half)),
      iend(),
    );
    expect(pngHeaderIssue(split, 112, 96)?.code).toBe('notPng');
    const late = png(ihdr(112, 96), idat(112, 96), chunk('PLTE', Buffer.alloc(3)), iend());
    expect(importHeaderIssue(late)?.code).toBe('notPng');
  });

  it('stops at IEND and lets a truncated tail alone (the decoder reports that)', () => {
    const ok = png(ihdr(112, 96), idat(112, 96), iend(), Buffer.from('trailing junk'));
    expect(pngHeaderIssue(ok, 112, 96)).toBeNull();
    const cut = png(ihdr(112, 96), idat(112, 96)).subarray(0, -5);
    expect(pngHeaderIssue(cut, 112, 96)).toBeNull();
  });
});

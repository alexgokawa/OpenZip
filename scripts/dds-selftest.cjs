'use strict';
// Usage: node scripts/dds-selftest.cjs  (lives in scripts/, needs ../dds-reader.cjs)
const assert = require('assert');
const path = require('path');
const { decodeDds } = require(path.join(__dirname, '..', 'dds-reader.cjs'));

function header(w, h, flags, fourCc, bits, masks) {
  const b = Buffer.alloc(128);
  b.writeUInt32LE(0x20534444, 0);
  b.writeUInt32LE(124, 4);
  b.writeUInt32LE(0x1007, 8);
  b.writeUInt32LE(h, 12);
  b.writeUInt32LE(w, 16);
  b.writeUInt32LE(32, 76);
  b.writeUInt32LE(flags, 80);
  if (fourCc) b.write(fourCc, 84, 'latin1');
  b.writeUInt32LE(bits || 0, 88);
  if (masks) masks.forEach((m, i) => b.writeUInt32LE(m >>> 0, 92 + i * 4));
  return b;
}

// BC1: solid red (0xF800), indices 0 -> every pixel = colour0
const bc1 = Buffer.alloc(8);
bc1.writeUInt16LE(0xf800, 0);
bc1.writeUInt16LE(0x0000, 2);
let r = decodeDds(Buffer.concat([header(4, 4, 4, 'DXT1'), bc1]));
assert.deepStrictEqual([...r.rgba.slice(0, 4)], [255, 0, 0, 255]);
assert.strictEqual(r.rgba.length, 4 * 4 * 4);

// BC3: solid green with alpha 128 (a0=a1=128, indices 0)
const bc3 = Buffer.alloc(16);
bc3[0] = 128; bc3[1] = 128;
bc3.writeUInt16LE(0x07e0, 8);
r = decodeDds(Buffer.concat([header(4, 4, 4, 'DXT5'), bc3]));
assert.deepStrictEqual([...r.rgba.slice(0, 4)], [0, 255, 0, 128]);

// BC2: explicit alpha nibble 0xF -> 255, blue
const bc2 = Buffer.alloc(16, 0xff);
bc2.writeUInt16LE(0x001f, 8);
bc2.writeUInt16LE(0x0000, 10);
bc2.writeUInt32LE(0, 12);
r = decodeDds(Buffer.concat([header(4, 4, 4, 'DXT3'), bc2]));
assert.deepStrictEqual([...r.rgba.slice(0, 4)], [0, 0, 255, 255]);

// Non-multiple-of-4 size (5x3) must not overflow: 2x1 blocks
const two = Buffer.concat([bc1, bc1]);
r = decodeDds(Buffer.concat([header(5, 3, 4, 'DXT1'), two]));
assert.strictEqual(r.rgba.length, 5 * 3 * 4);
assert.deepStrictEqual([...r.rgba.slice((2 * 5 + 4) * 4, (2 * 5 + 4) * 4 + 4)], [255, 0, 0, 255]);

// Uncompressed BGRA 2x1: pixel0 = R255 G0 B0 A200
const raw = Buffer.from([0, 0, 255, 200, 10, 20, 30, 255]);
r = decodeDds(Buffer.concat([header(2, 1, 0x41, null, 32, [0xff0000, 0xff00, 0xff, 0xff000000]), raw]));
assert.deepStrictEqual([...r.rgba.slice(0, 4)], [255, 0, 0, 200]);
assert.deepStrictEqual([...r.rgba.slice(4, 8)], [30, 20, 10, 255]);

// Errors
assert.throws(() => decodeDds(Buffer.alloc(10)), /valid DDS/);
assert.throws(() => decodeDds(Buffer.concat([header(4, 4, 4, 'DXT1'), Buffer.alloc(2)])), /truncated/);
assert.throws(() => decodeDds(header(4, 4, 4, 'XXXX')), /Unsupported/);

console.log('dds-reader self-test: all checks passed');

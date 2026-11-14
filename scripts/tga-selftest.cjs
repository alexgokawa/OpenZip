'use strict';
// Usage: node scripts/tga-selftest.cjs
const assert = require('assert');
const path = require('path');
const { decodeTga } = require(path.join(__dirname, '..', 'tga-reader.cjs'));

function hdr(type, w, h, bpp, desc, extra) {
  const b = Buffer.alloc(18);
  b[2] = type;
  b.writeUInt16LE(w, 12);
  b.writeUInt16LE(h, 14);
  b[16] = bpp;
  b[17] = desc;
  if (extra) extra(b);
  return b;
}

// 2x2 32-bit, bottom-left origin: rows stored bottom row first.
// bottom row: red, green ; top row: blue, white(alpha 128). BGRA order.
let px = Buffer.from([0,0,255,255, 0,255,0,255, 255,0,0,255, 255,255,255,128]);
let r = decodeTga(Buffer.concat([hdr(2, 2, 2, 32, 8), px]));
assert.deepStrictEqual([...r.rgba.slice(0, 4)], [0, 0, 255, 255]);      // top-left = blue
assert.deepStrictEqual([...r.rgba.slice(4, 8)], [255, 255, 255, 128]);  // top-right
assert.deepStrictEqual([...r.rgba.slice(8, 12)], [255, 0, 0, 255]);     // bottom-left = red

// Top-left origin 24-bit 2x1: pixel0 = (R10,G20,B30)
r = decodeTga(Buffer.concat([hdr(2, 2, 1, 24, 0x20), Buffer.from([30,20,10, 3,2,1])]));
assert.deepStrictEqual([...r.rgba.slice(0, 8)], [10, 20, 30, 255, 1, 2, 3, 255]);

// RLE 24-bit 4x1: one run of 3 identical + one raw pixel
const rle = Buffer.from([0x82, 0,0,255, 0x00, 9,8,7]);
r = decodeTga(Buffer.concat([hdr(10, 4, 1, 24, 0x20), rle]));
assert.deepStrictEqual([...r.rgba.slice(0, 4)], [255, 0, 0, 255]);
assert.deepStrictEqual([...r.rgba.slice(8, 12)], [255, 0, 0, 255]);
assert.deepStrictEqual([...r.rgba.slice(12, 16)], [7, 8, 9, 255]);

// Greyscale 8-bit 2x1
r = decodeTga(Buffer.concat([hdr(3, 2, 1, 8, 0x20), Buffer.from([0, 200])]));
assert.deepStrictEqual([...r.rgba.slice(4, 8)], [200, 200, 200, 255]);

// Colour-mapped 8-bit, 2-entry 24-bit palette
const cm = hdr(1, 2, 1, 8, 0x20, (b) => { b[1] = 1; b.writeUInt16LE(0, 3); b.writeUInt16LE(2, 5); b[7] = 24; });
r = decodeTga(Buffer.concat([cm, Buffer.from([0,0,255, 255,0,0]), Buffer.from([1, 0])]));
assert.deepStrictEqual([...r.rgba.slice(0, 4)], [0, 0, 255, 255]);
assert.deepStrictEqual([...r.rgba.slice(4, 8)], [255, 0, 0, 255]);

// Errors
assert.throws(() => decodeTga(Buffer.alloc(5)), /valid TGA/);
assert.throws(() => decodeTga(Buffer.concat([hdr(2, 4, 4, 24, 0), Buffer.alloc(3)])), /truncated/);
assert.throws(() => decodeTga(hdr(7, 2, 2, 24, 0)), /Unsupported/);

console.log('tga-reader self-test: all checks passed');

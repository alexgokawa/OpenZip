'use strict';

/**
 * Minimal TGA decoder for the OpenZip image viewer. No dependencies.
 * Supports types 1/9 (colour-mapped), 2/10 (true colour), 3/11 (greyscale),
 * RLE or raw, 8/15/16/24/32 bits per pixel, either vertical origin.
 */

const MAX_DIMENSION = 16384;

function decodeTga(data) {
  if (!Buffer.isBuffer(data) || data.length < 18) throw new Error('Not a valid TGA file.');

  const idLength = data[0];
  const mapType = data[1];
  const imageType = data[2];
  const mapStart = data.readUInt16LE(3);
  const mapLength = data.readUInt16LE(5);
  const mapBits = data[7];
  const width = data.readUInt16LE(12);
  const height = data.readUInt16LE(14);
  const bpp = data[16];
  const descriptor = data[17];

  const rle = imageType >= 9;
  const baseType = rle ? imageType - 8 : imageType;
  if (![1, 2, 3].includes(baseType)) throw new Error(`Unsupported TGA image type ${imageType}.`);
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`Unsupported TGA dimensions: ${width} × ${height}.`);
  }
  if (![8, 15, 16, 24, 32].includes(bpp)) throw new Error(`Unsupported TGA bit depth: ${bpp}.`);
  if (baseType === 1 && (mapType !== 1 || bpp !== 8)) throw new Error('Unsupported TGA colour map layout.');
  if (baseType === 3 && bpp !== 8 && bpp !== 16) throw new Error('Unsupported TGA greyscale depth.');

  let offset = 18 + idLength;

  // Colour map -> RGBA palette
  let palette = null;
  if (mapType === 1) {
    if (![15, 16, 24, 32].includes(mapBits)) throw new Error('Unsupported TGA colour map depth.');
    const entryBytes = Math.ceil(mapBits / 8);
    if (offset + mapLength * entryBytes > data.length) throw new Error('TGA file is truncated.');
    palette = new Array(mapStart + mapLength);
    for (let i = 0; i < mapLength; i += 1) {
      palette[mapStart + i] = readPixel(data, offset + i * entryBytes, mapBits);
    }
    offset += mapLength * entryBytes;
  }

  const bytesPerPixel = Math.ceil(bpp / 8);
  const pixelCount = width * height;
  const raw = Buffer.alloc(pixelCount * bytesPerPixel);

  if (rle) {
    let out = 0;
    while (out < raw.length) {
      if (offset >= data.length) throw new Error('TGA file is truncated.');
      const packet = data[offset++];
      const count = (packet & 0x7f) + 1;
      const bytes = count * bytesPerPixel;
      if (out + bytes > raw.length) throw new Error('TGA RLE data is corrupt.');
      if (packet & 0x80) {
        if (offset + bytesPerPixel > data.length) throw new Error('TGA file is truncated.');
        for (let i = 0; i < count; i += 1) {
          data.copy(raw, out + i * bytesPerPixel, offset, offset + bytesPerPixel);
        }
        offset += bytesPerPixel;
      } else {
        if (offset + bytes > data.length) throw new Error('TGA file is truncated.');
        data.copy(raw, out, offset, offset + bytes);
        offset += bytes;
      }
      out += bytes;
    }
  } else {
    if (offset + raw.length > data.length) throw new Error('TGA file is truncated.');
    data.copy(raw, 0, offset, offset + raw.length);
  }

  const rgba = Buffer.alloc(pixelCount * 4);
  const topToBottom = (descriptor & 0x20) !== 0;
  const rightToLeft = (descriptor & 0x10) !== 0;

  for (let y = 0; y < height; y += 1) {
    const dstY = topToBottom ? y : height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const dstX = rightToLeft ? width - 1 - x : x;
      const src = (y * width + x) * bytesPerPixel;
      let px;
      if (baseType === 1) {
        px = palette[raw[src]];
        if (!px) throw new Error('TGA colour map index out of range.');
      } else if (baseType === 3) {
        const l = raw[src];
        px = [l, l, l, bytesPerPixel === 2 ? raw[src + 1] : 255];
      } else {
        px = readPixel(raw, src, bpp);
      }
      const dst = (dstY * width + dstX) * 4;
      rgba[dst] = px[0];
      rgba[dst + 1] = px[1];
      rgba[dst + 2] = px[2];
      // 24-bit and 15/16-bit pixels are returned opaque by readPixel.
      rgba[dst + 3] = px[3];
    }
  }

  return { width, height, rgba, format: `TGA ${bpp}-bit${rle ? ' RLE' : ''}` };
}

function readPixel(buf, off, bits) {
  if (bits === 32) return [buf[off + 2], buf[off + 1], buf[off], buf[off + 3]];
  if (bits === 24) return [buf[off + 2], buf[off + 1], buf[off], 255];
  // 15/16-bit: A1R5G5B5. Treat as opaque when the alpha bit is never meaningful.
  const v = buf[off] | (buf[off + 1] << 8);
  const r = (v >> 10) & 31;
  const g = (v >> 5) & 31;
  const b = v & 31;
  return [(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2), 255];
}

module.exports = { decodeTga };

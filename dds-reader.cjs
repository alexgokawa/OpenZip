'use strict';

/**
 * Minimal DDS decoder for the OpenZip image viewer.
 * Decodes the top mip level to 8-bit RGBA. No dependencies.
 *
 * Supported: DXT1/DXT3/DXT5 (BC1/BC2/BC3), ATI1/BC4, ATI2/BC5, uncompressed
 * 16/24/32-bit RGB(A) via bit masks, and DX10 headers carrying the same formats.
 * Not supported (throws a clear error): BC6H, BC7, cubemap/volume layouts beyond face 0.
 */

const DDS_MAGIC = 0x20534444; // 'DDS '
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_LUMINANCE = 0x20000;

const MAX_DIMENSION = 16384;

function fourCcToString(value) {
  return String.fromCharCode(value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255);
}

function expand565(c) {
  const r = (c >> 11) & 31;
  const g = (c >> 5) & 63;
  const b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/** Decode one BC1 colour block into 16 RGBA pixels in `out` (16*4 bytes). */
function decodeColorBlock(data, off, out, forceOpaque) {
  const c0 = data.readUInt16LE(off);
  const c1 = data.readUInt16LE(off + 2);
  const bits = data.readUInt32LE(off + 4);
  const p0 = expand565(c0);
  const p1 = expand565(c1);
  const palette = [
    [p0[0], p0[1], p0[2], 255],
    [p1[0], p1[1], p1[2], 255],
    null,
    null,
  ];
  if (c0 > c1 || forceOpaque) {
    palette[2] = [
      Math.floor((2 * p0[0] + p1[0]) / 3),
      Math.floor((2 * p0[1] + p1[1]) / 3),
      Math.floor((2 * p0[2] + p1[2]) / 3),
      255,
    ];
    palette[3] = [
      Math.floor((p0[0] + 2 * p1[0]) / 3),
      Math.floor((p0[1] + 2 * p1[1]) / 3),
      Math.floor((p0[2] + 2 * p1[2]) / 3),
      255,
    ];
  } else {
    palette[2] = [(p0[0] + p1[0]) >> 1, (p0[1] + p1[1]) >> 1, (p0[2] + p1[2]) >> 1, 255];
    palette[3] = [0, 0, 0, 0];
  }
  for (let i = 0; i < 16; i += 1) {
    const color = palette[(bits >>> (i * 2)) & 3];
    out[i * 4] = color[0];
    out[i * 4 + 1] = color[1];
    out[i * 4 + 2] = color[2];
    out[i * 4 + 3] = color[3];
  }
}

/** Decode one BC3/BC4/BC5 single-channel block into 16 values. */
function decodeAlphaBlock(data, off, out) {
  const a0 = data[off];
  const a1 = data[off + 1];
  const table = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) {
    for (let i = 1; i <= 6; i += 1) table[i + 1] = Math.floor(((7 - i) * a0 + i * a1) / 7);
  } else {
    for (let i = 1; i <= 4; i += 1) table[i + 1] = Math.floor(((5 - i) * a0 + i * a1) / 5);
    table[6] = 0;
    table[7] = 255;
  }
  // 48 bits of 3-bit indices, little endian.
  const lo = data[off + 2] | (data[off + 3] << 8) | (data[off + 4] << 16);
  const hi = data[off + 5] | (data[off + 6] << 8) | (data[off + 7] << 16);
  for (let i = 0; i < 8; i += 1) out[i] = table[(lo >>> (i * 3)) & 7];
  for (let i = 0; i < 8; i += 1) out[i + 8] = table[(hi >>> (i * 3)) & 7];
}

function decodeBlockFormat(data, dataOffset, width, height, kind) {
  const rgba = Buffer.alloc(width * height * 4);
  const blocksX = Math.max(1, Math.ceil(width / 4));
  const blocksY = Math.max(1, Math.ceil(height / 4));
  const blockSize = kind === 'bc1' || kind === 'bc4' ? 8 : 16;
  if (dataOffset + blocksX * blocksY * blockSize > data.length) {
    throw new Error('DDS file is truncated.');
  }

  const px = new Uint8Array(64);
  const alpha = new Uint8Array(16);
  const alpha2 = new Uint8Array(16);

  let off = dataOffset;
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      if (kind === 'bc1') {
        decodeColorBlock(data, off, px, false);
      } else if (kind === 'bc2') {
        decodeColorBlock(data, off + 8, px, true);
        for (let i = 0; i < 16; i += 1) {
          const byte = data[off + (i >> 1)];
          const nibble = i & 1 ? byte >> 4 : byte & 15;
          px[i * 4 + 3] = nibble * 17;
        }
      } else if (kind === 'bc3') {
        decodeColorBlock(data, off + 8, px, true);
        decodeAlphaBlock(data, off, alpha);
        for (let i = 0; i < 16; i += 1) px[i * 4 + 3] = alpha[i];
      } else if (kind === 'bc4') {
        decodeAlphaBlock(data, off, alpha);
        for (let i = 0; i < 16; i += 1) {
          px[i * 4] = alpha[i];
          px[i * 4 + 1] = alpha[i];
          px[i * 4 + 2] = alpha[i];
          px[i * 4 + 3] = 255;
        }
      } else {
        // bc5: R and G channels, reconstruct Z for normal maps.
        decodeAlphaBlock(data, off, alpha);
        decodeAlphaBlock(data, off + 8, alpha2);
        for (let i = 0; i < 16; i += 1) {
          const x = (alpha[i] / 255) * 2 - 1;
          const y = (alpha2[i] / 255) * 2 - 1;
          const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
          px[i * 4] = alpha[i];
          px[i * 4 + 1] = alpha2[i];
          px[i * 4 + 2] = Math.round((z * 0.5 + 0.5) * 255);
          px[i * 4 + 3] = 255;
        }
      }

      for (let py = 0; py < 4; py += 1) {
        const y = by * 4 + py;
        if (y >= height) break;
        for (let pxIdx = 0; pxIdx < 4; pxIdx += 1) {
          const x = bx * 4 + pxIdx;
          if (x >= width) break;
          const src = (py * 4 + pxIdx) * 4;
          const dst = (y * width + x) * 4;
          rgba[dst] = px[src];
          rgba[dst + 1] = px[src + 1];
          rgba[dst + 2] = px[src + 2];
          rgba[dst + 3] = px[src + 3];
        }
      }
      off += blockSize;
    }
  }
  return rgba;
}

function maskShift(mask) {
  if (!mask) return { shift: 0, bits: 0 };
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift += 1;
  let bits = 0;
  while (((mask >>> (shift + bits)) & 1) === 1 && shift + bits < 32) bits += 1;
  return { shift, bits };
}

function extract(value, info) {
  if (!info.bits) return null;
  const raw = (value >>> info.shift) & ((2 ** info.bits) - 1);
  return info.bits === 8 ? raw : Math.round((raw * 255) / ((2 ** info.bits) - 1));
}

function decodeUncompressed(data, dataOffset, width, height, bitCount, masks, hasAlpha, luminance) {
  const bytesPer = bitCount / 8;
  if (![1, 2, 3, 4].includes(bytesPer)) throw new Error(`Unsupported DDS bit depth: ${bitCount}.`);
  if (dataOffset + width * height * bytesPer > data.length) throw new Error('DDS file is truncated.');

  const r = maskShift(masks.r);
  const g = maskShift(masks.g);
  const b = maskShift(masks.b);
  const a = maskShift(masks.a);
  const rgba = Buffer.alloc(width * height * 4);
  let off = dataOffset;
  for (let i = 0; i < width * height; i += 1) {
    let value = 0;
    for (let k = 0; k < bytesPer; k += 1) value += data[off + k] * 2 ** (8 * k);
    value >>>= 0;
    off += bytesPer;
    if (luminance) {
      const l = extract(value, r.bits ? r : { shift: 0, bits: bitCount >= 8 ? 8 : bitCount });
      rgba[i * 4] = l;
      rgba[i * 4 + 1] = l;
      rgba[i * 4 + 2] = l;
      rgba[i * 4 + 3] = hasAlpha ? extract(value, a) : 255;
    } else {
      rgba[i * 4] = extract(value, r) ?? 0;
      rgba[i * 4 + 1] = extract(value, g) ?? 0;
      rgba[i * 4 + 2] = extract(value, b) ?? 0;
      rgba[i * 4 + 3] = hasAlpha && a.bits ? extract(value, a) : 255;
    }
  }
  return rgba;
}

// DXGI formats we handle via the DX10 extension header.
const DXGI_BLOCK = {
  70: 'bc1', 71: 'bc1', 72: 'bc1',
  73: 'bc2', 74: 'bc2', 75: 'bc2',
  76: 'bc3', 77: 'bc3', 78: 'bc3',
  79: 'bc4', 80: 'bc4', 81: 'bc4',
  82: 'bc5', 83: 'bc5', 84: 'bc5',
};
const DXGI_RGBA8 = new Set([28, 29]);
const DXGI_BGRA8 = new Set([87, 91]);
const DXGI_BGRX8 = new Set([88, 93]);

/**
 * @param {Buffer} data whole .dds file
 * @returns {{ width: number, height: number, rgba: Buffer, format: string }}
 */
function decodeDds(data) {
  if (!Buffer.isBuffer(data) || data.length < 128) throw new Error('Not a valid DDS file.');
  if (data.readUInt32LE(0) !== DDS_MAGIC) throw new Error('Not a valid DDS file (bad magic).');
  if (data.readUInt32LE(4) !== 124) throw new Error('Not a valid DDS file (bad header size).');

  const height = data.readUInt32LE(12);
  const width = data.readUInt32LE(16);
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`Unsupported DDS dimensions: ${width} × ${height}.`);
  }

  const pfFlags = data.readUInt32LE(80);
  const fourCc = data.readUInt32LE(84);
  const bitCount = data.readUInt32LE(88);
  const masks = {
    r: data.readUInt32LE(92),
    g: data.readUInt32LE(96),
    b: data.readUInt32LE(100),
    a: data.readUInt32LE(104),
  };

  let dataOffset = 128;

  if (pfFlags & DDPF_FOURCC) {
    const cc = fourCcToString(fourCc);
    if (cc === 'DX10') {
      if (data.length < 148) throw new Error('DDS file is truncated.');
      const dxgi = data.readUInt32LE(128);
      dataOffset = 148;
      if (DXGI_BLOCK[dxgi]) {
        return { width, height, rgba: decodeBlockFormat(data, dataOffset, width, height, DXGI_BLOCK[dxgi]), format: `DXGI ${dxgi}` };
      }
      if (DXGI_RGBA8.has(dxgi)) {
        return { width, height, rgba: decodeUncompressed(data, dataOffset, width, height, 32, { r: 0xff, g: 0xff00, b: 0xff0000, a: 0xff000000 }, true, false), format: 'RGBA8' };
      }
      if (DXGI_BGRA8.has(dxgi) || DXGI_BGRX8.has(dxgi)) {
        return { width, height, rgba: decodeUncompressed(data, dataOffset, width, height, 32, { r: 0xff0000, g: 0xff00, b: 0xff, a: 0xff000000 }, DXGI_BGRA8.has(dxgi), false), format: 'BGRA8' };
      }
      if (dxgi === 94 || dxgi === 95 || dxgi === 96 || dxgi === 97 || dxgi === 98 || dxgi === 99) {
        throw new Error('BC6H/BC7 DDS textures are not supported yet.');
      }
      throw new Error(`Unsupported DXGI format ${dxgi} in DDS file.`);
    }

    const map = { DXT1: 'bc1', DXT2: 'bc2', DXT3: 'bc2', DXT4: 'bc3', DXT5: 'bc3', ATI1: 'bc4', BC4U: 'bc4', ATI2: 'bc5', BC5U: 'bc5' };
    const kind = map[cc];
    if (!kind) throw new Error(`Unsupported DDS format "${cc}".`);
    return { width, height, rgba: decodeBlockFormat(data, dataOffset, width, height, kind), format: cc };
  }

  if (pfFlags & (DDPF_RGB | DDPF_LUMINANCE)) {
    const luminance = Boolean(pfFlags & DDPF_LUMINANCE);
    return {
      width,
      height,
      rgba: decodeUncompressed(data, dataOffset, width, height, bitCount, masks, Boolean(pfFlags & DDPF_ALPHAPIXELS), luminance),
      format: `${bitCount}-bit`,
    };
  }

  throw new Error('Unsupported DDS pixel format.');
}

/** RGBA -> BGRA in place-safe copy, as nativeImage.createFromBitmap expects. */
function rgbaToBgra(rgba) {
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i];
    out[i] = out[i + 2];
    out[i + 2] = r;
  }
  return out;
}

module.exports = { decodeDds, rgbaToBgra };

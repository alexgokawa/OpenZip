'use strict';

/**
 * Native HashFS v2 (SCS#) reader/writer support for ETS2/ATS archives.
 *
 * Verified against the installed ETS2/ATS 1.50+ archives:
 *   header 44 bytes: SCS#, u16 version, u16 salt, "CITY",
 *                    u32 entryCount, u32 tableZSize, u32 metaWords,
 *                    u32 metaZSize, u64 tableOffset, u64 metaOffset
 *   entries:        u64 cityhash64(path), u32 metaIndex, u16 metaCount,
 *                   u16 flags (bit 0 = directory)
 *   metadata:       4-byte blocks. The first block contains a 3-byte index
 *                   plus the chunk type (128 file, 129 directory, 1 image).
 *                   The record starts at (metaIndex + metaCount) * 4:
 *                     (zsize | compression << 28), size, unused, offset/16
 *   directory data: u32 count, count x u8 name length, names. Names starting
 *                   with "/" are subdirectories, all other names are files.
 *
 * Only Node's fs/zlib are used here so this module can be unit-tested without
 * Electron. Nothing in this module ever writes to the source archive.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const SCS_MAGIC = Buffer.from('SCS#');
const CITY_MAGIC = Buffer.from('CITY');
const HEADER_SIZE = 44;
const ALIGN = 16;
const MAX_META_WORDS = 200_000_000;
const MAX_DIRECTORY_CONTENT = 32 * 1024 * 1024;

const MASK = (1n << 64n) - 1n;
const K0 = 0xc3a5c85c97cb3127n;
const K1 = 0xb492b66fbe98f273n;
const K2 = 0x9ae16a3b2f90404fn;
const K3 = 0xc949d7c7509e6557n;
const K_MUL = 0x9ddfea08eb382d69n;

const KNOWN_TOP_DIRS = [
  'automat',
  'def',
  'dlc',
  'effect',
  'font',
  'locale',
  'map',
  'material',
  'model',
  'model2',
  'prefab',
  'prefab2',
  'sound',
  'system',
  'ui',
  'unit',
  'vehicle',
];

function add(...values) {
  let result = 0n;
  for (const value of values) result = (result + value) & MASK;
  return result;
}

function sub(a, b) {
  return (a - b) & MASK;
}

function mul(a, b) {
  return (a * b) & MASK;
}

function rotate(value, shift) {
  const s = BigInt(shift);
  return s === 0n ? value : ((value >> s) | (value << (64n - s))) & MASK;
}

function rotateByAtLeast1(value, shift) {
  const s = BigInt(shift);
  return ((value >> s) | (value << (64n - s))) & MASK;
}

function shiftMix(value) {
  return (value ^ (value >> 47n)) & MASK;
}

function fetch64(buffer, offset) {
  return buffer.readBigUInt64LE(offset);
}

function fetch32(buffer, offset) {
  return BigInt(buffer.readUInt32LE(offset));
}

function hash128To64(first, second) {
  let a = mul(first ^ second, K_MUL);
  a = (a ^ (a >> 47n)) & MASK;
  let b = mul(second ^ a, K_MUL);
  b = (b ^ (b >> 47n)) & MASK;
  return mul(b, K_MUL);
}

function hashLen16(u, v) {
  return hash128To64(u, v);
}

function hashLen0to16(buffer, offset, length) {
  if (length > 8) {
    const a = fetch64(buffer, offset);
    const b = fetch64(buffer, offset + length - 8);
    return (hashLen16(a, rotateByAtLeast1(add(b, BigInt(length)), length)) ^ b) & MASK;
  }
  if (length >= 4) {
    const a = fetch32(buffer, offset);
    return hashLen16(add(BigInt(length), a << 3n), fetch32(buffer, offset + length - 4));
  }
  if (length > 0) {
    const a = BigInt(buffer[offset]);
    const b = BigInt(buffer[offset + (length >> 1)]);
    const c = BigInt(buffer[offset + length - 1]);
    const y = add(a, b << 8n);
    const z = add(BigInt(length), c << 2n);
    return mul(shiftMix(mul(y, K2) ^ mul(z, K3)), K2);
  }
  return K2;
}

function hashLen17to32(buffer, offset, length) {
  const a = mul(fetch64(buffer, offset), K1);
  const b = fetch64(buffer, offset + 8);
  const c = mul(fetch64(buffer, offset + length - 8), K2);
  const d = mul(fetch64(buffer, offset + length - 16), K0);
  return hashLen16(
    add(rotate(sub(a, b), 43), rotate(c, 30), d),
    add(a, rotate(b ^ K3, 20), sub(0n, c), BigInt(length)),
  );
}

function weakHashLen32WithSeedsRaw(w, x, y, z, a, b) {
  a = add(a, w);
  b = rotate(add(b, a, z), 21);
  const c = a;
  a = add(a, x, y);
  b = add(b, rotate(a, 44));
  return [add(a, z), add(b, c)];
}

function weakHashLen32WithSeeds(buffer, offset, a, b) {
  return weakHashLen32WithSeedsRaw(
    fetch64(buffer, offset),
    fetch64(buffer, offset + 8),
    fetch64(buffer, offset + 16),
    fetch64(buffer, offset + 24),
    a,
    b,
  );
}

function hashLen33to64(buffer, offset, length) {
  let z = fetch64(buffer, offset + 24);
  let a = add(fetch64(buffer, offset), mul(add(BigInt(length), fetch64(buffer, offset + length - 16)), K0));
  let b = rotate(add(a, z), 52);
  let c = rotate(a, 37);
  a = add(a, fetch64(buffer, offset + 8));
  c = add(c, rotate(a, 7));
  a = add(a, fetch64(buffer, offset + 16));
  const vf = add(a, z);
  const vs = add(b, rotate(a, 31), c);
  a = add(fetch64(buffer, offset + 16), fetch64(buffer, offset + length - 32));
  z = fetch64(buffer, offset + length - 8);
  b = rotate(add(a, z), 52);
  c = rotate(a, 37);
  a = add(a, fetch64(buffer, offset + length - 24));
  c = add(c, rotate(a, 7));
  a = add(a, fetch64(buffer, offset + length - 16));
  const wf = add(a, z);
  const ws = add(b, rotate(a, 31), c);
  const r = shiftMix(add(mul(add(vf, ws), K2), mul(add(wf, vs), K0)));
  return mul(shiftMix(add(mul(r, K0), vs)), K2);
}

/** HashFS-specific CityHash64 (the older variant used by SCS HashFS). */
function cityHash64(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const length = buffer.length;

  if (length <= 16) return hashLen0to16(buffer, 0, length);
  if (length <= 32) return hashLen17to32(buffer, 0, length);
  if (length <= 64) return hashLen33to64(buffer, 0, length);

  let x = fetch64(buffer, length - 40);
  let y = add(fetch64(buffer, length - 16), fetch64(buffer, length - 56));
  let z = hashLen16(add(fetch64(buffer, length - 48), BigInt(length)), fetch64(buffer, length - 24));
  let v = weakHashLen32WithSeeds(buffer, length - 64, BigInt(length), z);
  let w = weakHashLen32WithSeeds(buffer, length - 32, add(y, K1), x);
  x = add(mul(x, K1), fetch64(buffer, 0));

  let position = 0;
  let remaining = (length - 1) & ~63;
  for (;;) {
    x = mul(rotate(add(x, y, v[0], fetch64(buffer, position + 8)), 37), K1);
    y = mul(rotate(add(y, v[1], fetch64(buffer, position + 48)), 42), K1);
    x ^= w[1];
    y = add(y, v[0], fetch64(buffer, position + 40));
    z = mul(rotate(add(z, w[0]), 33), K1);
    v = weakHashLen32WithSeeds(buffer, position, mul(v[1], K1), add(x, w[0]));
    w = weakHashLen32WithSeeds(
      buffer,
      position + 32,
      add(z, w[1]),
      add(y, fetch64(buffer, position + 16)),
    );
    const swap = z;
    z = x;
    x = swap;
    position += 64;
    remaining -= 64;
    if (remaining === 0) break;
  }

  return hashLen16(
    add(hashLen16(v[0], w[0]), mul(shiftMix(y), K1), z),
    add(hashLen16(v[1], w[1]), x),
  );
}

function hashPath(pathName, salt = 0) {
  let normalized = pathName || '';
  if (normalized.startsWith('/')) normalized = normalized.slice(1);
  if (salt) normalized = `${salt}${normalized}`;
  return cityHash64(Buffer.from(normalized, 'utf8'));
}

function roundUp(value, alignment = ALIGN) {
  return Math.ceil(value / alignment) * alignment;
}

function readHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const header = Buffer.alloc(HEADER_SIZE);
    if (fs.readSync(fd, header, 0, HEADER_SIZE, 0) !== HEADER_SIZE) {
      throw new Error('HashFS header is truncated.');
    }
    if (!header.subarray(0, 4).equals(SCS_MAGIC)) {
      throw new Error('Not a HashFS (SCS#) archive.');
    }
    if (!header.subarray(8, 12).equals(CITY_MAGIC)) {
      throw new Error('HashFS header is missing the CITY marker.');
    }

    return {
      filePath,
      stat,
      size: stat.size,
      version: header.readUInt16LE(4),
      salt: header.readUInt16LE(6),
      entryCount: header.readUInt32LE(12),
      tableZSize: header.readUInt32LE(16),
      metaWords: header.readUInt32LE(20),
      metaZSize: header.readUInt32LE(24),
      tableOffset: Number(header.readBigUInt64LE(28)),
      metaOffset: Number(header.readBigUInt64LE(36)),
      header,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readAt(fd, offset, length) {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, offset);
  if (read !== length) throw new Error('HashFS data is truncated.');
  return buffer;
}

/** Decode the main file/directory record for one entry. */
function decodeEntryRecord(meta, entry) {
  const blockOffset = entry.metaIndex * 4;
  if (blockOffset + 4 > meta.length) return null;

  const type = meta[blockOffset + 3];
  if (type !== 1 && type !== 128 && type !== 129) return null;

  // Packed texture entries carry 12 bytes of tobj metadata before the main
  // record. They are binary and extract-only, but still belong in the tree.
  const recordOffset = (entry.metaIndex + entry.metaCount) * 4 + (type === 1 ? 12 : 0);
  if (recordOffset + 16 > meta.length) return null;

  const sizeWord = meta.readUInt32LE(recordOffset);
  const compression = sizeWord >>> 28;
  const zsize = sizeWord & 0x0fffffff;
  const size = meta.readUInt32LE(recordOffset + 4) & 0x0fffffff;
  const offset = meta.readUInt32LE(recordOffset + 12) * 16;

  return {
    type: type === 129 ? 'directory' : type === 1 ? 'image' : 'file',
    zsize,
    size,
    compression,
    offset,
    metaIndex: entry.metaIndex,
    metaCount: entry.metaCount,
    recordOffset,
    flags: entry.flags,
  };
}

function readRecordData(fd, record) {
  if (record.offset < 0 || record.offset + record.zsize > Number.MAX_SAFE_INTEGER) {
    throw new Error('HashFS record offset is invalid.');
  }
  const raw = readAt(fd, record.offset, record.zsize);
  if (record.compression === 0) return raw.subarray(0, record.size);
  if (record.compression === 1) return zlib.inflateSync(raw);
  throw new Error(`Unsupported HashFS compression method ${record.compression}.`);
}

function parseDirectoryListing(content) {
  if (content.length < 4) return [];
  const count = content.readUInt32LE(0);
  if (count > 1_000_000 || 4 + count > content.length) {
    throw new Error('HashFS directory listing is invalid.');
  }

  const lengths = content.subarray(4, 4 + count);
  let offset = 4 + count;
  const names = [];
  for (let i = 0; i < count; i += 1) {
    const length = lengths[i];
    if (offset + length > content.length) break;
    names.push(content.toString('utf8', offset, offset + length));
    offset += length;
  }
  return names;
}

/**
 * Parse a HashFS v2 archive and reconstruct its path tree.
 * Returns { supported: false, reason } for archives without a usable tree.
 */
function readHashFsIndex(filePath) {
  const header = readHeader(filePath);
  if (header.version !== 2) return { supported: false, reason: `HashFS v${header.version}`, header };
  if (header.entryCount > 10_000_000) {
    return { supported: false, reason: 'too many entries', header };
  }
  if (header.metaWords > MAX_META_WORDS) {
    return { supported: false, reason: 'metadata too large', header };
  }
  if (
    header.tableOffset + header.tableZSize > header.size ||
    header.metaOffset + header.metaZSize > header.size
  ) {
    return { supported: false, reason: 'table offsets outside the file', header };
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const tableCompressed = readAt(fd, header.tableOffset, header.tableZSize);
    const metaCompressed = readAt(fd, header.metaOffset, header.metaZSize);
    const table = zlib.inflateSync(tableCompressed);
    const meta = zlib.inflateSync(metaCompressed);

    if (table.length < header.entryCount * 16) {
      return { supported: false, reason: 'entry table is truncated', header };
    }
    if (meta.length < header.metaWords * 4) {
      return { supported: false, reason: 'metadata is truncated', header };
    }

    const byHash = new Map();
    const entries = [];
    for (let i = 0; i < header.entryCount; i += 1) {
      const base = i * 16;
      const entry = {
        hash: table.readBigUInt64LE(base).toString(),
        metaIndex: table.readUInt32LE(base + 8),
        metaCount: table.readUInt16LE(base + 12),
        flags: table.readUInt16LE(base + 14),
        order: i,
      };
      entry.record = decodeEntryRecord(meta, entry);
      byHash.set(entry.hash, entry);
      entries.push(entry);
    }

    const rootEntry = byHash.get(hashPath('', header.salt).toString());
    const seedEntries = [];
    if (rootEntry) {
      seedEntries.push({ pathName: '', entry: rootEntry });
    } else {
      for (const name of KNOWN_TOP_DIRS) {
        const entry = byHash.get(hashPath(name, header.salt).toString());
        if (entry) seedEntries.push({ pathName: name, entry });
      }
    }

    if (seedEntries.length === 0) {
      return {
        supported: false,
        reason: 'top-level directory listing is missing',
        header,
        entries,
      };
    }

    const files = [];
    const directories = [];
    const seen = new Set();
    const queue = [...seedEntries];
    const filesByPath = new Map();

    while (queue.length > 0) {
      const current = queue.shift();
      if (seen.has(current.pathName)) continue;
      seen.add(current.pathName);

      const record = current.entry.record;
      if (!record || record.type !== 'directory') continue;
      if (record.size > MAX_DIRECTORY_CONTENT) continue;

      let content;
      try {
        content = readRecordData(fd, record);
      } catch {
        continue;
      }

      let names;
      try {
        names = parseDirectoryListing(content);
      } catch {
        continue;
      }

      directories.push(current.pathName);

      for (const rawName of names) {
        const isDirectory = rawName.startsWith('/');
        const name = isDirectory ? rawName.slice(1) : rawName;
        if (!name) continue;
        const fullPath = current.pathName ? `${current.pathName}/${name}` : name;
        if (filesByPath.has(fullPath) || seen.has(fullPath)) continue;

        const entry = byHash.get(hashPath(fullPath, header.salt).toString());
        if (!entry || !entry.record) continue;

        if (isDirectory || entry.record.type === 'directory') {
          queue.push({ pathName: fullPath, entry });
          continue;
        }

        const fileRecord = entry.record;
        if (
          fileRecord.offset < 0 ||
          fileRecord.offset + fileRecord.zsize > header.size
        ) {
          continue;
        }

        const packedImage = fileRecord.type === 'image';
        const lowerPath = fullPath.toLowerCase();
        const primaryPackedSize = packedImage
          ? lowerPath.endsWith('.dds')
            ? fileRecord.zsize
            : 0
          : fileRecord.zsize;
        const file = {
          name: fullPath,
          size: 0,
          packedSize: primaryPackedSize,
          offset: fileRecord.offset,
          zsize: fileRecord.zsize,
          compression: fileRecord.compression,
          recordOffset: fileRecord.recordOffset,
          metaIndex: entry.metaIndex,
          metaCount: entry.metaCount,
          flags: entry.flags,
          packedImage,
        };
        if (!packedImage) file.size = fileRecord.size;
        files.push(file);
        filesByPath.set(fullPath, file);

        if (packedImage) {
          let sibling = null;
          if (lowerPath.endsWith('.tobj')) sibling = `${fullPath.slice(0, -5)}.dds`;
          else if (lowerPath.endsWith('.dds')) sibling = `${fullPath.slice(0, -4)}.tobj`;
          if (sibling && !filesByPath.has(sibling)) {
            const siblingFile = {
              ...file,
              name: sibling,
              size: 0,
              packedSize: sibling.toLowerCase().endsWith('.dds') ? fileRecord.zsize : 0,
            };
            files.push(siblingFile);
            filesByPath.set(sibling, siblingFile);
          }
        }
      }
    }

    files.sort((a, b) => a.name.localeCompare(b.name));
    return {
      supported: true,
      header,
      table,
      meta,
      tableCompressed,
      entries,
      byHash,
      files,
      filesByPath,
      directories,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readHashFsEntry(index, entryName, maxBytes = 20 * 1024 * 1024) {
  if (!index || !index.supported) throw new Error('HashFS archive is not readable.');
  const entry = index.filesByPath.get(entryName);
  if (!entry) throw new Error(`File not found in archive: ${entryName}`);
  if (entry.packedImage) {
    throw new Error('Packed HashFS texture entries are extract-only; use Extract To for .dds/.tobj files.');
  }
  if (entry.size > maxBytes) {
    throw new Error(`Entry is too large (limit ${Math.round(maxBytes / 1024 / 1024)} MB).`);
  }

  const fd = fs.openSync(index.header.filePath, 'r');
  try {
    const data = readRecordData(fd, entry);
    if (data.length !== entry.size) {
      throw new Error(`HashFS entry size mismatch for ${entryName}.`);
    }
    return data;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Build a complete modified HashFS copy without touching the source archive.
 *
 * All original bytes in the data section are copied verbatim. Edited file data
 * is appended at the end of that section, and only those file records, the
 * metadata table, the table offsets and the header are rewritten. This keeps
 * every unchanged file's stored bytes byte-identical while avoiding a full
 * decompress/recompress of archives that may be many GB.
 */
async function writeHashFsCopy(filePath, outputPath, editedFiles, options = {}) {
  if (!filePath || !outputPath) throw new Error('Source and output paths are required.');
  if (path.resolve(filePath).toLowerCase() === path.resolve(outputPath).toLowerCase()) {
    throw new Error('The modified copy must use a different path from the original archive.');
  }

  const edits =
    editedFiles instanceof Map ? editedFiles : new Map(Object.entries(editedFiles || {}));
  if (edits.size === 0) throw new Error('No edited files were provided.');

  const index = readHashFsIndex(filePath);
  if (!index.supported) throw new Error(index.reason || 'HashFS archive is not readable.');

  const records = [];
  for (const [entryName, rawContent] of edits) {
    const file = index.filesByPath.get(entryName);
    if (!file) throw new Error(`File not found in archive: ${entryName}`);
    if (typeof rawContent !== 'string' && !Buffer.isBuffer(rawContent)) {
      throw new Error(`No text was provided for ${entryName}.`);
    }
    const data = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent, 'utf8');
    if (data.length > 0x0fffffff) throw new Error(`${entryName} is too large for HashFS.`);
    records.push({ file, data });
  }

  const header = Buffer.from(index.header.header);
  const meta = Buffer.from(index.meta);
  const tableCompressed = Buffer.from(index.tableCompressed);

  let totalWork =
    index.header.tableOffset +
    records.reduce((sum, record) => sum + record.data.length, 0) +
    tableCompressed.length;
  let completed = 0;
  const report = (message) => {
    if (typeof options.onProgress === 'function') {
      const percent = totalWork > 0 ? Math.min(100, Math.round((completed / totalWork) * 100)) : 100;
      options.onProgress({ percent, message });
    }
  };

  const tempPath = `${outputPath}.openzip-${process.pid}-${Date.now()}.tmp`;
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const input = await fsp.open(filePath, 'r');
  const output = await fsp.open(tempPath, 'w+');

  try {
    const buffer = Buffer.alloc(8 * 1024 * 1024);
    let sourcePosition = 0;
    let outputPosition = 0;

    while (sourcePosition < index.header.tableOffset) {
      const length = Math.min(buffer.length, index.header.tableOffset - sourcePosition);
      const { bytesRead } = await input.read(buffer, 0, length, sourcePosition);
      if (bytesRead === 0) break;
      await output.write(buffer, 0, bytesRead, outputPosition);
      sourcePosition += bytesRead;
      outputPosition += bytesRead;
      completed += bytesRead;
      report('Copying original archive data…');
    }

    for (const record of records) {
      const compressed = await new Promise((resolve, reject) => {
        zlib.deflate(record.data, { level: 6 }, (error, result) => (error ? reject(error) : resolve(result)));
      });
      if (compressed.length > 0x0fffffff) {
        throw new Error(`${record.file.name} is too large for HashFS compression.`);
      }

      const aligned = roundUp(outputPosition, ALIGN);
      if (aligned > outputPosition) {
        await output.write(Buffer.alloc(aligned - outputPosition), 0, aligned - outputPosition, outputPosition);
        outputPosition = aligned;
      }

      await output.write(compressed, 0, compressed.length, outputPosition);
      const blockOffset = outputPosition / ALIGN;
      if (!Number.isInteger(blockOffset) || blockOffset > 0xffffffff) {
        throw new Error('HashFS data offset exceeds the format limit.');
      }

      const recordOffset = record.file.recordOffset;
      meta.writeUInt32LE((compressed.length | (1 << 28)) >>> 0, recordOffset);
      meta.writeUInt32LE(record.data.length, recordOffset + 4);
      meta.writeUInt32LE(0, recordOffset + 8);
      meta.writeUInt32LE(blockOffset, recordOffset + 12);

      outputPosition += compressed.length;
      completed += record.data.length;
      report(`Writing ${record.file.name}…`);
    }

    const newTableOffset = roundUp(outputPosition, ALIGN);
    if (newTableOffset > outputPosition) {
      await output.write(Buffer.alloc(newTableOffset - outputPosition), 0, newTableOffset - outputPosition, outputPosition);
      outputPosition = newTableOffset;
    }
    await output.write(tableCompressed, 0, tableCompressed.length, outputPosition);
    outputPosition += tableCompressed.length;
    completed += tableCompressed.length;
    report('Writing entry table…');

    const newMetaOffset = roundUp(outputPosition, ALIGN);
    if (newMetaOffset > outputPosition) {
      await output.write(Buffer.alloc(newMetaOffset - outputPosition), 0, newMetaOffset - outputPosition, outputPosition);
      outputPosition = newMetaOffset;
    }
    const metaCompressed = await new Promise((resolve, reject) => {
      zlib.deflate(meta, { level: 6 }, (error, result) => (error ? reject(error) : resolve(result)));
    });
    totalWork += metaCompressed.length;
    await output.write(metaCompressed, 0, metaCompressed.length, outputPosition);
    outputPosition += metaCompressed.length;
    completed += metaCompressed.length;
    report('Writing metadata…');

    // The header is at byte 0 and was copied with the data section; patch only
    // the fields that depend on the new table/metadata locations and sizes.
    header.writeUInt32LE(metaCompressed.length, 24);
    header.writeBigUInt64LE(BigInt(newTableOffset), 28);
    header.writeBigUInt64LE(BigInt(newMetaOffset), 36);
    await output.write(header, 0, header.length, 0);
    await output.truncate(outputPosition);
    await output.sync();
    report('Finalising modified copy…');

    await output.close();
    await input.close();
    await fsp.rename(tempPath, outputPath);
    return {
      outputPath,
      size: outputPosition,
      edited: records.map((record) => record.file.name),
    };
  } catch (error) {
    await output.close().catch(() => {});
    await input.close().catch(() => {});
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  SCS_MAGIC,
  HEADER_SIZE,
  ALIGN,
  cityHash64,
  hashPath,
  readHeader,
  readHashFsIndex,
  readHashFsEntry,
  roundUp,
  writeHashFsCopy,
};

'use strict';

/**
 * HashFS editing regression test.
 *
 * Uses a real ETS2/ATS HashFS v2 archive when one is installed. Set
 * OPENZIP_HASHFS_ARCHIVE to another .scs file to test a different archive.
 *
 * Verifies:
 *  - native directory listing and text reads
 *  - saving one edited file to a mod ZIP containing only that file
 *  - reopening the mod as a normal ZIP
 *  - the original archive's size, mtime and SHA-256 never change
 *  - every unchanged file in a full modified copy is byte-identical
 *  - the official SCS extractor can read the modified copy
 */

const Module = require('node:module');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const AdmZip = require(path.join(APP_ROOT, 'node_modules', 'adm-zip'));
const hashfs = require(path.join(APP_ROOT, 'scs-hashfs.cjs'));

const CANDIDATES = [
  process.env.OPENZIP_HASHFS_ARCHIVE,
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Euro Truck Simulator 2\\dlc_daf_tuning_pack.scs',
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\American Truck Simulator\\dlc_rims.scs',
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Euro Truck Simulator 2\\version.scs',
].filter(Boolean);

const archivePath = CANDIDATES.find((candidate) => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
});

if (!archivePath) {
  console.log('SKIP: no HashFS test archive found. Set OPENZIP_HASHFS_ARCHIVE=<path to .scs>.');
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openzip-hashfs-test-'));
const handlers = new Map();
const nativeTheme = new EventEmitter();
nativeTheme.shouldUseDarkColors = false;
nativeTheme.themeSource = 'system';

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        whenReady: () => new Promise(() => {}),
        on: () => {},
        getPath: () => os.tmpdir(),
        quit: () => {},
      },
      BrowserWindow: class {
        static getAllWindows() {
          return [];
        }
      },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      ipcMain: {
        handle: (channel, fn) => handlers.set(channel, fn),
        on: () => {},
      },
      nativeImage: {
        createFromPath: () => ({ isEmpty: () => false }),
        createFromBuffer: () => ({ isEmpty: () => false }),
      },
      nativeTheme,
      shell: { openExternal: async () => {} },
    };
  }
  return originalLoad.apply(this, arguments);
};

require(path.join(APP_ROOT, 'electron.cjs'));

let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log('ok  -', message);
  } else {
    failures += 1;
    console.error('FAIL -', message);
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function run() {
  console.log(`HashFS test archive: ${archivePath}`);
  const before = fs.statSync(archivePath);
  const beforeHash = sha256(archivePath);

  const read = await handlers.get('archive:read')(null, archivePath);
  assert(read.ok === true, `native HashFS listing succeeds (${read.error || ''})`);
  assert(read.format === 'scs', 'archive reports SCS format');
  assert(read.entries.length > 0, `directory tree has files (${read.entries.length})`);

  const editable = read.entries.filter((entry) => entry.name.endsWith('.sii'));
  assert(editable.length > 0, `text .sii entries are exposed (${editable.length})`);
  if (editable.length === 0) throw new Error('No .sii files to edit.');

  const target = editable[0];
  const other = editable.find((entry) => entry.name !== target.name) || target;
  const targetRead = await handlers.get('archive:readFile')(null, {
    archivePath,
    entryName: target.name,
  });
  assert(
    targetRead.success === true && typeof targetRead.content === 'string',
    `HashFS file reads inside the editor (${targetRead.error || ''})`,
  );
  const originalText = targetRead.content;
  const editedText = `${originalText}\n# OpenZip HashFS regression edit ${Date.now()}\n`;
  const otherRead = await handlers.get('archive:readFile')(null, {
    archivePath,
    entryName: other.name,
  });
  assert(otherRead.success === true, 'a second unchanged file reads successfully');

  const modPath = path.join(work, 'edited_mod.scs');
  const modResult = await handlers.get('archive:saveScsMod')(null, {
    archivePath,
    modPath,
    files: [{ entryName: target.name, content: editedText }],
  });
  assert(modResult.success === true, `mod package save succeeds (${modResult.error || ''})`);

  const modZip = new AdmZip(modPath);
  const modEntries = modZip.getEntries().map((entry) => entry.entryName);
  assert(modEntries.length === 1, 'mod package contains only the edited file');
  assert(modEntries[0] === target.name, 'edited file keeps its original archive path');
  assert(
    modZip.readAsText(target.name).includes('OpenZip HashFS regression edit'),
    'mod package contains the edited text',
  );

  const modRead = await handlers.get('archive:read')(null, modPath);
  assert(modRead.ok === true && modRead.format === 'zip', 'OpenZip opens the mod as a ZIP');
  const modFileRead = await handlers.get('archive:readFile')(null, {
    archivePath: modPath,
    entryName: target.name,
  });
  assert(
    modFileRead.success === true && modFileRead.content === editedText,
    'edited text is readable from the mod at the same path',
  );

  const copyPath = path.join(work, 'full_copy.scs');
  const copyResult = await handlers.get('archive:saveScsCopy')(null, {
    archivePath,
    outputPath: copyPath,
    files: [{ entryName: target.name, content: editedText }],
  });
  assert(copyResult.success === true, `modified full copy save succeeds (${copyResult.error || ''})`);
  assert(fs.existsSync(copyPath), 'modified full copy exists');

  const dragSession = 'hashfs-drag-001';
  const dragResult = await handlers.get('archive:prepareDrag')(null, {
    sessionId: dragSession,
    archivePath,
    roots: [target.name],
    entries: [target.name],
  });
  assert(dragResult.success === true, `HashFS drag preparation succeeds (${dragResult.error || ''})`);
  assert(
    dragResult.tempDir && fs.existsSync(path.join(dragResult.tempDir, ...target.name.split('/'))),
    'HashFS drag preparation extracts the selected nested path',
  );
  assert(
    fs.readFileSync(path.join(dragResult.tempDir, ...target.name.split('/')), 'utf8') === originalText,
    'HashFS drag preparation preserves the original file bytes',
  );
  await handlers.get('archive:cleanupDrag')(null, { sessionId: dragSession });
  assert(!fs.existsSync(dragResult.tempDir), 'HashFS drag temp folder is cleaned up');

  const copyIndex = hashfs.readHashFsIndex(copyPath);
  assert(copyIndex.supported === true, 'modified copy is a readable HashFS v2 archive');
  const copyEdited = hashfs.readHashFsEntry(copyIndex, target.name).toString('utf8');
  assert(copyEdited === editedText, 'modified copy contains the edited text');

  let unchangedCount = 0;
  let mismatch = null;
  for (const entry of read.entries) {
    if (entry.name === target.name) continue;
    if (copyIndex.filesByPath.get(entry.name)?.packedImage) continue;
    const originalBytes = hashfs.readHashFsEntry(readHashFsIndexCache(archivePath), entry.name);
    const copyBytes = hashfs.readHashFsEntry(copyIndex, entry.name);
    if (!originalBytes.equals(copyBytes)) {
      mismatch = entry.name;
      break;
    }
    unchangedCount += 1;
  }
  assert(mismatch === null, `every unchanged non-packed file is byte-identical (${unchangedCount})`);
  if (mismatch) console.error('     first differing file:', mismatch);

  const after = fs.statSync(archivePath);
  assert(before.size === after.size, 'original archive size is unchanged');
  assert(before.mtimeMs === after.mtimeMs, 'original archive modified date is unchanged');
  assert(beforeHash === sha256(archivePath), 'original archive SHA-256 is unchanged');

  const extractor = ['scs_extractor.exe', 'extractor.exe']
    .map((name) => path.join(APP_ROOT, 'bin', name))
    .find((candidate) => fs.existsSync(candidate)) || path.join(APP_ROOT, 'bin', 'extractor.exe');
  if (fs.existsSync(extractor)) {
    const extractDir = path.join(work, 'extractor_out');
    execFileSync(extractor, [copyPath, `--dest=${extractDir}`], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 120_000,
    });
    const extractedEdited = fs.readFileSync(path.join(extractDir, ...target.name.split('/')), 'utf8');
    assert(extractedEdited === editedText, 'official SCS extractor reads the edited copy');
    if (other.name !== target.name) {
      const extractedOther = fs.readFileSync(path.join(extractDir, ...other.name.split('/')));
      const originalOther = hashfs.readHashFsEntry(readHashFsIndexCache(archivePath), other.name);
      assert(extractedOther.equals(originalOther), 'official extractor agrees on an unchanged file');
    }
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — HashFS editing regression (${failures} failure(s))`);
  await fsp.rm(work, { recursive: true, force: true });
  process.exitCode = failures === 0 ? 0 : 1;
}

// Cache the source index for the compare loop; parsing it once is enough.
let sourceIndex = null;
function readHashFsIndexCache(filePath) {
  if (!sourceIndex) sourceIndex = hashfs.readHashFsIndex(filePath);
  return sourceIndex;
}

run().catch(async (error) => {
  console.error(error);
  await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  process.exitCode = 1;
});

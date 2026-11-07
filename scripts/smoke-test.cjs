'use strict';

/* Smoke test for OpenZip's archive handlers.
 *
 * Loads electron.cjs with a stubbed `electron` module, then exercises the real
 * IPC handlers: ZIP via adm-zip, 7z/tar/gz via node-7z, SCS HashFS detection,
 * selective extraction, and error paths.
 */

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const APP_ROOT = path.join(__dirname, '..');
const AdmZip = require(path.join(APP_ROOT, 'node_modules', 'adm-zip'));
const SEVEN_ZIP = path.join(APP_ROOT, 'bin', '7z', '7z.exe');

const handlers = new Map();
const nativeTheme = new EventEmitter();
nativeTheme.shouldUseDarkColors = false;
nativeTheme.themeSource = 'system';
const openedExternal = [];
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
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      nativeTheme,
      shell: {
        openExternal: async (url) => {
          openedExternal.push(url);
        },
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

require(path.join(APP_ROOT, 'electron.cjs'));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openzip-smoke-'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok  - ${message}`);
  }
}

function makeDirectory(dir, files) {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function run7z(args, cwd) {
  const result = spawnSync(SEVEN_ZIP, args, { cwd, windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`7z ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

function countFiles(dir) {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) stack.push(full);
      else count += 1;
    }
  }
  return count;
}

async function main() {
  for (const channel of ['dialog:openArchive', 'dialog:selectOutputDir', 'archive:read', 'archive:extract']) {
    assert(typeof handlers.get(channel) === 'function', `handler registered: ${channel}`);
  }

  assert(fs.existsSync(SEVEN_ZIP), 'bundled 7-Zip engine is present');

  /* ---------- ZIP ---------- */

  const zipPath = path.join(work, 'sample.zip');
  const zip = new AdmZip();
  zip.addFile('readme.txt', Buffer.from('OpenZip smoke test'));
  zip.addFile('def/world/road.sii', Buffer.from('SiiNunit { }'));
  zip.addFile('locale/en_gb.txt', Buffer.from('hello'));
  zip.writeZip(zipPath);

  const openZip = await handlers.get('archive:read')(null, zipPath);
  assert(openZip.ok === true, 'archive:read returns ok for a ZIP');
  assert(openZip.format === 'zip', 'ZIP format detected');
  const zipFiles = openZip.entries.filter((entry) => !entry.isDirectory);
  assert(zipFiles.length === 3, `ZIP file count is 3 (got ${zipFiles.length})`);

  const readme = openZip.entries.find((entry) => entry.name === 'readme.txt');
  assert(Boolean(readme), 'readme.txt entry present');
  assert(readme.size === 18, `readme.txt uncompressed size 18 (got ${readme.size})`);
  assert(typeof readme.time === 'number', 'entry carries a modified timestamp');
  assert(
    openZip.entries.some((entry) => entry.name === 'def/world/road.sii'),
    'nested path preserved',
  );

  const zipOut = path.join(work, 'zip-out');
  const zipResult = await handlers.get('archive:extract')(null, {
    filePath: zipPath,
    outputDir: zipOut,
  });
  assert(zipResult.ok === true, `ZIP extract ok (${zipResult.error || zipResult.message})`);
  assert(zipResult.extracted === 3, `ZIP extracted 3 files (got ${zipResult.extracted})`);
  assert(
    fs.readFileSync(path.join(zipOut, 'def', 'world', 'road.sii'), 'utf8') === 'SiiNunit { }',
    'nested ZIP file content extracted correctly',
  );

  const partialOut = path.join(work, 'zip-partial');
  const partial = await handlers.get('archive:extract')(null, {
    filePath: zipPath,
    outputDir: partialOut,
    entries: ['locale/en_gb.txt'],
  });
  assert(partial.ok === true && partial.extracted === 1, 'selective ZIP extraction of one entry');
  assert(fs.existsSync(path.join(partialOut, 'locale', 'en_gb.txt')), 'selected entry written');
  assert(!fs.existsSync(path.join(partialOut, 'readme.txt')), 'unselected entry not written');

  /* ---------- ZIP editor read/save ---------- */

  const zipRead = await handlers.get('archive:readFile')(null, {
    archivePath: zipPath,
    entryName: 'readme.txt',
  });
  assert(
    zipRead.success === true && zipRead.content === 'OpenZip smoke test',
    `ZIP readFile returns content (${zipRead.error || ''})`,
  );

  const zipSave = await handlers.get('archive:saveFile')(null, {
    archivePath: zipPath,
    entryName: 'readme.txt',
    newContent: 'OpenZip smoke test — edited\n',
  });
  assert(zipSave.success === true, `ZIP saveFile updates the archive (${zipSave.error || ''})`);

  const zipReadBack = await handlers.get('archive:readFile')(null, {
    archivePath: zipPath,
    entryName: 'readme.txt',
  });
  assert(
    zipReadBack.success === true && zipReadBack.content.includes('edited'),
    'ZIP saved content is readable again',
  );

  const zipAfterSave = await handlers.get('archive:read')(null, zipPath);
  assert(
    zipAfterSave.ok === true &&
      zipAfterSave.entries.filter((entry) => !entry.isDirectory).length === 3 &&
      zipAfterSave.entries.some((entry) => entry.name === 'def/world/road.sii'),
    'ZIP save preserves the other entries',
  );

  const traversal = await handlers.get('archive:saveFile')(null, {
    archivePath: zipPath,
    entryName: '../escape.txt',
    newContent: 'nope',
  });
  assert(
    traversal.success === false && /Invalid/i.test(traversal.error),
    'editor path traversal is rejected',
  );

  const binZipPath = path.join(work, 'binary.zip');
  const binZip = new AdmZip();
  binZip.addFile('binary.dat', Buffer.from([0, 1, 2, 3, 0, 4]));
  binZip.writeZip(binZipPath);
  const binRead = await handlers.get('archive:readFile')(null, {
    archivePath: binZipPath,
    entryName: 'binary.dat',
  });
  assert(binRead.success === false && /binary/i.test(binRead.error), 'binary file is rejected by the editor');

  /* ---------- Injection + image viewer ---------- */

  const dropFile = path.join(work, 'dropped.txt');
  fs.writeFileSync(dropFile, 'dropped into the archive');
  const addFiles = await handlers.get('archive:addFiles')(null, {
    archivePath: zipPath,
    filePaths: [dropFile],
    targetDir: 'injected',
  });
  assert(addFiles.success === true, `ZIP addFiles injects a file (${addFiles.error || ''})`);
  const injectedRead = await handlers.get('archive:read')(null, zipPath);
  assert(
    injectedRead.ok === true && injectedRead.entries.some((entry) => entry.name === 'injected/dropped.txt'),
    'injected file appears in the archive listing',
  );

  const imageZipPath = path.join(work, 'image.zip');
  const imageZip = new AdmZip();
  imageZip.addFile(
    'pixel.png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP1G7QAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  imageZip.writeZip(imageZipPath);
  const imageRead = await handlers.get('archive:readImage')(null, {
    archivePath: imageZipPath,
    entryName: 'pixel.png',
  });
  assert(
    imageRead.success === true && imageRead.base64.startsWith('data:image/png;base64,'),
    'image entry returns a PNG data URL',
  );

  const initial = await handlers.get('archive:initialPath')();
  assert(initial === null, 'no archive path from the smoke-test command line');

  const external = await handlers.get('shell:openExternal')(null, 'https://ko-fi.com/gokawa');
  assert(
    external.success === true && openedExternal.includes('https://ko-fi.com/gokawa'),
    'https external links are passed to shell.openExternal',
  );
  const invalidExternal = await handlers.get('shell:openExternal')(null, 'file:///C:/Windows');
  assert(
    invalidExternal.success === false && invalidExternal.error === 'Invalid protocol',
    'non-http protocols are rejected for external links',
  );

  /* ---------- 7z ---------- */

  const sourceDir = path.join(work, 'source');
  makeDirectory(sourceDir, {
    'manifest.sii': 'SiiNunit { }',
    'def/vehicle/engine.sii': 'engine data',
    'ui/dashboard.txt': 'dashboard',
  });
  const sevenPath = path.join(work, 'sample.7z');
  run7z(['a', '-t7z', sevenPath, '.'], sourceDir);

  const open7z = await handlers.get('archive:read')(null, sevenPath);
  assert(open7z.ok === true, `archive:read returns ok for 7z (${open7z.error || ''})`);
  assert(open7z.format === '7z', '7z format detected');
  assert(
    open7z.entries.filter((entry) => !entry.isDirectory).length === 3,
    '7z lists all three files',
  );
  assert(
    open7z.entries.some((entry) => entry.isDirectory),
    '7z lists directory entries',
  );

  const sevenOut = path.join(work, '7z-out');
  const sevenResult = await handlers.get('archive:extract')(null, {
    filePath: sevenPath,
    outputDir: sevenOut,
  });
  assert(sevenResult.ok === true, `7z extract ok (${sevenResult.error || sevenResult.message})`);
  assert(countFiles(sevenOut) === 3, '7z extracted all files');
  assert(
    fs.readFileSync(path.join(sevenOut, 'def', 'vehicle', 'engine.sii'), 'utf8') === 'engine data',
    '7z nested content extracted correctly',
  );

  /* ---------- 7z editor read/save ---------- */

  const sevenRead = await handlers.get('archive:readFile')(null, {
    archivePath: sevenPath,
    entryName: 'manifest.sii',
  });
  assert(
    sevenRead.success === true && sevenRead.content === 'SiiNunit { }',
    `7z readFile returns content (${sevenRead.error || ''})`,
  );

  const sevenSave = await handlers.get('archive:saveFile')(null, {
    archivePath: sevenPath,
    entryName: 'manifest.sii',
    newContent: 'SiiNunit { edited: true }',
  });
  assert(sevenSave.success === true, `7z saveFile updates the archive (${sevenSave.error || ''})`);

  const sevenReadBack = await handlers.get('archive:readFile')(null, {
    archivePath: sevenPath,
    entryName: 'manifest.sii',
  });
  assert(
    sevenReadBack.success === true && sevenReadBack.content.includes('edited'),
    '7z saved content is readable again',
  );

  const sevenDrop = path.join(work, 'seven-drop.txt');
  fs.writeFileSync(sevenDrop, 'dropped into 7z');
  const sevenAdd = await handlers.get('archive:addFiles')(null, {
    archivePath: sevenPath,
    filePaths: [sevenDrop],
    targetDir: 'ui',
  });
  assert(sevenAdd.success === true, `7z addFiles injects a file (${sevenAdd.error || ''})`);
  const sevenInjected = await handlers.get('archive:read')(null, sevenPath);
  assert(
    sevenInjected.ok === true &&
      sevenInjected.entries.some((entry) => entry.name === 'ui/seven-drop.txt'),
    '7z injected file appears in the listing',
  );

  /* ---------- TAR.GZ ---------- */

  const tarPath = path.join(work, 'sample.tar');
  run7z(['a', '-ttar', tarPath, '.'], sourceDir);
  const gzPath = path.join(work, 'sample.tar.gz');
  run7z(['a', '-tgzip', gzPath, tarPath], work);

  const tarRead = await handlers.get('archive:readFile')(null, {
    archivePath: tarPath,
    entryName: 'manifest.sii',
  });
  assert(tarRead.success === true, `TAR readFile returns content (${tarRead.error || ''})`);

  const tarSave = await handlers.get('archive:saveFile')(null, {
    archivePath: tarPath,
    entryName: 'manifest.sii',
    newContent: 'SiiNunit { tar_edit: true }',
  });
  assert(tarSave.success === true, `TAR saveFile updates the archive (${tarSave.error || ''})`);

  const tarReadBack = await handlers.get('archive:readFile')(null, {
    archivePath: tarPath,
    entryName: 'manifest.sii',
  });
  assert(
    tarReadBack.success === true && tarReadBack.content.includes('tar_edit'),
    'TAR saved content is readable again',
  );

  const tarDrop = path.join(work, 'tar-drop.txt');
  fs.writeFileSync(tarDrop, 'dropped into tar');
  const tarAdd = await handlers.get('archive:addFiles')(null, {
    archivePath: tarPath,
    filePaths: [tarDrop],
    targetDir: 'added',
  });
  assert(tarAdd.success === true, `TAR addFiles injects a file (${tarAdd.error || ''})`);
  const tarInjected = await handlers.get('archive:read')(null, tarPath);
  assert(
    tarInjected.ok === true &&
      tarInjected.entries.some((entry) => entry.name === 'added/tar-drop.txt'),
    'TAR injected file appears in the listing',
  );

  const openGz = await handlers.get('archive:read')(null, gzPath);
  assert(openGz.ok === true, `archive:read returns ok for tar.gz (${openGz.error || ''})`);
  assert(openGz.format === 'gz', 'gzip format detected');
  assert(openGz.entries.length === 1 && openGz.entries[0].name.endsWith('.tar'), 'gzip lists inner tar');

  const gzOut = path.join(work, 'gz-out');
  const gzResult = await handlers.get('archive:extract')(null, { filePath: gzPath, outputDir: gzOut });
  assert(gzResult.ok === true, `gzip extract ok (${gzResult.error || gzResult.message})`);
  assert(countFiles(gzOut) === 1, 'gzip extracted its single payload');

  /* ---------- BZ2 / XZ streams ---------- */

  for (const [extension, type] of [
    ['bz2', 'bzip2'],
    ['xz', 'xz'],
  ]) {
    const streamPath = path.join(work, `sample.tar.${extension}`);
    run7z(['a', `-t${type}`, streamPath, tarPath], work);

    const openStream = await handlers.get('archive:read')(null, streamPath);
    assert(openStream.ok === true, `archive:read returns ok for ${extension} (${openStream.error || ''})`);
    assert(openStream.format === extension, `${extension} format detected`);

    const streamOut = path.join(work, `${extension}-out`);
    const streamResult = await handlers.get('archive:extract')(null, {
      filePath: streamPath,
      outputDir: streamOut,
    });
    assert(streamResult.ok === true, `${extension} extract ok (${streamResult.error || streamResult.message})`);
    assert(countFiles(streamOut) === 1, `${extension} extracted its single payload`);
  }

  /* ---------- CAB ---------- */

  const cabPath = path.join(work, 'sample.cab');
  const cabArgs = [path.join(sourceDir, 'manifest.sii'), cabPath];
  const makeCab = spawnSync('makecab.exe', cabArgs, { windowsHide: true, encoding: 'utf8' });
  if (makeCab.status === 0 && fs.existsSync(cabPath)) {
    const openCab = await handlers.get('archive:read')(null, cabPath);
    assert(openCab.ok === true, `archive:read returns ok for CAB (${openCab.error || ''})`);
    assert(openCab.format === 'cab', 'CAB format detected');

    const cabOut = path.join(work, 'cab-out');
    const cabResult = await handlers.get('archive:extract')(null, { filePath: cabPath, outputDir: cabOut });
    assert(cabResult.ok === true, `CAB extract ok (${cabResult.error || cabResult.message})`);
    assert(countFiles(cabOut) === 1, 'CAB extracted its file');
  } else {
    console.log('skip - makecab.exe unavailable for CAB fixture');
  }

  /* ---------- Optional ISO fixture ---------- */

  const isoFixture = process.env.OPENZIP_ISO_FIXTURE;
  if (isoFixture && fs.existsSync(isoFixture)) {
    const openIso = await handlers.get('archive:read')(null, isoFixture);
    assert(openIso.ok === true, `archive:read returns ok for ISO (${openIso.error || ''})`);
    assert(openIso.format === 'iso', 'ISO format detected');

    const isoOut = path.join(work, 'iso-out');
    const isoResult = await handlers.get('archive:extract')(null, {
      filePath: isoFixture,
      outputDir: isoOut,
    });
    assert(isoResult.ok === true, `ISO extract ok (${isoResult.error || isoResult.message})`);
    assert(countFiles(isoOut) > 0, 'ISO extracted files');
  } else {
    console.log('skip - ISO fixture not provided (set OPENZIP_ISO_FIXTURE to test ISO)');
  }

  /* ---------- Optional RAR fixture (RAR cannot be created by 7-Zip) ---------- */

  const rarFixture = process.env.OPENZIP_RAR_FIXTURE;
  if (rarFixture && fs.existsSync(rarFixture)) {
    const openRar = await handlers.get('archive:read')(null, rarFixture);
    assert(openRar.ok === true, `archive:read returns ok for RAR (${openRar.error || ''})`);
    assert(openRar.format === 'rar', 'RAR format detected');
    const rarOut = path.join(work, 'rar-out');
    const rarResult = await handlers.get('archive:extract')(null, {
      filePath: rarFixture,
      outputDir: rarOut,
    });
    assert(rarResult.ok === true, `RAR extract ok (${rarResult.error || rarResult.message})`);
    assert(countFiles(rarOut) > 0, 'RAR extracted files');
  } else {
    console.log('skip - RAR fixture not provided (set OPENZIP_RAR_FIXTURE to test RAR)');
  }

  /* ---------- Empty zip ---------- */

  const emptyPath = path.join(work, 'empty.zip');
  new AdmZip().writeZip(emptyPath);
  const empty = await handlers.get('archive:read')(null, emptyPath);
  assert(empty.ok === true && empty.format === 'zip', 'empty ZIP recognised');

  /* ---------- SCS HashFS ---------- */

  const scsPath = path.join(work, 'fake.scs');
  const scsBytes = Buffer.concat([
    Buffer.from('SCS#'),
    Buffer.from([0x02, 0, 0, 0, 0x43, 0x49, 0x54, 0x59]),
    Buffer.from('not a real hashfs archive'),
  ]);
  fs.writeFileSync(scsPath, scsBytes);

  const openScs = await handlers.get('archive:read')(null, scsPath);
  assert(openScs.ok === true, 'archive:read returns ok for an SCS container');
  assert(openScs.format === 'scs', 'SCS# magic treated as HashFS');
  assert(openScs.entries.length === 1, 'SCS exposes a single container entry');
  assert(openScs.entries[0].kind === 'container', 'SCS container entry kind');
  assert(openScs.entries[0].name === 'fake.scs', 'container entry named after the archive');

  const scsEdit = await handlers.get('archive:readFile')(null, {
    archivePath: scsPath,
    entryName: 'fake.scs',
  });
  assert(
    scsEdit.success === false && /HashFS/i.test(scsEdit.error),
    'HashFS containers are read-only in the editor',
  );

  const scsInject = await handlers.get('archive:addFiles')(null, {
    archivePath: scsPath,
    filePaths: [dropFile],
    targetDir: '',
  });
  assert(
    scsInject.success === false &&
      scsInject.error === 'This archive format is read-only. Cannot inject files.',
    'HashFS injection is rejected with the read-only message',
  );

  const scsOut = path.join(work, 'scs-out');
  const scsResult = await handlers.get('archive:extract')(null, {
    filePath: scsPath,
    outputDir: scsOut,
    entries: ['fake.scs'],
  });
  console.log(`     SCS extract result: ${JSON.stringify({ ok: scsResult.ok, error: scsResult.error })}`);
  assert(scsResult.ok === false, 'garbage HashFS is rejected by the extractor');
  assert(
    typeof scsResult.error === 'string' && /extractor/i.test(scsResult.error),
    'SCS failure routed to the bundled SCS extractor',
  );

  /* ---------- Error paths ---------- */

  const missing = await handlers.get('archive:read')(null, path.join(work, 'nope.zip'));
  assert(missing.ok === false && /not found/i.test(missing.error), 'missing file reports an error');

  const badArchive = path.join(work, 'broken.rar');
  fs.writeFileSync(badArchive, Buffer.from('Rar! not really a rar archive'));
  const broken = await handlers.get('archive:read')(null, badArchive);
  assert(broken.ok === false && typeof broken.error === 'string', 'corrupt archive reports a 7-Zip error');

  console.log(`\nWork dir: ${work}`);
}

main()
  .catch((error) => {
    console.error('UNEXPECTED FAILURE', error);
    process.exitCode = 1;
  })
  .finally(() => {
    // Leave fixtures on disk for inspection when something failed.
    if (!process.exitCode) {
      fs.rmSync(work, { recursive: true, force: true });
      console.log('Cleaned up fixtures.');
    }
  });

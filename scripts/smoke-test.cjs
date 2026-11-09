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
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const APP_ROOT = path.join(__dirname, '..');
const AdmZip = require(path.join(APP_ROOT, 'node_modules', 'adm-zip'));
const SEVEN_ZIP = path.join(APP_ROOT, 'bin', '7z', '7z.exe');
const { sweepStaleTempFolders } = require(path.join(APP_ROOT, 'temp-cleanup.cjs'));
const { createSettingsStore } = require(path.join(APP_ROOT, 'app-settings.cjs'));
const smokeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'openzip-smoke-userdata-'));

const handlers = new Map();
const listeners = new Map();
const dialogCalls = [];
let dialogResult = { canceled: true, filePaths: [] };
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
        getPath: () => smokeUserData,
        quit: () => {},
      },
      BrowserWindow: class {
        static getAllWindows() {
          return [];
        }
      },
      dialog: {
        showOpenDialog: async (_win, options) => {
          dialogCalls.push(options);
          return dialogResult;
        },
      },
      ipcMain: {
        handle: (channel, fn) => handlers.set(channel, fn),
        on: (channel, fn) => listeners.set(channel, fn),
      },
      nativeImage: {
        createFromPath: () => ({ isEmpty: () => false }),
        createFromBuffer: () => ({ isEmpty: () => false }),
      },
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
  for (const channel of [
    'dialog:openArchive',
    'dialog:selectOutputDir',
    'dialog:dropChoice',
    'archive:read',
    'archive:extract',
  ]) {
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
    newContent: 'OpenZip smoke test Ã¢â‚¬â€ edited\n',
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

  const embeddedArchiveSource = path.join(work, 'embedded-archive.zip');
  const embeddedArchive = new AdmZip();
  embeddedArchive.addFile('payload.txt', Buffer.from('archive added as a normal file'));
  embeddedArchive.writeZip(embeddedArchiveSource);
  const embeddedArchiveBytes = fs.readFileSync(embeddedArchiveSource);
  const addArchiveResult = await handlers.get('archive:addFiles')(null, {
    archivePath: zipPath,
    filePaths: [embeddedArchiveSource],
    targetDir: 'archives',
  });
  assert(
    addArchiveResult.success === true,
    `ZIP addFiles injects a ZIP file as a normal entry (${addArchiveResult.error || ''})`,
  );
  const archiveInjectedRead = await handlers.get('archive:read')(null, zipPath);
  assert(
    archiveInjectedRead.ok === true &&
      archiveInjectedRead.entries.some((entry) => entry.name === 'archives/embedded-archive.zip'),
    'injected ZIP archive appears in the archive listing',
  );
  const embeddedOut = path.join(work, 'embedded-archive-out');
  const embeddedExtract = await handlers.get('archive:extract')(null, {
    filePath: zipPath,
    outputDir: embeddedOut,
    entries: ['archives/embedded-archive.zip'],
  });
  assert(
    embeddedExtract.ok === true &&
      fs
        .readFileSync(path.join(embeddedOut, 'archives', 'embedded-archive.zip'))
        .equals(embeddedArchiveBytes),
    'injected ZIP archive extracts byte-identical',
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

  /* ---------- Drag-out preparation ---------- */

  const dragSession = 'smoke-drag-1';
  const dragResult = await handlers.get('archive:prepareDrag')(null, {
    sessionId: dragSession,
    archivePath: zipPath,
    roots: ['readme.txt', 'injected/'],
    entries: ['readme.txt', 'injected/dropped.txt'],
  });
  assert(
    dragResult.success === true,
    `drag preparation extracts selected entries (${dragResult.error || ''})`,
  );
  assert(
    typeof dragResult.tempDir === 'string' &&
      path.basename(dragResult.tempDir).startsWith('openzip-drag-'),
    'drag preparation uses an openzip-drag temp folder',
  );
  assert(
    fs.existsSync(path.join(dragResult.tempDir, 'readme.txt')) &&
      fs.existsSync(path.join(dragResult.tempDir, 'injected', 'dropped.txt')),
    'drag preparation preserves selected folder structure',
  );
  assert(
    Array.isArray(dragResult.items) &&
      dragResult.items.some((item) => item.endsWith('readme.txt')) &&
      dragResult.items.some((item) => item.endsWith(`${path.sep}injected`)),
    'drag items contain the selected file and folder',
  );

  let dragPayload = null;
  let dragErrors = 0;
  const fakeDragEvent = {
    sender: {
      startDrag: (item) => {
        dragPayload = item;
      },
      send: (channel) => {
        if (channel === 'archive:dragError') dragErrors += 1;
      },
    },
  };
  listeners.get('archive:startDrag')(fakeDragEvent, {
    sessionId: dragSession,
    signature: dragResult.signature,
  });
  assert(dragPayload !== null && dragErrors === 0, 'startDrag is called with a prepared session');
  assert(
    dragPayload && (Array.isArray(dragPayload.files) || typeof dragPayload.file === 'string'),
    'startDrag payload contains real file paths',
  );
  assert(dragPayload && dragPayload.icon && !dragPayload.icon.isEmpty(), 'startDrag has a non-empty icon');

  const dragCleanup = await handlers.get('archive:cleanupDrag')(null, { sessionId: dragSession });
  assert(dragCleanup.success === true, 'drag cleanup succeeds');
  assert(!fs.existsSync(dragResult.tempDir), 'drag temp folder is removed on cleanup');

  const cappedSession = 'smoke-drag-cap';
  const capped = await handlers.get('archive:prepareDrag')(null, {
    sessionId: cappedSession,
    archivePath: zipPath,
    roots: ['readme.txt'],
    entries: ['readme.txt'],
    automatic: true,
    selectionBytes: 201 * 1024 * 1024,
  });
  assert(
    capped.success === false && capped.skipped === true,
    'automatic preparation is skipped above the 200 MB cap',
  );
  assert(
    !fs.existsSync(path.join(os.tmpdir(), `openzip-drag-${cappedSession}`)),
    'capped selection is not pre-extracted',
  );
  await handlers.get('archive:cleanupDrag')(null, { sessionId: cappedSession });

  const reuseSession = 'smoke-drag-reuse';
  const firstReuse = await handlers.get('archive:prepareDrag')(null, {
    sessionId: reuseSession,
    archivePath: zipPath,
    roots: ['readme.txt'],
    entries: ['readme.txt'],
  });
  assert(firstReuse.success === true, 'reuse test initial preparation succeeds');
  const reusedFile = path.join(firstReuse.tempDir, 'readme.txt');
  const firstMtime = fs.statSync(reusedFile).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 80));

  const secondReuse = await handlers.get('archive:prepareDrag')(null, {
    sessionId: reuseSession,
    archivePath: zipPath,
    roots: ['readme.txt', 'injected/'],
    entries: ['readme.txt', 'injected/dropped.txt'],
  });
  assert(secondReuse.success === true, 'reuse test incremental preparation succeeds');
  assert(secondReuse.tempDir === firstReuse.tempDir, 'reuse test keeps the same session folder');
  assert(fs.existsSync(reusedFile), 'reuse test retains the already-extracted file');
  assert(
    fs.statSync(reusedFile).mtimeMs === firstMtime,
    'reuse test does not re-extract an existing file',
  );
  assert(
    fs.existsSync(path.join(secondReuse.tempDir, 'injected', 'dropped.txt')),
    'reuse test extracts only the newly selected file',
  );
  await handlers.get('archive:cleanupDrag')(null, { sessionId: reuseSession });

  // Startup sweep: stale managed folders go, everything else stays.
  const sweepRoot = path.join(work, 'sweep-temp');
  fs.mkdirSync(sweepRoot, { recursive: true });
  const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const staleNames = [
    'openzip-drag-old',
    'openzip-edit-old',
    'openzip-add-old',
    'openzip-nested-old',
  ];
  const freshNames = ['openzip-drag-fresh', 'openzip-nested-fresh'];
  const untouchedNames = ['openzip-drag', 'openzip-dragx-old', 'other-folder-old'];
  for (const name of [...staleNames, ...freshNames, ...untouchedNames]) {
    fs.mkdirSync(path.join(sweepRoot, name));
  }
  for (const name of [...staleNames, ...untouchedNames]) {
    fs.utimesSync(path.join(sweepRoot, name), oldTime, oldTime);
  }
  fs.writeFileSync(path.join(sweepRoot, 'openzip-drag-file'), 'not a folder');
  fs.utimesSync(path.join(sweepRoot, 'openzip-drag-file'), oldTime, oldTime);

  const sweep = await sweepStaleTempFolders({ tmpDir: sweepRoot });
  assert(
    staleNames.every((name) => !fs.existsSync(path.join(sweepRoot, name))) &&
      staleNames.every((name) => sweep.removed.includes(name)),
    'startup sweep removes stale managed temp folders',
  );
  assert(
    freshNames.every((name) => fs.existsSync(path.join(sweepRoot, name))),
    'startup sweep keeps recent managed temp folders',
  );
  assert(
    untouchedNames.every((name) => fs.existsSync(path.join(sweepRoot, name))) &&
      fs.existsSync(path.join(sweepRoot, 'openzip-drag-file')),
    'startup sweep does not touch other folders or files',
  );

  // Cache invalidation after archive:saveFile.
  const saveDragSession = 'smoke-drag-save';
  const beforeSaveDrag = await handlers.get('archive:prepareDrag')(null, {
    sessionId: saveDragSession,
    archivePath: zipPath,
    roots: ['readme.txt'],
    entries: ['readme.txt'],
  });
  assert(beforeSaveDrag.success === true, 'save-invalidation initial preparation succeeds');
  const savedText = 'drag cache refreshed after save\n';
  const saveResult = await handlers.get('archive:saveFile')(null, {
    archivePath: zipPath,
    entryName: 'readme.txt',
    newContent: savedText,
  });
  assert(saveResult.success === true, 'save-invalidation saveFile succeeds');
  const afterSaveDrag = await handlers.get('archive:prepareDrag')(null, {
    sessionId: saveDragSession,
    archivePath: zipPath,
    roots: ['readme.txt'],
    entries: ['readme.txt'],
  });
  assert(afterSaveDrag.success === true, 'save-invalidation re-preparation succeeds');
  assert(
    fs.readFileSync(path.join(afterSaveDrag.tempDir, 'readme.txt'), 'utf8') === savedText,
    'save-invalidation re-extracts the new saveFile content',
  );
  await handlers.get('archive:cleanupDrag')(null, { sessionId: saveDragSession });

  // Cache invalidation after archive:addFiles.
  const addDragSession = 'smoke-drag-add';
  const beforeAddDrag = await handlers.get('archive:prepareDrag')(null, {
    sessionId: addDragSession,
    archivePath: zipPath,
    roots: ['readme.txt'],
    entries: ['readme.txt'],
  });
  assert(beforeAddDrag.success === true, 'add-invalidation initial preparation succeeds');
  const replacementDir = path.join(work, 'replacement');
  fs.mkdirSync(replacementDir, { recursive: true });
  const replacementPath = path.join(replacementDir, 'readme.txt');
  const addedText = 'drag cache refreshed after add\n';
  fs.writeFileSync(replacementPath, addedText);
  const addResult = await handlers.get('archive:addFiles')(null, {
    archivePath: zipPath,
    filePaths: [replacementPath],
    targetDir: '',
  });
  assert(addResult.success === true, 'add-invalidation addFiles succeeds');
  const afterAddDrag = await handlers.get('archive:prepareDrag')(null, {
    sessionId: addDragSession,
    archivePath: zipPath,
    roots: ['readme.txt'],
    entries: ['readme.txt'],
  });
  assert(afterAddDrag.success === true, 'add-invalidation re-preparation succeeds');
  assert(
    fs.readFileSync(path.join(afterAddDrag.tempDir, 'readme.txt'), 'utf8') === addedText,
    'add-invalidation re-extracts the replaced file content',
  );
  await handlers.get('archive:cleanupDrag')(null, { sessionId: addDragSession });

  // Cache invalidation when the archive changes outside the app handlers (stat path).
  const statDragSession = 'smoke-drag-stat';
  const beforeStatDrag = await handlers.get('archive:prepareDrag')(null, {
    sessionId: statDragSession,
    archivePath: zipPath,
    roots: ['readme.txt'],
    entries: ['readme.txt'],
  });
  assert(beforeStatDrag.success === true, 'stat-invalidation initial preparation succeeds');
  const externalZip = new AdmZip(zipPath);
  externalZip.updateFile('readme.txt', Buffer.from('drag cache refreshed externally\n'));
  externalZip.writeZip(zipPath);
  const afterStatDrag = await handlers.get('archive:prepareDrag')(null, {
    sessionId: statDragSession,
    archivePath: zipPath,
    roots: ['readme.txt'],
    entries: ['readme.txt'],
  });
  assert(afterStatDrag.success === true, 'stat-invalidation re-preparation succeeds');
  assert(
    fs.readFileSync(path.join(afterStatDrag.tempDir, 'readme.txt'), 'utf8') ===
      'drag cache refreshed externally\n',
    'stat-invalidation detects archive size/mtime changes',
  );
  await handlers.get('archive:cleanupDrag')(null, { sessionId: statDragSession });

  // Nested ZIP inside a ZIP: open, list, reuse, invalidate, edit, write back, cleanup.
  const nestedOuterPath = path.join(work, 'nested-outer.zip');
  const makeInnerZip = (text) => {
    const inner = new AdmZip();
    inner.addFile('inside.txt', Buffer.from(text));
    return inner.toBuffer();
  };
  const outerZip = new AdmZip();
  outerZip.addFile('inner.zip', makeInnerZip('nested v1'));
  outerZip.addFile('normal.txt', Buffer.from('normal'));
  outerZip.writeZip(nestedOuterPath);

  const outerRead = await handlers.get('archive:read')(null, nestedOuterPath);
  assert(outerRead.ok === true, 'nested test reads the outer archive');
  assert(
    outerRead.entries.some((entry) => entry.name === 'inner.zip'),
    'nested test outer archive lists the inner archive',
  );

  const nestedFirst = await handlers.get('archive:openNested')(null, {
    outerArchivePath: nestedOuterPath,
    entryName: 'inner.zip',
    confirmed: true,
  });
  assert(nestedFirst.ok === true, 'nested test opens the inner archive');
  assert(
    /openzip-nested-/.test(nestedFirst.filePath),
    'nested test extracts into an openzip-nested folder',
  );
  const nestedRead = await handlers.get('archive:read')(null, nestedFirst.filePath);
  assert(
    nestedRead.ok === true &&
      nestedRead.entries.some((entry) => entry.name === 'inside.txt'),
    'nested test reads the inner archive listing',
  );
  const nestedRoot = path.dirname(nestedFirst.filePath);

  const nestedSecond = await handlers.get('archive:openNested')(null, {
    outerArchivePath: nestedOuterPath,
    entryName: 'inner.zip',
    confirmed: true,
  });
  assert(
    nestedSecond.ok === true &&
      nestedSecond.cached === true &&
      nestedSecond.filePath === nestedFirst.filePath,
    'nested test reuses the cached extracted archive',
  );

  const replacementOuter = new AdmZip(nestedOuterPath);
  replacementOuter.updateFile('inner.zip', makeInnerZip('nested v2'));
  replacementOuter.writeZip(nestedOuterPath);
  const nestedAfterChange = await handlers.get('archive:openNested')(null, {
    outerArchivePath: nestedOuterPath,
    entryName: 'inner.zip',
    confirmed: true,
  });
  assert(
    nestedAfterChange.ok === true && nestedAfterChange.cached === false,
    'nested test invalidates the cache after the outer archive changes',
  );
  assert(
    new AdmZip(nestedAfterChange.filePath).readAsText('inside.txt') === 'nested v2',
    'nested test re-extracts the updated inner archive',
  );
  assert(!fs.existsSync(nestedRoot), 'nested test removes the stale nested folder');

  const nestedSave = await handlers.get('archive:saveFile')(null, {
    archivePath: nestedAfterChange.filePath,
    entryName: 'inside.txt',
    newContent: 'nested edited',
  });
  assert(nestedSave.success === true, 'nested archives allow saveFile into the inner copy');
  const nestedSavedRead = await handlers.get('archive:readFile')(null, {
    archivePath: nestedAfterChange.filePath,
    entryName: 'inside.txt',
  });
  assert(
    nestedSavedRead.success === true && nestedSavedRead.content === 'nested edited',
    'nested saveFile updates the extracted inner archive',
  );
  const nestedAdd = await handlers.get('archive:addFiles')(null, {
    archivePath: nestedAfterChange.filePath,
    filePaths: [replacementPath],
    targetDir: '',
  });
  assert(nestedAdd.success === true, 'nested archives allow addFiles into the inner copy');
  const nestedAddedRead = await handlers.get('archive:read')(null, nestedAfterChange.filePath);
  assert(
    nestedAddedRead.ok === true &&
      nestedAddedRead.entries.some((entry) => entry.name === 'readme.txt'),
    'nested addFiles adds the file to the extracted inner archive',
  );

  const nestedSizeBeforeWriteBack = fs.statSync(nestedAfterChange.filePath).size;
  const writeBack = await handlers.get('archive:writeBackNested')(null, {
    outerArchivePath: nestedOuterPath,
    entryName: 'inner.zip',
    nestedFilePath: nestedAfterChange.filePath,
    confirmed: true,
  });
  assert(writeBack.ok === true, 'nested write-back succeeds');
  assert(
    !fs.existsSync(path.dirname(nestedAfterChange.filePath)),
    'nested write-back invalidates the extracted nested folder',
  );

  const outerAfterWriteBack = await handlers.get('archive:read')(null, nestedOuterPath);
  const outerInnerEntry = outerAfterWriteBack.entries.find((entry) => entry.name === 'inner.zip');
  assert(
    outerAfterWriteBack.ok === true && outerInnerEntry?.size === nestedSizeBeforeWriteBack,
    'nested write-back updates the inner entry size in the outer archive',
  );

  const nestedReopened = await handlers.get('archive:openNested')(null, {
    outerArchivePath: nestedOuterPath,
    entryName: 'inner.zip',
    confirmed: true,
  });
  assert(
    nestedReopened.ok === true && nestedReopened.cached === false,
    'nested write-back invalidates the nested cache',
  );
  const reopenedInner = new AdmZip(nestedReopened.filePath);
  assert(
    reopenedInner.readAsText('inside.txt') === 'nested edited' &&
      reopenedInner.readAsText('readme.txt') === fs.readFileSync(replacementPath, 'utf8'),
    'nested write-back persists edits and added files inside the outer archive',
  );

  const beforeFailureHash = crypto.createHash('sha256').update(fs.readFileSync(nestedOuterPath)).digest('hex');
  const failedWriteBack = await handlers.get('archive:writeBackNested')(null, {
    outerArchivePath: nestedOuterPath,
    entryName: 'inner.zip',
    nestedFilePath: path.join(work, 'missing-inner.zip'),
    confirmed: true,
  });
  const afterFailureHash = crypto.createHash('sha256').update(fs.readFileSync(nestedOuterPath)).digest('hex');
  assert(
    failedWriteBack.ok === false && beforeFailureHash === afterFailureHash,
    'failed nested write-back leaves the original outer archive intact',
  );

  // ZIP-based .scs is writable like ZIP for nested editing.
  const zipScsOuter = path.join(work, 'zipscs-outer.zip');
  const zipScsArchive = new AdmZip();
  zipScsArchive.addFile('inner.scs', makeInnerZip('zipscs v1'));
  zipScsArchive.writeZip(zipScsOuter);
  const zipScsRead = await handlers.get('archive:read')(null, zipScsOuter);
  assert(
    zipScsRead.ok && zipScsRead.entries.some((entry) => entry.name === 'inner.scs'),
    'ZIP-based scs nested fixture is listed',
  );
  const zipScsNested = await handlers.get('archive:openNested')(null, {
    outerArchivePath: zipScsOuter,
    entryName: 'inner.scs',
    confirmed: true,
  });
  assert(zipScsNested.ok === true, 'ZIP-based scs opens as a nested archive');
  const zipScsSave = await handlers.get('archive:saveFile')(null, {
    archivePath: zipScsNested.filePath,
    entryName: 'inside.txt',
    newContent: 'zipscs edited',
  });
  assert(zipScsSave.success === true, 'ZIP-based scs allows nested editing');
  const zipScsWriteBack = await handlers.get('archive:writeBackNested')(null, {
    outerArchivePath: zipScsOuter,
    entryName: 'inner.scs',
    nestedFilePath: zipScsNested.filePath,
    confirmed: true,
  });
  assert(zipScsWriteBack.ok === true, 'ZIP-based scs writes back into its outer archive');
  const zipScsReopened = await handlers.get('archive:openNested')(null, {
    outerArchivePath: zipScsOuter,
    entryName: 'inner.scs',
    confirmed: true,
  });
  assert(
    zipScsReopened.ok === true &&
      new AdmZip(zipScsReopened.filePath).readAsText('inside.txt') === 'zipscs edited',
    'ZIP-based scs nested write-back persists the edit',
  );

  // A 7z outer archive with a writable inner ZIP.
  const sevenInnerPath = path.join(work, 'seven-inner.zip');
  const sevenInner = new AdmZip();
  sevenInner.addFile('inside.txt', Buffer.from('seven v1'));
  sevenInner.writeZip(sevenInnerPath);
  const sevenOuterPath = path.join(work, 'nested-outer.7z');
  fs.writeFileSync(path.join(work, 'seven-normal.txt'), 'normal');
  const makeSevenOuter = spawnSync(
    SEVEN_ZIP,
    ['a', '-ms=on', sevenOuterPath, path.basename(sevenInnerPath), 'seven-normal.txt'],
    { cwd: work, windowsHide: true, encoding: 'utf8' },
  );
  if (makeSevenOuter.status === 0 && fs.existsSync(sevenOuterPath)) {
    const sevenRead = await handlers.get('archive:read')(null, sevenOuterPath);
    const sevenEntry = sevenRead.entries?.find((entry) => entry.name === 'seven-inner.zip');
    assert(sevenRead.ok && sevenEntry, 'nested 7z outer lists the inner ZIP');
    const sevenNested = await handlers.get('archive:openNested')(null, {
      outerArchivePath: sevenOuterPath,
      entryName: 'seven-inner.zip',
      confirmed: true,
    });
    assert(sevenNested.ok === true, 'nested 7z outer opens the inner ZIP');
    const sevenSave = await handlers.get('archive:saveFile')(null, {
      archivePath: sevenNested.filePath,
      entryName: 'inside.txt',
      newContent: 'seven edited',
    });
    assert(sevenSave.success === true, 'nested inner file saves inside a 7z outer');
    const sevenWarning = await handlers.get('archive:writeBackNested')(null, {
      outerArchivePath: sevenOuterPath,
      entryName: 'seven-inner.zip',
      nestedFilePath: sevenNested.filePath,
      confirmed: false,
    });
    assert(
      sevenWarning.ok === false &&
        sevenWarning.needsWarning === true &&
        sevenWarning.solid === true,
      'solid 7z outer requests a write-back warning first',
    );
    const sevenWriteBack = await handlers.get('archive:writeBackNested')(null, {
      outerArchivePath: sevenOuterPath,
      entryName: 'seven-inner.zip',
      nestedFilePath: sevenNested.filePath,
      confirmed: true,
    });
    assert(sevenWriteBack.ok === true, 'nested write-back updates a 7z outer archive');
    const sevenReopened = await handlers.get('archive:openNested')(null, {
      outerArchivePath: sevenOuterPath,
      entryName: 'seven-inner.zip',
      confirmed: true,
    });
    assert(
      sevenReopened.ok === true &&
        new AdmZip(sevenReopened.filePath).readAsText('inside.txt') === 'seven edited',
      '7z nested write-back persists the inner edit',
    );
  } else {
    console.log('skip - 7z outer fixture could not be created');
  }

  // A TAR outer archive with a writable inner ZIP.
  const tarInnerPath = path.join(work, 'tar-inner.zip');
  const tarInner = new AdmZip();
  tarInner.addFile('inside.txt', Buffer.from('tar v1'));
  tarInner.writeZip(tarInnerPath);
  const tarOuterPath = path.join(work, 'nested-outer.tar');
  const makeTarOuter = spawnSync(
    SEVEN_ZIP,
    ['a', '-ttar', tarOuterPath, path.basename(tarInnerPath)],
    { cwd: work, windowsHide: true, encoding: 'utf8' },
  );
  if (makeTarOuter.status === 0 && fs.existsSync(tarOuterPath)) {
    const tarRead = await handlers.get('archive:read')(null, tarOuterPath);
    assert(
      tarRead.ok && tarRead.entries.some((entry) => entry.name === 'tar-inner.zip'),
      'nested TAR outer lists the inner ZIP',
    );
    const tarNested = await handlers.get('archive:openNested')(null, {
      outerArchivePath: tarOuterPath,
      entryName: 'tar-inner.zip',
      confirmed: true,
    });
    assert(tarNested.ok === true, 'nested TAR outer opens the inner ZIP');
    const tarSave = await handlers.get('archive:saveFile')(null, {
      archivePath: tarNested.filePath,
      entryName: 'inside.txt',
      newContent: 'tar edited',
    });
    assert(tarSave.success === true, 'nested inner file saves inside a TAR outer');
    const tarWriteBack = await handlers.get('archive:writeBackNested')(null, {
      outerArchivePath: tarOuterPath,
      entryName: 'tar-inner.zip',
      nestedFilePath: tarNested.filePath,
      confirmed: true,
    });
    assert(tarWriteBack.ok === true, 'nested write-back updates a TAR outer archive');
    const tarReopened = await handlers.get('archive:openNested')(null, {
      outerArchivePath: tarOuterPath,
      entryName: 'tar-inner.zip',
      confirmed: true,
    });
    assert(
      tarReopened.ok === true &&
        new AdmZip(tarReopened.filePath).readAsText('inside.txt') === 'tar edited',
      'TAR nested write-back persists the inner edit',
    );
  } else {
    console.log('skip - TAR outer fixture could not be created');
  }

  // Read-only outer archive: a CAB containing a writable inner ZIP.
  const cabSource = new AdmZip();
  cabSource.addFile('inside.txt', Buffer.from('cab inner'));
  const cabInnerPath = path.join(work, 'cab-inner.zip');
  cabSource.writeZip(cabInnerPath);
  const nestedCabPath = path.join(work, 'nested-outer.cab');
  const makeNestedCab = spawnSync('makecab.exe', [cabInnerPath, nestedCabPath], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (makeNestedCab.status === 0 && fs.existsSync(nestedCabPath)) {
    const cabRead = await handlers.get('archive:read')(null, nestedCabPath);
    const cabEntry = cabRead.entries?.find((entry) => entry.name.endsWith('cab-inner.zip'));
    if (cabRead.ok && cabEntry) {
      const cabNested = await handlers.get('archive:openNested')(null, {
        outerArchivePath: nestedCabPath,
        entryName: cabEntry.name,
        confirmed: true,
      });
      if (cabNested.ok) {
        const cabNestedSave = await handlers.get('archive:saveFile')(null, {
          archivePath: cabNested.filePath,
          entryName: 'inside.txt',
          newContent: 'must not write',
        });
        assert(
          cabNestedSave.success === false &&
            /outer archive is read-only/.test(cabNestedSave.error),
          'nested archives inside read-only CAB refuse saveFile',
        );
        const cabNestedAdd = await handlers.get('archive:addFiles')(null, {
          archivePath: cabNested.filePath,
          filePaths: [replacementPath],
          targetDir: '',
        });
        assert(
          cabNestedAdd.success === false &&
            /outer archive is read-only/.test(cabNestedAdd.error),
          'nested archives inside read-only CAB refuse addFiles',
        );
      }
    }
  }

  const nestedFinal = await handlers.get('archive:openNested')(null, {
    outerArchivePath: nestedOuterPath,
    entryName: 'inner.zip',
    confirmed: true,
  });
  const nestedCleanup = await handlers.get('archive:cleanupNested')(null);
  assert(nestedCleanup.success === true, 'nested cleanup succeeds');
  assert(
    nestedFinal.ok === true && !fs.existsSync(path.dirname(nestedFinal.filePath)),
    'nested cleanup removes the extracted folder',
  );

  const traversalSession = 'smoke-drag-bad';
  const traversalDrag = await handlers.get('archive:prepareDrag')(null, {
    sessionId: traversalSession,
    archivePath: zipPath,
    roots: ['../escape.txt'],
    entries: ['../escape.txt'],
  });
  assert(
    traversalDrag.success === false && /invalid|escape/i.test(traversalDrag.error),
    'drag preparation rejects path traversal entries',
  );
  assert(
    !fs.existsSync(path.join(os.tmpdir(), 'escape.txt')) &&
      !fs.existsSync(path.join(os.tmpdir(), `openzip-drag-${traversalSession}`)),
    'rejected traversal did not create files outside the drag temp folder',
  );
  await handlers.get('archive:cleanupDrag')(null, { sessionId: traversalSession });

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
  if (makeNestedCab.status === 0 && fs.existsSync(nestedCabPath)) {
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
    scsEdit.success === false && /HashFS|cannot be read/i.test(scsEdit.error),
    'unindexable HashFS containers cannot be read natively',
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

  /* ---------- Settings persistence ---------- */

  const settingsRoot = path.join(work, 'settings-store');
  const settingsDirA = path.join(work, 'settings-dir-a');
  const settingsDirB = path.join(work, 'settings-dir-b');
  fs.mkdirSync(settingsDirA, { recursive: true });
  fs.mkdirSync(settingsDirB, { recursive: true });
  const settingsFile = path.join(settingsRoot, 'settings.json');
  const settings = createSettingsStore({ userDataPath: settingsRoot });

  settings.load();
  assert(settings.get('lastOpenDir') === null, 'settings default to no last folder');
  assert(
    settings.set('lastOpenDir', settingsDirA) === true,
    'settings write the last open folder',
  );
  assert(
    settings.set('lastExtractDir', settingsDirB) === true,
    'settings write the last extract folder independently',
  );
  const settingsJson = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert(
    path.resolve(settingsJson.lastOpenDir) === path.resolve(settingsDirA) &&
      path.resolve(settingsJson.lastExtractDir) === path.resolve(settingsDirB),
    'settings JSON keeps both folders separate',
  );

  const settingsMtime = fs.statSync(settingsFile).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert(
    settings.set('lastOpenDir', settingsDirA) === false &&
      fs.statSync(settingsFile).mtimeMs === settingsMtime,
    'settings do not rewrite an unchanged folder',
  );

  const cachedOpenDir = settings.get('lastOpenDir');
  fs.writeFileSync(settingsFile, JSON.stringify({ lastOpenDir: settingsDirB }), 'utf8');
  assert(
    settings.get('lastOpenDir') === cachedOpenDir,
    'settings file is read only once per store',
  );

  const corruptRoot = path.join(work, 'settings-corrupt');
  fs.mkdirSync(corruptRoot, { recursive: true });
  fs.writeFileSync(path.join(corruptRoot, 'settings.json'), '{not valid json', 'utf8');
  const corruptSettings = createSettingsStore({ userDataPath: corruptRoot });
  assert(
    corruptSettings.get('lastOpenDir') === null,
    'corrupt settings are ignored',
  );
  assert(
    corruptSettings.set('lastOpenDir', settingsDirA) === true,
    'settings recover from corrupt JSON on the next write',
  );

  const missingDir = path.join(work, 'settings-missing-dir');
  const fallbackSettings = createSettingsStore({
    userDataPath: path.join(work, 'settings-fallback'),
  });
  fallbackSettings.set('lastOpenDir', missingDir);
  assert(
    fallbackSettings.get('lastOpenDir') === path.resolve(missingDir) &&
      fallbackSettings.getExistingDir('lastOpenDir') === null,
    'settings fall back when the remembered folder is missing',
  );
  fs.mkdirSync(missingDir, { recursive: true });
  assert(
    fallbackSettings.getExistingDir('lastOpenDir') === path.resolve(missingDir),
    'settings use the remembered folder once it exists again',
  );

  // Dialog integration: the archive read above remembered the fixture folder.
  dialogCalls.length = 0;
  dialogResult = { canceled: true, filePaths: [] };
  await handlers.get('dialog:openArchive')(null);
  assert(
    path.resolve(dialogCalls.at(-1)?.defaultPath) === path.resolve(work),
    'Open Archive dialog receives the last successfully opened folder',
  );

  const outputDir = path.join(work, 'settings-output');
  fs.mkdirSync(outputDir, { recursive: true });
  dialogResult = { canceled: false, filePaths: [outputDir] };
  const selectedOutput = await handlers.get('dialog:selectOutputDir')(null);
  assert(
    selectedOutput.filePath === path.resolve(outputDir),
    'Extract To dialog returns the selected folder',
  );
  dialogCalls.length = 0;
  dialogResult = { canceled: true, filePaths: [] };
  await handlers.get('dialog:selectOutputDir')(null);
  assert(
    path.resolve(dialogCalls.at(-1)?.defaultPath) === path.resolve(outputDir),
    'Extract To dialog receives its own last folder',
  );
  const appSettingsJson = JSON.parse(
    fs.readFileSync(path.join(smokeUserData, 'settings.json'), 'utf8'),
  );
  assert(
    path.resolve(appSettingsJson.lastOpenDir) === path.resolve(work) &&
      path.resolve(appSettingsJson.lastExtractDir) === path.resolve(outputDir),
    'application settings keep lastOpenDir and lastExtractDir separate',
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
      fs.rmSync(smokeUserData, { recursive: true, force: true });
      console.log('Cleaned up fixtures.');
    }
  });




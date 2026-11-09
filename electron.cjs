'use strict';

/**
 * OpenZip - Electron main process.
 *
 * Responsibilities:
 *  - create the desktop window (950x650) that hosts the Vite/React UI
 *  - expose archive dialogs over IPC
 *  - inspect/extract ZIP, RAR, 7z, TAR, GZ, BZ2, XZ, ISO, CAB and more with
 *    the bundled 7-Zip engine through node-7z
 *  - detect HashFS .scs containers from ETS2/ATS and unpack those with the
 *    bundled SCS extractor instead
 */

const { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } = require('electron');
const {
  readHashFsIndex,
  readHashFsEntry,
  writeHashFsCopy,
} = require('./scs-hashfs.cjs');
const { sweepStaleTempFolders } = require('./temp-cleanup.cjs');
const { createSettingsStore } = require('./app-settings.cjs');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const os = require('node:os');
const Seven = require('node-7z');
const AdmZip = require('adm-zip');

const DEV_SERVER_URL = 'http://localhost:5173';

/** HashFS archives (ETS2/ATS) start with the ASCII magic "SCS#". */
const SCS_MAGIC_HEX = '53435323';

/** ZIP local header / central directory / empty archive / data descriptor. */
const ZIP_SIGNATURES = new Set(['504b0304', '504b0506', '504b0708', '504b0500']);

/** Upper bound for files loaded into the in-app editor. */
const MAX_EDITABLE_BYTES = 20 * 1024 * 1024;

/** Upper bound for images loaded into the in-app viewer. */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** Error returned for archive formats that cannot be modified. */
const READ_ONLY_INJECT_ERROR = 'This archive format is read-only. Cannot inject files.';

/** Image types supported by the built-in viewer. */
const IMAGE_MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  bmp: 'image/bmp',
  webp: 'image/webp',
  ico: 'image/x-icon',
  gif: 'image/gif',
};

/** Archive extensions accepted from Windows command-line arguments. */
const ARCHIVE_ARG_EXTENSIONS = new Set([
  'zip',
  'scs',
  'rar',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'iso',
  'cab',
]);

/** Formats whose entries 7-Zip can update in place. */
const SEVEN_WRITABLE_EXTENSIONS = new Set(['7z', 'tar']);

/** Formats that are read-only for in-place editing. */
const READ_ONLY_EXTENSIONS = new Set(['rar', 'iso', 'udf', 'cab', 'gz', 'bz2', 'xz', 'zst', 'lzma', 'z']);

/** Extensions advertised in the open dialog and handled by the 7-Zip engine. */
const ARCHIVE_EXTENSIONS = ['rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab', 'zip'];

/** Where the bundled SCS extractor may live. */
const SCS_EXTRACTOR_NAMES = ['scs_extractor.exe', 'scs_extractor', 'extractor.exe', 'extractor'];

/** Where the bundled full 7-Zip build may live. */
const SEVEN_ZIP_NAMES = ['7z.exe', '7z'];

/**
 * Metadata from the last `archive:read`, reused during extraction to tell
 * files from folders (7-Zip emits the same event for both) and to size the
 * progress bar. Entries are bounded by the archive's own listing.
 */
const archiveMetaCache = new Map();
const scsIndexCache = new Map();
const dragSessions = new Map();
const dragRoots = new Set();
const DRAG_ROOT_PREFIX = 'openzip-drag-';
const DRAG_SESSION_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const DRAG_AUTO_PREP_LIMIT_BYTES = 200 * 1024 * 1024;
const DRAG_SESSION_PRUNE_LIMIT_BYTES = 512 * 1024 * 1024;
const NESTED_ROOT_PREFIX = 'openzip-nested-';
const NESTED_CONFIRM_BYTES = 300 * 1024 * 1024;
const NESTED_ARCHIVE_EXTENSIONS = new Set(['scs', 'zip', 'rar', '7z', 'tar', 'iso', 'cab']);
const NESTED_WRITABLE_FORMATS = new Set(['zip', '7z', 'tar']);
const NESTED_READ_ONLY_ERROR =
  'This archive is opened from inside another archive. Extract it to edit it.';
const nestedArchiveCache = new Map();
const nestedRoots = new Set();

let appSettings = null;
function getAppSettings() {
  if (!appSettings) {
    appSettings = createSettingsStore({ userDataPath: app.getPath('userData') });
    appSettings.load();
  }
  return appSettings;
}

function rememberArchiveFolder(filePath) {
  if (!filePath || isNestedArchivePath(filePath)) return;
  try {
    getAppSettings().set('lastOpenDir', path.dirname(path.resolve(filePath)));
  } catch {
    /* settings are best effort */
  }
}
const DRAG_ICON_FALLBACK =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOklEQVR42u3OMQEAAAgDoJnc/9CtwQ8FkGx3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4G8GmQABAVX0ZQAAAABJRU5ErkJggg==';
let mainWindow = null;
let cachedSevenBinary = null;

/* ------------------------------------------------------------------ */
/* System theme                                                        */
/* ------------------------------------------------------------------ */

// Always follow the Windows theme instead of forcing light/dark.
nativeTheme.themeSource = 'system';

function themeBackground() {
  return nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f0f0f0';
}

function themePayload() {
  return {
    dark: nativeTheme.shouldUseDarkColors,
    themeSource: nativeTheme.themeSource,
  };
}

// Keep the native window background and the renderer in sync with Windows.
nativeTheme.on('updated', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(themeBackground());
  mainWindow.webContents.send('theme:changed', themePayload());
});

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

function resolveWindowIcon() {
  const roots = [];
  if (app.isPackaged) {
    roots.push(path.join(process.resourcesPath, 'app.asar.unpacked'));
  }
  roots.push(__dirname, app.getAppPath());
  for (const extension of ['ico', 'png']) {
    for (const root of roots) {
      const candidate = path.join(root, 'docs', `icon.${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 950,
    height: 650,
    minWidth: 780,
    minHeight: 480,
    title: 'OpenZip',
    icon: resolveWindowIcon(),
    backgroundColor: themeBackground(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false,
      sandbox: false,
    },
  });

  const builtIndex = path.join(__dirname, 'dist', 'index.html');
  if (app.isPackaged && fs.existsSync(builtIndex)) {
    mainWindow.loadFile(builtIndex);
  } else {
    mainWindow.loadURL(DEV_SERVER_URL);
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('theme:changed', themePayload());
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('archive:progress', payload);
  }
}

/** Read the first bytes of a file without loading the whole archive. */
async function readMagic(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isScsMagic(buffer) {
  return buffer.length >= 4 && buffer.subarray(0, 4).toString('hex') === SCS_MAGIC_HEX;
}

function isZipMagic(buffer) {
  return buffer.length >= 4 && ZIP_SIGNATURES.has(buffer.subarray(0, 4).toString('hex'));
}

function toTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function extensionOf(filePath) {
  return path.extname(filePath).replace(/^\./, '').toLowerCase();
}

/** Find an archive path passed by Windows file association / "Open with". */
function findArchiveFromArgv(argv) {
  for (const argument of argv.slice(1)) {
    if (!argument || argument.startsWith('-')) continue;
    const candidate = path.resolve(argument);
    if (!ARCHIVE_ARG_EXTENSIONS.has(extensionOf(candidate))) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not a readable file */
    }
  }
  return null;
}

/** Returned once to the renderer so a file-association launch opens it. */
let pendingInitialArchive = findArchiveFromArgv(process.argv);

/** Directory holding the executables that must live outside the ASAR. */
function bundledBinRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'bin')
    : path.join(__dirname, 'bin');
}

/** Resolve the bundled 7-Zip executable, falling back to 7zip-bin. */
function resolveSevenZipBinary() {
  if (cachedSevenBinary) return cachedSevenBinary;

  const root = path.join(bundledBinRoot(), '7z');
  for (const name of SEVEN_ZIP_NAMES) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) {
      cachedSevenBinary = candidate;
      return candidate;
    }
  }

  // 7zip-bin ships the standalone 7za build. It handles 7z/zip/tar/gz/bz2/xz,
  // but not RAR or ISO, so it is only a last-resort fallback.
  try {
    const { path7za } = require('7zip-bin');
    if (path7za && fs.existsSync(path7za)) {
      cachedSevenBinary = path7za;
      return cachedSevenBinary;
    }
  } catch {
    /* optional dependency */
  }

  cachedSevenBinary = '7z';
  return cachedSevenBinary;
}

/** Cached CLI flavour per extractor path: 'legacy' or 'modern'. */
const scsToolProfiles = new Map();

/**
 * The official `scs_extractor` accepts `[filePath] [outputDir]`, while newer
 * SCS extractors (including the one bundled in bin/) require `--dest=<dir>`.
 * Probe `--help` once so both flavours work with the same UI.
 */
function probeScsToolProfile(toolPath) {
  if (scsToolProfiles.has(toolPath)) return Promise.resolve(scsToolProfiles.get(toolPath));

  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timer = null;

    const finish = (profile) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      scsToolProfiles.set(toolPath, profile);
      resolve(profile);
    };

    let child;
    try {
      child = spawn(toolPath, ['--help'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish('legacy');
      return;
    }

    const collect = (chunk) => {
      output += chunk.toString();
    };

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', () => finish('legacy'));
    child.on('close', () => finish(/--dest\b/.test(output) ? 'modern' : 'legacy'));

    // Never let a misbehaving tool stall the first extraction.
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(/--dest\b/.test(output) ? 'modern' : 'legacy');
    }, 5000);
  });
}

/** Bounded recursive file count, used when the extractor is silent. */
async function countFilesRecursive(root, cap = 100000) {
  let files = 0;
  const stack = [root];

  while (stack.length > 0 && files < cap) {
    const dir = stack.pop();
    const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if (item.isDirectory()) stack.push(path.join(dir, item.name));
      else if (item.isFile()) files += 1;
      if (files >= cap) break;
    }
  }

  return files;
}

function resolveScsExtractor() {
  const root = bundledBinRoot();

  for (const name of SCS_EXTRACTOR_NAMES) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function ensureDirectory(dirPath) {
  const stat = await fsp.stat(dirPath).catch(() => null);
  if (stat && !stat.isDirectory()) {
    throw new Error(`Output path is not a folder: ${dirPath}`);
  }
  await fsp.mkdir(dirPath, { recursive: true });
  return dirPath;
}

/* ------------------------------------------------------------------ */
/* In-app text editor file access                                      */
/* ------------------------------------------------------------------ */

/** Validate and normalise an archive entry path used for reading/writing. */
function normalizeEntryName(entryName) {
  if (typeof entryName !== 'string') throw new Error('No file was selected.');

  let normalized = entryName.trim().replace(/\\/g, '/');
  if (normalized.startsWith('./')) normalized = normalized.slice(2);

  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid archive entry path.');
  }

  return normalized;
}

function bufferToText(buffer, label) {
  if (buffer.length > MAX_EDITABLE_BYTES) {
    throw new Error(
      `${label} is too large to edit (${Math.round(buffer.length / 1024 / 1024)} MB, limit ${Math.round(
        MAX_EDITABLE_BYTES / 1024 / 1024,
      )} MB).`,
    );
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) {
    throw new Error(`${label} looks like a binary file and cannot be edited as text.`);
  }

  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readZipEntry(filePath, entryName, maxBytes = MAX_EDITABLE_BYTES) {
  let zip;
  try {
    zip = new AdmZip(filePath);
  } catch (error) {
    throw new Error(`Could not open ZIP archive: ${error.message}`);
  }

  const entry = zip.getEntry(entryName);
  if (!entry || entry.isDirectory) {
    throw new Error(`File not found in archive: ${entryName}`);
  }
  if (entry.header && entry.header.encrypted) {
    throw new Error('Encrypted archive entries cannot be opened.');
  }
  if (entry.header && Number.isFinite(entry.header.size) && entry.header.size > maxBytes) {
    throw new Error(`Entry is too large (limit ${Math.round(maxBytes / 1024 / 1024)} MB).`);
  }

  let data;
  try {
    data = entry.getData();
  } catch (error) {
    throw new Error(`Could not read ${entryName}: ${error.message}`);
  }

  if (data.length > maxBytes) {
    throw new Error(`Entry is too large (limit ${Math.round(maxBytes / 1024 / 1024)} MB).`);
  }

  return data;
}

/** Stream a single entry out of any 7-Zip supported archive. */
function readSevenZipEntry(filePath, entryName, maxBytes = MAX_EDITABLE_BYTES) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveSevenZipBinary(),
      ['x', filePath, '-so', '-y', '-spd', entryName],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const chunks = [];
    let size = 0;
    let stderr = '';
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        fail(new Error(`Entry is too large (limit ${Math.round(maxBytes / 1024 / 1024)} MB).`));
        return;
      }
      chunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', (error) => {
      fail(
        new Error(
          error.code === 'ENOENT'
            ? 'The bundled 7-Zip engine could not be started.'
            : `Could not read the archive entry: ${error.message}`,
        ),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const error = new Error('7-Zip could not read the archive entry.');
        error.stderr = stderr;
        fail(new Error(describeSevenError(error)));
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

async function readArchiveEntryBuffer(archivePath, entryName, maxBytes = MAX_EDITABLE_BYTES) {
  if (!archivePath) throw new Error('No archive is open.');
  const stat = await fsp.stat(archivePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('Archive no longer exists.');

  const name = normalizeEntryName(entryName);
  const magic = await readMagic(archivePath);

  if (isScsMagic(magic)) {
    const index = readScsIndex(archivePath, stat);
    if (!index.supported) {
      throw new Error(
        `This HashFS archive cannot be read natively (${index.reason || 'unsupported variant'}). Extract it with the SCS extractor.`,
      );
    }
    return readHashFsEntry(index, name, maxBytes);
  }

  return isZipMagic(magic)
    ? readZipEntry(archivePath, name, maxBytes)
    : readSevenZipEntry(archivePath, name, maxBytes);
}

async function readArchiveEntry(archivePath, entryName) {
  const name = normalizeEntryName(entryName);
  const buffer = await readArchiveEntryBuffer(archivePath, name, MAX_EDITABLE_BYTES);
  return bufferToText(buffer, name);
}

async function readImageEntry(archivePath, entryName) {
  const name = normalizeEntryName(entryName);
  const mime = IMAGE_MIME_TYPES[extensionOf(name)];
  if (!mime) throw new Error('This file type is not supported by the image viewer.');

  const buffer = await readArchiveEntryBuffer(archivePath, name, MAX_IMAGE_BYTES);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function runSevenZipUpdate(archivePath, entryName, workDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveSevenZipBinary(),
      ['u', archivePath, entryName, '-y', '-spd'],
      {
        cwd: workDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let output = '';
    let stderr = '';
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      fail(
        new Error(
          error.code === 'ENOENT'
            ? 'The bundled 7-Zip engine could not be started.'
            : `Could not update the archive: ${error.message}`,
        ),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        resolve();
        return;
      }
      const error = new Error('7-Zip could not update the archive.');
      error.stderr = stderr || output;
      fail(new Error(describeSevenError(error)));
    });
  });
}

/** Write a ZIP through a sibling temp file so failures cannot truncate it. */
async function writeZipAtomically(zip, filePath) {
  const tempPath = `${filePath}.openzip-${process.pid}-${Date.now()}.tmp`;
  try {
    zip.writeZip(tempPath);
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw new Error(`Could not write the archive: ${error.message}`);
  }
}

async function saveZipEntry(filePath, entryName, newContent) {
  let zip;
  try {
    zip = new AdmZip(filePath);
  } catch (error) {
    throw new Error(`Could not open ZIP archive: ${error.message}`);
  }

  const existing = zip.getEntry(entryName);
  if (existing && existing.header && existing.header.encrypted) {
    throw new Error('Encrypted archive entries cannot be edited.');
  }

  const data = Buffer.from(newContent, 'utf8');
  if (existing) {
    zip.updateFile(entryName, data);
  } else {
    zip.addFile(entryName, data);
  }

  await writeZipAtomically(zip, filePath);
}

async function saveSevenZipEntry(filePath, entryName, newContent) {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'openzip-edit-'));
  try {
    const destination = path.join(workDir, ...entryName.split('/'));
    if (!destination.startsWith(`${workDir}${path.sep}`)) {
      throw new Error('Invalid archive entry path.');
    }

    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, newContent, 'utf8');
    await runSevenZipUpdate(filePath, entryName, workDir);
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Keep extraction bookkeeping coherent after an in-place edit. */
async function refreshArchiveCacheAfterSave(archivePath, entryName, bytes) {
  const cached = archiveMetaCache.get(archivePath);
  if (!cached) return;

  const stat = await fsp.stat(archivePath).catch(() => null);
  if (stat) {
    cached.size = stat.size;
    cached.mtimeMs = stat.mtimeMs;
  }

  const entry = cached.entries.find((candidate) => candidate.name === entryName);
  if (entry) {
    entry.size = bytes;
    entry.time = Date.now();
  }
}

async function saveArchiveEntry(archivePath, entryName, newContent) {
  await ensureNestedWritable(archivePath);
  if (!archivePath) throw new Error('No archive is open.');
  if (typeof newContent !== 'string') throw new Error('No file content was provided.');

  const bytes = Buffer.byteLength(newContent, 'utf8');
  if (bytes > MAX_EDITABLE_BYTES) {
    throw new Error(`File is too large to save (limit ${Math.round(MAX_EDITABLE_BYTES / 1024 / 1024)} MB).`);
  }

  const stat = await fsp.stat(archivePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('Archive no longer exists.');

  const name = normalizeEntryName(entryName);
  const magic = await readMagic(archivePath);

  if (isScsMagic(magic)) {
    throw new Error('HashFS edits are saved through the mod package workflow; use Save to Mod.');
  }

  if (isZipMagic(magic)) {
    await saveZipEntry(archivePath, name, newContent);
    await refreshArchiveCacheAfterSave(archivePath, name, bytes);
    return;
  }

  const extension = extensionOf(archivePath);
  if (READ_ONLY_EXTENSIONS.has(extension)) {
    throw new Error(
      `In-place editing is not supported for .${extension} archives. Extract the file, edit it, and repack the archive.`,
    );
  }
  if (!SEVEN_WRITABLE_EXTENSIONS.has(extension)) {
    throw new Error('In-place editing is not supported for this archive format.');
  }

  await saveSevenZipEntry(archivePath, name, newContent);
  await refreshArchiveCacheAfterSave(archivePath, name, bytes);
}

/* ------------------------------------------------------------------ */
/* HashFS edit output                                                  */
/* ------------------------------------------------------------------ */

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

async function saveScsMod({ archivePath, modPath, files }) {
  await ensureNestedWritable(archivePath);
  if (!archivePath || !modPath) throw new Error('No mod target was selected.');
  if (!Array.isArray(files)) throw new Error('No edited files were provided.');
  if (samePath(archivePath, modPath)) {
    throw new Error('The mod package must use a different path from the original archive.');
  }

  const stat = await fsp.stat(archivePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('Archive no longer exists.');
  const magic = await readMagic(archivePath);
  if (!isScsMagic(magic)) throw new Error('This save mode is only for HashFS .scs archives.');

  const zip = new AdmZip();
  const written = [];
  for (const item of files) {
    const entryName = normalizeEntryName(item && item.entryName);
    if (typeof item.content !== 'string') throw new Error(`No text was provided for ${entryName}.`);
    if (Buffer.byteLength(item.content, 'utf8') > MAX_EDITABLE_BYTES) {
      throw new Error(`${entryName} is too large to save.`);
    }
    zip.addFile(entryName, Buffer.from(item.content, 'utf8'));
    written.push(entryName);
  }

  await fsp.mkdir(path.dirname(modPath), { recursive: true });
  await writeZipAtomically(zip, modPath);
  return { success: true, fileCount: written.length, path: modPath, files: written };
}

async function saveScsModifiedCopy({ archivePath, outputPath, files }) {
  await ensureNestedWritable(archivePath);
  if (!archivePath || !outputPath) throw new Error('No output path was selected.');
  if (!Array.isArray(files) || files.length === 0) throw new Error('No edited files were provided.');
  if (samePath(archivePath, outputPath)) {
    throw new Error('The modified copy must use a different path from the original archive.');
  }

  const stat = await fsp.stat(archivePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('Archive no longer exists.');
  const magic = await readMagic(archivePath);
  if (!isScsMagic(magic)) throw new Error('This save mode is only for HashFS .scs archives.');

  const edits = new Map();
  for (const item of files) {
    const entryName = normalizeEntryName(item && item.entryName);
    if (typeof item.content !== 'string') throw new Error(`No text was provided for ${entryName}.`);
    if (Buffer.byteLength(item.content, 'utf8') > MAX_EDITABLE_BYTES) {
      throw new Error(`${entryName} is too large to save.`);
    }
    edits.set(entryName, Buffer.from(item.content, 'utf8'));
  }

  sendProgress({
    format: 'scs',
    phase: 'writing',
    percent: 0,
    done: null,
    total: null,
    entry: '',
    message: 'Preparing modified HashFS copy…',
  });

  const result = await writeHashFsCopy(archivePath, outputPath, edits, {
    onProgress: ({ percent, message }) => {
      sendProgress({
        format: 'scs',
        phase: 'writing',
        percent,
        done: null,
        total: null,
        entry: '',
        message,
      });
    },
  });

  sendProgress({
    format: 'scs',
    phase: 'done',
    percent: 100,
    done: result.edited.length,
    total: result.edited.length,
    entry: '',
    message: 'Modified copy written',
  });

  return { success: true, ...result };
}

async function chooseScsPath({ archivePath, mode }) {
  const baseName = path.basename(archivePath, path.extname(archivePath));
  const suffix = mode === 'copy' ? '_modified.scs' : '_mod.scs';
  let defaultPath;

  if (mode === 'copy') {
    defaultPath = path.join(path.dirname(archivePath), `${baseName}${suffix}`);
  } else {
    const modDir = path.join(app.getPath('documents'), 'OpenZip Mods');
    await fsp.mkdir(modDir, { recursive: true }).catch(() => {});
    defaultPath = path.join(modDir, `${baseName}${suffix}`);
  }

  const options = {
    title:
      mode === 'copy'
        ? 'Save a modified copy of the HashFS archive'
        : 'Save HashFS edits as a mod package',
    defaultPath,
    filters: [
      { name: 'SCS / ZIP mod package', extensions: ['scs', 'zip'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };

  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { canceled: true, filePath: null };

  let target = result.filePath;
  if (!/\.(scs|zip)$/i.test(target)) target += '.scs';
  if (samePath(archivePath, target)) {
    throw new Error('Choose a different path; the original archive is never overwritten.');
  }
  return { canceled: false, filePath: target };
}

/* ------------------------------------------------------------------ */
/* Drag-and-drop injection                                             */
/* ------------------------------------------------------------------ */

function normalizeTargetDir(targetDir) {
  if (targetDir === undefined || targetDir === null) return '';
  if (typeof targetDir !== 'string') throw new Error('Invalid target folder.');

  const normalized = targetDir.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) return '';

  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid target folder.');
  }
  return normalized;
}

async function archiveInjectionKind(archivePath) {
  if (!archivePath) throw new Error('No archive is open.');

  const stat = await fsp.stat(archivePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('Archive no longer exists.');

  const magic = await readMagic(archivePath);
  if (isScsMagic(magic)) throw new Error(READ_ONLY_INJECT_ERROR);
  if (isZipMagic(magic)) return 'zip';

  if (SEVEN_WRITABLE_EXTENSIONS.has(extensionOf(archivePath))) return 'seven';
  throw new Error(READ_ONLY_INJECT_ERROR);
}

/** Add one file or directory tree to an AdmZip archive. */
async function addPathToZip(zip, sourcePath, entryName) {
  const stat = await fsp.stat(sourcePath);

  if (stat.isDirectory()) {
    zip.addFile(entryName.endsWith('/') ? entryName : `${entryName}/`, Buffer.alloc(0));
    const items = await fsp.readdir(sourcePath, { withFileTypes: true });
    for (const item of items) {
      await addPathToZip(zip, path.join(sourcePath, item.name), `${entryName}/${item.name}`);
    }
    return;
  }

  if (stat.isFile()) {
    zip.addFile(entryName, await fsp.readFile(sourcePath));
  }
}

function runSevenZipAdd(archivePath, relativePaths, workDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveSevenZipBinary(),
      ['a', archivePath, ...relativePaths, '-y', '-spd'],
      {
        cwd: workDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let output = '';
    let stderr = '';
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      fail(
        new Error(
          error.code === 'ENOENT'
            ? 'The bundled 7-Zip engine could not be started.'
            : `Could not add files to the archive: ${error.message}`,
        ),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        resolve();
        return;
      }
      const error = new Error('7-Zip could not add files to the archive.');
      error.stderr = stderr || output;
      fail(new Error(describeSevenError(error)));
    });
  });
}

async function addFilesToSevenZip(archivePath, sources, targetDir) {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'openzip-add-'));
  try {
    const relativePaths = [];

    for (const sourcePath of sources) {
      const stat = await fsp.stat(sourcePath);
      if (!stat.isFile() && !stat.isDirectory()) continue;

      const name = path.basename(sourcePath);
      const relative = targetDir ? `${targetDir}/${name}` : name;
      const destination = path.join(workDir, ...relative.split('/'));

      if (!destination.startsWith(`${workDir}${path.sep}`)) {
        throw new Error('Invalid target folder.');
      }

      await fsp.mkdir(path.dirname(destination), { recursive: true });
      if (stat.isDirectory()) {
        await fsp.cp(sourcePath, destination, { recursive: true, force: true });
      } else {
        await fsp.copyFile(sourcePath, destination);
      }
      relativePaths.push(relative);
    }

    if (relativePaths.length === 0) throw new Error('No files were selected.');
    await runSevenZipAdd(archivePath, relativePaths, workDir);
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function addFilesToArchive({
  archivePath,
  filePaths,
  targetDir,
  allowNestedWrite = false,
}) {
  if (!allowNestedWrite) await ensureNestedWritable(archivePath);
  if (!archivePath) throw new Error('No archive is open.');
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('No files were dropped.');
  }

  const sources = [];
  const seen = new Set();
  for (const item of filePaths) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const resolved = path.resolve(item);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const stat = await fsp.stat(resolved).catch(() => null);
    if (stat && (stat.isFile() || stat.isDirectory())) sources.push(resolved);
  }

  if (sources.length === 0) throw new Error('No valid files or folders were dropped.');
  const target = normalizeTargetDir(targetDir);
  const prefix = target ? `${target}/` : '';
  const kind = await archiveInjectionKind(archivePath);

  if (kind === 'zip') {
    let zip;
    try {
      zip = new AdmZip(archivePath);
    } catch (error) {
      throw new Error(`Could not open ZIP archive: ${error.message}`);
    }

    if (zip.getEntries().some((entry) => entry.header && entry.header.encrypted)) {
      throw new Error('Encrypted archives cannot be modified.');
    }

    for (const sourcePath of sources) {
      await addPathToZip(zip, sourcePath, `${prefix}${path.basename(sourcePath)}`);
    }
    await writeZipAtomically(zip, archivePath);
  } else {
    await addFilesToSevenZip(archivePath, sources, target);
  }

  archiveMetaCache.delete(archivePath);
  return { success: true, added: sources.length };
}


/** Turn a node-7z error into a message worth showing in the status bar. */
function describeSevenError(error) {
  const stderr = String(error && error.stderr ? error.stderr : '').trim();
  if (stderr) {
    const lines = stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^7-Zip\s/i.test(line));

    const meaningful =
      lines.find((line) => /error|can not|cannot|wrong password|unsupported|not supported/i.test(line)) ||
      lines[lines.length - 1];

    if (meaningful) {
      return meaningful.replace(/^ERROR:\s*/i, '').replace(/^WARNING:\s*/i, '');
    }
  }

  return (error && error.message ? error.message : 'unknown 7-Zip error').replace(
    /^unknown error$/i,
    'The archive could not be read by 7-Zip',
  );
}

/**
 * Run a node-7z stream to completion.
 * Resolves with the collected data rows (for list) or extraction summary, and
 * rejects with a readable error when 7-Zip reports one or exits non-zero.
 */
function runSevenZip(method, archive, options, onEvent) {
  return new Promise((resolve, reject) => {
    let stream;
    try {
      stream = Seven[method](archive, {
        $bin: resolveSevenZipBinary(),
        charset: 'UTF-8',
        ...options,
      });
    } catch (error) {
      reject(new Error(describeSevenError(error)));
      return;
    }

    // 7-Zip only reads stdin for prompts (passwords, overwrite questions).
    // Closing it turns a potential hang into a normal, reportable error.
    try {
      stream._childProcess?.stdin?.end();
    } catch {
      /* stream already finished */
    }

    const rows = [];
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(describeSevenError(error)));
    };

    stream.on('data', (data) => {
      if (!data) return;
      rows.push(data);
      if (onEvent) onEvent('data', data);
    });

    stream.on('progress', (progress) => {
      if (onEvent) onEvent('progress', progress);
    });

    stream.on('error', fail);

    stream.on('end', () => {
      if (settled) return;
      settled = true;

      const child = stream._childProcess;
      const exitCode = child && typeof child.exitCode === 'number' ? child.exitCode : 0;

      if (stream.err) {
        reject(new Error(describeSevenError(stream.err)));
        return;
      }
      if (exitCode !== 0) {
        reject(new Error(`7-Zip exited with code ${exitCode} while reading ${path.basename(archive)}`));
        return;
      }

      resolve({ rows, info: stream.info });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Archive reading                                                     */
/* ------------------------------------------------------------------ */

function isDirectoryEntry(row) {
  return typeof row.attributes === 'string' && row.attributes.startsWith('D');
}

function toArchiveEntry(row) {
  const isDirectory = isDirectoryEntry(row);
  return {
    name: row.file,
    size: Number.isFinite(row.size) ? row.size : 0,
    compressedSize: Number.isFinite(row.sizeCompressed) ? row.sizeCompressed : null,
    isDirectory,
    time: toTime(row.datetime),
    kind: isDirectory ? 'directory' : 'file',
    encrypted: false,
  };
}

/** Inspect any 7-Zip supported archive (zip, rar, 7z, iso, tar, cab, ...). */
async function readWithSevenZip(filePath) {
  const { rows, info } = await runSevenZip('list', filePath, { yes: true });

  const entries = rows
    .filter((row) => typeof row.file === 'string' && row.file.length > 0)
    .map(toArchiveEntry);

  const files = entries.filter((entry) => !entry.isDirectory);
  const totalPacked = files.reduce((sum, entry) => sum + (entry.compressedSize ?? 0), 0);
  const formatFromSeven = info && info.get ? String(info.get('Type') || '').toLowerCase() : '';
  const extension = extensionOf(filePath);

  // A .scs file may actually be a ZIP/RAR mod; trust 7-Zip's detected type in
  // that case instead of labelling it as a HashFS container.
  const format = extension && extension !== 'scs' ? extension : formatFromSeven || extension || 'archive';

  return {
    format,
    sevenType: formatFromSeven || null,
    entries,
    stats: {
      fileCount: files.length,
      folderCount: entries.length - files.length,
      totalSize: files.reduce((sum, entry) => sum + entry.size, 0),
      totalPackedSize: totalPacked,
    },
  };
}

function readScsIndex(filePath, stat) {
  const cached = scsIndexCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.index;

  let index;
  try {
    index = readHashFsIndex(filePath);
  } catch (error) {
    index = { supported: false, reason: error.message || String(error) };
  }
  scsIndexCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, index });
  return index;
}

function readScs(filePath, fileName, stat) {
  const index = readScsIndex(filePath, stat);
  if (index.supported && index.files.length > 0) {
    const folders = Math.max(0, index.directories.length - 1);
    const entries = index.files.map((file) => ({
      name: file.name,
      size: file.size,
      compressedSize: file.packedSize,
      isDirectory: false,
      time: null,
      kind: 'file',
      encrypted: false,
    }));

    return {
      format: 'scs',
      entries,
      stats: {
        fileCount: entries.length,
        folderCount: folders,
        totalSize: entries.reduce((sum, entry) => sum + entry.size, 0),
        totalPackedSize: entries.reduce((sum, entry) => sum + (entry.compressedSize ?? 0), 0),
      },
      note:
        'HashFS v2 archive read natively. Edits are saved to a separate mod package; ' +
        'the original game archive is never modified.',
    };
  }

  // Unsupported HashFS variant or missing directory tree: expose a single
  // container entry so the existing SCS extractor path still works.
  const container = {
    name: fileName,
    size: stat.size,
    compressedSize: stat.size,
    isDirectory: false,
    time: toTime(stat.mtime),
    kind: 'container',
    encrypted: false,
  };

  return {
    format: 'scs',
    entries: [container],
    stats: {
      fileCount: 1,
      folderCount: 0,
      totalSize: stat.size,
      totalPackedSize: stat.size,
    },
    note: index.reason
      ? `HashFS archive could not be fully indexed (${index.reason}). It may be an unsupported version or protected by its author; try Extract To.`
      : "HashFS archive could not be fully indexed. It may be an unsupported version or protected by its author; try Extract To.",
  };
}

async function readArchive(filePath, stat, magic) {
  if (isScsMagic(magic)) {
    return { ...readScs(filePath, path.basename(filePath), stat), isScs: true };
  }

  try {
    const parsed = await readWithSevenZip(filePath);
    return { ...parsed, isScs: false };
  } catch (error) {
    // Some HashFS variants may not carry the magic; only fall back for .scs.
    if (extensionOf(filePath) === 'scs') {
      return { ...readScs(filePath, path.basename(filePath), stat), isScs: true };
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Archive extraction                                                  */
/* ------------------------------------------------------------------ */

function cachedMetaFor(filePath, stat) {
  const cached = archiveMetaCache.get(filePath);
  if (!cached) return null;
  if (cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
    archiveMetaCache.delete(filePath);
    return null;
  }
  return cached;
}

/**
 * Extract with node-7z (`7z.extractFull`). `selectedEntries` limits extraction
 * to the chosen files/folders; without it the whole archive is unpacked.
 */
function extractWithSevenZip({ filePath, outputDir, selectedEntries, format, meta }) {
  const knownFiles = meta
    ? new Set(meta.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name))
    : null;

  let selection = null;
  if (Array.isArray(selectedEntries) && selectedEntries.length > 0) {
    selection = selectedEntries.filter((name) => (knownFiles ? knownFiles.has(name) : true));

    // Selecting folders only: hand 7-Zip their paths so it walks the tree.
    if (selection.length === 0) {
      selection = selectedEntries.slice();
    }
  }

  const totalFiles = selection ? selection.length : knownFiles ? knownFiles.size : null;
  // Windows limits a command line to ~32k characters. Large selections are
  // handed to 7-Zip through a list file instead of one argument per entry.
  const needsListFile = selection !== null && selection.length > 500;
  let selectionListFile = null;

  const cleanupSelectionFile = () => {
    if (!selectionListFile) return;
    try {
      fs.rmSync(selectionListFile, { force: true });
    } catch {
      /* best effort */
    }
    selectionListFile = null;
  };

  let done = 0;
  let rawPercent = 0;
  let lastSent = 0;

  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastSent < 70) return;
    lastSent = now;

    const computed = totalFiles && totalFiles > 0 ? Math.min(99, Math.round((done / totalFiles) * 100)) : null;
    const percent =
      computed === null ? (Number.isFinite(rawPercent) ? rawPercent : null) : Math.max(computed, rawPercent);

    sendProgress({
      format,
      phase: 'extracting',
      done,
      total: totalFiles,
      percent,
      entry: '',
      message: selection ? 'Extracting selected files' : `Extracting ${format.toUpperCase()} archive`,
    });
  };

  return new Promise((resolve, reject) => {
    let stream;

    const options = {
      $bin: resolveSevenZipBinary(),
      charset: 'UTF-8',
      $progress: true,
      yes: true,
      overwrite: 'a',
    };

    if (selection) {
      if (needsListFile) {
        try {
          selectionListFile = path.join(
            os.tmpdir(),
            `openzip-selection-${process.pid}-${Date.now()}.txt`,
          );
          fs.writeFileSync(selectionListFile, `${selection.join('\r\n')}\r\n`, 'utf8');
        } catch (error) {
          cleanupSelectionFile();
          reject(new Error(`Could not prepare the selected file list: ${error.message}`));
          return;
        }
        options.listFileCharset = 'UTF-8';
        options.noWildcards = true;
        options.$raw = [`@${selectionListFile}`];
      } else {
        options.$cherryPick = selection;
        options.noWildcards = true;
      }
    }

    try {
      stream = Seven.extractFull(filePath, outputDir, options);
    } catch (error) {
      cleanupSelectionFile();
      reject(new Error(describeSevenError(error)));
      return;
    }

    try {
      stream._childProcess?.stdin?.end();
    } catch {
      /* already finished */
    }

    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanupSelectionFile();
      reject(new Error(describeSevenError(error)));
    };

    stream.on('data', (data) => {
      if (!data || data.status !== 'extracted' || !data.file) return;
      // 7-Zip emits an extraction event for folders too; ignore those.
      if (knownFiles && !knownFiles.has(data.file)) return;
      done += 1;
      emit();
    });

    stream.on('progress', (progress) => {
      if (progress && Number.isFinite(progress.percent)) {
        rawPercent = Math.max(0, Math.min(100, progress.percent));
        emit();
      }
    });

    stream.on('error', fail);

    stream.on('end', () => {
      if (settled) return;
      settled = true;
      cleanupSelectionFile();

      const child = stream._childProcess;
      const exitCode = child && typeof child.exitCode === 'number' ? child.exitCode : 0;

      if (stream.err) {
        reject(new Error(describeSevenError(stream.err)));
        return;
      }
      if (exitCode !== 0) {
        reject(new Error(`7-Zip exited with code ${exitCode} while extracting ${path.basename(filePath)}`));
        return;
      }

      const infoFiles = stream.info && stream.info.get ? Number.parseInt(stream.info.get('Files'), 10) : NaN;
      const extracted = done > 0 ? done : Number.isFinite(infoFiles) ? infoFiles : 0;

      sendProgress({
        format,
        phase: 'done',
        done: extracted,
        total: totalFiles,
        percent: 100,
        entry: '',
        message: 'Extraction finished',
      });

      resolve({
        ok: true,
        format,
        outputDir,
        extracted,
        total: totalFiles,
        message:
          extracted > 0
            ? `Extracted ${extracted} file${extracted === 1 ? '' : 's'} to ${outputDir}`
            : `Nothing was extracted to ${outputDir}`,
      });
    });
  });
}

function extractScsWithTool(toolPath, filePath, outputDir, profile, extraArgs = []) {
  const args =
    profile === 'modern'
      ? [filePath, `--dest=${outputDir}`, ...extraArgs]
      : [filePath, outputDir, ...extraArgs];

  return new Promise((resolve, reject) => {
    const child = spawn(toolPath, args, {
      windowsHide: true,
      cwd: path.dirname(toolPath),
      // `ignore` maps stdin to the NUL device so the extractor's closing
      // "Press any key to continue ..." cannot block the extraction.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let extracted = 0;
    let summaryCount = 0;
    let lineBuffer = '';
    const tail = [];
    let lastSent = 0;

    const handleLine = (line) => {
      const text = line.replace(/\r$/, '').trim();
      if (!text) return;

      tail.push(text);
      if (tail.length > 40) tail.shift();

      // Authoritative total from "N extracted (…), N skipped, …".
      const summary = text.match(/^(\d+)\s+extracted\b/i);
      if (summary) summaryCount = Number(summary[1]);

      // Legacy `scs_extractor` reports "Extracting: <path>"; newer builds print
      // one bare path per unpacked file. Both are counted here.
      const isPathLine =
        profile === 'modern'
          ? /[\\/]/.test(text) && !/^(error|warning|usage|options|extractor)\b/i.test(text)
          : /^(extracting|extracted)\b/i.test(text);

      if (isPathLine) extracted += 1;

      const now = Date.now();
      if (now - lastSent >= 60) {
        lastSent = now;
        sendProgress({
          format: 'scs',
          phase: 'extracting',
          done: extracted,
          total: null,
          percent: null,
          entry: text,
          message: 'Unpacking HashFS container',
        });
      }
    };

    const consume = (chunk) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      lines.forEach(handleLine);
    };

    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);

    child.on('error', (error) => {
      reject(
        new Error(
          error.code === 'ENOENT'
            ? `SCS extractor not found: ${toolPath}`
            : `SCS extractor failed to start: ${error.message}`,
        ),
      );
    });

    child.on('close', async (code) => {
      if (lineBuffer) handleLine(lineBuffer);

      if (code === 0) {
        let total = summaryCount || extracted;
        if (total === 0) {
          // Silent extractor build: fall back to the files actually on disk.
          total = await countFilesRecursive(outputDir);
        }

        sendProgress({
          format: 'scs',
          phase: 'done',
          done: total,
          total: null,
          percent: 100,
          entry: '',
          message: 'Extraction finished',
        });
        resolve({
          ok: true,
          format: 'scs',
          outputDir,
          extracted: total,
          total: null,
          toolPath,
          message:
            total > 0
              ? `Extracted ${total} HashFS file${total === 1 ? '' : 's'} to ${outputDir}`
              : `HashFS extraction finished. Files were written to ${outputDir}`,
          log: tail.slice(-12),
        });
      } else {
        const meaningful = tail.filter((line) => !/press any key/i.test(line));
        const reason =
          meaningful.find((line) => /unable to|error|top level directory|failed/i.test(line)) ||
          meaningful[meaningful.length - 1] ||
          'unknown extractor error';

        const failure = new Error(`SCS extractor exited with code ${code}: ${reason}`);
        failure.detail = tail.slice(-20);
        reject(failure);
      }
    });
  });
}

async function extractArchive({ filePath, outputDir, entries }) {
  if (!filePath) throw new Error('No archive is open.');
  if (!outputDir) throw new Error('No output folder was selected.');

  await ensureDirectory(outputDir);

  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`Archive no longer exists: ${filePath}`);
  }

  const magic = await readMagic(filePath);
  const meta = cachedMetaFor(filePath, stat);
  // readArchive() may have fallen back to the SCS container for a .scs file
  // without the HashFS magic; keep extraction consistent with what was shown.
  const treatAsScs = isScsMagic(magic) || (meta && meta.format === 'scs');

  if (!treatAsScs) {
    return extractWithSevenZip({
      filePath,
      outputDir,
      selectedEntries: entries,
      format: (meta && meta.format) || extensionOf(filePath) || 'archive',
      meta,
    });
  }

  // ---- Official HashFS SCS container ----
  const toolPath = resolveScsExtractor();
  if (!toolPath) {
    throw new Error(
      'The bundled SCS extractor (bin/scs_extractor.exe) is missing. Reinstall OpenZip with its bin folder.',
    );
  }

  const profile = await probeScsToolProfile(toolPath);

  try {
    return await extractScsWithTool(toolPath, filePath, outputDir, profile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Archives without a top-level directory listing need the deep scanner.
    if (profile === 'modern' && /top level directory is (missing|empty)/i.test(message)) {
      sendProgress({
        format: 'scs',
        phase: 'extracting',
        percent: null,
        done: 0,
        total: null,
        entry: '',
        message: 'No directory listing found — scanning archive contents (deep mode)…',
      });
      return extractScsWithTool(toolPath, filePath, outputDir, profile, ['--deep']);
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Drag-out preparation                                                */
/* ------------------------------------------------------------------ */

function dragRootFor(sessionId) {
  if (typeof sessionId !== 'string' || !DRAG_SESSION_PATTERN.test(sessionId)) {
    throw new Error('Invalid drag session identifier.');
  }
  const tempRoot = path.resolve(os.tmpdir());
  const root = path.resolve(path.join(tempRoot, `${DRAG_ROOT_PREFIX}${sessionId}`));
  if (path.dirname(root) !== tempRoot || !path.basename(root).startsWith(DRAG_ROOT_PREFIX)) {
    throw new Error('Invalid drag temporary folder.');
  }
  return root;
}

function normalizeDragRoot(rootName) {
  if (typeof rootName !== 'string') throw new Error('Invalid selected entry.');
  const isDirectory = rootName.endsWith('/');
  const normalized = normalizeEntryName(isDirectory ? rootName.slice(0, -1) : rootName);
  return isDirectory ? `${normalized}/` : normalized;
}

function dragSignature(roots, entries) {
  return JSON.stringify({
    roots: [...new Set(roots)].sort(),
    entries: [...new Set(entries)].sort(),
  });
}

function safeDragPath(root, entryName) {
  const normalized = normalizeEntryName(entryName);
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, ...normalized.split('/'));
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error('Archive entry would escape the drag temporary folder.');
  }
  return resolved;
}

async function verifyDragTree(root) {
  const rootResolved = path.resolve(root);
  const stack = [rootResolved];
  let visited = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    visited += 1;
    if (visited > 250_000) throw new Error('Extracted selection is too large to drag.');

    const records = await fsp.readdir(current, { withFileTypes: true });
    for (const record of records) {
      const fullPath = path.join(current, record.name);
      const resolved = path.resolve(fullPath);
      if (!resolved.startsWith(`${rootResolved}${path.sep}`)) {
        throw new Error('Extraction escaped the drag temporary folder.');
      }
      if (record.isSymbolicLink()) {
        throw new Error('Symbolic links cannot be dragged out safely.');
      }
      if (record.isDirectory()) stack.push(resolved);
    }
  }
}

function dragIcon() {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'app.asar.unpacked', 'docs', 'icon.png'),
        path.join(app.getAppPath(), 'docs', 'icon.png'),
      ]
    : [path.join(__dirname, 'docs', 'icon.png'), path.join(__dirname, 'docs', 'icon.ico')];

  for (const candidate of candidates) {
    try {
      const icon = nativeImage.createFromPath(candidate);
      if (!icon.isEmpty()) return icon;
    } catch {
      /* try the next candidate */
    }
  }

  return nativeImage.createFromBuffer(Buffer.from(DRAG_ICON_FALLBACK, 'base64'));
}

async function extractScsDragSelection(filePath, outputDir, entries, stat) {
  const toolPath = resolveScsExtractor();
  if (!toolPath) {
    throw new Error(
      'The bundled SCS extractor (bin/scs_extractor.exe) is missing. Reinstall OpenZip with its bin folder.',
    );
  }

  const profile = await probeScsToolProfile(toolPath);
  if (profile === 'modern') {
    const listPath = path.join(outputDir, '.openzip-drag-selection.txt');
    await fsp.writeFile(listPath, entries.map((entry) => `/${entry}`).join('\n'), 'utf8');
    try {
      await extractScsWithTool(toolPath, filePath, outputDir, profile, [`--paths=${listPath}`]);
    } finally {
      await fsp.rm(listPath, { force: true }).catch(() => {});
    }
    return;
  }

  // Legacy extractor: prefer native HashFS reads when the archive is v2.
  const index = readScsIndex(filePath, stat);
  if (index.supported) {
    const extracted = [];
    for (const entryName of entries) {
      const file = index.filesByPath.get(entryName);
      if (!file || file.packedImage) continue;
      const destination = safeDragPath(outputDir, entryName);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, readHashFsEntry(index, entryName, Number.MAX_SAFE_INTEGER));
      extracted.push(entryName);
    }
    if (extracted.length === 0) throw new Error('None of the selected files could be read.');
    return;
  }

  await extractScsWithTool(toolPath, filePath, outputDir, profile);
}

async function extractDragEntries(archivePath, outputDir, entries) {
  const stat = await fsp.stat(archivePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('Archive no longer exists.');

  const magic = await readMagic(archivePath);
  const meta = cachedMetaFor(archivePath, stat);
  const treatAsScs = isScsMagic(magic) || (meta && meta.format === 'scs');

  await ensureDirectory(outputDir);

  if (treatAsScs) {
    await extractScsDragSelection(archivePath, outputDir, entries, stat);
    return;
  }

  await extractWithSevenZip({
    filePath: archivePath,
    outputDir,
    selectedEntries: entries,
    format: (meta && meta.format) || extensionOf(archivePath) || 'archive',
    meta,
  });
}

function buildDragItems(root, roots, entries) {
  const folderRoots = roots.filter((rootName) => rootName.endsWith('/'));
  const fileRoots = roots.filter((rootName) => !rootName.endsWith('/'));
  const folderNames = folderRoots.map((rootName) => rootName.slice(0, -1));
  const candidates = [];

  const isInsideSelectedFolder = (name) =>
    folderNames.some((folder) => name === folder || name.startsWith(`${folder}/`));

  for (const folder of folderNames) {
    const absolute = safeDragPath(root, folder);
    const stat = fs.statSync(absolute, { throwIfNoEntry: false });
    if (stat && stat.isDirectory()) candidates.push(absolute);
  }

  for (const file of fileRoots) {
    if (isInsideSelectedFolder(file)) continue;
    const absolute = safeDragPath(root, file);
    if (fs.existsSync(absolute)) candidates.push(absolute);
  }

  if (roots.length === 0) {
    for (const entry of entries) {
      const absolute = safeDragPath(root, entry);
      if (fs.existsSync(absolute)) candidates.push(absolute);
    }
  }

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

async function prepareDrag({
  sessionId,
  archivePath,
  roots,
  entries,
  automatic = false,
  selectionBytes = 0,
}) {
  if (!archivePath) throw new Error('No archive is open.');
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Select at least one file or folder to drag.');
  }

  const archiveStat = await fsp.stat(archivePath).catch(() => null);
  if (!archiveStat || !archiveStat.isFile()) throw new Error('Archive no longer exists.');

  if (automatic) {
    const bytes = Number(selectionBytes);
    if (!Number.isFinite(bytes) || bytes > DRAG_AUTO_PREP_LIMIT_BYTES) {
      return {
        success: false,
        skipped: true,
        error: `Automatic preparation is limited to ${Math.round(
          DRAG_AUTO_PREP_LIMIT_BYTES / 1024 / 1024,
        )} MB. Drag again to prepare the selection manually.`,
      };
    }
  }

  const normalizedEntries = [...new Set(entries.map(normalizeEntryName))];
  const rootList = Array.isArray(roots) ? roots : [];
  const normalizedRoots = [...new Set(rootList.map(normalizeDragRoot))];
  const root = dragRootFor(sessionId);
  const signature = dragSignature(normalizedRoots, normalizedEntries);

  let session = dragSessions.get(sessionId);
  if (!session) {
    session = {
      root,
      archivePath,
      chain: Promise.resolve(),
      requestId: 0,
      ready: false,
      signature: null,
      items: [],
      closed: false,
      presentEntries: new Map(),
      extractedBytes: 0,
      archiveSize: archiveStat.size,
      archiveMtimeMs: archiveStat.mtimeMs,
      needsExtractReset: false,
    };
    dragSessions.set(sessionId, session);
    dragRoots.add(root);
  }

  if (session.archivePath !== archivePath) {
    throw new Error('The drag session does not belong to this archive.');
  }

  const archiveChanged =
    session.archiveSize !== archiveStat.size || session.archiveMtimeMs !== archiveStat.mtimeMs;
  session.archiveSize = archiveStat.size;
  session.archiveMtimeMs = archiveStat.mtimeMs;
  if (archiveChanged) {
    session.presentEntries.clear();
    session.extractedBytes = 0;
    session.ready = false;
    session.signature = null;
    session.items = [];
    session.needsExtractReset = true;
  }

  if (
    session.ready &&
    session.signature === signature &&
    session.items.length > 0 &&
    session.items.every((item) => fs.existsSync(item))
  ) {
    return {
      success: true,
      ready: true,
      signature,
      items: session.items,
      tempDir: root,
    };
  }

  session.ready = false;
  const requestId = ++session.requestId;

  const job = session.chain
    .catch(() => {})
    .then(async () => {
      if (session.closed || requestId !== session.requestId) {
        return { success: false, stale: true, error: 'Drag preparation superseded.' };
      }

      if (session.needsExtractReset) {
        await fsp.rm(root, { recursive: true, force: true });
        await fsp.mkdir(root, { recursive: true });
        session.needsExtractReset = false;
      } else {
        await fsp.mkdir(root, { recursive: true });
      }

      // Drop records whose files vanished from the session folder.
      for (const [entryName, record] of session.presentEntries) {
        if (!fs.existsSync(record.path)) {
          session.presentEntries.delete(entryName);
          session.extractedBytes = Math.max(0, session.extractedBytes - record.size);
        }
      }

      const missingEntries = normalizedEntries.filter((entryName) => {
        const record = session.presentEntries.get(entryName);
        return !record || !fs.existsSync(record.path);
      });

      try {
        if (missingEntries.length > 0) {
          await extractDragEntries(archivePath, root, missingEntries);
        }
        await verifyDragTree(root);

        for (const entryName of normalizedEntries) {
          const absolute = safeDragPath(root, entryName);
          const stat = fs.statSync(absolute, { throwIfNoEntry: false });
          if (!stat || !stat.isFile()) continue;
          const existing = session.presentEntries.get(entryName);
          if (existing) {
            session.extractedBytes = Math.max(0, session.extractedBytes - existing.size);
          }
          session.presentEntries.set(entryName, { path: absolute, size: stat.size });
          session.extractedBytes += stat.size;
        }

        if (session.closed || requestId !== session.requestId) {
          return { success: false, stale: true, error: 'Drag preparation superseded.' };
        }

        // Retain already-extracted files while the session stays below the
        // pruning threshold. Above it, drop entries no longer in the selection.
        if (session.extractedBytes > DRAG_SESSION_PRUNE_LIMIT_BYTES) {
          const selected = new Set(normalizedEntries);
          for (const [entryName, record] of session.presentEntries) {
            if (selected.has(entryName)) continue;
            try {
              fs.rmSync(record.path, { force: true });
            } catch {
              continue;
            }
            session.presentEntries.delete(entryName);
            session.extractedBytes = Math.max(0, session.extractedBytes - record.size);
          }
        }

        const items = buildDragItems(root, normalizedRoots, normalizedEntries);
        if (items.length === 0) {
          throw new Error('No selected files were extracted.');
        }

        session.ready = true;
        session.signature = signature;
        session.items = items;
        return { success: true, ready: true, signature, items, tempDir: root };
      } catch (error) {
        session.ready = false;
        return { success: false, error: error.message || String(error) };
      }
    });

  session.chain = job;
  return job;
}

function invalidateDragSessions(archivePath) {
  if (!archivePath) return;
  for (const session of dragSessions.values()) {
    if (session.archivePath !== archivePath) continue;
    session.presentEntries.clear();
    session.extractedBytes = 0;
    session.ready = false;
    session.signature = null;
    session.items = [];
    session.archiveSize = null;
    session.archiveMtimeMs = null;
    session.needsExtractReset = true;
    session.requestId += 1;
  }
}

async function cleanupDragSession(sessionId) {
  let root;
  try {
    root = dragRootFor(sessionId);
  } catch {
    return { success: false, error: 'Invalid drag session identifier.' };
  }

  const session = dragSessions.get(sessionId);
  if (session) {
    session.closed = true;
    session.ready = false;
    dragSessions.delete(sessionId);
    await session.chain.catch(() => {});
  }

  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  dragRoots.delete(root);
  return { success: true };
}

function cleanupAllDragRootsSync() {
  const tempRoot = path.resolve(os.tmpdir());
  const roots = new Set(dragRoots);
  for (const session of dragSessions.values()) roots.add(session.root);
  dragSessions.clear();
  dragRoots.clear();

  for (const root of roots) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== tempRoot) continue;
    if (!path.basename(resolved).startsWith(DRAG_ROOT_PREFIX)) continue;
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
    } catch {
      /* best effort during shutdown */
    }
  }
}

ipcMain.handle('archive:prepareDrag', async (_event, payload) => {
  try {
    return await prepareDrag(payload || {});
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:cleanupDrag', async (_event, payload) => {
  return cleanupDragSession((payload || {}).sessionId);
});

ipcMain.on('archive:startDrag', (event, payload) => {
  try {
    const { sessionId, signature } = payload || {};
    const session = dragSessions.get(sessionId);
    if (!session || !session.ready || session.signature !== signature) {
      event.sender.send('archive:dragError', 'Files are not ready yet. Drag again once preparation finishes.');
      return;
    }

    const items = session.items.filter((item) => fs.existsSync(item));
    if (items.length === 0) {
      event.sender.send('archive:dragError', 'The prepared files are no longer available.');
      return;
    }

    const icon = dragIcon();
    if (!icon || icon.isEmpty()) {
      event.sender.send('archive:dragError', 'The drag icon could not be loaded.');
      return;
    }

    const electronMajor = Number.parseInt(String(process.versions.electron).split('.')[0], 10);
    const singleFile = items.length === 1 && fs.statSync(items[0]).isFile();
    if (singleFile) {
      event.sender.startDrag({ file: items[0], icon });
    } else if (Number.isFinite(electronMajor) && electronMajor >= 30) {
      event.sender.startDrag({ files: items, icon });
    } else {
      // Older Electron versions only accept one path: drag the extracted
      // parent folder, which keeps the selected tree intact.
      event.sender.startDrag({ file: session.root, icon });
    }
  } catch (error) {
    try {
      event.sender.send('archive:dragError', error.message || String(error));
    } catch {
      /* renderer already gone */
    }
  }
});

/* ------------------------------------------------------------------ */
/* Nested archive extraction                                           */
/* ------------------------------------------------------------------ */

function isNestedArchivePath(filePath) {
  if (!filePath) return false;
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const first = relative.split(path.sep)[0];
  return first.startsWith(NESTED_ROOT_PREFIX);
}

function isManagedNestedRoot(root) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(root);
  return (
    path.dirname(resolved) === tempRoot &&
    path.basename(resolved).startsWith(NESTED_ROOT_PREFIX)
  );
}

function nestedRootFor(sessionId) {
  if (typeof sessionId !== 'string' || !DRAG_SESSION_PATTERN.test(sessionId)) {
    throw new Error('Invalid nested archive session identifier.');
  }
  const root = path.resolve(os.tmpdir(), `${NESTED_ROOT_PREFIX}${sessionId}`);
  if (!isManagedNestedRoot(root)) throw new Error('Invalid nested archive temporary folder.');
  return root;
}

async function cleanupAllNestedArchives() {
  const roots = new Set(nestedRoots);
  for (const item of nestedArchiveCache.values()) roots.add(item.root);
  nestedArchiveCache.clear();
  nestedRoots.clear();

  for (const root of roots) {
    if (!isManagedNestedRoot(root)) continue;
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

function cleanupAllNestedArchivesSync() {
  const roots = new Set(nestedRoots);
  for (const item of nestedArchiveCache.values()) roots.add(item.root);
  nestedArchiveCache.clear();
  nestedRoots.clear();

  for (const root of roots) {
    if (!isManagedNestedRoot(root)) continue;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

function invalidateNestedArchives(archivePath) {
  if (!archivePath) return;
  const resolved = path.resolve(archivePath);
  for (const [key, item] of nestedArchiveCache) {
    if (path.resolve(item.outerArchivePath) !== resolved) continue;
    nestedArchiveCache.delete(key);
    nestedRoots.delete(item.root);
    if (isManagedNestedRoot(item.root)) {
      try {
        fs.rmSync(item.root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

function nestedReadOnlyError(reason) {
  return `${NESTED_READ_ONLY_ERROR} ${reason}`;
}

function isNestedWritableFormat(format) {
  return NESTED_WRITABLE_FORMATS.has(format);
}

function findNestedCacheItem(filePath) {
  const resolved = path.resolve(filePath);
  for (const item of nestedArchiveCache.values()) {
    if (path.resolve(item.filePath) === resolved) return item;
  }
  return null;
}

async function ensureNestedWritable(archivePath) {
  if (!isNestedArchivePath(archivePath)) return;
  const item = findNestedCacheItem(archivePath);
  if (!item) {
    throw new Error(nestedReadOnlyError('The nested session is no longer available.'));
  }

  const innerStat = await fsp.stat(archivePath).catch(() => null);
  if (!innerStat || !innerStat.isFile()) {
    throw new Error(nestedReadOnlyError('The inner archive is no longer available.'));
  }
  const innerParsed = await readArchive(
    archivePath,
    innerStat,
    await readMagic(archivePath),
  ).catch(() => null);
  if (!innerParsed || !isNestedWritableFormat(innerParsed.format)) {
    throw new Error(nestedReadOnlyError('The inner archive is read-only.'));
  }

  const outerStat = await fsp.stat(item.outerArchivePath).catch(() => null);
  if (!outerStat || !outerStat.isFile()) {
    throw new Error(nestedReadOnlyError('The outer archive is no longer available.'));
  }
  const outerParsed = await readArchive(
    item.outerArchivePath,
    outerStat,
    await readMagic(item.outerArchivePath),
  ).catch(() => null);
  if (!outerParsed || !isNestedWritableFormat(outerParsed.format)) {
    throw new Error(nestedReadOnlyError('The outer archive is read-only.'));
  }
}

function isSolidSevenZip(filePath) {
  return new Promise((resolve) => {
    const child = spawn(resolveSevenZipBinary(), ['l', '-slt', filePath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 1024 * 1024) child.kill();
    });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(/^Solid = \+/m.test(output)));
  });
}

async function nestedEntrySize(outerArchivePath, stat, entryName) {
  let entry = cachedMetaFor(outerArchivePath, stat)?.entries?.find(
    (candidate) => candidate.name === entryName && !candidate.isDirectory,
  );
  if (!entry) {
    const magic = await readMagic(outerArchivePath);
    const parsed = await readArchive(outerArchivePath, stat, magic);
    entry = parsed.entries.find(
      (candidate) => candidate.name === entryName && !candidate.isDirectory,
    );
  }
  if (!entry) throw new Error(`Entry not found in the outer archive: ${entryName}`);
  return entry.size;
}

async function ensureNestedFreeSpace(entrySize) {
  if (!Number.isFinite(entrySize) || entrySize <= 0) return;
  let stats;
  try {
    stats = await fsp.statfs(os.tmpdir(), { bigint: true });
  } catch (error) {
    throw new Error(`Could not check free space on the temp drive: ${error.message || error}`);
  }
  const free = stats.bavail * stats.bsize;
  const required = BigInt(entrySize) * 2n;
  if (free < required) {
    throw new Error(
      `Not enough free space on the temp drive: ${Math.ceil(
        Number(required) / 1024 / 1024,
      )} MB required, ${Math.floor(Number(free) / 1024 / 1024)} MB available.`,
    );
  }
}

async function openNestedArchive({ outerArchivePath, entryName, confirmed = false }) {
  if (!outerArchivePath) throw new Error('No outer archive is open.');
  const extension = extensionOf(entryName);
  if (!NESTED_ARCHIVE_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported nested archive type: .${extension || 'unknown'}`);
  }

  const normalizedEntry = normalizeEntryName(entryName);
  const stat = await fsp.stat(outerArchivePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('Outer archive no longer exists.');

  const entrySize = await nestedEntrySize(outerArchivePath, stat, normalizedEntry);
  const resolvedOuter = path.resolve(outerArchivePath);
  const cacheKey = `${resolvedOuter}|${normalizedEntry}|${stat.size}|${stat.mtimeMs}`;
  const cached = nestedArchiveCache.get(cacheKey);
  if (cached && fs.existsSync(cached.filePath)) {
    return {
      ok: true,
      cached: true,
      filePath: cached.filePath,
      entryName: normalizedEntry,
      sessionId: cached.sessionId,
      outerArchivePath: resolvedOuter,
      outerSize: stat.size,
      outerMtimeMs: stat.mtimeMs,
      entrySize,
    };
  }

  if (entrySize > NESTED_CONFIRM_BYTES && confirmed !== true) {
    return {
      ok: false,
      needsConfirmation: true,
      entrySize,
      error: `This entry is ${Math.round(entrySize / 1024 / 1024)} MB.`,
    };
  }

  await ensureNestedFreeSpace(entrySize);

  // A changed outer archive (or a previous extraction for the same entry)
  // invalidates its old nested folder.
  for (const [key, item] of nestedArchiveCache) {
    if (path.resolve(item.outerArchivePath) !== resolvedOuter) continue;
    if (item.entryName !== normalizedEntry) continue;
    nestedArchiveCache.delete(key);
    nestedRoots.delete(item.root);
    await fsp.rm(item.root, { recursive: true, force: true }).catch(() => {});
  }

  const sessionId = randomUUID().replace(/[^A-Za-z0-9_-]/g, '');
  const root = nestedRootFor(sessionId);
  await fsp.mkdir(root, { recursive: true });
  nestedRoots.add(root);

  try {
    sendProgress({
      format: 'nested',
      phase: 'extracting',
      percent: null,
      done: 0,
      total: 1,
      entry: normalizedEntry,
      message: `Extracting ${path.basename(normalizedEntry)} from the outer archive…`,
    });

    const magic = await readMagic(outerArchivePath);
    const meta = cachedMetaFor(outerArchivePath, stat);
    if (isScsMagic(magic) || (meta && meta.format === 'scs')) {
      await extractScsDragSelection(outerArchivePath, root, [normalizedEntry], stat);
    } else {
      await extractArchive({
        filePath: outerArchivePath,
        outputDir: root,
        entries: [normalizedEntry],
      });
    }

    const filePath = safeDragPath(root, normalizedEntry);
    const extracted = await fsp.stat(filePath).catch(() => null);
    if (!extracted || !extracted.isFile()) {
      throw new Error('The nested archive could not be extracted.');
    }

    const result = {
      filePath,
      sessionId,
      root,
      entryName: normalizedEntry,
      outerArchivePath: resolvedOuter,
      outerSize: stat.size,
      outerMtimeMs: stat.mtimeMs,
      entrySize,
    };
    nestedArchiveCache.set(cacheKey, result);
    sendProgress({
      format: 'nested',
      phase: 'done',
      percent: 100,
      done: 1,
      total: 1,
      entry: normalizedEntry,
      message: 'Nested archive prepared',
    });

    return {
      ok: true,
      cached: false,
      filePath,
      entryName: normalizedEntry,
      sessionId,
      outerArchivePath: resolvedOuter,
      outerSize: stat.size,
      outerMtimeMs: stat.mtimeMs,
      entrySize,
    };
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    nestedRoots.delete(root);
    throw error;
  }
}

async function writeBackNestedArchive({
  outerArchivePath,
  entryName,
  nestedFilePath,
  confirmed = false,
}) {
  if (!outerArchivePath || !nestedFilePath) throw new Error('No nested archive is open.');
  const normalizedEntry = normalizeEntryName(entryName);
  const parentPath = path.resolve(outerArchivePath);
  const nestedPath = path.resolve(nestedFilePath);
  const parentStat = await fsp.stat(parentPath).catch(() => null);
  const nestedStat = await fsp.stat(nestedPath).catch(() => null);
  if (!parentStat || !parentStat.isFile()) throw new Error('The outer archive no longer exists.');
  if (!nestedStat || !nestedStat.isFile()) throw new Error('The nested archive no longer exists.');

  const parentParsed = await readArchive(
    parentPath,
    parentStat,
    await readMagic(parentPath),
  );
  if (!isNestedWritableFormat(parentParsed.format)) {
    throw new Error(nestedReadOnlyError('The outer archive is read-only.'));
  }
  const nestedParsed = await readArchive(
    nestedPath,
    nestedStat,
    await readMagic(nestedPath),
  );
  if (!isNestedWritableFormat(nestedParsed.format)) {
    throw new Error(nestedReadOnlyError('The inner archive is read-only.'));
  }

  const parentEntry = parentParsed.entries.find(
    (entry) => entry.name === normalizedEntry && !entry.isDirectory,
  );
  if (!parentEntry) throw new Error(`The outer archive has no entry named ${normalizedEntry}.`);

  const innerSize = nestedStat.size;
  const solid = parentParsed.format === '7z' && (await isSolidSevenZip(parentPath));
  if (!confirmed && (innerSize > NESTED_CONFIRM_BYTES || solid)) {
    return {
      ok: false,
      needsWarning: true,
      innerSize,
      solid,
      outerFormat: parentParsed.format,
    };
  }

  const id = randomUUID().replace(/[^A-Za-z0-9_-]/g, '');
  const ext = path.extname(parentPath);
  const tempOuter = path.join(
    path.dirname(parentPath),
    `.${path.basename(parentPath)}.openzip-writeback-${id}${ext}`,
  );
  const backupOuter = path.join(
    path.dirname(parentPath),
    `.${path.basename(parentPath)}.openzip-backup-${id}`,
  );
  const stageDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'openzip-writeback-'));
  const stagedInner = path.join(stageDir, path.basename(normalizedEntry));

  const sendWriteProgress = (phase, percent, message) => {
    sendProgress({
      format: 'nested-writeback',
      phase,
      percent,
      done: null,
      total: null,
      entry: normalizedEntry,
      message,
    });
  };

  try {
    sendWriteProgress('writing', 5, `Writing ${path.basename(normalizedEntry)} back to the outer archive…`);
    await fsp.copyFile(nestedPath, stagedInner);
    await fsp.copyFile(parentPath, tempOuter);

    const slash = normalizedEntry.lastIndexOf('/');
    const targetDir = slash >= 0 ? normalizedEntry.slice(0, slash) : '';
    const addResult = await addFilesToArchive({
      archivePath: tempOuter,
      filePaths: [stagedInner],
      targetDir,
      allowNestedWrite: true,
    });
    if (!addResult || !addResult.success) {
      throw new Error(addResult?.error ?? 'Could not update the temporary outer archive.');
    }

    sendWriteProgress('verifying', 70, 'Verifying the updated outer archive…');
    const checkStat = await fsp.stat(tempOuter);
    const checkParsed = await readArchive(tempOuter, checkStat, await readMagic(tempOuter));
    const checkEntry = checkParsed.entries.find(
      (entry) => entry.name === normalizedEntry && !entry.isDirectory,
    );
    if (!checkEntry || checkEntry.size !== innerSize) {
      throw new Error(
        `Verification failed: expected ${normalizedEntry} to be ${innerSize} bytes.`,
      );
    }

    sendWriteProgress('replacing', 90, 'Replacing the original outer archive…');
    let movedOriginal = false;
    try {
      await fsp.rename(parentPath, backupOuter);
      movedOriginal = true;
      await fsp.rename(tempOuter, parentPath);
    } catch (error) {
      if (movedOriginal) {
        try {
          await fsp.rename(backupOuter, parentPath);
        } catch {
          await fsp.copyFile(backupOuter, parentPath).catch(() => {});
        }
      }
      throw new Error(
        `Could not replace the outer archive. The original was left unchanged. ${
          error.message || error
        }`,
      );
    }

    if (movedOriginal) await fsp.rm(backupOuter, { force: true }).catch(() => {});
    invalidateNestedArchives(parentPath);
    invalidateDragSessions(parentPath);
    invalidateDragSessions(nestedPath);
    archiveMetaCache.delete(parentPath);
    sendWriteProgress('done', 100, 'Inner archive written back');
    return {
      ok: true,
      entryName: normalizedEntry,
      innerSize,
      outerFormat: parentParsed.format,
      solid,
    };
  } catch (error) {
    sendWriteProgress('error', null, error.message || String(error));
    throw error;
  } finally {
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(tempOuter, { force: true }).catch(() => {});
    if (!fs.existsSync(parentPath)) {
      // Last-resort restoration if a replacement failed after moving the original.
      if (fs.existsSync(backupOuter)) {
        await fsp.copyFile(backupOuter, parentPath).catch(() => {});
        await fsp.rm(backupOuter, { force: true }).catch(() => {});
      }
    }
  }
}

ipcMain.handle('archive:writeBackNested', async (_event, payload) => {
  try {
    return await writeBackNestedArchive(payload || {});
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:discardNested', async (_event, payload) => {
  const outerArchivePath = (payload || {}).outerArchivePath;
  if (outerArchivePath) invalidateNestedArchives(outerArchivePath);
  const nestedFilePath = (payload || {}).nestedFilePath;
  if (nestedFilePath) invalidateDragSessions(nestedFilePath);
  return { success: true };
});

ipcMain.handle('archive:openNested', async (_event, payload) => {
  try {
    return await openNestedArchive(payload || {});
  } catch (error) {
    sendProgress({
      format: 'nested',
      phase: 'error',
      percent: null,
      done: 0,
      total: null,
      entry: '',
      message: error.message || String(error),
    });
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:cleanupNested', async () => {
  await cleanupAllNestedArchives();
  return { success: true };
});

/* ------------------------------------------------------------------ */
/* IPC handlers                                                        */
/* ------------------------------------------------------------------ */

ipcMain.handle('dialog:openArchive', async () => {
  const lastOpenDir = getAppSettings().getExistingDir('lastOpenDir');
  const options = {
    title: 'Open archive',
    properties: ['openFile'],
    filters: [
      { name: 'Archives', extensions: [...ARCHIVE_EXTENSIONS, 'scs'] },
      { name: 'ZIP archives', extensions: ['zip'] },
      { name: 'RAR archives', extensions: ['rar'] },
      { name: '7z archives', extensions: ['7z'] },
      { name: 'TAR archives', extensions: ['tar'] },
      { name: 'Compressed streams', extensions: ['gz', 'bz2', 'xz'] },
      { name: 'Disk images', extensions: ['iso'] },
      { name: 'CAB archives', extensions: ['cab'] },
      {
        name: 'SCS archives (Euro Truck Simulator 2 / American Truck Simulator)',
        extensions: ['scs'],
      },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  if (lastOpenDir) options.defaultPath = lastOpenDir;
  const result = await dialog.showOpenDialog(mainWindow, options);

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, filePath: null };
  }
  return { canceled: false, filePath: result.filePaths[0] };
});

ipcMain.handle('dialog:selectOutputDir', async () => {
  const lastExtractDir = getAppSettings().getExistingDir('lastExtractDir');
  const options = {
    title: 'Select a folder to extract to',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Extract here',
  };
  if (lastExtractDir) options.defaultPath = lastExtractDir;
  const result = await dialog.showOpenDialog(mainWindow, options);

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, filePath: null };
  }
  const selected = path.resolve(result.filePaths[0]);
  getAppSettings().set('lastExtractDir', selected);
  return { canceled: false, filePath: selected };
});

ipcMain.handle('dialog:dropChoice', async (_event, payload) => {
  const rawName = payload && typeof payload.fileName === 'string' ? payload.fileName : '';
  const fileName = rawName ? path.basename(rawName) : 'this archive';
  const options = {
    type: 'question',
    buttons: ['Add to archive', 'Open it', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Dropped archive',
    message: `What should OpenZip do with ${fileName}?`,
    detail: 'Add it as a file inside the open archive, or open it instead.',
  };
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (result.response === 0) return 'add';
  if (result.response === 1) return 'open';
  return 'cancel';
});

async function readArchiveForRenderer(filePath) {
  if (!filePath) throw new Error('No file path was provided.');

  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`File not found: ${filePath}`);
  }

  const magic = await readMagic(filePath);
  const parsed = await readArchive(filePath, stat, magic);
  rememberArchiveFolder(filePath);

  // Only the currently open archive is needed for extraction bookkeeping.
  archiveMetaCache.clear();
  archiveMetaCache.set(filePath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    fileCount: parsed.stats.fileCount,
    format: parsed.format,
    entries: parsed.entries,
  });

  return {
    ok: true,
    filePath,
    fileName: path.basename(filePath),
    fileSize: stat.size,
    format: parsed.format,
    entries: parsed.entries,
    stats: parsed.stats,
    note:
      parsed.note ??
      (parsed.isScs
        ? 'HashFS container detected. Extracting it will unpack the archive with the bundled SCS extractor.'
        : null),
  };
}

ipcMain.handle('archive:read', async (_event, filePath) => {
  try {
    return await readArchiveForRenderer(filePath);
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:refresh', async (_event, filePath) => {
  try {
    if (filePath) {
      archiveMetaCache.delete(filePath);
      scsIndexCache.delete(filePath);
    }
    return await readArchiveForRenderer(filePath);
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:extract', async (_event, payload) => {
  try {
    return await extractArchive(payload || {});
  } catch (error) {
    sendProgress({
      format: 'error',
      phase: 'error',
      message: error.message || String(error),
      percent: null,
      done: 0,
      total: null,
      entry: '',
    });
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:readFile', async (_event, payload) => {
  try {
    const { archivePath, entryName } = payload || {};
    const content = await readArchiveEntry(archivePath, entryName);
    return { success: true, content };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:saveFile', async (_event, payload) => {
  try {
    const { archivePath, entryName, newContent } = payload || {};
    await saveArchiveEntry(archivePath, entryName, newContent);
    invalidateDragSessions(archivePath);
    invalidateNestedArchives(archivePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:chooseScsModPath', async (_event, payload) => {
  try {
    return await chooseScsPath({ archivePath: (payload || {}).archivePath, mode: 'mod' });
  } catch (error) {
    return { canceled: false, filePath: null, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:chooseScsCopyPath', async (_event, payload) => {
  try {
    return await chooseScsPath({ archivePath: (payload || {}).archivePath, mode: 'copy' });
  } catch (error) {
    return { canceled: false, filePath: null, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:saveScsMod', async (_event, payload) => {
  try {
    const result = await saveScsMod(payload || {});
    if (result.success) {
      invalidateDragSessions((payload || {}).archivePath);
      invalidateDragSessions((payload || {}).modPath);
      invalidateNestedArchives((payload || {}).archivePath);
      invalidateNestedArchives((payload || {}).modPath);
    }
    return result;
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:saveScsCopy', async (_event, payload) => {
  try {
    const result = await saveScsModifiedCopy(payload || {});
    if (result.success) {
      invalidateDragSessions((payload || {}).archivePath);
      invalidateDragSessions((payload || {}).outputPath);
      invalidateNestedArchives((payload || {}).archivePath);
      invalidateNestedArchives((payload || {}).outputPath);
    }
    return result;
  } catch (error) {
    sendProgress({
      format: 'scs',
      phase: 'error',
      percent: null,
      done: null,
      total: null,
      entry: '',
      message: error.message || String(error),
    });
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:readImage', async (_event, payload) => {
  try {
    const { archivePath, entryName } = payload || {};
    const base64 = await readImageEntry(archivePath, entryName);
    return { success: true, base64 };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:addFiles', async (_event, payload) => {
  try {
    const result = await addFilesToArchive(payload || {});
    if (result.success) {
      invalidateDragSessions((payload || {}).archivePath);
      invalidateNestedArchives((payload || {}).archivePath);
    }
    return result;
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:initialPath', () => {
  const initial = pendingInitialArchive;
  pendingInitialArchive = null;
  return initial;
});

ipcMain.handle('app:getVersion', () => ({
  version: app.getVersion(),
  packaged: app.isPackaged,
}));

ipcMain.handle('shell:openExternal', async (_event, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  }
  return { success: false, error: 'Invalid protocol' };
});

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  getAppSettings();
  void sweepStaleTempFolders().catch(() => {});
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  cleanupAllDragRootsSync();
  cleanupAllNestedArchivesSync();
});

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

const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 950,
    height: 650,
    minWidth: 780,
    minHeight: 480,
    title: 'OpenZip',
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
    throw new Error('HashFS .scs containers cannot be opened in place.');
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
    throw new Error('HashFS .scs containers cannot be edited in place. Extract the files and repack the mod.');
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

async function addFilesToArchive({ archivePath, filePaths, targetDir }) {
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

function readScs(filePath, fileName, stat) {
  // HashFS archives are opaque: they are exposed as one extractable container
  // and unpacked by the bundled SCS extractor executable.
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
      'The bundled SCS extractor (bin/extractor.exe) is missing. Reinstall OpenZip with its bin folder.',
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
/* IPC handlers                                                        */
/* ------------------------------------------------------------------ */

ipcMain.handle('dialog:openArchive', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
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
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, filePath: null };
  }
  return { canceled: false, filePath: result.filePaths[0] };
});

ipcMain.handle('dialog:selectOutputDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a folder to extract to',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Extract here',
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, filePath: null };
  }
  return { canceled: false, filePath: result.filePaths[0] };
});

ipcMain.handle('archive:read', async (_event, filePath) => {
  try {
    if (!filePath) throw new Error('No file path was provided.');

    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new Error(`File not found: ${filePath}`);
    }

    const magic = await readMagic(filePath);
    const parsed = await readArchive(filePath, stat, magic);

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
      note: parsed.isScs
        ? 'HashFS container detected. Extracting it will unpack the archive with the bundled SCS extractor.'
        : null,
    };
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
    return { success: true };
  } catch (error) {
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
    return await addFilesToArchive(payload || {});
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('archive:initialPath', () => {
  const initial = pendingInitialArchive;
  pendingInitialArchive = null;
  return initial;
});

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
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

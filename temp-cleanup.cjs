'use strict';

/**
 * Startup cleanup for temp folders created by OpenZip.
 *
 * Only directories whose names start with one of the exact managed prefixes are
 * considered. Anything else in the system temp directory is left untouched.
 */

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MANAGED_TEMP_PREFIXES = [
  'openzip-drag-',
  'openzip-edit-',
  'openzip-add-',
  'openzip-nested-',
];
const MAX_TEMP_AGE_MS = 24 * 60 * 60 * 1000;

function isManagedTempName(name) {
  return (
    typeof name === 'string' &&
    MANAGED_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

async function sweepStaleTempFolders({
  tmpDir = os.tmpdir(),
  now = Date.now(),
  maxAgeMs = MAX_TEMP_AGE_MS,
} = {}) {
  const root = path.resolve(tmpDir);
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const removed = [];
  const kept = [];
  const errors = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !isManagedTempName(entry.name)) continue;

    const target = path.resolve(path.join(root, entry.name));
    if (path.dirname(target) !== root) continue;

    const stat = await fsp.stat(target).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;

    if (now - stat.mtimeMs <= maxAgeMs) {
      kept.push(entry.name);
      continue;
    }

    try {
      await fsp.rm(target, { recursive: true, force: true });
      removed.push(entry.name);
    } catch (error) {
      errors.push({ name: entry.name, error: error.message || String(error) });
    }
  }

  return { removed, kept, errors };
}

module.exports = {
  MANAGED_TEMP_PREFIXES,
  MAX_TEMP_AGE_MS,
  isManagedTempName,
  sweepStaleTempFolders,
};

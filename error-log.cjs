'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE_NAME = 'openzip-errors.log';
const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_STACK_CHARS = 6000;

function clip(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}… [truncated]` : value;
}

/**
 * Append-only error log with one rotated backup (<file>.1).
 * Logging never throws: a failing logger must not break the app.
 */
function createErrorLog({ logDir, fileName = DEFAULT_FILE_NAME, maxBytes = DEFAULT_MAX_BYTES, version = '' } = {}) {
  if (!logDir) throw new Error('No log directory was provided.');
  const filePath = path.join(logDir, fileName);
  let headerWritten = false;

  function rotateIfNeeded() {
    try {
      if (fs.statSync(filePath).size >= maxBytes) {
        fs.renameSync(filePath, `${filePath}.1`);
      }
    } catch {
      // No file yet, or rotation failed; carry on.
    }
  }

  function log(context, error, details) {
    try {
      const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
      const stack = error instanceof Error && error.stack ? error.stack : '';
      const lines = [`${new Date().toISOString()} [${clip(context, 120)}] ${clip(message, MAX_MESSAGE_CHARS)}`];
      if (details) lines.push(`  details: ${clip(details, 2000)}`);
      if (stack) {
        const body = stack.split('\n').slice(1).join('\n');
        if (body.trim()) lines.push(clip(body, MAX_STACK_CHARS));
      }
      fs.mkdirSync(logDir, { recursive: true });
      rotateIfNeeded();
      if (!headerWritten) {
        // Written lazily so the file only exists once something has gone wrong.
        lines.unshift(`=== OpenZip ${version} session ${new Date().toISOString()} (${process.platform}) ===`);
        headerWritten = true;
      }
      fs.appendFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  return { filePath, logDir, log };
}

module.exports = { DEFAULT_FILE_NAME, DEFAULT_MAX_BYTES, createErrorLog };

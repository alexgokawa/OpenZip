'use strict';
// Usage: node scripts/error-log-selftest.cjs
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createErrorLog } = require(path.join(__dirname, '..', 'error-log.cjs'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openzip-log-'));
try {
  const log = createErrorLog({ logDir: path.join(dir, 'logs'), maxBytes: 600, version: 'test' });

  assert.ok(!fs.existsSync(log.filePath), 'no file until the first error');
  assert.strictEqual(log.log('ipc:archive:read', new Error('boom'), 'archivePath=C:\\x.scs'), true);
  let text = fs.readFileSync(log.filePath, 'utf8');
  assert.match(text, /=== OpenZip test session /);
  assert.strictEqual(text.split('=== OpenZip').length - 1, 1, 'header once per session');
  assert.match(text, /\[ipc:archive:read\] boom/);
  assert.match(text, /details: archivePath=C:\\x\.scs/);
  assert.match(text, /at /); // stack frames present

  assert.strictEqual(log.log('x', 'plain string error'), true);
  assert.match(fs.readFileSync(log.filePath, 'utf8'), /plain string error/);

  // Rotation: exceed maxBytes, expect a .1 backup and a fresh file.
  for (let i = 0; i < 12; i += 1) log.log('fill', new Error('y'.repeat(80)));
  assert.ok(fs.existsSync(`${log.filePath}.1`), 'backup file should exist');
  assert.ok(fs.statSync(log.filePath).size < 2000, 'active file should stay small');

  // Never throws, even when the directory cannot be created.
  const blocked = path.join(dir, 'file.txt');
  fs.writeFileSync(blocked, 'x');
  const bad = createErrorLog({ logDir: path.join(blocked, 'sub') });
  assert.strictEqual(bad.log('x', new Error('nope')), false);

  // Huge messages are clipped.
  log.log('big', new Error('z'.repeat(50000)));
  assert.ok(fs.readFileSync(log.filePath, 'utf8').length < 12000);

  console.log('error-log self-test: all checks passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

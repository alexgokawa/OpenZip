'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS_FILE = 'settings.json';
const SETTINGS_KEYS = ['lastOpenDir', 'lastExtractDir'];

function createSettingsStore({ userDataPath, fileName = DEFAULT_SETTINGS_FILE } = {}) {
  if (!userDataPath) throw new Error('No user data directory was provided.');
  const filePath = path.join(userDataPath, fileName);
  const values = {};
  let loaded = false;

  function load() {
    if (loaded) return { ...values };
    loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const key of SETTINGS_KEYS) {
          if (typeof parsed[key] === 'string' && parsed[key].trim()) {
            values[key] = path.resolve(parsed[key]);
          }
        }
      }
    } catch {
      // Missing or corrupt settings are ignored; defaults stay empty.
    }
    return { ...values };
  }

  function get(key) {
    load();
    return typeof values[key] === 'string' ? values[key] : null;
  }

  function getExistingDir(key) {
    const value = get(key);
    if (!value) return null;
    try {
      return fs.statSync(value).isDirectory() ? value : null;
    } catch {
      return null;
    }
  }

  function set(key, value) {
    if (!SETTINGS_KEYS.includes(key) || typeof value !== 'string' || !value.trim()) {
      return false;
    }
    load();
    const normalized = path.resolve(value.trim());
    if (values[key] === normalized) return false;

    const previous = values[key];
    values[key] = normalized;
    try {
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(values, null, 2), 'utf8');
      return true;
    } catch {
      if (previous === undefined) delete values[key];
      else values[key] = previous;
      return false;
    }
  }

  return { filePath, load, get, getExistingDir, set };
}

module.exports = {
  DEFAULT_SETTINGS_FILE,
  SETTINGS_KEYS,
  createSettingsStore,
};

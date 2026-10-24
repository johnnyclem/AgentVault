/**
 * The webapp's /settings preferences
 * (webapp/src/app/(dashboard)/settings/settings-storage.ts), kept in the
 * browser's localStorage. Number fields are clamped so an emptied input
 * (parseInt('') is NaN) or an out-of-range value is never stored, a damaged
 * entry falls back to the defaults field by field, and blocked storage is
 * reported rather than thrown.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { join } from 'node:path';

interface DashboardSettings {
  autoRefresh: boolean;
  refreshInterval: number;
  notifications: boolean;
  sound: boolean;
  autoBackup: boolean;
  backupInterval: number;
}

interface IntervalBounds {
  min: number;
  max: number;
}

interface SettingsStorageModule {
  REFRESH_INTERVAL: IntervalBounds;
  BACKUP_INTERVAL: IntervalBounds;
  DEFAULT_SETTINGS: DashboardSettings;
  SETTINGS_STORAGE_KEY: string;
  clampInterval: (value: unknown, bounds: IntervalBounds, fallback: number) => number;
  parseSettings: (raw: string | null) => DashboardSettings;
  loadSettings: () => DashboardSettings | null;
  saveSettings: (settings: DashboardSettings) => boolean;
}

// Loaded by path, so the root typecheck does not compile the webapp
const MODULE = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'app', '(dashboard)', 'settings', 'settings-storage.ts');
let storage: SettingsStorageModule;

beforeAll(async () => {
  storage = (await import(MODULE)) as SettingsStorageModule;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function memoryStorage(): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
  };
}

const blocked = () => {
  throw new Error('SecurityError: storage is disabled');
};

describe('clampInterval', () => {
  it('keeps the fallback for an empty field or anything that is not a number', () => {
    for (const value of ['', '   ', 'abc', Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}]) {
      expect(storage.clampInterval(value, storage.REFRESH_INTERVAL, 30)).toBe(30);
    }
  });

  it('clamps into range and rounds to a whole number', () => {
    expect(storage.clampInterval('5', storage.REFRESH_INTERVAL, 30)).toBe(10);
    expect(storage.clampInterval(9000, storage.REFRESH_INTERVAL, 30)).toBe(300);
    expect(storage.clampInterval('12.6', storage.BACKUP_INTERVAL, 24)).toBe(13);
    expect(storage.clampInterval(0, storage.BACKUP_INTERVAL, 24)).toBe(1);
  });
});

describe('parseSettings', () => {
  it('returns the defaults when nothing usable is stored', () => {
    for (const raw of [null, '', '{not json', '[]', '42', 'null']) {
      expect(storage.parseSettings(raw)).toEqual(storage.DEFAULT_SETTINGS);
    }
  });

  it('keeps valid fields, defaults the wrong-typed ones and clamps the intervals', () => {
    const raw = JSON.stringify({ autoRefresh: false, refreshInterval: 2, sound: 'yes', backupInterval: 'NaN', extra: 1 });

    expect(storage.parseSettings(raw)).toEqual({
      ...storage.DEFAULT_SETTINGS,
      autoRefresh: false,
      refreshInterval: 10,
    });
  });
});

describe('loadSettings and saveSettings', () => {
  it('round-trips through localStorage under the settings key', () => {
    const localStorage = memoryStorage();
    vi.stubGlobal('window', { localStorage });
    const changed = { ...storage.DEFAULT_SETTINGS, sound: true, backupInterval: 48 };

    expect(storage.saveSettings(changed)).toBe(true);
    expect(JSON.parse(localStorage.getItem(storage.SETTINGS_STORAGE_KEY) ?? 'null')).toEqual(changed);
    expect(storage.loadSettings()).toEqual(changed);
  });

  it('reports blocked storage instead of throwing', () => {
    vi.stubGlobal('window', { localStorage: { getItem: blocked, setItem: blocked } });

    expect(storage.loadSettings()).toBeNull();
    expect(storage.saveSettings(storage.DEFAULT_SETTINGS)).toBe(false);
  });

  it('reports no storage at all, as during a server render', () => {
    expect(storage.loadSettings()).toBeNull();
    expect(storage.saveSettings(storage.DEFAULT_SETTINGS)).toBe(false);
  });
});

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  BackupRetentionManager,
  KEY_RETENTION_KEEP_LAST,
  KEY_RETENTION_KEEP_LAST_DAY,
  KEY_RETENTION_KEEP_LAST_MONTH,
  KEY_RETENTION_KEEP_LAST_WEEK,
  KEY_RETENTION_KEEP_LAST_YEAR,
} from '../src/backupRetentionManager.ts';
import type { Env } from '../src/env.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('BackupRetentionManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'notion-keeper-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function envOf(values: Record<string, string>): Env {
    return { get: (key) => values[key] };
  }

  function buildManager(keepLast: number, keepLastDay: number, keepLastWeek: number,
    keepLastMonth: number, keepLastYear: number): BackupRetentionManager {
    return new BackupRetentionManager(envOf({
      [KEY_RETENTION_KEEP_LAST]: String(keepLast),
      [KEY_RETENTION_KEEP_LAST_DAY]: String(keepLastDay),
      [KEY_RETENTION_KEEP_LAST_WEEK]: String(keepLastWeek),
      [KEY_RETENTION_KEEP_LAST_MONTH]: String(keepLastMonth),
      [KEY_RETENTION_KEEP_LAST_YEAR]: String(keepLastYear),
    }), tempDir);
  }

  function createBackup(name: string, timestampMs: number): string {
    const filePath = createFile(name);
    const time = new Date(timestampMs);
    utimesSync(filePath, time, time);
    return filePath;
  }

  function createFile(name: string): string {
    const filePath = join(tempDir, name);
    writeFileSync(filePath, '');
    return filePath;
  }

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  test('applyRetentionPolicy_emptyDirectory_doesNotThrow', () => {
    const manager = buildManager(5, 1, 3, 8, 12);
    manager.applyRetentionPolicy();
  });

  test('applyRetentionPolicy_nonExistentDirectory_doesNotThrow', () => {
    const manager = new BackupRetentionManager(envOf({
      [KEY_RETENTION_KEEP_LAST]: '5',
      [KEY_RETENTION_KEEP_LAST_DAY]: '1',
      [KEY_RETENTION_KEEP_LAST_WEEK]: '3',
      [KEY_RETENTION_KEEP_LAST_MONTH]: '8',
      [KEY_RETENTION_KEEP_LAST_YEAR]: '12',
    }), '/path/does/not/exist');
    manager.applyRetentionPolicy();
  });

  test('applyRetentionPolicy_nonBackupFilesAreNeverDeleted', () => {
    const logFile = createFile('logfile.log');
    const notes = createFile('notes.txt');
    const manager = buildManager(0, 0, 0, 0, 0);

    manager.applyRetentionPolicy();

    assert.ok(existsSync(logFile));
    assert.ok(existsSync(notes));
  });

  test('applyRetentionPolicy_allRulesDisabled_deletesAllBackups', () => {
    const now = Date.now();
    const f1h = createBackup('notion-export-1h.zip', now - HOUR_MS);
    const f5d = createBackup('notion-export-5d.zip', now - 5 * DAY_MS);
    const manager = buildManager(0, 0, 0, 0, 0);

    manager.applyRetentionPolicy();

    assert.ok(!existsSync(f1h));
    assert.ok(!existsSync(f5d));
  });

  // ---------------------------------------------------------------------------
  // keepLast rule
  // ---------------------------------------------------------------------------

  test('applyRetentionPolicy_keepLast_keepsNewestN_deletesOlderOnes', () => {
    const now = Date.now();
    const f1h = createBackup('notion-export-1h.zip', now - HOUR_MS);
    const f2h = createBackup('notion-export-2h.zip', now - 2 * HOUR_MS);
    const f3h = createBackup('notion-export-3h.zip', now - 3 * HOUR_MS);
    const f4h = createBackup('notion-export-4h.zip', now - 4 * HOUR_MS);
    const f5h = createBackup('notion-export-5h.zip', now - 5 * HOUR_MS);
    const manager = buildManager(3, 0, 0, 0, 0);

    manager.applyRetentionPolicy();

    assert.ok(existsSync(f1h));
    assert.ok(existsSync(f2h));
    assert.ok(existsSync(f3h));
    assert.ok(!existsSync(f4h));
    assert.ok(!existsSync(f5h));
  });

  test('applyRetentionPolicy_keepLast_savesFilesOlderThanAllTimeWindows', () => {
    // keepLast has no time bounds — even a very old file is kept if it is among the N most recent
    const now = Date.now();
    const f400d = createBackup('notion-export-400d.zip', now - 400 * DAY_MS);
    const manager = buildManager(1, 0, 0, 0, 0);

    manager.applyRetentionPolicy();

    assert.ok(existsSync(f400d));
  });

  // ---------------------------------------------------------------------------
  // keepLastDay rule — exclusive window: (now-1d, now]
  // ---------------------------------------------------------------------------

  test('applyRetentionPolicy_keepLastDay_keepsOldestNFromDayWindow', () => {
    // Three files all within 24 h; oldest two should survive with keepLastDay=2
    const now = Date.now();
    const f2h = createBackup('notion-export-2h.zip', now - 2 * HOUR_MS);
    const f8h = createBackup('notion-export-8h.zip', now - 8 * HOUR_MS);
    const f20h = createBackup('notion-export-20h.zip', now - 20 * HOUR_MS);
    const manager = buildManager(0, 2, 0, 0, 0);

    manager.applyRetentionPolicy();

    assert.ok(existsSync(f8h));
    assert.ok(existsSync(f20h));
    assert.ok(!existsSync(f2h));
  });

  // ---------------------------------------------------------------------------
  // keepLastWeek rule — exclusive window: (now-7d, now-1d]
  // ---------------------------------------------------------------------------

  test('applyRetentionPolicy_keepLastWeek_usesExclusiveWindow_doesNotOverlapWithDay', () => {
    // File in day window must NOT count towards the week quota
    const now = Date.now();
    const f12h = createBackup('notion-export-12h.zip', now - 12 * HOUR_MS); // day window
    const f2d = createBackup('notion-export-2d.zip', now - 2 * DAY_MS); // week exclusive
    const f5d = createBackup('notion-export-5d.zip', now - 5 * DAY_MS); // week exclusive
    const manager = buildManager(0, 0, 1, 0, 0);

    manager.applyRetentionPolicy();

    // keepLastWeek=1 picks the OLDEST from the exclusive week window
    assert.ok(existsSync(f5d));
    assert.ok(!existsSync(f12h)); // day window, not covered by any rule
    assert.ok(!existsSync(f2d)); // not the oldest in the week window
  });

  test('applyRetentionPolicy_keepLastWeek_keepsOldestN', () => {
    const now = Date.now();
    const f2d = createBackup('notion-export-2d.zip', now - 2 * DAY_MS);
    const f4d = createBackup('notion-export-4d.zip', now - 4 * DAY_MS);
    const f6d = createBackup('notion-export-6d.zip', now - 6 * DAY_MS);
    const manager = buildManager(0, 0, 2, 0, 0);

    manager.applyRetentionPolicy();

    assert.ok(existsSync(f4d));
    assert.ok(existsSync(f6d));
    assert.ok(!existsSync(f2d));
  });

  // ---------------------------------------------------------------------------
  // keepLastMonth rule — exclusive window: (now-30d, now-7d]
  // ---------------------------------------------------------------------------

  test('applyRetentionPolicy_keepLastMonth_usesExclusiveWindow_doesNotOverlapWithWeek', () => {
    const now = Date.now();
    const f3d = createBackup('notion-export-3d.zip', now - 3 * DAY_MS); // week window
    const f10d = createBackup('notion-export-10d.zip', now - 10 * DAY_MS); // month exclusive
    const f25d = createBackup('notion-export-25d.zip', now - 25 * DAY_MS); // month exclusive
    const manager = buildManager(0, 0, 0, 1, 0);

    manager.applyRetentionPolicy();

    assert.ok(existsSync(f25d));
    assert.ok(!existsSync(f3d)); // week window, not covered
    assert.ok(!existsSync(f10d)); // not the oldest in the month window
  });

  // ---------------------------------------------------------------------------
  // keepLastYear rule — exclusive window: (now-365d, now-30d]
  // ---------------------------------------------------------------------------

  test('applyRetentionPolicy_keepLastYear_usesExclusiveWindow_doesNotOverlapWithMonth', () => {
    const now = Date.now();
    const f15d = createBackup('notion-export-15d.zip', now - 15 * DAY_MS); // month window
    const f45d = createBackup('notion-export-45d.zip', now - 45 * DAY_MS); // year exclusive
    const f200d = createBackup('notion-export-200d.zip', now - 200 * DAY_MS); // year exclusive
    const manager = buildManager(0, 0, 0, 0, 1);

    manager.applyRetentionPolicy();

    assert.ok(existsSync(f200d));
    assert.ok(!existsSync(f15d)); // month window, not covered
    assert.ok(!existsSync(f45d)); // not the oldest in the year window
  });

  test('applyRetentionPolicy_filesOlderThanOneYear_deletedWhenNotCoveredByKeepLast', () => {
    const now = Date.now();
    const f400d = createBackup('notion-export-400d.zip', now - 400 * DAY_MS);
    const manager = buildManager(0, 1, 1, 1, 1);

    manager.applyRetentionPolicy();

    assert.ok(!existsSync(f400d));
  });

  // ---------------------------------------------------------------------------
  // Config parsing
  // ---------------------------------------------------------------------------

  for (const [description, keepLastValue] of [['invalidEnvVar', 'not-a-number'], ['negativeEnvVar', '-3']]) {
    test(`applyRetentionPolicy_${description}_fallsBackToDefaultKeepLast`, () => {
      // Create 6 files; the bad env var for keepLast should fall back to the default (5)
      const now = Date.now();
      const files = [1, 2, 3, 4, 5, 6].map((hours) => createBackup(`notion-export-${hours}h.zip`, now - hours * HOUR_MS));
      const manager = new BackupRetentionManager(envOf({
        [KEY_RETENTION_KEEP_LAST]: keepLastValue,
        [KEY_RETENTION_KEEP_LAST_DAY]: '0',
        [KEY_RETENTION_KEEP_LAST_WEEK]: '0',
        [KEY_RETENTION_KEEP_LAST_MONTH]: '0',
        [KEY_RETENTION_KEEP_LAST_YEAR]: '0',
      }), tempDir);

      manager.applyRetentionPolicy();

      // Default keepLast=5 → 5 most recent kept, 6th deleted
      for (const file of files.slice(0, 5)) {
        assert.ok(existsSync(file), file);
      }
      assert.ok(!existsSync(files[5]));
    });
  }

  test('applyRetentionPolicy_missingEnvVars_useDefaults', () => {
    const now = Date.now();
    const files = [1, 2, 3, 4, 5, 6].map((hours) => createBackup(`notion-export-${hours}h.zip`, now - hours * HOUR_MS));
    const manager = new BackupRetentionManager(envOf({}), tempDir);

    manager.applyRetentionPolicy();

    // keepLast=5 keeps the newest five; keepLastDay=1 keeps the oldest one in the day window (6h)
    for (const file of files) {
      assert.ok(existsSync(file), file);
    }
  });

  // ---------------------------------------------------------------------------
  // Integration: all rules combined
  // ---------------------------------------------------------------------------

  test('applyRetentionPolicy_allRules_eachWindowContributesDistinctFiles', () => {
    const now = Date.now();
    const fDay = createBackup('notion-export-6h.zip', now - 6 * HOUR_MS);
    const fWeek = createBackup('notion-export-3d.zip', now - 3 * DAY_MS);
    const fMonth = createBackup('notion-export-15d.zip', now - 15 * DAY_MS);
    const fYear = createBackup('notion-export-60d.zip', now - 60 * DAY_MS);
    const fOutside = createBackup('notion-export-400d.zip', now - 400 * DAY_MS);
    const manager = buildManager(1, 1, 1, 1, 1);

    manager.applyRetentionPolicy();

    assert.ok(existsSync(fDay));
    assert.ok(existsSync(fWeek));
    assert.ok(existsSync(fMonth));
    assert.ok(existsSync(fYear));
    assert.ok(!existsSync(fOutside));
  });
});

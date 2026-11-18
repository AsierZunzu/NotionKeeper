import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { type Env, isBlank } from './env.ts';
import { createLogger } from './logger.ts';

const log = createLogger('BackupRetentionManager');

export const KEY_RETENTION_KEEP_LAST = 'RETENTION_KEEP_LAST';
export const KEY_RETENTION_KEEP_LAST_DAY = 'RETENTION_KEEP_LAST_DAY';
export const KEY_RETENTION_KEEP_LAST_WEEK = 'RETENTION_KEEP_LAST_WEEK';
export const KEY_RETENTION_KEEP_LAST_MONTH = 'RETENTION_KEEP_LAST_MONTH';
export const KEY_RETENTION_KEEP_LAST_YEAR = 'RETENTION_KEEP_LAST_YEAR';

const DEFAULT_KEEP_LAST = 5;
const DEFAULT_KEEP_LAST_DAY = 1;
const DEFAULT_KEEP_LAST_WEEK = 3;
const DEFAULT_KEEP_LAST_MONTH = 8;
const DEFAULT_KEEP_LAST_YEAR = 12;

const DAY_MS = 24 * 60 * 60 * 1000;
const INT_MAX = 2 ** 31 - 1;

interface BackupFile {
  name: string;
  path: string;
  lastModified: number;
}

export class BackupRetentionManager {

  private readonly keepLast: number;
  private readonly keepLastDay: number;
  private readonly keepLastWeek: number;
  private readonly keepLastMonth: number;
  private readonly keepLastYear: number;
  private readonly downloadsDirectoryPath: string;

  constructor(env: Env, downloadsDirectoryPath: string) {
    this.downloadsDirectoryPath = downloadsDirectoryPath;
    this.keepLast = parseEnvInt(env, KEY_RETENTION_KEEP_LAST, DEFAULT_KEEP_LAST);
    this.keepLastDay = parseEnvInt(env, KEY_RETENTION_KEEP_LAST_DAY, DEFAULT_KEEP_LAST_DAY);
    this.keepLastWeek = parseEnvInt(env, KEY_RETENTION_KEEP_LAST_WEEK, DEFAULT_KEEP_LAST_WEEK);
    this.keepLastMonth = parseEnvInt(env, KEY_RETENTION_KEEP_LAST_MONTH, DEFAULT_KEEP_LAST_MONTH);
    this.keepLastYear = parseEnvInt(env, KEY_RETENTION_KEEP_LAST_YEAR, DEFAULT_KEEP_LAST_YEAR);

    log.info('Retention policy: keepLast={}, keepLastDay={}, keepLastWeek={}, keepLastMonth={}, keepLastYear={}',
      this.keepLast, this.keepLastDay, this.keepLastWeek, this.keepLastMonth, this.keepLastYear);
  }

  applyRetentionPolicy(): void {
    let entries: string[];
    try {
      if (!statSync(this.downloadsDirectoryPath).isDirectory()) {
        throw new Error('not a directory');
      }
      entries = readdirSync(this.downloadsDirectoryPath);
    } catch {
      log.warn('Downloads directory does not exist or is not a directory: {}', this.downloadsDirectoryPath);
      return;
    }

    const backupFiles: BackupFile[] = entries
      .filter((name) => name.startsWith('notion-export') && name.endsWith('.zip'))
      .map((name) => {
        const path = join(this.downloadsDirectoryPath, name);
        return { name, path, lastModified: statSync(path).mtimeMs };
      });

    if (backupFiles.length === 0) {
      log.info('No backup files found in {}. Nothing to clean up.', this.downloadsDirectoryPath);
      return;
    }

    // Sort newest first; oldest-first iteration is done by walking the list in reverse
    const sortedFiles = backupFiles.toSorted((a, b) => b.lastModified - a.lastModified);

    log.info('Applying retention policy to {} backup file(s) in {}', sortedFiles.length, this.downloadsDirectoryPath);

    const now = Date.now();
    const cutDay = now - DAY_MS;
    const cutWeek = now - 7 * DAY_MS;
    const cutMonth = now - 30 * DAY_MS;
    const cutYear = now - 365 * DAY_MS;

    const filesToKeep = new Set<BackupFile>();

    // Unconditional: the N most recent backups regardless of age
    markNewestToKeep(filesToKeep, sortedFiles, this.keepLast, `last ${this.keepLast}`);

    // Time-windowed rules use exclusive, non-overlapping windows so each rule
    // contributes distinct files. Within each window the OLDEST files are chosen
    // to maximise temporal coverage (reach as far back in the window as possible).
    markOldestToKeep(filesToKeep, sortedFiles, this.keepLastDay, cutDay, now, 'last day   (now-1d  → now)');
    markOldestToKeep(filesToKeep, sortedFiles, this.keepLastWeek, cutWeek, cutDay, 'last week  (now-7d  → now-1d)');
    markOldestToKeep(filesToKeep, sortedFiles, this.keepLastMonth, cutMonth, cutWeek, 'last month (now-30d → now-7d)');
    markOldestToKeep(filesToKeep, sortedFiles, this.keepLastYear, cutYear, cutMonth, 'last year  (now-365d→ now-30d)');

    let deleted = 0;
    for (const file of sortedFiles) {
      if (!filesToKeep.has(file)) {
        log.info('Deleting old backup: {}', file.name);
        try {
          unlinkSync(file.path);
          deleted++;
        } catch {
          log.warn('Failed to delete backup file: {}', file.name);
        }
      }
    }

    log.info('Retention policy applied: kept {}, deleted {} backup file(s)', filesToKeep.size, deleted);
  }
}

/** Keeps the N most recent files from the full list (no time bounds). */
function markNewestToKeep(filesToKeep: Set<BackupFile>, sortedFiles: BackupFile[], count: number, label: string): void {
  if (count <= 0) {
    return;
  }
  let marked = 0;
  for (const file of sortedFiles) {
    if (marked >= count) {
      break;
    }
    filesToKeep.add(file);
    marked++;
  }
  log.debug("Retention rule '{}': marked {} file(s) to keep", label, marked);
}

/**
 * Keeps the N oldest files that fall strictly inside (from, to].
 * Using the oldest files in each exclusive window maximises temporal spread:
 * e.g. for "last week" we preserve a backup from ~7 days ago rather than ~2 days ago.
 */
function markOldestToKeep(filesToKeep: Set<BackupFile>, sortedFiles: BackupFile[], count: number,
  from: number, to: number, label: string): void {
  if (count <= 0) {
    return;
  }
  let marked = 0;
  // sortedFiles is newest-first, so iterate in reverse to get oldest-first
  for (let i = sortedFiles.length - 1; i >= 0 && marked < count; i--) {
    const file = sortedFiles[i];
    // Window is exclusive on the lower bound, inclusive on the upper bound: (from, to]
    if (file.lastModified <= from || file.lastModified > to) {
      continue;
    }
    filesToKeep.add(file);
    marked++;
  }
  log.debug("Retention rule '{}': marked {} file(s) to keep", label, marked);
}

function parseEnvInt(env: Env, key: string, defaultValue: number): number {
  const value = env.get(key);
  if (value === undefined || isBlank(value)) {
    return defaultValue;
  }
  // Same accepted syntax as Java's Integer.parseInt: optional sign followed by digits, within int range
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!/^[+-]?\d+$/.test(trimmed) || parsed > INT_MAX || parsed < -INT_MAX - 1) {
    log.warn("Invalid value for {}: '{}'. Using default: {}", key, value, defaultValue);
    return defaultValue;
  }
  if (parsed < 0) {
    log.warn('Negative value for {}: {}. Using default: {}', key, parsed, defaultValue);
    return defaultValue;
  }
  return parsed;
}

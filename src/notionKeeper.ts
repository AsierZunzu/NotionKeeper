import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { CronExpressionParser } from 'cron-parser';

import { BackupRetentionManager } from './backupRetentionManager.ts';
import { type Env, isBlank, loadEnv, parseBoolean } from './env.ts';
import { createLogger } from './logger.ts';
import { NotionClient } from './notionClient.ts';

const log = createLogger('NotionKeeper');

const KEY_SCHEDULING_CONFIG = 'SCHEDULING_CONFIG';
const KEY_RUN_ON_STARTUP = 'RUN_ON_STARTUP';
const KEY_NOTION_SPACE_ID = 'NOTION_SPACE_ID';
const KEY_NOTION_TOKEN_V2 = 'NOTION_TOKEN_V2';
const KEY_NOTION_EXPORT_TYPE = 'NOTION_EXPORT_TYPE';
const KEY_NOTION_FLATTEN_EXPORT_FILETREE = 'NOTION_FLATTEN_EXPORT_FILETREE';
const KEY_NOTION_EXPORT_COMMENTS = 'NOTION_EXPORT_COMMENTS';
const KEY_DOWNLOADS_DIRECTORY_PATH = 'DOWNLOADS_DIRECTORY_PATH';
const DEFAULT_NOTION_EXPORT_TYPE = 'markdown';
const DEFAULT_NOTION_FLATTEN_EXPORT_FILETREE = false;
const DEFAULT_NOTION_EXPORT_COMMENTS = true;
const DEFAULT_DOWNLOADS_PATH = '/downloads';

// Longest delay a single Node.js timer supports (~24.8 days)
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

// Standard Unix crontab nicknames
const CRON_NICKNAMES = new Set(['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']);

export interface Schedule {
  /** Next execution strictly after `from`. */
  nextExecution(from: Date): Date;
}

/** Seams for tests; every default is the real implementation. */
export interface MainDependencies {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  createNotionClient?: (...args: ConstructorParameters<typeof NotionClient>) => Pick<NotionClient, 'export'>;
  createRetentionManager?: (env: Env, downloadsPath: string) => Pick<BackupRetentionManager, 'applyRetentionPolicy'>;
  exit?: (code: number) => never;
}

type ResolvedDependencies = Required<MainDependencies>;

export function resolveDownloadsPath(env: Env): string {
  const downloadsPath = env.get(KEY_DOWNLOADS_DIRECTORY_PATH);
  if (downloadsPath === undefined || isBlank(downloadsPath)) {
    log.info('{} is not set. Downloads will be saved to: {}', KEY_DOWNLOADS_DIRECTORY_PATH, DEFAULT_DOWNLOADS_PATH);
    return DEFAULT_DOWNLOADS_PATH;
  }
  return downloadsPath;
}

/** Parses a Unix (5-field) cron expression. Throws an Error naming SCHEDULING_CONFIG if it is invalid. */
export function parseSchedule(schedulingConfig: string): Schedule {
  const invalid = (cause?: unknown): Error => new Error(
    `${KEY_SCHEDULING_CONFIG} does not contain valid cron syntax. Value was: '${schedulingConfig}'`, { cause });

  // cron-parser also accepts 6-field (seconds) expressions and treats blank input as "* * * * *",
  // so enforce the Unix crontab shape first
  const fields = schedulingConfig.trim().split(/\s+/).filter((field) => field !== '');
  const isNickname = fields.length === 1 && CRON_NICKNAMES.has(fields[0].toLowerCase());
  if (fields.length !== 5 && !isNickname) {
    throw invalid();
  }
  try {
    CronExpressionParser.parse(schedulingConfig);
  } catch (e) {
    throw invalid(e);
  }
  return {
    nextExecution: (from) => CronExpressionParser.parse(schedulingConfig, { currentDate: from }).next().toDate(),
  };
}

function createNotionClient(env: Env, deps: ResolvedDependencies): Pick<NotionClient, 'export'> {
  const spaceId = env.get(KEY_NOTION_SPACE_ID);
  const tokenV2 = env.get(KEY_NOTION_TOKEN_V2);
  if (spaceId === undefined || isBlank(spaceId)) {
    log.error('{} is missing!', KEY_NOTION_SPACE_ID);
    deps.exit(1);
  }
  if (tokenV2 === undefined || isBlank(tokenV2)) {
    log.error('{} is missing!', KEY_NOTION_TOKEN_V2);
    deps.exit(1);
  }
  const downloadsPath = resolveDownloadsPath(env);
  const exportType = env.get(KEY_NOTION_EXPORT_TYPE);
  const flattenExportFileTree = env.get(KEY_NOTION_FLATTEN_EXPORT_FILETREE);
  const exportComments = env.get(KEY_NOTION_EXPORT_COMMENTS);
  return deps.createNotionClient(
    spaceId,
    tokenV2,
    downloadsPath,
    exportType !== undefined && !isBlank(exportType) ? exportType : DEFAULT_NOTION_EXPORT_TYPE,
    flattenExportFileTree !== undefined && !isBlank(flattenExportFileTree)
      ? parseBoolean(flattenExportFileTree) : DEFAULT_NOTION_FLATTEN_EXPORT_FILETREE,
    exportComments !== undefined && !isBlank(exportComments)
      ? parseBoolean(exportComments) : DEFAULT_NOTION_EXPORT_COMMENTS,
  );
}

/** Local date-time with UTC offset and zone, e.g. 2026-11-19T02:00:00+01:00[Europe/Madrid]. */
function formatZonedDateTime(date: Date): string {
  const pad = (value: number): string => String(Math.abs(value)).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const offset = offsetMinutes === 0
    ? 'Z'
    : `${offsetMinutes > 0 ? '+' : '-'}${pad(Math.trunc(offsetMinutes / 60))}:${pad(offsetMinutes % 60)}`;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}[${zone}]`;
}

async function sleepUntilNextRun(schedule: Schedule, deps: ResolvedDependencies): Promise<void> {
  const now = deps.now();
  const next = schedule.nextExecution(now);

  log.info('Next backup scheduled at: {}', formatZonedDateTime(next));

  let remaining = next.getTime() - now.getTime();
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_TIMER_DELAY_MS);
    await deps.sleep(chunk);
    remaining -= chunk;
  }
}

async function runBackup(env: Env, deps: ResolvedDependencies): Promise<void> {
  log.info('---------------- Starting backup ----------------');
  try {
    const exportedFile = await createNotionClient(env, deps).export();
    if (exportedFile === undefined) {
      log.error('Backup failed: could not export Notion file');
      return;
    }
    log.info('Backup completed successfully: {}', basename(exportedFile));
  } catch (e) {
    log.error('Backup failed with exception', e);
  }
  log.info('---------------- Backup finished ----------------');
}

function runCleanup(env: Env, deps: ResolvedDependencies): void {
  log.info('---------------- Starting cleanup ----------------');
  try {
    const downloadsPath = resolveDownloadsPath(env);
    deps.createRetentionManager(env, downloadsPath).applyRetentionPolicy();
    log.info('Cleanup completed successfully.');
  } catch (e) {
    log.error('Cleanup failed with exception', e);
  }
  log.info('---------------- Cleanup finished ----------------');
}

export async function main(env: Env, dependencies: MainDependencies = {}): Promise<void> {
  const deps: ResolvedDependencies = {
    now: dependencies.now ?? (() => new Date()),
    sleep: dependencies.sleep ?? ((ms) => delay(ms)),
    createNotionClient: dependencies.createNotionClient ?? ((...args) => new NotionClient(...args)),
    createRetentionManager: dependencies.createRetentionManager
      ?? ((retentionEnv, downloadsPath) => new BackupRetentionManager(retentionEnv, downloadsPath)),
    exit: dependencies.exit ?? ((code) => process.exit(code)),
  };

  log.info('---------------- Starting NotionKeeper ----------------');

  // Exit promptly on `docker stop` / Ctrl+C (Node running as PID 1 ignores signals without handlers)
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
    process.on(signal, () => {
      log.info('Scheduler interrupted, shutting down');
      deps.exit(code);
    });
  }

  const schedulingConfig = (env.get(KEY_SCHEDULING_CONFIG) ?? '').trim();
  let schedule: Schedule;
  try {
    schedule = parseSchedule(schedulingConfig);
  } catch (e) {
    log.error((e as Error).message);
    deps.exit(1);
  }

  log.info("Scheduling backup with cron syntax '{}'", schedulingConfig);

  if (parseBoolean(env.get(KEY_RUN_ON_STARTUP) ?? 'false')) {
    log.info('RUN_ON_STARTUP is enabled, running backup now');
    await runBackup(env, deps);
    runCleanup(env, deps);
  }

  for (;;) {
    await sleepUntilNextRun(schedule, deps);
    await runBackup(env, deps);
    runCleanup(env, deps);
  }
}

if (import.meta.main) {
  await main(loadEnv());
}

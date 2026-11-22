import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Env } from '../src/env.ts';
import { type MainDependencies, main, parseSchedule, resolveDownloadsPath } from '../src/notionKeeper.ts';

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function envOf(values: Record<string, string>): Env {
  return { get: (key) => values[key] };
}

/** Thrown by the fake exit, since the real process.exit never returns. */
class ExitCalled extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit(${code})`);
    this.code = code;
  }
}

/** Thrown by the fake sleep to break out of the scheduler's infinite loop. */
class StopScheduler extends Error {}

interface MainRun {
  error: unknown;
  /** Ordered trace: 'sleep:<ms>', 'export', 'cleanup'. */
  events: string[];
  clientArgs: unknown[][];
  retentionPaths: string[];
  exitCodes: number[];
}

interface MainRunOptions {
  start?: Date;
  /** The fake sleep stops the scheduler once this many backup + cleanup cycles have run. */
  cycles?: number;
  exportResult?: () => Promise<string | undefined>;
  applyRetentionPolicy?: () => void;
}

const VALID_ENV = {
  SCHEDULING_CONFIG: '0 2 * * *',
  NOTION_SPACE_ID: 'test-space-id',
  NOTION_TOKEN_V2: 'test-token-v2',
};

function createHarness(options: MainRunOptions = {}): { run: MainRun; deps: MainDependencies } {
  const run: MainRun = { error: undefined, events: [], clientArgs: [], retentionPaths: [], exitCodes: [] };
  let now = options.start ?? new Date(2026, 0, 1, 1, 59, 0);
  const deps: MainDependencies = {
    now: () => now,
    sleep: async (ms) => {
      run.events.push(`sleep:${ms}`);
      if (run.retentionPaths.length >= (options.cycles ?? 1)) {
        throw new StopScheduler();
      }
      now = new Date(now.getTime() + ms);
    },
    createNotionClient: (...args) => {
      run.clientArgs.push(args);
      return {
        export: () => {
          run.events.push('export');
          return options.exportResult?.() ?? Promise.resolve('/downloads/notion-export-markdown_2026-01-01.zip');
        },
      };
    },
    createRetentionManager: (_env, downloadsPath) => {
      run.retentionPaths.push(downloadsPath);
      return {
        applyRetentionPolicy: () => {
          run.events.push('cleanup');
          options.applyRetentionPolicy?.();
        },
      };
    },
    exit: (code) => {
      run.exitCodes.push(code);
      throw new ExitCalled(code);
    },
  };
  return { run, deps };
}

async function runMain(values: Record<string, string>, options: MainRunOptions = {}): Promise<MainRun> {
  const { run, deps } = createHarness(options);
  run.error = await main(envOf(values), deps).then(() => undefined, (e: unknown) => e);
  return run;
}

describe('NotionKeeper', () => {

  // --- resolveDownloadsPath ---

  test('resolveDownloadsPath_givenNullDownloadsPath_usesDefaultPath', () => {
    assert.equal(resolveDownloadsPath(envOf({})), '/downloads');
  });

  test('resolveDownloadsPath_givenBlankDownloadsPath_usesDefaultPath', () => {
    assert.equal(resolveDownloadsPath(envOf({ DOWNLOADS_DIRECTORY_PATH: '   ' })), '/downloads');
  });

  test('resolveDownloadsPath_givenCustomDownloadsPath_usesCustomPath', () => {
    assert.equal(resolveDownloadsPath(envOf({ DOWNLOADS_DIRECTORY_PATH: '/custom/backup/path' })), '/custom/backup/path');
  });

  // --- parseSchedule ---

  test('parseSchedule_validDailyCron_returnsSchedule', () => {
    const schedule = parseSchedule('0 2 * * *');

    const next = schedule.nextExecution(new Date(2026, 0, 1, 12, 0, 0));
    assert.deepEqual(next, new Date(2026, 0, 2, 2, 0, 0));
  });

  test('parseSchedule_validEveryMinuteCron_returnsSchedule', () => {
    const schedule = parseSchedule('* * * * *');

    const next = schedule.nextExecution(new Date(2026, 0, 1, 12, 0, 30));
    assert.deepEqual(next, new Date(2026, 0, 1, 12, 1, 0));
  });

  test('parseSchedule_nextExecution_isStrictlyAfterGivenTime', () => {
    const schedule = parseSchedule('0 2 * * *');

    const next = schedule.nextExecution(new Date(2026, 0, 1, 2, 0, 0));
    assert.deepEqual(next, new Date(2026, 0, 2, 2, 0, 0));
  });

  for (const [description, expression] of [
    ['invalidCronExpression', 'not-a-cron'],
    ['emptyCronExpression', ''],
    ['tooManyFields', '0 2 * * * *'],
    ['tooFewFields', '0 2 * *'],
    ['outOfRangeValue', '60 * * * *'],
  ]) {
    test(`parseSchedule_${description}_throws`, () => {
      assert.throws(() => parseSchedule(expression), /SCHEDULING_CONFIG/);
    });
  }

  // --- main ---

  describe('main', () => {
    const SIGNALS = ['SIGTERM', 'SIGINT'] as const;
    let listenersBefore: Map<string, ReturnType<typeof process.listeners>>;

    beforeEach(() => {
      listenersBefore = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal)]));
    });

    afterEach(() => {
      // main() registers signal handlers on every call; drop them so they do not leak between tests
      for (const signal of SIGNALS) {
        for (const listener of process.listeners(signal)) {
          if (!listenersBefore.get(signal)?.includes(listener)) {
            process.removeListener(signal, listener as NodeJS.SignalsListener);
          }
        }
      }
    });

    test('main_invalidSchedulingConfig_exitsWithCode1', async () => {
      const run = await runMain({ ...VALID_ENV, SCHEDULING_CONFIG: 'not-a-cron', RUN_ON_STARTUP: 'true' });

      assert.ok(run.error instanceof ExitCalled);
      assert.deepEqual(run.exitCodes, [1]);
      assert.deepEqual(run.events, []);
    });

    test('main_missingSchedulingConfig_exitsWithCode1', async () => {
      const run = await runMain({ NOTION_SPACE_ID: 'test-space-id', NOTION_TOKEN_V2: 'test-token-v2' });

      assert.deepEqual(run.exitCodes, [1]);
      assert.deepEqual(run.events, []);
    });

    test('main_runOnStartupEnabled_backsUpAndCleansUpBeforeFirstSleep', async () => {
      const run = await runMain({ ...VALID_ENV, RUN_ON_STARTUP: 'true' });

      assert.ok(run.error instanceof StopScheduler);
      assert.deepEqual(run.events, ['export', 'cleanup', 'sleep:60000']);
    });

    test('main_runOnStartupDisabled_sleepsBeforeFirstBackup', async () => {
      const run = await runMain({ ...VALID_ENV, RUN_ON_STARTUP: 'false' });

      assert.deepEqual(run.events[0], 'sleep:60000');
    });

    test('main_runOnStartupUnset_sleepsBeforeFirstBackup', async () => {
      const run = await runMain(VALID_ENV);

      assert.deepEqual(run.events[0], 'sleep:60000');
    });

    test('main_scheduledRun_sleepsUntilEachCronExecutionThenBacksUpAndCleansUp', async () => {
      const run = await runMain(VALID_ENV, { start: new Date(2026, 0, 1, 1, 59, 0), cycles: 2 });

      assert.ok(run.error instanceof StopScheduler);
      assert.deepEqual(run.events, [
        'sleep:60000', 'export', 'cleanup',
        `sleep:${DAY_MS}`, 'export', 'cleanup',
        `sleep:${DAY_MS}`,
      ]);
    });

    test('main_waitLongerThanMaxTimerDelay_sleepsInChunks', async () => {
      const run = await runMain({ ...VALID_ENV, SCHEDULING_CONFIG: '0 0 1 1 *' },
        { start: new Date(2026, 0, 1, 0, 0, 0) });

      const sleeps = run.events.slice(0, run.events.indexOf('export')).map((event) => Number(event.split(':')[1]));
      assert.ok(sleeps.length > 1);
      assert.ok(sleeps.every((ms) => ms > 0 && ms <= MAX_TIMER_DELAY_MS));
      assert.equal(sleeps.reduce((sum, ms) => sum + ms, 0), 365 * DAY_MS);
    });

    test('main_exportReturnsUndefined_stillCleansUpAndKeepsScheduling', async () => {
      const run = await runMain(VALID_ENV, { exportResult: () => Promise.resolve(undefined), cycles: 2 });

      assert.ok(run.error instanceof StopScheduler);
      assert.deepEqual(run.events.filter((event) => event === 'export' || event === 'cleanup'),
        ['export', 'cleanup', 'export', 'cleanup']);
    });

    test('main_exportThrows_stillCleansUpAndKeepsScheduling', async () => {
      const run = await runMain(VALID_ENV, { exportResult: () => Promise.reject(new Error('boom')), cycles: 2 });

      assert.ok(run.error instanceof StopScheduler);
      assert.deepEqual(run.events.filter((event) => event === 'export' || event === 'cleanup'),
        ['export', 'cleanup', 'export', 'cleanup']);
    });

    test('main_cleanupThrows_keepsScheduling', async () => {
      const run = await runMain(VALID_ENV, {
        applyRetentionPolicy: () => {
          throw new Error('boom');
        },
        cycles: 2,
      });

      assert.ok(run.error instanceof StopScheduler);
      assert.equal(run.events.filter((event) => event === 'export').length, 2);
    });

    for (const missingKey of ['NOTION_SPACE_ID', 'NOTION_TOKEN_V2']) {
      for (const [description, value] of [['Unset', undefined], ['Blank', '  ']] as const) {
        test(`main_${missingKey}${description}_exitsWithCode1WithoutExporting`, async () => {
          const values: Record<string, string> = { ...VALID_ENV, RUN_ON_STARTUP: 'true' };
          if (value === undefined) {
            delete values[missingKey];
          } else {
            values[missingKey] = value;
          }

          const run = await runMain(values, { cycles: 1 });

          assert.equal(run.exitCodes[0], 1);
          assert.deepEqual(run.clientArgs, []);
          assert.ok(!run.events.includes('export'));
        });
      }
    }

    test('main_defaultClientConfig_usesDefaults', async () => {
      const run = await runMain({ ...VALID_ENV, RUN_ON_STARTUP: 'true' });

      assert.deepEqual(run.clientArgs, [['test-space-id', 'test-token-v2', '/downloads', 'markdown', false, true]]);
      assert.deepEqual(run.retentionPaths, ['/downloads']);
    });

    test('main_blankOptionalClientConfig_usesDefaults', async () => {
      const run = await runMain({
        ...VALID_ENV,
        RUN_ON_STARTUP: 'true',
        DOWNLOADS_DIRECTORY_PATH: ' ',
        NOTION_EXPORT_TYPE: ' ',
        NOTION_FLATTEN_EXPORT_FILETREE: ' ',
        NOTION_EXPORT_COMMENTS: ' ',
      });

      assert.deepEqual(run.clientArgs, [['test-space-id', 'test-token-v2', '/downloads', 'markdown', false, true]]);
    });

    test('main_customClientConfig_passesConfigToClientAndRetention', async () => {
      const run = await runMain({
        ...VALID_ENV,
        RUN_ON_STARTUP: 'TRUE',
        DOWNLOADS_DIRECTORY_PATH: '/custom/backup/path',
        NOTION_EXPORT_TYPE: 'html',
        NOTION_FLATTEN_EXPORT_FILETREE: 'true',
        NOTION_EXPORT_COMMENTS: 'false',
      });

      assert.deepEqual(run.clientArgs,
        [['test-space-id', 'test-token-v2', '/custom/backup/path', 'html', true, false]]);
      assert.deepEqual(run.retentionPaths, ['/custom/backup/path']);
    });

    for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
      test(`main_${signal}_exitsWithCode${code}`, async () => {
        const { run, deps } = createHarness();
        // Park the scheduler in its first sleep so the signal arrives while it is waiting
        void main(envOf(VALID_ENV), { ...deps, sleep: () => new Promise(() => {}) });

        assert.throws(() => process.emit(signal), ExitCalled);
        assert.deepEqual(run.exitCodes, [code]);
      });
    }
  });
});

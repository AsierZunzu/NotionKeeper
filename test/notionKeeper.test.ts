import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Env } from '../src/env.ts';
import { parseSchedule, resolveDownloadsPath } from '../src/notionKeeper.ts';

function envOf(values: Record<string, string>): Env {
  return { get: (key) => values[key] };
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
});

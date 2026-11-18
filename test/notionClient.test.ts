import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { type FetchFn, NotionClient } from '../src/notionClient.ts';

const MOCK_NOTIFICATION_ID = '00000000-0000-0000-0000-000000000001';
const MOCK_ACTIVITY_ID = '00000000-0000-0000-0000-000000000002';
const MOCK_SPACE_ID = '00000000-0000-0000-0000-000000000003';
const MOCK_CONTEXT_ID = '00000000-0000-0000-0000-000000000004';
const MOCK_START_TIME = 1000000000500;
const MOCK_DOWNLOAD_URL = 'https://file.notion.so/f/t/test/Export.zip?download=true';

function notificationResponse(startTime: number, downloadUrl = MOCK_DOWNLOAD_URL): string {
  // Shaped like a real Notion API response (getNotificationLogV2)
  // Structure: recordMap → activity → {id} → value → value → {start_time, edits[{link}]}
  return JSON.stringify({
    notificationIds: [MOCK_NOTIFICATION_ID],
    recordMap: {
      activity: {
        [MOCK_ACTIVITY_ID]: {
          spaceId: MOCK_SPACE_ID,
          value: {
            value: {
              id: MOCK_ACTIVITY_ID, version: 1, index: 0,
              type: 'export-completed', parent_table: 'space', parent_id: MOCK_SPACE_ID,
              start_time: String(startTime), end_time: String(startTime), invalid: false,
              space_id: MOCK_SPACE_ID,
              edits: [{ link: downloadUrl, type: 'export-completed', space_id: MOCK_SPACE_ID, timestamp: startTime }],
              shard_id: 1, context_id: MOCK_CONTEXT_ID,
            },
            role: 'reader',
          },
        },
      },
    },
  });
}

const NOTIFICATION_RESPONSE = notificationResponse(MOCK_START_TIME);
const TRIGGER_TIMESTAMP_BEFORE = MOCK_START_TIME - 1; // before start_time → should find URL
const TRIGGER_TIMESTAMP_AFTER = MOCK_START_TIME + 1; // after start_time  → too old, skip

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

describe('NotionClient', () => {
  let downloadsDir: string;
  let client: NotionClient;

  beforeEach(() => {
    downloadsDir = mkdtempSync(join(tmpdir(), 'notion-keeper-test-'));
    client = new NotionClient('test-space-id', 'test-token-v2', downloadsDir, 'markdown', false, true);
  });

  afterEach(() => {
    rmSync(downloadsDir, { recursive: true, force: true });
  });

  // --- parseNotificationResponseUrl ---

  test('parseNotificationResponseUrl_givenValidResponse_returnsDownloadUrl', () => {
    const result = client.parseNotificationResponseUrl(JSON.parse(NOTIFICATION_RESPONSE), TRIGGER_TIMESTAMP_BEFORE, NOTIFICATION_RESPONSE);

    assert.equal(result, MOCK_DOWNLOAD_URL);
  });

  test('parseNotificationResponseUrl_givenTriggerTimestampAfterNotification_returnsEmpty', () => {
    const result = client.parseNotificationResponseUrl(JSON.parse(NOTIFICATION_RESPONSE), TRIGGER_TIMESTAMP_AFTER, NOTIFICATION_RESPONSE);

    assert.equal(result, undefined);
  });

  test('parseNotificationResponseUrl_givenMissingActivityMap_returnsEmpty', () => {
    const noActivity = '{"recordMap":{}}';

    const result = client.parseNotificationResponseUrl(JSON.parse(noActivity), TRIGGER_TIMESTAMP_BEFORE, noActivity);

    assert.equal(result, undefined);
  });

  test('parseNotificationResponseUrl_givenMissingStartTime_returnsEmpty', () => {
    const noStartTime = '{"recordMap":{"activity":{"id1":{"value":{"value":{"edits":[]}}}}}}';

    const result = client.parseNotificationResponseUrl(JSON.parse(noStartTime), TRIGGER_TIMESTAMP_BEFORE, noStartTime);

    assert.equal(result, undefined);
  });

  test('parseNotificationResponseUrl_givenMissingLink_returnsEmpty', () => {
    const noLink = '{"recordMap":{"activity":{"id1":{"value":{"value":{'
      + '"start_time":"1776002312379","edits":[{"type":"export-completed"}]}}}}}}';

    const result = client.parseNotificationResponseUrl(JSON.parse(noLink), TRIGGER_TIMESTAMP_BEFORE, noLink);

    assert.equal(result, undefined);
  });

  // --- export (full flow against a fake Notion API) ---

  function fakeNotion(handlers: Array<(request: RecordedRequest) => Response>): { fetch: FetchFn; requests: RecordedRequest[] } {
    const requests: RecordedRequest[] = [];
    const fetch: FetchFn = async (url, init) => {
      const request: RecordedRequest = {
        url,
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: init.body as string | undefined,
      };
      requests.push(request);
      const handler = handlers.shift();
      assert.ok(handler, `unexpected request to ${url}`);
      return handler(request);
    };
    return { fetch, requests };
  }

  function exportingClient(fetch: FetchFn, sleeps: number[] = []): NotionClient {
    return new NotionClient(MOCK_SPACE_ID, 'test-token-v2', downloadsDir, 'markdown', true, false, {
      fetch,
      sleep: async (seconds) => {
        sleeps.push(seconds);
      },
    });
  }

  test('export_givenSuccessfulFlow_downloadsZipUsingFileTokenCookie', async () => {
    const { fetch, requests } = fakeNotion([
      () => new Response('{"taskId":"task-1"}', { headers: { 'Set-Cookie': 'notion_browser_id=b1; Domain=.notion.so; Path=/' } }),
      () => new Response('{"recordMap":{"activity":{}}}'),
      () => new Response(notificationResponse(Date.now() + 60_000), {
        headers: { 'Set-Cookie': 'file_token=ft-123; Domain=notion.so; Path=/; Secure' },
      }),
      () => new Response('zip-bytes'),
    ]);
    const sleeps: number[] = [];

    const result = await exportingClient(fetch, sleeps).export();

    assert.ok(result);
    assert.match(basename(result), /^notion-export-markdown-flattened_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/);
    assert.equal(readFileSync(result, 'utf8'), 'zip-bytes');
    assert.deepEqual(readdirSync(downloadsDir), [basename(result)]);
    assert.deepEqual(sleeps, [5, 5]);

    const [enqueue, firstPoll, , download] = requests;
    assert.equal(enqueue.url, 'https://www.notion.so/api/v3/enqueueTask');
    assert.equal(enqueue.method, 'POST');
    assert.equal(enqueue.headers.Cookie, 'token_v2=test-token-v2');
    assert.equal(enqueue.headers['Content-Type'], 'application/json');
    assert.equal(enqueue.headers['User-Agent'], 'Java-http-client/25');
    assert.deepEqual(JSON.parse(enqueue.body ?? ''), {
      task: {
        eventName: 'exportSpace',
        request: {
          spaceId: MOCK_SPACE_ID,
          shouldExportComments: false,
          exportOptions: { exportType: 'markdown', flattenExportFiletree: true, timeZone: 'Europe/Berlin', locale: 'en' },
        },
      },
    });

    assert.equal(firstPoll.url, 'https://www.notion.so/api/v3/getNotificationLogV2');
    assert.equal(firstPoll.headers.Cookie, 'token_v2=test-token-v2; notion_browser_id=b1');
    assert.deepEqual(JSON.parse(firstPoll.body ?? ''),
      { spaceId: MOCK_SPACE_ID, size: 20, type: 'unread_and_read', variant: 'no_grouping' });

    assert.equal(download.url, MOCK_DOWNLOAD_URL);
    assert.equal(download.method, 'GET');
    assert.equal(download.headers.Cookie, 'file_token=ft-123; notion_browser_id=b1');
  });

  test('export_givenServerErrorOnEnqueue_retries', async () => {
    const { fetch, requests } = fakeNotion([
      () => new Response('oops', { status: 502 }),
      () => new Response('not json'),
      () => new Response('{"errorId":"e1","name":"ValidationError","message":"bad"}'),
    ]);
    const sleeps: number[] = [];

    const result = await exportingClient(fetch, sleeps).export();

    assert.equal(result, undefined);
    assert.equal(requests.length, 3);
    assert.deepEqual(sleeps, [5, 5]);
  });

  test('export_givenUnauthorizedError_doesNotRetry', async () => {
    const { fetch, requests } = fakeNotion([
      () => new Response('{"errorId":"e1","name":"UnauthorizedError","message":"Token was invalid or expired."}', { status: 401 }),
    ]);

    const result = await exportingClient(fetch).export();

    assert.equal(result, undefined);
    assert.equal(requests.length, 1);
  });

  test('export_givenNoFileTokenCookie_fails', async () => {
    const { fetch } = fakeNotion([
      () => new Response('{"taskId":"task-1"}'),
      () => new Response(notificationResponse(Date.now() + 60_000)),
    ]);

    const result = await exportingClient(fetch).export();

    assert.equal(result, undefined);
  });

  test('export_givenDownloadFails_returnsEmptyAndWritesNothing', async () => {
    const { fetch } = fakeNotion([
      () => new Response('{"taskId":"task-1"}'),
      () => new Response(notificationResponse(Date.now() + 60_000), { headers: { 'Set-Cookie': 'file_token=ft-123' } }),
      () => new Response('forbidden', { status: 403 }),
    ]);

    const result = await exportingClient(fetch).export();

    assert.equal(result, undefined);
    assert.deepEqual(readdirSync(downloadsDir), []);
  });

  test('export_givenNetworkError_returnsEmpty', async () => {
    const result = await exportingClient(async () => {
      throw new TypeError('fetch failed');
    }).export();

    assert.equal(result, undefined);
  });
});

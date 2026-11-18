import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { ReadableStream } from 'node:stream/web';

import { createLogger } from './logger.ts';
import {
  isJsonObject,
  logViolations,
  path,
  validateEnqueueTaskResponse,
  validateNotificationResponse,
} from './notionApiContractValidator.ts';

const log = createLogger('NotionClient');

const FETCH_DOWNLOAD_URL_RETRY_SECONDS = 5;
const TRIGGER_EXPORT_TASK_RETRY_SECONDS = 5;
const MAX_ATTEMPTS = 500;

const ENQUEUE_ENDPOINT = 'https://www.notion.so/api/v3/enqueueTask';
const NOTIFICATION_ENDPOINT = 'https://www.notion.so/api/v3/getNotificationLogV2';
const TOKEN_V2 = 'token_v2';
const FILE_TOKEN = 'file_token';
const EXPORT_FILE_NAME = 'notion-export';
const EXPORT_FILE_EXTENSION = '.zip';
// The User-Agent the previous Java implementation sent (java.net.http.HttpClient's default).
// Notion's edge rejects Node's default "node" User-Agent with an HTML 403 page.
const USER_AGENT = 'Java-http-client/25';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
export type SleepFn = (seconds: number) => Promise<void>;

export interface NotionClientDependencies {
  fetch?: FetchFn;
  sleep?: SleepFn;
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
}

/**
 * Minimal cookie jar (accept-all policy): remembers every cookie set by Notion so it is sent back
 * on later requests to matching hosts, and so the `file_token` cookie can be read for the download.
 */
class CookieJar {
  private cookies: StoredCookie[] = [];

  store(requestUrl: string, response: Response): void {
    const requestHost = new URL(requestUrl).hostname;
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const domainAttribute = attributes
        .map((attribute) => attribute.trim())
        .find((attribute) => attribute.toLowerCase().startsWith('domain='));
      const domain = domainAttribute ? domainAttribute.slice('domain='.length).replace(/^\./, '').toLowerCase() : requestHost;
      this.cookies = this.cookies.filter((cookie) => !(cookie.name === name && cookie.domain === domain));
      this.cookies.push({ name, value, domain, hostOnly: domainAttribute === undefined });
    }
  }

  cookiesFor(url: string): StoredCookie[] {
    const host = new URL(url).hostname.toLowerCase();
    return this.cookies.filter((cookie) => cookie.hostOnly
      ? host === cookie.domain
      : host === cookie.domain || host.endsWith(`.${cookie.domain}`));
  }

  find(name: string): StoredCookie | undefined {
    return this.cookies.find((cookie) => cookie.name === name);
  }
}

/** Equivalent of Jackson's `JsonNode.asText()` for the value types Notion returns. */
function asText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return '';
}

/** Same accepted syntax as Java's Long.parseLong. */
function parseLong(text: string): number {
  if (!/^[+-]?\d+$/.test(text)) {
    throw new Error(`For input string: "${text}"`);
  }
  return Number(text);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local date-time formatted as yyyy-MM-dd_HH-mm-ss. */
function formatTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

export class NotionClient {

  private readonly notionSpaceId: string;
  private readonly notionTokenV2: string;
  private readonly downloadsDirectoryPath: string;
  private readonly exportType: string;
  private readonly flattenExportFileTree: boolean;
  private readonly exportComments: boolean;
  private readonly cookieJar = new CookieJar();
  private readonly fetch: FetchFn;
  private readonly sleep: SleepFn;
  private notionFileToken: string | undefined;

  constructor(
    notionSpaceId: string,
    notionTokenV2: string,
    downloadsDirectoryPath: string,
    exportType: string,
    flattenExportFileTree: boolean,
    exportComments: boolean,
    dependencies: NotionClientDependencies = {},
  ) {
    this.notionSpaceId = notionSpaceId;
    this.notionTokenV2 = notionTokenV2;
    this.downloadsDirectoryPath = downloadsDirectoryPath;
    this.exportType = exportType;
    this.flattenExportFileTree = flattenExportFileTree;
    this.exportComments = exportComments;
    this.fetch = dependencies.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.sleep = dependencies.sleep ?? ((seconds) => delay(seconds * 1000));

    log.info('Downloads will be saved to: {}', downloadsDirectoryPath);
    log.info('Using export type: {}', exportType);
    log.info('Flatten export file tree: {}', flattenExportFileTree);
    log.info('Export comments: {}', exportComments);
  }

  /** Triggers a Notion export and downloads it. Resolves to the path of the downloaded ZIP, or undefined on failure. */
  async export(): Promise<string | undefined> {
    try {
      const exportTriggerTimestamp = Date.now();
      if (!await this.triggerExportTask()) {
        log.info('Export task could not be triggered');
        return undefined;
      }
      log.info('Export task triggered');

      const downloadLink = await this.fetchDownloadUrl(exportTriggerTimestamp);
      if (downloadLink === undefined) {
        log.info('downloadLink could not be extracted');
        return undefined;
      }
      log.info('Download link extracted');

      log.info('Downloading file...');
      const fileName = `${EXPORT_FILE_NAME}-${this.exportType}${this.flattenExportFileTree ? '-flattened' : ''}`
        + `_${formatTimestamp(new Date())}${EXPORT_FILE_EXTENSION}`;

      log.info('Downloaded export will be saved to: {}', this.downloadsDirectoryPath);
      log.info('fileName: {}', fileName);
      const downloadPath = join(this.downloadsDirectoryPath, fileName);
      const downloadedFile = await this.downloadToFile(downloadLink, downloadPath);

      if (downloadedFile === undefined || !isFile(downloadedFile)) {
        log.info('Could not download file');
        return undefined;
      }

      log.info('Download finished: {}', basename(downloadedFile));
      log.info('File size: {} bytes', statSync(downloadedFile).size);
      return downloadedFile;
    } catch (e) {
      log.warn('Exception during export', e);
    }
    return undefined;
  }

  private async downloadToFile(url: string, downloadPath: string): Promise<string | undefined> {
    try {
      log.info("Downloading file to: '{}'", downloadPath);
      const response = await this.request(url, FILE_TOKEN, this.notionFileToken, { method: 'GET' });

      const statusCode = response.status;
      if (statusCode !== 200 || response.body === null) {
        log.error('The file download responded with status code {}', statusCode);
        return undefined;
      }
      mkdirSync(dirname(downloadPath), { recursive: true });
      await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), createWriteStream(downloadPath));

      return downloadPath;
    } catch (e) {
      log.warn('Exception during file download', e);
      return undefined;
    }
  }

  private async triggerExportTask(): Promise<boolean> {
    for (let i = 0; i < MAX_ATTEMPTS; i++, await this.sleep(TRIGGER_EXPORT_TASK_RETRY_SECONDS)) {
      const response = await this.postJson(ENQUEUE_ENDPOINT, this.getTaskJson());

      const statusCode = response.status;
      const body = await response.text();
      if (statusCode >= 500) {
        log.error('Server error (HTTP {}). Trying again in {} seconds...',
          statusCode, TRIGGER_EXPORT_TASK_RETRY_SECONDS);
        continue;
      }

      let responseJson: unknown;
      try {
        responseJson = JSON.parse(body);
      } catch {
        log.error('Failed to parse response as JSON (HTTP {}). Trying again in {} seconds...',
          statusCode, TRIGGER_EXPORT_TASK_RETRY_SECONDS);
        continue;
      }

      /*  This will be the response if the given token is not valid anymore (for example if a logout occurred)
        {
          "errorId": "<some-UUID>",
          "name":"UnauthorizedError",
          "message":"Token was invalid or expired.",
          "clientData":{"type":"login_try_again"}
        }
       */
      if (path(responseJson, 'taskId') === undefined) {
        logViolations('enqueueTask', validateEnqueueTaskResponse(responseJson));

        const errorName = path(responseJson, 'name');
        log.error('Error name: {}, error message: {}',
          JSON.stringify(errorName) ?? null, JSON.stringify(path(responseJson, 'message')) ?? null);
        if (typeof errorName === 'string' && errorName.toLowerCase() === 'unauthorizederror') {
          log.error('Your NOTION_TOKEN_V2 is expired or invalid. To fix this:');
          log.error('  1. Open Notion in your browser and make sure you are logged in');
          log.error('  2. Open DevTools -> Application -> Cookies -> https://www.notion.so');
          log.error("  3. Find the 'token_v2' cookie and copy its value");
          log.error('  4. Update NOTION_TOKEN_V2 in your .env file with the new value');
          log.error('  5. Restart the application');
        }
        return false;
      }

      return true;
    }
    return false;
  }

  private async fetchDownloadUrl(exportTriggerTimestamp: number): Promise<string | undefined> {
    try {
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await this.sleep(FETCH_DOWNLOAD_URL_RETRY_SECONDS);

        const response = await this.postJson(NOTIFICATION_ENDPOINT, this.getNotificationJson());

        const statusCode = response.status;
        const body = await response.text();
        if (statusCode >= 500) {
          log.error('Server error (HTTP {}). Trying again in {} seconds...',
            statusCode, FETCH_DOWNLOAD_URL_RETRY_SECONDS);
          continue;
        }

        let root: unknown;
        try {
          root = JSON.parse(body);
        } catch {
          log.error('Failed to parse response as JSON (HTTP {}). Trying again in {} seconds...',
            statusCode, FETCH_DOWNLOAD_URL_RETRY_SECONDS);
          continue;
        }

        logViolations('getNotificationLogV2', validateNotificationResponse(root));

        const downloadUrl = this.parseNotificationResponseUrl(root, exportTriggerTimestamp, body);
        if (downloadUrl === undefined) {
          continue;
        }

        const fileTokenCookie = this.cookieJar.find(FILE_TOKEN);
        if (fileTokenCookie === undefined) {
          throw new Error(`No '${FILE_TOKEN}' cookie was received from Notion`);
        }
        this.notionFileToken = fileTokenCookie.value;
        log.info('Notion file token {}', this.notionFileToken);
        return downloadUrl;
      }
    } catch (e) {
      log.error('An exception occurred: ', e);
    }
    return undefined;
  }

  // Public for testing
  parseNotificationResponseUrl(root: unknown, exportTriggerTimestamp: number, rawBodyForLogging: string): string | undefined {
    const activityMap = path(path(root, 'recordMap'), 'activity');
    const firstActivityEntry = isJsonObject(activityMap) ? Object.values(activityMap)[0] : undefined;
    if (firstActivityEntry === undefined) {
      log.info("'activity' map is missing or empty in response. Trying again in {} seconds...", FETCH_DOWNLOAD_URL_RETRY_SECONDS);
      log.debug('Full response body: {}', rawBodyForLogging);
      return undefined;
    }
    const data = path(path(firstActivityEntry, 'value'), 'value');
    if (data === undefined) {
      log.info("'value.value' field is missing in activity entry. Trying again in {} seconds...", FETCH_DOWNLOAD_URL_RETRY_SECONDS);
      log.debug('Activity entry: {}', JSON.stringify(firstActivityEntry));
      return undefined;
    }

    const startTimeText = asText(path(data, 'start_time'));
    if (startTimeText === '') {
      log.info("'start_time' field is missing in response. Trying again in {} seconds...", FETCH_DOWNLOAD_URL_RETRY_SECONDS);
      log.debug('Value node: {}', JSON.stringify(data));
      return undefined;
    }
    const notificationStartTimestamp = parseLong(startTimeText);

    if (notificationStartTimestamp < exportTriggerTimestamp) {
      log.info('The newest export trigger notification is still not in the Notion response. '
        + 'Trying again in {} seconds...', FETCH_DOWNLOAD_URL_RETRY_SECONDS);
      return undefined;
    }
    log.info('Found a new export trigger notification in the Notion response. '
      + 'Attempting to extract the download URL. '
      + 'Timestamp of when the export was triggered: {}. '
      + 'Timestamp of the notification: {}', exportTriggerTimestamp, notificationStartTimestamp);

    const edits = path(data, 'edits');
    if (!Array.isArray(edits) || edits.length === 0) {
      throw new Error("'edits' is missing or empty in the export notification");
    }
    const link = path(edits[0], 'link');
    if (link === undefined) {
      log.info('The download URL is not yet present. Trying again in {} seconds...', FETCH_DOWNLOAD_URL_RETRY_SECONDS);
      return undefined;
    }
    if (typeof link !== 'string') {
      throw new Error(`'link' is not a text value: ${JSON.stringify(link)}`);
    }
    return link;
  }

  private postJson(url: string, body: string): Promise<Response> {
    return this.request(url, TOKEN_V2, this.notionTokenV2, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  }

  /**
   * Sends a request with the given cookie plus any stored cookies for the host,
   * and remembers the cookies the response sets.
   */
  private async request(url: string, cookieName: string, cookieValue: string | undefined,
    init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
    const cookieHeader = [
      `${cookieName}=${cookieValue}`,
      ...this.cookieJar.cookiesFor(url)
        .filter((cookie) => cookie.name !== cookieName)
        .map((cookie) => `${cookie.name}=${cookie.value}`),
    ].join('; ');

    const response = await this.fetch(url, {
      ...init,
      headers: { ...init.headers, 'User-Agent': USER_AGENT, 'Cookie': cookieHeader },
    });
    this.cookieJar.store(url, response);
    return response;
  }

  private getTaskJson(): string {
    return JSON.stringify({
      task: {
        eventName: 'exportSpace',
        request: {
          spaceId: this.notionSpaceId,
          shouldExportComments: this.exportComments,
          exportOptions: {
            exportType: this.exportType.toLowerCase(),
            flattenExportFiletree: this.flattenExportFileTree,
            timeZone: 'Europe/Berlin',
            locale: 'en',
          },
        },
      },
    });
  }

  private getNotificationJson(): string {
    return JSON.stringify({
      spaceId: this.notionSpaceId,
      size: 20,
      type: 'unread_and_read',
      variant: 'no_grouping',
    });
  }
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

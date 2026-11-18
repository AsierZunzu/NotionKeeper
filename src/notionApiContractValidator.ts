import { createLogger } from './logger.ts';

const log = createLogger('NotionApiContractValidator');

/**
 * Validates Notion private API responses against the known field contracts.
 *
 * These endpoints (`/api/v3/enqueueTask`, `/api/v3/getNotificationLogV2`) are undocumented and
 * their structure can change at any time without notice. This module makes each assumed field
 * path explicit and logs a clear `[API-CONTRACT]` warning — including which field was expected,
 * at which path, and what was actually found — whenever the structure deviates.
 */

/** A deviation between the expected and actual structure of a Notion API response. */
export class ContractViolation {
  /** dot-separated path to the field that violated the contract */
  readonly fieldPath: string;
  /** human-readable description of the expected type or value */
  readonly expected: string;
  /** human-readable description of what was actually found */
  readonly actual: string;

  constructor(fieldPath: string, expected: string, actual: string) {
    this.fieldPath = fieldPath;
    this.expected = expected;
    this.actual = actual;
  }

  toString(): string {
    return `field '${this.fieldPath}': expected ${this.expected}, got ${this.actual}`;
  }
}

export type JsonObject = { [key: string]: unknown };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Node type names as reported by Jackson, so log messages stay recognisable. */
export function jsonNodeType(value: unknown): string {
  if (value === undefined) {
    return 'MISSING';
  }
  if (value === null) {
    return 'NULL';
  }
  if (Array.isArray(value)) {
    return 'ARRAY';
  }
  switch (typeof value) {
    case 'string':
      return 'STRING';
    case 'number':
      return 'NUMBER';
    case 'boolean':
      return 'BOOLEAN';
    default:
      return 'OBJECT';
  }
}

/** Equivalent of Jackson's `JsonNode.path(name)`: undefined unless `node` is an object with that field. */
export function path(node: unknown, name: string): unknown {
  return isJsonObject(node) && Object.hasOwn(node, name) ? node[name] : undefined;
}

function keysOf(node: unknown): string {
  return `[${isJsonObject(node) ? Object.keys(node).join(', ') : ''}]`;
}

/**
 * Validates a response from `POST /api/v3/enqueueTask`.
 *
 * Expected shapes:
 *   Success: { "taskId": "<string>" }
 *   Error:   { "errorId": "...", "name": "...", "message": "..." }
 *
 * @returns list of structural violations; empty if the response matches the known contract
 */
export function validateEnqueueTaskResponse(root: unknown): ContractViolation[] {
  const violations: ContractViolation[] = [];

  const taskId = path(root, 'taskId');
  const hasTaskId = taskId !== undefined;
  const hasErrorId = path(root, 'errorId') !== undefined;

  if (!hasTaskId && !hasErrorId) {
    violations.push(new ContractViolation(
      'root',
      "'taskId' (success) or 'errorId' (error)",
      `neither found; present keys: ${keysOf(root)}`,
    ));
  }

  if (hasTaskId && typeof taskId !== 'string') {
    violations.push(new ContractViolation(
      'taskId',
      'text value',
      `type: ${jsonNodeType(taskId)}`,
    ));
  }

  return violations;
}

/**
 * Validates the structural shape of a response from `POST /api/v3/getNotificationLogV2`.
 *
 * Only structural violations are returned (missing fields, type changes). Transient gaps
 * — an empty `activity` map while no notifications exist yet, or a missing `edits[0].link`
 * while the export is still in progress — are intentionally excluded.
 *
 * Known structure:
 *   recordMap
 *     activity
 *       {uuid}
 *         value
 *           value
 *             start_time  (text, millis epoch)
 *             edits       (array)
 *               [0]
 *                 link    (text URL — only present once export completes)
 *
 * @returns list of structural violations; empty if the response matches the known contract
 */
export function validateNotificationResponse(root: unknown): ContractViolation[] {
  const violations: ContractViolation[] = [];

  const recordMap = path(root, 'recordMap');
  if (recordMap === undefined) {
    violations.push(new ContractViolation(
      'recordMap',
      'object',
      `missing; root keys: ${keysOf(root)}`,
    ));
    return violations;
  }

  const activity = path(recordMap, 'activity');
  if (activity === undefined) {
    violations.push(new ContractViolation(
      'recordMap.activity',
      'object',
      `missing; recordMap keys: ${keysOf(recordMap)}`,
    ));
    return violations;
  }

  if (!isJsonObject(activity)) {
    violations.push(new ContractViolation(
      'recordMap.activity',
      'object',
      `type: ${jsonNodeType(activity)}`,
    ));
    return violations;
  }

  // An empty activity map is transient (no notifications yet), not a structural violation.
  const firstEntry = Object.entries(activity)[0];
  if (firstEntry === undefined) {
    return violations;
  }

  const [entryId, entryNode] = firstEntry;

  const outerValue = path(entryNode, 'value');
  if (outerValue === undefined) {
    violations.push(new ContractViolation(
      `recordMap.activity.${entryId}.value`,
      'object',
      `missing; entry keys: ${keysOf(entryNode)}`,
    ));
    return violations;
  }

  const innerValue = path(outerValue, 'value');
  if (innerValue === undefined) {
    violations.push(new ContractViolation(
      `recordMap.activity.${entryId}.value.value`,
      'object',
      `missing; outer value keys: ${keysOf(outerValue)}`,
    ));
    return violations;
  }

  const startTime = path(innerValue, 'start_time');
  if (startTime !== undefined && typeof startTime !== 'string') {
    violations.push(new ContractViolation(
      `recordMap.activity.${entryId}.value.value.start_time`,
      'text (millis epoch as string)',
      `type: ${jsonNodeType(startTime)}`,
    ));
  }

  const edits = path(innerValue, 'edits');
  if (edits !== undefined && !Array.isArray(edits)) {
    violations.push(new ContractViolation(
      `recordMap.activity.${entryId}.value.value.edits`,
      'array',
      `type: ${jsonNodeType(edits)}`,
    ));
  }

  return violations;
}

/**
 * Logs all violations at WARN level with a clear `[API-CONTRACT]` prefix.
 * Does nothing if `violations` is empty.
 *
 * @param context    short description of the endpoint or parse step being validated
 * @param violations the violations returned by one of the `validate*` functions
 */
export function logViolations(context: string, violations: ContractViolation[]): void {
  if (violations.length === 0) {
    return;
  }
  log.warn('[API-CONTRACT] Notion API response structure may have changed — context: {}', context);
  for (const violation of violations) {
    log.warn('[API-CONTRACT]   {}', violation.toString());
  }
  log.warn('[API-CONTRACT] If this keeps happening, inspect the raw response and compare it to the'
    + ' field paths documented in notionApiContractValidator.ts.');
}

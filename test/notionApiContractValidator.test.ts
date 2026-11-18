import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ContractViolation,
  validateEnqueueTaskResponse,
  validateNotificationResponse,
} from '../src/notionApiContractValidator.ts';

describe('NotionApiContractValidator', () => {

  // ─── enqueueTask ────────────────────────────────────────────────────────────

  test('validateEnqueueTaskResponse_givenSuccessResponse_returnsNoViolations', () => {
    const violations = validateEnqueueTaskResponse(JSON.parse('{"taskId":"abc-123"}'));

    assert.deepEqual(violations, []);
  });

  test('validateEnqueueTaskResponse_givenErrorResponse_returnsNoViolations', () => {
    const violations = validateEnqueueTaskResponse(
      JSON.parse('{"errorId":"e1","name":"UnauthorizedError","message":"Token was invalid."}'));

    assert.deepEqual(violations, []);
  });

  test('validateEnqueueTaskResponse_givenNeitherTaskIdNorErrorId_returnsRootViolation', () => {
    const violations = validateEnqueueTaskResponse(JSON.parse('{"something":"unexpected"}'));

    assert.equal(violations.length, 1);
    assert.equal(violations[0].fieldPath, 'root');
    assert.match(violations[0].actual, /something/);
  });

  test('validateEnqueueTaskResponse_givenNonTextTaskId_returnsTypeViolation', () => {
    const violations = validateEnqueueTaskResponse(JSON.parse('{"taskId":42}'));

    assert.equal(violations.length, 1);
    assert.equal(violations[0].fieldPath, 'taskId');
    assert.match(violations[0].expected, /text/);
  });

  // ─── getNotificationLogV2 ───────────────────────────────────────────────────

  test('validateNotificationResponse_givenFullyValidResponse_returnsNoViolations', () => {
    const json = '{"recordMap":{"activity":{"id1":{"value":{"value":{'
      + '"start_time":"1000000000500","edits":[{"link":"https://file.notion.so/Export.zip"}]'
      + '}}}}}}';

    const violations = validateNotificationResponse(JSON.parse(json));

    assert.deepEqual(violations, []);
  });

  test('validateNotificationResponse_givenEmptyActivity_returnsNoViolations', () => {
    const violations = validateNotificationResponse(JSON.parse('{"recordMap":{"activity":{}}}'));

    assert.deepEqual(violations, []);
  });

  test('validateNotificationResponse_givenEntryWithNoLink_returnsNoViolations', () => {
    // link is absent while export is still in progress — not a structural violation
    const json = '{"recordMap":{"activity":{"id1":{"value":{"value":{'
      + '"start_time":"1000000000500","edits":[{"type":"export-completed"}]'
      + '}}}}}}';

    const violations = validateNotificationResponse(JSON.parse(json));

    assert.deepEqual(violations, []);
  });

  test('validateNotificationResponse_givenMissingRecordMap_returnsViolationWithRootKeys', () => {
    const violations = validateNotificationResponse(JSON.parse('{"notifications":[]}'));

    assert.equal(violations.length, 1);
    assert.equal(violations[0].fieldPath, 'recordMap');
    assert.match(violations[0].actual, /notifications/);
  });

  test('validateNotificationResponse_givenMissingActivity_returnsViolationWithRecordMapKeys', () => {
    const violations = validateNotificationResponse(JSON.parse('{"recordMap":{"blocks":{}}}'));

    assert.equal(violations.length, 1);
    assert.equal(violations[0].fieldPath, 'recordMap.activity');
    assert.match(violations[0].actual, /blocks/);
  });

  test('validateNotificationResponse_givenActivityIsArray_returnsTypeViolation', () => {
    const violations = validateNotificationResponse(JSON.parse('{"recordMap":{"activity":[]}}'));

    assert.equal(violations.length, 1);
    assert.equal(violations[0].fieldPath, 'recordMap.activity');
    assert.match(violations[0].actual, /ARRAY/);
  });

  test('validateNotificationResponse_givenEntryMissingOuterValue_returnsViolationWithEntryKeys', () => {
    const violations = validateNotificationResponse(JSON.parse('{"recordMap":{"activity":{"id1":{"role":"reader"}}}}'));

    assert.equal(violations.length, 1);
    assert.equal(violations[0].fieldPath, 'recordMap.activity.id1.value');
    assert.match(violations[0].actual, /role/);
  });

  test('validateNotificationResponse_givenEntryMissingInnerValue_returnsViolationWithOuterValueKeys', () => {
    const violations = validateNotificationResponse(
      JSON.parse('{"recordMap":{"activity":{"id1":{"value":{"role":"reader"}}}}}'));

    assert.equal(violations.length, 1);
    assert.equal(violations[0].fieldPath, 'recordMap.activity.id1.value.value');
    assert.match(violations[0].actual, /role/);
  });

  test('validateNotificationResponse_givenStartTimeNotText_returnsTypeViolation', () => {
    const json = '{"recordMap":{"activity":{"id1":{"value":{"value":{'
      + '"start_time":12345,"edits":[]'
      + '}}}}}}';

    const violations = validateNotificationResponse(JSON.parse(json));

    assert.equal(violations.length, 1);
    assert.match(violations[0].fieldPath, /start_time/);
    assert.match(violations[0].actual, /NUMBER/);
  });

  test('validateNotificationResponse_givenEditsIsNotArray_returnsTypeViolation', () => {
    const json = '{"recordMap":{"activity":{"id1":{"value":{"value":{'
      + '"start_time":"1000","edits":"not-an-array"'
      + '}}}}}}';

    const violations = validateNotificationResponse(JSON.parse(json));

    assert.equal(violations.length, 1);
    assert.match(violations[0].fieldPath, /edits/);
    assert.match(violations[0].actual, /STRING/);
  });

  test('contractViolation_toString_describesFieldExpectedAndActual', () => {
    const violation = new ContractViolation('taskId', 'text value', 'type: NUMBER');

    assert.equal(violation.toString(), "field 'taskId': expected text value, got type: NUMBER");
  });
});

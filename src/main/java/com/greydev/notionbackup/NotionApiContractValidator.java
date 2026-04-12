package com.greydev.notionbackup;

import java.util.ArrayList;
import java.util.List;

import com.fasterxml.jackson.databind.JsonNode;

import lombok.extern.slf4j.Slf4j;


/**
 * Validates Notion private API responses against the known field contracts.
 *
 * <p>These endpoints ({@code /api/v3/enqueueTask}, {@code /api/v3/getNotificationLogV2}) are
 * undocumented and their structure can change at any time without notice. This class makes each
 * assumed field path explicit and logs a clear {@code [API-CONTRACT]} warning — including which
 * field was expected, at which path, and what was actually found — whenever the structure deviates.
 */
@Slf4j
public class NotionApiContractValidator {

    /**
     * A deviation between the expected and actual structure of a Notion API response.
     *
     * @param fieldPath dot-separated path to the field that violated the contract
     * @param expected  human-readable description of the expected type or value
     * @param actual    human-readable description of what was actually found
     */
    public record ContractViolation(String fieldPath, String expected, String actual) {
        @Override
        public String toString() {
            return String.format("field '%s': expected %s, got %s", fieldPath, expected, actual);
        }
    }

    private NotionApiContractValidator() {
    }

    /**
     * Validates a response from {@code POST /api/v3/enqueueTask}.
     *
     * <p>Expected shapes:
     * <pre>
     *   Success: { "taskId": "&lt;string&gt;" }
     *   Error:   { "errorId": "...", "name": "...", "message": "..." }
     * </pre>
     *
     * @param root the parsed response root node
     * @return list of structural violations; empty if the response matches the known contract
     */
    public static List<ContractViolation> validateEnqueueTaskResponse(JsonNode root) {
        List<ContractViolation> violations = new ArrayList<>();

        boolean hasTaskId = !root.path("taskId").isMissingNode();
        boolean hasErrorId = !root.path("errorId").isMissingNode();

        if (!hasTaskId && !hasErrorId) {
            List<String> presentKeys = new ArrayList<>();
            root.fieldNames().forEachRemaining(presentKeys::add);
            violations.add(new ContractViolation(
                    "root",
                    "'taskId' (success) or 'errorId' (error)",
                    "neither found; present keys: " + presentKeys
            ));
        }

        if (hasTaskId && !root.path("taskId").isTextual()) {
            violations.add(new ContractViolation(
                    "taskId",
                    "text value",
                    "type: " + root.path("taskId").getNodeType()
            ));
        }

        return violations;
    }

    /**
     * Validates the structural shape of a response from {@code POST /api/v3/getNotificationLogV2}.
     *
     * <p>Only structural violations are returned (missing fields, type changes). Transient gaps
     * — an empty {@code activity} map while no notifications exist yet, or a missing
     * {@code edits[0].link} while the export is still in progress — are intentionally excluded.
     *
     * <p>Known structure:
     * <pre>
     *   recordMap
     *     activity
     *       {uuid}
     *         value
     *           value
     *             start_time  (text, millis epoch)
     *             edits       (array)
     *               [0]
     *                 link    (text URL — only present once export completes)
     * </pre>
     *
     * @param root the parsed response root node
     * @return list of structural violations; empty if the response matches the known contract
     */
    public static List<ContractViolation> validateNotificationResponse(JsonNode root) {
        List<ContractViolation> violations = new ArrayList<>();

        JsonNode recordMap = root.path("recordMap");
        if (recordMap.isMissingNode()) {
            List<String> presentKeys = new ArrayList<>();
            root.fieldNames().forEachRemaining(presentKeys::add);
            violations.add(new ContractViolation(
                    "recordMap",
                    "object",
                    "missing; root keys: " + presentKeys
            ));
            return violations;
        }

        JsonNode activity = recordMap.path("activity");
        if (activity.isMissingNode()) {
            List<String> presentKeys = new ArrayList<>();
            recordMap.fieldNames().forEachRemaining(presentKeys::add);
            violations.add(new ContractViolation(
                    "recordMap.activity",
                    "object",
                    "missing; recordMap keys: " + presentKeys
            ));
            return violations;
        }

        if (!activity.isObject()) {
            violations.add(new ContractViolation(
                    "recordMap.activity",
                    "object",
                    "type: " + activity.getNodeType()
            ));
            return violations;
        }

        // An empty activity map is transient (no notifications yet), not a structural violation.
        if (!activity.fields().hasNext()) {
            return violations;
        }

        var firstEntry = activity.fields().next();
        String entryId = firstEntry.getKey();
        JsonNode entryNode = firstEntry.getValue();

        JsonNode outerValue = entryNode.path("value");
        if (outerValue.isMissingNode()) {
            List<String> presentKeys = new ArrayList<>();
            entryNode.fieldNames().forEachRemaining(presentKeys::add);
            violations.add(new ContractViolation(
                    "recordMap.activity." + entryId + ".value",
                    "object",
                    "missing; entry keys: " + presentKeys
            ));
            return violations;
        }

        JsonNode innerValue = outerValue.path("value");
        if (innerValue.isMissingNode()) {
            List<String> presentKeys = new ArrayList<>();
            outerValue.fieldNames().forEachRemaining(presentKeys::add);
            violations.add(new ContractViolation(
                    "recordMap.activity." + entryId + ".value.value",
                    "object",
                    "missing; outer value keys: " + presentKeys
            ));
            return violations;
        }

        JsonNode startTime = innerValue.path("start_time");
        if (!startTime.isMissingNode() && !startTime.isTextual()) {
            violations.add(new ContractViolation(
                    "recordMap.activity." + entryId + ".value.value.start_time",
                    "text (millis epoch as string)",
                    "type: " + startTime.getNodeType()
            ));
        }

        JsonNode edits = innerValue.path("edits");
        if (!edits.isMissingNode() && !edits.isArray()) {
            violations.add(new ContractViolation(
                    "recordMap.activity." + entryId + ".value.value.edits",
                    "array",
                    "type: " + edits.getNodeType()
            ));
        }

        return violations;
    }

    /**
     * Logs all violations at {@code WARN} level with a clear {@code [API-CONTRACT]} prefix.
     * Does nothing if {@code violations} is empty.
     *
     * @param context   short description of the endpoint or parse step being validated
     * @param violations the violations returned by one of the {@code validate*} methods
     */
    public static void logViolations(String context, List<ContractViolation> violations) {
        if (violations.isEmpty()) {
            return;
        }
        log.warn("[API-CONTRACT] Notion API response structure may have changed — context: {}", context);
        for (ContractViolation violation : violations) {
            log.warn("[API-CONTRACT]   {}", violation);
        }
        log.warn("[API-CONTRACT] If this keeps happening, inspect the raw response and compare it to the"
                + " field paths documented in NotionApiContractValidator.");
    }
}

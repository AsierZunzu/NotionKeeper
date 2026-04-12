package com.greydev.notionbackup;

import java.util.List;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.greydev.notionbackup.NotionApiContractValidator.ContractViolation;

import static org.assertj.core.api.Assertions.assertThat;


class NotionApiContractValidatorTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // ─── enqueueTask ──────────────────────────────────────────────────────────

    @Test
    public void validateEnqueueTaskResponse_givenSuccessResponse_returnsNoViolations() throws Exception {
        JsonNode root = MAPPER.readTree("{\"taskId\":\"abc-123\"}");

        List<ContractViolation> violations = NotionApiContractValidator.validateEnqueueTaskResponse(root);

        assertThat(violations).isEmpty();
    }

    @Test
    public void validateEnqueueTaskResponse_givenErrorResponse_returnsNoViolations() throws Exception {
        JsonNode root = MAPPER.readTree(
                "{\"errorId\":\"e1\",\"name\":\"UnauthorizedError\",\"message\":\"Token was invalid.\"}");

        List<ContractViolation> violations = NotionApiContractValidator.validateEnqueueTaskResponse(root);

        assertThat(violations).isEmpty();
    }

    @Test
    public void validateEnqueueTaskResponse_givenNeitherTaskIdNorErrorId_returnsRootViolation() throws Exception {
        JsonNode root = MAPPER.readTree("{\"something\":\"unexpected\"}");

        List<ContractViolation> violations = NotionApiContractValidator.validateEnqueueTaskResponse(root);

        assertThat(violations).hasSize(1);
        assertThat(violations.get(0).fieldPath()).isEqualTo("root");
        assertThat(violations.get(0).actual()).contains("something");
    }

    @Test
    public void validateEnqueueTaskResponse_givenNonTextTaskId_returnsTypeViolation() throws Exception {
        JsonNode root = MAPPER.readTree("{\"taskId\":42}");

        List<ContractViolation> violations = NotionApiContractValidator.validateEnqueueTaskResponse(root);

        assertThat(violations).hasSize(1);
        assertThat(violations.get(0).fieldPath()).isEqualTo("taskId");
        assertThat(violations.get(0).expected()).contains("text");
    }

    // ─── getNotificationLogV2 ─────────────────────────────────────────────────

    @Test
    public void validateNotificationResponse_givenFullyValidResponse_returnsNoViolations() throws Exception {
        String json = "{\"recordMap\":{\"activity\":{\"id1\":{\"value\":{\"value\":{" +
                "\"start_time\":\"1000000000500\",\"edits\":[{\"link\":\"https://file.notion.so/Export.zip\"}]" +
                "}}}}}}";
        JsonNode root = MAPPER.readTree(json);

        List<ContractViolation> violations = NotionApiContractValidator.validateNotificationResponse(root);

        assertThat(violations).isEmpty();
    }

    @Test
    public void validateNotificationResponse_givenEmptyActivity_returnsNoViolations() throws Exception {
        JsonNode root = MAPPER.readTree("{\"recordMap\":{\"activity\":{}}}");

        List<ContractViolation> violations = NotionApiContractValidator.validateNotificationResponse(root);

        assertThat(violations).isEmpty();
    }

    @Test
    public void validateNotificationResponse_givenEntryWithNoLink_returnsNoViolations() throws Exception {
        // link is absent while export is still in progress — not a structural violation
        String json = "{\"recordMap\":{\"activity\":{\"id1\":{\"value\":{\"value\":{" +
                "\"start_time\":\"1000000000500\",\"edits\":[{\"type\":\"export-completed\"}]" +
                "}}}}}}";
        JsonNode root = MAPPER.readTree(json);

        List<ContractViolation> violations = NotionApiContractValidator.validateNotificationResponse(root);

        assertThat(violations).isEmpty();
    }

    @Test
    public void validateNotificationResponse_givenMissingRecordMap_returnsViolationWithRootKeys() throws Exception {
        JsonNode root = MAPPER.readTree("{\"notifications\":[]}");

        List<ContractViolation> violations = NotionApiContractValidator.validateNotificationResponse(root);

        assertThat(violations).hasSize(1);
        assertThat(violations.get(0).fieldPath()).isEqualTo("recordMap");
        assertThat(violations.get(0).actual()).contains("notifications");
    }

    @Test
    public void validateNotificationResponse_givenMissingActivity_returnsViolationWithRecordMapKeys() throws Exception {
        JsonNode root = MAPPER.readTree("{\"recordMap\":{\"blocks\":{}}}");

        List<ContractViolation> violations = NotionApiContractValidator.validateNotificationResponse(root);

        assertThat(violations).hasSize(1);
        assertThat(violations.get(0).fieldPath()).isEqualTo("recordMap.activity");
        assertThat(violations.get(0).actual()).contains("blocks");
    }

    @Test
    public void validateNotificationResponse_givenActivityIsArray_returnsTypeViolation() throws Exception {
        JsonNode root = MAPPER.readTree("{\"recordMap\":{\"activity\":[]}}");

        List<ContractViolation> violations = NotionApiContractValidator.validateNotificationResponse(root);

        assertThat(violations).hasSize(1);
        assertThat(violations.get(0).fieldPath()).isEqualTo("recordMap.activity");
        assertThat(violations.get(0).actual()).contains("ARRAY");
    }

    @Test
    public void validateNotificationResponse_givenEntryMissingOuterValue_returnsViolationWithEntryKeys() throws Exception {
        JsonNode root = MAPPER.readTree("{\"recordMap\":{\"activity\":{\"id1\":{\"role\":\"reader\"}}}}");

        List<ContractViolation> violations = NotionApiContractValidator.validateNotificationResponse(root);

        assertThat(violations).hasSize(1);
        assertThat(violations.get(0).fieldPath()).contains("id1").contains(".value");
        assertThat(violations.get(0).actual()).contains("role");
    }

    @Test
    public void validateNotificationResponse_givenEntryMissingInnerValue_returnsViolationWithOuterValueKeys() throws Exception {
        JsonNode root = MAPPER.readTree(
                "{\"recordMap\":{\"activity\":{\"id1\":{\"value\":{\"role\":\"reader\"}}}}}");

        List<ContractViolation> violations = NotionApiContractValidator.validateNotificationResponse(root);

        assertThat(violations).hasSize(1);
        assertThat(violations.get(0).fieldPath()).contains("id1").contains(".value.value");
        assertThat(violations.get(0).actual()).contains("role");
    }

    @Test
    public void validateNotificationResponse_givenStartTimeNotText_returnsTypeViolation() throws Exception {
        String json = "{\"recordMap\":{\"activity\":{\"id1\":{\"value\":{\"value\":{" +
                "\"start_time\":12345,\"edits\":[]" +
                "}}}}}}";
        JsonNode root = MAPPER.readTree(json);

        List<ContractViolation> violations = NotionApiContractValidator.validateNotificationResponse(root);

        assertThat(violations).hasSize(1);
        assertThat(violations.get(0).fieldPath()).contains("start_time");
        assertThat(violations.get(0).actual()).contains("NUMBER");
    }

    @Test
    public void validateNotificationResponse_givenEditsIsNotArray_returnsTypeViolation() throws Exception {
        String json = "{\"recordMap\":{\"activity\":{\"id1\":{\"value\":{\"value\":{" +
                "\"start_time\":\"1000\",\"edits\":\"not-an-array\"" +
                "}}}}}}";
        JsonNode root = MAPPER.readTree(json);

        List<ContractViolation> violations = NotionApiContractValidator.validateNotificationResponse(root);

        assertThat(violations).hasSize(1);
        assertThat(violations.get(0).fieldPath()).contains("edits");
        assertThat(violations.get(0).actual()).contains("STRING");
    }

}

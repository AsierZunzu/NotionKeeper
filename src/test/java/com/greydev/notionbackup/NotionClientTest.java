package com.greydev.notionbackup;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.cdimascio.dotenv.Dotenv;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.when;


@ExtendWith(MockitoExtension.class)
class NotionClientTest {

	private static final String MOCK_NOTIFICATION_ID = "00000000-0000-0000-0000-000000000001";
	private static final String MOCK_ACTIVITY_ID     = "00000000-0000-0000-0000-000000000002";
	private static final String MOCK_SPACE_ID        = "00000000-0000-0000-0000-000000000003";
	private static final String MOCK_CONTEXT_ID      = "00000000-0000-0000-0000-000000000004";
	private static final long   MOCK_START_TIME      = 1000000000500L;
	private static final String MOCK_DOWNLOAD_URL    = "https://file.notion.so/f/t/test/Export.zip?download=true";

	// Shaped like a real Notion API response (getNotificationLogV2)
	// Structure: recordMap → activity → {id} → value → value → {start_time, edits[{link}]}
	private static final String NOTIFICATION_RESPONSE = "{\"notificationIds\":[\"" + MOCK_NOTIFICATION_ID + "\"]," +
			"\"recordMap\":{\"activity\":{" +
			"\"" + MOCK_ACTIVITY_ID + "\":{\"spaceId\":\"" + MOCK_SPACE_ID + "\"," +
			"\"value\":{\"value\":{\"id\":\"" + MOCK_ACTIVITY_ID + "\",\"version\":1,\"index\":0," +
			"\"type\":\"export-completed\",\"parent_table\":\"space\",\"parent_id\":\"" + MOCK_SPACE_ID + "\"," +
			"\"start_time\":\"" + MOCK_START_TIME + "\",\"end_time\":\"" + MOCK_START_TIME + "\",\"invalid\":false," +
			"\"space_id\":\"" + MOCK_SPACE_ID + "\"," +
			"\"edits\":[{\"link\":\"" + MOCK_DOWNLOAD_URL + "\"," +
			"\"type\":\"export-completed\",\"space_id\":\"" + MOCK_SPACE_ID + "\"," +
			"\"timestamp\":" + MOCK_START_TIME + "}],\"shard_id\":1,\"context_id\":\"" + MOCK_CONTEXT_ID + "\"}," +
			"\"role\":\"reader\"}}}}}";

	private static final long TRIGGER_TIMESTAMP_BEFORE = MOCK_START_TIME - 1; // before start_time → should find URL
	private static final long TRIGGER_TIMESTAMP_AFTER  = MOCK_START_TIME + 1; // after start_time  → too old, skip

	@Mock
	private Dotenv dotenv;

	private NotionClient client;
	private final ObjectMapper objectMapper = new ObjectMapper();

	@BeforeEach
	void setUp() {
		client = new NotionClient("test-space-id", "test-token-v2", "/downloads", "markdown", false, true);
	}

	// --- resolveDownloadsPath tests ---

	@Test
	public void resolveDownloadsPath_givenNullDownloadsPath_usesDefaultPath() {
		// dotenv.get("DOWNLOADS_DIRECTORY_PATH") returns null (Mockito default)
		assertEquals("/downloads", NotionKeeper.resolveDownloadsPath(dotenv));
	}

	@Test
	public void resolveDownloadsPath_givenBlankDownloadsPath_usesDefaultPath() {
		when(dotenv.get("DOWNLOADS_DIRECTORY_PATH")).thenReturn("   ");

		assertEquals("/downloads", NotionKeeper.resolveDownloadsPath(dotenv));
	}

	@Test
	public void resolveDownloadsPath_givenCustomDownloadsPath_usesCustomPath() {
		when(dotenv.get("DOWNLOADS_DIRECTORY_PATH")).thenReturn("/custom/backup/path");

		assertEquals("/custom/backup/path", NotionKeeper.resolveDownloadsPath(dotenv));
	}

	// --- parseNotificationResponseUrl tests ---

	@Test
	public void parseNotificationResponseUrl_givenValidResponse_returnsDownloadUrl() throws Exception {
		JsonNode rootNode = objectMapper.readTree(NOTIFICATION_RESPONSE);

		Optional<String> result = client.parseNotificationResponseUrl(rootNode, TRIGGER_TIMESTAMP_BEFORE, NOTIFICATION_RESPONSE);

		assertTrue(result.isPresent());
		assertEquals(MOCK_DOWNLOAD_URL, result.get());
	}

	@Test
	public void parseNotificationResponseUrl_givenTriggerTimestampAfterNotification_returnsEmpty() throws Exception {
		JsonNode rootNode = objectMapper.readTree(NOTIFICATION_RESPONSE);

		Optional<String> result = client.parseNotificationResponseUrl(rootNode, TRIGGER_TIMESTAMP_AFTER, NOTIFICATION_RESPONSE);

		assertTrue(result.isEmpty());
	}

	@Test
	public void parseNotificationResponseUrl_givenMissingActivityMap_returnsEmpty() throws Exception {
		String noActivity = "{\"recordMap\":{}}";
		JsonNode rootNode = objectMapper.readTree(noActivity);

		Optional<String> result = client.parseNotificationResponseUrl(rootNode, TRIGGER_TIMESTAMP_BEFORE, noActivity);

		assertTrue(result.isEmpty());
	}

	@Test
	public void parseNotificationResponseUrl_givenMissingStartTime_returnsEmpty() throws Exception {
		String noStartTime = "{\"recordMap\":{\"activity\":{\"id1\":{\"value\":{\"value\":{\"edits\":[]}}}}}}";
		JsonNode rootNode = objectMapper.readTree(noStartTime);

		Optional<String> result = client.parseNotificationResponseUrl(rootNode, TRIGGER_TIMESTAMP_BEFORE, noStartTime);

		assertTrue(result.isEmpty());
	}

	@Test
	public void parseNotificationResponseUrl_givenMissingLink_returnsEmpty() throws Exception {
		String noLink = "{\"recordMap\":{\"activity\":{\"id1\":{\"value\":{\"value\":{" +
				"\"start_time\":\"1776002312379\",\"edits\":[{\"type\":\"export-completed\"}]}}}}}}";
		JsonNode rootNode = objectMapper.readTree(noLink);

		Optional<String> result = client.parseNotificationResponseUrl(rootNode, TRIGGER_TIMESTAMP_BEFORE, noLink);

		assertTrue(result.isEmpty());
	}

}


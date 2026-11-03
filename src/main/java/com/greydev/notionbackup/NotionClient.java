package com.greydev.notionbackup;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.CookieStore;
import java.net.HttpCookie;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.greydev.notionbackup.NotionApiContractValidator.ContractViolation;

import org.apache.commons.io.FileUtils;
import org.apache.commons.lang3.StringUtils;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import lombok.extern.slf4j.Slf4j;


@Slf4j
public class NotionClient {

	private static final String EXPORT_COMPLETED_ACTIVITY_TYPE = "export-completed";
	// Polling backoff: exports used to finish in ~20 min, but can now take many hours.
	static final Duration FAST_POLL_PHASE = Duration.ofMinutes(10);
	static final Duration MEDIUM_POLL_PHASE = Duration.ofMinutes(60);
	static final Duration FAST_POLL_INTERVAL = Duration.ofSeconds(30);
	static final Duration MEDIUM_POLL_INTERVAL = Duration.ofSeconds(90);
	static final Duration MAX_POLL_INTERVAL = Duration.ofMinutes(5);
	private static final int TRIGGER_EXPORT_TASK_RETRY_SECONDS = 5;

	private static final String ENQUEUE_ENDPOINT = "https://www.notion.so/api/v3/enqueueTask";
	private static final String NOTIFICATION_ENDPOINT = "https://www.notion.so/api/v3/getNotificationLogV2";
	private static final String TOKEN_V2 = "token_v2";
	private static final String FILE_TOKEN = "file_token";
	private static final String EXPORT_FILE_NAME = "notion-export";
	private static final String EXPORT_FILE_EXTENSION = ".zip";


	private final String notionSpaceId;
	private final String notionTokenV2;
	private final String exportType;
	private final boolean flattenExportFileTree;
	private final boolean exportComments;
	private final Duration exportTimeout;
	private final CookieManager cookieManager;
	private final HttpClient client;
	private final ObjectMapper objectMapper = new ObjectMapper();
	private String notionFileToken;
	private final String downloadsDirectoryPath;


	NotionClient(
	    String notionSpaceId,
	    String notionTokenV2,
	    String downloadsDirectoryPath,
        String exportType,
        boolean flattenExportFileTree,
        boolean exportComments,
        Duration exportTimeout
     ) {
		this.cookieManager = new CookieManager();
		this.cookieManager.setCookiePolicy(CookiePolicy.ACCEPT_ALL);
		this.client = HttpClient.newBuilder().cookieHandler(this.cookieManager).build();

		this.notionSpaceId = notionSpaceId;
		this.notionTokenV2 = notionTokenV2;
		this.downloadsDirectoryPath = downloadsDirectoryPath;
		this.exportType = exportType;
		this.flattenExportFileTree = flattenExportFileTree;
		this.exportComments = exportComments;
		this.exportTimeout = exportTimeout;

		log.info("Downloads will be saved to: {}", downloadsDirectoryPath);
		log.info("Using export type: {}", exportType);
		log.info("Flatten export file tree: {}", flattenExportFileTree);
		log.info("Export comments: {}", exportComments);
		log.info("Export timeout: {} minutes", exportTimeout.toMinutes());
	}


	public Optional<File> export() {
		try {
			long exportTriggerTimestamp = System.currentTimeMillis();
			if (!triggerExportTask()) {
				log.info("Export task could not be triggered");
				return Optional.empty();
			}
			log.info("Export task triggered");

			Optional<String> downloadLink = fetchDownloadUrl(exportTriggerTimestamp);
			if (downloadLink.isEmpty()) {
				log.info("downloadLink could not be extracted");
				return Optional.empty();
			}
			log.info("Download link extracted");

			log.info("Downloading file...");
			String fileName = String.format("%s-%s%s_%s%s",
					EXPORT_FILE_NAME,
					exportType,
					flattenExportFileTree ? "-flattened" : "",
					LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd_HH-mm-ss")),
					EXPORT_FILE_EXTENSION);

            log.info("Downloaded export will be saved to: {}", downloadsDirectoryPath);
            log.info("fileName: {}", fileName);
			Path downloadPath = Path.of(downloadsDirectoryPath, fileName);
			Optional<File> downloadedFile = downloadToFile(downloadLink.get(), downloadPath);

			if (downloadedFile.isEmpty() || !downloadedFile.get().isFile()) {
				log.info("Could not download file");
				return Optional.empty();
			}

			log.info("Download finished: {}", downloadedFile.get().getName());
			log.info("File size: {} bytes", downloadedFile.get().length());
			return downloadedFile;
		} catch (IOException | InterruptedException e) {
			log.warn("Exception during export", e);
		}
		return Optional.empty();
	}


	private Optional<File> downloadToFile(String url, Path downloadPath) {
		HttpRequest request = HttpRequest.newBuilder()
				.uri(URI.create(url))
                .header("Cookie", FILE_TOKEN + "=" + notionFileToken)
				.GET()
				.build();

		try {
			log.info("Downloading file to: '{}'", downloadPath);
			HttpResponse<InputStream> response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());

			var statusCode = response.statusCode();
			if (statusCode != HttpURLConnection.HTTP_OK) {
				log.error("The file download responded with status code {}", statusCode);
				return Optional.empty();
			}
			File file = new File(downloadPath.toString());
			FileUtils.copyInputStreamToFile(response.body(), file);

			return Optional.of(downloadPath.toFile());
		} catch (IOException | InterruptedException e) {
			log.warn("Exception during file download", e);
			return Optional.empty();
		}
	}

	private boolean triggerExportTask() throws IOException, InterruptedException {
		for (int i = 0; i < 500; i++, sleep(TRIGGER_EXPORT_TASK_RETRY_SECONDS)) {
			HttpRequest request = HttpRequest.newBuilder()
					.uri(URI.create(ENQUEUE_ENDPOINT))
					.header("Cookie", TOKEN_V2 + "=" + notionTokenV2)
					.header("Content-Type", "application/json")
					.POST(HttpRequest.BodyPublishers.ofString(getTaskJson()))
					.build();

			HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

			var statusCode = response.statusCode();
			if (statusCode >= 500) {
				log.error("Server error (HTTP {}). Trying again in {} seconds...",
						statusCode, TRIGGER_EXPORT_TASK_RETRY_SECONDS);
				continue;
			}

			JsonNode responseJsonNode;
			try {
				responseJsonNode = objectMapper.readTree(response.body());
			} catch (Exception e) {
				log.error("Failed to parse response as JSON (HTTP {}). Trying again in {} seconds...",
						statusCode, TRIGGER_EXPORT_TASK_RETRY_SECONDS);
				continue;
			}

		/*	This will be the response if the given token is not valid anymore (for example if a logout occurred)
			{
				"errorId": "<some-UUID>",
				"name":"UnauthorizedError",
				"message":"Token was invalid or expired.",
				"clientData":{"type":"login_try_again"}
			}
		 */
			if (responseJsonNode.get("taskId") == null) {
				List<ContractViolation> violations = NotionApiContractValidator.validateEnqueueTaskResponse(responseJsonNode);
				NotionApiContractValidator.logViolations("enqueueTask", violations);

				String errorName = responseJsonNode.path("name").asText();
				log.error("Error name: {}, error message: {}", errorName, responseJsonNode.path("message").asText());
				if (StringUtils.equalsIgnoreCase(errorName, "UnauthorizedError")) {
					log.error("Your NOTION_TOKEN_V2 is expired or invalid. To fix this:");
					log.error("  1. Open Notion in your browser and make sure you are logged in");
					log.error("  2. Open DevTools -> Application -> Cookies -> https://www.notion.so");
					log.error("  3. Find the 'token_v2' cookie and copy its value");
					log.error("  4. Update NOTION_TOKEN_V2 in your .env file with the new value");
					log.error("  5. Restart the application");
				}
				return false;
			}

			return true;
		}
		return false;
	}

	private Optional<String> fetchDownloadUrl(long exportTriggerTimestamp) throws IOException, InterruptedException {
		long deadline = exportTriggerTimestamp + exportTimeout.toMillis();
		try {
			for (int attempt = 0; System.currentTimeMillis() < deadline; attempt++) {
				Duration elapsed = Duration.ofMillis(System.currentTimeMillis() - exportTriggerTimestamp);
				Duration interval = nextPollInterval(attempt, elapsed);
				log.debug("Poll attempt {} after {}s elapsed, next poll in {}s", attempt, elapsed.toSeconds(), interval.toSeconds());
				Thread.sleep(interval.toMillis());

				HttpRequest request = HttpRequest.newBuilder()
						.uri(URI.create(NOTIFICATION_ENDPOINT))
						.header("Cookie", TOKEN_V2 + "=" + notionTokenV2)
						.header("Content-Type", "application/json")
						.POST(HttpRequest.BodyPublishers.ofString(getNotificationJson()))
						.build();

				HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

				var statusCode = response.statusCode();
				if (statusCode == HttpURLConnection.HTTP_UNAUTHORIZED) {
					log.error("Notion rejected the token while polling for the export (HTTP 401). "
							+ "NOTION_TOKEN_V2 is expired or invalid; giving up.");
					return Optional.empty();
				}
				if (statusCode >= 500) {
					log.error("Server error (HTTP {}). Trying again...", statusCode);
					continue;
				}

				JsonNode rootNode;
				try {
					rootNode = objectMapper.readTree(response.body());
				} catch (Exception e) {
					log.error("Failed to parse response as JSON (HTTP {}). Trying again...", statusCode);
					continue;
				}

				List<ContractViolation> violations = NotionApiContractValidator.validateNotificationResponse(rootNode);
				NotionApiContractValidator.logViolations("getNotificationLogV2", violations);

				Optional<String> downloadUrl = parseNotificationResponseUrl(rootNode, exportTriggerTimestamp, response.body());
				if (downloadUrl.isEmpty()) {
					continue;
				}

				CookieStore cookieStore = cookieManager.getCookieStore();
				List<HttpCookie> cookies = cookieStore.getCookies();
				notionFileToken = cookies
						.stream()
						.filter(cookie -> FILE_TOKEN.equals(cookie.getName()))
						.findFirst()
						.orElseThrow(() -> new IllegalStateException("'" + FILE_TOKEN + "' cookie not set by Notion"))
						.getValue();
				log.info("Notion file token obtained");
				return downloadUrl;
			}
			log.error("Export did not complete within the configured timeout of {} minutes "
					+ "(NOTION_EXPORT_TIMEOUT_MINUTES).", exportTimeout.toMinutes());
		}
		catch (InterruptedException e) {
			throw e;
		}
		catch (Exception e) {
			log.error("An exception occurred: ", e);
		}
		return Optional.empty();
	}

	/**
	 * Decides how long to wait before the next poll of the notification log.
	 *
	 * <p>Notion exports normally finish within minutes, but since late October 2026 they have
	 * regularly taken several hours. The polling loop now runs until {@code exportTimeout} expires,
	 * so this interval controls the trade-off between how quickly a finished export is picked up
	 * and how many requests are sent to Notion's undocumented API during a long wait.
	 *
	 * @param attempt zero-based number of the poll about to happen
	 * @param elapsed time since the export was triggered
	 * @return the delay before the next poll; must be positive
	 */
	// Package-private for testing
	static Duration nextPollInterval(int attempt, Duration elapsed) {
		// Tiered by elapsed time rather than attempt count, so the schedule stays predictable even
		// when individual requests are slow. Over a 12h timeout this is roughly 190 requests,
		// instead of ~8,600 at a fixed 5s interval.
		if (elapsed.compareTo(FAST_POLL_PHASE) < 0) {
			return FAST_POLL_INTERVAL;
		}
		if (elapsed.compareTo(MEDIUM_POLL_PHASE) < 0) {
			return MEDIUM_POLL_INTERVAL;
		}
		return MAX_POLL_INTERVAL;
	}

	/**
	 * Finds the download link of an export that completed after {@code exportTriggerTimestamp}.
	 *
	 * <p>All activities are scanned (not just the first one), because other notifications may be
	 * listed before the export and the JSON object's ordering is not guaranteed. If several
	 * matching exports exist, the one with the newest {@code start_time} wins.
	 */
	// Package-private for testing
	Optional<String> parseNotificationResponseUrl(JsonNode rootNode, long exportTriggerTimestamp, String rawBodyForLogging) {
		JsonNode activityMapNode = rootNode.path("recordMap").path("activity");
		if (!activityMapNode.isObject() || activityMapNode.isEmpty()) {
			log.info("'activity' map is missing or empty in response. Still waiting...");
			log.debug("Full response body: {}", rawBodyForLogging);
			return Optional.empty();
		}

		String newestLink = null;
		long newestStartTime = Long.MIN_VALUE;
		boolean pendingExportFound = false;

		Iterator<Map.Entry<String, JsonNode>> entries = activityMapNode.fields();
		while (entries.hasNext()) {
			JsonNode dataNode = entries.next().getValue().path("value").path("value");
			if (!EXPORT_COMPLETED_ACTIVITY_TYPE.equals(dataNode.path("type").asText())) {
				continue;
			}
			long startTime = dataNode.path("start_time").asLong(Long.MIN_VALUE);
			if (startTime < exportTriggerTimestamp) {
				continue;
			}
			String link = dataNode.path("edits").path(0).path("link").asText("");
			if (link.isEmpty()) {
				pendingExportFound = true;
				continue;
			}
			if (startTime > newestStartTime) {
				newestStartTime = startTime;
				newestLink = link;
			}
		}

		if (newestLink == null) {
			if (pendingExportFound) {
				log.info("Export notification found but the download URL is not yet present. Still waiting...");
			} else {
				log.info("No export completed since the trigger yet. Still waiting...");
			}
			return Optional.empty();
		}

		log.info("Found a completed export. Trigger timestamp: {}, notification timestamp: {} ({} min later)",
				exportTriggerTimestamp, newestStartTime, (newestStartTime - exportTriggerTimestamp) / 60_000);
		return Optional.of(newestLink);
	}

	private String getTaskJson() {
		String taskJsonTemplate = "{" +
				"  \"task\": {" +
				"    \"eventName\": \"exportSpace\"," +
				"    \"request\": {" +
				"      \"spaceId\": \"%s\"," +
				"      \"shouldExportComments\": %s," +
				"      \"exportOptions\": {" +
				"        \"exportType\": \"%s\"," +
				"        \"flattenExportFiletree\": %s," +
				"        \"timeZone\": \"Europe/Berlin\"," +
				"        \"locale\": \"en\"" +
				"      }" +
				"    }" +
				"  }" +
				"}";
		return String.format(taskJsonTemplate, notionSpaceId, exportComments, exportType.toLowerCase(), flattenExportFileTree);
	}

	private String getNotificationJson() {
		String notificationJsonTemplate = "{" +
				"  \"spaceId\": \"%s\"," +
				"  \"size\": 20," +
				"  \"type\": \"unread_and_read\"," +
				"  \"variant\": \"no_grouping\"" +
				"}";
		return String.format(notificationJsonTemplate, notionSpaceId);
	}

	private void sleep(int seconds) {
		try {
			Thread.sleep(seconds * 1000L);
		} catch (InterruptedException e) {
			log.error("An exception occurred: ", e);
			Thread.currentThread().interrupt();
		}
	}
}

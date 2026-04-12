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
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Optional;

import com.greydev.notionbackup.NotionApiContractValidator.ContractViolation;

import org.apache.commons.io.FileUtils;
import org.apache.commons.lang3.StringUtils;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import lombok.extern.slf4j.Slf4j;


@Slf4j
public class NotionClient {

	private static final int FETCH_DOWNLOAD_URL_RETRY_SECONDS = 5;
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
        boolean exportComments
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

		log.info("Downloads will be saved to: {}", downloadsDirectoryPath);
		log.info("Using export type: {}", exportType);
		log.info("Flatten export file tree: {}", flattenExportFileTree);
		log.info("Export comments: {}", exportComments);
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

				JsonNode errorName = responseJsonNode.get("name");
				log.error("Error name: {}, error message: {}", errorName, responseJsonNode.get("message"));
				if (StringUtils.equalsIgnoreCase(errorName.toString(), "UnauthorizedError")) {
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
		try {
			for (int i = 0; i < 500; i++) {
				sleep(FETCH_DOWNLOAD_URL_RETRY_SECONDS);

				HttpRequest request = HttpRequest.newBuilder()
						.uri(URI.create(NOTIFICATION_ENDPOINT))
						.header("Cookie", TOKEN_V2 + "=" + notionTokenV2)
						.header("Content-Type", "application/json")
						.POST(HttpRequest.BodyPublishers.ofString(getNotificationJson()))
						.build();

				HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

				var statusCode = response.statusCode();
				if (statusCode >= 500) {
					log.error("Server error (HTTP {}). Trying again in {} seconds...",
							statusCode, FETCH_DOWNLOAD_URL_RETRY_SECONDS);
					continue;
				}

				JsonNode rootNode;
				try {
					rootNode = objectMapper.readTree(response.body());
				} catch (Exception e) {
					log.error("Failed to parse response as JSON (HTTP {}). Trying again in {} seconds...",
							statusCode, FETCH_DOWNLOAD_URL_RETRY_SECONDS);
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
						.orElseThrow(IllegalStateException::new)
						.getValue();
				log.info("Notion file token {}", notionFileToken);
				return downloadUrl;
			}
		}
		catch (Exception e) {
			log.error("An exception occurred: ", e);
		}
		return Optional.empty();
	}

	// Package-private for testing
	Optional<String> parseNotificationResponseUrl(JsonNode rootNode, long exportTriggerTimestamp, String rawBodyForLogging) {
		JsonNode activityMapNode = rootNode.path("recordMap").path("activity");
		if (activityMapNode.isMissingNode() || !activityMapNode.fields().hasNext()) {
			log.info("'activity' map is missing or empty in response. Trying again in {} seconds...", FETCH_DOWNLOAD_URL_RETRY_SECONDS);
			log.debug("Full response body: {}", rawBodyForLogging);
			return Optional.empty();
		}
		JsonNode activityEntryNode = activityMapNode.fields().next().getValue();
		JsonNode dataNode = activityEntryNode.path("value").path("value");
		if (dataNode.isMissingNode()) {
			log.info("'value.value' field is missing in activity entry. Trying again in {} seconds...", FETCH_DOWNLOAD_URL_RETRY_SECONDS);
			log.debug("Activity entry: {}", activityEntryNode);
			return Optional.empty();
		}

		String startTimeText = dataNode.path("start_time").asText();
		if (startTimeText.isEmpty()) {
			log.info("'start_time' field is missing in response. Trying again in {} seconds...", FETCH_DOWNLOAD_URL_RETRY_SECONDS);
			log.debug("Value node: {}", dataNode);
			return Optional.empty();
		}
		long notificationStartTimestamp = Long.parseLong(startTimeText);

		if (notificationStartTimestamp < exportTriggerTimestamp) {
			log.info("The newest export trigger notification is still not in the Notion response. " +
					"Trying again in {} seconds...", FETCH_DOWNLOAD_URL_RETRY_SECONDS);
			return Optional.empty();
		}
		log.info("Found a new export trigger notification in the Notion response. " +
				"Attempting to extract the download URL. " +
				"Timestamp of when the export was triggered: {}. " +
				"Timestamp of the notification: {}", exportTriggerTimestamp, notificationStartTimestamp);

		JsonNode linkNode = dataNode.path("edits").get(0).path("link");
		if (linkNode.isMissingNode()) {
			log.info("The download URL is not yet present. Trying again in {} seconds...", FETCH_DOWNLOAD_URL_RETRY_SECONDS);
			return Optional.empty();
		}
		return Optional.of(linkNode.textValue());
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

package com.greydev.notionbackup;

import java.io.File;
import java.time.Duration;
import java.time.ZonedDateTime;
import java.util.Optional;

import org.apache.commons.lang3.StringUtils;

import com.cronutils.model.Cron;
import com.cronutils.model.CronType;
import com.cronutils.model.definition.CronDefinitionBuilder;
import com.cronutils.model.time.ExecutionTime;
import com.cronutils.parser.CronParser;

import io.github.cdimascio.dotenv.Dotenv;
import lombok.extern.slf4j.Slf4j;


@Slf4j
public class NotionKeeper {

	private static final String KEY_SCHEDULING_CONFIG = "SCHEDULING_CONFIG";
	private static final String KEY_RUN_ON_STARTUP = "RUN_ON_STARTUP";
	private static final String KEY_NOTION_SPACE_ID = "NOTION_SPACE_ID";
	private static final String KEY_NOTION_TOKEN_V2 = "NOTION_TOKEN_V2";
	private static final String KEY_NOTION_EXPORT_TYPE = "NOTION_EXPORT_TYPE";
	private static final String KEY_NOTION_FLATTEN_EXPORT_FILETREE = "NOTION_FLATTEN_EXPORT_FILETREE";
	private static final String KEY_NOTION_EXPORT_COMMENTS = "NOTION_EXPORT_COMMENTS";
	private static final String KEY_DOWNLOADS_DIRECTORY_PATH = "DOWNLOADS_DIRECTORY_PATH";
	private static final String DEFAULT_NOTION_EXPORT_TYPE = "markdown";
	private static final boolean DEFAULT_NOTION_FLATTEN_EXPORT_FILETREE = false;
	private static final boolean DEFAULT_NOTION_EXPORT_COMMENTS = true;
	private static final String DEFAULT_DOWNLOADS_PATH = "/downloads";

	static String resolveDownloadsPath(Dotenv dotenv) {
		String path = dotenv.get(KEY_DOWNLOADS_DIRECTORY_PATH);
		if (StringUtils.isBlank(path)) {
			log.info("{} is not set. Downloads will be saved to: {}", KEY_DOWNLOADS_DIRECTORY_PATH, DEFAULT_DOWNLOADS_PATH);
			return DEFAULT_DOWNLOADS_PATH;
		}
		return path;
	}

	private static NotionClient createNotionClient(Dotenv dotenv) {
		String spaceId = dotenv.get(KEY_NOTION_SPACE_ID);
		String tokenV2 = dotenv.get(KEY_NOTION_TOKEN_V2);
		if (StringUtils.isBlank(spaceId)) {
			log.error("{} is missing!", KEY_NOTION_SPACE_ID);
			System.exit(1);
		}
		if (StringUtils.isBlank(tokenV2)) {
			log.error("{} is missing!", KEY_NOTION_TOKEN_V2);
			System.exit(1);
		}
		String downloadsPath = resolveDownloadsPath(dotenv);
		String exportType = StringUtils.isNotBlank(dotenv.get(KEY_NOTION_EXPORT_TYPE))
				? dotenv.get(KEY_NOTION_EXPORT_TYPE) : DEFAULT_NOTION_EXPORT_TYPE;
		boolean flattenExportFileTree = StringUtils.isNotBlank(dotenv.get(KEY_NOTION_FLATTEN_EXPORT_FILETREE))
				? Boolean.parseBoolean(dotenv.get(KEY_NOTION_FLATTEN_EXPORT_FILETREE)) : DEFAULT_NOTION_FLATTEN_EXPORT_FILETREE;
		boolean exportComments = StringUtils.isNotBlank(dotenv.get(KEY_NOTION_EXPORT_COMMENTS))
				? Boolean.parseBoolean(dotenv.get(KEY_NOTION_EXPORT_COMMENTS)) : DEFAULT_NOTION_EXPORT_COMMENTS;
		return new NotionClient(spaceId, tokenV2, downloadsPath, exportType, flattenExportFileTree, exportComments);
	}

	private static final Dotenv DOTENV;

	static {
		DOTENV = initDotenv();
	}

	public static void main(String[] args) {
		log.info("---------------- Starting NotionKeeper ----------------");

		String schedulingConfig = DOTENV.get(KEY_SCHEDULING_CONFIG, "").trim();
		ExecutionTime executionTime;
		try {
			executionTime = parseSchedule(schedulingConfig);
		} catch (IllegalArgumentException e) {
			log.error(e.getMessage());
			System.exit(1);
			return;
		}

		log.info("Scheduling backup with cron syntax '{}'", schedulingConfig);

		if (Boolean.parseBoolean(DOTENV.get(KEY_RUN_ON_STARTUP, "false"))) {
			log.info("RUN_ON_STARTUP is enabled, running backup now");
			runBackup();
			runCleanup();
		}

		while (!Thread.currentThread().isInterrupted()) {
			sleepUntilNextRun(executionTime, schedulingConfig);
			runBackup();
			runCleanup();
		}
	}

	static ExecutionTime parseSchedule(String schedulingConfig) {
		CronParser parser = new CronParser(CronDefinitionBuilder.instanceDefinitionFor(CronType.UNIX));
		try {
			Cron cron = parser.parse(schedulingConfig);
			cron.validate();
			return ExecutionTime.forCron(cron);
		} catch (IllegalArgumentException e) {
			throw new IllegalArgumentException(KEY_SCHEDULING_CONFIG
					+ " does not contain valid cron syntax. Value was: '" + schedulingConfig + "'", e);
		}
	}

	private static void sleepUntilNextRun(ExecutionTime executionTime, String schedulingConfig) {
		ZonedDateTime now = ZonedDateTime.now();
		Duration delay = executionTime.timeToNextExecution(now).orElseThrow(() -> {
			log.error("Could not calculate next execution time for cron expression '{}'", schedulingConfig);
			return new IllegalStateException("Could not calculate next execution time");
		});

		log.info("Next backup scheduled at: {}", now.plus(delay));

		try {
			Thread.sleep(delay.toMillis());
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			log.info("Scheduler interrupted, shutting down");
		}
	}

	private static void runBackup() {
		log.info("---------------- Starting backup ----------------");
		try {
			Optional<File> exportedFile = createNotionClient(DOTENV).export();
			if (exportedFile.isEmpty()) {
				log.error("Backup failed: could not export Notion file");
				return;
			}
			log.info("Backup completed successfully: {}", exportedFile.get().getName());
		} catch (Exception e) {
			log.error("Backup failed with exception", e);
		}
		log.info("---------------- Backup finished ----------------");
	}


	private static void runCleanup() {
		log.info("---------------- Starting cleanup ----------------");
		try {
		    String downloadsPath = resolveDownloadsPath(DOTENV);
			new BackupRetentionManager(DOTENV, downloadsPath).applyRetentionPolicy();
			log.info("Cleanup completed successfully.");
		} catch (Exception e) {
			log.error("Cleanup failed with exception", e);
		}
        log.info("---------------- Cleanup finished ----------------");
	}

	private static Dotenv initDotenv() {
		Dotenv dotenv = Dotenv.configure()
				.ignoreIfMissing()
				.ignoreIfMalformed()
				.load();
		if (dotenv == null) {
			throw new IllegalStateException("Could not load dotenv!");
		}
		return dotenv;
	}
}

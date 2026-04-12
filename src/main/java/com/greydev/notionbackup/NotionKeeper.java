package com.greydev.notionbackup;

import java.io.File;
import java.time.Duration;
import java.time.ZonedDateTime;
import java.util.Optional;

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
			NotionClient notionClient = new NotionClient(DOTENV);

			Optional<File> exportedFile = notionClient.export();
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
			new BackupRetentionManager(DOTENV, notionClient.getDownloadsDirectoryPath()).applyRetentionPolicy();
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

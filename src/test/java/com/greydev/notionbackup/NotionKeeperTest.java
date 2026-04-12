package com.greydev.notionbackup;

import com.cronutils.model.time.ExecutionTime;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;


class NotionKeeperTest {

	@Test
	void parseSchedule_validDailyCron_returnsExecutionTime() {
		ExecutionTime result = NotionKeeper.parseSchedule("0 2 * * *");

		assertThat(result).isNotNull();
	}

	@Test
	void parseSchedule_validEveryMinuteCron_returnsExecutionTime() {
		ExecutionTime result = NotionKeeper.parseSchedule("* * * * *");

		assertThat(result).isNotNull();
	}

	@Test
	void parseSchedule_invalidCronExpression_throwsIllegalArgumentException() {
		assertThatThrownBy(() -> NotionKeeper.parseSchedule("not-a-cron"))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("SCHEDULING_CONFIG");
	}

	@Test
	void parseSchedule_emptyCronExpression_throwsIllegalArgumentException() {
		assertThatThrownBy(() -> NotionKeeper.parseSchedule(""))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("SCHEDULING_CONFIG");
	}

	@Test
	void parseSchedule_tooManyFields_throwsIllegalArgumentException() {
		assertThatThrownBy(() -> NotionKeeper.parseSchedule("0 2 * * * *"))
				.isInstanceOf(IllegalArgumentException.class)
				.hasMessageContaining("SCHEDULING_CONFIG");
	}
}

# NotionKeeper

![CI](https://github.com/AsierZunzu/notionkeeper/actions/workflows/ci.yml/badge.svg?branch=main)

This project extends the [jckleiner/notion-backup](https://github.com/jckleiner/notion-backup) project by patching a couple of bugs and incorporating a scheduler to the Docker image so that the backups can be scheduled. This is achieved using a _cron_ which scheduling is based on an `.env` value.
An updated `.env.dist` file is provided with the original project's variables (see [README -> Set Credentials](https://github.com/jckleiner/notion-backup?tab=readme-ov-file#set-credentials)) plus a couple of custom more. A `compose.yaml` is included too, to ease up the configuration of the container.

## Configure the service
Follow the instructions at [README -> Set Credentials](https://github.com/jckleiner/notion-backup?tab=readme-ov-file#set-credentials) and add:
* `BACKUP_PATH` to set where do you want your backup files to be stored
* `SCHEDULING_CONFIG` to set the scheduling interval. Check out [this link](https://en.wikipedia.org/wiki/Cron) for more information on the format
* `PUID` / `PGID` (optional, default `1000`) to set the user and group the container runs as. On start it takes ownership of the backup directory, so existing backups written by older, root-running versions keep being cleaned up by the retention policy

## Backup retention

After each backup is created, a retention policy is applied to the local backup directory to automatically delete old files. Each rule operates on a **non-overlapping time window** and preserves the **oldest** available backups within that window, maximising temporal coverage.

| Environment variable | Default | Description |
|---|---|---|
| `RETENTION_KEEP_LAST` | `5` | Always keep the N most recent backups, regardless of age |
| `RETENTION_KEEP_LAST_DAY` | `1` | Keep the N oldest backups from the last 24 hours |
| `RETENTION_KEEP_LAST_WEEK` | `3` | Keep the N oldest backups from the 1–7 day range |
| `RETENTION_KEEP_LAST_MONTH` | `8` | Keep the N oldest backups from the 7–30 day range |
| `RETENTION_KEEP_LAST_YEAR` | `12` | Keep the N oldest backups from the 30–365 day range |

A file is deleted only if it is not selected by any rule. Set a variable to `0` to disable that rule.

Example outcome with daily backups after one year (default values):
- **Most recent 5** — unconditional, always available
- **~23 h ago** — oldest from the last day window
- **~4, 5, 6 days ago** — oldest 3 from the last week window
- **~22–29 days ago** — oldest 8 from the last month window
- **~353–364 days ago** — oldest 12 from the last year window

## Testing

Tests use the built-in [Node.js test runner](https://nodejs.org/api/test.html) (`node:test` + `node:assert`). Run them locally with:

```bash
npm ci
npm test
```

Tests run automatically on every push and pull request via the **Test** GitHub Actions workflow.

### What is tested

`BackupRetentionManager` (`src/backupRetentionManager.ts`) is covered by unit tests that exercise every retention rule in isolation as well as combined:

| Test scenario | What it verifies |
|---|---|
| Empty / non-existent directory | No crash, no side-effects |
| Non-backup files present | Files that don't match the backup pattern are never deleted |
| All rules disabled (`0`) | Every backup file is deleted |
| `RETENTION_KEEP_LAST` | Keeps the N most recent files unconditionally; deletes the rest |
| `keepLast` on a very old file | Even a file older than a year is kept if it is among the N most recent |
| `RETENTION_KEEP_LAST_DAY` | Keeps the N **oldest** files from the `(now-1d, now]` window |
| `RETENTION_KEEP_LAST_WEEK` | Exclusive window `(now-7d, now-1d]` — day-window files are not counted |
| `RETENTION_KEEP_LAST_MONTH` | Exclusive window `(now-30d, now-7d]` — week-window files are not counted |
| `RETENTION_KEEP_LAST_YEAR` | Exclusive window `(now-365d, now-30d]` — month-window files are not counted |
| Files older than 365 days | Deleted unless saved by `keepLast` |
| Invalid env var value | Falls back to the default for that rule |
| Negative env var value | Falls back to the default for that rule |
| All rules combined | Each window contributes distinct files; file outside every window is deleted |

The Notion client (`src/notionClient.ts`) is tested against a fake Notion API: the full export flow (cookies, polling, download), retries on server errors / non-JSON responses, an invalid token, a missing `file_token` cookie and download failures. The cron parsing and the API contract validator have their own tests too.

## Code style

The project is written in TypeScript and runs directly on Node.js 26 (native type stripping, no build step). [ESLint](https://eslint.org/) with [typescript-eslint](https://typescript-eslint.io/) enforces a consistent style ([`eslint.config.js`](eslint.config.js)) and `tsc` type-checks the code in strict mode:

- Mandatory braces on all control structures, strict equality, no empty `catch` blocks
- Standard naming conventions (PascalCase types, camelCase functions and variables, UPPER_CASE constants)
- One statement per line, `default` comes last, no switch fall-through
- Files end with a newline

Lint runs automatically on every push and pull request via the **lint** GitHub Actions job. Run it locally with:

```bash
npm run lint
```

## Run the service
Just start the service with docker compose and you are good to go:
```
docker compose up -d
```

### Build/Run
Build the image and run it locally:
```
docker build -t notion-keeper .
docker run --rm --env-file .env -v "$(pwd)/backups:/downloads" notion-keeper
```

Or run it without Docker (requires Node.js 26+ and a `.env` file in the working directory):
```
npm ci --omit=dev
npm start
```

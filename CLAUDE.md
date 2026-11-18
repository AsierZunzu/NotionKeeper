# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**NotionKeeper** — a Dockerized Node.js (TypeScript) application that exports Notion workspaces on a cron schedule and saves them locally. It is an enhanced fork of [jckleiner/notion-backup](https://github.com/jckleiner/notion-backup).

## Commands

### Build & Run

The TypeScript sources run directly on Node.js 26+ via native type stripping — there is no build step.

```bash
# Install dependencies
npm ci

# Run locally (reads .env from the working directory)
npm start

# Build and run with Docker (local build)
docker compose up -d

# Run with published image
docker compose -f compose.yaml up -d
```

### Tests & Lint

```bash
# Run all tests (node:test)
npm test

# Run a single test file
node --test test/notionClient.test.ts

# Run tests whose name matches a pattern
node --test --test-name-pattern="keepLastWeek" "test/**/*.test.ts"

# ESLint + tsc type-check
npm run lint
```

### Docker

```bash
# Build the Docker image
docker build -t notion-keeper .

# Rebuild without cache
docker build --no-cache -t notion-keeper .
```

## Architecture

### Execution Flow

1. **Container startup**: `node /app/src/notionKeeper.ts` is the entrypoint; it loads `.env` (if present, without overriding real env vars) and validates `SCHEDULING_CONFIG` as a 5-field Unix cron expression (exits with code 1 if invalid).
2. **Scheduler** (`src/notionKeeper.ts`): optionally runs a backup immediately (`RUN_ON_STARTUP`), then loops forever: sleep until the next cron execution → backup → retention cleanup. Handles SIGTERM/SIGINT for a fast `docker stop`.
3. **`src/notionClient.ts`**: POSTs to Notion's private `enqueueTask` endpoint, polls `getNotificationLogV2` up to 500 times (5s intervals) for the download URL, captures the `file_token` cookie, then streams the ZIP to `DOWNLOADS_DIRECTORY_PATH`. It sends an explicit `User-Agent` because Notion's edge rejects Node's default one.
4. **`src/backupRetentionManager.ts`**: deletes old `notion-export*.zip` files according to the `RETENTION_KEEP_*` rules.
5. **`src/notionApiContractValidator.ts`**: logs `[API-CONTRACT]` warnings when Notion's undocumented response shapes change.

Logging (`src/logger.ts`) uses SLF4J-style `{}` placeholders.

### Key Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `SCHEDULING_CONFIG` | Cron expression (e.g. `0 2 * * *`) |
| `RUN_ON_STARTUP` | Run a backup immediately on start |
| `TZ` | Container timezone (used for scheduling and file names) |
| `NOTION_SPACE_ID` / `NOTION_TOKEN_V2` | Notion auth |
| `NOTION_EXPORT_TYPE` | `markdown` or `html` |
| `DOWNLOADS_DIRECTORY_PATH` | Path inside container for ZIP files |
| `RETENTION_KEEP_*` | Retention policy |

Copy `.env.dist` to `.env` to get started.

### Docker Image

Single stage on `node:26-slim`: production dependencies are installed with `npm ci --omit=dev` and `src/` is copied as-is.

### CI/CD

`.github/workflows/ci.yml` runs lint and tests on Node 26, then publishes to `ghcr.io/asierzunzu/notionkeeper` on pushes to `main` and version tags (`v*.*.*`), with provenance/SBOM attestation.

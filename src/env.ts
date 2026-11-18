/**
 * Read-only view over the configuration. Real environment variables take precedence over
 * values coming from the .env file, mirroring dotenv-java.
 */
export interface Env {
  get(key: string): string | undefined;
}

/**
 * Loads ./.env into process.env (without overriding variables that are already set).
 * A missing or unreadable .env file is ignored, so the app can be configured purely via
 * environment variables (e.g. Docker's env_file).
 */
export function loadEnv(path = '.env'): Env {
  try {
    process.loadEnvFile(path);
  } catch {
    // ignore: the .env file is optional
  }
  return { get: (key) => process.env[key] };
}

export function isBlank(value: string | undefined | null): boolean {
  return value === undefined || value === null || value.trim() === '';
}

/** Same semantics as Java's Boolean.parseBoolean: true only for "true" (case-insensitive). */
export function parseBoolean(value: string | undefined): boolean {
  return value !== undefined && value.toLowerCase() === 'true';
}

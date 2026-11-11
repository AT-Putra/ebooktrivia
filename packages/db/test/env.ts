// Superuser URL of the test server. DEV ONLY default: the local dev stack (infra/dev/compose.yaml).
const DEFAULT_URL = "postgres://postgres:devonly@127.0.0.1:55432/postgres"; // DEV ONLY

export function serverUrl(): string {
  return process.env["TEST_PG_URL"] ?? DEFAULT_URL;
}

export function databaseUrl(database: string): string {
  const url = new URL(serverUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

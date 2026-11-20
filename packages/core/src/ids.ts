// A lowercase UUID (as PostgreSQL prints uuid), shared by every place that takes an id from a form,
// a job or an outbox payload (code review US-017 L5).
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value);

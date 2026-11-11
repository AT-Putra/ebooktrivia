/**
 * Options every connection made with the `postgres` driver must include:
 *
 *   postgres(url, { ...PG_CONNECTION_OPTIONS, max: 10 })
 *
 * Drizzle's SQL names our public tables unqualified. With PostgreSQL's default search_path
 * ("$user", public) a schema named after the login user (e.g. "worker") would shadow them for
 * every query of that app. sql/roles.sql already sets the database default to `public`; this
 * pins it per connection as well, whatever database or role settings say.
 */
export const PG_CONNECTION_OPTIONS = {
  connection: { search_path: "public" },
} as const;

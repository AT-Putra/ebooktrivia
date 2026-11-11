import { sql } from "drizzle-orm";
import { type AnyPgColumn, bigint, check, customType, timestamp, uuid } from "drizzle-orm/pg-core";

/** Every timestamp is timestamptz, stored in UTC; WIB is applied in core. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const createdAt = () => tstz("created_at").notNull().defaultNow();
export const updatedAt = () => tstz("updated_at").notNull().defaultNow();

/**
 * IDR amount in whole rupiah. Always bigint; the column name must end in `_idr`
 * (test/schema.int.test.ts checks that every `*_idr` column is bigint).
 */
export const idr = (name: `${string}_idr`) => bigint(name, { mode: "number" });

/**
 * Random v4 primary key. Deliberately not uuidv7: ids reach clients (question options are
 * sent as opaque ids) and a time-ordered id would leak insertion order.
 */
export const id = () => uuid("id").primaryKey().defaultRandom();

export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });

/** E.164 phone number, e.g. +6281234567890. */
export const e164Check = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} ~ '^\\+[1-9][0-9]{7,14}$'`);

/** CHECK (column IN (...)) for text kind/state columns. Values are code constants, never input. */
export const inCheck = (name: string, column: AnyPgColumn, values: readonly string[]) =>
  check(name, sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`);

export const nonNegative = (name: string, column: AnyPgColumn) => check(name, sql`${column} >= 0`);

export const jsonObject = (name: string, column: AnyPgColumn) => check(name, sql`jsonb_typeof(${column}) = 'object'`);

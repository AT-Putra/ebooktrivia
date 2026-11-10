// Spike R1 sample schema; replaced by the full M2 schema in US-009.
import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  priceIdr: bigint("price_idr", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

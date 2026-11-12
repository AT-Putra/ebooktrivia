// The DB enums (packages/db) are the source of truth for state names; core must match exactly.
import { schema } from "@ebooktrivia/db";
import { describe, expect, it } from "vitest";
import { CONVERSION_STATUSES, DELIVERY_STATUSES, ORDER_STATUSES } from "./index.ts";

describe("core state lists match the DB enums", () => {
  it("order_status", () => {
    expect([...ORDER_STATUSES]).toEqual(schema.orderStatus.enumValues);
  });

  it("delivery_status", () => {
    expect([...DELIVERY_STATUSES]).toEqual(schema.deliveryStatus.enumValues);
  });

  it("conversion_status", () => {
    expect([...CONVERSION_STATUSES]).toEqual(schema.conversionStatus.enumValues);
  });
});

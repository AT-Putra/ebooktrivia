import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { sqlState } from "./sql-state.ts";

describe("sqlState", () => {
  it("reads this copy's PostgresError", () => {
    const error = Object.assign(new postgres.PostgresError("refused"), { code: "ET144", severity: "ERROR" });
    expect(sqlState(error)).toBe("ET144");
  });

  it("reads a PostgreSQL error of ANOTHER copy of postgres.js by shape (a second bundle's pool fails instanceof)", () => {
    // What postgres.js builds from the server's ErrorResponse: an Error with the server's fields assigned onto it.
    const fromOtherCopy = Object.assign(new Error("order_review_decide: the confirmation does not match the order"), { severity: "ERROR", code: "ET185", routine: "exec_stmt_raise" });
    expect(sqlState(fromOtherCopy)).toBe("ET185");
    expect(sqlState(Object.assign(new Error("deadlock detected"), { severity: "ERROR", code: "40P01" }))).toBe("40P01");
  });

  it("is undefined for anything else: a Node system error, a plain object, a bad code, a bare Error", () => {
    expect(sqlState(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBeUndefined();
    expect(sqlState({ code: "ET185", severity: "ERROR" })).toBeUndefined();
    expect(sqlState(Object.assign(new Error("x"), { code: "et185x", severity: "ERROR" }))).toBeUndefined();
    expect(sqlState(new Error("x"))).toBeUndefined();
    expect(sqlState(undefined)).toBeUndefined();
  });
});

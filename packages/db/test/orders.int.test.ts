// orders_status_guard: public_rw may only use the checkout states; confirmed transitions
// (paid, refunded, review, expired, ...) belong to worker_rw / admin_rw.
import { beforeAll, describe, expect, it } from "vitest";
import { asRole, first, sql, sqlState } from "./db.ts";
import { createLandingPage, createProgram, orderRow, PRICE_IDR } from "./fixtures.ts";

let base: { landingPageId: string; programId: string; productId: string };
beforeAll(async () => {
  const { productId, programId } = await createProgram();
  base = { landingPageId: await createLandingPage(programId), programId, productId };
});

const insertAsPublic = (status = "pending") =>
  asRole("public_rw", async (tx) =>
    first(await tx<{ id: string }[]>`INSERT INTO public.orders ${tx(orderRow({ ...base, status }))} RETURNING id`).id,
  );
const setStatus = (role: "public_rw" | "worker_rw", id: string, status: string) =>
  asRole(role, (tx) => tx`UPDATE public.orders SET status = ${status}, updated_at = now() WHERE id = ${id}`);

describe("orders status guard", () => {
  it.each(["paid", "review", "expired", "gateway_failed", "refunded"])(
    "public_rw cannot INSERT an order as %s (ET040)",
    async (status) => {
      expect(await sqlState(insertAsPublic(status))).toBe("ET040");
    },
  );

  it("public_rw can move between pending and snap_create_failed only", async () => {
    const id = await insertAsPublic();
    await setStatus("public_rw", id, "snap_create_failed");
    await setStatus("public_rw", id, "pending");
    for (const status of ["paid", "review", "expired", "refunded"]) {
      expect(await sqlState(setStatus("public_rw", id, status))).toBe("ET040");
    }
  });

  it("worker_rw confirms payment; public_rw cannot move a paid order back", async () => {
    const id = await insertAsPublic();
    await asRole("worker_rw", (tx) => tx`UPDATE public.orders SET status = 'paid', paid_at = now() WHERE id = ${id}`);
    expect(await sqlState(setStatus("public_rw", id, "pending"))).toBe("ET040");
    await setStatus("worker_rw", id, "refunded");
  });

  it("public_rw cannot write paid_at / refunded_at (42501)", async () => {
    const id = await insertAsPublic();
    for (const column of ["paid_at", "refunded_at"]) {
      expect(await sqlState(asRole("public_rw", (tx) => tx`UPDATE public.orders SET ${tx(column)} = now() WHERE id = ${id}`))).toBe(
        "42501",
      );
    }
  });
});

// Security review item 1: a compromised public app must not be able to create a cheap order that
// the worker's re-query (gross_amount vs orders.amount_idr) would then confirm as PAID.
describe("orders checkout guard (price and combination)", () => {
  const insertAs = (role: "public_rw" | "admin_rw", row: Record<string, unknown>) =>
    asRole(role, (tx) => tx`INSERT INTO public.orders ${tx(row)}`);
  const valid = () => orderRow(base);

  it("accepts an order at the product price on a program on sale", async () => {
    await insertAs("public_rw", valid());
  });

  it.each([1, PRICE_IDR - 1, PRICE_IDR + 1])("rejects amount_idr = %i (ET041)", async (amount) => {
    expect(await sqlState(insertAs("public_rw", { ...valid(), amount_idr: amount }))).toBe("ET041");
  });

  it("rejects a cheaper product on this program (ET042)", async () => {
    const cheap = await createProgram({ priceIdr: 1000 });
    const row = { ...valid(), product_id: cheap.productId, amount_idr: 1000 };
    expect(await sqlState(insertAs("public_rw", row))).toBe("ET042");
  });

  it("rejects a landing page that belongs to another program (ET042)", async () => {
    const other = await createProgram();
    const row = { ...valid(), landing_page_id: await createLandingPage(other.programId) };
    expect(await sqlState(insertAs("public_rw", row))).toBe("ET042");
  });

  it("rejects a draft program (ET043)", async () => {
    const draft = await createProgram({ status: "draft" });
    const row = orderRow({ ...draft, landingPageId: await createLandingPage(draft.programId) });
    expect(await sqlState(insertAs("public_rw", row))).toBe("ET043");
  });

  it.each([
    ["not started", "now() + interval '1 day'", "now() + interval '30 days'"],
    ["ended", "now() - interval '30 days'", "now() - interval '1 second'"],
  ])("rejects a program whose sales window has %s (ET043)", async (_what, start, end) => {
    const p = await createProgram();
    await sql.unsafe(`UPDATE programs SET sales_start_at = ${start}, sales_end_at = ${end} WHERE id = '${p.programId}'`);
    const row = orderRow({ ...p, landingPageId: await createLandingPage(p.programId) });
    expect(await sqlState(insertAs("public_rw", row))).toBe("ET043");
  });

  it("rejects expires_at beyond orders.expiry_seconds (ET044)", async () => {
    const row = { ...valid(), expires_at: new Date(Date.now() + 10 * 365 * 86_400_000) };
    expect(await sqlState(insertAs("public_rw", row))).toBe("ET044");
    const justOver = { ...valid(), expires_at: new Date(Date.now() + 86_400_000 + 60_000) };
    expect(await sqlState(insertAs("public_rw", justOver))).toBe("ET044");
  });

  it("public_rw cannot UPDATE the priced columns afterwards (42501)", async () => {
    const id = await insertAsPublic();
    for (const column of ["amount_idr", "product_id", "program_id", "landing_page_id", "expires_at"]) {
      const value = column === "amount_idr" ? 1 : column === "expires_at" ? new Date() : base.productId;
      expect(
        await sqlState(asRole("public_rw", (tx) => tx`UPDATE public.orders SET ${tx(column)} = ${value} WHERE id = ${id}`)),
      ).toBe("42501");
    }
  });

  it("admin_rw is not bound by the checkout guard (manual orders)", async () => {
    await insertAs("admin_rw", { ...valid(), amount_idr: 1 });
  });
});

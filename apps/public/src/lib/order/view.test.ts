// What the order page can show of an order: the masked values the database gives it (nothing else exists
// in this process), the state mapping, the WhatsApp link.
import { ORDER_STATUSES } from "@ebooktrivia/core";
import { describe, expect, it } from "vitest";
import { isLatePayable, isTerminal, PAGE_STATES } from "./contract.ts";
import type { OrderRecord } from "./data.ts";
import { pageState, PLAY_LOGIN_PATH, toView, whatsappHref } from "./view.ts";

const RECORD: OrderRecord = {
  status: "pending",
  orderCode: "7K4Q9M2XJ5",
  maskedName: "B*** S***",
  maskedPhone: "****890",
  productTitle: "Ebook Trivia Nusantara Juara",
  amountIdr: 49_000,
  pixels: { meta: "1234567890123", tiktok: "ABCDEFGH12345678" },
  lpHost: "promo.example.test",
};

describe("pageState", () => {
  const EXPECTED = {
    pending: "pending",
    paid: "paid",
    review: "review",
    expired: "expired",
    gateway_failed: "failed",
    snap_create_failed: "failed",
    refunded: "refunded",
  } as const;

  it("maps every order status of the enum to a page state", () => {
    expect(ORDER_STATUSES.map((status) => [status, pageState(status)])).toEqual(ORDER_STATUSES.map((status) => [status, EXPECTED[status]]));
  });

  it("shows a status it does not know as pending, which keeps the poll asking", () => {
    for (const status of ["something_new", "", "__proto__", "constructor", "toString", "hasOwnProperty"]) expect(pageState(status), status).toBe("pending");
  });
});

describe("the polling states", () => {
  it("stops only at paid and refunded; expired, failed and review can still be paid late and stay polled", () => {
    expect(PAGE_STATES.filter((s) => isTerminal(s))).toEqual(["paid", "refunded"]);
    expect(PAGE_STATES.filter((s) => isLatePayable(s))).toEqual(["expired", "failed", "review"]);
    expect(PAGE_STATES.filter((s) => !isTerminal(s) && !isLatePayable(s))).toEqual(["pending"]);
  });
});

describe("toView", () => {
  const view = toView(RECORD, "6281111222333", "example.test");

  it("passes the database's masked name and phone through, and carries nothing else personal", () => {
    expect(view.name).toBe("B*** S***");
    expect(view.phone).toBe("****890");
    expect(Object.keys(view).sort()).toEqual(["amountIdr", "code", "loginHref", "name", "orderAgainHref", "phone", "product", "state", "vendors", "whatsappHref"]);
    const json = JSON.stringify(view);
    for (const secret of ["1234567890123", "ABCDEFGH12345678"]) expect(json, secret).not.toContain(secret);
  });

  it("carries the state, the order code, the product, the amount and the vendors (names only)", () => {
    expect(view).toMatchObject({ state: "pending", code: "7K4Q9M2XJ5", product: "Ebook Trivia Nusantara Juara", amountIdr: 49_000, vendors: ["meta", "tiktok"] });
  });

  it("links the OTP login on the play origin, with no token, and back to the landing page", () => {
    expect(view.loginHref).toBe(`https://play.example.test${PLAY_LOGIN_PATH}`);
    expect(new URL(view.loginHref).search).toBe("");
    expect(view.orderAgainHref).toBe("https://promo.example.test/");
    expect(toView({ ...RECORD, lpHost: null }, undefined, "example.test").orderAgainHref).toBeNull();
  });
});

describe("whatsappHref", () => {
  it("is a wa.me link to the pool number with the order code in the text", () => {
    const href = whatsappHref("6281111222333", "7K4Q9M2XJ5", "Ebook & Co");
    const url = new URL(href ?? "");
    expect(url.origin + url.pathname).toBe("https://wa.me/6281111222333");
    expect(url.searchParams.get("text")).toContain("7K4Q9M2XJ5");
    expect(url.searchParams.get("text")).toContain("Ebook & Co");
  });

  it("is absent when no pool number is known", () => {
    expect(whatsappHref(undefined, "7K4Q9M2XJ5", "x")).toBeNull();
  });
});

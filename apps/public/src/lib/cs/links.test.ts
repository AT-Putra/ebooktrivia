import { describe, expect, it } from "vitest";
import { csMailHref, csWhatsappHref } from "./links.ts";

describe("csWhatsappHref", () => {
  it("opens wa.me with the digits of the CS number and a plain prefilled text", () => {
    const href = csWhatsappHref("+6281234567890");
    expect(href.startsWith("https://wa.me/6281234567890?text=")).toBe(true);
    expect(decodeURIComponent(href.split("?text=")[1] ?? "")).toBe("Halo CS, saya butuh bantuan.");
  });

  it("puts the order code, and nothing else, in the text on the order page", () => {
    const href = csWhatsappHref("+6281234567890", "7K4Q9M2XJ5");
    expect(decodeURIComponent(href.split("?text=")[1] ?? "")).toBe("Halo CS, saya butuh bantuan untuk pesanan 7K4Q9M2XJ5.");
    expect(new URL(href).search).toBe(`?text=${encodeURIComponent("Halo CS, saya butuh bantuan untuk pesanan 7K4Q9M2XJ5.")}`);
  });
});

describe("csMailHref", () => {
  it("is a mailto link to the CS address with a subject", () => {
    expect(csMailHref("cs@contoh.id")).toBe(`mailto:cs@contoh.id?subject=${encodeURIComponent("Butuh bantuan")}`);
    expect(csMailHref("cs@contoh.id", "7K4Q9M2XJ5")).toBe(`mailto:cs@contoh.id?subject=${encodeURIComponent("Butuh bantuan untuk pesanan 7K4Q9M2XJ5")}`);
  });

  it("keeps an address with + or & from changing the link (only the one @ stays as it is)", () => {
    const href = csMailHref("cs+toko&x@contoh.id");
    expect(href).toBe(`mailto:cs%2Btoko%26x@contoh.id?subject=${encodeURIComponent("Butuh bantuan")}`);
    expect(new URL(href).searchParams.get("subject")).toBe("Butuh bantuan");
  });
});

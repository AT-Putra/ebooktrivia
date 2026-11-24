// The customer-service (CS) contact on the buyer site against PostgreSQL as the public_rw login: the read (the three fields and nothing else), the cached
// read that never breaks a page, and the help block rendered with a real order: the order code in its links and no personal data anywhere in them.
import { randomBytes } from "node:crypto";
import { newOrderCode, newPublicId } from "@ebooktrivia/core";
import { NO_CS_CONTACT } from "@ebooktrivia/core/cs-contact";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HelpCard } from "../src/components/help/help-card.tsx";
import { OrderCard } from "../src/components/order/order-card.tsx";
import { createCsContactCache, readCsContact } from "../src/lib/cs/contact.ts";
import { getOrderStatus } from "../src/lib/order/data.ts";
import { toView } from "../src/lib/order/view.ts";
import { createShop, DOMAIN, one, PRICE_IDR, publicSql, root, uniquePhone } from "./support.ts";

const CS = { whatsapp: "+6281234567890", email: "cs@contoh.id", hours: "Senin–Jumat 09.00–17.00 WIB" };

beforeEach(async () => {
  await root`DELETE FROM cs_contact`;
});
afterAll(async () => {
  await root`DELETE FROM cs_contact`;
});

describe("reading the CS contact as public_rw", () => {
  it("is no contact when nothing is set, and the three fields when they are", async () => {
    expect(await readCsContact(publicSql)).toEqual(NO_CS_CONTACT);
    await root`INSERT INTO cs_contact (id, whatsapp, email, hours, updated_by_admin_user_id) VALUES (1, ${CS.whatsapp}, ${CS.email}, ${CS.hours}, 'admin-1')`;
    expect(await readCsContact(publicSql)).toEqual(CS);
    await root`UPDATE cs_contact SET whatsapp = NULL, hours = NULL`;
    expect(await readCsContact(publicSql)).toEqual({ whatsapp: null, email: CS.email, hours: null });
  });

  it("can read nothing else of the table (who edited it, and when), and cannot write it", async () => {
    await root`INSERT INTO cs_contact (id, whatsapp) VALUES (1, ${CS.whatsapp})`;
    await expect(publicSql`SELECT updated_by_admin_user_id FROM public.cs_contact`).rejects.toMatchObject({ code: "42501" });
    await expect(publicSql`UPDATE public.cs_contact SET email = 'x@y.id'`).rejects.toMatchObject({ code: "42501" });
    await expect(publicSql`DELETE FROM public.cs_contact`).rejects.toMatchObject({ code: "42501" });
  });

  it("is served through the cache: one read for many pages, a change shows from the refresh after the time to live, a failing refresh keeps the last answer and a failing first read gives no block", async () => {
    await root`INSERT INTO cs_contact (id, whatsapp, email) VALUES (1, ${CS.whatsapp}, ${CS.email})`;
    let clock = 5_000_000;
    const failures: string[] = [];
    const read = vi.fn((signal: AbortSignal) => readCsContact(publicSql, signal));
    const cache = createCsContactCache({ read, onFailure: (code) => failures.push(code), now: () => clock });
    expect(await Promise.all([cache.get(), cache.get(), cache.get()])).toEqual([{ ...CS, hours: null }, { ...CS, hours: null }, { ...CS, hours: null }]);
    expect(read).toHaveBeenCalledTimes(1);
    await root`UPDATE cs_contact SET email = 'baru@contoh.id'`;
    expect((await cache.get()).email).toBe(CS.email);
    // Past the time to live the request is answered with the last answer at once, and the refresh behind it brings the change for the next one.
    clock += 31_000;
    expect((await cache.get()).email).toBe(CS.email);
    await cache.idle();
    expect((await cache.get()).email).toBe("baru@contoh.id");
    // The table cannot be read (what a broken grant or a database fault looks like): the last good answer stays, and the failure is a code.
    await root`REVOKE SELECT (whatsapp, email, hours) ON public.cs_contact FROM public_rw`;
    try {
      clock += 31_000;
      expect((await cache.get()).email).toBe("baru@contoh.id");
      await cache.idle();
      expect(failures).toEqual(["read_failed"]);
      expect((await cache.get()).email).toBe("baru@contoh.id");
      const cold = createCsContactCache({ read: (signal) => readCsContact(publicSql, signal), onFailure: (code) => failures.push(code), now: () => clock });
      expect(await cold.get()).toEqual(NO_CS_CONTACT);
    } finally {
      await root`GRANT SELECT (whatsapp, email, hours) ON public.cs_contact TO public_rw`;
    }
  });

  it("a read that is cancelled stops on the server and leaves the pool free (a stalled database never holds a connection)", async () => {
    await root`INSERT INTO cs_contact (id, whatsapp) VALUES (1, ${CS.whatsapp})`;
    const waiting = (): Promise<{ n: number }[]> => root<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%FROM public.cs_contact WHERE id = 1%' AND pid <> pg_backend_pid()`;
    // The table is locked: the public read has to wait for the lock.
    const locked = root.begin(async (tx) => {
      await tx`LOCK TABLE public.cs_contact IN ACCESS EXCLUSIVE MODE`;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const controller = new AbortController();
    const read = readCsContact(publicSql, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await waiting())[0]?.n).toBe(1);
    controller.abort();
    await expect(read).rejects.toMatchObject({ code: "57014" });
    await expect.poll(async () => (await waiting())[0]?.n, { timeout: 2000 }).toBe(0);
    await locked;
    expect(await readCsContact(publicSql)).toMatchObject({ whatsapp: CS.whatsapp });
  });
});

describe("the help block with a real order", () => {
  it("carries the order code in the WhatsApp text and the mail subject, and no name, e-mail address, phone number or public id anywhere on the page", async () => {
    const shop = await createShop();
    const publicId = newPublicId();
    const code = newOrderCode();
    const phone = uniquePhone();
    const email = "budi.santoso@example.test";
    await one(root<{ id: string }[]>`
      INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at)
      VALUES (${publicId}, ${code}, ${shop.landingPageId}, ${shop.programId}, ${shop.productId}, 'Budi Santoso', ${phone}, ${email}, ${randomBytes(32)}, ${PRICE_IDR}, 'pending', now() + interval '1 hour')
      RETURNING id`);
    await root`INSERT INTO cs_contact (id, whatsapp, email, hours) VALUES (1, ${CS.whatsapp}, ${CS.email}, ${CS.hours})`;
    const contact = await readCsContact(publicSql);
    const record = await getOrderStatus(publicSql, publicId);
    if (record === undefined) throw new Error("order");
    const view = toView(record, "6281199900011", DOMAIN);
    const html =
      renderToStaticMarkup(
        createElement(OrderCard, {
          state: "failed",
          order: { ref: view.code, product: view.product, amount: view.amountIdr, name: view.name, whatsapp: view.phone },
          links: { trivia: view.loginHref, again: view.orderAgainHref, whatsapp: view.whatsappHref },
          pointToHelp: true,
        }),
      ) + renderToStaticMarkup(createElement(HelpCard, { contact, orderCode: view.code }));
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => decodeURIComponent(m[1] ?? ""));
    expect(hrefs).toContain(`https://wa.me/6281234567890?text=Halo CS, saya butuh bantuan untuk pesanan ${code}.`);
    expect(hrefs).toContain(`mailto:cs@contoh.id?subject=Butuh bantuan untuk pesanan ${code}`);
    expect(html).toContain("Hubungi CS di bawah.");
    // The order card has no help area of its own: one "Butuh bantuan?" on the page.
    expect(html.match(/Butuh bantuan\?/g)).toHaveLength(1);
    const csUrls = hrefs.filter((h) => h.startsWith("mailto:") || h.includes("wa.me/6281234567890")).join(" ");
    for (const secret of ["Budi", "Santoso", email, "budi.santoso", phone, phone.slice(1), publicId]) expect(csUrls, secret).not.toContain(secret);
    // Nothing set: no block at all, and the card does not point to one.
    expect(renderToStaticMarkup(createElement(HelpCard, { contact: NO_CS_CONTACT, orderCode: view.code }))).toBe("");
  });
});

// Order status page e2e environment (US-022): a throwaway migrated database with a public_rw LOGIN role
// (@ebooktrivia/test-support/database), the production build of apps/public started through the entry the
// container runs (src/server.ts: Next behind the edge listener, bound to an explicit EDGE_HOST, as in
// infra/images and edge-smoke.sh) on its own port and a DOMAIN, so the host gating, the nonce CSP, the
// proxy rewrites and the order and play origins behave as in production (a plain `next start` listening on
// "localhost" hid a rewrite that failed on the real entry: an empty 404 at the root of the order origin).
// The browser reaches order.example.test and play.example.test through Chromium's --host-resolver-rules
// (ORDER_BROWSER_ARGS), which makes them two different origins with their own (empty) cookie jars, on plain
// http because the test setup has no TLS.
// DEV ONLY defaults: the local dev stack (infra/dev/compose.yaml); CI sets TEST_PG_URL / TEST_VALKEY_URL.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PUBLIC_VALKEY_LIBRARY_CODE } from "@ebooktrivia/adapters/valkey-functions";
import { newOrderCode, newPublicId } from "@ebooktrivia/core";
import { createTestDatabase } from "@ebooktrivia/test-support/database";
import { loadValkeyFunctions } from "@ebooktrivia/test-support/valkey";
import postgres from "postgres";

export const ORDER_PORT = 3205;
export const DOMAIN = "example.test";
export const ORDER_ORIGIN = `http://order.${DOMAIN}:${String(ORDER_PORT)}`;
export const PLAY_ORIGIN = `http://play.${DOMAIN}:${String(ORDER_PORT)}`;
export const ORDER_BROWSER_ARGS = [`--host-resolver-rules=MAP *.${DOMAIN} 127.0.0.1`];
export const PRICE_IDR = 49_000;
export const BUYER = { name: "Budi Santoso", email: "budi.santoso@example.test" } as const;

const publicDir = fileURLToPath(new URL("../../apps/public/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export interface Shop {
  readonly landingPageId: string;
  readonly programId: string;
  readonly productId: string;
  readonly programSlug: string;
  readonly host: string;
}

export interface Order {
  readonly id: string;
  readonly publicId: string;
  readonly eventId: string;
  readonly code: string;
  readonly phone: string;
}

export interface OrderEnv {
  readonly sql: postgres.Sql;
  /** A landing page (with its program, product, hosts and legal pages) with these pixel ids. */
  shop(pixels: Record<string, string>): Promise<Shop>;
  /** An order of the shop in `status` (as the worker would set it). */
  order(shop: Shop, status?: string): Promise<Order>;
  setStatus(order: Order, status: string): Promise<void>;
  /** The paired WORKING WhatsApp session the page's button points to. */
  poolNumber(): Promise<string>;
  stop(): Promise<void>;
}

const one = async <T>(rows: Promise<readonly T[]>): Promise<T> => {
  const [row] = await rows;
  if (row === undefined) throw new Error("no row");
  return row;
};

export async function startOrderEnv(): Promise<OrderEnv> {
  // The other specs get their build from the webServer entries of playwright.config.ts; a run of this spec alone builds it.
  if (!existsSync(`${publicDir}.next/BUILD_ID`)) {
    const built = spawnSync("pnpm", ["--filter", "@ebooktrivia/public", "run", "build"], { cwd: repoRoot, stdio: "inherit", shell: true });
    if (built.status !== 0) throw new Error("the public app did not build");
  }
  const db = await createTestDatabase("ebt_e2e_ord", ["public_rw"]);
  const paymentKey = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" }).d;
  if (paymentKey === undefined) throw new Error("no key");
  const env = {
    NODE_ENV: "production",
    DOMAIN,
    DATABASE_URL_PUBLIC: db.logins.public_rw ?? "",
    VALKEY_URL: process.env["TEST_VALKEY_URL"] ?? "redis://127.0.0.1:56379", // DEV ONLY
    VALKEY_USERNAME: process.env["TEST_VALKEY_PUBLIC_USERNAME"] ?? "public",
    VALKEY_PASSWORD: process.env["TEST_VALKEY_PUBLIC_PASSWORD"] ?? "public-devonly", // DEV ONLY
    CAPTCHA_HMAC_KEY: randomBytes(32).toString("hex"),
    SECRETS_PAYMENT_PRIVATE_KEY: paymentKey,
  };
  // US-031: the worker loads public's rate-limit function in production; no worker runs here.
  await loadValkeyFunctions({ url: env.VALKEY_URL, username: process.env["TEST_VALKEY_USERNAME"] ?? "worker", password: process.env["TEST_VALKEY_PASSWORD"] ?? "worker-devonly" }, PUBLIC_VALKEY_LIBRARY_CODE); // DEV ONLY
  const sql = postgres(db.url, { max: 4, onnotice: () => undefined });
  const child: ChildProcess = spawn(process.execPath, ["src/server.ts"], {
    cwd: publicDir,
    // The listener's own settings (packages/edge): an explicit address, and a trusted proxy that never connects here.
    env: { PATH: process.env["PATH"] ?? "", SYSTEMROOT: process.env["SYSTEMROOT"] ?? "", EDGE_HOST: "127.0.0.1", EDGE_PORT: String(ORDER_PORT), TRUSTED_PROXY_IP: "192.0.2.1", ...env },
    stdio: "ignore",
  });
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${String(ORDER_PORT)}/`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("the public app did not start");
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const tag = (): string => randomBytes(4).toString("hex");
  const setStatus = (order: Order, status: string): Promise<void> =>
    sql
      .begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE worker_rw");
        await tx`UPDATE orders SET status = ${status}, paid_at = CASE WHEN ${status} = 'paid' THEN now() END WHERE id = ${order.id}`;
      })
      .then(() => undefined);

  return {
    sql,
    async shop(pixels) {
      const t = tag();
      const product = await one(sql<{ id: string }[]>`INSERT INTO products (title, price_idr, active) VALUES (${`Ebook Trivia ${t}`}, ${PRICE_IDR}, true) RETURNING id`);
      const slug = `juni-${t}`;
      const program = await one(sql<{ id: string }[]>`
        INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
        VALUES (${product.id}, ${slug}, 'Program', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`);
      const lp = await one(sql<{ id: string }[]>`
        INSERT INTO landing_pages (lp_key, name, program_id, pixels) VALUES (${`lp_${randomBytes(8).toString("hex")}`}, 'LP', ${program.id}, ${sql.json(pixels as never)}) RETURNING id`);
      const host = `lp-${t}.${DOMAIN}`;
      await sql`INSERT INTO lp_domains (landing_page_id, host) VALUES (${lp.id}, ${host})`;
      const legal = async (kind: string, version: number, title: string, body: string, published: boolean) => {
        const page = await one(sql<{ id: string }[]>`INSERT INTO legal_pages (program_id, kind, version, title, body) VALUES (${program.id}, ${kind}, ${version}, ${title}, ${body}) RETURNING id`);
        if (published) await sql`UPDATE legal_pages SET published_at = now() WHERE id = ${page.id}`;
      };
      await legal("terms", 1, "S&K versi lama", "# Lama\nVersi pertama.", true);
      await legal("terms", 2, "Syarat dan Ketentuan Musim 1", "# Hadiah\nJuara 1 mendapat voucher.\n\n<script>window.__xss = 1</script>\n<img src=x onerror=\"window.__xss = 2\">", true);
      await legal("privacy", 1, "Kebijakan Privasi", "# Data\nKami menyimpan nomor WhatsApp.", true);
      await legal("terms", 3, "Draf S&K", "Belum terbit.", false);
      return { landingPageId: lp.id, programId: program.id, productId: product.id, programSlug: slug, host };
    },
    async order(shop, status = "pending") {
      const publicId = newPublicId();
      const code = newOrderCode();
      const phone = `+62812${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
      const row = await one(sql<{ id: string; event_id: string }[]>`
        INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at)
        VALUES (${publicId}, ${code}, ${shop.landingPageId}, ${shop.programId}, ${shop.productId}, ${BUYER.name}, ${phone}, ${BUYER.email}, ${randomBytes(32)}, ${PRICE_IDR}, 'pending', now() + interval '1 hour')
        RETURNING id, event_id`);
      const order = { id: row.id, publicId, eventId: row.event_id, code, phone };
      if (status !== "pending") await setStatus(order, status);
      return order;
    },
    setStatus,
    async poolNumber() {
      await sql`DELETE FROM waha_sessions`;
      const server = await one(sql<{ id: string }[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES ('W', 'https://waha-e2e.invalid/', 'waha-e2e.invalid') RETURNING id`);
      await sql`INSERT INTO waha_sessions (server_id, session_name, phone, status, active) VALUES (${server.id}, 'e2e', '+6281199900011', 'WORKING', true)`;
      return "6281199900011";
    },
    async stop() {
      child.kill();
      await sql.end({ timeout: 5 });
      await db.drop();
    },
  };
}

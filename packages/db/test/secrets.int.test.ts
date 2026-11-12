// US-011: settings_secrets relabel guard (US-009 security finding) and endpoint binding (a host
// change deletes the secrets bound to it). Ciphertexts here are random bytes: the DB never sees
// plaintext, and @ebooktrivia/crypto tests that a relabelled row also fails decryption.
import { afterEach, describe, expect, it } from "vitest";
import { asRole, bytes, first, sql, sqlState, suffix, type Tx } from "./db.ts";

type Id = { id: string };

// The database is shared by every test file, and roles.int.test.ts asserts the exact set of
// payment-scope secrets: every row created here is deleted again after each test.
const created = { secrets: [] as string[], adnets: [] as string[], wahaServers: [] as string[] };
afterEach(async () => {
  await sql`DELETE FROM settings_secrets WHERE id = ANY (${created.secrets}::uuid[])`;
  await sql`DELETE FROM adnets WHERE id = ANY (${created.adnets}::uuid[])`;
  await sql`DELETE FROM waha_servers WHERE id = ANY (${created.wahaServers}::uuid[])`;
  created.secrets = [];
  created.adnets = [];
  created.wahaServers = [];
});

async function createAdnet(endpointHost: string | null): Promise<string> {
  const { id } = first(
    await sql<Id[]>`
      INSERT INTO adnets (slug, name, clickid_param, endpoint_host)
      VALUES (${`adnet-${suffix()}`}, 'Adnet', 'clickid', ${endpointHost}) RETURNING id`,
  );
  created.adnets.push(id);
  return id;
}

async function createWahaServer(baseUrl: string, host: string): Promise<string> {
  const { id } = first(
    await sql<Id[]>`
      INSERT INTO waha_servers (name, base_url, base_url_host) VALUES ('WAHA', ${baseUrl}, ${host}) RETURNING id`,
  );
  created.wahaServers.push(id);
  return id;
}

interface SecretRow {
  scope: string;
  name: string;
  adnet_id: string | null;
  bound_host: string | null;
}

/** Inserts a sealed secret as admin_rw (as the admin app does) and returns its id. */
async function insertSecret(row: SecretRow): Promise<string> {
  const id = await asRole("admin_rw", async (tx) =>
    first(
      await tx<Id[]>`
        INSERT INTO public.settings_secrets (scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
        VALUES (${row.scope}, ${row.name}, ${row.adnet_id}, ${row.bound_host}, ${bytes(40)}, ${bytes(12)}, ${bytes(80)},
                ${`${suffix()}${suffix()}`}, '1234')
        RETURNING id`,
    ).id,
  );
  created.secrets.push(id);
  return id;
}

const secretExists = async (id: string): Promise<boolean> =>
  (await sql`SELECT 1 FROM settings_secrets WHERE id = ${id}`).length === 1;

const paymentSecret = () =>
  insertSecret({ scope: "payment", name: `midtrans.server_key_${suffix()}`, adnet_id: null, bound_host: "api.midtrans.com" });

describe("settings_secrets relabel guard (ET060 / ET061)", () => {
  // The exact attack from the US-009 review: relabel the payment row as a conversions secret
  // bound to an attacker adnet + host, keeping its ciphertext, so the worker would post the
  // Midtrans key to the attacker.
  it("rejects relabelling the payment row as an attacker's conversions secret with the ciphertext kept", async () => {
    const id = await paymentSecret();
    const attackerAdnet = await createAdnet("attacker.example");
    const attack = asRole(
      "admin_rw",
      (tx) => tx`
        UPDATE public.settings_secrets
           SET scope = 'conversions', name = 'api_key', adnet_id = ${attackerAdnet}, bound_host = 'attacker.example'
         WHERE id = ${id}`,
    );
    expect(await sqlState(attack)).toBe("ET060");
    const [row] = await sql<SecretRow[]>`SELECT scope, name, adnet_id, bound_host FROM settings_secrets WHERE id = ${id}`;
    expect(row).toMatchObject({ scope: "payment", adnet_id: null, bound_host: "api.midtrans.com" });
  });

  it.each([
    ["scope", "scope = 'conversions'"],
    ["name", "name = 'other_name'"],
    ["adnet_id", "adnet_id = $1"],
    ["bound_host", "bound_host = 'attacker.example'"],
    ["bound_host to NULL", "bound_host = NULL"],
    ["key_id", "key_id = 'ffffffffffffffff'"],
  ])("rejects a change of %s without re-encryption, for admin_rw, the owner and superusers", async (_what, set) => {
    const id = await paymentSecret();
    const adnet = await createAdnet("attacker.example");
    const params = set.includes("$1") ? [adnet, id] : [id];
    const where = set.includes("$1") ? "$2" : "$1";
    const statement = `UPDATE public.settings_secrets SET ${set} WHERE id = ${where}`;
    for (const role of ["admin_rw", "migrator"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx.unsafe(statement, params)))).toBe("ET060");
    }
    expect(await sqlState(sql.unsafe(statement, params))).toBe("ET060");
  });

  it("rejects a relabel that re-encrypts only part of the row", async () => {
    const id = await paymentSecret();
    const fresh = { ciphertext: bytes(40), nonce: bytes(12), sealed_dek: bytes(80) };
    const partial = (tx: Tx, columns: (keyof typeof fresh)[]) =>
      tx`UPDATE public.settings_secrets SET ${tx(fresh, columns)}, scope = 'conversions' WHERE id = ${id}`;
    for (const columns of [
      ["ciphertext"],
      ["nonce"],
      ["sealed_dek"],
      ["ciphertext", "nonce"],
      ["ciphertext", "sealed_dek"],
      ["nonce", "sealed_dek"],
    ] as (keyof typeof fresh)[][]) {
      expect(await sqlState(asRole("admin_rw", (tx) => partial(tx, columns)))).toBe("ET060");
    }
    // Writing the same bytes back is no re-encryption either.
    const same = asRole(
      "admin_rw",
      (tx) => tx`
        UPDATE public.settings_secrets
           SET scope = 'conversions', ciphertext = ciphertext, nonce = nonce, sealed_dek = sealed_dek
         WHERE id = ${id}`,
    );
    expect(await sqlState(same)).toBe("ET060");
  });

  it("allows a relabel together with a full re-encryption, and a plain value rotation", async () => {
    const id = await paymentSecret();
    await asRole(
      "admin_rw",
      (tx) => tx`
        UPDATE public.settings_secrets
           SET name = 'midtrans.server_key_v2', bound_host = 'app.midtrans.com',
               ciphertext = ${bytes(40)}, nonce = ${bytes(12)}, sealed_dek = ${bytes(80)}, last4 = '9876'
         WHERE id = ${id}`,
    );
    await asRole(
      "admin_rw",
      (tx) => tx`
        UPDATE public.settings_secrets SET ciphertext = ${bytes(44)}, nonce = ${bytes(12)}, sealed_dek = ${bytes(80)}
         WHERE id = ${id}`,
    );
    await asRole("admin_rw", (tx) => tx`UPDATE public.settings_secrets SET last4 = '' , updated_at = now() WHERE id = ${id}`);
    const [row] = await sql<SecretRow[]>`SELECT scope, name, adnet_id, bound_host FROM settings_secrets WHERE id = ${id}`;
    expect(row).toMatchObject({ name: "midtrans.server_key_v2", bound_host: "app.midtrans.com" });
  });

  it("never lets the id change, even with a full re-encryption", async () => {
    const id = await paymentSecret();
    const moveId = (tx: Pick<Tx, "unsafe">) =>
      tx.unsafe(
        `UPDATE public.settings_secrets SET id = gen_random_uuid(), ciphertext = $2, nonce = $3, sealed_dek = $4 WHERE id = $1`,
        [id, bytes(40), bytes(12), bytes(80)],
      );
    expect(await sqlState(asRole("admin_rw", moveId))).toBe("ET061");
    expect(await sqlState(moveId(sql))).toBe("ET061");
    expect(await secretExists(id)).toBe(true);
  });

  it("still fires under session_replication_role = replica", async () => {
    const id = await paymentSecret();
    const underReplica = sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL session_replication_role = replica");
      await tx`UPDATE public.settings_secrets SET scope = 'conversions' WHERE id = ${id}`;
    });
    expect(await sqlState(underReplica)).toBe("ET060");
  });
});

describe("endpoint binding: a host change deletes the bound secret (no error)", () => {
  it("adnets.endpoint_host: the adnet's secrets bound to the old host are deleted in the same transaction", async () => {
    const adnet = await createAdnet("track.adnet.example");
    const other = await createAdnet("track.adnet.example");
    const bound = await insertSecret({ scope: "conversions", name: "api_key", adnet_id: adnet, bound_host: "track.adnet.example" });
    const ported = await insertSecret({ scope: "conversions", name: "api_key_2", adnet_id: adnet, bound_host: "track.adnet.example:8443" });
    const otherAdnet = await insertSecret({ scope: "conversions", name: "api_key", adnet_id: other, bound_host: "track.adnet.example" });
    const payment = await paymentSecret();

    // Unrelated edits and a no-op host write keep the secret.
    await asRole("admin_rw", (tx) => tx`UPDATE public.adnets SET name = 'Renamed', endpoint_host = endpoint_host WHERE id = ${adnet}`);
    expect(await secretExists(bound)).toBe(true);

    await asRole("admin_rw", async (tx) => {
      await tx`UPDATE public.adnets SET endpoint_host = 'attacker.example' WHERE id = ${adnet}`;
      const [n] = await tx<{ n: string }[]>`SELECT count(*) AS n FROM public.settings_secrets WHERE adnet_id = ${adnet}`;
      expect(Number(n?.n)).toBe(0); // gone inside the same transaction
    });
    expect(await secretExists(bound)).toBe(false);
    expect(await secretExists(ported)).toBe(false);
    expect(await secretExists(otherAdnet)).toBe(true);
    expect(await secretExists(payment)).toBe(true);
  });

  it("adnets.endpoint_host: a port change or clearing the host also deletes; a secret bound to the new host stays", async () => {
    const adnet = await createAdnet("track.adnet.example");
    const old = await insertSecret({ scope: "conversions", name: "api_key", adnet_id: adnet, bound_host: "track.adnet.example" });
    const staged = await insertSecret({ scope: "conversions", name: "api_key_new", adnet_id: adnet, bound_host: "track.adnet.example:8443" });
    await asRole("admin_rw", (tx) => tx`UPDATE public.adnets SET endpoint_host = 'track.adnet.example:8443' WHERE id = ${adnet}`);
    expect(await secretExists(old)).toBe(false);
    expect(await secretExists(staged)).toBe(true);
    await asRole("admin_rw", (tx) => tx`UPDATE public.adnets SET endpoint_host = NULL WHERE id = ${adnet}`);
    expect(await secretExists(staged)).toBe(false);
  });

  it("adnets.endpoint_host: a rolled-back host change keeps the secret", async () => {
    const adnet = await createAdnet("track.adnet.example");
    const bound = await insertSecret({ scope: "conversions", name: "api_key", adnet_id: adnet, bound_host: "track.adnet.example" });
    const failing = sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE admin_rw");
      await tx`UPDATE public.adnets SET endpoint_host = 'attacker.example' WHERE id = ${adnet}`;
      await tx`SELECT 1 / 0`;
    });
    expect(await sqlState(failing)).toBe("22012");
    expect(await secretExists(bound)).toBe(true);
  });

  it("waha_servers: a base_url_host change deletes the messaging secrets bound to the old host", async () => {
    const server = await createWahaServer("https://waha.example.id:3000/api", "waha.example.id:3000");
    const apiKey = await insertSecret({ scope: "messaging", name: `waha.api_key_${suffix()}`, adnet_id: null, bound_host: "waha.example.id:3000" });
    const otherHost = await insertSecret({ scope: "messaging", name: `smtp.password_${suffix()}`, adnet_id: null, bound_host: "smtp.example.id:587" });
    await asRole(
      "admin_rw",
      (tx) => tx`
        UPDATE public.waha_servers SET base_url = 'https://evil.example/api', base_url_host = 'evil.example' WHERE id = ${server}`,
    );
    expect(await secretExists(apiKey)).toBe(false);
    expect(await secretExists(otherHost)).toBe(true);
  });

  it.each([
    ["host", "https://evil.example:3000/api"],
    ["port", "https://waha.example.id:4000/api"],
    ["scheme", "http://waha.example.id:3000/api"],
    ["userinfo", "https://waha.example.id:3000@evil.example/api"],
    ["backslash authority", "https://\\evil.example/api"],
    ["unparsable prefix", " https://evil.example/api"],
  ])("waha_servers: a base_url %s change that disagrees with base_url_host is refused (23514)", async (_what, url) => {
    // Since security review US-011 #1 the CHECK ties base_url to base_url_host, so a re-point
    // without the matching label cannot happen at all (before: allowed, key cleared by trigger).
    const server = await createWahaServer("https://waha.example.id:3000/api", "waha.example.id:3000");
    const apiKey = await insertSecret({ scope: "messaging", name: `waha.api_key_${suffix()}`, adnet_id: null, bound_host: "waha.example.id:3000" });
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.waha_servers SET base_url = ${url} WHERE id = ${server}`))).toBe("23514");
    const [row] = await sql<{ base_url: string }[]>`SELECT base_url FROM waha_servers WHERE id = ${server}`;
    expect(row?.base_url).toBe("https://waha.example.id:3000/api");
    expect(await secretExists(apiKey)).toBe(true);
  });

  it("waha_servers: a consistent port change (base_url + base_url_host) deletes the key", async () => {
    const server = await createWahaServer("https://waha.example.id:3000/api", "waha.example.id:3000");
    const apiKey = await insertSecret({ scope: "messaging", name: `waha.api_key_${suffix()}`, adnet_id: null, bound_host: "waha.example.id:3000" });
    await asRole(
      "admin_rw",
      (tx) => tx`UPDATE public.waha_servers SET base_url = 'https://waha.example.id:4000/api', base_url_host = 'waha.example.id:4000' WHERE id = ${server}`,
    );
    expect(await secretExists(apiKey)).toBe(false);
  });

  it("waha_servers: a path-only or unrelated change keeps the key", async () => {
    const server = await createWahaServer("https://waha.example.id:3000/api", "waha.example.id:3000");
    const apiKey = await insertSecret({ scope: "messaging", name: `waha.api_key_${suffix()}`, adnet_id: null, bound_host: "waha.example.id:3000" });
    await asRole(
      "admin_rw",
      (tx) => tx`UPDATE public.waha_servers SET base_url = 'https://waha.example.id:3000/v2', name = 'Renamed', active = false WHERE id = ${server}`,
    );
    expect(await secretExists(apiKey)).toBe(true);
  });

  it("waha_servers: an UPDATE of base_url_host alone (label moved, URL kept) is refused", async () => {
    const server = await createWahaServer("https://evil.example/api", "evil.example");
    expect(
      await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.waha_servers SET base_url_host = 'waha.example.id:3000' WHERE id = ${server}`)),
    ).toBe("23514");
  });

  it("clears for any writer: the delete runs with owner rights", async () => {
    const adnet = await createAdnet("track.adnet.example");
    const bound = await insertSecret({ scope: "conversions", name: "api_key", adnet_id: adnet, bound_host: "track.adnet.example" });
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE migrator");
      await tx`UPDATE public.adnets SET endpoint_host = 'moved.adnet.example' WHERE id = ${adnet}`;
    });
    expect(await secretExists(bound)).toBe(false);
  });
});

describe("waha_servers base_url binding CHECK (security review US-011 #1)", () => {
  // The messaging key is sealed with bound_host = base_url_host in its AAD, but the client sends
  // to base_url. Without this CHECK an INSERT (or DELETE + re-INSERT) could label an attacker
  // URL with the real host and keep the key alive (P4 / P5).
  const insertAsAdmin = (baseUrl: string, host: string) =>
    asRole("admin_rw", (tx) => tx`INSERT INTO public.waha_servers (name, base_url, base_url_host) VALUES ('W', ${baseUrl}, ${host})`);

  it.each([
    ["P4: attacker URL with the real host label", "https://evil.example/api", "waha.example.id:3000"],
    ["P5c: http", "http://waha.example.id:3000/api", "waha.example.id:3000"],
    ["uppercase host", "https://WAHA.example.id:3000/api", "waha.example.id:3000"],
    ["explicit default port", "https://waha.example.id:443/api", "waha.example.id:443"],
    ["port out of range", "https://waha.example.id:70000/api", "waha.example.id:70000"],
    ["port with leading zero", "https://waha.example.id:03000/api", "waha.example.id:03000"],
    ["userinfo", "https://u:p@waha.example.id:3000/api", "u:p@waha.example.id:3000"],
    ["backslash", "https://waha.example.id:3000\\@evil.example/", "waha.example.id:3000\\@evil.example"],
    ["no slash before query", "https://waha.example.id:3000?x=1", "waha.example.id:3000?x=1"],
    ["space in path", "https://waha.example.id:3000/a b", "waha.example.id:3000"],
    ["label with trailing path", "https://waha.example.id:3000/api", "waha.example.id:3000/api"],
  ])("refuses %s (23514)", async (_label, baseUrl, host) => {
    expect(await sqlState(insertAsAdmin(baseUrl, host))).toBe("23514");
  });

  it("P5: deleting the real server and re-inserting its label with an attacker URL is refused", async () => {
    const server = await createWahaServer("https://waha.example.id:3000/api", "waha.example.id:3000");
    const apiKey = await insertSecret({ scope: "messaging", name: `waha.api_key_${suffix()}`, adnet_id: null, bound_host: "waha.example.id:3000" });
    const replace = asRole("admin_rw", async (tx) => {
      await tx`DELETE FROM public.waha_servers WHERE id = ${server}`;
      await tx`INSERT INTO public.waha_servers (id, name, base_url, base_url_host) VALUES (${server}, 'W', 'https://evil.example/api', 'waha.example.id:3000')`;
    });
    expect(await sqlState(replace)).toBe("23514");
    expect(await secretExists(apiKey)).toBe(true);
    const [row] = await sql<{ base_url: string }[]>`SELECT base_url FROM waha_servers WHERE id = ${server}`;
    expect(row?.base_url).toBe("https://waha.example.id:3000/api");
  });

  it.each([
    ["https://waha.example.id", "waha.example.id"],
    ["https://waha.example.id/", "waha.example.id"],
    ["https://waha.example.id:3000/api/v1?x=1#f", "waha.example.id:3000"],
    ["https://203.0.113.5:8443/api", "203.0.113.5:8443"],
  ])("accepts %s labelled %s", async (baseUrl, host) => {
    const id = await asRole("admin_rw", async (tx) =>
      first(await tx<Id[]>`INSERT INTO public.waha_servers (name, base_url, base_url_host) VALUES ('W', ${baseUrl}, ${host}) RETURNING id`).id,
    );
    created.wahaServers.push(id);
    // The DB label equals what the WHATWG URL parser (and @ebooktrivia/crypto assertWahaTarget) sees.
    expect(new URL(baseUrl).host).toBe(host);
  });
});

describe("settings_secrets binding shape (security review US-011 #3)", () => {
  // get_payment_secret() returns no scope/adnet_id, so the public app rebuilds the AAD with
  // adnet null: the DB must guarantee that only conversions secrets carry an adnet, and that
  // every conversions secret is bound to an adnet and a host.
  const insertRaw = (scope: string, adnetId: string | null, boundHost: string | null) =>
    asRole(
      "admin_rw",
      (tx) => tx`
        INSERT INTO public.settings_secrets (scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
        VALUES (${scope}, ${`k_${suffix()}`}, ${adnetId}, ${boundHost}, ${bytes(40)}, ${bytes(12)}, ${bytes(80)}, ${`${suffix()}${suffix()}`}, '')`,
    );

  it("P7: refuses a payment or messaging secret that carries an adnet_id", async () => {
    const adnet = await createAdnet("track.adnet.example");
    expect(await sqlState(insertRaw("payment", adnet, "api.midtrans.com"))).toBe("23514");
    expect(await sqlState(insertRaw("messaging", adnet, "waha.example.id"))).toBe("23514");
  });

  it("P8: refuses a conversions secret without an adnet or without a bound host", async () => {
    const adnet = await createAdnet("track.adnet.example");
    expect(await sqlState(insertRaw("conversions", null, "track.adnet.example"))).toBe("23514");
    expect(await sqlState(insertRaw("conversions", adnet, null))).toBe("23514");
  });

  it("get_payment_secret() returns only adnet-less payment rows", async () => {
    const fn = await sql<{ src: string }[]>`SELECT prosrc AS src FROM pg_proc WHERE proname = 'get_payment_secret'`;
    expect(first(fn).src).toMatch(/s\.adnet_id IS NULL/);
  });
});

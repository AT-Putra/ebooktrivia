// A fresh database with a random name, migrated by @ebooktrivia/db, plus one LOGIN role per app
// group the worker uses (worker_rw, internal_rw): exactly how M4 deploys them (roles.sql groups are
// NOLOGIN; preflight.sql refuses a login in two groups). Both are dropped afterwards.
// DEV ONLY defaults: the local dev stack (infra/dev/compose.yaml). CI sets TEST_PG_URL and
// TEST_VALKEY_URL / TEST_VALKEY_USERNAME / TEST_VALKEY_PASSWORD.
import { randomBytes } from "node:crypto";
import { runMigrations } from "@ebooktrivia/db/migrate";
import postgres from "postgres";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    dbUrl: string;
    workerDbUrl: string;
    internalDbUrl: string;
    publicDbUrl: string;
    valkeyPublicUsername: string;
    valkeyPublicPassword: string;
    valkeyUrl: string;
    valkeyUsername: string;
    valkeyPassword: string;
  }
}

const DEFAULT_PG = "postgres://postgres:devonly@127.0.0.1:55432/postgres"; // DEV ONLY
const DEFAULT_VALKEY = "redis://127.0.0.1:56379"; // DEV ONLY

function urlFor(server: string, database: string, user?: { name: string; password: string }): string {
  const url = new URL(server);
  url.pathname = `/${database}`;
  if (user !== undefined) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = process.env["TEST_PG_URL"] ?? DEFAULT_PG;
  const id = randomBytes(6).toString("hex");
  const name = `ebt_wrk_${id}`;
  const worker = { name: `ebt_worker_${id}`, password: randomBytes(18).toString("hex") };
  const internal = { name: `ebt_internal_${id}`, password: randomBytes(18).toString("hex") };
  const publicLogin = { name: `ebt_public_${id}`, password: randomBytes(18).toString("hex") };
  const admin = postgres(server, { max: 1, onnotice: () => undefined });
  const teardown = async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${worker.name}`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${internal.name}`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${publicLogin.name}`);
    await admin.end();
  };
  await admin.unsafe(`CREATE DATABASE ${name}`);
  try {
    await runMigrations(urlFor(server, name));
    await admin.unsafe(`CREATE ROLE ${worker.name} LOGIN PASSWORD '${worker.password}' IN ROLE worker_rw`);
    await admin.unsafe(`CREATE ROLE ${internal.name} LOGIN PASSWORD '${internal.password}' IN ROLE internal_rw`);
    await admin.unsafe(`CREATE ROLE ${publicLogin.name} LOGIN PASSWORD '${publicLogin.password}' IN ROLE public_rw`);
  } catch (error) {
    await teardown();
    throw error;
  }
  project.provide("dbUrl", urlFor(server, name));
  project.provide("workerDbUrl", urlFor(server, name, worker));
  project.provide("internalDbUrl", urlFor(server, name, internal));
  project.provide("publicDbUrl", urlFor(server, name, publicLogin));
  project.provide("valkeyUrl", process.env["TEST_VALKEY_URL"] ?? DEFAULT_VALKEY);
  project.provide("valkeyUsername", process.env["TEST_VALKEY_USERNAME"] ?? "worker");
  project.provide("valkeyPassword", process.env["TEST_VALKEY_PASSWORD"] ?? "worker-devonly"); // DEV ONLY
  project.provide("valkeyPublicUsername", process.env["TEST_VALKEY_PUBLIC_USERNAME"] ?? "public");
  project.provide("valkeyPublicPassword", process.env["TEST_VALKEY_PUBLIC_PASSWORD"] ?? "public-devonly"); // DEV ONLY
  return teardown;
}

# infra

Local dev stack and provisional third-party stubs.

## Start

```sh
docker compose -f infra/dev/compose.yaml up -d --build --wait
docker compose -f infra/dev/compose.yaml ps      # all five services should be healthy
docker compose -f infra/dev/compose.yaml down    # add -v to drop volumes
```

Optional: `cp infra/dev/.env.example infra/dev/.env` to override defaults (the `.env` is gitignored).
Every credential in this stack is a DEV ONLY placeholder; never reuse them elsewhere.

| Service | Host port | Notes |
|---|---|---|
| postgres (18.6 + wal-g v3.0.9 binary, archiving off) | 127.0.0.1:55432 | user `postgres` |
| valkey 9.1.3 | 127.0.0.1:56379 | ACL users `public`, `worker`, `admin`, `ops` (ping only); `default` is off |
| mailpit v1.33.1 | SMTP 127.0.0.1:51025, UI 127.0.0.1:58025 | |
| waha-mock | 127.0.0.1:53000 | header `X-Api-Key`; control plane under `/__mock/*` |
| midtrans-stub | 127.0.0.1:53001 | Basic auth `base64(serverKey:)`; control plane under `/__stub/*` |

## PROVISIONAL status of fixtures

All files in `waha-mock/fixtures` and `midtrans-stub/fixtures` carry a top-level `_provenance` of
`PROVISIONAL`: they are shaped from public docs, not recorded from a real WAHA session or Midtrans sandbox.
WAHA fixtures are to be replaced in US-005. The Midtrans duplicate `order_id` 400 body is also unverified.

## Tests

The stubs are tested in-process (no Docker) via `pnpm test`.

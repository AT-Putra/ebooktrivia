# Decision: no separate eviction-enabled Valkey for the public cache (US-031 follow-up)

Status: **recommended, not built** (2026-11-22). Revisit when a trigger below fires.

## The question

One Valkey 9.1.3 serves everything (`noeviction`, AOF, 384 MB in a 512 MB container; infra/provision/files/valkey/valkey.conf):
BullMQ's queues (`ebt:*`, the worker), the public app's rate-limit counters (`rl:*`) and Cap token marks (`cache:public:cap:t:*`),
and the admin's cache. Under `noeviction` a full Valkey refuses writes, so a flood of public keys could stop the queues. Should
the public keys move to a second Valkey that evicts?

## What the public keys are

- **Rate-limit counters** (`rl:*`, the `ebt_rate_limit_v1` function): every one carries its window as TTL (seconds to hours).
- **Cap token marks** (`cache:public:cap:t:<nonce>`, `SET NX PX`): the single-use mark of a redeemed captcha token, kept for the
  token's remaining life. Cap stores nothing else (Owner decision, US-020).
- The checkout config and the SDK config caches are in-process (apps/public lib/sdk-routes.ts), not in Valkey.

## Why not

1. **Eviction would weaken the controls these keys are.** An evicted counter resets a rate limit; an evicted mark lets a redeemed
   Cap token verify a second time. Under memory pressure (exactly when an attacker floods) an eviction policy would remove the
   protections first. They are not a cache: they are security state with a short life.
2. **The volume is bounded by the limits themselves.** A counter is created only per client bucket (/64 or /48 for IPv6, the
   phone hash) and expires with its window; a mark needs a solved proof of work. Filling 384 MB with ~100-byte keys takes millions of
   distinct buckets inside one window: a botnet-scale attack that the accepted residual R3 (no CDN/WAF, plan section 7) already covers.
3. **Cost on a 4 vCPU / 8 GB VM:** a second container, ACL file, quadlet, health check, budget and monitor, and a second client and
   failure mode in apps/public, for no gain in the common case.

## What is done instead

- Every public key has a TTL (lib/valkey.ts; `ebt_rate_limit_v1` re-sets a lost TTL).
- The public app fails closed when Valkey refuses a write (503, the existing ValkeyUnavailable path), and the worker's queues and
  sweepers recover from the outbox in PostgreSQL (Valkey is disposable, plan section 3).
- The `public` ACL user reaches `rl:*` and `cache:public:*` only, with no reads, deletes or Lua of its own (US-031).

## Triggers to revisit

- `used_memory` above 60 % of `maxmemory` outside a load test, or keys under `rl:*` above 1 million (US-015 monitoring: add the
  Valkey memory alert there);
- a public feature that needs a real, losable cache in Valkey (then that cache, and only it, goes to an `allkeys-lru` instance,
  never the counters or the marks).

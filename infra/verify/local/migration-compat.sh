#!/usr/bin/env bash
# CI migration compatibility (US-015, plan M4.4): the PREVIOUS release's code and tests against the NEW schema.
#
#   infra/verify/local/migration-compat.sh [PREVIOUS_REF]
#
# A rolling deploy migrates first and restarts the apps after, and a failed deploy rolls the IMAGES back and leaves the schema
# alone (infra/deploy/remote.sh): so for as long as a deploy lasts, the previous release runs on the new schema. This script
# proves that it can:
#   1. the new migrations are checked for the expand-only rule (infra/verify/local/expand-only.sh);
#   2. PREVIOUS_REF is exported (git archive: nothing in this checkout or in any worktree is touched) and given the NEW
#      database schema: packages/db/migrations, packages/db/sql and the migration runner src/migrate.ts of THIS checkout;
#   3. the previous release's own integration tests run in it, so their global setup applies the new schema (twice, like
#      the real one) and the previous code, queries and fixtures run on it: public (checkout, webhooks, order page, play),
#      admin (settings, auth, reports), the worker (relay, consumers, sweepers, deliveries) and crypto (the secret store).
# What is left out on purpose: the db package's own tests (they pin THIS schema: tables, roles, grants, snapshots) and the
# chaos and load tests (child processes and Docker, covering no query).
#
# PREVIOUS_REF defaults to the commit this one was branched from (merge-base with origin/main) or, on main, to HEAD~1. In CI
# the job passes the base of the pull request or the commit before the push. Needs the services of the job
# db-integration (TEST_PG_URL, TEST_VALKEY_URL...; the DEV ONLY dev stack by default), pnpm and network access for the install
# (offline from the pnpm store works too). Exit 1 when the previous release fails on the new schema.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
cd "$REPO"

previous=${1:-}
if [[ -z $previous ]]; then
  base=$(git merge-base HEAD origin/main 2>/dev/null || true)
  if [[ -n $base && $base != "$(git rev-parse HEAD)" ]]; then previous=$base; else previous=HEAD~1; fi
fi
git rev-parse --verify --quiet "$previous^{commit}" >/dev/null || {
  printf 'migration-compat: %s is not a commit (CI needs fetch-depth: 0)\n' "$previous" >&2
  exit 1
}
printf 'migration-compat: previous release = %s (%s)\n' "$previous" "$(git rev-parse --short "$previous")"

bash "$HERE/expand-only.sh" "$previous"

work=$(mktemp -d "${TMPDIR:-/tmp}/ebt-migration-compat.XXXXXX")
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
prev=$work/previous
mkdir -p "$prev"
git archive "$previous" | tar -x -C "$prev"

# The new schema into the previous tree: the migrations, the SQL files the runner applies after them, and the runner (a new
# release may add a SQL file to it). The previous release's own schema.ts and queries stay: that is the code under test.
rm -rf "$prev/packages/db/migrations" "$prev/packages/db/sql"
cp -a "$REPO/packages/db/migrations" "$REPO/packages/db/sql" "$prev/packages/db/"
cp "$REPO/packages/db/src/migrate.ts" "$prev/packages/db/src/migrate.ts"
printf 'migration-compat: %s migrations on the previous release (was %s)\n' \
  "$(find "$prev/packages/db/migrations" -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')" \
  "$(git ls-tree --name-only "$previous" packages/db/migrations/ | grep -c '\.sql$' || true)"

cd "$prev"
pnpm install --frozen-lockfile >/dev/null
fail=0
run() {
  printf '\n### previous release: %s\n' "$*"
  if ! "$@"; then
    printf 'FAIL  %s\n' "$*"
    fail=1
  fi
}
run pnpm --filter @ebooktrivia/crypto test:int
run pnpm --filter @ebooktrivia/public test:int
run pnpm --filter @ebooktrivia/admin test:int
# The worker's in-process integration tests (the same set the coverage gate runs, without the coverage).
run pnpm --filter @ebooktrivia/worker exec vitest run --config vitest.config.ts --coverage.enabled=false

if ((fail)); then
  printf '\nmigration-compat: the previous release FAILS on the new schema: the migrations are not backward compatible\n' >&2
  exit 1
fi
printf '\nmigration-compat: the previous release (%s) passes on the new schema\n' "$(git -C "$REPO" rev-parse --short "$previous")"

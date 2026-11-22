#!/usr/bin/env bash
# The expand-only rule on the migrations a change ADDS (US-015; rule and reasons: infra/verify/src/expand-only.ts and
# docs/runbooks/deploy.md section "Expand and contract"):
#
#   infra/verify/local/expand-only.sh [--refuse-contract-ok] [BASE_REF]      BASE_REF defaults to HEAD~1
#
# Checks every packages/db/migrations/*.sql that is new (or changed) between BASE_REF and the working tree, however many commits that is.
# A migration that drops, renames or retypes something, makes a column NOT NULL or adds a NOT NULL column without a default is refused
# unless it carries a `-- contract-ok: <reason>` line. Applied migrations are never edited, so a changed one is refused too.
# --refuse-contract-ok is the deploy job's mode (.github/workflows/deploy.yml: BASE_REF is the release running on the VM): a
# contract-ok line only promises that the PREVIOUS release no longer needs what the file removes, so across a jump it is refused too.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
cd "$REPO"
flags=()
if [[ ${1:-} == --refuse-contract-ok ]]; then
  flags=(--refuse-contract-ok)
  shift
fi
base=${1:-HEAD~1}
git rev-parse --verify --quiet "$base^{commit}" >/dev/null || {
  printf 'expand-only: %s is not a commit\n' "$base" >&2
  exit 1
}
mapfile -t added < <(git diff --name-only --diff-filter=A "$base" -- 'packages/db/migrations/*.sql'; git ls-files --others --exclude-standard -- 'packages/db/migrations/*.sql')
mapfile -t changed < <(git diff --name-only --diff-filter=MDR "$base" -- 'packages/db/migrations/*.sql')
if ((${#changed[@]})); then
  printf 'expand-only: an applied migration was changed or removed: %s\n' "${changed[*]}" >&2
  printf '             add a new migration instead (an applied one is never edited)\n' >&2
  exit 1
fi
if ((${#added[@]} == 0)); then
  printf 'expand-only: no new migration since %s\n' "$base"
  exit 0
fi
node "$REPO/infra/verify/src/expand-only-cli.ts" "${flags[@]+"${flags[@]}"}" "${added[@]}"

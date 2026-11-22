#!/usr/bin/env bash
# Secret and dependency scans (US-031), run locally from the tools' OFFICIAL images through Docker, pinned by
# digest. Nothing is installed on the host. The same tool versions and the same config files as CI
# (.github/workflows/ci.yml jobs secrets-scan and dependency-scan; docs/versions.md "Security scans"):
#
#   gitleaks 8.30.1      the FULL history of every branch of this repository, then the working tree as it
#                        would be committed (tracked files plus untracked ones that .gitignore does not
#                        exclude). Config: .gitleaks.toml at the repository root (the default rules plus
#                        reviewed allowlists, each narrowed to one file and one value or shape). Findings are
#                        printed redacted. Runs with --network none: nothing leaves the machine.
#   OSV-Scanner 2.7.0    pnpm-lock.yaml (every workspace package, the infra stubs included). Config:
#                        osv-scanner.toml next to the lockfile (reviewed overrides, each pinned to a package name
#                        and version, with a reason and an expiry). The only network traffic is OSV's normal vulnerability-database query to
#                        api.osv.dev: package names, versions and ecosystems from the lockfile, no source.
#
#   infra/verify/local/security-scan.sh [all|secrets|deps]      (default: all; needs Docker and git)
#
# The repository is mounted read-only. The history is scanned from a bare clone in a temporary directory
# (a linked git worktree's .git is a file naming a host path, which the container cannot follow); the
# working tree from a temporary copy of the files git would commit. Both are removed on exit.
# Exit status: 0 when both scans are clean, 1 on any finding or scan error.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
# shellcheck source=infra/verify/local/lib.sh
. "$HERE/lib.sh"
# Latest stable releases at least 14 days old on 2026-11-22 (OSV-Scanner 2.7.1, 2026-11-09, was younger).
GITLEAKS_IMAGE=ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
OSV_IMAGE=ghcr.io/google/osv-scanner:v2.7.0@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0
mode=${1:-all}
case $mode in all | secrets | deps) ;; *)
  printf 'usage: %s [all|secrets|deps]\n' "$0" >&2
  exit 2
  ;;
esac
work=$(mktemp -d)
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
fail=0

secrets() {
  printf '### gitleaks: full history of every branch\n'
  git clone --quiet --bare --no-local "$(host_path "$REPO")" "$(host_path "$work")/history.git"
  printf '%s commits\n' "$(git -C "$(host_path "$work")/history.git" rev-list --all --count)"
  # The bare clone belongs to the host user, the container runs as another: tell git to trust it.
  local trust=(-e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*')
  local config=(--config /repo/.gitleaks.toml --redact --verbose --no-banner --no-color --exit-code 1)
  docker run --rm --network none "${trust[@]}" \
    -v "$(host_path "$REPO"):/repo:ro" -v "$(host_path "$work/history.git"):/history:ro" \
    "$GITLEAKS_IMAGE" git "${config[@]}" --log-opts=--all /history || fail=1

  printf '### gitleaks: the working tree (what a commit would hold)\n'
  mkdir "$work/tree"
  # The files a commit would hold: tracked and untracked-not-ignored ones, minus those deleted in the working tree
  # (still in the index until staged). Every one must be copied: a short copy would scan less and pass (code review 6).
  local listed=0 copied
  : >"$work/files"
  while IFS= read -r -d '' file; do
    [[ -f $REPO/$file ]] || continue
    printf '%s\0' "$file" >>"$work/files"
    listed=$((listed + 1))
  done < <(cd "$REPO" && git ls-files -z --cached --others --exclude-standard)
  (cd "$REPO" && xargs -0 -r cp --parents -t "$work/tree" <"$work/files") || {
    printf 'gitleaks: could not copy the working tree\n' >&2
    fail=1
    return
  }
  copied=$(find "$work/tree" -type f | wc -l | tr -d ' ')
  printf '%s files\n' "$copied"
  if ((copied != listed)); then
    printf 'gitleaks: copied %s of the %s files git lists: the working tree scan would miss some\n' "$copied" "$listed" >&2
    fail=1
    return
  fi
  docker run --rm --network none -v "$(host_path "$REPO"):/repo:ro" -v "$(host_path "$work/tree"):/tree:ro" \
    "$GITLEAKS_IMAGE" dir "${config[@]}" /tree || fail=1
}

deps() {
  printf '### OSV-Scanner: pnpm-lock.yaml\n'
  docker run --rm -v "$(host_path "$REPO"):/repo:ro" "$OSV_IMAGE" scan source --lockfile=/repo/pnpm-lock.yaml || fail=1
}

[[ $mode == deps ]] || secrets
[[ $mode == secrets ]] || deps
if ((fail == 0)); then printf 'security-scan: clean\n'; else printf 'security-scan: FINDINGS (see above)\n'; fi
exit "$fail"

#!/usr/bin/env bash
# Runs ShellCheck over every shell script of the infrastructure (koalaman/shellcheck v0.11.0, all
# severities; each `# shellcheck disable` in the scripts carries its reason).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
# shellcheck source=infra/verify/local/lib.sh
. "$HERE/lib.sh"
cd "$REPO"
mapfile -t scripts < <(git ls-files --cached --others --exclude-standard 'infra/*.sh')
docker run --rm -v "$(host_path "$REPO"):/mnt:ro" -w /mnt docker.io/koalaman/shellcheck:v0.11.0 \
  -x -P SCRIPTDIR --severity=style "${scripts[@]}"
printf 'shellcheck: %d scripts, no findings\n' "${#scripts[@]}"

# shellcheck shell=bash
# Helpers of the local harnesses (sourced): Docker Desktop on Windows (Git Bash) needs Windows
# paths for mounts, build contexts and docker cp; elsewhere the path is used as it is.
export MSYS_NO_PATHCONV=1
host_path() { (cd "$1" && pwd -W 2>/dev/null) || printf '%s' "$1"; }

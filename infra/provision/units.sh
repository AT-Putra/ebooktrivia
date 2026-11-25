# shellcheck shell=bash
# The quadlet units, in one place for provision.sh, host-check.sh and the local harnesses
# (sourced, never run). infra/verify/src/quadlets.test.ts checks this list against infra/quadlet.
# shellcheck disable=SC2034 # read by the scripts that source this file
EBT_SERVICES=(postgres valkey internal worker admin public@a public@b caddy)
# shellcheck disable=SC2034 # read by the scripts that source this file
EBT_ONESHOTS=(migrate)
# shellcheck disable=SC2034 # read by the scripts that source this file
EBT_NETWORKS=(ebt-edge ebt-data ebt-admin ebt-internal ebt-backup ebt-preflight)
# shellcheck disable=SC2034 # read by the scripts that source this file
EBT_VOLUMES=(ebt-pgdata ebt-valkeydata ebt-caddy-data ebt-caddy-config)
# Every service the quadlet generator must produce.
# shellcheck disable=SC2034 # read by the scripts that source this file
EBT_GENERATED=("${EBT_SERVICES[@]}" "${EBT_ONESHOTS[@]}" "${EBT_NETWORKS[@]/%/-network}" "${EBT_VOLUMES[@]/%/-volume}")

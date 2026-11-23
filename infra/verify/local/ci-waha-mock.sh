#!/usr/bin/env bash
# Starts the dev stack's WAHA stand-in (infra/waha-mock, as infra/dev/compose.yaml runs it) on 127.0.0.1:53000 for a CI
# job whose integration tests send through it over HTTP (apps/worker/test/otp-send.int.test.ts). Waits for its /healthz.
#
#   infra/verify/local/ci-waha-mock.sh        (needs Docker and curl)
#
# The keys are the dev stack's defaults: DEV ONLY / CI ONLY test values, never a real WAHA key.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
NAME=waha-mock
PORT=${WAHA_MOCK_PORT:-53000}

docker build -q -t ebt-waha-mock "$REPO/infra/waha-mock" >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:3000" \
  -e WAHA_MOCK_API_KEY=devonly-waha-key \
  -e WAHA_MOCK_WEBHOOK_HMAC_SECRET=devonly-waha-hmac \
  ebt-waha-mock >/dev/null
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/healthz"; then
    printf 'waha-mock: up on 127.0.0.1:%s\n' "$PORT"
    exit 0
  fi
  sleep 1
done
printf 'waha-mock did not become healthy; its log:\n' >&2
docker logs "$NAME" 2>&1 | tail -n 20 >&2
exit 1

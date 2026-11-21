#!/usr/bin/env bash
# Staging check of story US-023 criterion 3 (second half): a valid landing-page ZIP served on a real
# custom domain with an on-demand TLS certificate. Run on the staging VM after the steps of
# docs/runbooks/landing-pages.md "Staging check" (domain registered, DNS at this VM, ZIP published).
#
#   sudo infra/verify/lp-tls-check.sh HOST LP_KEY [UNREGISTERED_HOST] [CONFIG]
#
#   HOST               a domain registered on a landing page whose ZIP is published; its A / AAAA record
#                      points at this VM
#   LP_KEY             that landing page's key (lp_...), as the console shows it
#   UNREGISTERED_HOST  optional: a name that ALSO points at this VM but is registered nowhere; it must get
#                      no certificate
#   CONFIG             defaults to /etc/ebooktrivia/provision.env
#
# Read-only: it asks the internal process, reads the database (SELECT), reads the link, opens TLS
# connections and GETs pages. The first HTTPS request may trigger the certificate's issuance (on-demand
# TLS), so it is retried for up to two minutes. Prints one PASS / FAIL line per check, exits 1 on a FAIL.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/provision/lib.sh
. "$HERE/../provision/lib.sh"
require_root
[[ $# -ge 2 ]] || die "usage: lp-tls-check.sh HOST LP_KEY [UNREGISTERED_HOST] [CONFIG]"
HOST=$1
LP_KEY=$2
OTHER=${3:-}
load_config "${4:-/etc/ebooktrivia/provision.env}"
DOMAIN=$CFG_DOMAIN
label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
[[ $HOST =~ ^($label\.)+$label$ ]] || die "HOST must be a lowercase DNS name"
[[ -z $OTHER || $OTHER =~ ^($label\.)+$label$ ]] || die "UNREGISTERED_HOST must be a lowercase DNS name"
[[ $LP_KEY =~ ^lp_[0-9A-Za-z]{8,40}$ ]] || die "LP_KEY must look like lp_..."

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
passed=0
failed=0
expect() { # expect DESCRIPTION EXPECTED ACTUAL
  if [[ $3 == "$2" ]]; then
    printf 'PASS  %s\n' "$1"
    passed=$((passed + 1))
  else
    printf 'FAIL  %s: expected [%s], got [%s]\n' "$1" "$2" "$3"
    failed=$((failed + 1))
  fi
}
contains() { # contains DESCRIPTION NEEDLE HAYSTACK
  if [[ $3 == *"$2"* ]]; then expect "$1" yes yes; else expect "$1" "contains $2" "${3:0:300}"; fi
}
ask() { as_app podman exec caddy wget -q -S -O /dev/null "http://internal:9000/caddy/ask?domain=$1" 2>&1 | awk '/HTTP\//{print $2; exit}'; }
psql_q() { as_app podman exec -i -u postgres postgres psql -X -At -d ebooktrivia -c "$1" 2>/dev/null; }

# 1. The served set, the ask and the link agree.
served=$(psql_q "SELECT landing_page_id || '/' || version FROM public.lp_served_hosts() WHERE host = '$HOST'")
expect "$HOST is served (an active zip page with a live version)" yes "$([[ -n $served ]] && printf yes || printf no)"
lp_key=$(psql_q "SELECT lp.lp_key FROM public.lp_domains d JOIN public.landing_pages lp ON lp.id = d.landing_page_id WHERE d.host = '$HOST'")
expect "$HOST belongs to $LP_KEY" "$LP_KEY" "$lp_key"
expect "the ask approves $HOST" 200 "$(ask "$HOST")"
expect "current links to the live version" "../../versions/$served" "$(as_app readlink "/srv/lp/hosts/$HOST/current" 2>/dev/null)"
expect "current is a symlink" yes "$(as_app test -L "/srv/lp/hosts/$HOST/current" && printf yes || printf no)"

# 2. A publicly trusted certificate for exactly this name (curl verifies the chain and the name).
code=""
for _ in $(seq 1 12); do
  code=$(curl -sS --max-time 20 -o "$work/index.html" -D "$work/headers" -w '%{http_code}' "https://$HOST/" 2>"$work/curl.err") && break
  sleep 10
done
expect "https://$HOST/ answers 200 over verified TLS" 200 "$code"
san=$(openssl s_client -connect "$HOST:443" -servername "$HOST" </dev/null 2>/dev/null | openssl x509 -noout -ext subjectAltName 2>/dev/null | tr -d ' \n')
contains "the certificate names $HOST" "DNS:$HOST" "$san"
issuer=$(openssl s_client -connect "$HOST:443" -servername "$HOST" </dev/null 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null)
printf 'INFO  issuer: %s\n' "$issuer"

# 3. The page: the injected SDK tag, the fixed type and the LP headers.
body=$(cat "$work/index.html" 2>/dev/null)
contains "index.html carries the SDK tag of $LP_KEY" "<script src=\"https://api.$DOMAIN/sdk/v1.js\" data-lp=\"$LP_KEY\" async></script></head>" "$body"
headers=$(tr -d '\r' <"$work/headers" 2>/dev/null | tr '[:upper:]' '[:lower:]')
contains "Content-Type text/html; charset=utf-8" "content-type: text/html; charset=utf-8" "$headers"
contains "nosniff" "x-content-type-options: nosniff" "$headers"
contains "HSTS" "strict-transport-security: max-age=31536000" "$headers"
contains "the default page CSP" "content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://api.$DOMAIN" "$headers"
expect "a path off the allowlist is a 404" 404 "$(curl -s -o /dev/null --max-time 20 -w '%{http_code}' "https://$HOST/x.php")"
expect "http:// redirects to https" "308 https://$HOST/" "$(curl -s -o /dev/null --max-time 20 -w '%{http_code} %{redirect_url}' "http://$HOST/")"

# 4. Host isolation: the LP's files are not served on the app hosts.
for app in play order api admin; do
  page=$(curl -s --max-time 20 "https://$app.$DOMAIN/index.html" 2>/dev/null)
  expect "$app.$DOMAIN does not serve the LP" no "$([[ $page == *"data-lp=\"$LP_KEY\""* ]] && printf yes || printf no)"
done

# 5. A name that is not registered gets no certificate.
if [[ -n $OTHER ]]; then
  expect "the ask refuses $OTHER" 404 "$(ask "$OTHER")"
  curl -s -o /dev/null --max-time 30 "https://$OTHER/" 2>/dev/null
  rc=$?
  expect "no certificate for $OTHER (TLS fails)" yes "$([[ $rc -eq 35 || $rc -eq 60 || $rc -eq 51 ]] && printf yes || printf 'no (curl exit %s)' "$rc")"
fi

printf 'summary: %d passed, %d failed\n' "$passed" "$failed"
((failed == 0))

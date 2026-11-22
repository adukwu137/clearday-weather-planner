#!/usr/bin/env bash
# Checks a ClearDay deployment and prints output you can paste into the README.
# Run it from your own computer (Git Bash, WSL, macOS or Linux):
#   bash deploy/verify-deployment.sh
# Override any address with an environment variable, for example:
#   LB_URL=http://127.0.0.1:3400 SITE_URL=http://127.0.0.1:3400 bash deploy/verify-deployment.sh
set -u

WEB01_URL="${WEB01_URL:-http://18.171.204.227}"
WEB02_URL="${WEB02_URL:-http://18.171.160.168}"
LB_URL="${LB_URL:-http://3.10.24.245}"
SITE_URL="${SITE_URL:-https://www.adukwu137.tech}"
BARE_HOST="${BARE_HOST:-adukwu137.tech}"

failures=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; failures=$((failures + 1)); }
section() { printf '\n== %s ==\n' "$1"; }

server_name() { sed -n 's/.*"server":"\([^"]*\)".*/\1/p'; }

check_health() {
  local label="$1" url="$2" body
  echo "\$ curl $url/api/health"
  body="$(curl -fsS --max-time 10 "$url/api/health" 2>&1)"
  echo "$body"
  if echo "$body" | grep -q '"status":"ok"'; then
    pass "$label answers with ClearDay's health JSON (server: $(echo "$body" | server_name))"
  else
    fail "$label did not answer with ClearDay's health JSON (an old placeholder page, or the app is not running)"
  fi
}

check_home() {
  local label="$1" url="$2"
  if curl -fsS --max-time 10 "$url/" | grep -q "ClearDay"; then
    pass "$label serves the ClearDay page"
  else
    fail "$label does not serve the ClearDay page"
  fi
}

section "1. Each web server directly"
check_health "web-01" "$WEB01_URL"
check_health "web-02" "$WEB02_URL"
check_home "web-01" "$WEB01_URL"
check_home "web-02" "$WEB02_URL"

section "2. Load balancer: health and alternating X-Served-By"
check_health "load balancer" "$LB_URL"
echo "\$ for i in 1 2 3 4 5 6; do curl -sI $LB_URL/ | grep -i x-served-by; done"
names=()
for _ in 1 2 3 4 5 6; do
  line="$(curl -sI --max-time 10 "$LB_URL/" | tr -d '\r' | grep -i '^x-served-by' | head -n 1)"
  echo "${line:-"(no X-Served-By header)"}"
  names+=("$(echo "$line" | cut -d' ' -f2-)")
done
distinct="$(printf '%s\n' "${names[@]}" | sort -u | grep -c .)"
alternating=1
for i in 1 2 3 4 5; do [ "${names[$i]}" = "${names[$((i - 1))]}" ] && alternating=0; done
if [ "$distinct" -eq 2 ] && [ "$alternating" -eq 1 ]; then
  pass "requests alternate between two servers"
else
  fail "requests do not alternate between exactly two servers"
fi
check_home "load balancer" "$LB_URL"

section "3. Public address and HTTPS"
echo "\$ curl -sI $SITE_URL/ | grep -i x-served-by"
curl -sI --max-time 10 "$SITE_URL/" | tr -d '\r' | grep -i '^x-served-by' || true
check_home "$SITE_URL" "$SITE_URL"
case "$SITE_URL" in
  https://*)
    host="${SITE_URL#https://}"
    code_loc="$(curl -sI --max-time 10 "http://$host/" | tr -d '\r' | awk 'NR==1{c=$2} tolower($1)=="location:"{l=$2} END{print c, l}')"
    echo "\$ curl -sI http://$host/   ->   $code_loc"
    case "$code_loc" in
      30[1278]\ https://*) pass "http://$host redirects to HTTPS" ;;
      *) fail "http://$host does not redirect to HTTPS" ;;
    esac
    for scheme in http https; do
      result="$(curl -sL --max-time 15 -o /dev/null -w '%{http_code} %{url_effective}' "$scheme://$BARE_HOST/" 2>&1)"
      echo "\$ curl -L $scheme://$BARE_HOST/   ->   $result"
      case "$result" in
        200\ "$SITE_URL"*) pass "$scheme://$BARE_HOST ends at $SITE_URL" ;;
        *) fail "$scheme://$BARE_HOST does not end at $SITE_URL" ;;
      esac
    done
    ;;
  *) echo "(SITE_URL is not https, skipping the HTTPS and bare-domain checks)" ;;
esac

section "Result"
if [ "$failures" -eq 0 ]; then
  echo "All checks passed. Paste the output above into the README evidence section."
else
  echo "$failures check(s) failed. Fix them before submitting."
  exit 1
fi

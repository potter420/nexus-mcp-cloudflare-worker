#!/usr/bin/env bash
# End-to-end auth test: fake Access issuer + wrangler dev.
# Asserts: no token / forged / wrong-aud / wrong-email -> 403, good -> 200 (6 tools), bad path -> 404.
# Exit 0 = PASS. Does not read or modify .dev.vars (uses its own --env-file).
set -uo pipefail
cd "$(dirname "$0")/.."

ISSUER_PORT=8788
DEV_PORT=8787
AUD="test-aud-$(date +%s)"
EMAIL="owner@example.com"
# wrangler dev rewrites Host to the route pattern, so MCP_HOSTNAME must match it.
HOST=$(node -e 'const s=require("fs").readFileSync("wrangler.jsonc","utf8");const m=s.match(/"pattern"\s*:\s*"([^"]+)"/);process.stdout.write(m?m[1]:"")')
[ -n "$HOST" ] || { echo "FAIL: no routes[0].pattern in wrangler.jsonc"; exit 1; }

TMP=$(mktemp -d)
ISSUER_PGID=""
DEV_PGID=""
cleanup() {
  for pg in "$DEV_PGID" "$ISSUER_PGID"; do
    [ -n "$pg" ] && kill -TERM -- "-$pg" 2>/dev/null
  done
  sleep 0.5
  for pg in "$DEV_PGID" "$ISSUER_PGID"; do
    [ -n "$pg" ] && kill -KILL -- "-$pg" 2>/dev/null
  done
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in $ISSUER_PORT $DEV_PORT; do
  if port_busy "$p"; then echo "FAIL: port $p already in use (leftover wrangler/workerd?)"; exit 1; fi
done

# 1. Fake issuer (own process group so we can kill everything it spawns).
setsid env PORT=$ISSUER_PORT OUT_DIR="$TMP" AUD="$AUD" EMAIL="$EMAIL" \
  node test/fake-access.mjs >"$TMP/issuer.log" 2>&1 &
ISSUER_PGID=$!
for _ in $(seq 1 50); do [ -f "$TMP/ready" ] && break; sleep 0.1; done
[ -f "$TMP/ready" ] || { echo "FAIL: issuer did not start"; cat "$TMP/issuer.log"; exit 1; }

# 2. wrangler dev with test-only vars.
cat >"$TMP/test.env" <<EOF
NEXUS_API_KEY=test-not-a-real-key
MCP_HOSTNAME=$HOST
ACCESS_TEAM_DOMAIN=http://127.0.0.1:$ISSUER_PORT
ACCESS_AUD=$AUD
ALLOWED_EMAILS=$EMAIL
EOF
setsid ./node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port $DEV_PORT \
  --env-file "$TMP/test.env" >"$TMP/dev.log" 2>&1 &
DEV_PGID=$!

URL="http://127.0.0.1:$DEV_PORT"
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$URL/" || true)
  [ "$code" != "000" ] && break
  sleep 0.5
done
[ "$code" != "000" ] || { echo "FAIL: wrangler dev did not start"; tail -30 "$TMP/dev.log"; exit 1; }

BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
call() { # $1 path, $2 token name ("" = none), $3 output file
  local auth=()
  [ -n "$2" ] && auth=(-H "cf-access-jwt-assertion: $(cat "$TMP/$2.jwt")")
  curl -s -o "$3" -w '%{http_code}' --max-time 10 -X POST "$URL$1" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H 'mcp-protocol-version: 2025-06-18' \
    "${auth[@]}" -d "$BODY"
}

fails=0
expect() { # $1 label, $2 expected, $3 actual
  if [ "$2" = "$3" ]; then echo "ok   $1 -> $3"; else echo "FAIL $1 -> $3 (want $2)"; fails=$((fails+1)); fi
}

expect "no token"    403 "$(call /mcp ""          "$TMP/r1")"
expect "forged"      403 "$(call /mcp forged      "$TMP/r2")"
expect "wrong aud"   403 "$(call /mcp wrong-aud   "$TMP/r3")"
expect "wrong email" 403 "$(call /mcp wrong-email "$TMP/r4")"
expect "good"        200 "$(call /mcp good        "$TMP/r5")"
expect "bad path"    404 "$(call /mcp/x good      "$TMP/r6")"

# Response may be JSON or SSE; pull the JSON-RPC payload out either way.
tools=$(node -e '
  const s=require("fs").readFileSync(process.argv[1],"utf8");
  const line=s.split("\n").find(l=>l.startsWith("data:"));
  try{const j=JSON.parse(line?line.slice(5):s);console.log((j.result?.tools??[]).length)}catch{console.log(0)}
' "$TMP/r5")
expect "tools/list count" 6 "$tools"

if [ $fails -ne 0 ]; then
  echo "--- good response:"; head -c 1000 "$TMP/r5"; echo
  echo "--- dev.log (tail):"; tail -30 "$TMP/dev.log"
  echo "FAIL ($fails)"; exit 1
fi
echo "PASS"

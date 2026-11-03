#!/usr/bin/env bash
# Meridian x402 walkthrough with curl.
#   1. Free demo (no wallet)            -> 200 JSON card
#   2. Unpaid call to a paid route      -> 402 + PAYMENT-REQUIRED header (decoded here)
#   3. Paid call (opt-in, MERIDIAN_PAY=1) -> curl cannot sign, so ../js/payment-header.mjs
#      (built on the official @x402 client, with the payTo/network/asset/cap/origin pins) signs
#      the payment into a private 0600 temp file and curl sends it with -H @file.
#
# Usage: ./meridian.sh [demo|unpaid|pay|all]   (default: demo + unpaid; never pays)
set -euo pipefail
MERIDIAN_ORIGIN="https://meridian.miodiollc.com"
BASE="${MERIDIAN_BASE_URL:-$MERIDIAN_ORIGIN}"; BASE="${BASE%/}"
PAID_PATH="${MERIDIAN_PAID_PATH:-/v1/risk/0x0000000000000000000000000000000000000001?chain=base}"
HERE="$(cd "$(dirname "$0")" && pwd)"
die() { echo "error: $*" >&2; exit 1; }

# Origin check: only Meridian, unless MERIDIAN_ALLOW_OTHER_ORIGIN=1 (local test server). Never user-info.
if [ "$BASE" != "$MERIDIAN_ORIGIN" ]; then
  [ "${MERIDIAN_ALLOW_OTHER_ORIGIN:-0}" = "1" ] || die "refusing origin $BASE: only $MERIDIAN_ORIGIN is allowed (set MERIDIAN_ALLOW_OTHER_ORIGIN=1 for a local test server)"
  [[ "$BASE" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "MERIDIAN_BASE_URL must be a bare origin like https://host[:port] (no user-info or path)"
  # https only; plain http is allowed only for a loopback test server.
  [[ "$BASE" =~ ^https:// || "$BASE" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$ ]] \
    || die "refusing $BASE: the base URL must be https (plain http is allowed only for a loopback test server)"
fi
[[ "$PAID_PATH" =~ ^/[A-Za-z0-9._~/?=\&%:+,-]*$ && "$PAID_PATH" != //* ]] \
  || die "MERIDIAN_PAID_PATH must be a plain path starting with a single / (no @, backslash or spaces)"

TMP="$(mktemp -d)"; chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

demo() {
  echo "== 1. Free demos (no payment)"
  for d in risk sanctions vault drift simulate; do
    code=$(curl -sS --proto =https,http -o "$TMP/demo.json" -w '%{http_code}' "$BASE/v1/demo/$d")
    echo "GET /v1/demo/$d -> HTTP $code"
    python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));c=d.get("card",{});print("   card:",c.get("card",c.get("product")),"| status:",c.get("status","-"),"| result:",c.get("verdict",c.get("result",c.get("match","-"))))' "$TMP/demo.json"
  done
}

unpaid() {
  echo "== 2. Unpaid call to a paid route: GET $PAID_PATH"
  code=$(curl -sS -D "$TMP/unpaid.hdr" -o /dev/null -w '%{http_code}' "$BASE$PAID_PATH")
  echo "HTTP $code (expected 402)"
  req=$(awk -F': ' 'tolower($1)=="payment-required"{print $2}' "$TMP/unpaid.hdr" | tr -d '\r')
  [ -n "$req" ] || { echo "no PAYMENT-REQUIRED header"; return 1; }
  echo "Decoded PAYMENT-REQUIRED accepts:"
  echo "$req" | base64 -d | python3 -c 'import json,sys;d=json.load(sys.stdin);[print("  ",a["scheme"],a["network"],"amount",a["amount"],"(USDC atomic, 6 decimals = $%s)"%(int(a["amount"])/1e6),"asset",a["asset"],"payTo",a["payTo"]) for a in d["accepts"]]'
}

# Print the paid response with the bearer receipt id (rcpt_ + 32 hex) redacted: by key (id,
# receipt_id, receipt-id, receiptId, receipt, rid, ref), by value (also URL-encoded) and inside
# links (/receipt/<id>, /receipts/<id>, ?id=<id>). Only a short allowlist of headers is printed;
# the others are listed by name only, since any header could carry the id.
show_redacted() {
  python3 - "$1" "$2" <<'PY'
import base64, json, re, sys
from urllib.parse import unquote
ID_KEY = re.compile(r"(?i)(id|rid|ref|receipts?|receipt[_-]?id|receiptid)")
RCPT = re.compile(r"(?i)rcpt(?:_|%5f)[0-9a-f]{32}")
LINK_ID = re.compile(r"(?i)((?:/|%2f)receipts?(?:/|%2f))[^\s\"'?#&/%]+")
QUERY_ID = re.compile(r"(?i)((?:[?&;]|%3f|%26)(?:id|rid|ref|receipt|receipt[_-]?id|receiptid)(?:=|%3d))[^\s\"'&#%]+")
HIDDEN = "<redacted: bearer receipt id>"
def redact_text(text):
    s = QUERY_ID.sub(r"\1<redacted>", LINK_ID.sub(r"\1<redacted>", RCPT.sub("rcpt_<redacted>", str(text))))
    d = s
    for _ in range(3):
        d = unquote(d)
        if re.search(r"(?i)rcpt_[0-9a-f]{32}", d):
            return "<redacted: text containing a bearer receipt id>"
    return s
def redact(v):
    if isinstance(v, list): return [redact(x) for x in v]
    if isinstance(v, dict): return {k: (HIDDEN if ID_KEY.fullmatch(str(k)) and isinstance(x, (str, int, float)) else redact(x)) for k, x in v.items()}
    if isinstance(v, str): return redact_text(v)
    return v
def say(*parts): print(redact_text(" ".join(parts)))
SHOW = {"content-type", "content-length", "date", "meridian-receipt-status"}
hidden = []
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    line = line.rstrip("\r\n")
    if not line: continue
    if line.startswith("HTTP/"): say(line); continue
    name, _, value = line.partition(":"); value = value.strip(); key = name.strip().lower()
    if key in ("payment-response", "meridian-receipt"):
        try: say(f"{name} (decoded, id redacted): {json.dumps(redact(json.loads(base64.b64decode(value))))}")
        except Exception: say(f"{name}: <not decodable, not shown>")
    elif key in SHOW: say(f"{name}: {value}")
    else: hidden.append(name.strip())
if hidden: say(f"({len(hidden)} other response headers not shown: {', '.join(hidden)})")
body = open(sys.argv[2], encoding="utf-8", errors="replace").read()
try: say(json.dumps(redact(json.loads(body)), indent=2))
except ValueError: say(redact(body))
PY
}

pay() {
  echo "== 3. Paid call"
  if [ "${MERIDIAN_PAY:-0}" != "1" ] || [ -z "${EVM_PRIVATE_KEY:-}" ]; then
    echo "Skipped. Set MERIDIAN_PAY=1 and EVM_PRIVATE_KEY (dedicated low-balance wallet) to pay for real."
    return 0
  fi
  local sigfile="$TMP/payment.hdr"   # must not exist yet: payment-header.mjs creates it 0600
  # Fetches the 402, enforces the pins and cap, signs, creates $sigfile (0600, O_EXCL|O_NOFOLLOW)
  # and prints only the checked URL.
  url=$(node "$HERE/../js/payment-header.mjs" "$PAID_PATH" "$sigfile")
  curl -sS --proto =https,http -D "$TMP/paid.hdr" -o "$TMP/paid.body" -H @"$sigfile" "$url"
  rm -f "$sigfile"
  show_redacted "$TMP/paid.hdr" "$TMP/paid.body"
}

case "${1:-default}" in
  demo) demo ;;
  unpaid) unpaid ;;
  pay) pay ;;
  all) demo; unpaid; pay ;;
  default) demo; unpaid ;;
  *) echo "usage: $0 [demo|unpaid|pay|all]"; exit 1 ;;
esac

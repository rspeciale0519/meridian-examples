#!/usr/bin/env bash
# Print every paid route and every payment option it accepts, from the live discovery document.
# Free, no payment.
set -euo pipefail
BASE="https://meridian.miodiollc.com"
curl -sS "$BASE/.well-known/x402" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("Meridian", d.get("version", ""))
for r in d["resources"]:
    for a in r["accepts"]:
        usd = int(a["amount"]) / 1e6
        print("%-5s %-34s %-6s $%-6g USDC (%s atomic) on %s asset %s payTo %s" % (
            r["method"], r["path"], a["scheme"], usd, a["amount"], a["network"], a["asset"], a["payTo"]))
'

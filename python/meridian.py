"""Meridian x402 walkthrough in Python (3.10+).

  1. Free demo (no wallet)              -> 200 JSON card
  2. Unpaid call to a paid route        -> 402 + PAYMENT-REQUIRED header
  3. Paid call (opt-in, MERIDIAN_PAY=1) -> the official x402 client signs a USDC payment and retries

Usage: python meridian.py [demo|unpaid|pay|all]   (default: demo + unpaid; never pays)

The wallet key is read from the EVM_PRIVATE_KEY environment variable. Never hardcode a key.

Nothing here trusts the 402 response. Before anything is signed, the client checks:
  - origin:  requests go only to https://meridian.miodiollc.com (no user-info, no redirects)
  - network: eip155:8453 (Base) only, scheme "exact" only
  - asset:   Base USDC only
  - payTo:   Meridian's pinned pay-to address only
  - amount:  at most MERIDIAN_MAX_PER_CALL (US dollars, "$" prefix, hard maximum $0.10)
"""
import asyncio
import base64
import json
import os
import re
import stat
import sys
from urllib.parse import unquote

import httpx

MERIDIAN_ORIGIN = "https://meridian.miodiollc.com"
NETWORK = "eip155:8453"  # Base mainnet
USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
# Meridian's pay-to address, pinned here on purpose. Check it against /.well-known/x402 and /docs
# yourself before paying. A 402 that names any other address is refused.
MERIDIAN_PAY_TO = "0x4DA1ED782BD61BaE9AdD5a5CaBbCf32f767f8d7F"
DEFAULT_CAP = "$0.02"
HARD_MAX_ATOMIC = 100_000  # $0.10 in USDC atomic units (6 decimals)
PAID_PATH = os.getenv("MERIDIAN_PAID_PATH", "/v1/risk/0x0000000000000000000000000000000000000001?chain=base")
PATH_RE = re.compile(r"/(?!/)[A-Za-z0-9._~/?=&%:+,-]*\Z")  # used with fullmatch: no trailing newline


LOOPBACK = ("127.0.0.1", "localhost", "::1")


def base_origin() -> httpx.URL:
    """Only Meridian's origin, unless MERIDIAN_ALLOW_OTHER_ORIGIN=1 (for a local test server).

    The URL must be https (plain http only for a loopback test server), with no user-info,
    path or surrounding whitespace.
    """
    raw = os.getenv("MERIDIAN_BASE_URL") or MERIDIAN_ORIGIN
    if re.search(r"\s", raw):
        raise SystemExit("MERIDIAN_BASE_URL must not contain spaces or other whitespace")
    u = httpx.URL(raw)
    if u.userinfo:
        raise SystemExit("MERIDIAN_BASE_URL must not contain user-info")
    if u.scheme not in ("http", "https") or not u.host or u.raw_path not in (b"", b"/") or u.fragment:
        raise SystemExit("MERIDIAN_BASE_URL must be an origin only, like https://meridian.miodiollc.com")
    origin = httpx.URL(scheme=u.scheme, host=u.host, port=u.port)
    origin_text = str(origin).rstrip("/")
    pinned = httpx.URL(MERIDIAN_ORIGIN)
    same = (origin.scheme, origin.host, origin.port) == (pinned.scheme, pinned.host, pinned.port)
    if not same and os.getenv("MERIDIAN_ALLOW_OTHER_ORIGIN") != "1":
        raise SystemExit(f"Refusing origin {origin_text}: only {MERIDIAN_ORIGIN} is allowed "
                         "(set MERIDIAN_ALLOW_OTHER_ORIGIN=1 for a local test server)")
    if origin.scheme != "https" and origin.host not in LOOPBACK:
        raise SystemExit(f"Refusing {origin_text}: the base URL must be https "
                         "(plain http is allowed only for a loopback test server)")
    return origin


def resolve_url(path: str) -> str:
    """Full URL for a path like /v1/risk/0x...?chain=base, proven to stay on the allowed origin."""
    if not isinstance(path, str) or not PATH_RE.fullmatch(path):
        raise SystemExit("MERIDIAN_PAID_PATH must be a plain path starting with a single / (no @, backslash or spaces)")
    origin = base_origin()
    u = httpx.URL(str(origin).rstrip("/") + path)
    if u.userinfo or (u.scheme, u.host, u.port) != (origin.scheme, origin.host, origin.port):
        raise SystemExit("Resolved URL left the allowed origin")
    return str(u)


def parse_cap(raw: str | None = None) -> tuple[str, int]:
    """MERIDIAN_MAX_PER_CALL is US dollars with a $ prefix (e.g. '$0.02'). Bare numbers are rejected."""
    raw = os.getenv("MERIDIAN_MAX_PER_CALL") if raw is None else raw
    usd = raw or DEFAULT_CAP
    m = re.fullmatch(r"\$(\d{1,3})(?:\.(\d{1,6}))?", usd)
    if not m:
        raise SystemExit(f"MERIDIAN_MAX_PER_CALL must be US dollars with a $ prefix, like '$0.02' (got {usd!r})")
    atomic = int(m.group(1)) * 1_000_000 + int((m.group(2) or "").ljust(6, "0"))
    if not 0 < atomic <= HARD_MAX_ATOMIC:
        raise SystemExit(f"MERIDIAN_MAX_PER_CALL must be more than $0 and at most $0.10 (got {usd})")
    return usd, atomic


def meridian_policy(cap_atomic: int):
    """Keep only 402 entries that match the pins and the cap. Everything else is dropped before signing."""
    def eq(a, b):
        return isinstance(a, str) and a.lower() == b.lower()

    def ok(r) -> bool:
        amount = str(getattr(r, "amount", ""))
        return (getattr(r, "scheme", None) == "exact" and getattr(r, "network", None) == NETWORK
                and eq(getattr(r, "asset", None), USDC_BASE) and eq(getattr(r, "pay_to", None), MERIDIAN_PAY_TO)
                and re.fullmatch(r"[0-9]{1,18}", amount) is not None and 0 < int(amount) <= cap_atomic)

    return lambda _version, reqs: [r for r in reqs if ok(r)]


# The receipt id (rcpt_ + 32 hex) is a bearer secret: anyone holding it can read the receipt.
# Redact it by key (id, receipt_id, receipt-id, receiptId, receipt, rid, ref), by value (the
# rcpt_ pattern, also URL-encoded), and inside links (/receipt/<id>, /receipts/<id>, ?id=<id>).
# redact_text() runs again over every printed line as a last line of defense.
ID_KEY = re.compile(r"(?i)(id|rid|ref|receipts?|receipt[_-]?id|receiptid)")
RCPT = re.compile(r"(?i)rcpt(?:_|%5f)[0-9a-f]{32}")
LINK_ID = re.compile(r"(?i)((?:/|%2f)receipts?(?:/|%2f))[^\s\"'?#&/%]+")
QUERY_ID = re.compile(r"(?i)((?:[?&;]|%3f|%26)(?:id|rid|ref|receipt|receipt[_-]?id|receiptid)(?:=|%3d))[^\s\"'&#%]+")
HIDDEN = "<redacted: bearer receipt id>"


def redact_text(text) -> str:
    s = RCPT.sub("rcpt_<redacted>", str(text))
    s = QUERY_ID.sub(r"\1<redacted>", LINK_ID.sub(r"\1<redacted>", s))
    d = s  # if a receipt id still shows up after URL-decoding (e.g. double-encoded), hide it all
    for _ in range(3):
        d = unquote(d)
        if re.search(r"(?i)rcpt_[0-9a-f]{32}", d):
            return "<redacted: text containing a bearer receipt id>"
    return s


def redact(value):
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, dict):
        return {k: (HIDDEN if ID_KEY.fullmatch(str(k)) and isinstance(value[k], (str, int, float)) else redact(v))
                for k, v in value.items()}
    if isinstance(value, str):
        return redact_text(value)
    return value


def say(*parts) -> None:
    """print() with every line passed through redact_text."""
    print(redact_text(" ".join(p if isinstance(p, str) else json.dumps(p) for p in parts)))


def b64json(header: str):
    """Decode a base64 JSON header; None if it isn't valid JSON."""
    try:
        return json.loads(base64.b64decode(header))
    except ValueError:
        return None


async def demo() -> None:
    say("== 1. Free demos (no payment)")
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as http:
        for d in ["risk", "sanctions", "vault", "drift", "simulate"]:
            r = await http.get(resolve_url(f"/v1/demo/{d}"))
            card = r.json().get("card", {})
            result = card.get("verdict", card.get("result", card.get("match", "-")))
            say(f"GET /v1/demo/{d} -> HTTP {r.status_code} | card: {card.get('card', card.get('product'))}"
                  f" | status: {card.get('status', '-')} | result: {result}")


async def unpaid() -> None:
    say(f"== 2. Unpaid call to a paid route: GET {PAID_PATH}")
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as http:
        r = await http.get(resolve_url(PAID_PATH))
    say(f"HTTP {r.status_code} (expected 402)")
    header = r.headers.get("payment-required")
    if not header:
        raise SystemExit("no PAYMENT-REQUIRED header")
    required = json.loads(base64.b64decode(header))
    for a in required["accepts"]:
        say(f"   {a['scheme']} {a['network']} amount {a['amount']} (${int(a['amount']) / 1e6:g} USDC)"
              f" asset {a['asset']} payTo {a['payTo']}")


def make_client(key: str):
    from eth_account import Account
    from x402 import x402Client
    from x402.mechanisms.evm import EthAccountSigner
    from x402.mechanisms.evm.exact.register import register_exact_evm_client

    cap_usd, cap_atomic = parse_cap()
    client = x402Client()
    # Register Base only (the default registers every EVM network).
    register_exact_evm_client(client, EthAccountSigner(Account.from_key(key)), networks=[NETWORK])
    client.register_policy(meridian_policy(cap_atomic))                   # our pins + cap in atomic units
    client.set_spend_controls({"max_amount_per_payment": cap_usd})        # library cap (USD)
    return client


async def pay() -> None:
    say("== 3. Paid call")
    key = os.getenv("EVM_PRIVATE_KEY")
    if os.getenv("MERIDIAN_PAY") != "1" or not key:
        say("Skipped. Set MERIDIAN_PAY=1 and EVM_PRIVATE_KEY (dedicated low-balance wallet) to pay for real.")
        return
    from x402.http.clients import x402HttpxClient

    url = resolve_url(PAID_PATH)  # origin check before any signing
    async with x402HttpxClient(make_client(key), timeout=60, follow_redirects=False) as http:
        r = await http.get(url)
    if r.is_redirect:
        raise SystemExit(f"Refusing redirect (HTTP {r.status_code}); redirects are never followed")
    say(f"HTTP {r.status_code}")
    if r.headers.get("payment-response"):
        settle = b64json(r.headers["payment-response"])
        say("PAYMENT-RESPONSE:", "<not decodable, not shown>" if settle is None else redact(settle))
    if r.headers.get("meridian-receipt"):
        receipt = b64json(r.headers["meridian-receipt"])
        say("Meridian-Receipt (id redacted):", "<not JSON, not shown>" if receipt is None else redact(receipt))
        # The full receipt (with its bearer id) is only written to a private file if you ask for it.
        out = os.getenv("MERIDIAN_RECEIPT_FILE")
        if out:
            text = (base64.b64decode(r.headers["meridian-receipt"]).decode("utf-8", "replace") if receipt is None
                    else json.dumps(receipt, indent=2))
            save_receipt(out, text)
            say(f"Full receipt saved (mode 0600) to {out}; verify it with /receipt-verify.ts")
    try:
        say(json.dumps(redact(r.json()), indent=2))
    except ValueError:
        say(redact(r.text))


def save_receipt(path: str, text: str) -> None:
    """Write with mode 0600, even if the file already exists. Never follows a symlink."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as f:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise SystemExit("MERIDIAN_RECEIPT_FILE must be a regular file")
        os.fchmod(fd, 0o600)
        f.write(text)


async def main() -> None:
    step = sys.argv[1] if len(sys.argv) > 1 else "default"
    plan = {"demo": [demo], "unpaid": [unpaid], "pay": [pay], "all": [demo, unpaid, pay], "default": [demo, unpaid]}
    if step not in plan:
        raise SystemExit(__doc__)
    try:
        for fn in plan[step]:
            await fn()
    except Exception as e:  # print a one-line error, never a traceback with local variables
        raise SystemExit(redact_text(f"error: {type(e).__name__}: {e}")) from None
    except SystemExit as e:
        raise SystemExit(redact_text(e.code) if isinstance(e.code, str) else e.code) from None


if __name__ == "__main__":
    asyncio.run(main())

// Shared x402 setup and safety checks for the JS and curl examples (official @x402 packages).
// The wallet key is read from the EVM_PRIVATE_KEY environment variable. Never hardcode a key.
//
// Nothing here trusts the 402 response. Before anything is signed, the client checks:
//   - origin:  requests go only to https://meridian.miodiollc.com (no user-info, no redirects)
//   - network: eip155:8453 (Base) only, scheme "exact" only
//   - asset:   Base USDC only
//   - payTo:   Meridian's pinned pay-to address only
//   - amount:  at most MERIDIAN_MAX_PER_CALL (US dollars, "$" prefix, hard maximum $0.10)
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

export const MERIDIAN_ORIGIN = "https://meridian.miodiollc.com";
export const NETWORK = "eip155:8453"; // Base mainnet
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Meridian's pay-to address, pinned here on purpose. Check it against /.well-known/x402 and /docs
// yourself before paying. A 402 that names any other address is refused.
export const MERIDIAN_PAY_TO = "0x4DA1ED782BD61BaE9AdD5a5CaBbCf32f767f8d7F";
export const DEFAULT_CAP = "$0.02";
export const HARD_MAX_ATOMIC = 100_000n; // $0.10 in USDC atomic units (6 decimals)

// Origin to call. Only Meridian's origin is allowed unless MERIDIAN_ALLOW_OTHER_ORIGIN=1
// (for a local test server). User-info (user:pass@host), paths and surrounding whitespace are
// always rejected, and the URL must be https (plain http only for a loopback test server).
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
export function baseOrigin() {
  const raw = process.env.MERIDIAN_BASE_URL || MERIDIAN_ORIGIN;
  if (/\s/.test(raw)) throw new Error("MERIDIAN_BASE_URL must not contain spaces or other whitespace");
  if (!/^https?:\/\/[^/?#\\]/i.test(raw)) throw new Error("MERIDIAN_BASE_URL must start with https:// (an origin only, like https://meridian.miodiollc.com)");
  let u;
  try { u = new URL(raw); } catch { throw new Error("MERIDIAN_BASE_URL is not a valid URL"); }
  if (u.username || u.password) throw new Error("MERIDIAN_BASE_URL must not contain user-info");
  if (u.pathname !== "/" || u.search || u.hash) throw new Error("MERIDIAN_BASE_URL must be an origin only, like https://meridian.miodiollc.com");
  if (u.origin !== MERIDIAN_ORIGIN && process.env.MERIDIAN_ALLOW_OTHER_ORIGIN !== "1") {
    throw new Error(`Refusing origin ${u.origin}: only ${MERIDIAN_ORIGIN} is allowed (set MERIDIAN_ALLOW_OTHER_ORIGIN=1 for a local test server)`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new Error(`Refusing ${u.origin}: the base URL must be https (plain http is allowed only for a loopback test server)`);
  }
  return u.origin;
}

// Build a full URL from a path such as /v1/risk/0x...?chain=base and prove it stays on the origin.
export function resolveUrl(path) {
  if (typeof path !== "string" || !/^\/(?!\/)[A-Za-z0-9._~\/?=&%:+,-]*$/.test(path)) {
    throw new Error("MERIDIAN_PAID_PATH must be a plain path starting with a single / (no @, backslash or spaces)");
  }
  const origin = baseOrigin();
  const u = new URL(origin + path);
  if (u.origin !== origin || u.username || u.password) throw new Error("Resolved URL left the allowed origin");
  return u.href;
}

// fetch that never follows redirects, so a payment can't be replayed to another host.
export const fetchNoRedirect = (input, init = {}) => fetch(input, { ...init, redirect: "error" });

// MERIDIAN_MAX_PER_CALL is US dollars and must start with "$" (e.g. '$0.02'). A bare number
// like 20000 is rejected so atomic units can't be mistaken for dollars.
export function parseCap(raw = process.env.MERIDIAN_MAX_PER_CALL) {
  const usd = raw === undefined || raw === "" ? DEFAULT_CAP : raw;
  const m = /^\$(\d{1,3})(?:\.(\d{1,6}))?$/.exec(usd);
  if (!m) throw new Error(`MERIDIAN_MAX_PER_CALL must be US dollars with a $ prefix, like '$0.02' (got ${JSON.stringify(usd)})`);
  const atomic = BigInt(m[1]) * 1_000_000n + BigInt((m[2] || "").padEnd(6, "0"));
  if (atomic <= 0n || atomic > HARD_MAX_ATOMIC) throw new Error(`MERIDIAN_MAX_PER_CALL must be more than $0 and at most $0.10 (got ${usd})`);
  return { usd, atomic };
}

// Keep only 402 entries that match the pins and the cap. Everything else is dropped before signing.
export function meridianPolicy(capAtomic) {
  const eq = (a, b) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  return (_x402Version, reqs) => reqs.filter((r) =>
    r && r.scheme === "exact" && r.network === NETWORK &&
    eq(r.asset, USDC_BASE) && eq(r.payTo, MERIDIAN_PAY_TO) &&
    typeof r.amount === "string" && /^[0-9]{1,18}$/.test(r.amount) &&
    BigInt(r.amount) > 0n && BigInt(r.amount) <= capAtomic);
}

export function makeX402Client() {
  const key = process.env.EVM_PRIVATE_KEY;
  if (!key) throw new Error("Set EVM_PRIVATE_KEY (dedicated low-balance wallet with USDC on Base)");
  const cap = parseCap();
  const client = new x402Client();
  client.setSpendControls({ maxAmountPerPayment: cap.usd }); // library cap (USD)
  client.registerPolicy(meridianPolicy(cap.atomic));         // our pins + the same cap in atomic units
  client.register(NETWORK, new ExactEvmScheme(privateKeyToAccount(key)));
  return client;
}

// The receipt id (rcpt_ + 32 hex) is a bearer secret: anyone holding it can read the receipt.
// Redact it by key (id, receipt_id, receipt-id, receiptId, receipt, rid, ref), by value (the
// rcpt_ pattern, also URL-encoded), and inside links (/receipt/<id>, /receipts/<id>, ?id=<id>).
// redactText() runs again over every printed line as a last line of defense.
const ID_KEY = /^(id|rid|ref|receipts?|receipt[_-]?id|receiptid)$/i;
const RCPT = /rcpt(?:_|%5f)[0-9a-f]{32}/gi;
const LINK_ID = /((?:\/|%2f)receipts?(?:\/|%2f))[^\s"'?#&/%]+/gi;
const QUERY_ID = /((?:[?&;]|%3f|%26)(?:id|rid|ref|receipt|receipt[_-]?id|receiptid)(?:=|%3d))[^\s"'&#%]+/gi;
const HIDDEN = "<redacted: bearer receipt id>";

export function redactText(text) {
  let s = String(text).replace(RCPT, "rcpt_<redacted>").replace(LINK_ID, "$1<redacted>").replace(QUERY_ID, "$1<redacted>");
  // If a receipt id still shows up after URL-decoding (e.g. double-encoded), hide the whole string.
  let d = s;
  for (let i = 0; i < 3; i++) {
    try { d = decodeURIComponent(d); } catch { break; }
    if (/rcpt_[0-9a-f]{32}/i.test(d)) return "<redacted: text containing a bearer receipt id>";
  }
  return s;
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, ID_KEY.test(k) && (typeof v === "string" || typeof v === "number") ? HIDDEN : redact(v)]));
  }
  if (typeof value === "string") return redactText(value);
  return value;
}

// console.log with every line passed through redactText.
export function say(...parts) {
  console.log(redactText(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")));
}

export function errorLine(e) {
  return redactText(`error: ${e?.message ?? e}${e?.cause ? ` (${e.cause.message ?? e.cause})` : ""}`);
}

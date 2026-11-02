// Meridian x402 walkthrough in JavaScript (Node 20+).
//   1. Free demo (no wallet)              -> 200 JSON card
//   2. Unpaid call to a paid route        -> 402 + PAYMENT-REQUIRED header
//   3. Paid call (opt-in, MERIDIAN_PAY=1) -> @x402/fetch signs a USDC payment and retries
//
// Usage: node meridian.mjs [demo|unpaid|pay|all]   (default: demo + unpaid; never pays)
import { openSync, fstatSync, fchmodSync, writeSync, closeSync, constants as C } from "node:fs";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { resolveUrl, fetchNoRedirect, redact, say, errorLine } from "./x402-client.mjs";

const PAID_PATH = process.env.MERIDIAN_PAID_PATH || "/v1/risk/0x0000000000000000000000000000000000000001?chain=base";

async function demo() {
  say("== 1. Free demos (no payment)");
  for (const d of ["risk", "sanctions", "vault", "drift", "simulate"]) {
    const res = await fetchNoRedirect(resolveUrl(`/v1/demo/${d}`));
    const { card = {} } = await res.json();
    say(`GET /v1/demo/${d} -> HTTP ${res.status} | card: ${card.card ?? card.product} | status: ${card.status ?? "-"} | result: ${card.verdict ?? card.result ?? card.match ?? "-"}`);
  }
}

async function unpaid() {
  say(`== 2. Unpaid call to a paid route: GET ${PAID_PATH}`);
  const res = await fetchNoRedirect(resolveUrl(PAID_PATH));
  say(`HTTP ${res.status} (expected 402)`);
  const header = res.headers.get("payment-required");
  if (!header) throw new Error("no PAYMENT-REQUIRED header");
  const required = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  for (const a of required.accepts) {
    say(`   ${a.scheme} ${a.network} amount ${a.amount} ($${Number(a.amount) / 1e6} USDC) asset ${a.asset} payTo ${a.payTo}`);
  }
}

async function pay() {
  say("== 3. Paid call");
  if (process.env.MERIDIAN_PAY !== "1" || !process.env.EVM_PRIVATE_KEY) {
    say("Skipped. Set MERIDIAN_PAY=1 and EVM_PRIVATE_KEY (dedicated low-balance wallet) to pay for real.");
    return;
  }
  const { makeX402Client } = await import("./x402-client.mjs");
  const url = resolveUrl(PAID_PATH); // origin check before any signing
  const fetchWithPayment = wrapFetchWithPayment(fetchNoRedirect, makeX402Client());
  const res = await fetchWithPayment(url, { method: "GET" });
  say(`HTTP ${res.status}`);
  const settle = res.headers.get("payment-response");
  if (settle) {
    try { say("PAYMENT-RESPONSE:", redact(decodePaymentResponseHeader(settle))); }
    catch { say("PAYMENT-RESPONSE: <not decodable, not shown>"); }
  }
  const receipt = res.headers.get("meridian-receipt");
  if (receipt) {
    const text = Buffer.from(receipt, "base64").toString("utf8");
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    say("Meridian-Receipt (id redacted):", parsed === undefined ? "<not JSON, not shown>" : redact(parsed));
    // The full receipt (with its bearer id) is only written to a private file if you ask for it.
    if (process.env.MERIDIAN_RECEIPT_FILE) {
      saveReceipt(process.env.MERIDIAN_RECEIPT_FILE, parsed === undefined ? text : JSON.stringify(parsed, null, 2));
      say(`Full receipt saved (mode 0600) to ${process.env.MERIDIAN_RECEIPT_FILE}; verify it with /receipt-verify.ts`);
    }
  }
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = undefined; }
  say(json === undefined ? redact(body) : JSON.stringify(redact(json), null, 2));
}

// Write the receipt with mode 0600, even if the file already exists. Never follows a symlink.
function saveReceipt(file, text) {
  const fd = openSync(file, C.O_WRONLY | C.O_CREAT | C.O_TRUNC | C.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("MERIDIAN_RECEIPT_FILE must be a regular file");
    fchmodSync(fd, 0o600);
    writeSync(fd, text);
  } finally { closeSync(fd); }
}

const step = process.argv[2] || "default";
const plan = { demo: [demo], unpaid: [unpaid], pay: [pay], all: [demo, unpaid, pay], default: [demo, unpaid] }[step];
if (!plan) { console.error("usage: node meridian.mjs [demo|unpaid|pay|all]"); process.exit(1); }
try {
  for (const fn of plan) await fn();
} catch (e) {
  console.error(errorLine(e));
  process.exit(1);
}

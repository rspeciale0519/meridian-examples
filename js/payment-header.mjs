// Helper for curl/meridian.sh: fetch the 402 for a Meridian GET path, sign the payment with the
// official @x402 client (same pins and cap as the JS example), and write a curl header file
// ("PAYMENT-SIGNATURE: <base64>") to OUTFILE with mode 0600. The signed header is never printed.
// OUTFILE must not exist yet: it is created with O_CREAT|O_EXCL|O_NOFOLLOW, so an existing file,
// a symlink, stdout or a device is refused instead of overwritten or followed.
// stdout gets only the resolved URL, so curl sends the payment to the exact URL that was checked.
//
// Usage: MERIDIAN_PAY=1 EVM_PRIVATE_KEY=... node payment-header.mjs <path> <outfile>
import { openSync, lstatSync, fstatSync, fchmodSync, writeSync, closeSync, unlinkSync, constants as C } from "node:fs";
import { x402HTTPClient } from "@x402/fetch";
import { makeX402Client, resolveUrl, fetchNoRedirect, errorLine } from "./x402-client.mjs";

const [path, outfile] = process.argv.slice(2);
if (!path || !outfile) { console.error("usage: node payment-header.mjs <path> <outfile>"); process.exit(1); }
if (process.env.MERIDIAN_PAY !== "1") { console.error("Refusing to sign: set MERIDIAN_PAY=1 to allow a real payment."); process.exit(1); }

process.on("uncaughtException", (e) => { console.error(errorLine(e)); process.exit(1); });

const EXISTS = `OUTFILE ${outfile} already exists (or is a symlink, stdout or a device); give a new path in a private directory`;
try { lstatSync(outfile); console.error(`error: ${EXISTS}`); process.exit(1); } catch (e) { if (e.code !== "ENOENT") throw e; }

const url = resolveUrl(path);
const res = await fetchNoRedirect(url);
if (res.status !== 402) { console.error(`expected 402, got ${res.status}`); process.exit(1); }
const http = new x402HTTPClient(makeX402Client());
const required = http.getPaymentRequiredResponse((n) => res.headers.get(n), await res.json().catch(() => undefined));
const payload = await http.createPaymentPayload(required); // throws if the pins or cap reject every entry

let fd;
try {
  fd = openSync(outfile, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
} catch (e) {
  if (e.code === "EEXIST" || e.code === "ELOOP") { console.error(`error: ${EXISTS}`); process.exit(1); }
  throw e;
}
try {
  if (!fstatSync(fd).isFile()) throw new Error("OUTFILE must be a regular file");
  fchmodSync(fd, 0o600);
  for (const [name, value] of Object.entries(http.encodePaymentSignatureHeader(payload))) writeSync(fd, `${name}: ${value}\n`);
} catch (e) {
  closeSync(fd); fd = undefined; unlinkSync(outfile); throw e;
} finally { if (fd !== undefined) closeSync(fd); }
console.log(url);

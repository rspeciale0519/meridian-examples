# Meridian x402 examples

Meridian is a read-only, pay-per-call HTTP API from MioDio LLC. It returns twelve pre-sign checks built from public on-chain reads: Aave v3 risk cards, Lido stETH exit-risk, ERC-4626 vault risk, a deep passport that joins those reads, an OFAC SDN exact-match address screen, a passport-plus-sanctions bundle, an OFAC SDN batch screen (1 to 50 addresses), recipient readiness (including an address-poisoning / lookalike field), an x402 seller preflight, a Base USDC payment check, a signature decoder / parameter-drift check for unsigned transactions (intent optional), and a transaction simulation dry run. There are no API keys or accounts: each paid call costs a fraction of a dollar in USDC on Base, paid with the [x402](https://github.com/coinbase/x402) protocol (HTTP 402, x402 v2, `exact` scheme).

- Live API: <https://meridian.miodiollc.com>
- Docs: <https://meridian.miodiollc.com/docs>
- Terms: <https://meridian.miodiollc.com/terms>
- Machine-readable discovery: <https://meridian.miodiollc.com/.well-known/x402> · [/openapi.json](https://meridian.miodiollc.com/openapi.json) · [/llms.txt](https://meridian.miodiollc.com/llms.txt)

`https://workers.miodiollc.com` still works permanently with no redirect, so existing integrations do not need to change.

> Data only. Not financial, legal, investment, security or compliance advice. Reads are best-effort and point-in-time and can be stale or partial. Always verify on-chain. Meridian never holds your keys or signs your transactions, and never moves your funds.

## Use case: a pre-sign check

Run Meridian right before an agent or wallet signs something:

1. **Drift:** `POST /v1/drift` is a signature decoder / parameter-drift check (intent optional). With an intent (action, recipient or spender, token, amount, expected contract) it compares that intent against the exact unsigned transaction or EIP-712 payload you are about to sign and returns `match`, `drift` or `cannot_verify`, with a per-field diff. Without an intent it decodes Permit, Permit2, DAI, CoW, Seaport or EIP-7702 payloads and returns `risk_flags` (no `match`/`drift`/`cannot_verify` verdict). An unknown or unsupported EIP-712 `primaryType` returns `UNDECODED_CAUTION`. Unknown transaction calldata is `cannot_verify` when an intent is present; without an intent it is reported as undecoded (limits: `unknown_selector`). Never `match` in either mode.
2. **Simulate:** `POST /v1/simulate` dry-runs the unsigned transaction against the latest Base or Ethereum state and returns success or revert, gas, native and ERC-20 balance changes, approvals and warnings.
3. **Recipient:** `GET /v1/recipient/:address` reports recipient readiness for the address you are about to send to (code on Base vs Ethereum, EIP-7702 vs a known-wallet allowlist, USDC freeze flags on Base and Ethereum, USDT freeze on Ethereum only, OFAC exact match, burn/token flags, and an optional address-poisoning / lookalike field (only when you pass `counterparties` or `from`)).
4. **Preflight (optional):** `GET /v1/x402-preflight?url=` checks another x402 seller before you pay it.
5. **Counterparty:** `GET /v1/sanctions/:address` checks the recipient against public OFAC SDN digital-currency addresses, and `/v1/risk`, `/v1/vault` or `/v1/passport` read the Aave v3 position, ERC-4626 vault or Lido exit picture behind it.

A `match` or a clean simulation is not a guarantee that the action is safe. A sanctions "no match" does not mean an address is clean.

## Try it free (no wallet)

These demos use fixed public inputs and return real cards:

| Demo | Shows |
|---|---|
| [/v1/demo/risk](https://meridian.miodiollc.com/v1/demo/risk) | Aave v3 risk card |
| [/v1/demo/sanctions](https://meridian.miodiollc.com/v1/demo/sanctions) | OFAC SDN screen of a listed address (a match) |
| [/v1/demo/vault](https://meridian.miodiollc.com/v1/demo/vault) | ERC-4626 vault card |
| [/v1/demo/drift](https://meridian.miodiollc.com/v1/demo/drift) | A USDC transfer whose recipient was swapped (verdict `drift`) |
| [/v1/demo/simulate](https://meridian.miodiollc.com/v1/demo/simulate) | Dry run of a small sample ETH transfer on Base |

```bash
curl -s https://meridian.miodiollc.com/v1/demo/drift
```

## Paid endpoints and prices

Read from the live discovery document `GET /.well-known/x402` (Meridian v0.9.0) on Nov 4, 2026. Prices can change. The 402 response for each call is the source of truth, and `./curl/prices.sh` prints the current list.

| Endpoint | What it returns | Price (USDC on Base) | Atomic amount |
|---|---|---|---|
| `GET /v1/risk/:address` | Aave v3 risk card (health factor, collateral, debt) | $0.005 | 5000 |
| `GET /v1/lido/exit-risk` | Lido stETH exit-risk card (`?amount=` stETH, required) | $0.005 | 5000 |
| `GET /v1/vault/:address` | ERC-4626 vault risk card | $0.005 | 5000 |
| `GET /v1/passport/:address` | Deep passport (Aave v3 + Lido exit + optional vault) | $0.02 | 20000 |
| `GET /v1/sanctions/:address` | OFAC SDN exact-match screen | $0.005 | 5000 |
| `GET /v1/passport-sanctions/:address` | Deep passport + OFAC SDN screen | $0.02 | 20000 |
| `POST /v1/sanctions/batch` | OFAC SDN batch screen (1 to 50 addresses) | $0.10 | 100000 |
| `POST /v1/drift` | Signature decoder / parameter-drift check (intent optional) | $0.005 | 5000 |
| `POST /v1/simulate` | Transaction simulation (dry run) | $0.01 | 10000 |
| `POST /v1/payment-check` | Base USDC payment-check (on-chain read) | $0.005 | 5000 |
| `GET /v1/recipient/:address` | Recipient readiness | $0.005 | 5000 |
| `GET /v1/x402-preflight?url=` | x402 seller preflight | $0.005 | 5000 |

The atomic amount is in USDC base units (6 decimals, so 5000 = $0.005). It is not a dollar figure: never put it in `MERIDIAN_MAX_PER_CALL`, which takes dollars like `'$0.02'`.

Every paid route is paid on network `eip155:8453` (Base) in USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals). Meridian's pay-to address is `0x4DA1ED782BD61BaE9AdD5a5CaBbCf32f767f8d7F`. **Pin it in your client** and refuse any 402 that names a different pay-to, network or asset: a 402 is just a response header, so anyone who can answer the request (a proxy, a redirect target, a typo'd host) can ask for money. Check the address yourself against [/.well-known/x402](https://meridian.miodiollc.com/.well-known/x402) and [/docs](https://meridian.miodiollc.com/docs) before you pay. Request details for each route, including `?chain=base|ethereum` on the address cards and the JSON bodies for the POST routes, are in [/docs](https://meridian.miodiollc.com/docs) and [/openapi.json](https://meridian.miodiollc.com/openapi.json).

## How the payment works

1. Call a paid route with no payment. You get `HTTP 402` with a base64 JSON `PAYMENT-REQUIRED` header that lists the scheme, network, asset, amount and pay-to address.
2. Your client checks those terms against its pins and spend cap, then an x402 client signs a USDC transfer authorization (EIP-3009) for exactly that amount.
3. The client retries with a `PAYMENT-SIGNATURE` header. You get `200` with the JSON card, a `PAYMENT-RESPONSE` settlement header and, when settled, a signed `Meridian-Receipt` header.

The official clients (`@x402/fetch` and `@x402/evm` for JavaScript, `x402` for Python) handle steps 2 and 3 for you.

## Examples

Each example runs the same three steps: (1) call the free demos, (2) make an unpaid call to a paid route and decode the 402, and (3) pay for that call with an x402 client. **Step 3 only runs if you set `MERIDIAN_PAY=1` and `EVM_PRIVATE_KEY`.** By default no example signs or spends anything.

| Folder | Run | x402 client |
|---|---|---|
| `curl/` | `./curl/meridian.sh` (`all` to include paying) | curl can't sign, so step 3 uses `js/payment-header.mjs` to sign the payment into a private `0600` temp file and curl sends it with `-H @file` (install `js/` first) |
| `js/` | `cd js && npm ci --ignore-scripts && node meridian.mjs` (`all` to include paying) | [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch) + [`@x402/evm`](https://www.npmjs.com/package/@x402/evm) + viem, Node 20+ |
| `python/` | `cd python && pip install --require-hashes -r requirements.txt && python meridian.py` (`all` to include paying) | [`x402`](https://pypi.org/project/x402/) (httpx client) + eth-account, Python 3.10+ |

Dependencies are pinned to exact versions. `js/package-lock.json` is committed, so use `npm ci --ignore-scripts` (it installs exactly the locked tree and runs no install scripts). `python/requirements.txt` is generated from `requirements.in` with hashes (`uv pip compile --generate-hashes --universal --python-version 3.10`), so pip refuses any file that doesn't match.

To pay for real:

```bash
cp .env.example .env               # then edit .env: EVM_PRIVATE_KEY=0x... and MERIDIAN_PAY=1
set -a; . ./.env; set +a           # load it into this shell (or use: node --env-file=../.env ...)
node js/meridian.mjs pay           # pays for GET /v1/risk/0x...0001?chain=base
```

| Variable | Meaning |
|---|---|
| `EVM_PRIVATE_KEY` | Key of a **dedicated, low-balance** hot wallet holding a little USDC on Base. |
| `MERIDIAN_PAY` | Must be exactly `1` for any example to sign. Anything else skips step 3. |
| `MERIDIAN_MAX_PER_CALL` | Spend cap per payment in **US dollars**, written with a `$` prefix and single-quoted in the shell: `'$0.02'` (default). Bare numbers such as `20000` are rejected, so atomic units can't be mistaken for dollars. Hard maximum `'$0.10'` (the batch screen needs `'$0.10'`). |
| `MERIDIAN_PAID_PATH` | Which GET route to pay for. Must be a plain path starting with one `/` (no `@`, backslash or spaces). |
| `MERIDIAN_RECEIPT_FILE` | Optional. Saves the full `Meridian-Receipt` (it contains a bearer id) to this file with mode `0600` (an existing file is reset to `0600`; a symlink or non-regular file is refused). Receipt ids are redacted from everything printed to the terminal. |
| `MERIDIAN_BASE_URL` + `MERIDIAN_ALLOW_OTHER_ORIGIN=1` | Testing only, for a local mock server. Without the second variable any origin other than `https://meridian.miodiollc.com` is refused. Even with it, the URL must be `https://`; plain `http://` is allowed only for `127.0.0.1` or `localhost`. |

### Wallet safety: what the examples check before signing

Never use a main wallet key and never commit a key. `.env` and common key files are git-ignored. Nothing in a 402 response is trusted. Before any payment is signed, every example (JS, Python, and curl through `js/payment-header.mjs`) enforces all of these and refuses to pay if any check fails:

- **Opt-in:** nothing is signed unless `MERIDIAN_PAY=1` and `EVM_PRIVATE_KEY` are set.
- **Origin:** requests go only to `https://meridian.miodiollc.com`. URLs with user-info (`user@host`) or a path that could change the host are rejected.
- **No redirects:** redirects are never followed (`redirect: "error"` in JS, `follow_redirects=False` in Python, no `-L` in curl), so a signed payment can't be sent to another host.
- **Network:** only `eip155:8453` (Base) is registered and accepted, so a 402 for Ethereum mainnet or a testnet is refused.
- **Scheme:** only `exact`.
- **Asset:** only Base USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`).
- **Pay-to:** only Meridian's pinned `0x4DA1ED782BD61BaE9AdD5a5CaBbCf32f767f8d7F`. If a 402 lists several options, any entry naming another address is dropped before one is chosen.
- **Spend cap:** the amount must be a positive whole number of atomic units no larger than `MERIDIAN_MAX_PER_CALL` (default `$0.02`, hard maximum `$0.10`). It is checked by the examples' own policy and again by the x402 client's spend controls.
- **No secrets in output:** the signed `PAYMENT-SIGNATURE` is never printed (curl gets it through a private temp file that is deleted on exit), and the bearer receipt id is redacted from the printed `PAYMENT-RESPONSE`, `Meridian-Receipt` and body.

## Verifying a receipt

A paid, settled `2xx` can include a `Meridian-Receipt` header: base64 JSON signed with Ed25519.

- Public keys: [/.well-known/meridian-receipt-keys.json](https://meridian.miodiollc.com/.well-known/meridian-receipt-keys.json)
- Copy-paste offline verifier: [/receipt-verify.ts](https://meridian.miodiollc.com/receipt-verify.ts)
- Rules (canonical bytes, key status, timestamps): see "Verify a Meridian-Receipt" in [/docs](https://meridian.miodiollc.com/docs)

After the signature checks out, also confirm the matching on-chain USDC transfer on Base. Treat the receipt id as a bearer secret: don't share `GET /v1/receipt/:id` links. A receipt is not a payment and can't unlock another call.

## Output notes

- Balances are never invented. If an upstream read fails, the card returns `200` with `status: "partial"` or `"error"`. An unexpected 5xx is not charged.
- An invalid address or body returns `400` before the payment gate, so you aren't asked to pay for it.
- The vault APY is a share-price lookback, not a promise.
- Every card carries a `disclaimer` field.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 MioDio LLC.

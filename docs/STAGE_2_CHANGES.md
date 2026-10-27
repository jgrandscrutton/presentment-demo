# Stage 2 Changes

**Date:** 20 October 2026

**Status:** Complete — awaiting review before Stage 3

Future work remains governed by `braintree_demo_roadmap.md`.

## Outcome

Stage 2 turns the routing runner into a payment-lifecycle demonstration and adds a durable proof screen at `/demo/log`.

A presenter can now:

- Run an approved sale or create an authorization without submitting it for settlement.
- Trigger documented Braintree Sandbox processor-decline and gateway-rejection outcomes in any discovered account currency.
- Open the persisted event log, filter it by gateway, currency, and merchant account, and inspect every redacted event.
- Expand an original transaction, refresh its live Braintree state, and perform only currently valid capture, void, Sandbox settlement, or refund operations.
- See every follow-up action linked to its original transaction and verify that the returned merchant account and currency still match the original route.

The browser never supplies a merchant account ID or Braintree transaction ID to an action endpoint. It supplies only the server-owned audit event ID and, for partial capture or refund, an optional amount.

## Implementation details

### Authorize-only and expected Sandbox outcomes

The scenario runner now separates two choices:

- **Gateway action:** submit a sale for settlement, or authorize only.
- **Expected outcome:** approved, processor declined, or gateway rejected.

Approved payments keep the fixed GBP demo-rate price. Failure demonstrations use dedicated Braintree Sandbox trigger values instead of FX conversion:

| Expected outcome | Sandbox major-unit value | Two-decimal example | Zero-decimal example |
| --- | ---: | ---: | ---: |
| Processor decline | 2001 | `2001.00` | `2001` |
| Gateway rejection | 5001 | `5001.00` | `5001` |

The server validates these amounts exactly. The UI locks the amount while a Sandbox failure outcome is selected and labels it as a test trigger rather than a converted price.

An expected decline or rejection is returned as a successful **demo observation** only when the actual Braintree outcome matches, the returned transaction is present, and its merchant account matches the resolved route. The response keeps `paymentApproved: false` and the sanitized Braintree result keeps `success: false`, so a declined payment is never represented as an approved payment.

Decline presets prefer the connected gateway's active default-account currency, then fall back to the first discovered currency with an active one-time route. They therefore move with the connected gateway rather than assuming GBP, EUR, USD, or a particular merchant account.

### Gateway lifecycle boundary

The shared gateway wrapper now supports:

- transaction lookup
- full or reduced capture through `submitForSettlement`
- void
- Sandbox-only forced settlement
- full or partial refund

Every lifecycle wrapper requires the original merchant account ID and validates it against the current discovered catalog immediately before the Braintree SDK call. Transaction lookup also verifies that Braintree returns the expected merchant account.

Refund requests always pass `merchantAccountId` explicitly. This avoids Braintree's documented default-account behaviour when that option is omitted. The action layer then verifies both the merchant account and currency returned by Braintree against the original transaction event.

The Braintree Node SDK's Sandbox settlement helper can return a Transaction directly while other adapters can return a Result-like wrapper. The gateway boundary normalizes direct, wrapped, and wrapped-without-`success` responses to one explicit shape, preserves explicit failures, and rejects successful responses with a missing or mismatched transaction.

The implementation deliberately uses a single reduced `submitForSettlement` capture. It does not use Braintree's separate multiple-partial-settlement feature, which is restricted, and does not imply that the uncaptured remainder can be captured later.

### Live transaction actions

The action API is mounted at:

```text
GET  /api/demo/transactions/:eventId/status
POST /api/demo/transactions/:eventId/actions/:action
```

For both routes, the server:

1. Loads the original transaction from the persisted event store.
2. Rejects route decisions, follow-up events, legacy events, historical-gateway events, unverified routes, and inactive or stale merchant accounts.
3. Derives the transaction ID, merchant account ID, and currency from that trusted event.
4. Refreshes the transaction from Braintree and verifies its live account and currency.
5. Applies the real status matrix immediately before the requested operation.

The supported state matrix is:

| Action | Live status required |
| --- | --- |
| Capture | `authorized` |
| Void | `authorized`, `submitted_for_settlement`, or supported `settlement_pending` cases |
| Settle (Sandbox only) | `submitted_for_settlement` |
| Refund | `settling` or `settled`, with a positive refundable balance |

Capture and refund amounts use integer minor-unit arithmetic rather than floating point. Refund availability follows the original transaction's `refundIds`, reloads each refund, subtracts the exact refunded amounts, and sends the calculated remaining amount explicitly for a remaining/full refund. A partial amount cannot exceed the live remainder.

Every completed action attempts to create a `transaction_action` event with `relatedEventId` pointing to the original transaction event and the returned transaction status. If Braintree may have received an action but the result or local audit write is uncertain, the response says not to retry and the UI leaves the controls locked. The opt-in live verifier applies the same checkpoint rule and prints the known transaction or request reference plus a Control Panel warning if a mutation is not fully audited.

### Durable transaction log

`/demo/log` reads the existing JSON event store, so its contents survive a server restart. It shows the connected gateway by default and can switch to all, historical, or legacy events. Currency and merchant-account filters are applied on the server.

Each row shows:

- timestamp
- scenario and event type
- amount and currency
- current display label plus raw merchant account ID
- payment method type
- outcome or Braintree status
- routing verification result

Expanding a row reveals the complete redacted persisted event. Eligible original transactions lazily request their current Braintree status only when expanded, then show the valid actions. Follow-up and historical rows remain inspectable but read-only.

The event schema now has canonical fields for stage, endpoint, action, transaction mode, expected outcome, transaction status, original Braintree ID, and related event ID. Existing legacy events remain readable and unchanged.

### Local presentation boundary

The server now binds to `127.0.0.1` unless `HOST` is explicitly configured. Setting a non-loopback host prints a warning because lifecycle endpoints are presenter controls that change Sandbox transactions. `.env.example` documents the loopback-safe default.

### Reset boundary correction

The later presentation-readiness roadmap wording now matches the original requirement: reset will clear only the local event store and visible demo state. It will not cancel subscriptions, remove customers, delete payment methods, or change any other object in the Braintree Control Panel.

## Braintree references verified

Stage 2 behaviour was checked against the official Braintree documentation:

- [Submit for settlement](https://developer.paypal.com/braintree/docs/reference/request/transaction/submit-for-settlement/node/)
- [Transaction lookup](https://developer.paypal.com/braintree/docs/reference/request/transaction/find/node/)
- [Void](https://developer.paypal.com/braintree/docs/reference/request/transaction/void/node/)
- [Refund, including explicit merchant account ID](https://developer.paypal.com/braintree/docs/reference/request/transaction/refund/node/)
- [Transaction statuses](https://developer.paypal.com/braintree/docs/reference/general/statuses/)
- [Sandbox settlement and test amounts](https://developer.paypal.com/braintree/docs/reference/general/testing/node/)
- [Transaction response fields](https://developer.paypal.com/braintree/docs/reference/response/transaction/node/)
- [Supported currencies and zero-decimal currencies](https://developer.paypal.com/braintree/docs/reference/general/currencies)
- [Restricted multiple partial settlement API](https://developer.paypal.com/braintree/docs/reference/request/transaction/submit-for-partial-settlement/node/)

## Files added

| File | Purpose |
| --- | --- |
| `config/sandbox-scenarios.js` | Configured expected outcomes and fixed Braintree Sandbox trigger values |
| `lib/transactions/money.js` | Exact action-amount parsing, balance subtraction, and range validation |
| `routes/demo-log.js` | Gateway-aware event filtering and transaction-log view model |
| `routes/demo-operations.js` | Live status, action authorization, lifecycle calls, verification, and follow-up auditing |
| `views/demo-log.hbs` | Durable proof log and expandable live-operation interface |
| `public/scripts/demo-log.js` | Lazy live-state loading and safe operation controls |
| `scripts/verify-stage2-sandbox.js` | Opt-in live lifecycle, routing, and expected-decline verification |
| `test/demo-log-client.test.js` | Browser coverage for lazy status loading and retry-safe versus ambiguous operation locking |
| `test/demo-log.test.js` | Log filtering, rendering, escaping, and persistence-facing coverage |
| `test/demo-operations.test.js` | Trusted-event authority, state matrix, exact amounts, routing verification, and audit coverage |
| `test/server.test.js` | Loopback-default host validation and explicit-exposure coverage |
| `test/stage2-verifier.test.js` | Strict result-shape and pending-mutation warning coverage for the live verifier |
| `docs/STAGE_2_CHANGES.md` | Stage 2 implementation and verification record |

## Files modified

| File | Change |
| --- | --- |
| `.env.example` | Documents the loopback-safe host default |
| `app.js` | Mounts the transaction log and lifecycle API |
| `package.json` | Adds the opt-in `verify:stage2:sandbox` command |
| `server.js` | Binds to loopback by default, validates `HOST`, and warns on explicit network exposure |
| `lib/braintree/gateway.js` | Adds catalog-validated lookup, capture, void, normalized Sandbox settlement, and explicit-account refund wrappers |
| `lib/braintree/result.js` | Includes safe refund relationship fields in sanitized transaction results |
| `lib/currency/index.js` | Adds configured Sandbox amount validation and exact minor-unit helpers |
| `lib/demo/scenarios.js` | Adds generated default-currency decline and rejection presets plus Stage 2 scenario metadata |
| `lib/events/store.js` | Adds canonical Stage 2 lifecycle and relationship fields |
| `routes/demo-api.js` | Executes authorize-only requests and classifies expected Sandbox outcomes without treating them as crashes |
| `routes/demo.js` | Supplies Stage 2 scenario state and per-currency Sandbox trigger values |
| `views/demo.hbs` | Adds lifecycle/outcome controls, log navigation, and Stage 2 presentation copy |
| `public/scripts/demo.js` | Manages Stage 2 controls, locked trigger amounts, request state, and distinct result language |
| `public/stylesheets/demo.css` | Adds transaction-log, operation, responsive, focus, and locked-amount presentation |
| `docs/braintree_demo_roadmap.md` | Corrects the later reset boundary so Braintree Control Panel data remains intact |
| `test/braintree-gateway.test.js` | Covers lifecycle wrappers, stale accounts, settlement response shapes, lazy SDK support, and route mismatches |
| `test/currency.test.js` | Covers exact Sandbox triggers, zero-decimal formatting, and minor-unit arithmetic |
| `test/demo-api.test.js` | Covers authorization, expected failures, invalid trigger values, and unexpected outcomes |
| `test/demo-client.test.js` | Covers Stage 2 browser state, locked amounts, and authorize-only result language |
| `test/demo.test.js` | Covers generated Stage 2 controls, presets, labels, and escaped values |
| `test/scenarios.test.js` | Covers default-currency failure presets and Stage 2 scenario defaults |

## Verification performed

- `npm test`: **180 tests passed**; the automated suite uses fakes and makes no live Braintree calls
- Focused gateway, currency, scenario, runner, log, and lifecycle-action test runs
- JavaScript syntax checks for server and browser modules
- Local HTTP rendering checks for `/demo`, `/demo/log`, and `/health`
- `npm run verify:stage2:sandbox` against the connected Braintree Sandbox

The live verifier performs an authorize-only transaction, reduced capture, Sandbox settlement, partial refund, a separate authorization and void, a processor decline, and a gateway rejection. It records only redacted Stage 2 audit events and verifies returned merchant account IDs and currencies.

The final clean run produced:

| Scenario | Original transaction | Related transaction | Amount observed | Account / currency | Result |
| --- | --- | --- | --- | --- | --- |
| Authorize → partial capture → settle → partial refund | `2qjqzwdk` | Refund `94j8jp5b` | Captured `5.47`; refunded `2.73` | `paypal2` / GBP | Route preserved; verified |
| Authorize → void | `9gxj5f4y` | — | `15.94` | `paypal2` / GBP | Voided; verified |
| Processor decline | `cb20w317` | — | `2001.00` | `paypal2` / GBP | Expected decline observed |
| Gateway rejection | `jr1hewrz` | — | `5001.00` | `paypal2` / GBP | Expected rejection observed |

An earlier verifier pass exposed the SDK's direct-Transaction settlement return shape after the settlement had already completed. The adapter was corrected and covered with response-shape tests. That original transaction (`86t2j0w7`) was read back as settled and partially refunded through the app's audited action API (`675ejc7t`) without replaying capture or settlement. The clean run above then passed end to end.

All Sandbox transactions remain in the Braintree Control Panel. Clearing or filtering the local demo log does not alter them.

## Stage boundary

Stage 2 does not add vaulting, customers, recurring charges, subscriptions, PayPal/Venmo/wallet checkout, 3D Secure, webhooks, or a reset control. Those remain later stages.

No dependency was added.

## Review required

Before Stage 3, review:

- Sale versus authorize-only behaviour in the runner.
- Processor-decline and gateway-rejection presentation, especially that neither is labelled as an approved payment.
- Default/current/historical/legacy log filters and expanded redacted inspector data.
- Partial capture, void, Sandbox settlement, full/partial refund, and live action availability.
- Follow-up `relatedEventId` links and merchant-account/currency verification.
- The fail-closed behaviour for stale accounts, unverified events, ambiguous action results, and local audit failures.

Stage 3 has not been started.

# Stage 3 Changes

**Date:** 28 October 2026

**Status:** Implemented — awaiting review before Stage 4

Future work remains governed by [`braintree_demo_roadmap.md`](braintree_demo_roadmap.md). The Stage 3 decision was resolved in favour of both recommended recurring models. Stage 4 remains blocked pending this review and the separate public-URL decision.

## Outcome

Stage 3 turns the recurring preview into a real vaulted-payment demonstration.

A presenter can now:

- Create a recognisably labelled Sandbox customer and verify its card on the server-resolved recurring merchant account.
- Run Model A, where the application sends a first merchant-managed charge with `transactionSource=recurring_first` and an on-demand next cycle with `transactionSource=recurring`.
- Charge the same vaulted customer through its currency's one-time route, making both shared-account and split-account policies visible without giving the browser a payment-method token or merchant account ID.
- Run Model B from Braintree plans discovered at startup: create a subscription with an explicit merchant account, view its status and next billing date, and cancel it.
- See an exact **No plan available** state for a currency while Model A and the rest of the demo remain usable.
- Inspect the selected model, outbound transaction-source flag, returned merchant account, returned currency evidence, safe vault details, and subscription state in the existing runner and durable event log.

The current gateway policy continues to describe `vmUSD` and `vmUSD2` as interchangeable-purpose processor variants. Assigning one-time USD to `vmUSD` and recurring USD to `vmUSD2` is merchant-controlled demo policy, not an intrinsic Braintree restriction.

## Implementation details

### Plan discovery and catalog validation

The catalog refresh now performs Braintree's plan-listing call alongside merchant-account discovery. Plans are copied immediately from the Node SDK collection and reduced to documented, presentation-safe fields:

```text
id · name · description · currency · price · billing frequency · trial settings
```

Plan handling is deliberately independent from core account discovery. If plan discovery fails, the merchant-account catalog stays available and the UI reports that Model B is unavailable; one-time payments and Model A still work.

The plan catalog excludes malformed rows, duplicate IDs, and currencies without an active recurring route, recording safe warnings for each exclusion. Its read-only accessors support all plans, plans for a currency, lookup by ID, and a final route assertion immediately before Model B vaulting. A missing plan, failed discovery, or plan/route currency mismatch stops before any customer or subscription call.

Plans do not select merchant accounts. Their currency is matched to the server-owned recurring route, and subscription creation passes that resolved merchant account ID explicitly.

### Vault and recurring gateway boundary

The shared Braintree boundary now supports:

- customer creation with an application-generated `demo-` customer ID
- card verification through `verificationMerchantAccountId`
- customer lookup
- subscription create, find, and cancel
- optional, allowlisted transaction sources on transaction sale

Every wrapper that can act in an account context requires an explicit merchant account ID and revalidates it against the current discovered catalog next to the SDK call. Subscription responses and any transactions nested inside them are checked against the expected account before returning to application code.

Model A sends `transactionSource` as a top-level Braintree sale field. Only the documented values are accepted:

| Billing step | Value sent |
| --- | --- |
| First merchant-managed recurring charge | `recurring_first` |
| Subsequent merchant-managed charge | `recurring` |

Braintree's transaction response does not echo this original request field. The inspector therefore labels it as the server-owned value **sent to Braintree**, while the returned transaction merchant account and currency provide independent routing proof.

Safe result adapters expose only allowlisted customer, masked-card, verification, transaction, and subscription fields. Raw nonces, client tokens, payment-method tokens, credentials, and full SDK objects never enter HTTP responses or the event store.

### Recurring API and server-owned authority

The Stage 3 API is mounted under `/api/demo/recurring`:

```text
POST /start
POST /events/:eventId/next-cycle
POST /events/:eventId/one-time
GET  /subscriptions/:eventId
POST /subscriptions/:eventId/cancel
```

The start endpoint accepts customer intent, a Hosted Fields nonce, the recurring model, and—only for Model B—a discovered plan ID. It resolves the account again on the server, creates a prefixed customer, verifies the card on that account, and stops before billing if verification does not return the expected status, account, and currency.

Follow-up endpoints accept only the server-owned audit event ID in the path. They recover the customer, original amount, model, subscription, plan, currency, and account relationship from the verified persisted event. Bodies that attempt to inject a customer ID, token, subscription ID, amount, transaction source, or merchant account ID are rejected before a gateway call.

Model A uses the customer ID rather than returning a vault token to the browser. The same customer is used for:

1. the first recurring-route charge;
2. the next recurring billing cycle; and
3. the one-time-route comparison charge.

Model B extracts its payment-method token only inside the server operation, creates the subscription with the selected plan and explicit resolved account, then persists only a safe subscription summary. View and cancel derive their Braintree subscription ID from the original verified event.

The Model B same-vault one-time comparison uses a separate positive server-owned demo amount rather than reusing the plan price. This keeps valid zero-price and high-price plans usable while the comparison remains inside the demo transaction range.

Gateway mutations retain Stage 2's cautious retry boundary. If Braintree may have received a request but the response or local audit is incomplete, the API reports that the operation is unsafe to retry blindly.

### Runner, inspector, and log

Every discovered currency with a recurring route now receives a runnable recurring preset. The Stage 1/2 preview-only Stage 3 placeholder has been removed.

The runner adds:

- a recurring-model selector for Model A and Model B;
- a currency-filtered plan selector populated from discovery;
- the exact **No plan available** fallback;
- Hosted Fields collection for the recurring flow;
- controls to run the next Model A cycle and the same-vault one-time comparison;
- controls to view and cancel a Model B subscription;
- plain-language copy explaining that Braintree, rather than the demo, owns Model B's schedule;
- inspector fields for the recurring model and transaction-source request value.

Recurring controls require an approved, submitted sale flow. Processor-decline, gateway-rejection, and authorize-only Stage 2 settings remain available for one-time demonstrations but do not masquerade as recurring billing.

The event schema and log presentation now recognise vault, subscription, and subscription-action records plus recurring model, billing cycle, transaction source, customer, plan, subscription status, next billing date, and vault relationship fields. Stored and rendered payloads remain redacted.

### Opt-in Stage 3 Sandbox verifier

`npm run verify:stage3:sandbox` loads `config.env` or `.env` without printing it, refreshes both catalogs, and selects routes from discovery rather than embedding account IDs.

The verifier:

1. Enumerates every discovered currency that has both an active one-time route and an active recurring route.
2. For each eligible currency, creates its own uniquely prefixed `demo-stage3-…` customer and verifies the card on the resolved recurring account.
3. For each eligible currency, sends a first Model A charge with `recurring_first`, then charges that same vaulted customer through the independently resolved one-time route.
4. Sends a subsequent Model A charge with `recurring` at least once, preferring any split-account route discovered from the current gateway and otherwise using the first eligible route.
5. Requires returned merchant-account and currency evidence to match for every vault verification and transaction; one mismatch fails the whole run.
6. If a compatible plan exists, creates, finds, and cancels a Model B subscription with an explicit merchant account ID, reusing an already verified currency vault when possible.
7. If no compatible plan exists, prints an explicit Model B skip and still completes the catalog-wide Model A and shared-vault proof.
8. Verifies the subscription account plus any returned subscription-transaction currency evidence.
9. Writes only redacted audit records and never prints the nonce, payment-method token, client token, or credentials.

Subscription cancellation is attempted as cleanup after creation, including when a later read or assertion fails. Submitted transactions and demo customers remain clearly labelled Sandbox artifacts because this stage does not add destructive customer cleanup.

## Braintree references verified

Stage 3 behaviour was checked against the official Braintree documentation:

- [Create a customer and verify a vaulted card](https://developer.paypal.com/braintree/docs/reference/request/customer/create/node/)
- [Create a payment method with card-verification options](https://developer.paypal.com/braintree/docs/reference/request/payment-method/create/node/)
- [Credit card response fields](https://developer.paypal.com/braintree/docs/reference/response/credit-card/node)
- [Credit card verification response fields](https://developer.paypal.com/braintree/docs/reference/response/credit-card-verification/node/)
- [Transaction sale, including `transactionSource`](https://developer.paypal.com/braintree/docs/reference/request/transaction/sale/node)
- [List subscription plans](https://developer.paypal.com/braintree/docs/reference/request/plan/all/node/)
- [Plan response fields](https://developer.paypal.com/braintree/docs/reference/response/plan/node/)
- [Create a subscription with an explicit merchant account](https://developer.paypal.com/braintree/docs/reference/request/subscription/create/node)
- [Find a subscription](https://developer.paypal.com/braintree/docs/reference/request/subscription/find/node)
- [Cancel a subscription](https://developer.paypal.com/braintree/docs/reference/request/subscription/cancel/node/)
- [Subscription response fields](https://developer.paypal.com/braintree/docs/reference/response/subscription/node)

## Files added

| File | Purpose |
| --- | --- |
| `lib/braintree/discover-plans.js` | SDK plan listing, normalization, warning isolation, and safe plan fields |
| `routes/demo-recurring-api.js` | Vault, Model A, shared-vault comparison, and Model B endpoints |
| `scripts/verify-stage3-sandbox.js` | Opt-in live vault, recurring-route, plan, and cleanup verification |
| `test/braintree-recurring-result.test.js` | Safe vault/subscription summaries and route-verification coverage |
| `test/demo-recurring-api.test.js` | Recurring authority, sequencing, routing, retry, redaction, and audit coverage |
| `test/plan-catalog.test.js` | Plan/catalog integration, mismatch rejection, warnings, and graceful degradation |
| `test/plan-discovery.test.js` | SDK plan collection and normalization coverage |
| `test/stage3-sandbox-verifier.test.js` | Live-verifier follow-up linkage, deterministic failure, and cancellation audit semantics |
| `docs/STAGE_3_CHANGES.md` | Stage 3 implementation, verification status, and review record |

## Files modified

| File | Change |
| --- | --- |
| `app.js` | Mounts the Stage 3 recurring API |
| `server.js` | Carries plan-discovery state through startup and safe unavailable-catalog handling |
| `package.json` | Adds the opt-in `verify:stage3:sandbox` command |
| `lib/braintree/gateway.js` | Adds vault/customer/subscription wrappers and recurring transaction-source support |
| `lib/braintree/result.js` | Adds allowlisted vault/subscription summaries and account/currency verification |
| `lib/catalog/index.js` | Exposes plan-catalog errors and accessors |
| `lib/catalog/runtime.js` | Keeps the unavailable runtime service shape compatible with plan access |
| `lib/catalog/service.js` | Discovers, validates, filters, stores, and queries subscription plans |
| `lib/demo/scenarios.js` | Makes recurring routes executable presets for every eligible currency |
| `lib/events/store.js` | Adds canonical vault and recurring/subscription fields |
| `routes/demo-api.js` | Generates recurring-route client tokens instead of returning the old Stage 3 placeholder |
| `routes/demo-log.js` | Labels vault, subscription, and subscription-action events |
| `routes/demo.js` | Supplies recurring models, discovered plans, and plan availability to the runner |
| `views/demo.hbs` | Adds Stage 3 controls, explanations, proof fields, and review state |
| `public/scripts/demo.js` | Runs Hosted Fields recurring starts and server-authorised follow-up actions |
| `public/stylesheets/demo.css` | Styles recurring-model, plan, follow-up, and proof states |
| `test/braintree-gateway.test.js` | Covers explicit-account recurring wrappers, flags, lazy APIs, and mismatches |
| `test/demo-api.test.js` | Covers real recurring-route token generation and removal of preview-only behaviour |
| `test/demo-client.test.js` | Covers Model A/Model B browser state, actions, and no-plan fallback |
| `test/demo.test.js` | Covers Stage 3 view state, controls, plans, fallback, and escaping |
| `test/scenarios.test.js` | Covers executable recurring presets on shared and split routes |
| `docs/braintree_demo_roadmap.md` | Records the resolved two-model decision and blocks Stage 4 pending review |

## Braintree-only integration boundary

All executable payment paths use Braintree client components and the Braintree server SDK. The legacy storefront may display PayPal buttons, but Braintree PayPal Checkout loads that UI, tokenizes the approved payment into a Braintree nonce, and submits it through the same routed Braintree gateway boundary. Direct PPCP OAuth, Orders, capture, subscription, and webhook APIs are not part of this project.

- Removed the unused, unverified `/api/webhooks/paypal` placeholder; the webhook surface now exposes only the Braintree endpoint and activity feed.
- Updated storefront copy and code labels so PayPal is consistently described as a payment method offered through Braintree PayPal Checkout.
- Added source invariants that reject direct PayPal REST hosts, OAuth and Orders endpoints, PayPal server SDKs, direct SDK script loading, and any PayPal button that lacks the complete Braintree tokenization chain.

## Verification performed

- The full Node test suite passes using fake gateways; unit tests make no live Braintree calls.
- All 244 tests pass, including focused live-verifier audit tests and the Braintree-only integration-boundary checks.
- Focused plan discovery, plan catalog, gateway boundary, safe-result, recurring API, server-rendered UI, and browser-state tests pass.
- JavaScript syntax checks pass for the Stage 3 server, browser, and verifier modules.
- `git diff --check` passes.
- The new live verifier has intentionally **not** been run yet. It is opt-in because it creates Sandbox customers and submitted transactions; when a compatible plan exists it also creates and then cancels a subscription.

## Stage boundary

Stage 3 does not add webhook receipt, disputes, PayPal/Venmo/wallet checkout, 3D Secure, policy editing, or local reset controls. Those remain assigned to later stages.

No dependency was added.

Stage 4 must not begin until Stage 3 has been reviewed and the human chooses how Braintree will reach the webhook endpoint through a public HTTPS deployment or tunnel.

## Review required

Before Stage 4, review:

- Card verification account and currency proof before any recurring charge.
- Model A's first and subsequent `transactionSource` values and their **sent to Braintree** wording.
- Same-vault one-time versus recurring routing, especially the configurable USD split.
- GBP/EUR or any dynamically discovered currency whose one-time and recurring routes share an account.
- Model B plan discovery, plan/route currency rejection, status, next billing date, and cancellation.
- The exact **No plan available** state and continued Model A usability.
- Redacted inspector/log output and server-owned event authority for every follow-up action.
- The fail-closed behaviour for stale accounts, verification mismatches, ambiguous gateway results, and local audit failures.

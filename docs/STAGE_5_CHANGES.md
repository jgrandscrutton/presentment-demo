# Stage 5 Changes: Card and PayPal

**Date:** 16 November 2026
**Status:** Implemented locally; all card routes live-verified; linked-Sandbox PayPal approval remains a browser step

## Outcome

The routing demo now offers Card and Braintree-mediated PayPal on every configured account. The payment method changes how Braintree collects and represents payment details, but it does not participate in routing: currency and merchant-defined payment type still select the merchant account on the server.

The runner has been reorganized around a short, visible sequence:

1. choose a scenario;
2. choose an available payment method;
3. preview the server-selected route;
4. approve or enter payment details;
5. compare the requested route with the account, currency, and instrument returned by Braintree.

Card remains the conservative automatic default. PayPal appears only where the merchant-specific policy explicitly enables it. Venmo, Apple Pay, Google Pay, local payment methods, and direct PayPal REST integrations remain disabled.

## User-interface changes

- Added a Card/PayPal method chooser with plain-language descriptions and clear selected, disabled, focus, and responsive states.
- Kept Hosted Fields mounted only for Card and Braintree PayPal Checkout mounted only for PayPal.
- Added PayPal launch, approval, cancellation, teardown, and failure states without exposing a nonce or PayPal credential in the page.
- Kept route preview separate from payment approval so the presenter can explain the business decision before opening either payment UI.
- Added method-aware proof copy to the inspector and activity log.
- Preserved keyboard navigation, fieldset/legend semantics, live regions, visible focus, reduced-motion behaviour, and narrow-screen layouts.
- Added confirmation before subscription cancellation and protected the UI against stale asynchronous callbacks after a scenario, currency, account, or method changes.

## Policy and routing

`paymentMethods` is now a validated account-policy field. An omitted field defaults to Card only; an inactive account exposes no payment methods. The local merchant overlay explicitly enables `card` and `paypal` for:

| Currency | Payment type | Merchant account | Methods |
| --- | --- | --- | --- |
| EUR | one-time and recurring | `paypal` | Card, PayPal |
| GBP | one-time and recurring | `paypal2` | Card, PayPal |
| USD | one-time | `vmUSD` | Card, PayPal |
| USD | recurring | `vmUSD2` | Card, PayPal |

The route resolver remains method-agnostic. Tests resolve the same intent with Card and PayPal and require the selected merchant account to remain identical.

Unknown future method names are excluded with a catalog warning rather than accidentally appearing in the UI. The browser receives only public method availability and never sends a merchant account ID.

## One-time payments

Before a sale, the server performs a read-only `paymentMethodNonce.find` and rejects a nonce whose Braintree type does not match the selected method. A failed pre-sale lookup is explicitly retry-safe because no transaction request was made.

After a sale, success requires all of the following independent evidence from Braintree:

- the operation succeeded;
- `transaction.merchantAccountId` matches the server-selected account;
- `transaction.currencyIsoCode` matches the requested currency;
- `transaction.paymentInstrumentType` maps to the selected Card or PayPal method.

A returned mismatch or completed mutation with failed audit persistence is recorded and treated as unsafe to retry blindly.

One-time Card mode continues to support sale and authorize-only flows. PayPal Checkout receives the matching intent through Braintree and uses the same server-owned route.

## Vaulting and recurring payments

- Card vault creation requests verification on the recurring merchant account and requires returned verification account, currency, status, and card proof.
- PayPal vault creation uses a billing-agreement nonce. Braintree does not return merchant-account proof during that vault step, so the audit record states that route proof is deferred rather than claiming success.
- The first recurring sale supplies the resolved merchant account explicitly and proves account, currency, and PayPal instrument from the transaction response.
- Model A, Model B, next-cycle, subscription view, and cancellation paths preserve the selected method in their safe summaries and audit evidence.
- The same-vault one-time comparison is not offered for PayPal because that follow-up needs fresh device data; it remains available for Card.

No raw nonce, client token, payment-method token, PayPal credential, or unbounded SDK object is returned to the browser or stored in the activity log.

## PayPal client lifecycle

PayPal is loaded through Braintree PayPal Checkout, not the direct PayPal server APIs. The browser caches PayPal SDK loads by account, currency, flow, and intent and gives each configuration a stable `data-namespace`. That prevents an SDK instance configured for one route from being silently reused for a different merchant-account token.

The Stage 5 implementation stays on Braintree JavaScript v3 for the current local HTTP demo. Braintree's newer PayPal client path requires an HTTPS context, which belongs with the later hosted deployment work.

## Sandbox verifier

`npm run verify:stage5:sandbox` discovers the current catalog and builds a route/method matrix rather than embedding merchant account IDs. It inspects every nonce before mutation, uses explicit merchant accounts, and requires account, currency, instrument, and operation-success proof after every transaction. Scenario selection is available through repeated `--scenario <scenario-id>` arguments so a reviewed partial run can continue without replaying successful transactions.

Verifier amounts now stay in a deliberately narrow success band: `1.01–9.99` for two-decimal currencies and `101–999` for zero-decimal currencies. This avoids Braintree's documented transaction and dispute trigger values.

Static PayPal test nonces are permitted only with the explicit `--allow-mocked-paypal` switch. Without that switch, selected PayPal scenarios stop before mutation and explain that a linked PayPal Sandbox needs fresh browser-generated nonces. This is important because mocked PayPal nonces may stop working after a PayPal Sandbox account is linked, while Braintree PayPal Checkout itself does not operate in mocked mode.

### Live run on 16 November 2026

Every configured Card route completed with matching returned evidence:

| Route | Selected/returned account | Transaction | Result |
| --- | --- | --- | --- |
| EUR one-time | `paypal` | `my8ypxg2` | verified |
| EUR recurring | `paypal` | `gpkb2nsa` | verified |
| GBP one-time | `paypal2` | `8hcv8887` | verified |
| GBP recurring | `paypal2` | `p9yxk4a3` | verified |
| USD one-time | `vmUSD` | `db4fpbj1` | verified |
| USD recurring | `vmUSD2` | `6y4z3ht9` | verified |

The first static PayPal one-time attempt returned the expected EUR account, EUR currency, and `paypal_account` instrument but was processor-declined. A reviewed second attempt returned processor code `2069` (`PayPal Blocking Duplicate Order IDs`), confirming that the static one-time artifact could not be replayed in this linked Sandbox. Both failures were audited, and no further PayPal mutation was attempted.

Consequently, live Card proof is complete. PayPal routing, nonce classification, response verification, UI lifecycle, and failure behaviour are covered locally, but a successful linked-Sandbox PayPal transaction still requires approval in the demo UI with a fresh Sandbox buyer session. It must not be reported as live-passed until that browser step succeeds.

Clearly labelled submitted transactions and recurring demo customers remain in Braintree Sandbox. The verifier does not delete gateway artifacts.

## Files added

- `lib/payment-methods.js`
- `scripts/verify-stage5-sandbox.js`
- `test/payment-methods.test.js`
- `test/stage5-sandbox-verifier.test.js`
- `docs/STAGE_5_CHANGES.md`

## Principal files modified

- `config/routing-policies/example.json` and the local merchant policy overlay
- `lib/catalog/build-catalog.js`
- `lib/catalog/validate-catalog.js`
- `lib/braintree/gateway.js`
- `lib/braintree/result.js`
- `lib/currency/index.js`
- `routes/demo.js`
- `routes/demo-api.js`
- `routes/demo-recurring-api.js`
- `routes/demo-log.js`
- `views/demo.hbs`
- `views/demo-log.hbs`
- `public/scripts/demo.js`
- `public/stylesheets/demo.css`
- `package.json`
- `docs/braintree_demo_roadmap.md`
- the related catalog, API, browser, view, result, source-invariant, and verifier tests

## Official Braintree and PayPal references

- [Find a payment-method nonce](https://developer.paypal.com/braintree/docs/reference/request/payment-method-nonce/find/node)
- [PayPal Checkout with Braintree JavaScript v3](https://developer.paypal.com/braintree/docs/guides/paypal/client-side/javascript/v3)
- [Vault PayPal with Braintree JavaScript v3](https://developer.paypal.com/braintree/docs/guides/paypal/vault/javascript/v3/)
- [PayPal testing and linked-Sandbox limitations](https://developer.paypal.com/braintree/docs/guides/paypal/testing-go-live/javascript/v3/)
- [Braintree Sandbox test nonces and trigger amounts](https://developer.paypal.com/braintree/docs/reference/general/testing/node/)
- [Create and verify a vaulted customer](https://developer.paypal.com/braintree/docs/reference/request/customer/create/node)
- [Create a subscription](https://developer.paypal.com/braintree/docs/reference/request/subscription/create/node)
- [PayPal SDK script configuration and `data-namespace`](https://developer.paypal.com/sdk/js/configuration/)
- [Braintree authorization response codes](https://developer.paypal.com/braintree/docs/reference/general/processor-responses/authorization-responses)

## Verification performed

- Full Node test suite: **331 tests passed**, with no skips or failures.
- Focused Card/PayPal policy, catalog, one-time, recurring, browser, result, activity-log, verifier, and source-invariant tests pass.
- JavaScript syntax checks pass for every changed Stage 5 server, browser, and verifier module.
- Runtime smoke testing discovered four live Sandbox merchant accounts and returned `200` for `/health`, `/demo`, `/demo/log`, `/scripts/demo.js`, and `/stylesheets/demo.css` with the expected UI content.
- `git diff --check` passes.

## Stage boundary

Stage 5 does not add direct PayPal Orders/capture/subscription APIs, Venmo, Apple Pay, Google Pay, local payment methods, 3D Secure, presenter policy editing, or hosted deployment.

The separate Stage 4 public HTTPS callback and dispute review remains outstanding. Stage 6 has not started.

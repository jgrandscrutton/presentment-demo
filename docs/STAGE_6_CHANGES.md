# Stage 6 Changes: 3D Secure

**Date:** 16 November 2026
**Status:** Gateway rejection verified in Sandbox on 19 November 2026; a live browser challenge review remains outstanding

## Outcome

The routing demo now applies a Card 3D Secure policy to every discovered merchant account, authenticates eligible cards with Braintree 3D Secure v2, and shows bounded authentication and liability-shift proof alongside the existing route, currency, and payment-method evidence.

The policy is owned by the server-selected account. EUR defaults to required authentication; other currencies default to optional authentication. A valid merchant overlay can make either policy explicit. An invalid configured value fails closed to required and produces a catalog warning.

PayPal remains mediated by Braintree PayPal Checkout and is correctly labelled as not applicable to Card 3D Secure. The payment method does not influence routing.

## Customer flow and interface

- Added a compact Card-only 3D Secure panel after Hosted Fields, with Required or Optional policy copy and a clear readiness/authentication status.
- Added frictionless, challenge, and failed-authentication guidance using Braintree's documented Sandbox test cards. Selecting a path does not replace the card already entered in Hosted Fields; the presenter must enter the displayed test card.
- Optional routes let the presenter turn 3D Secure off for comparison; required routes cannot be bypassed in the browser.
- Hosted Fields and 3D Secure use the same Braintree client created from the client token for the resolved merchant account.
- The Card sequence is Hosted Fields tokenization, 3D Secure verification with amount and BIN, then submission of only the upgraded nonce.
- A failed or cancelled authentication stops before the payment API and remains safe to retry. Long-running challenge results are rejected if the route has since become stale.
- The inspector distinguishes policy, authentication status, liability-shift possibility, and actual liability shift. Missing evidence is displayed as unavailable rather than as false.
- The account registry, decision trace, and activity log expose the Card 3D Secure policy without presenting it as a routing selector.

## Server authority and fail-closed enforcement

The browser never sends a merchant account ID, an account policy, or authoritative liability flags. For both one-time and recurring Card starts, the server:

1. resolves the route again;
2. inspects the Braintree payment-method nonce;
3. derives bounded 3D Secure evidence from the returned SDK object;
4. evaluates that evidence against the selected account's policy; and
5. blocks required authentication that is missing, failed, or did not produce liability shift before any sale or vault mutation.

Required Card sales explicitly send `options.threeDSecure.required: true`. Optional sales omit this option so Braintree retains its default enforcement for a 3DS-enriched nonce; optional policy must not force an authentication failure through with `required: false`. Card transaction responses are independently checked again. A completed mutation whose returned transaction lacks required proof is treated as unsafe to retry and directs the presenter to the Sandbox Control Panel.

Missing or failed required authentication is retry-safe and creates a bounded `three_d_secure` audit event when local persistence is available. The event records only policy, normalized status, liability-shift booleans, the route, and the safe verification explanation. The separate required-Model-B re-authentication block happens after route resolution but before vaulting, so it leaves the route-resolution event rather than claiming that authentication itself failed.

## Recurring payments

- The initial Card nonce is inspected before vault creation. A required route blocks a missing, failed, or non-shifted authentication before any customer, payment method, sale, or subscription mutation.
- Once a Card nonce is consumed by vault setup, its bounded evidence is labelled `evidenceScope: "vault_setup"` with `transactionAuthenticated: false`. It can document customer/vault setup and a recurring mandate, but it is not represented as fresh authentication of a later transaction.
- Model A merchant-managed recurring retains that setup evidence with the root event. First-cycle and next-cycle evidence remains scoped to `vault_setup`; transaction events explicitly record `transactionThreeDSecureAuthenticated: false` instead of presenting the historical shift as transaction-level proof.
- Merchant-managed next-cycle actions re-resolve the route and re-evaluate the persisted setup evidence against the current target policy. A stricter target that the setup evidence cannot satisfy is blocked before sale, but a permitted recurring charge still does not claim a fresh customer challenge.
- Required-policy Card Model B stops before customer vaulting or `Subscription.create`, even when the submitted nonce contains successful 3D Secure evidence. Vaulting would consume the one-use nonce and leave only a token for subscription creation, so the API returns `THREE_D_SECURE_SUBSCRIPTION_REAUTH_REQUIRED` and recommends Model A or an optional-policy route.
- Optional-policy Model B may proceed, but it separates `vaultThreeDSecureVerification` (`evidenceScope: "vault_setup"`) from the subscription transaction's `threeDSecureVerification` (`evidenceScope: "subscription_transaction"`). The latter reports no performed authentication or liability shift and records `transactionThreeDSecureAuthenticated: false`.
- Subscription status and cancellation rehydrate those two evidence scopes without treating either operation as a new authenticated charge. Even a legacy required-policy subscription remains viewable and cancelable, while any new one-time charge still goes through the fresh-authentication gate.
- A vaulted one-time follow-up on a required target always returns `THREE_D_SECURE_FRESH_AUTHENTICATION_REQUIRED` before sale. Historical setup evidence cannot authorize that new customer-initiated charge even when it previously showed liability shift. An optional target can proceed, but its transaction evidence is labelled `vaulted_one_time_transaction` and does not claim fresh authentication.
- PayPal recurring starts bypass only the Card-specific gate and are labelled not applicable.

## Catalog and audit contract

Each account now has `threeDSecurePolicy: "required" | "optional"`. The field is validated, preserved in public route decisions, shown in matched trace evidence, and frozen with the rest of the catalog.

The canonical event contract adds:

- `threeDSecurePolicy`
- `threeDSecureStatus`
- `liabilityShiftPossible`
- `liabilityShifted`
- `threeDSecureEvidenceScope`
- `transactionThreeDSecureAuthenticated`

Recurring responses and redacted evidence may also include separate bounded `vaultThreeDSecureVerification` and transaction-level `threeDSecureVerification` summaries so the UI can show what each proof applies to. No CAVV, ECI, XID, directory-server transaction ID, ACS URL, device data, raw authentication payload, payment-method token, or nonce is returned in payment/recurring results or stored in the activity log. The short-lived client token required to initialize Braintree Web is returned only by the dedicated setup endpoint and is not persisted or echoed in payment evidence.

## Files added

- `lib/three-d-secure.js`
- `test/three-d-secure.test.js`
- `docs/STAGE_6_CHANGES.md`

## Principal files modified

- `config/routing-policies/example.json` and the local ignored merchant overlay
- `lib/catalog/build-catalog.js`
- `lib/catalog/validate-catalog.js`
- `lib/routing/resolve-route.js`
- `lib/braintree/gateway.js`
- `lib/braintree/result.js`
- `lib/events/store.js`
- `routes/demo.js`
- `routes/demo-api.js`
- `routes/demo-recurring-api.js`
- `routes/demo-log.js`
- `views/demo.hbs`
- `views/demo-log.hbs`
- `public/scripts/demo.js`
- `public/stylesheets/demo.css`
- `docs/braintree_demo_roadmap.md`
- the related catalog, routing, gateway, result, API, recurring, browser, view, log, event-store, and source-invariant tests

## Official Braintree references

- [3D Secure JavaScript v3 step-by-step integration](https://developer.paypal.com/braintree/docs/guides/3d-secure/step-by-step-integration/javascript/v3/)
- [Apply 3D Secure to transactions and verifications — Node.js](https://developer.paypal.com/braintree/docs/guides/3d-secure/applying-3ds-to-transactions-and-verifications/node/)
- [3D Secure testing — Node.js](https://developer.paypal.com/braintree/docs/guides/3d-secure/testing/node/)
- [Find a payment-method nonce — Node.js](https://developer.paypal.com/braintree/docs/reference/request/payment-method-nonce/find/node)
- [Create a subscription — Node.js](https://developer.paypal.com/braintree/docs/reference/request/subscription/create/node/)
- [Transaction response — Node.js](https://developer.paypal.com/braintree/docs/reference/response/transaction/node/)
- [Braintree Web `ThreeDSecure` API](https://braintree.github.io/braintree-web/current/ThreeDSecure.html)

## Verification performed

- Unit coverage exercises policy defaults and overrides, invalid fail-closed configuration, nonce and transaction evidence, one-time pre-sale blocking, recurring pre-vault blocking, required Model B pre-vault rejection, optional Model B evidence separation, historical-proof rejection for required vaulted one-time charges, stricter follow-up routes, safe audit fields, and gateway request mapping without live Braintree calls.
- The dependency-free Node `vm` client harness uses a fake DOM and fake Braintree SDK to cover the 3D Secure component lifecycle, upgraded-nonce submission, optional bypass, PayPal exclusion, failure-before-payment behaviour, stale callbacks, and proof rendering. Stage 7 separately adds real headless-Chrome/CDP presenter-workflow smoke, without live payment execution.
- Runtime source-contract tests require the Braintree 3D Secure v2 script and client chain, shared resolved-account client, upgraded nonce handoff, server-owned policy gates, and the validated gateway option mapping.
- JavaScript syntax checks and the full Node regression suite are part of the local Stage 6 review.
- The initial stage implementation did not include a live Sandbox payment, challenge, or liability-shift review. The later gateway rejection checks below cover only their stated negative cases.

## Gateway enforcement correction — 19 November 2026

The one-time API previously sent `threeDSecure.required: false` for every optional Card route. Braintree documents this as an override that can allow a transaction despite failed authentication. The API now omits that override while retaining explicit enforcement for required routes and the existing server checks before sale. Missing or failed authentication on a required route normally stops locally, so that path does not create a gateway-rejected transaction.

The browser also previously allowed payment when the presenter selected Failed but left a successfully authenticated test card in Hosted Fields. That mismatch now stops before either a one-time payment or recurring-start request, with instructions to replace the entered card. It does not claim that successful authentication was rejected by Braintree.

Two bounded, authorization-only checks were sent directly through the shared gateway wrapper to the connected Braintree Sandbox, independently of the browser's local checks:

| Test | Currency | Transaction ID | Gateway result |
| --- | --- | --- | --- |
| Plain card nonce with `threeDSecure.required: true` | EUR | `6k2chxkp` | `gateway_rejected`, reason `three_d_secure` |
| Failed-authentication test nonce with the option omitted | USD | `466javys` | `gateway_rejected`, reason `three_d_secure`; `authenticate_failed`, liability not shifted |

Neither request submitted for settlement, and neither was approved. These checks verify gateway rejection using SDK test nonces; they do not verify the browser's issuer challenge. The full suite passed 445 tests, including regressions for the outgoing SDK options and the Failed-selection mismatch. The isolated Stage 7 browser smoke also passed without live payment execution.

## Stage boundary

Stage 6 does not add production 3D Secure configuration, exemption strategy, PSD2 legal advice, network-token authentication, a live fraud-rules integration, or a hosted deployment. It does not complete the outstanding Stage 4 public webhook review or the Stage 5 linked-PayPal buyer approval.

## Review required

Before representing Stage 6 as live-verified:

1. Open `/demo` with the connected Braintree Sandbox and select an EUR Card route.
2. Complete the documented frictionless and challenge test-card flows and confirm that the server-observed transaction proof shows liability shift on the resolved account.
3. Run the documented failed-authentication card and confirm that no payment API mutation is requested and the UI remains safely retryable.
4. Repeat on an optional route with authentication enabled and disabled, confirming that the log distinguishes both outcomes.
5. Inspect the Sandbox Control Panel and local activity log to confirm account, currency, instrument, and 3D Secure proof agree and no sensitive authentication artifacts were persisted.

# Stage 1 Changes

**Date:** 15 October 2026

**Status:** Complete — awaiting review before Stage 2

Future work remains governed by `braintree_demo_roadmap.md`.

## Outcome

Stage 1 turns the Stage 0 account catalog into a working Braintree Sandbox routing demonstration.

A presenter can now use `/demo` to:

- Pick a GBP, EUR, USD one-time, USD recurring-preview, or unsupported JPY scenario.
- Preview the server's complete routing decision before a gateway call is made.
- Enter a sandbox card through Braintree Hosted Fields and run a real one-time payment.
- See the selected audience-facing account label, raw merchant account ID, and the reason every configured account matched or was skipped.
- Compare the resolved merchant account with `transaction.merchantAccountId` returned by Braintree.
- Inspect a sanitized gateway result and open the transaction in the Sandbox Control Panel.
- Preview the USD recurring route without executing a recurring payment before Stage 3.

The browser still submits business intent—not a merchant account choice. A supplied `merchantAccountId` is ignored, the server resolves the route again for each gateway operation, and an unsupported intent stops without falling back to the gateway default.

## Routing policy

| Currency | Payment type | Audience-facing label | Merchant account ID | Result |
| --- | --- | --- | --- | --- |
| GBP | One-time or recurring | UK Store – GBP | `paypal2` | Matched |
| EUR | One-time or recurring | EU Store – EUR | `paypal` | Matched |
| USD | One-time | US Store – One-time | `vmUSD` | Matched by demo policy |
| USD | Recurring | US Store – Subscriptions | `vmUSD2` | Matched by demo policy |
| Any unconfigured currency, including JPY | Any | None | None | Explicit no-route result; no Braintree call |

`vmUSD` and `vmUSD2` are versions of the same kind of USD merchant account with different processor configurations. Neither account inherently exists for one-time or recurring payments. Assigning `vmUSD` to one-time payments and `vmUSD2` to recurring payments is a configurable merchant demo policy, not a Braintree restriction or an intrinsic difference in purpose.

## Implementation details

### Routing engine

Added `lib/routing/resolve-route.js` as a pure routing function. It normalizes the currency and payment type, evaluates every catalog row, and returns:

- The normalized intent.
- Whether a route matched.
- A defensive copy of the selected account, or `null`.
- A plain-language reason.
- One trace entry for every configured merchant account.

The engine has no network or filesystem access. It never reads a client-supplied merchant account ID and never substitutes the gateway default when a route is missing.

### Gateway boundary and response verification

Added a shared Braintree gateway module in `lib/braintree/gateway.js`. Its client-token and sale wrappers reject the request before reaching Braintree unless a non-empty `merchantAccountId` is supplied explicitly.

One-time sales include:

- The server-resolved merchant account ID.
- The validated amount.
- Exactly one supported payment source.
- A clearly labelled `routing-demo-...` order ID.
- `submitForSettlement: true`.

`lib/braintree/result.js` builds a safe, allowlisted response summary and independently compares the resolved account with the merchant account returned in Braintree's transaction response. A mismatch is returned as `ROUTE_VERIFICATION_FAILED`, produces an HTTP 502 response, and is recorded as a failed event rather than being presented as a successful payment. Because Braintree has still returned a transaction, the UI warns the presenter not to retry and keeps all submission paths—not only the visible button—blocked until a fresh route preview rebuilds Hosted Fields. The same guard applies when a submitted request has an unknown network outcome or its transaction audit event cannot be saved.

The Sandbox Control Panel transaction link is constructed only from validated merchant and transaction identifiers. The exact sandbox deep-link shape is an implementation inference from Braintree's documented Control Panel pattern and sandbox host; it is not presented as a separately documented API contract.

### Demo API

Added these server-owned JSON endpoints under `/api/demo`:

| Endpoint | Purpose | Gateway behavior |
| --- | --- | --- |
| `POST /api/demo/route-preview` | Returns the route, reason, and complete decision trace | Never calls Braintree |
| `POST /api/demo/client-token` | Resolves intent and creates a client token for the selected account | Calls Braintree only for a supported one-time route |
| `POST /api/demo/payments/one-time` | Resolves intent again, creates a sale, and verifies the returned account | Calls `transaction.sale` with the explicit resolved account |

The recurring route is intentionally preview-only. Client-token generation for recurring checkout returns `STAGE_3_REQUIRED`, and the sale endpoint rejects recurring execution with `ONE_TIME_ONLY`.

Input handling includes an allowlist of known scenario IDs (with an explicit `manual` fallback), strict two-decimal amount validation, a successful-demo amount range of `0.01`–`1999.99`, and clear no-route, invalid-intent, missing-payment-method, gateway-failure, and route-mismatch responses.

Audit persistence errors are reported separately from Braintree errors. If the route event cannot be saved before client-token generation or payment execution, the request stops with `AUDIT_PERSISTENCE_FAILED` and does not call Braintree. If a gateway attempt fails and its failure event also cannot be saved, the response includes `audit.persisted: false` and directs the presenter to check the Sandbox Control Panel before retrying.

### Scenario runner and Hosted Fields

The `/demo` page is now an interactive scenario runner with presets for:

- UK one-time purchase in GBP.
- EU one-time purchase in EUR.
- US one-time purchase in USD.
- US recurring route preview in USD, labelled for Stage 3.
- Unsupported JPY intent.

Presenters can also choose currency and payment type manually. Selecting USD recurring resolves to `vmUSD2` and displays “Route preview only”; the page does not initialize payment fields or send a transaction for that choice.

Card entry uses Braintree Hosted Fields with the Braintree JavaScript v3 client. Raw card number, expiry, and CVV values stay inside Braintree-controlled fields and never reach this server. The generated client token is used by the browser to initialize Hosted Fields but is not rendered, logged, or stored. The resulting payment-method nonce is sent only to the sale endpoint and is never echoed into the inspector, server logs, or event store.

The routing inspector shows:

- Normalized intent.
- Selected display label and raw merchant account ID.
- Human-readable routing reason.
- Every match/skip decision in catalog order.
- The redacted server request.
- An allowlisted Braintree result containing transaction and processor-response fields.
- The independent route-verification result.
- A Sandbox Control Panel link after a transaction is returned.

Status is conveyed with text as well as colour, focus states remain visible, dynamic updates use live regions, and reduced-motion behavior remains supported.

### Redaction and event store

Added `lib/inspector/redact.js` to produce deep, non-mutating, JSON-safe copies before data reaches the UI or persistent audit trail. It redacts credentials, authorizations, client tokens, payment nonces, vaulted tokens, raw card data, email addresses, embedded secret values, binary data, and common credential fields while deliberately retaining `merchantAccountId` as the proof this demo needs.

Added an append-only event store in `lib/events/store.js` with `append`, `list`, `get`, and `clear` operations. It:

- Records route-resolution activity and transaction attempts/results.
- Redacts data before keeping it in memory and before writing it to disk.
- Persists atomically to `data/runtime/events.json`.
- Uses a short-lived cross-process lock and reloads current disk state before each write, so the running server and `verify:sandbox` cannot overwrite one another's events.
- Uses defensive copies for data returned to callers.
- Keeps runtime data out of version control through `/data/runtime/` in `.gitignore`.

The Stage 1 UI does not expose the event list. The transaction-log page remains deferred to Stage 2.

### Existing route hardening

The pre-existing API continues to work through the shared gateway wrapper:

- `/api/client-token` explicitly uses the configured GBP one-time route (`paypal2`).
- `/api/create-transaction` explicitly uses the same GBP route.
- Pre-existing recurring-style storefront calls remain explicitly on the gateway-default GBP route (`paypal2`), matching their legacy client token and preserving their pre-Stage-1 behavior. The real USD recurring route remains preview-only until Stage 3.
- Every legacy sale now verifies the returned merchant account and writes redacted route and transaction events through the same audit foundation.

This applies the “explicit merchant account on every supported gateway call” invariant without turning the older storefront pages into a second scenario runner. Raw payment nonces are no longer written to server or browser output, and webhook activity is redacted before storage or display.

### Sandbox verification command

Added `npm run verify:sandbox`. It resolves the GBP, EUR, and USD one-time routes, creates one clearly labelled small sandbox sale for each, and fails if the merchant account returned by Braintree differs from the selected route. It prints only safe transaction proof and appends redacted audit events.

No new npm dependency was required for Stage 1. The implementation uses the existing Braintree Node SDK, Express, Handlebars, vanilla browser JavaScript, and the official Braintree Web v3 scripts.

## Files added

| File | Purpose |
| --- | --- |
| `lib/routing/resolve-route.js` | Pure intent-to-account resolver with a full decision trace |
| `lib/braintree/gateway.js` | Sandbox gateway construction and explicit-account wrappers |
| `lib/braintree/result.js` | Safe response summaries, account verification, and Control Panel link construction |
| `lib/inspector/redact.js` | Deep redaction and JSON-safe serialization |
| `lib/events/store.js` | Atomic, persistent, append-only demo event store |
| `routes/demo-api.js` | Route preview, routed client-token, and one-time payment endpoints |
| `public/scripts/demo.js` | Scenario runner, Hosted Fields lifecycle, payment submission, and inspector rendering |
| `scripts/verify-sandbox.js` | Opt-in live verification for all three one-time currency routes |
| `test/resolve-route.test.js` | Resolver coverage, including no-route and untrusted-account input |
| `test/braintree-gateway.test.js` | Wrapper, result-sanitization, and account-verification tests |
| `test/demo-api.test.js` | Endpoint, no-call, redaction, audit-failure, and route-mismatch tests using fakes |
| `test/demo-client.test.js` | Fake-DOM browser-flow tests for mismatch, network, gateway, and audit-warning retry locks |
| `test/redact.test.js` | Sensitive-field, embedded-value, cycle, and SDK-object redaction tests |
| `test/event-store.test.js` | Persistence, defensive-copy, redaction, validation, and clear tests |
| `docs/STAGE_1_CHANGES.md` | Stage 1 implementation, verification, and review record |

## Files modified

| File | Change |
| --- | --- |
| `config/merchant-accounts.js` | Adds clear audience-facing labels while retaining raw IDs and the explicit USD demo-policy explanation |
| `app.js` | Registers the new API router at `/api/demo` |
| `routes/demo.js` | Supplies the five scenario presets and the Stage 1 view model |
| `views/demo.hbs` | Replaces the Stage 0 overview with the interactive runner and inspector |
| `public/stylesheets/demo.css` | Adds responsive runner, Hosted Fields, trace, result, and verification states |
| `routes/api.js` | Routes all supported legacy gateway calls through wrappers with explicit account IDs |
| `routes/store.js` | Stops reading PayPal email addresses from success-page query strings |
| `routes/webhooks.js` | Redacts webhook input before retaining activity and avoids raw-payload logging |
| `views/webhook-activity.hbs` | Renders webhook activity with safe DOM text nodes instead of HTML interpolation |
| `public/scripts/payment-flow.js` | Removes raw SDK error objects and PayPal email propagation from legacy browser flows |
| `views/basic.hbs` | Removes legacy nonce, email, response, and raw SDK-error console logging |
| `views/success.hbs` | Removes the PayPal email field from the legacy success page |
| `package.json` | Adds the opt-in `verify:sandbox` command |
| `.gitignore` | Ignores persistent runtime event data |
| `test/merchant-accounts.test.js` | Verifies the audience labels and policy metadata |
| `test/demo.test.js` | Verifies the Stage 1 view model, rendered runner, escaped output, retry guard wiring, and legacy email removal |

The pre-existing untracked `setup_gar_npm.sh` file was not changed.

## Verification performed

### Automated and local checks

- Ran `npm test`: **57 tests passed** with no live Braintree calls from the test suite.
- Confirmed `GET /demo` returned HTTP 200 on local port 3137.
- Confirmed `GET /health` returned HTTP 200.
- Confirmed a GBP one-time `POST /api/demo/route-preview` returned HTTP 200, selected `paypal2`, and included all four trace entries even when the request contained a malicious client-supplied merchant account ID.
- Confirmed a JPY one-time route preview returned HTTP 200 with `matched: false`, `account: null`, and four skipped checks.
- Repeated a final post-fix preview across GBP one-time, EUR one-time, USD one-time, USD recurring, and JPY; the results were `paypal2`, `paypal`, `vmUSD`, `vmUSD2`, and `NO_ROUTE`, with four trace checks each and no client merchant-account field echoed.
- Confirmed the existing `/`, `/basic`, `/devices`, and `/api/webhooks/activity` routes all returned HTTP 200.
- Rendered the `demo`, `basic`, and `success` Handlebars views after the final privacy hardening.
- Passed `node --check` for every JavaScript source file and `npm ci --dry-run --offline`.
- Rechecked the ignored runtime event store: 18 events, file mode `0600`, no forbidden sensitive keys, nonce/token values, or email-like values.
- Confirmed `git diff --check` completed without whitespace errors.

A controlled browser was unavailable. No visual browser verification is claimed; UI verification was limited to source review, rendered markup checks, accessibility review, and local HTTP behavior.

### Live Braintree Sandbox verification

`npm run verify:sandbox` created and verified these submitted sandbox transactions:

| Currency | Amount | Selected and returned account | Transaction ID | Status | Verified |
| --- | ---: | --- | --- | --- | --- |
| GBP | 10.11 | `paypal2` | `g2678x7m` | `submitted_for_settlement` | Yes |
| EUR | 10.12 | `paypal` | `jf21fywh` | `submitted_for_settlement` | Yes |
| USD | 10.13 | `vmUSD` | `aetmrepv` | `submitted_for_settlement` | Yes |

All three Braintree responses returned the merchant account selected by the routing engine. The transactions remain in the Braintree Sandbox; clearing local demo data does not alter the Control Panel.

## Running and reviewing Stage 1

With a populated `config.env` or `.env`:

```bash
npm ci
npm test
npm start
```

Open:

```text
http://localhost:3000/demo
```

If port 3000 is occupied, start with another port, for example:

```bash
PORT=3137 npm start
```

Suggested review sequence:

1. Select the GBP scenario and inspect all four decision-trace entries.
2. Use sandbox card `4111 1111 1111 1111`, any future expiry, and any three-digit CVV; run the payment and confirm the returned account is `paypal2`.
3. Repeat for EUR and USD, confirming `paypal` and `vmUSD` respectively.
4. Select JPY and confirm the result is “No route,” card fields remain unavailable, and no gateway operation is offered.
5. Select USD with recurring billing and confirm the preview selects `vmUSD2` while execution remains disabled and labelled for Stage 3.
6. Inspect the redacted request, sanitized Braintree result, verification message, and Control Panel link after a completed transaction.

To repeat the direct live sandbox route check intentionally:

```bash
npm run verify:sandbox
```

This command creates three additional submitted-for-settlement Sandbox transactions, one per supported one-time currency.

## Stage boundary

Stage 1 does **not** include:

- A transaction-log page, filtering, capture, void, settlement, refund, or decline simulation.
- Vaulting or charging a stored payment method.
- Executing recurring payments or running a simulated billing cycle.
- PayPal, Venmo, Apple Pay, Google Pay, or other additional payment methods in the new runner.
- 3D Secure verification.
- Webhook-driven dispute handling.
- Presenter-controlled route editing, preflight checks, or visual reset controls.

Those remain assigned to later stages. Under the current roadmap, Stage 2 begins with the persistent transaction-log page, post-payment operations, and decline simulation. No Stage 2 work should begin until this Stage 1 review gate is approved.

## Official Braintree documentation used

Only official PayPal/Braintree developer documentation was used for the Braintree-specific implementation:

- [Generate a client token — Node.js](https://developer.paypal.com/braintree/docs/reference/request/client-token/generate/node/) — passing the resolved `merchantAccountId` during token generation.
- [Create a transaction with `transaction.sale` — Node.js](https://developer.paypal.com/braintree/docs/reference/request/transaction/sale/node/) — explicit merchant-account routing and `submitForSettlement`.
- [Transaction response — Node.js](https://developer.paypal.com/braintree/docs/reference/response/transaction/node) — transaction ID, status, currency, amount, merchant account, payment instrument, and processor-response fields.
- [Testing and Go Live — Node.js](https://developer.paypal.com/braintree/docs/reference/general/testing/node/) — documented sandbox payment values and behavior used by the UI and verification script.
- [Hosted Fields overview — JavaScript v3](https://developer.paypal.com/braintree/docs/guides/hosted-fields/overview/javascript/v3/) — secure hosted card-entry architecture.
- [Hosted Fields setup and integration — JavaScript v3](https://developer.paypal.com/braintree/docs/guides/hosted-fields/setup-and-integration/javascript/v3/) — client creation, field setup, and tokenization flow.
- [Client SDK setup — JavaScript v3](https://developer.paypal.com/braintree/docs/guides/client-sdk/setup/javascript/v3/) — loading and initializing the Braintree Web client.
- [Braintree Auth reference — Node.js](https://developer.paypal.com/braintree/docs/guides/braintree-auth/reference/node/) — merchant-context and Control Panel reference material consulted for the transaction-link behavior.

## Review required before Stage 2

Please review the four route outcomes, the Hosted Fields payment flow, the inspector's sanitized result, and the live returned-account proof. In particular, confirm that the USD presentation consistently describes `vmUSD` and `vmUSD2` as processor variants whose one-time/recurring split is merchant-controlled demo policy.

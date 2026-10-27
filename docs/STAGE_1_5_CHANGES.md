# Stage 1.5 Changes

**Date:** 18 October 2026

**Status:** Complete — awaiting review before Stage 2

Future work remains governed by `braintree_demo_roadmap.md`.

## Outcome

Stage 1.5 replaces the Stage 1 gateway-specific account list with runtime discovery, an optional merchant policy overlay, and deterministic automatic assignment.

Changing the Braintree Sandbox credentials and restarting the application now causes the demo to:

- Discover the connected gateway's merchant accounts, currencies, statuses, and default account.
- Build a new routing catalog without code changes or a cached account fallback.
- Apply a policy file for that gateway when one exists, or assign usable routes automatically when it does not.
- Generate the scenario presets, currency picker, account registry, legacy storefront routes, and verification run from the discovered catalog.
- Display and charge storefront prices in the connected gateway's default account currency.
- Validate every merchant account ID against the current active discovery result immediately before either supported Braintree SDK call.

The current gateway's local policy preserves the Stage 1 route split. In particular, `vmUSD` and `vmUSD2` remain processor variants whose one-time/recurring roles are merchant-controlled demo policy; neither account has an intrinsic Braintree purpose restriction.

## Pre-change findings confirmed

Code inspection and fake-gateway tests confirmed all eight findings from the Stage 1.5 specification:

1. Stage 1's `config/merchant-accounts.js` contained the four-account allowlist and did not derive membership from Braintree.
2. Route preview did not call Braintree, so stale hardcoded accounts could appear to route successfully on another gateway.
3. Client-token generation was not a reliable stale-ID check. Braintree documents that an unknown `merchantAccountId` can silently produce a token for the gateway default account; the later sale would then fail when it explicitly used that unknown ID. This finding has been corrected from the earlier assumption that token generation itself would expose the stale account.
4. The legacy client-token, transaction, and storefront paths were pinned to the Stage 1 default account.
5. `verify:sandbox` enumerated the Stage 1 routes rather than discovering them.
6. Scenario presets and the currency picker assumed GBP, EUR, USD, USD recurring, and unsupported JPY.
7. Amount validation assumed two decimal places, which is invalid for Braintree zero-decimal currencies such as JPY.
8. The default-account flag came from static configuration rather than the gateway.

The wider hardcode audit also found gateway-specific currency and formatting assumptions in the legacy API, browser payment flow, storefront templates, verification script, and tests. The storefront contained literal pound/dollar presentation, the browser forced two-decimal formatting, and the verification script knew its currency list in advance. The Sandbox Control Panel link builder already read the gateway merchant ID from configuration; no literal merchant ID was found there.

Runtime-source tests now fail if the former known account IDs appear outside policy files, tests, or documentation, or if the Stage 1 gateway currencies escape the dedicated currency configuration and scenario fallback modules.

## Implementation details

### Runtime merchant-account discovery

Added a read-only discovery layer around Braintree's `merchantAccount.all` API. The Node SDK supplies the fully collected account list to its callback, after which the application normalizes each row to:

```text
merchantAccountId · currency · status · isDefault
```

Discovery runs:

- Once before the server begins listening.
- On demand through `POST /api/demo/catalog/refresh`.
- When `npm run verify:sandbox` starts.

There is no timed refresh and no offline or cached catalog. A refresh clears the usable catalog before its network work begins, so requests cannot continue routing against a stale snapshot while discovery is in flight.

Discovery fails closed when Braintree returns an error, an empty or malformed account list, anything other than exactly one active default account, or a currency without a valid configured demo rate. The server still starts for Sandbox credential and network failures, but `/demo` displays a safe gateway-unavailable state and every routing or storefront gateway endpoint returns `CATALOG_UNAVAILABLE` without making a Braintree payment call. Explicit production configuration is rejected because this demo remains Sandbox-only.

Catalog state records:

- `status`: `not_run`, `ok`, or `failed`.
- The configured gateway merchant ID.
- The successful discovery timestamp.
- Safe presenter-facing errors and policy warnings.
- Policy status and the current built accounts.

Accessors continue to return frozen defensive copies.

### Policy overlay and automatic assignment

Routing policy files live at:

```text
config/routing-policies/<merchantId>.json
```

`config/routing-policies/example.json` documents the format. Real gateway policy files are ignored by Git unless the human explicitly decides to commit one. A local ignored policy for the current gateway preserves the Stage 1 labels and routes:

| Currency | Payment type | Merchant account | Role source |
| --- | --- | --- | --- |
| GBP | One-time and recurring | `paypal2` | Merchant policy |
| EUR | One-time and recurring | `paypal` | Merchant policy |
| USD | One-time | `vmUSD` | Merchant policy |
| USD | Recurring | `vmUSD2` | Merchant policy |

The policy may assign labels and payment roles, but it cannot create accounts or override currency, status, or default-account data. Those fields always come from discovery.

Policy handling is safe and visible:

- An account missing from discovery is ignored with a warning.
- An inactive account receives no route.
- A merchant-ID mismatch ignores the whole file.
- Duplicate active currency/payment-type routes reject the whole policy and activate automatic assignment.
- Missing, unreadable, or invalid policy files produce warnings and activate automatic assignment rather than stopping discovery.

Automatic assignment is deterministic. A currency with one active account assigns both roles to that account. With several active accounts, the gateway default in that currency is preferred; otherwise the alphabetically first account ID handles the unclaimed roles. Remaining accounts stay visible as **Available, not assigned**. Each assigned role records whether it came from `policy` or `auto`, and that source appears in the route explanation and account registry.

### Current-catalog invariant at the gateway boundary

Every operation that is about to send a `merchantAccountId` to Braintree now proves that the ID is an active member of the current discovered catalog.

This check happens inside the shared gateway wrapper immediately before:

- `clientToken.generate`
- `transaction.sale`

Unknown, removed, inactive, stale, or unavailable-catalog IDs are rejected locally. This is especially important for client-token generation because Braintree can silently fall back to the default account for an unknown ID. Route resolution alone is not treated as proof: the wrapper asks the live in-memory catalog service again for every call, so a refresh immediately invalidates an earlier selection.

Gateway-spy tests prove that neither SDK method is invoked for unknown, inactive, removed-after-refresh, or catalog-unavailable IDs.

### Dynamic scenarios and routing demo

The Stage 1 scenario runner is now generated from the current catalog:

- One one-time scenario per discovered currency.
- A recurring preview only when that currency's recurring route uses a different account from its one-time route.
- One unsupported-currency scenario selected from the first absent currency in the fixed JPY, CHF, SEK, NOK, PLN, CZK fallback list.

The currency picker, amount defaults, symbols, decimal precision, minimum, maximum, and input step are generated from the same catalog and currency metadata. A discovered JPY account therefore becomes a supported route and the no-route scenario advances to CHF rather than making a false claim.

The account registry now displays:

- The connected gateway merchant ID and last discovery time.
- Policy status and safe overlay warnings.
- A manual **Refresh accounts** control.
- Every discovered account's label, raw ID, currency, status, default flag, assigned payment types, role source, and unassigned state.

Refresh replaces the scenarios and picker on reload. Failed discovery immediately tears down Hosted Fields, disables the runner, clears the current routing proof, hides the stale account registry and metadata, and presents a plain-language unavailable state while keeping the retry control available.

### Dynamic currency and fixed demo rates

Added a dedicated fixed-rate configuration expressed as target-currency units per GBP, with GBP fixed at `1`. It covers every currency in Braintree's currency reference and is deliberately never fetched from an exchange-rate service.

The application validates at discovery time that every connected currency has a positive, finite configured rate. An unknown or invalid rate makes the catalog unavailable instead of silently substituting a value.

Currency handling now:

- Converts each existing GBP base price exactly once on the server.
- Rounds once, half up, to the target currency's Braintree-supported precision.
- Uses whole numbers for Braintree's zero-decimal currencies.
- Uses canonical strings for amounts sent by the browser and server.
- Formats displayed prices with `Intl.NumberFormat` using the same precision.
- Labels converted values as `Fixed demo rate: GBP 1 = <CURRENCY> <RATE> — not a live FX quote`.
- Prevents the browser or request payload from supplying or overriding the rate.

The routing runner keeps its successful-demo range as `0.01`–`1999.99` for two-decimal currencies and `1`–`1999` for zero-decimal currencies. A decimal point is rejected for JPY and every other zero-decimal currency before a sale can be attempted.

### Dynamic legacy storefront

The legacy storefront now uses the connected gateway default account's currency, then resolves the one-time and recurring routes for that currency from the current catalog. It no longer assumes a particular account ID or GBP/USD value.

Product, device, setup, monthly, installment, recurring, and unscheduled amounts are converted from their existing GBP bases in the server view model. The same canonical converted values and currency are carried into browser billing payloads and validated again by the API. One-time checkout requests a client token for the one-time route; recurring and vault-style checkout requests one for the recurring route. Only the payment-type intent is accepted, so a browser-supplied merchant account ID is rejected before catalog or gateway work. A client currency mismatch, an unavailable catalog, or a missing default-currency route stops before Braintree.

This changes only presentment and routing for the existing storefront flows. It does not add vaulted subscription billing, which remains Stage 3 work.

### Health, startup, and event identity

`GET /health` now reports the last discovery state as `merchantAccountDiscovery`, together with `gatewayMerchantId` and `discoveredAt`. It does not refresh the catalog, so `braintreeConnectivity` correctly remains `not_checked` for the health request itself.

Server startup loads Sandbox configuration, installs the runtime catalog service, awaits initial discovery, and only then begins listening. Safe startup diagnostics report whether discovery succeeded without exposing credentials or raw gateway errors.

Every newly appended audit event receives `gatewayMerchantId` from the server-owned event store. Callers cannot spoof it, and an event is not persisted if the current gateway identity is unavailable. Existing stored events without this field remain unchanged for backward compatibility. Stage 2 can therefore filter new records by gateway while retaining earlier history.

### Dynamic Sandbox verifier

`npm run verify:sandbox` now:

1. Performs fresh discovery and prints the safe account, route, and role-source summary.
2. Resolves one one-time route per discovered currency.
3. Generates a small valid amount with that currency's precision.
4. Submits the sale to the resolved account.
5. Verifies the returned `transaction.merchantAccountId` and records a redacted event.

It exits clearly if discovery fails and skips a discovered currency that has no active one-time route. Running it is opt-in because it creates submitted Braintree Sandbox transactions.

## Files added

| File | Purpose |
| --- | --- |
| `config/demo-currency.js` | Complete fixed GBP demo-rate table, Braintree currency list, and zero-decimal metadata |
| `config/routing-policies/example.json` | Safe example of the per-gateway routing-policy format |
| `lib/braintree/discover-merchant-accounts.js` | Read-only merchant-account discovery and normalization |
| `lib/catalog/build-catalog.js` | Policy overlay, deterministic auto-assignment, role sources, and catalog construction |
| `lib/catalog/copies.js` | Deep-freeze and defensive-copy helpers |
| `lib/catalog/errors.js` | Typed catalog-unavailable and account-membership errors |
| `lib/catalog/index.js` | Catalog public API |
| `lib/catalog/policy.js` | Safe policy-file loading and warnings |
| `lib/catalog/runtime.js` | Process-wide current catalog service with an unavailable default state |
| `lib/catalog/service.js` | Refresh lifecycle, fail-closed state, rate validation, and membership invariant |
| `lib/catalog/validate-catalog.js` | Validation for the dynamically built routing catalog |
| `lib/currency/index.js` | Conversion, formatting, precision, canonical validation, and demo amount helpers |
| `lib/demo/scenarios.js` | Catalog-derived scenario and unsupported-currency generation |
| `test/currency.test.js` | Rate coverage, conversion, precision, rounding, ranges, and fail-closed tests |
| `test/dynamic-catalog.test.js` | Overlay, automatic assignment, discovery failure, refresh, and defensive-copy tests |
| `test/health-status.test.js` | Last-discovery health reporting without network calls |
| `test/merchant-account-discovery.test.js` | SDK discovery, normalization, two-page collection, and safe-failure tests |
| `test/routing-policy.test.js` | Policy loading, merchant mismatch, and safe filename tests |
| `test/runtime-source-invariants.test.js` | Static account-ID and gateway-currency hardcode checks |
| `test/scenarios.test.js` | Dynamic scenario, recurring-preview, and unsupported fallback tests |
| `test/storefront-api.test.js` | Dynamic default-currency route and pre-gateway rejection tests |
| `test/storefront-currency.test.js` | Server-side conversion, labels, browser payloads, and zero-decimal storefront tests |
| `docs/STAGE_1_5_CHANGES.md` | Stage 1.5 implementation, verification status, and review record |

## Files modified

| File | Change |
| --- | --- |
| `.env.example` | Makes the Sandbox-only environment explicit |
| `.gitignore` | Ignores real gateway policy JSON while allowing the example file |
| `config/merchant-accounts.js` | Replaces the static catalog with compatibility accessors for the runtime service |
| `app.js` | Adds dynamic health reporting, dependency injection, and safe catalog-unavailable handling |
| `server.js` | Runs initial discovery before listening and installs a safe failed service when Sandbox configuration is unavailable |
| `lib/braintree/gateway.js` | Revalidates every account ID against the current catalog before token or sale SDK calls |
| `lib/events/store.js` | Adds server-owned gateway identity to new events while preserving legacy events |
| `lib/routing/resolve-route.js` | Receives the built catalog explicitly and exposes policy/automatic route reasons |
| `routes/demo-api.js` | Uses the runtime catalog, dynamic amount rules, safe failure handling, and refresh endpoint |
| `routes/demo.js` | Builds discovery metadata, dynamic accounts, currencies, scenarios, and unavailable state |
| `routes/store.js` | Converts GBP base prices into the discovered default account currency |
| `routes/api.js` | Resolves storefront routes dynamically and validates canonical currency amounts |
| `public/scripts/demo.js` | Applies per-currency precision and refreshes discovery from the runner |
| `public/scripts/payment-flow.js` | Removes gateway-specific currency and forced two-decimal browser assumptions |
| `public/stylesheets/demo.css` | Adds discovery, policy-warning, role-source, unassigned, and unavailable presentation states |
| `views/demo.hbs` | Displays live discovery metadata, refresh controls, account sources, and demo-rate labels |
| `views/layouts/main.hbs` | Supplies the dynamic storefront currency and fixed-rate disclosure |
| `views/layouts/store.hbs` | Displays converted currency context and the fixed demo-rate disclosure |
| `views/basic.hbs` | Uses dynamic plan/storefront currency without forced two-decimal formatting |
| `views/bundled.hbs` | Uses server-converted setup and recurring amounts |
| `views/device-detail.hbs` | Uses converted device amounts and canonical billing data |
| `views/index.hbs` | Uses converted product amounts |
| `views/installments.hbs` | Uses converted installment amounts |
| `views/recurring.hbs` | Uses converted recurring amounts |
| `views/subscription.hbs` | Uses converted subscription amounts |
| `views/unscheduled.hbs` | Uses converted unscheduled-payment amounts |
| `scripts/verify-sandbox.js` | Discovers routes and verifies one sale per discovered one-time currency route |
| `test/braintree-gateway.test.js` | Adds SDK-spy proof for unknown, inactive, stale, and unavailable-catalog IDs |
| `test/demo-api.test.js` | Replaces fixed catalog assumptions with refresh, dynamic JPY, and fail-closed coverage |
| `test/demo-client.test.js` | Covers dynamic currency controls, refresh, and unavailable states |
| `test/demo.test.js` | Covers discovery metadata, generated UI, escaping, and safe failure rendering |
| `test/event-store.test.js` | Covers server-owned gateway identity and legacy-event compatibility |
| `test/merchant-accounts.test.js` | Verifies runtime-service compatibility accessors and dynamic catalog validation |
| `test/resolve-route.test.js` | Uses built catalog fixtures and checks role-source explanations |
| `docs/braintree_demo_roadmap.md` | Inserts Stage 1.5 and carries dynamic-gateway requirements into later stages |
| `docs/stage_1.5_dynamic_merchant_accounts.md` | Corrects the client-token fallback finding and makes pre-SDK membership validation explicit |

The pre-existing untracked `setup_gar_npm.sh` file was not changed.

## Verification performed

### Automated checks

- Ran `npm test`: **125 tests passed**, including the retained Stage 1 coverage.
- The test suite makes no live Braintree calls.
- Fake gateways cover the current four-account policy, policy-free automatic assignment, single- and multi-currency gateways, JPY, inactive accounts, inactive-default rejection, invalid overlays, discovery failure, refresh replacement, legacy routes, and storefront conversion.
- A regression test drives the installed Braintree SDK collector across two merchant-account pages and proves discovery receives every account before normalization.
- Gateway spies confirm unknown, inactive, stale, and unavailable-catalog IDs cause zero `clientToken.generate` and zero `transaction.sale` calls.
- Browser tests prove a failed refresh invalidates both the runner and stale account registry. Split-route storefront tests prove one-time and recurring client tokens use their respective server-resolved accounts and reject merchant-account injection.
- Static source checks confirm the known Stage 1 account allowlist is absent from runtime code and gateway-specific currencies remain confined to approved configuration modules.

### Live discovery and HTTP verification

Live discovery with the current credentials found all four merchant accounts active. The current gateway policy was applied with no warnings, preserving the Stage 1 routes.

HTTP smoke checks passed for:

- `GET /health`
- `GET /demo`
- `GET /`
- `GET /basic`
- `GET /devices`
- `GET /api/webhooks/activity`
- `GET /api/client-token?paymentType=recurring` without displaying the returned token
- Three `POST /api/demo/route-preview` requests
- `POST /api/demo/catalog/refresh`

The route previews also confirmed that a supplied `merchantAccountId` is ignored and routing remains server-owned. The final client-token check returned HTTP 200 for the recurring intent, while a request that also supplied `merchantAccountId` returned `INVALID_CLIENT_TOKEN_INTENT` before gateway access:

| Intent | Result |
| --- | --- |
| GBP one-time | Routed to `paypal2` |
| USD recurring | Routed to `vmUSD2` for Stage 3 preview |
| JPY one-time | Explicit no-route result; no account selected |

The policy file was temporarily moved aside for a live automatic-assignment check. The resulting catalog assigned:

| Currency | Merchant account | Automatic assignment |
| --- | --- | --- |
| EUR | `paypal` | One-time and recurring |
| GBP | `paypal2` | One-time and recurring; gateway default |
| USD | `vmUSD` | One-time and recurring |
| USD | `vmUSD2` | Available, not assigned |

The current gateway policy file was restored after this check.

### Live routed-sale verification

`npm run verify:sandbox` completed successfully and proved that the selected account matched the merchant account returned by Braintree for every discovered one-time currency route:

| Currency | Amount | Selected account | Returned account | Transaction ID | Status | Verified |
| --- | ---: | --- | --- | --- | --- | --- |
| EUR | 20.92 | `paypal` | `paypal` | `0s3fcm1k` | `submitted_for_settlement` | Yes |
| GBP | 17.91 | `paypal2` | `paypal2` | `5xvet91f` | `submitted_for_settlement` | Yes |
| USD | 13.51 | `vmUSD` | `vmUSD` | `3gzmk7cj` | `submitted_for_settlement` | Yes |

All 23 Stage 1.5 audit events present after the final HTTP check contained the server-owned `gatewayMerchantId`. The three verifier transaction events recorded successful outcomes and matching returned accounts.

These submitted Sandbox transactions remain in the Braintree Control Panel and are not affected by any future visual demo-data reset.

### Verification limits

A second Sandbox gateway was not available, so cross-gateway verification used fake-gateway tests only. Those tests exercise different account IDs, currencies, account counts, default accounts, statuses, and refresh changes without any Stage 1 allowlist.

A controlled browser was also unavailable. Browser visual interaction was therefore not manually exercised; UI verification used HTTP-rendered markup plus the automated client, view, accessibility-source, and escaping tests.

## Running and reviewing Stage 1.5

With populated Sandbox credentials in `config.env` or `.env`:

```bash
npm ci
npm test
npm start
```

Open:

```text
http://localhost:3000/demo
```

Suggested review sequence:

1. Confirm the gateway merchant ID, discovery timestamp, policy status, and account count at the top of `/demo`.
2. Inspect each account's raw ID, discovered currency/status/default flag, payment roles, and policy or automatic source.
3. Preview each generated one-time scenario and any split recurring route; confirm the selected account and trace match the registry.
4. Inspect the fixed demo-rate disclosure and switch currencies, checking the amount precision and range.
5. Use **Refresh accounts** and confirm the discovery timestamp and catalog-driven controls reload.
6. Review the legacy storefront in the gateway default account currency and confirm its prices carry the fixed demo-rate label.
7. With a test double or deliberately stale selection, confirm an account removed by refresh is blocked before either gateway SDK operation.

To perform the opt-in live transaction check:

```bash
npm run verify:sandbox
```

## Stage boundary

Stage 1.5 does **not** include:

- Production gateway support.
- Runtime switching among multiple credential sets without a restart.
- Cached or offline account data.
- A presenter UI for editing policy overlays.
- The Stage 2 transaction-log page, gateway filtering UI, post-payment operations, or decline simulation.
- Vaulted payment methods or executable recurring billing.
- Additional payment methods, 3D Secure, or dispute handling.

Those remain assigned to later stages. Stage 2 must use `gatewayMerchantId` when filtering the event log and must respect each currency's decimal precision for decline-test amounts. No Stage 2 work should begin until this Stage 1.5 review gate is approved.

## Official Braintree documentation used

Only official PayPal/Braintree documentation was used for Braintree-specific behavior:

- [List all merchant accounts — Node.js](https://developer.paypal.com/braintree/docs/reference/request/merchant-account/all/node/) — runtime discovery through `merchantAccount.all`.
- [Merchant account response — Node.js](https://developer.paypal.com/braintree/docs/reference/response/merchant-account/node/) — account ID, currency, status, and default-account fields.
- [Generate a client token — Node.js](https://developer.paypal.com/braintree/docs/reference/request/client-token/generate/node/) — documents the unknown merchant-account fallback that requires local current-catalog validation.
- [Create a transaction with `transaction.sale` — Node.js](https://developer.paypal.com/braintree/docs/reference/request/transaction/sale/node/) — explicit account routing for sales.
- [Supported currencies](https://developer.paypal.com/braintree/docs/reference/general/currencies) — supported currency list and currencies that do not accept decimal places.
- [Testing and Go Live — Node.js](https://developer.paypal.com/braintree/docs/reference/general/testing/node/) — Sandbox-only payment verification behavior.
- [Braintree Auth multi-currency — Node.js](https://developer.paypal.com/braintree/docs/guides/braintree-auth/multi-currency/node/) — merchant-account and currency context.

## Review required before Stage 2

Please review discovery failure behavior, active-default validation, current-catalog enforcement at both Braintree call sites, policy warnings and automatic assignment, generated scenarios, zero-decimal handling, and default-currency storefront conversion.

In particular, confirm that:

- Client-token generation is no longer treated as validation of a merchant account ID.
- The demo never routes against a hardcoded or previously cached account list.
- Fixed rates are clearly presented as demo values rather than live foreign-exchange quotes.
- The current USD split is described only as merchant demo policy between processor variants.

After Stage 1.5 is approved, Stage 2 can begin.

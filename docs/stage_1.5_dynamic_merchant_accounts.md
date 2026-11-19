# Stage 1.5: Dynamic Merchant Account Discovery

**Audience:** AI coding agent working in the existing repository.
**Starting point:** Stage 1 is complete (see `docs/STAGE_1_CHANGES.md`).
**Insert into roadmap:** between Stage 1 and Stage 2 in `braintree_demo_roadmap.md`.
**Rules:** all ground rules in `braintree_demo_roadmap.md` still apply, including the stop-for-review gate.

---

## 1. Goal

The demo must work with **any Braintree Sandbox gateway just by changing credentials**, with no code or config edits.

The merchant account list, routing table, scenarios, currency picker, legacy storefront account, and `verify:sandbox` must all be derived from what the configured gateway actually contains.

---

## 2. Problem to confirm first

Before changing anything, confirm and record in the CHANGES file how the current build behaves with credentials for a different gateway. Do this by code inspection and by unit tests with a fake gateway; do not use real third-party credentials. The expected findings are:

1. `config/merchant-accounts.js` hardcodes four merchant account IDs (`paypal`, `paypal2`, `vmUSD`, `vmUSD2`). Nothing derives them from the gateway.
2. `POST /api/demo/route-preview` makes no Braintree call, so it keeps "succeeding" with accounts that do not exist on the new gateway. This is the most dangerous failure because it looks correct.
3. `POST /api/demo/client-token` does **not** reliably expose a stale or unknown hardcoded account ID: Braintree silently generates the client token for the gateway's default merchant account when the supplied `merchantAccountId` is not found. The later one-time sale fails when it explicitly uses that unknown account ID. This fallback is documented in Braintree's [client-token generation reference](https://developer.paypal.com/braintree/docs/reference/request/client-token/generate/node/) and makes server-side catalog validation essential.
4. Legacy `/api/client-token` and `/api/create-transaction` are pinned to `paypal2` and fail.
5. `npm run verify:sandbox` fails.
6. The scenario presets (GBP, EUR, USD, USD recurring, JPY) and the currency picker are hardcoded. The "unsupported JPY" scenario becomes wrong if the new gateway has a JPY account.
7. The two-decimal amount validation is wrong for zero-decimal currencies such as JPY.
8. The default-account flag (`paypal2`) is hardcoded rather than read from the gateway.

If any finding differs from what you see in the code, report it and stop.

Also search the codebase for every other hardcoded merchant account ID, merchant ID, or currency (views, scripts, the Control Panel link builder, storefront templates, tests), and list them.

---

## 3. Target design

### 3.1 Three layers

| Layer | Source | Decides |
| --- | --- | --- |
| **Discovery** | Braintree API, at runtime | Which merchant accounts exist, plus each one's currency, status, and default flag |
| **Policy overlay** (optional) | A file keyed by the gateway's merchant ID | Which payment types each account handles, plus display labels |
| **Auto-assignment** | Deterministic rules in code | Payment types and labels for anything the overlay does not cover |

The routing catalog is built by combining these three layers. `resolveRoute` keeps its existing pure-function signature and receives the built catalog. Its behaviour (decision trace, no fallback to the default, ignoring any client-supplied account ID) must not change.

### 3.2 Discovery

- Add `lib/braintree/discover-merchant-accounts.js`.
- Use the Braintree Node SDK's call for listing all merchant accounts, and handle pagination. Verify the method name, its response fields, and its pagination behaviour against the official Braintree documentation, and cite the page.
- Normalise each account to `{ merchantAccountId, currency, status, isDefault }`.
- Discovery is read-only. It must never create, modify, or delete merchant accounts.
- When it runs:
  - On server startup.
  - On demand through `POST /api/demo/catalog/refresh`, plus a "Refresh accounts" button on `/demo`.
- No timed background refresh.
- Keep the discovered catalog in memory, along with `discoveredAt` and the gateway's merchant ID (read from configuration, never hardcoded).
- **Failure handling:**
  - If discovery fails (bad credentials, network error, empty result), the server still starts.
  - `/demo` shows a clear "Gateway unavailable" state with the reason in plain language. Do not show the raw error, and do not show credentials.
  - Every routing endpoint returns `CATALOG_UNAVAILABLE` and makes no gateway call.
  - **There is no fallback to a hardcoded or previously cached account list.**
- `/health` gains a `merchantAccountDiscovery` check with one of the states `ok`, `failed`, or `not_run`, plus `discoveredAt`. Keep `braintreeConnectivity: "not_checked"` semantics for the health request itself: health must report the last discovery result, not trigger a new call.

### 3.3 Policy overlay

- Location: `config/routing-policies/<merchantId>.json`.
- Commit an `example.json` that documents the format. Gitignore real policy files by default.
- Add the human's current gateway policy as that gateway's file, so their behaviour is unchanged. The human decides whether to commit it.
- The format lets you assign payment types and display labels per merchant account ID. For example:

```json
{
  "merchantId": "<gateway merchant id>",
  "accounts": {
    "paypal2": { "label": "UK Store – GBP", "paymentTypes": ["one_time", "recurring"] },
    "paypal":  { "label": "EU Store – EUR", "paymentTypes": ["one_time", "recurring"] },
    "vmUSD":   { "label": "US Store – One-time", "paymentTypes": ["one_time"] },
    "vmUSD2":  { "label": "US Store – Subscriptions", "paymentTypes": ["recurring"] }
  }
}
```

- **The overlay may assign roles; it may never invent accounts.** Currency, status, and default flag always come from discovery.
- **Overlay validation:**
  - If an overlay entry refers to an account the gateway does not have, show a visible warning and ignore that entry. Do not crash.
  - If the overlay's `merchantId` does not match the connected gateway, ignore the whole file and warn.
  - If the overlay produces two active accounts for the same currency and payment type, it is invalid. Reject the whole overlay with a clear message and fall back to auto-assignment.
- Stage 7's presenter route-mapping page will later write to this overlay. It is not built in this stage.

### 3.4 Auto-assignment rules

These apply to each currency, for accounts the overlay does not cover. They must be deterministic, so the same gateway always produces the same result.

1. Only **active** accounts take part in routing. Inactive accounts are shown with their status, but no route is assigned to them.
2. If a currency has exactly one active account, it handles both `one_time` and `recurring`.
3. If a currency has several active accounts, one of them handles both types: the gateway default if it is in that currency, otherwise the first by account ID in alphabetical order. The rest are shown as **"Available, not assigned"**, with a note that they can be assigned through the policy overlay.
4. Payment types already claimed by the overlay for a currency are not auto-assigned again.
5. Auto labels follow the format `<CURRENCY> account (<merchantAccountId>)`.

Every catalog entry records where its role came from: `policy` or `auto`. The decision trace and the `/demo` account list show this, for example "Matched by merchant policy" or "Matched automatically (only active USD account)". This keeps intact the Stage 0/1 wording rule that the USD split is a merchant demo policy, not a Braintree restriction.

### 3.5 Validation

Re-apply the Stage 0 catalog validation to the **built** catalog, adjusted as follows:

- **Sandbox only.** Reject the configuration at startup if the configured environment is not sandbox.
- **Exactly one active default account.** It must come from discovery. If discovery reports none, more than one, or an inactive default, treat discovery as failed.
- **No duplicate active routes.** No two active accounts may share the same currency and payment type.
- **Validate every merchant account ID before every Braintree call.** Any wrapper or route that is about to pass a `merchantAccountId` must first prove that the ID is an active member of the current discovered catalog. An unknown, removed, inactive, or stale ID is rejected locally before the SDK is invoked. This invariant applies even to client-token generation, because Braintree can silently fall back to the gateway default when an unknown ID is supplied.
- Remove all validation that assumes particular account IDs, a particular account count, or particular currencies.
- Keep returning frozen defensive copies from the accessors.

### 3.6 Things that must become dynamic

| Item | New behaviour |
| --- | --- |
| Scenario presets | Generated from the catalog, as listed below this table. |
| Currency picker | Options come from the currencies discovered in the catalog. |
| Amount validation | Respects each currency's number of decimal places: two for GBP, EUR, and USD; none for JPY and other zero-decimal currencies. Verify Braintree's amount format rules for zero-decimal currencies against the documentation. Keep the successful-demo amount range, scaled to each currency. Amounts that trigger declines are a Stage 2 concern. |
| Legacy `/api/client-token`, `/api/create-transaction`, and storefront recurring calls | Use the **gateway default account's** one-time route (or its recurring route for recurring calls), resolved through the same catalog. Display and charge in that default account's currency. Convert the existing GBP base prices with fixed demo conversion rates defined in configuration, never fetched live. Label the rate and converted price clearly as demo values in the UI. Currency formatting and amount rounding must respect the currency's decimal places, including whole-number rounding for zero-decimal currencies. Never charge a GBP-priced amount as though it were another currency. |
| Control Panel link builder | Uses the merchant ID read from configuration. Confirm nothing in it is hardcoded. |
| `verify:sandbox` | Runs discovery, then makes one small sale per discovered currency's one-time route, and verifies the account returned by Braintree. It prints a summary of what it discovered first. It exits with a clear message if discovery fails. |
| Event store | Every event gains a `gatewayMerchantId` field. Existing events without it are kept as they are. Stage 2's log must filter by gateway, and shows the current gateway's events by default. |

Storefront conversion rates belong in a dedicated configuration module (for example `config/demo-currency-rates.js`), expressed as target-currency units per GBP with GBP fixed at `1`. The table must cover every currency Braintree can expose to this demo; startup validation rejects missing, non-positive, or non-finite rates. Convert from the existing GBP base price once, then round once to the target currency's ISO minor-unit precision. The storefront must show wording such as "Fixed demo rate: GBP 1 = JPY 190 — not a live FX quote" next to converted prices. Neither the browser nor a request may supply or override a rate.

The generated scenario presets are:
- One "one-time purchase" scenario per discovered currency.
- One "recurring route preview" scenario per currency whose recurring account differs from its one-time account. This is where the USD split appears on the human's gateway.
- One "unsupported currency" scenario, using the first currency from a fixed fallback list (JPY, CHF, SEK, NOK, PLN, CZK) that the gateway does not support.

### 3.7 Account list display on `/demo`

Show the list of discovered accounts with:
- the label
- the raw merchant account ID
- currency
- status
- the default flag
- assigned payment types
- where the role came from (policy or auto)
- the "Available, not assigned" state

Above the list, show the gateway merchant ID, the time of the last discovery, any overlay warnings, and the "Refresh accounts" button.

---

## 4. Tests (no live Braintree calls)

Use a fake discovery client and cover:

1. The human's gateway shape (four accounts, with the overlay). The resulting routes must be **identical** to Stage 1: `paypal2`, `paypal`, `vmUSD`, `vmUSD2`, and no route for JPY.
2. The same gateway with **no overlay**. USD auto-assigns to one account for both payment types, the other USD account shows as "Available, not assigned", and the role source is `auto`.
3. A single-account gateway.
4. A many-currency gateway that includes JPY. The unsupported-currency scenario must pick a different currency, and JPY amounts must be validated as whole numbers.
5. An inactive account that is the only account in its currency: no route for that currency.
6. An overlay referring to a missing account: a warning, the entry ignored, the rest applied.
7. An overlay whose merchant ID does not match the gateway: the file ignored, with a warning.
8. An overlay producing a duplicate route: the overlay rejected, falling back to auto-assignment.
9. A discovery failure: the server starts, routing endpoints return `CATALOG_UNAVAILABLE`, no Braintree calls are made, and there is no fallback list.
10. Paginated discovery results are fully collected.
11. Refreshing after the fake gateway's accounts change updates the catalog, scenarios, and currency picker.
12. The legacy routes use the discovered default account's route, not a hardcoded ID.
13. An unknown, removed, inactive, or otherwise stale merchant account ID is rejected against the current discovered catalog before any Braintree SDK method is called. Include explicit gateway-spy assertions for both client-token generation and a transaction call.
14. Storefront prices are derived from GBP base prices using configured fixed demo rates, are labelled as demo conversions, and are rounded using the target currency's decimal places, including zero-decimal currencies.
15. A static check (test or lint script) that fails if a known merchant account ID appears outside the policy files, test fixtures, and docs. Gateway-specific currency assumptions must not appear outside those locations; generic ISO minor-unit metadata, the unsupported-currency fallback list, and the dedicated fixed-rate configuration are the only currency-constant exceptions.

Keep all existing Stage 1 tests passing. Update any test that depends on the hardcoded catalog to use fixtures.

---

## 5. Live verification

1. With the human's current credentials, run `npm run verify:sandbox`. Confirm discovery finds the same four accounts and that all one-time routes match Stage 1.
2. Temporarily move the human's policy file aside and confirm the auto-assigned result on `/demo`. Restore the file afterwards.
3. If the human can provide credentials for a second sandbox gateway, repeat step 1 with them. Otherwise, record that verifying a second gateway relied on fakes only.

---

## 6. Roadmap updates to make in `braintree_demo_roadmap.md`

- Insert this stage as **Stage 1.5**.
- **Stage 2:** the log filters by `gatewayMerchantId`. Decline-test amounts must respect each currency's decimal places.
- **Stage 3:**
  - Discover plans through the SDK's call for listing plans, rather than requiring hand-entered plan IDs. Verify the plan fields, including the currency, against the documentation.
  - Validate each plan's currency against the discovered accounts.
  - If a currency has no matching plan, show "No plan available" for that currency rather than failing.
- **Stage 5:** the payment-method availability matrix moves into the policy overlay. Automatic defaults must be conservative, offering cards only unless the overlay enables more methods. Venmo is still only allowed on USD.
- **Stage 7:** the route-mapping page edits the policy overlay for the connected gateway's merchant ID. The preflight check shows the discovery result and any overlay warnings.

---

## 7. Out of scope

- Supporting production gateways.
- Switching between several gateways at runtime without a restart. Credentials still come from the environment file. Swapping gateways means changing the file and restarting.
- An offline or cached demo mode.
- Any UI for editing the overlay (that is Stage 7).

---

## 8. Definition of done

- With the human's credentials and policy file, demo behaviour is unchanged from Stage 1, and this is proven by tests and `verify:sandbox`.
- With any other sandbox credentials, the demo starts, discovers that gateway's accounts, assigns routes automatically, and runs one-time payments with no code or config edits.
- Every merchant account ID is validated against the current discovered catalog before any Braintree call; unknown or stale IDs never reach the SDK.
- The storefront displays and charges in the discovered default account's currency, using clearly labelled fixed demo conversion rates from GBP and correct zero-decimal rounding.
- No merchant account ID, merchant ID, or gateway-specific currency assumption is hardcoded outside the policy files, test fixtures, and docs. Generic ISO minor-unit metadata, the unsupported-currency fallback list, and fixed demo rates are kept in dedicated currency configuration.
- All tests pass, and `docs/STAGE_1_5_CHANGES.md` is written in the established format, including the confirmation findings from Section 2 and the documentation pages used.
- Work stops for human review.

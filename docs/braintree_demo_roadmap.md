# Braintree Multi-Account Routing Demo: Build Roadmap (Stages 1–8, including Stage 1.5)

**Audience:** AI coding agent working in the existing repository.
**Starting point:** Stage 0 is complete (see `STAGE_0_CHANGES.md`). Do not redo Stage 0 work.
**Goal of the demo:** Show prospective Braintree clients how one gateway with multiple merchant accounts (MAIDs) can route payments by currency and merchant-defined payment type, and how that routing holds across payment methods, vaulting, recurring billing, 3D Secure, and post-payment operations.

> **USD account context:** `vmUSD` and `vmUSD2` are equivalent-purpose USD merchant accounts created with different processor configurations. Neither account is intrinsically limited to one-time or recurring payments. For this demo, the merchant-defined routing policy deliberately assigns `vmUSD` to one-time payments and `vmUSD2` to recurring payments. The UI and documentation must describe this as configurable policy, not as a Braintree capability restriction.

---

## 1. How to use this document

1. Work on **one stage at a time**, in the order given. Do not start a stage until the previous stage has been approved.
2. Before starting a stage, check its **[DECISION]** items. If any are unresolved, stop and ask the human. Do not assume.
3. At the end of each stage, write `docs/STAGE_N_CHANGES.md` using the same structure as `STAGE_0_CHANGES.md`: Outcome, Implementation details, Files added, Files modified, Verification performed, Stage boundary, Review required. Then stop and wait for review.
4. If what you find in the repository conflicts with this document, stop and report the conflict. Do not improvise around it.
5. Inspect existing code before adding new code. In particular, check how the storefront (`/`, `/basic`, `/devices`), `routes/api.js`, and `/api/webhooks/activity` currently work, and reuse them where sensible.

---

## 2. Ground rules (apply to every stage)

### Security and environment
- **Sandbox only.** Never add production credentials. Never weaken the catalog validation that rejects non-sandbox entries.
- Never commit `config.env` or `.env`. Never log or display API keys, client tokens, full payment method tokens, or raw nonces.
- Do not commit `setup_gar_npm.sh`. Keep the lockfile free of private registry URLs.
- All runtime data files go under `data/runtime/`, which must be gitignored.

### Routing invariants (these are the core of the demo; never violate them)
- **The browser never chooses or sends a merchant account ID.** The client sends *intent* (currency, payment type, scenario ID). The server resolves the merchant account.
- **Every Braintree call that accepts `merchantAccountId` must pass it explicitly.** Never rely on the gateway default (`paypal2`). Enforce this in code (wrapper functions that throw if it is missing) and in tests.
- **Resolve the route before generating the client token**, and generate the client token with the resolved merchant account ID. PayPal, 3D Secure, and local payment methods depend on the currency of the account the token was generated for.
- **An unmatched route is an explicit error, never a fallback to the default account.** A request for an unsupported currency must return a clear "no route" result.
- After every transaction, **verify that `transaction.merchantAccountId` in Braintree's response matches the resolved account**, and record the result. A mismatch is a bug and must be surfaced loudly in the UI and log.

### Braintree behaviour
- Verify every SDK method, sandbox test amount, test card number, webhook kind, and 3DS test scenario against the official Braintree developer documentation before relying on it. Do not hardcode values from memory. Record the documentation page used in the stage's CHANGES file.
- Treat sandbox quirks explicitly. For example, transactions do not settle instantly; use the SDK's sandbox testing helper to settle when a scenario needs a settled transaction.

### Engineering standards
- Keep the existing stack: Node.js, Express, Handlebars, and vanilla browser JavaScript. No frontend framework.
- Add a new dependency only when needed, and justify it in the CHANGES file.
- Every stage adds automated tests using the existing test runner. **Unit tests must not call Braintree.** Use stubs or fakes for the gateway.
- Live sandbox checks go in a separate, opt-in script (`npm run verify:sandbox`, created in Stage 1) that creates only clearly labelled demo objects.
- Maintain the accessibility standard set in Stage 0: semantic structure, visible focus, HTML escaping, reduced-motion handling, and status shown by text as well as colour.
- Do not break existing routes: `/`, `/basic`, `/devices`, `/demo`, `/health`, `/api/client-token`, `/api/webhooks/activity`.

---

## 3. Current state after Stage 0

| Currency | Merchant account ID | Demo routing policy | Gateway default |
| --- | --- | --- | --- |
| EUR | `paypal` | one-time, recurring | No |
| GBP | `paypal2` | one-time, recurring | Yes |
| USD | `vmUSD` | one-time | No |
| USD | `vmUSD2` | recurring | No |

The USD rows are processor variants. Their different payment-type assignments are a demo policy that the merchant controls; they are not inherent account purposes.

**Display labels.** The raw IDs `paypal` and `paypal2` will be confused with PayPal as a payment method once that is added. In Stage 1, give every account a clear audience-facing label (for example "EU Store – EUR", "UK Store – GBP", "US Store – One-time", "US Store – Subscriptions"). Show the raw merchant account ID alongside it in the technical views.

**Existing modules to build on:** `config/merchant-accounts.js` (validated, frozen catalog), `routes/demo.js` + `views/demo.hbs` (`/demo` page), `/health`, and `routes/api.js` (client token and GBP one-time transaction).

---

## 4. Target architecture

Add these modules incrementally. Do not build them all up front.

| Module | Responsibility |
| --- | --- |
| `config/merchant-accounts.js` | Exists. Extend with display labels and later route attributes (for example 3DS policy). |
| `lib/routing/resolve-route.js` | Pure function: `(intent, catalog) → { matched, account, reason, trace[] }`. No I/O. |
| `lib/braintree/gateway.js` | Single gateway instance plus wrapper functions. Every wrapper requires `merchantAccountId`. |
| `lib/events/store.js` | Append-only event store (in memory, persisted to `data/runtime/events.json`). Interface: `append`, `list`, `get`, `clear`. |
| `lib/inspector/redact.js` | Redacts sensitive fields before anything reaches the UI or the event store. |
| `routes/demo-api.js` | JSON endpoints used by the demo UI. |
| `public/js/demo.js` | Browser logic for the scenario runner and inspector. |

### Request flow
1. The browser sends intent: currency, payment type, scenario ID.
2. The server calls `resolveRoute` and gets the matched account and a decision trace.
3. The server generates a client token for the resolved merchant account.
4. The browser collects a nonce through the payment UI and sends it with the intent.
5. The server resolves the route again (never trusting the client), calls Braintree through the wrapper, verifies the merchant account in the response, and appends an event.
6. The UI shows the decision trace, the redacted request, the response summary, and the verification result.

### Decision trace shape
The trace explains *why* an account was chosen and is the main thing shown to audiences:

```json
{
  "intent": { "currency": "USD", "paymentType": "recurring" },
  "matched": true,
  "account": { "key": "usd-recurring", "merchantAccountId": "vmUSD2", "label": "US Store – Subscriptions" },
  "reason": "The demo policy assigns USD recurring payments to vmUSD2",
  "trace": [
    { "account": "paypal",  "result": "skipped", "why": "currency EUR ≠ USD" },
    { "account": "paypal2", "result": "skipped", "why": "currency GBP ≠ USD" },
    { "account": "vmUSD",   "result": "skipped", "why": "demo policy assigns this variant to one-time" },
    { "account": "vmUSD2",  "result": "matched", "why": "demo policy match: USD + recurring" }
  ]
}
```

### Event shape
Each event in the store should include at least: `id`, `timestamp`, `scenarioId`, `type` (for example `route.resolved`, `transaction.sale`, `transaction.refund`, `webhook.received`), `intent`, `resolvedMerchantAccountId`, `responseMerchantAccountId`, `verified`, `paymentMethodType`, `amount`, `currency`, `outcome`, `braintreeId`, a `relatedEventId` for follow-up actions, and a redacted `request` and `response`.

---

## 5. Stages

### Stage 1: Routing engine, scenario runner, and inspector (one-time payments, all currencies)

**Goal:** A presenter picks a scenario, runs a real sandbox one-time payment, and immediately sees which merchant account it went to, why, and the Braintree result. This covers routing by currency for all three currencies.

**Build:**
- `resolveRoute` with the decision trace, covering every catalog row plus the unmatched case.
- Gateway wrappers that throw if `merchantAccountId` is missing.
- Display labels in the catalog.
- Endpoints:
  - `POST /api/demo/route-preview`: intent → decision. No Braintree call.
  - `POST /api/demo/client-token`: intent → client token generated with the resolved account.
  - `POST /api/demo/payments/one-time`: intent + nonce + amount → sale on the resolved account.
- Scenario runner on `/demo`:
  - Preset scenarios: "UK phone purchase (GBP)", "EU phone purchase (EUR)", "US phone purchase (USD)", and "Unsupported currency (JPY)", which shows a no-route result.
  - Manual currency and payment-type selectors.
  - Card payment UI. Reuse whatever card component the existing storefront already uses.
  - A recurring USD option that shows a **route preview only** (resolving to `vmUSD2`), clearly labelled "Recurring payments arrive in Stage 3".
- Inspector panel showing the decision trace, the redacted request, a response summary (transaction ID, status, merchant account ID, currency, amount, processor response), the verification result, and a link to the transaction in the Sandbox Control Panel.
- Event store, written to on every route resolution and transaction. The log *page* comes in Stage 2.
- An `npm run verify:sandbox` script that runs one small one-time payment per currency and checks the response's merchant account.

**Acceptance criteria:**
- GBP, EUR, and USD one-time payments land on `paypal2`, `paypal`, and `vmUSD` respectively, confirmed from Braintree's response.
- JPY (or any unconfigured currency) returns a clear no-route result, and no Braintree call is made.
- Unit tests cover every resolver outcome. A test asserts that the wrappers reject calls without a merchant account ID. A test asserts that a client-supplied merchant account ID is ignored.
- No credentials, client tokens, or nonces appear in the UI, logs, or event store.

**Demo moment:** Buy the same phone in GBP, then EUR, then USD, and watch three different accounts appear with the reason for each. Then try JPY and show it is refused rather than silently misrouted.

**Out of scope:** Vaulting, recurring charges, other payment methods, the log page.

---

### Stage 1.5: Dynamic merchant account discovery

**Goal:** Make the demo portable between Braintree Sandbox gateways. Changing credentials and restarting the server must be enough to discover the connected gateway's merchant accounts, build a deterministic routing catalog, generate the scenarios, and run one-time payments without editing code or account configuration.

The detailed implementation specification and acceptance tests are in [`stage_1.5_dynamic_merchant_accounts.md`](stage_1.5_dynamic_merchant_accounts.md). Its requirements are part of this roadmap.

**Build:**
- Discover every merchant account at startup and on explicit refresh, normalising its ID, currency, status, and default flag. Discovery is read-only, sandbox-only, and has no hardcoded or cached fallback.
- Combine discovery with an optional gateway-specific policy overlay and deterministic auto-assignment. An overlay can label and assign discovered accounts but cannot invent them.
- Validate every merchant account ID against the current discovered catalog before **any** Braintree call. Unknown, inactive, removed, or stale IDs are rejected locally. This is especially important for client-token generation: Braintree can silently use the default account for an unknown ID, as documented in the [client-token generation reference](https://developer.paypal.com/braintree/docs/reference/request/client-token/generate/node/); a later sale with that ID fails.
- Generate presets, currency options, amount validation, the account display, and sandbox verification work from the built catalog.
- Make the legacy storefront use the discovered default account's currency. Convert its GBP base prices using fixed demo rates stored in a dedicated configuration module, label them as demo rates and not live FX quotes in the UI, and round according to the target currency's decimal places, including zero-decimal currencies.
- Record the configured gateway merchant ID on new events, expose discovery status through `/health`, and provide a refresh action on `/demo`.

**Acceptance criteria:**
- The existing gateway plus its policy produces the same Stage 1 routes, while a different fake gateway works without code or configuration edits.
- Discovery, overlays, automatic assignment, pagination, refresh, failure states, dynamic scenarios, currency-aware amounts, and dynamic legacy routing are covered without live calls in unit tests.
- Tests prove an unknown or stale merchant account ID is blocked before the gateway method is called.
- No merchant account ID, merchant ID, or gateway-specific currency assumption is hardcoded outside policy files, fixtures, and documentation. Generic currency metadata and fixed demo rates live only in dedicated currency configuration.

**Demo moment:** Refresh the account catalog and show that the scenarios, account list, storefront currency, and routing proof all reflect the connected gateway rather than a compiled-in list.

**Out of scope:** Production gateways, runtime switching between gateways, offline cached discovery, and UI editing of the policy overlay.

---

### Stage 2: Transaction log, post-payment operations, and decline simulation

**Goal:** A "proof" screen listing everything run during the demo, plus the operational actions merchants care about.

**Build:**
- `/demo/log` page listing events: time, scenario, amount, currency, display label and merchant account ID, payment method type, outcome, and verification result. Filterable by gateway merchant ID, currency, and account; it shows the connected gateway's events by default. Each row expands to show its inspector detail.
- Authorize-only mode in the scenario runner, as opposed to authorize and submit for settlement.
- Actions on log rows, each following the transaction's real state:
  - capture, including a partial capture
  - void (before settlement)
  - settle, using the sandbox testing helper, labelled "sandbox only"
  - refund and partial refund (after settlement)
- Decline scenarios using the documented sandbox amounts for processor declines and gateway rejections, adjusted so every test amount respects the selected currency's decimal places, and shown as normal results in the inspector rather than as crashes.
- Follow-up actions are linked to the original transaction with `relatedEventId`.

**Acceptance criteria:**
- Actions are offered only when valid for the transaction's current status, and any Braintree error is shown clearly.
- Refunds stay on the same merchant account as the original transaction, and this is verified and shown.
- The log survives a server restart (it is persisted in the runtime data file).

**Demo moment:** Authorize a pre-order, capture part of it for a split shipment, then refund, with every step visible in the log against the right account.

---

### Stage 3: Vault and recurring payments

**[DECISION]** before starting: Confirm which recurring models to show. Recommended: both A and B below.

**Goal:** Recurring payments are routed for real. The merchant-defined USD one-time/recurring policy becomes visible across the two processor variants.

**Build:**
- Demo customers created with a recognisable ID prefix (for example `demo-`) so they can be cleaned up in Stage 7.
- Vaulting with card verification run on the *resolved* merchant account (pass the verification merchant account option).
- **Model A, merchant-managed recurring:**
  - The first charge is flagged as the first recurring transaction, using the documented `transactionSource` value.
  - A **"Run next billing cycle"** button charges the vaulted token as a subsequent recurring transaction on the recurring route.
- **Model B, Braintree Subscriptions:**
  - Discover plans with the Braintree SDK's plan-listing call rather than requiring hand-entered plan IDs. Verify the returned plan fields, including currency, against the official documentation.
  - Validate every discovered plan's currency against the currencies and routes in the discovered merchant-account catalog.
  - If a currency has no matching plan, show "No plan available" for that currency and keep the rest of the demo usable.
  - Create, view (status, next billing date), and cancel subscriptions. Every create call passes the merchant account ID explicitly.
  - Explain in the UI that Braintree controls the billing schedule in this model, which is why model A exists for on-demand demonstration.
- A **"one vault, many accounts"** scenario: the same vaulted payment method is charged as a USD one-time payment (`vmUSD`) and a USD recurring payment (`vmUSD2`), showing that the vault is shared across the gateway.
- Remove the "Stage 3" placeholder label from the recurring route preview.

**Acceptance criteria:**
- Under the configured demo policy, USD recurring charges land on `vmUSD2` and USD one-time charges on `vmUSD`. GBP and EUR use the same account for both types. All of this is verified from Braintree's responses.
- First and subsequent recurring transactions carry the correct `transactionSource` flags, and these are shown in the inspector.
- Plan and merchant account currency mismatches are rejected during catalog construction, and currencies without a plan are shown as unavailable rather than failing the application.

**Demo moment:** One customer and one saved card produce two charges on two processor variants because of merchant-controlled routing policy, while the same flow in GBP uses a single account. The routing policy belongs to the merchant, not to Braintree.

---

### Stage 4: Webhooks and disputes

**[DECISION]** before starting: how Braintree will reach the server. Either a hosted deployment with a public HTTPS URL, or a tunnel to the local machine. The human configures the webhook URL in the Sandbox Control Panel.

**Goal:** Show the operational side of the gateway: events arriving in real time, and dispute handling.

**Build:**
- Inspect and extend the existing `/api/webhooks/activity` endpoint. Do not create a parallel one.
- Verify webhook signatures using the SDK's parse function. Reject unverifiable payloads, and log the rejection without the payload.
- Store webhook events in the event store, linked to the related transaction or subscription where possible.
- Handle at least these event kinds: dispute opened, won, and lost; subscription charged successfully and unsuccessfully; subscription went past due. Check the exact names in the documentation.
- A dispute scenario using the documented sandbox card number that triggers a dispute.
- A `/demo/disputes` view with actions to accept a dispute, or to add text evidence and finalize it, using the SDK's dispute API.
- Live UI updates through polling. Server-Sent Events are optional if simple to add.
- Local tests using the SDK's sample-notification helper. No live webhooks in unit tests.

**Acceptance criteria:**
- A dispute triggered from the demo appears in the UI without a page reload, linked to its original transaction and merchant account.
- Invalid signatures are rejected, and a test proves it.

**Demo moment:** Run a payment with the dispute test card and watch the chargeback arrive and get handled, on the correct account.

---

### Stage 5: More payment methods

**[DECISION]** before starting: which methods are enabled in the sandbox for each merchant account. The human checks the Control Panel. For Apple Pay, domain verification needs the hosted HTTPS deployment from Stage 4.

**Goal:** Prove that routing works the same no matter how the customer pays.

**Build:**
- A payment-method availability matrix in the connected gateway's policy overlay (method × currency/account), validated when the overlay is applied. Automatic defaults are conservative: offer cards only unless the overlay explicitly enables another method. Venmo may still be enabled only for USD accounts. Apple Pay, Google Pay, PayPal, and optional local payment methods appear only where the overlay enables them and the sandbox supports them.
- The scenario runner offers only valid method/currency combinations, so live demos never hit an unsupported pairing.
- PayPal for both one-time payments and vaulting (for recurring routes).
- Record the payment method type in the inspector and log.

**Acceptance criteria:**
- Tests prove that the same intent resolves to the same account regardless of payment method.
- Every enabled method completes a sandbox payment on its expected account, checked by `verify:sandbox`.

**Demo moment:** Pay in USD with a card, then PayPal, then Venmo. All three land on the same account because routing follows business rules, not the payment method.

---

### Stage 6: 3D Secure

**Goal:** Show strong customer authentication and liability shift, which matters most on the EUR route.

**Build:**
- A per-account 3DS policy attribute in the catalog (for example `"required"` for EUR, `"optional"` elsewhere), shown in the decision trace.
- A 3DS verification step in the client flow, using the client token from the resolved account, with the 3DS result passed through to the sale.
- 3DS results shown in the inspector and log: status, whether liability shift was possible, and whether it occurred.
- Scenarios using the documented 3DS test cards: frictionless success, challenge, and failed authentication.

**Acceptance criteria:**
- A EUR card payment without completed 3DS is blocked by policy before reaching Braintree, with a clear message.
- Liability-shift fields are shown accurately for each documented test scenario.

**Demo moment:** A frictionless EUR payment with liability shift, then a challenge flow, then a failure, all explained in plain language.

---

### Stage 7: Presentation readiness

**Goal:** Anyone on the team can run a consistent, reliable demo without a developer present.

**Build:**
- **One-click reset**, with a confirmation step:
  - Clear only the demo's local event store and reset its visible UI state.
  - Leave every transaction, subscription, customer, payment method, and other object in the Braintree Control Panel intact.
  - Explain this boundary in the confirmation copy so presenters know the reset is visual/local, not a gateway cleanup operation.
- **Route mapping page:**
  - Lets a presenter reassign *existing* merchant accounts to purposes, validated with the same rules as the catalog.
  - Protected by a presenter passcode from the environment.
  - Edits the policy overlay for the connected gateway's configured merchant ID and has a "restore defaults" button.
  - Must not allow entering credentials or creating merchant accounts, since accounts have to exist in Braintree first.
- **Pre-demo check page** (`/demo/preflight`):
  - an optional live Braintree connectivity check (for example `/health?live=1`, keeping the current default honest)
  - the latest merchant-account discovery result, including every catalog account's current status and any policy-overlay warnings
  - matching plans were discovered for the currencies intended for subscription demonstrations
  - webhooks reachable
  - payment methods available
- **Demo scripts** in `docs/demo-scripts/`: a 5-minute business-audience script and a 15-minute technical-audience script, each with setup steps and talking points per scenario.
- **Automated browser smoke tests** for the main scenarios, which Stage 0 could not do. A browser-testing dependency is justified here.

**Acceptance criteria:**
- Reset returns the local demo to a clean visual state in one action, and a test proves it makes no Braintree SDK call or gateway-side change.
- A non-developer can change the USD one-time/recurring assignment through the UI, and the next payment routes accordingly.

---

### Stage 8 (optional): Storefront integration

**Goal:** A customer-facing story for business audiences, using the same engine.

**Build:**
- Connect the existing storefront checkout (`/devices`, `/basic`) to the routing engine, gateway wrappers, and event store, so a customer journey produces the same inspector and log output as the scenario runner.
- A region/currency switcher in the storefront header.
- An optional "show what's happening" toggle that opens the inspector alongside the storefront.

**Acceptance criteria:** Purchases and subscriptions made through the storefront appear in `/demo/log` with the same routing detail and verification as scenario-runner payments.

---

## 6. Decisions

### Resolved

| Decision | Resolution |
| --- | --- |
| USD demo routing policy | `vmUSD` for one-time and `vmUSD2` for recurring. These are processor variants; the split is configurable merchant policy. |

### Open

| # | Decision | Needed before | Owner |
| --- | --- | --- | --- |
| 1 | Recurring models to show: merchant-managed, Braintree Subscriptions, or both (recommended: both) | Stage 3 | Human |
| 2 | Public URL for webhooks (hosted deployment or tunnel) | Stage 4 | Human |
| 3 | Which payment methods are enabled per merchant account in the sandbox | Stage 5 | Human |
| 4 | Whether the demo may be shown externally to clients, and any internal approval needed | Before the first client demo | Human |

---

## 7. Definition of done (every stage)

- All acceptance criteria met.
- Tests pass; new behaviour has new tests. Unit tests make no live Braintree calls.
- `npm run verify:sandbox` passes for everything the stage touches.
- No secrets in the code, logs, UI, event store, or git history.
- Existing routes still return HTTP 200.
- `docs/STAGE_N_CHANGES.md` written in the Stage 0 format, including the documentation pages used and any assumptions made.
- Work stops for human review.

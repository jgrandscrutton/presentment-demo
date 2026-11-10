# Braintree Presentment Demo

An Express and Handlebars storefront whose payment layer runs through Braintree. The browser presents PayPal with Braintree Web, while the server creates client tokens, vault customers and payment methods, submits transactions, persists billing agreements, and verifies Braintree webhooks with the Braintree Node SDK.

## Setup

Use Node.js 22.22.2 or newer, then install every runtime and development package in one terminal command:

```bash
npm ci
```

`npm ci` uses the committed lockfile and is the recommended fresh-clone/CI command. Use `npm install` instead only when intentionally changing dependencies.

Copy `.env.example` to `.env`, then replace the placeholders with credentials from a **Braintree sandbox** account:

```dotenv
PORT=3000
BRAINTREE_ENVIRONMENT=sandbox
BRAINTREE_MERCHANT_ID=your_braintree_merchant_id
BRAINTREE_PUBLIC_KEY=your_braintree_public_key
BRAINTREE_PRIVATE_KEY=your_braintree_private_key
BRAINTREE_MERCHANT_ACCOUNT_ID=your_merchant_account_id
BRAINTREE_CURRENCY=GBP

# Recurring execution is deliberately off by default.
BILLING_SCHEDULER_ENABLED=false
BILLING_SCHEDULER_INTERVAL_MS=60000
BILLING_SCHEDULER_BATCH_SIZE=20
BILLING_STORE_PATH=var/billing-agreements.json
BILLING_ADMIN_KEY=replace_with_a_long_random_admin_key
BILLING_QUOTE_SECRET=replace_with_an_independent_long_random_secret
BILLING_QUOTE_TTL_SECONDS=1800
```

Start the application:

```bash
npm start
```

The terminal prints a clickable local URL, normally `http://localhost:3000`.

`BILLING_QUOTE_SECRET` should be independent and random. For compatibility, the app falls back to the configured Braintree private key when it is omitted, but a separate secret is recommended.

## Commands

- `npm start` — run the server
- `npm run dev` — run with automatic restarts
- `npm test` — run the test suite

## Payment and billing flow

- All server-side payment operations use Braintree. PayPal is a wallet presented through Braintree's PayPal Checkout component; the project has no separate PayPal server SDK.
- Storefront product IDs resolve against the server-side catalog, so browser-edited product prices are not trusted. The free-form `/basic` demos use separate `/api/demo/*` endpoints.
- Before PayPal approval, the server signs the exact purchase selection or billing amount, cadence, and first date into a short-lived quote. Checkout submits that quote instead of mutable browser terms, so the approved terms and charged terms stay bound together.
- An approved PayPal billing checkout creates a Braintree Vault customer and payment-method token. The approval nonce is used once and is never stored.
- The initial transaction is submitted immediately during checkout. The agreement then stores only the Braintree references and terms needed for later merchant-initiated transactions.
- Subscription, variable recurring, installment, hybrid, and unscheduled reload examples use Braintree transaction-source metadata appropriate to their billing model.
- Cancellation stops local scheduling and asks Braintree to delete the agreement's Vault customer. If Braintree deletion fails, the agreement is restored instead of being reported as cancelled.
- `POST /api/webhooks/braintree` verifies Braintree signatures before events appear in the activity view.

Successful transaction summaries used by the confirmation page remain in memory and disappear when the demo server restarts. Billing agreements are separate and persist in `BILLING_STORE_PATH`.

## Recurring scheduler safety

The recurring scheduler is **disabled by default**. Setting `BILLING_SCHEDULER_ENABLED=true` authorizes the running process to submit due token-based charges. It does not affect the initial checkout charge, which is always submitted when the buyer approves the payment.

Before enabling it:

1. Keep `BRAINTREE_ENVIRONMENT=sandbox` while testing.
2. Configure a long, random `BILLING_ADMIN_KEY`.
3. Inspect the stored agreements and their next-charge dates through the protected admin API.
4. Enable the scheduler only when automatic due-date charging is intended.

The scheduler checks at `BILLING_SCHEDULER_INTERVAL_MS`, processes at most `BILLING_SCHEDULER_BATCH_SIZE` due agreements per pass, and prevents overlapping passes inside one process. The approved first date remains the calendar anchor, including month-end and leap-year plans. If the process was paused or late, missed dates are skipped rather than charged in a burst, while the original cadence is retained.

It does not retry declined payments automatically: a definitive decline becomes `past_due` and requires operator action. A network/process interruption becomes `review_required`; verify the persisted order ID in Braintree before resolving it so an uncertain payment is not duplicated.

## Billing administration API

Every endpoint below requires this header:

```http
x-billing-admin-key: value-from-BILLING_ADMIN_KEY
```

If `BILLING_ADMIN_KEY` is unset, billing administration returns `503` rather than exposing an unprotected API.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/billing-agreements` | List redacted agreements |
| `GET` | `/api/billing-agreements/:id` | Read one redacted agreement |
| `POST` | `/api/billing-agreements/run-due` | Run one due-charge pass manually |
| `POST` | `/api/billing-agreements/:id/pause` | Stop future due-date processing |
| `POST` | `/api/billing-agreements/:id/resume` | Resume an eligible paused or past-due agreement |
| `POST` | `/api/billing-agreements/:id/cancel` | Cancel locally and delete its Braintree Vault customer |
| `PATCH` | `/api/billing-agreements/:id/amount` | Supply the next variable recurring/unscheduled amount |
| `POST` | `/api/billing-agreements/:id/charge` | Submit an explicitly authorized manual charge |
| `POST` | `/api/billing-agreements/:id/usage` | Record unscheduled-plan usage and reload below its threshold |
| `POST` | `/api/billing-agreements/:id/resolve-review` | Record the verified result of an interrupted charge |

Variable recurring agreements deliberately enter `awaiting_amount` after a charge. A merchant system must provide a newly authorized amount through the amount endpoint before another scheduled charge can run. Unscheduled auto-reload agreements do not infer usage: the merchant system must send usage amounts to the usage endpoint; crossing the configured threshold triggers the reload transaction.

Review resolution is an operator action, not automatic reconciliation. For `outcome: "charged"`, the app retrieves the supplied transaction from Braintree and verifies its order ID, amount, currency, customer, type, and status before advancing the agreement. Use `outcome: "not_charged"` only after confirming the persisted order ID did not complete.

## Persistence and production limits

`BILLING_STORE_PATH` defaults to the ignored `var/billing-agreements.json`. The file is written with restrictive permissions and API responses omit payment-method tokens. It is intentionally a **single-process demo store**: it is not safe for multiple Node workers, multiple hosts, or production billing.

Before production use, replace it with a transactional database that provides row-level leasing/idempotency, encrypted secret storage, durable audit history, and automated reconciliation. Production integration should also reconcile settlement failures and revoked payment methods from Braintree webhooks. Current webhook handling verifies and displays events but does not mutate agreement lifecycle state.

## Project structure

```text
config/       Environment loading and Braintree gateway configuration
controllers/  HTTP request and response handling
middleware/   Billing administration authentication
services/     Gateway, validation, Vault, agreement, persistence, and scheduler logic
routes/       Thin storefront and API route definitions
public/       Browser-side Braintree payment flow and static assets
views/        Handlebars storefront pages
test/         Node test runner coverage
var/          Ignored local billing-agreement data created at runtime
```

The automated tests use fake gateway responses for recurring lifecycle coverage. Running them does not create Braintree transactions. A real sandbox approval or checkout can create a sandbox transaction, so keep automatic scheduling disabled until you explicitly want to exercise that flow.

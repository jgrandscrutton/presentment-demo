# Stage 0 Changes

**Date:** 14 October 2026  
**Status:** Complete — awaiting review before Stage 1

Future work is governed by `braintree_demo_roadmap.md`.

## Outcome

Stage 0 establishes the foundation for the Braintree merchant-account routing demo while preserving the project's existing Node.js, Express, Handlebars, and browser JavaScript approach.

The application now has:

- A validated, server-owned catalog of Braintree merchant accounts.
- A presentation-ready page at `/demo` that explains the planned routing architecture and displays the configured accounts.
- A health endpoint at `/health` that reports local server and catalog state without falsely claiming that Braintree connectivity was checked for that request.
- Safer environment-file handling and reproducible dependency metadata.
- Automated tests for the catalog, health summary, template rendering, and output escaping.

No payment or transaction was created as part of Stage 0.

## Merchant account catalog

A read-only Braintree Sandbox lookup found these four active merchant accounts:

| Currency | Merchant account ID | Demo routing assignment | Default |
| --- | --- | --- | --- |
| EUR | `paypal` | One-time purchases and recurring billing | No |
| GBP | `paypal2` | One-time purchases and recurring billing | Yes |
| USD | `vmUSD` | One-time purchases | No |
| USD | `vmUSD2` | Recurring billing | No |

`vmUSD` and `vmUSD2` are two versions of the same kind of USD merchant account, created with different processor configurations. Neither account inherently exists for one-time or recurring payments.

For this demo, their different roles are an intentional, configurable merchant routing policy:

- `vmUSD` is assigned to one-time USD payments.
- `vmUSD2` is assigned to recurring USD payments.

This distinction must be described as a demo policy—not as a Braintree limitation or an intrinsic capability difference between the accounts. The default policy can be changed in `config/merchant-accounts.js` and will become presenter-configurable in Stage 7.

## Implementation details

### Account configuration

Added `config/merchant-accounts.js` as the trusted server-side catalog.

Each account contains:

- A stable configuration key.
- A display label.
- Its Braintree merchant account ID.
- Its ISO currency code.
- Supported demo payment types: `one_time` and/or `recurring`.
- A human-readable purpose.
- Environment and account status.
- Whether it is the gateway default.

The catalog validates itself when loaded. Validation prevents:

- Missing or malformed fields.
- Duplicate configuration keys.
- Duplicate merchant account IDs.
- Unsupported or repeated payment types.
- Multiple active accounts claiming the same currency/payment-type route.
- Non-sandbox entries.
- Missing or multiple default accounts.
- An inactive default account.

Public accessors return frozen defensive copies so request code cannot accidentally mutate the configuration.

### Stage 0 demo page

Added a standalone, responsive page at `/demo` showing:

- The Stage 0 review state.
- The single-gateway architecture.
- The planned Stage 1 routing flow.
- Configured and active account counts.
- Supported currencies.
- Each merchant account ID, purpose, currency, status, payment-type tags, and gateway-default state.
- A clear statement that no payment has been sent yet.

The page deliberately uses future-tense language for payment routing because the routing engine belongs to Stage 1.

Accessibility work includes semantic headings and regions, visible keyboard focus, responsive environment labels, status-specific colours, reduced-motion handling, HTML escaping, and safe wrapping for long configurable identifiers.

### Health endpoint

Added `GET /health` with a response shaped like:

```json
{
  "status": "up",
  "environment": "sandbox",
  "checks": {
    "server": "up",
    "merchantAccountCatalog": "loaded",
    "braintreeConnectivity": "not_checked"
  },
  "configuredMerchantAccounts": 4,
  "activeMerchantAccounts": 4,
  "currencies": ["EUR", "GBP", "USD"]
}
```

`braintreeConnectivity` intentionally says `not_checked`: this endpoint is a local liveness/configuration check, not a live call to Braintree.

### Existing Braintree flow

The existing client-token and GBP one-time transaction paths now take their default merchant account ID from the validated catalog instead of an absent `MERCHANT_ACCOUNT_ID` environment variable.

This does not implement Stage 1 routing. It makes the existing default behaviour explicit and ties it to the new configuration source.

### Environment and runtime hygiene

- `config.env` is now ignored by Git so live credentials are not accidentally committed.
- The server accepts either `config.env` or `.env`; `config.env` takes precedence when both exist.
- `.env.example` now documents the Braintree Sandbox variables actually used by the application.
- Dotenv startup tips are suppressed to keep presentation logs clean.
- Server startup now reports bind failures correctly instead of printing a false success message.
- `npm run dev` now uses Node's built-in watch mode, avoiding the previously missing `nodemon` dependency.
- The minimum supported Node version is declared as `22.22.2`.
- `package-lock.json` is enabled for version control and its package URLs use the public npm registry rather than a private corporate registry.

## Files added

| File | Purpose |
| --- | --- |
| `config/merchant-accounts.js` | Validated merchant-account catalog and read-only accessors |
| `routes/demo.js` | Builds the Stage 0 view model and serves `/demo` |
| `views/demo.hbs` | Standalone Stage 0 presentation page |
| `public/stylesheets/demo.css` | Responsive and accessible demo-page styling |
| `test/merchant-accounts.test.js` | Catalog content, validation, and immutability tests |
| `test/demo.test.js` | Health, view-model, rendering, and escaping tests |
| `package-lock.json` | Reproducible dependency resolution using public npm URLs |

## Files modified

| File | Change |
| --- | --- |
| `.env.example` | Replaced obsolete PayPal REST settings with Braintree Sandbox placeholders and setup notes |
| `.gitignore` | Ignores `config.env` and allows the lockfile to be versioned |
| `app.js` | Registers `/demo`, adds `/health`, and exposes a testable health summary |
| `package.json` | Adds working test/dev scripts, project description, and Node engine requirement |
| `routes/api.js` | Uses the catalog's gateway-default account and removes misleading startup logging |
| `server.js` | Loads either supported environment file, cleans startup output, and handles listen errors |
| `views/layouts/store.hbs` | Links the storefront navigation to the new routing demo and updates the footer description |

The pre-existing untracked `setup_gar_npm.sh` file was not changed.

## Verification performed

- Confirmed the four merchant accounts through a read-only Braintree Sandbox API lookup.
- Confirmed all four accounts were active and `paypal2` was the gateway default.
- Generated a Braintree client token successfully without displaying or retaining the token.
- Confirmed HTTP 200 responses for:
  - `/demo`
  - `/health`
  - `/api/client-token`
  - `/`
  - `/basic`
  - `/devices`
  - `/api/webhooks/activity`
- Ran `npm test`: **8 tests passed**.
- Ran JavaScript syntax checks across the project.
- Ran `git diff --check` successfully.
- Ran an offline `npm ci --dry-run` successfully.
- Confirmed `config.env` is ignored.
- Confirmed the lockfile contains no private PayPal Artifact Registry URLs.

Port 3000 was already occupied by an existing Node process during verification. The completed build was tested on port 3100, and the existing process was left untouched.

A controlled browser was unavailable, so visual verification was limited to rendered HTML, responsive source review, accessibility review, and HTTP checks.

## Running Stage 0

With an existing populated `config.env` or `.env`:

```bash
npm ci
npm start
```

Then open:

```text
http://localhost:3000/demo
```

If port 3000 is already in use:

```bash
PORT=3100 npm start
```

Then open `http://localhost:3100/demo`.

## Stage boundary

Stage 0 does **not** yet include:

- A scenario picker that executes payments.
- Automatic routing based on payment type.
- Currency selection at checkout.
- Vaulted-payment or billing-cycle controls.
- Additional payment methods.
- 3D Secure.
- Dispute handling.
- Transaction history or visual reset controls.

Those remain assigned to Stages 1–8 and will be implemented only after the preceding stage is reviewed and approved.

## Review required before Stage 1

The USD routing policy has been recorded as:

```text
vmUSD  -> one-time USD payments
vmUSD2 -> recurring USD payments
```

This is a deliberate demo assignment between two processor variants. It does not describe an underlying purpose restriction on either merchant account.

After Stage 0 is approved, Stage 1 can begin.

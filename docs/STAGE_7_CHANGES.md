# Stage 7 Changes: Presentation readiness

**Date:** 17 November 2026
**Status:** Implemented locally; deterministic presenter-workflow browser smoke is available, while live Sandbox rehearsal remains outstanding

## Outcome so far

Stage 7 turns the routing demo into a repeatable presenter workflow without widening payment authority in the checkout browser or pretending that local controls manage Braintree objects.

The repository now contains a local-only evidence reset, a preflight page with an explicit read-only discovery refresh, a passcode-protected route editor backed by an atomic policy writer, business and technical presenter scripts, and a deterministic real-browser smoke harness. The reset and policy editor have explicit object and rollback boundaries. Preflight distinguishes current discovery, policy warnings, plan coverage, webhook configuration, and historical webhook evidence instead of collapsing them into one “ready” claim.

Local implementation and deterministic workflow coverage do not prove that the connected Braintree Sandbox, PayPal buyer approval, issuer challenge, or public webhook tunnel is ready at presentation time. Those live-dependent steps remain a presenter rehearsal requirement.

## Local-only reset

- `/demo/log` exposes a **Reset local demo** action with explicit confirmation and clear busy, success, and failure copy.
- The JSON endpoint requires both the expected local-store scope and a dedicated confirmation header.
- Success clears only the local event store and reports `braintreeObjectsChanged: false`.
- The reset path has no gateway dependency and does not delete, void, refund, cancel, or otherwise mutate a Braintree transaction, customer, payment method, subscription, dispute, or webhook configuration.
- Failure copy preserves the same boundary: nothing in Braintree was changed by the reset attempt.

## Pre-demo check

- `/demo/preflight` renders the latest local merchant-account and plan discovery state without making an automatic gateway call.
- The explicit refresh action invokes the existing catalog service refresh, which performs read-only merchant-account and plan discovery.
- The page shows discovery status and time, active accounts, route roles, enabled payment methods, per-account Card 3D Secure policy, overlay warnings, and plan coverage for every recurring currency.
- Webhook presentation has three separate concepts: public callback configuration, current reachability, and persisted receipt evidence. Configuration is never presented as proof of reachability, and old signed evidence is labelled historical.
- The page contains no payment nonce input or transaction, customer, vault, subscription, dispute, or webhook mutation control.

## Protected route mapping and policy safety

- `/demo/routes` fails closed when `DEMO_PRESENTER_PASSCODE` is absent. There is no application default passcode.
- Authentication uses a short-lived server-side session with a path-scoped, HTTP-only, SameSite Strict cookie. Successful login regenerates the session, mutation forms require a session-bound CSRF token, and repeated failed logins are temporarily rate-limited.
- The editor presents every discovered currency and payment-purpose row. A presenter can select only an active, already-discovered account of the same currency, or explicitly choose **Not assigned** to make that route unavailable.
- Merchant ID, account inventory, labels, payment-method availability, and Card 3D Secure policy come from current server-owned catalog state. Browser-supplied credentials, capabilities, currencies, and out-of-catalog accounts are not accepted.
- The editor is a protected policy-administration exception: it submits the selected account ID for validation, but ordinary preview and payment requests still submit business intent rather than merchant-account authority.
- The resulting overlay is validated by the same catalog builder used at runtime.
- Writes use a private `0600` atomic file replacement. The original local overlay is captured once as an ignored presenter-baseline JSON file.
- Saving refreshes discovery immediately. A rejected or failed post-write refresh restores the previous overlay and refreshes again.
- **Restore starting policy** reapplies the exact overlay captured before the first presenter edit. It does not guess at defaults, create an account, or delete a Braintree object.

## Presenter scripts

Added:

- `docs/demo-scripts/5-minute-business-demo.md`
- `docs/demo-scripts/15-minute-technical-demo.md`

Both scripts include preflight, exact scenario beats, safe claims, route-mapping and restore workflow, the local-reset boundary, webhook caveats, and recovery guidance. They explicitly distinguish route preview from a completed Sandbox mutation and prevent presenters from claiming live PayPal, 3D Secure, or webhook verification without current evidence.

## Deterministic real-browser smoke

Run:

```sh
npm run verify:stage7:browser
```

Prerequisites:

- Node.js matching the repository engine requirement;
- Google Chrome or Chromium at one of the harness's recognised platform paths, or an explicit `CHROME_PATH` pointing to the executable; and
- permission to start a temporary loopback server and headless browser process.

The harness uses Node's built-in WebSocket client and the Chrome DevTools Protocol, so no browser-automation npm dependency is required. It starts an isolated loopback application and a temporary Chrome profile, then removes the profile after the run. Its CAD and JPY fixture catalog is deliberately unrelated to the connected merchant so the workflow cannot pass by relying on the intended USD/EUR/GBP demo account IDs.

The browser workflow covers:

- preflight rendering without an automatic discovery refresh;
- one-time and recurring route previews on different same-currency fixture accounts;
- presenter-passcode login, route reassignment, save confirmation, and proof that the next preview uses the new route;
- captured-baseline restore followed by proof that both preview routes returned to their original accounts; and
- confirmed local event reset followed by an empty visible log.

The safety boundary is intentional. The harness blocks the external Braintree Web CDN, supplies no Braintree credentials or usable gateway client, replaces transaction-operation and recurring-operation routers with rejecting fixtures, and asserts that those mutation routers were never called. Consequently it does **not** cover Hosted Fields, client-token use, tokenization, a payment POST, 3D Secure, PayPal approval, vaulting, subscription creation, recurring charges, or any other live Braintree mutation. Those remain covered by focused contract tests or require the live Sandbox rehearsal below.

## Files added

- `lib/catalog/policy-writer.js`
- `routes/demo-preflight.js`
- `routes/demo-routes.js`
- `views/demo-routes.hbs`
- `views/demo-preflight.hbs`
- `public/stylesheets/demo-routes.css`
- `scripts/verify-stage7-browser.js`
- `test/policy-writer.test.js`
- `test/demo-preflight.test.js`
- `test/demo-routes.test.js`
- `docs/STAGE_7_CHANGES.md`
- `docs/demo-scripts/5-minute-business-demo.md`
- `docs/demo-scripts/15-minute-technical-demo.md`

## Principal files modified

- `app.js`
- `routes/demo-log.js`
- `views/demo-log.hbs`
- `public/scripts/demo-log.js`
- `public/stylesheets/demo.css`
- `test/demo-log.test.js`
- `test/demo-log-client.test.js`
- `.env.example`
- `package.json`
- the demo navigation views that expose preflight and protected route mapping

## Verification state

- Focused tests cover reset confirmation, local store clearing, absence of a gateway-side reset claim, reset client states, preflight projection and refresh behavior, policy assignment validation, baseline capture and restore, private file permissions, and rollback after a rejected refresh.
- Route-editor coverage includes unset and wrong passcodes, strict session-cookie attributes, passcode non-disclosure, authentication and CSRF rejection, derivation from current catalog state, browser-authority rejection, successful save, explicit restore confirmation, and specific-router mount order.
- `npm run verify:stage7:browser` is the deterministic real-browser presenter-workflow check described above. It is safe to run without Sandbox credentials because its fixture blocks live payment setup and mutation.
- JavaScript syntax, diff, full Node regression, and local HTTP checks remain part of final handoff verification; their command output, rather than this document, is authoritative for the current worktree.
- No new live Sandbox payment, 3D Secure challenge, PayPal approval, public webhook callback, or gateway-side route-editing claim is made by the Stage 7 browser harness.

## Remaining live rehearsal

Before an external presentation, rehearse both scripts against the intended connected Sandbox and record which live-dependent steps passed. In particular:

1. run a fresh merchant-account and plan discovery from `/demo/preflight`;
2. confirm the intended Card routes with real Hosted Fields tokenization and returned transaction proof;
3. complete and inspect the intended 3D Secure frictionless/challenge/failure flows before making a liability-shift claim;
4. complete a fresh linked-Sandbox PayPal buyer approval before claiming PayPal success;
5. verify the dedicated public webhook receiver and current tunnel separately rather than inferring reachability from configuration or old evidence; and
6. restore the captured route baseline and decide whether to clear only the local presentation log after rehearsal.

## Stage boundary

Stage 7 does not create or delete merchant accounts, manage gateway credentials, clean up Braintree Sandbox objects, prove public webhook reachability, provide production authentication, or make the loopback demo a hosted multi-user application. The presenter passcode is a local demonstration safeguard, not a replacement for production identity, authorization, audit, or secret management. Local reset clears evidence only; route restore changes the local overlay only.

# Stage 4 Changes: Webhooks and disputes

**Date:** 3 November 2026
**Status:** Implemented locally — live Sandbox review blocked on tunnel availability

## Outcome

Stage 4 is implemented locally and ready for the live Braintree Sandbox callback check.
Stage 5 later proceeded at the user's direction after a read-only capability review; that work
does not satisfy or remove this separate callback check.

The application now verifies signed Braintree webhooks, persists safe canonical webhook events, links disputes and subscription notifications to verified local audit records, and provides a polling dispute inbox with guarded accept, text-evidence, and finalize actions. The normal demo remains private on `127.0.0.1:3000`; a separate webhook-only listener on `127.0.0.1:3001` is the only process intended for the temporary HTTPS tunnel.

The live acceptance check has not been run yet. It requires a tunnel client, a temporary public HTTPS URL configured in the Braintree Sandbox Control Panel, and an artifact-creating dispute-card transaction.

### Live review attempt — 3 November 2026

The receiver and its real HTTP rejection path work locally, but this workstation could not establish a safe public tunnel:

- The official current and 2026.10.3 Cloudflare macOS ARM64 artifacts matched their published SHA-256 digests, but macOS rejected their code signatures and killed the executables. Gatekeeper was not bypassed and the temporary downloads were removed.
- `localhost.run` closed both documented SSH tunnel attempts before allocating a URL, consistent with outbound SSH being unavailable from this environment.
- A transient LocalTunnel fallback was denied by both the configured private npm proxy and the public npm registry with `403`; no project dependency or npm configuration was changed.

No receiver or tunnel process was left running. The remaining live review requires an approved tunnel client or a network path that permits one of these providers.

## Implementation details

### Restricted local webhook receiver

- Added a dedicated receiver process launched with `npm run webhook:receiver`.
- The receiver is hard-bound to loopback and rejects non-loopback host configuration.
- It exposes only `POST /api/webhooks/braintree`; the activity feed, payment APIs, dispute mutations, and demo pages are not mounted on its port.
- The normal application extends the existing `/api/webhooks/activity` endpoint for local polling; no parallel activity endpoint was added.

### Signed webhook processing

- Accepts only `application/x-www-form-urlencoded` requests containing exactly `bt_signature` and `bt_payload`.
- Preserves the signed values byte-for-byte and parses them with `gateway.webhookNotification.parse`.
- Invalid signatures return `400`; parse and persistence failures return non-2xx responses so Braintree can retry.
- Malformed, unsupported-charset, and oversized form bodies return bounded JSON errors without exposing body-parser diagnostics or signed values.
- Rejection logs contain only safe error names/codes and never contain the signature or payload.
- Handles the required kinds:
  - `dispute_opened`
  - `dispute_won`
  - `dispute_lost`
  - `subscription_charged_successfully`
  - `subscription_charged_unsuccessfully`
  - `subscription_went_past_due`
- Stores allowlisted summaries rather than raw SDK objects and deduplicates Braintree retries using kind, entity ID, and webhook timestamp. The duplicate decision runs inside the event-store file lock, so separate receiver processes cannot both persist the same delivery.

### Event linkage and routing proof

- Dispute notifications link by Braintree transaction ID only to verified root transaction events for the current gateway.
- Subscription notifications link by subscription ID only to verified root subscription events for the current gateway.
- Merchant-account evidence must agree when the notification provides it; otherwise the event remains unlinked and read-only.
- Webhook and dispute-action events use the existing persistent, redacted event store and appear in the transaction log.

### Dispute workflow

- Added a documented Sandbox dispute preset using test card `4023898493988028`.
- Added `/demo/disputes`, which polls the local event store without reloading the page.
- The dispute projection keeps only the newest event per dispute, is capped at 50 rows, and caches live status for 30 seconds to avoid repeatedly querying Braintree on every five-second UI poll.
- The browser submits only a server-owned webhook event ID. It never supplies a dispute ID, transaction ID, or merchant account ID.
- Before every operation, the server revalidates the current gateway, active account, linked transaction, live dispute identity, merchant account, transaction, and open status.
- Mutation locks use the gateway and Braintree dispute identity, so separate webhook events for the same dispute cannot start concurrent actions.
- Accept and finalize require explicit confirmation.
- Text evidence is bounded to 4,000 characters, sent to Braintree once, and never returned, logged, or persisted.
- Completed or ambiguous mutations are marked non-replayable so the UI does not encourage unsafe retries, including when Braintree confirms an action but the follow-up live verification fails.
- Polling pauses rendering while evidence text is being edited so a draft and focus are not lost.
- Activity-read failures use the same structured safe error contract as the dispute polling client.

## Files added

- `webhook-server.js`
- `routes/demo-disputes.js`
- `views/demo-disputes.hbs`
- `public/scripts/demo-disputes.js`
- `public/stylesheets/demo-disputes.css`
- `test/webhooks.test.js`
- `test/webhook-server.test.js`
- `test/demo-disputes.test.js`
- `test/demo-disputes-client.test.js`
- `test/stage4-app-integration.test.js`
- `docs/STAGE_4_LOCAL_WEBHOOKS.md`
- `docs/STAGE_4_CHANGES.md`

## Files modified

- `app.js`
- `package.json`
- `docs/braintree_demo_roadmap.md`
- `lib/braintree/gateway.js`
- `lib/demo/scenarios.js`
- `lib/events/store.js`
- `test/event-store.test.js`
- `public/scripts/demo.js`
- `routes/demo-log.js`
- `routes/webhooks.js`
- `test/braintree-gateway.test.js`
- `test/demo.test.js`
- `test/scenarios.test.js`
- `views/demo.hbs`
- `views/demo-log.hbs`
- `views/webhook-activity.hbs`

## Official Braintree documentation used

- [Parse webhook notifications — Node.js](https://developer.paypal.com/braintree/docs/guides/webhooks/parse/node/) — signed form fields, SDK parsing, invalid signatures, and retry behaviour.
- [Test webhook notifications — Node.js](https://developer.paypal.com/braintree/docs/guides/webhooks/testing-go-live/node/) — locally signed sample notifications without live calls.
- [Create webhooks — Node.js](https://developer.paypal.com/braintree/docs/guides/webhooks/create/node/) — public HTTPS destination and Sandbox Control Panel setup.
- [Dispute webhook reference — Node.js](https://developer.paypal.com/braintree/docs/reference/general/webhooks/dispute/node) — dispute notification kinds and object shape.
- [Subscription webhook reference — Node.js](https://developer.paypal.com/braintree/docs/reference/general/webhooks/subscription/node/) — subscription notification kinds.
- [Dispute response — Node.js](https://developer.paypal.com/braintree/docs/reference/response/dispute/node/) — merchant account, status, currency, and transaction evidence.
- [Find a dispute — Node.js](https://developer.paypal.com/braintree/docs/reference/request/dispute/find/node/) — live status lookup.
- [Accept a dispute — Node.js](https://developer.paypal.com/braintree/docs/reference/request/dispute/accept/node/) — open-status acceptance.
- [Add text evidence — Node.js](https://developer.paypal.com/braintree/docs/reference/request/dispute/add-text-evidence/node/) — evidence submission.
- [Finalize a dispute — Node.js](https://developer.paypal.com/braintree/docs/reference/request/dispute/finalize/node/) — submitting evidence to the bank.
- [Dispute testing and go-live — Node.js](https://developer.paypal.com/braintree/docs/guides/disputes/testing-go-live/node/) — dispute test card and Sandbox evidence outcomes.

## Verification performed

- Full unit suite: **287 tests passed**; no unit test made a live Braintree call.
- Real SDK-generated sample notifications were parsed locally for all six required kinds using dummy Sandbox credentials and no network request.
- Invalid signatures, malformed and oversized forms, unsupported charsets, JSON bodies, unsafe event linkage, cross-process retry deduplication, safe logging, and persistence failures are covered.
- Dispute context authority, live refetching, account/transaction mismatches, status restrictions, confirmation, evidence redaction, ambiguous outcomes, and polling behaviour are covered. A dependency-free executable browser harness verifies card rendering, caching, draft preservation, confirmation, server-owned action paths, and permanent locking after non-replayable outcomes.
- The dedicated receiver surface test proves that `/activity`, `/demo`, and mutation routes are not mounted on the tunnel port.
- A local smoke check started the receiver successfully on `127.0.0.1:3001` and then stopped it; no public tunnel or Braintree request was made.
- A real loopback HTTP form submission with an invalid signature returned `400`; the receiver logged only the safe SDK error name and did not echo the signed fields.
- Application integration coverage proves `/demo/disputes` is mounted before the broader `/demo` router.
- JavaScript syntax checks pass for every Stage 4 server and browser module.
- `git diff --check` passes.

At the time Stage 4 was completed, the general `npm run verify:sandbox` script remained the routed one-time-payment verifier from Stage 1. Stage 5 has since promoted that command to its current card-and-PayPal route verifier and preserved the original command as `npm run verify:stage1:sandbox`. Stage 4 still cannot have a meaningful command-only verifier: a genuine callback check necessarily depends on the separate receiver process, a temporary public HTTPS tunnel registered in the Sandbox Control Panel, and an artifact-creating dispute transaction. The review procedure below remains the explicit opt-in Stage 4 Sandbox verification.

## Stage boundary

Stage 4 does not itself enable additional payment methods, 3D Secure, production webhooks, presenter authentication, or a hosted deployment. Stage 5 was subsequently authorized and implemented independently after its payment-method decision and read-only capability check were completed. The live Stage 4 tunnel and callback review remains outstanding and must not be represented as passed by Stage 5 results.

## Review required

Before approving Stage 4:

1. Install or select a local HTTPS tunnel client and follow `docs/STAGE_4_LOCAL_WEBHOOKS.md`.
2. Configure the generated `/api/webhooks/braintree` URL in the Braintree Sandbox Control Panel with the six supported notification kinds.
3. Use the Control Panel's URL check and confirm invalid or test-only kinds do not create unsafe events.
4. Run the dispute preset and confirm the open dispute appears on `/demo/disputes` without a reload, linked to the original transaction and merchant account.
5. Exercise either acceptance or evidence plus finalization, then confirm the audit record contains no evidence text or signed payload.

# PhonePal routing demo: 15-minute technical script

## Audience and promise

Use this version for engineers, architects, security reviewers, and payment specialists. It demonstrates the authority boundaries and evidence chain behind the UI. It is a Braintree Sandbox implementation review, not a production certification, compliance opinion, or claim that every live integration step has been verified.

## Before the audience joins

1. Start the app on loopback with the intended Sandbox credentials. Set `DEMO_PRESENTER_PASSCODE` before startup if `/demo/routes` will be used. Do not bind the mutation app publicly for a webhook demonstration; the documented webhook workflow uses the separate restricted receiver.
2. Open `/demo/preflight`. Review the cached discovery timestamp first, then use **Refresh Sandbox discovery** for an intentional read-only merchant-account and plan discovery call.
3. Confirm every account needed by the script is active, its one-time/recurring role is correct, its enabled payment methods match the planned flow, and its Card 3D Secure policy is expected.
4. Confirm plan coverage before demonstrating Braintree Subscriptions. Model A merchant-managed recurring does not require a Braintree plan.
5. Read webhook state exactly. `WEBHOOK_PUBLIC_URL` configuration does not prove reachability. A persisted, signature-verified notification proves receipt only at its recorded time.
6. On `/demo/log`, optionally choose **Reset local demo** and accept the explicit confirmation. The operation clears only the local event store; it makes no Braintree SDK call and changes no gateway object.
7. Keep a logged-in Braintree Sandbox Control Panel tab available for resolving ambiguous outcomes. Keep all credentials, tokens, nonces, raw authentication data, and raw webhook payloads off screen.
8. Rehearse with the actual generated presets. The sequence below names USD and EUR because they are the intended demo policy; substitute equivalent discovered routes if the connected gateway differs.

## 0:00–1:30 — Architecture and trust boundary

Open `/demo` and orient the audience to the runner, route decision, payment component, inspector, and account registry.

Say:

> The browser submits intent: currency, payment purpose, amount, and method. It does not submit a merchant account ID, route policy, authoritative 3D Secure flags, customer ID, payment-method token, or subscription ID. The server resolves the route again immediately before mutation.

Explain the sequence:

1. dynamic merchant-account and plan discovery;
2. validated local policy overlay;
3. server route resolution;
4. client authorization and payment UI tied to the resolved account;
5. server-side mutation through an allowlisted gateway wrapper;
6. independent response verification and redacted local evidence.

Call account assignments a configurable demo policy—not an account capability Braintree imposes.

## 1:30–3:00 — Preflight and honest state

Open `/demo/preflight`.

Walk through:

- discovery status, timestamp, active-account count, and overlay warnings;
- each account’s currency, one-time/recurring roles, enabled methods, and Card 3D Secure policy;
- discovered plan coverage by recurring currency;
- configured versus confirmed webhook state;
- the latest persisted webhook evidence, if present.

Say:

> GET renders current local state without contacting Braintree. Refresh is explicit and read-only. This page intentionally distinguishes configured, discovered, historically observed, and currently reachable.

If refresh fails, stop mutation scenarios. A stale catalog is not treated as authority.

## 3:00–4:30 — Presenter policy editing and rollback

Open `/demo/routes` and authenticate with the environment-backed presenter passcode. Keep the passcode out of the URL, narration, screen recording, and logs.

Explain the controls:

- only currently discovered accounts are available;
- a route may select only an active account with the same currency;
- the server rebuilds every discovered currency/payment-purpose row from the current catalog; a presenter may explicitly choose **Not assigned** to make one unavailable;
- labels, method capability, and 3D Secure policy are preserved server-side rather than trusted from the form;
- save uses an atomic local overlay update followed by catalog refresh; a rejected refresh rolls the overlay back;
- the first presenter edit captures a durable local baseline, and **Restore starting policy** reapplies that baseline.

For a live edit, swap the USD one-time and recurring roles between the two active USD accounts, save, then return to `/demo` and preview both presets. Restore the baseline after the comparison. If two active same-currency accounts are not present, do not fabricate the demonstration—explain the constraint and leave the mapping unchanged.

## 4:30–6:15 — Card one-time route and response proof

Select **USD one-time purchase**, choose **Card**, and preview.

Before paying, point to:

- normalized intent;
- selected account and decision reason;
- decision trace;
- method availability and optional/required Card authentication policy.

Complete the Sandbox Card flow. Then point to the returned transaction status, merchant account, currency, instrument, route verification, and local audit state.

Say:

> Preview proves only the local decision. After mutation, the server checks Braintree’s returned merchant account, currency, method, and authentication evidence before presenting the outcome as verified.

If the request was sent but the response or audit result is ambiguous, do not retry. Use the Control Panel and start a fresh preview after investigation.

## 6:15–7:30 — Same route, different payment method

On the same one-time intent, select **PayPal** if preflight shows it enabled and a Sandbox buyer can approve the Braintree PayPal Checkout window.

Say before approval:

> Method availability is policy, but the business route remains currency plus purpose. PayPal is mediated through Braintree and Card 3D Secure is correctly not applicable.

After approval, compare the resolved account with the Card attempt. Only claim a successful PayPal transaction if the fresh browser approval and server verification complete. If buyer approval is unavailable, show the enabled method and skip mutation; do not substitute a static nonce or call it live-verified.

## 7:30–9:45 — Recurring models and vault boundaries

Select **USD recurring billing** and preview the recurring account.

### Model A: merchant-managed

1. Select **Model A · Merchant-managed**.
2. Complete the initial Card or PayPal vault/start flow.
3. After success, use **Run next cycle** once.
4. Point out that follow-up endpoints use the local audit-event reference; the browser does not post customer IDs or payment-method tokens.

Say:

> PhonePal owns the schedule in Model A. The server retrieves the bounded local reference, resolves the route again, and asks Braintree to charge the vaulted customer on that route.

### Model B: Braintree Subscription

Show this only when preflight has a matching plan and the current 3D Secure policy supports the rehearsed flow.

1. Select **Model B · Braintree Subscription** and the discovered same-currency plan.
2. Create the subscription.
3. Use **Refresh status** to read the current Braintree subscription state.
4. Do not cancel unless cancellation is an explicit part of the rehearsal; it changes a Sandbox object.

Say:

> Braintree owns the billing schedule in Model B. Plan currency and the resolved recurring account are checked before creation.

Do not describe setup authentication evidence as proof that every future merchant-initiated transaction received a fresh customer challenge.

## 9:45–12:00 — Required 3D Secure and a safe failure

Choose the active Card route marked **Required**, normally EUR.

### Frictionless or successful challenge

1. Select **Frictionless authentication** first; use **Successful issuer challenge** only if the browser challenge flow was rehearsed.
2. Preview and point to the server-owned Required policy.
3. Run the payment.
4. Read the actual authentication status, liability-shift-possible value, and liability-shifted value from the returned proof.

### Failed authentication

1. Start a fresh preview.
2. Select **Failed authentication**.
3. Run the flow and show that it stops before the payment API when authentication does not produce the required result.

Say:

> The browser can perform 3D Secure, but it cannot assert success. The server inspects the Braintree nonce and enforces the selected account’s policy before sale. Failure-before-payment is safely retryable after a fresh preview.

Never claim liability shift from the selected test scenario alone. Claim only the values the server reports from Braintree evidence.

## 12:00–13:15 — Expected failure and dispute/webhook boundary

Select the generated **processor decline** preset and point out its fixed Sandbox trigger amount. Run it only if rehearsed, then show that the expected decline is a matched demo outcome rather than a successful payment.

If an optional-3DS **dispute workflow** preset exists, explain that it uses Braintree’s Sandbox dispute card and requires a settled sale plus later asynchronous processing. The preset is deliberately omitted when no compatible optional-3DS one-time route exists.

Open `/demo/disputes` or the preflight webhook section only if evidence exists. Say:

> A signature-verified row proves what this receiver accepted at that timestamp. It does not prove today’s temporary tunnel is reachable unless that was separately checked during this session.

Do not promise immediate dispute creation or webhook delivery; both are asynchronous Sandbox behaviors.

## 13:15–14:30 — Activity evidence and redaction

Open `/demo/log` and filter by gateway, currency, or account. Correlate the route decision, transaction or recurring result, 3D Secure summary, lifecycle operation, and webhook evidence where available.

Say:

> This is an allowlisted presentation model, not a dump of SDK objects. Sensitive payment and authentication artifacts are excluded. The Braintree Sandbox Control Panel remains the authoritative place to inspect created gateway objects.

If an event reports `audit.persisted: false`, treat the gateway outcome as potentially completed and do not retry.

## 14:30–15:00 — Restore and close

If a presenter mapping was changed, use `/demo/routes` → **Restore starting policy** and confirm the affected preview again. Optionally use `/demo/log` → **Reset local demo** for the next presenter.

Close with:

> The durable design is authority plus proof: discover existing accounts, validate policy, resolve on the server, mutate through a bounded wrapper, verify Braintree’s response, and show only safe evidence.

Remind the audience that route restoration changes only the local overlay and local reset changes only the local event store. Neither operation removes created Braintree objects.

## Recovery playbook

| Situation | Presenter action | Safe statement |
| --- | --- | --- |
| Discovery or refresh fails | Stop mutations; check Sandbox environment and connectivity, then explicitly refresh | “Current routing authority is unavailable, so the demo has failed closed.” |
| Policy save is rejected | Leave the current mapping in place; correct the matrix or restore the captured baseline | “The proposed local overlay did not pass the same catalog validation used at runtime.” |
| Required 3D Secure SDK/setup fails | Do not submit; refresh the route after fixing the browser condition | “Required authentication was unavailable, so no payment was sent.” |
| Authentication fails before request | Start a fresh preview and retry only if useful | “Authentication stopped before payment; there is no payment outcome to reconcile.” |
| Request sent, response unknown, route mismatch, or audit persistence warning | Do not retry; inspect the Control Panel and local log | “A gateway mutation may exist, so retry would risk duplication.” |
| Subscription plan missing | Use Model A or skip recurring mutation | “This currency has no discovered Braintree plan for Model B.” |
| PayPal approval unavailable | Show availability only and skip mutation | “A fresh buyer approval is required; no live PayPal success is being claimed.” |
| Webhook does not arrive | Continue without the asynchronous beat | “Current public callback reachability is unconfirmed.” |
| Local reset fails | Keep the visible history; do not infer gateway change | “The local presentation store was not cleared; Braintree was not changed by this control.” |

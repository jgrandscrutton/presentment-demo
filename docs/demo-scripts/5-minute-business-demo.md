# PhonePal routing demo: 5-minute business script

## Audience and promise

Use this version for product, commercial, operations, and leadership audiences. The story is that one checkout can apply explicit business policy across currencies and payment use cases while leaving an evidence trail. This is a Braintree Sandbox demonstration, not a production-readiness claim.

## Before the audience joins

1. Start the app on loopback with the intended Braintree Sandbox credentials. Set `DEMO_PRESENTER_PASSCODE` before startup if route editing will be shown. During private setup, sign in to `/demo/routes` in a separate tab so the passcode never appears during the presentation.
2. Open `/demo/preflight`. The initial page is a read-only snapshot; use **Refresh Sandbox discovery** only when you intentionally want a live, read-only discovery check.
3. Confirm that merchant-account discovery is current, the accounts needed for the story are active, the intended payment methods are enabled, and the recurring currency has a discovered plan if Model B will be mentioned.
4. Treat webhook status literally. **Configured · reachability unconfirmed** is not a live check, and a historical signed notification proves only that the receiver worked at that earlier time.
5. Open `/demo/log` and choose **Reset local demo** if a clean activity view is useful. Read the confirmation before accepting it: this clears only local evidence. It does not delete or reverse any Braintree transaction, customer, payment method, subscription, dispute, or other Sandbox object.
6. Keep the Braintree Sandbox Control Panel open in a separate tab. Do not expose credentials, client tokens, nonces, payment-method tokens, or raw webhook payloads on screen.
7. Pick the actual discovered presets shown by the UI. The examples below use USD and EUR; if the connected Sandbox differs, use an equivalent active one-time currency and the currency whose Card policy is marked **Required**.

## 0:00–0:30 — Set the business context

Open `/demo`.

Say:

> PhonePal has one checkout, but the destination is a business decision. Currency and payment purpose select an existing Braintree merchant account. The browser never chooses or submits that account ID.

Point to the four-step runner and the account registry. Call the assignments “our demo routing policy,” not a Braintree limitation or an inherent difference between the accounts.

## 0:30–1:00 — Show readiness without over-claiming

Open `/demo/preflight` and point to discovery, route roles, payment methods, Card 3D Secure policy, plan coverage, and webhook evidence.

Say:

> This page separates what we know now from what still needs confirmation. Account and plan refresh is read-only. Webhook reachability is deliberately not inferred from configuration or old evidence.

If any required item is unavailable, skip that scenario rather than narrating it as working.

## 1:00–2:10 — Run one routed purchase

Return to `/demo` and select **USD one-time purchase** or the equivalent active one-time preset.

1. Select **Card**.
2. Choose **Preview route**.
3. Pause on the decision trace and name the resolved account and reason.
4. Complete the Sandbox payment only after the preview is clear.
5. After success, point to the returned merchant account, currency, payment method, and 3D Secure evidence shown by the inspector.

Say:

> Preview explains the policy decision. The completed result is stronger evidence: the server compares Braintree’s returned transaction with the route it selected.

Only say that a payment was created, routed, or verified after the UI shows a successful Sandbox response. A preview alone proves no gateway mutation.

## 2:10–2:50 — Contrast purchase and recurring intent

Select the matching **USD recurring billing** preset and preview it. If it resolves to a different same-currency account, place the two account names side by side.

Say:

> The currency stayed the same; the purpose changed. Our policy can separate a purchase from recurring billing without trusting the browser to name the destination.

Do not start a subscription unless preflight shows plan coverage and the extra time was rehearsed.

## 2:50–3:35 — Show strong authentication as policy

Select the active Card route whose badge says **Required**—normally EUR—and choose the **Frictionless authentication** scenario.

1. Preview the route and point to the Required policy.
2. Run the Card flow.
3. After completion, read the actual authentication status and liability-shift values from the inspector.

Say:

> Strong authentication is attached to the server-selected account policy. The demo reports Braintree’s observed result; it does not manufacture a liability-shift claim in the browser.

If authentication fails or is cancelled, say that the flow stopped before payment and move on. Do not describe liability shift unless the returned proof explicitly shows it.

## 3:35–4:20 — Show controlled presenter routing (optional live edit)

Open `/demo/routes` and sign in with the presenter passcode. Never put the passcode in the URL or say it aloud.

Point out that the page lists only already-discovered accounts and allows only same-currency assignments. It cannot accept credentials or create merchant accounts.

If changing a route was rehearsed:

1. Change the one-time or recurring assignment to another active account for that same currency.
2. Save the mapping.
3. Return to `/demo`, preview the affected scenario, and point to the new server decision.
4. Return to `/demo/routes` and use **Restore starting policy** before handing off the environment. This restores the baseline captured before the first presenter edit; it does not delete Braintree objects.

Only run the live edit when it has been pre-staged and rehearsed; otherwise show the protected page, explain the constraint, and keep the five-minute story moving. If route editing is unavailable or no same-currency alternative exists, say so plainly.

## 4:20–5:00 — Close with evidence and the reset boundary

Open `/demo/log`. Point to the safe route, instrument, result, and authentication fields. If a webhook row exists, label it historical unless current reachability was separately verified.

Say:

> The activity view is the local demonstration trail. Resetting it prepares the screen for the next presentation, but the Braintree Sandbox remains the system of record for every object we created.

End on the business message:

> One checkout can make an explainable routing decision, enforce account-specific controls, and verify the result without giving destination authority to the browser.

## Recovery notes

- **Catalog unavailable:** do not run a payment. Check Sandbox configuration and connectivity, then use the explicit refresh on `/demo/preflight`.
- **Save rejected on `/demo/routes`:** keep the current mapping. The editor rejects malformed, unknown, inactive, or cross-currency assignments; use **Restore starting policy** if a baseline exists.
- **Authentication stopped before payment:** it is safe to retry after a fresh preview. Do not claim a payment or liability shift.
- **Request sent but result unknown:** do not retry. Check the Braintree Sandbox Control Panel, then start a fresh preview.
- **Webhook absent:** continue without the webhook beat and say reachability is unconfirmed.
- **Local reset fails:** leave the log as-is. The failure does not imply that any Braintree object changed.

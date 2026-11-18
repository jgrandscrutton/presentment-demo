# Stage 4 local webhook setup

## What the tunnel is for

The demo sends payment requests **to** Braintree over the Braintree SDK. Webhooks travel in the opposite direction: Braintree sends an HTTPS POST back when an asynchronous event occurs, such as a dispute opening or a subscription charge failing. Braintree cannot call a `localhost` URL, so a temporary HTTPS tunnel is required for the live Sandbox demonstration.

The tunnel must target the dedicated webhook receiver, not the normal demo server:

```text
Braintree Sandbox
        │ signed HTTPS POST
        ▼
temporary tunnel URL
        │ forwards only to 127.0.0.1:3001
        ▼
webhook-only receiver ──► persistent local event store
                                  │
normal demo on 127.0.0.1:3000 ◄───┘
```

The receiver exposes only `POST /api/webhooks/braintree`. The transaction log, dispute actions, payment endpoints, and webhook activity feed are not available through its port.

## Run locally

1. Start the normal demo:

   ```sh
   npm start
   ```

2. In a second terminal, start the isolated receiver:

   ```sh
   npm run webhook:receiver
   ```

   It binds to `127.0.0.1:3001` by default. Set `WEBHOOK_PORT` to another local port if needed.

3. Start an HTTPS tunnel to the receiver port. For example, after installing Cloudflare Tunnel:

   ```sh
   cloudflared tunnel --url http://127.0.0.1:3001
   ```

   Install tunnel software through its official distribution path and require it to pass the operating system's signature checks. Do not disable Gatekeeper or re-sign a rejected download merely to run this demo.

4. Copy the generated HTTPS origin and append the receiver path:

   ```text
   https://your-temporary-host.example/api/webhooks/braintree
   ```

5. In the **Braintree Sandbox Control Panel**, open **Settings → API → Webhooks**, create a webhook for that HTTPS URL, and enable:

   - Dispute Opened
   - Dispute Won
   - Dispute Lost
   - Subscription Charged Successfully
   - Subscription Charged Unsuccessfully
   - Subscription Went Past Due

6. Keep the receiver and tunnel running while demonstrating. A temporary tunnel URL normally changes after restart, so update the Control Panel entry when it does.

## Demonstrate a dispute

1. Open `/demo` and select the **dispute workflow** preset.
2. Enter Sandbox card `4023 8984 9398 8028`, any future expiry, and any three-digit CVV.
3. Complete the routed sale. Braintree creates a settled Sandbox transaction with an open dispute.
4. Open `/demo/disputes`. The signed webhook should appear without a page reload and link back to the original transaction and merchant account.
5. Either accept the dispute, or add `compelling_evidence` or `losing_evidence` and finalize it to exercise the documented Sandbox outcomes.

## Security boundary

- Never point the tunnel at port `3000`.
- Never bind the webhook receiver to `0.0.0.0`; it intentionally rejects non-loopback hosts.
- The receiver accepts form-encoded requests with exactly `bt_signature` and `bt_payload`, verifies them through the Braintree SDK, and rejects invalid signatures.
- Signed payloads and evidence text are not written to logs or the local event store.
- This remains Sandbox-only.

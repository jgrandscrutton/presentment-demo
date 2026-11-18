'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const braintree = require('braintree');

const webhookRouter = require('../routes/webhooks');
const {
  SUPPORTED_WEBHOOK_KINDS,
  createWebhookRouter,
} = webhookRouter;

function hasRoute(router, method, routePath) {
  return router.stack.some(
    (layer) => layer.route?.path === routePath && layer.route.methods[method]
  );
}

test('webhook surface is Braintree-only', () => {
  assert.equal(hasRoute(webhookRouter, 'post', '/braintree'), true);
  assert.equal(hasRoute(webhookRouter, 'get', '/activity'), true);
  assert.equal(hasRoute(webhookRouter, 'post', '/paypal'), false);

  const receiverOnly = createWebhookRouter({
    gatewayClient: { parseWebhookNotification() {} },
    store: fakeStore(),
    includeActivity: false,
  });
  assert.equal(hasRoute(receiverOnly, 'post', '/braintree'), true);
  assert.equal(hasRoute(receiverOnly, 'get', '/activity'), false);
});

function fakeStore(seed = [], { appendError, listError } = {}) {
  const events = structuredClone(seed);
  let nextId = 0;
  function persist(event, isDuplicate = () => false) {
    if (appendError) throw appendError;
    const candidateId = `webhook-event-${nextId + 1}`;
    const stored = {
      ...structuredClone(event),
      gatewayMerchantId: 'merchant-test',
      id: candidateId,
      timestamp: `2026-11-02T12:00:0${nextId + 1}.000Z`,
    };
    if (events.some((candidate) => isDuplicate(
      structuredClone(candidate),
      structuredClone(stored)
    ))) {
      return null;
    }
    nextId += 1;
    events.push(stored);
    return structuredClone(stored);
  }
  return {
    events,
    list() {
      if (listError) throw listError;
      return structuredClone(events);
    },
    append(event) {
      return persist(event);
    },
    appendIfAbsent(event, isDuplicate) {
      return persist(event, isDuplicate);
    },
  };
}

function trustedTransaction(id, transactionId) {
  return {
    id,
    timestamp: '2026-11-02T10:00:00.000Z',
    gatewayMerchantId: 'merchant-test',
    type: 'transaction',
    relatedEventId: null,
    braintreeId: transactionId,
    resolvedMerchantAccountId: 'usd-sales',
    responseMerchantAccountId: 'usd-sales',
    verified: true,
    amount: '250.00',
    currency: 'USD',
    intent: { currency: 'USD', paymentType: 'one_time' },
  };
}

function trustedSubscription(id, subscriptionId) {
  return {
    id,
    timestamp: '2026-11-02T10:00:00.000Z',
    gatewayMerchantId: 'merchant-test',
    type: 'subscription',
    relatedEventId: null,
    subscriptionId,
    resolvedMerchantAccountId: 'usd-recurring',
    responseMerchantAccountId: 'usd-recurring',
    verified: true,
    amount: '49.99',
    currency: 'USD',
    intent: { currency: 'USD', paymentType: 'recurring' },
  };
}

function loggerCapture() {
  const entries = [];
  return {
    entries,
    logger: {
      error: (...args) => entries.push(['error', ...structuredClone(args)]),
      info: (...args) => entries.push(['info', ...structuredClone(args)]),
      warn: (...args) => entries.push(['warn', ...structuredClone(args)]),
    },
  };
}

function localGateway() {
  const gateway = new braintree.BraintreeGateway({
    environment: braintree.Environment.Sandbox,
    merchantId: 'merchant-test',
    publicKey: 'public-test',
    privateKey: 'private-test',
  });
  return {
    gateway,
    gatewayClient: {
      parseWebhookNotification({ btSignature, btPayload }) {
        return gateway.webhookNotification.parse(btSignature, btPayload);
      },
    },
  };
}

async function invoke(router, method, routePath, body = {}, contentType = null) {
  const normalizedMethod = method.toLowerCase();
  const layer = router.stack.find(
    (candidate) =>
      candidate.route?.path === routePath &&
      candidate.route.methods[normalizedMethod]
  );
  if (!layer) throw new Error(`No ${method} route registered for ${routePath}`);

  const req = {
    body: structuredClone(body),
    is(expected) {
      return contentType?.split(';', 1)[0] === expected ? expected : false;
    },
  };
  let response = null;
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      response = { status: this.statusCode, body: structuredClone(payload) };
      return this;
    },
    send(payload) {
      response = { status: this.statusCode, body: payload };
      return this;
    },
  };

  const handlers = layer.route.stack.map((entry) => entry.handle);
  if (normalizedMethod === 'post') {
    let nextCalled = false;
    let nextError;
    await Promise.resolve(handlers[0](req, res, (error) => {
      nextCalled = true;
      nextError = error;
    }));
    if (nextError) throw nextError;
    if (nextCalled && !response) {
      // req.body is pre-populated in this unit harness, so the Express form
      // parser between these handlers does not need a network stream.
      await Promise.resolve(handlers.at(-1)(req, res));
    }
  } else {
    await Promise.resolve(handlers[0](req, res));
  }

  if (!response) throw new Error(`${method} ${routePath} sent no response`);
  return response;
}

function harness(options = {}) {
  const router = createWebhookRouter(options);
  return {
    router,
    getActivity: () => invoke(router, 'GET', '/activity'),
    postForm: (body) => invoke(
      router,
      'POST',
      '/braintree',
      body,
      'application/x-www-form-urlencoded'
    ),
    postJson: (body) => invoke(router, 'POST', '/braintree', body, 'application/json'),
  };
}

test('all six supported SDK-signed notifications persist safe linked events', async () => {
  const { gateway, gatewayClient } = localGateway();
  const fixtures = [
    [braintree.WebhookNotification.Kind.DisputeOpened, 'txn-open', 'transaction-open'],
    [braintree.WebhookNotification.Kind.DisputeWon, 'txn-won', 'transaction-won'],
    [braintree.WebhookNotification.Kind.DisputeLost, 'txn-lost', 'transaction-lost'],
    [braintree.WebhookNotification.Kind.SubscriptionChargedSuccessfully, 'sub-success', 'subscription-success'],
    [braintree.WebhookNotification.Kind.SubscriptionChargedUnsuccessfully, 'sub-failure', 'subscription-failure'],
    [braintree.WebhookNotification.Kind.SubscriptionWentPastDue, 'sub-past-due', 'subscription-past-due'],
  ];
  const roots = fixtures.map(([kind, entityId, eventId]) =>
    kind.startsWith('dispute_')
      ? trustedTransaction(eventId, entityId)
      : trustedSubscription(eventId, entityId)
  );
  const store = fakeStore(roots);
  const receiver = harness({
    gatewayClient,
    store,
    logger: loggerCapture().logger,
    getGatewayMerchantId: () => 'merchant-test',
  });

  for (const [kind, entityId] of fixtures) {
    const sample = await gateway.webhookTesting.sampleNotification(kind, entityId);
    const response = await receiver.postForm(sample);
    assert.equal(response.status, 200, `${kind} should be accepted`);
  }

  const events = store.events.filter((event) => event.type === 'webhook');
  assert.equal(events.length, 6);
  assert.deepEqual(new Set(events.map((event) => event.webhookKind)), SUPPORTED_WEBHOOK_KINDS);

  const opened = events.find((event) => event.webhookKind === 'dispute_opened');
  assert.equal(opened.disputeId, 'txn-open');
  assert.equal(opened.disputeStatus, 'open');
  assert.equal(opened.disputeReason, 'fraud');
  assert.equal(opened.braintreeId, 'txn-open');
  assert.equal(opened.relatedEventId, 'transaction-open');
  assert.equal(opened.resolvedMerchantAccountId, 'usd-sales');
  assert.equal(opened.responseMerchantAccountId, 'usd-sales');
  assert.equal(opened.verified, true);
  assert.equal(opened.currency, 'USD');
  assert.equal(opened.response.dispute.transactionId, 'txn-open');
  assert.equal(Object.hasOwn(opened.response, 'subject'), false);

  const charged = events.find(
    (event) => event.webhookKind === 'subscription_charged_successfully'
  );
  assert.equal(charged.subscriptionId, 'sub-success');
  assert.equal(charged.braintreeId, 'sub-success');
  assert.equal(charged.relatedEventId, 'subscription-success');
  assert.equal(charged.resolvedMerchantAccountId, 'usd-recurring');
  assert.equal(charged.amount, '49.99');
  assert.equal(charged.outcome, 'succeeded');

  const pastDue = events.find(
    (event) => event.webhookKind === 'subscription_went_past_due'
  );
  assert.equal(pastDue.subscriptionStatus, 'past_due');
  assert.equal(pastDue.outcome, 'past_due');

  const persisted = JSON.stringify(events);
  assert.equal(persisted.includes('bt_signature'), false);
  assert.equal(persisted.includes('bt_payload'), false);
  assert.equal(persisted.includes('public-test|'), false);
});

test('invalid, malformed, and JSON webhooks fail closed without leaking secrets', async () => {
  const { gateway, gatewayClient } = localGateway();
  const store = fakeStore();
  const capture = loggerCapture();
  const receiver = harness({
    gatewayClient,
    store,
    logger: capture.logger,
    getGatewayMerchantId: () => 'merchant-test',
  });
  const sample = await gateway.webhookTesting.sampleNotification(
    braintree.WebhookNotification.Kind.DisputeOpened,
    'txn-secret'
  );

  const invalid = await receiver.postForm({
    ...sample,
    bt_signature: 'public-test|invalid-secret-signature',
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'INVALID_WEBHOOK_SIGNATURE');

  const missing = await receiver.postForm({ bt_signature: sample.bt_signature });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'INVALID_WEBHOOK_FORM');

  const unexpected = await receiver.postForm({ ...sample, extra: 'not-allowed' });
  assert.equal(unexpected.status, 400);
  assert.equal(unexpected.body.code, 'INVALID_WEBHOOK_FORM');

  const json = await receiver.postJson(sample);
  assert.equal(json.status, 415);
  assert.equal(json.body.code, 'UNSUPPORTED_WEBHOOK_MEDIA_TYPE');

  assert.deepEqual(store.events, []);
  const logs = JSON.stringify(capture.entries);
  assert.equal(logs.includes(sample.bt_signature), false);
  assert.equal(logs.includes(sample.bt_payload), false);
  assert.equal(logs.includes('invalid-secret-signature'), false);
});

test('unsupported signed kinds are acknowledged without persistence', async () => {
  const { gateway, gatewayClient } = localGateway();
  const store = fakeStore();
  const receiver = harness({
    gatewayClient,
    store,
    logger: loggerCapture().logger,
    getGatewayMerchantId: () => 'merchant-test',
  });
  const sample = await gateway.webhookTesting.sampleNotification(
    braintree.WebhookNotification.Kind.Check,
    'ignored-check'
  );

  const response = await receiver.postForm(sample);
  assert.equal(response.status, 202);
  assert.equal(response.body, 'Ignored');
  assert.deepEqual(store.events, []);
});

test('webhook retries are idempotent and unverified cross-gateway events stay unlinked', async () => {
  const { gateway, gatewayClient } = localGateway();
  const historical = trustedTransaction('historical-root', 'txn-retry');
  historical.gatewayMerchantId = 'different-merchant';
  const store = fakeStore([historical]);
  const receiver = harness({
    gatewayClient,
    store,
    logger: loggerCapture().logger,
    getGatewayMerchantId: () => 'merchant-test',
  });
  const sample = await gateway.webhookTesting.sampleNotification(
    braintree.WebhookNotification.Kind.DisputeOpened,
    'txn-retry'
  );

  assert.equal((await receiver.postForm(sample)).status, 200);
  assert.equal((await receiver.postForm(sample)).status, 200);

  const webhooks = store.events.filter((event) => event.type === 'webhook');
  assert.equal(webhooks.length, 1);
  assert.equal(webhooks[0].relatedEventId, null);
  assert.equal(webhooks[0].resolvedMerchantAccountId, null);
  assert.equal(webhooks[0].responseMerchantAccountId, null);
  assert.equal(webhooks[0].verified, false);
});

test('activity extends the existing endpoint with a bounded newest-per-dispute projection', async () => {
  const seed = [trustedTransaction('transaction-root', 'txn-root')];
  seed.push({
    id: 'historical-webhook',
    timestamp: '2026-11-02T11:00:00.000Z',
    gatewayMerchantId: 'historical-merchant',
    type: 'webhook',
    webhookKind: 'dispute_opened',
    webhookTimestamp: '2026-11-02T11:00:00.000Z',
    disputeId: 'historical-dispute',
    disputeStatus: 'open',
  });
  for (let index = 1; index <= 52; index += 1) {
    const disputeId = index === 52 ? 'dispute-1' : `dispute-${index}`;
    seed.push({
      id: `webhook-${index}`,
      timestamp: `2026-11-02T12:${String(index).padStart(2, '0')}:00.000Z`,
      gatewayMerchantId: 'merchant-test',
      type: 'webhook',
      webhookKind: index % 2 ? 'dispute_opened' : 'dispute_won',
      webhookTimestamp: `2026-11-02T12:${String(index).padStart(2, '0')}:00.000Z`,
      disputeId,
      disputeStatus: index % 2 ? 'open' : 'won',
      disputeReason: 'fraud',
      relatedEventId: 'transaction-root',
      resolvedMerchantAccountId: 'usd-sales',
      responseMerchantAccountId: 'usd-sales',
      verified: true,
      braintreeId: `txn-${index}`,
      amount: '10.00',
      currency: 'USD',
      response: { kind: index % 2 ? 'dispute_opened' : 'dispute_won' },
    });
  }
  const store = fakeStore(seed);
  const receiver = harness({
    gatewayClient: { parseWebhookNotification() {} },
    store,
    logger: loggerCapture().logger,
    getGatewayMerchantId: () => 'merchant-test',
  });

  const response = await receiver.getActivity();
  assert.equal(response.status, 200);
  const body = response.body;
  assert.equal(body.success, true);
  assert.equal(body.count, 53);
  assert.equal(body.events.length, 50);
  assert.equal(body.events[0].id, 'webhook-52');
  assert.equal(body.events[0].auditType, 'webhook');
  assert.equal(body.events[0].type, 'dispute_won');
  assert.deepEqual(body.events[0].data, { kind: 'dispute_won' });
  assert.equal(body.events.at(-1).id, 'webhook-3');

  assert.equal(body.disputeCount, 50);
  assert.equal(body.disputes.length, 50);
  assert.deepEqual(body.disputes[0], {
    eventId: 'webhook-52',
    receivedAt: '2026-11-02T12:52:00.000Z',
    webhookKind: 'dispute_won',
    disputeId: 'dispute-1',
    disputeStatus: 'won',
    disputeReason: 'fraud',
    transactionId: 'txn-52',
    merchantAccountId: 'usd-sales',
    amount: '10.00',
    currency: 'USD',
    linked: true,
    actionable: false,
  });
  assert.equal(body.disputes.some((dispute) => dispute.eventId === 'webhook-1'), false);
  assert.equal(body.disputes.some((dispute) => dispute.eventId === 'historical-webhook'), false);
  assert.equal(body.disputes.at(-1).eventId, 'webhook-3');
  assert.doesNotMatch(JSON.stringify(body.disputes), /request|response|payload|signature/i);
});

test('activity read failures return a structured safe error for polling clients', async () => {
  const privateDetail = 'private event-store failure detail';
  const captured = loggerCapture();
  const receiver = harness({
    gatewayClient: { parseWebhookNotification() {} },
    store: fakeStore([], { listError: new Error(privateDetail) }),
    logger: captured.logger,
    getGatewayMerchantId: () => 'merchant-test',
  });

  const response = await receiver.getActivity();

  assert.equal(response.status, 500);
  assert.equal(response.body.success, false);
  assert.equal(response.body.code, 'WEBHOOK_ACTIVITY_UNAVAILABLE');
  assert.deepEqual(response.body.error, {
    code: 'WEBHOOK_ACTIVITY_UNAVAILABLE',
    message: 'Webhook activity is temporarily unavailable.',
  });
  assert.deepEqual(response.body.events, []);
  assert.deepEqual(response.body.disputes, []);
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(privateDetail));
  assert.doesNotMatch(JSON.stringify(captured.entries), new RegExp(privateDetail));
});

test('parse and persistence failures use retryable responses with safe logs', async () => {
  const parseCapture = loggerCapture();
  const parseReceiver = harness({
    gatewayClient: {
      async parseWebhookNotification() {
        throw Object.assign(new Error('upstream failed with bt_payload=secret'), {
          code: 'UPSTREAM_FAILURE',
        });
      },
    },
    store: fakeStore(),
    logger: parseCapture.logger,
  });
  const parsed = await parseReceiver.postForm({
    bt_signature: 'signature-secret',
    bt_payload: 'payload-secret',
  });
  assert.equal(parsed.status, 502);
  assert.equal(parsed.body.code, 'WEBHOOK_PARSE_FAILED');
  assert.equal(JSON.stringify(parseCapture.entries).includes('payload-secret'), false);

  const persistenceCapture = loggerCapture();
  const persistenceReceiver = harness({
    gatewayClient: {
      async parseWebhookNotification() {
        return {
          kind: 'dispute_opened',
          timestamp: new Date('2026-11-02T12:00:00.000Z'),
          dispute: {
            id: 'dispute-1',
            status: 'open',
            transaction: { id: 'txn-1' },
          },
        };
      },
    },
    store: fakeStore([], { appendError: new Error('disk secret') }),
    logger: persistenceCapture.logger,
  });
  const persisted = await persistenceReceiver.postForm({
    bt_signature: 'signature-secret',
    bt_payload: 'payload-secret',
  });
  assert.equal(persisted.status, 500);
  assert.equal(persisted.body.code, 'WEBHOOK_PERSISTENCE_FAILED');
  const logs = JSON.stringify(persistenceCapture.entries);
  assert.equal(logs.includes('signature-secret'), false);
  assert.equal(logs.includes('payload-secret'), false);
  assert.equal(logs.includes('disk secret'), false);
});

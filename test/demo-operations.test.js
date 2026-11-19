'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDemoOperationsRouter,
} = require('../routes/demo-operations');
const {
  subtractAmounts,
  validateActionAmount,
} = require('../lib/transactions/money');

function rootEvent(overrides = {}) {
  return {
    id: 'root-event',
    timestamp: '2026-10-20T10:00:00.000Z',
    gatewayMerchantId: 'sandbox-merchant',
    type: 'transaction',
    scenarioId: 'usd-preorder',
    intent: { currency: 'USD', paymentType: 'one_time' },
    resolvedMerchantAccountId: 'usd-sales',
    responseMerchantAccountId: 'usd-sales',
    verified: true,
    paymentMethodType: 'credit_card',
    amount: '20.00',
    currency: 'USD',
    outcome: 'succeeded',
    braintreeId: 'txn-root',
    relatedEventId: null,
    ...overrides,
  };
}

function liveTransaction(overrides = {}) {
  return {
    id: 'txn-root',
    status: 'authorized',
    amount: '20.00',
    currencyIsoCode: 'USD',
    merchantAccountId: 'usd-sales',
    paymentInstrumentType: 'credit_card',
    refundIds: [],
    ...overrides,
  };
}

function fakeCatalog(overrides = {}) {
  const state = {
    status: 'ok',
    gatewayMerchantId: 'sandbox-merchant',
    accounts: [
      {
        merchantAccountId: 'usd-sales',
        currency: 'USD',
        status: 'active',
        label: 'USD sales',
      },
      {
        merchantAccountId: 'jpy-sales',
        currency: 'JPY',
        status: 'active',
        label: 'JPY sales',
      },
    ],
    ...overrides,
  };
  return {
    getState: () => structuredClone(state),
    getMerchantAccountById(id) {
      const account = state.accounts.find((candidate) => candidate.merchantAccountId === id);
      return account ? structuredClone(account) : undefined;
    },
  };
}

function fakeStore(event = rootEvent(), { appendError } = {}) {
  const events = [structuredClone(event)];
  return {
    events,
    get(id) {
      const found = events.find((candidate) => candidate.id === id);
      return found ? structuredClone(found) : undefined;
    },
    append(value) {
      if (appendError) throw appendError;
      const stored = {
        ...structuredClone(value),
        id: `follow-up-${events.length}`,
        timestamp: '2026-10-20T10:01:00.000Z',
        gatewayMerchantId: 'sandbox-merchant',
      };
      events.push(stored);
      return structuredClone(stored);
    },
  };
}

function createHarness({
  event = rootEvent(),
  catalog = fakeCatalog(),
  transactions = { 'txn-root': liveTransaction() },
  operationResults = {},
  store = fakeStore(event),
} = {}) {
  const calls = {
    find: [],
    capture: [],
    void: [],
    settle: [],
    refund: [],
  };
  const gatewayClient = {
    async findTransaction(request) {
      calls.find.push(structuredClone(request));
      const value = transactions[request.transactionId];
      if (value instanceof Error) throw value;
      return typeof value === 'function' ? value(request) : structuredClone(value);
    },
    async captureTransaction(request) {
      calls.capture.push(structuredClone(request));
      const value = operationResults.capture || {
        success: true,
        transaction: liveTransaction({
          amount: request.amount || '20.00',
          status: 'submitted_for_settlement',
        }),
      };
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
    async voidTransaction(request) {
      calls.void.push(structuredClone(request));
      const value = operationResults.void || {
        success: true,
        transaction: liveTransaction({ status: 'voided' }),
      };
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
    async settleTransaction(request) {
      calls.settle.push(structuredClone(request));
      const value = operationResults.settle || {
        success: true,
        transaction: liveTransaction({ status: 'settled' }),
      };
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
    async refundTransaction(request) {
      calls.refund.push(structuredClone(request));
      const value = operationResults.refund || {
        success: true,
        transaction: liveTransaction({
          id: 'refund-new',
          type: 'credit',
          amount: request.amount,
          status: 'submitted_for_settlement',
        }),
      };
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
  };
  const router = createDemoOperationsRouter({
    gatewayClient,
    catalogService: catalog,
    store,
    merchantId: 'sandbox-merchant',
    logger: { error() {} },
  });

  return {
    calls,
    gatewayClient,
    router,
    store,
    get(eventId = event.id) {
      return invoke(router, 'get', '/:eventId/status', {
        params: { eventId },
      });
    },
    post(action, body = {}, eventId = event.id) {
      return invoke(router, 'post', '/:eventId/actions/:action', {
        params: { eventId, action },
        body,
      });
    },
  };
}

function invoke(router, method, path, request = {}) {
  const layer = router.stack.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method]
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} route for ${path}`);
  const handler = layer.route.stack[0].handle;

  return new Promise((resolve, reject) => {
    let sent = false;
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        sent = true;
        resolve({ status: this.statusCode, body: JSON.parse(JSON.stringify(payload)) });
        return this;
      },
    };
    const next = (error) => reject(error || new Error('next() called without an error'));
    Promise.resolve(handler({ body: {}, ...request }, res, next)).then(() => {
      if (!sent) reject(new Error('Route completed without a response'));
    }, reject);
  });
}

test('status derives the transaction and merchant account from the root audit event', async () => {
  const harness = createHarness();
  const response = await harness.get();

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.transaction.status, 'authorized');
  assert.equal(response.body.actions.capture.allowed, true);
  assert.equal(response.body.actions.capture.maximumAmount, '20.00');
  assert.equal(response.body.actions.void.allowed, true);
  assert.equal(response.body.actions.settle.allowed, false);
  assert.equal(response.body.actions.refund.allowed, false);
  assert.deepEqual(harness.calls.find, [{
    merchantAccountId: 'usd-sales',
    transactionId: 'txn-root',
  }]);
});

test('legacy, historical, follow-up, stale-account, and unverified events are read-only before Braintree', async (t) => {
  const cases = [
    ['legacy', rootEvent({ gatewayMerchantId: null }), fakeCatalog(), 'LEGACY_EVENT_READ_ONLY'],
    ['historical', rootEvent({ gatewayMerchantId: 'old-gateway' }), fakeCatalog(), 'HISTORICAL_GATEWAY_READ_ONLY'],
    ['follow-up', rootEvent({ type: 'transaction_action', relatedEventId: 'older' }), fakeCatalog(), 'ROOT_TRANSACTION_REQUIRED'],
    ['stale account', rootEvent(), fakeCatalog({ accounts: [] }), 'MERCHANT_ACCOUNT_INACTIVE'],
    ['unverified', rootEvent({ verified: false }), fakeCatalog(), 'UNVERIFIED_ROUTE_READ_ONLY'],
  ];

  for (const [name, event, catalog, code] of cases) {
    await t.test(name, async () => {
      const harness = createHarness({ event, catalog, store: fakeStore(event) });
      const response = await harness.get();
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, code);
      assert.deepEqual(harness.calls.find, []);
    });
  }
});

test('a live account or currency mismatch blocks the action before the operation call', async () => {
  const harness = createHarness({
    transactions: {
      'txn-root': liveTransaction({ merchantAccountId: 'other-account' }),
    },
  });
  const response = await harness.post('capture');

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'ROUTE_VERIFICATION_FAILED');
  assert.equal(response.body.verification.expectedMerchantAccountId, 'usd-sales');
  assert.deepEqual(harness.calls.capture, []);
  assert.equal(harness.store.events.length, 1);
});

test('partial capture uses canonical exact amount and creates a related follow-up event', async () => {
  const harness = createHarness();
  const response = await harness.post('capture', { amount: '7.5' });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.deepEqual(harness.calls.capture, [{
    merchantAccountId: 'usd-sales',
    transactionId: 'txn-root',
    amount: '7.50',
  }]);
  assert.equal(harness.store.events.length, 2);
  const followUp = harness.store.events[1];
  assert.equal(followUp.type, 'transaction_action');
  assert.equal(followUp.action, 'capture');
  assert.equal(followUp.relatedEventId, 'root-event');
  assert.equal(followUp.originalBraintreeId, 'txn-root');
  assert.equal(followUp.amount, '7.50');
  assert.equal(followUp.transactionStatus, 'submitted_for_settlement');
  assert.equal(followUp.verified, true);
});

test('state matrix blocks invalid actions with a clear live-status response', async () => {
  const harness = createHarness({
    transactions: {
      'txn-root': liveTransaction({ status: 'settled' }),
    },
  });
  const response = await harness.post('void');

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'ACTION_NOT_ALLOWED');
  assert.match(response.body.error.message, /unavailable.*state/i);
  assert.deepEqual(harness.calls.void, []);
});

test('refund availability subtracts prior refunds exactly and sends the live remainder explicitly', async () => {
  const harness = createHarness({
    transactions: {
      'txn-root': liveTransaction({
        status: 'settled',
        amount: '20.00',
        refundIds: ['refund-1', 'refund-2'],
      }),
      'refund-1': liveTransaction({
        id: 'refund-1',
        status: 'settled',
        amount: '7.25',
      }),
      'refund-2': liveTransaction({
        id: 'refund-2',
        status: 'settling',
        amount: '2.10',
      }),
    },
  });

  const status = await harness.get();
  assert.equal(status.body.actions.refund.allowed, true);
  assert.equal(status.body.actions.refund.maximumAmount, '10.65');
  assert.equal(status.body.actions.refund.refundCount, 2);

  const refunded = await harness.post('refund');
  assert.equal(refunded.status, 200);
  assert.deepEqual(harness.calls.refund, [{
    merchantAccountId: 'usd-sales',
    transactionId: 'txn-root',
    amount: '10.65',
  }]);
});

test('partial refund cannot exceed the exact remaining amount', async () => {
  const harness = createHarness({
    transactions: {
      'txn-root': liveTransaction({
        status: 'settling',
        amount: '10.00',
        refundIds: ['refund-1'],
      }),
      'refund-1': liveTransaction({ id: 'refund-1', amount: '7.33' }),
    },
  });
  const response = await harness.post('refund', { amount: '2.68' });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'AMOUNT_EXCEEDS_AVAILABLE');
  assert.equal(response.body.maximumAmount, '2.67');
  assert.deepEqual(harness.calls.refund, []);
});

test('zero-decimal action amounts are canonical and decimals are rejected', async () => {
  const event = rootEvent({
    resolvedMerchantAccountId: 'jpy-sales',
    responseMerchantAccountId: 'jpy-sales',
    amount: '2000',
    currency: 'JPY',
    intent: { currency: 'JPY', paymentType: 'one_time' },
  });
  const transactions = {
    'txn-root': liveTransaction({
      merchantAccountId: 'jpy-sales',
      currencyIsoCode: 'JPY',
      amount: '2000',
    }),
  };
  const harness = createHarness({ event, transactions, store: fakeStore(event) });
  const invalid = await harness.post('capture', { amount: '100.50' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'AMOUNT_FORMAT_INVALID');

  const valid = await harness.post('capture', { amount: '100' });
  assert.equal(valid.status, 502);
  // The fake operation intentionally returns a USD result, proving the
  // post-operation account/currency verification is also enforced.
  assert.equal(valid.body.error.code, 'ROUTE_VERIFICATION_FAILED');
  assert.equal(harness.calls.capture[0].amount, '100');
});

test('browser-supplied transaction or account identifiers are rejected and never forwarded', async () => {
  const harness = createHarness();
  const response = await harness.post('capture', {
    merchantAccountId: 'attacker-choice',
    transactionId: 'attacker-transaction',
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'UNEXPECTED_ACTION_INPUT');
  assert.deepEqual(harness.calls.find, []);
  assert.deepEqual(harness.calls.capture, []);
});

test('successful gateway action with audit failure warns not to retry', async () => {
  const event = rootEvent();
  const store = fakeStore(event, { appendError: new Error('disk unavailable') });
  const harness = createHarness({ event, store });
  const response = await harness.post('capture');

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.audit.persisted, false);
  assert.match(response.body.audit.warning, /Do not retry/i);
  assert.equal(harness.calls.capture.length, 1);
});

test('failed Braintree action is persisted and returned as a normal operation failure', async () => {
  const harness = createHarness({
    operationResults: {
      capture: {
        success: false,
        message: 'Processor could not capture this authorization.',
        transaction: liveTransaction({ status: 'processor_declined' }),
      },
    },
  });
  const response = await harness.post('capture');

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'BRAINTREE_ACTION_FAILED');
  assert.equal(harness.store.events[1].outcome, 'failed');
  assert.equal(harness.store.events[1].relatedEventId, 'root-event');
});

test('a thrown lifecycle request is retry-unsafe and records an ambiguous follow-up', async () => {
  const harness = createHarness({
    operationResults: {
      capture: new Error('connection closed after request'),
    },
  });
  const response = await harness.post('capture');

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'BRAINTREE_ACTION_OUTCOME_UNKNOWN');
  assert.equal(response.body.retrySafe, false);
  assert.equal(response.body.action, 'capture');
  assert.equal(response.body.relatedEventId, 'root-event');
  assert.equal(harness.calls.capture.length, 1);

  const followUp = harness.store.events[1];
  assert.equal(followUp.type, 'transaction_action');
  assert.equal(followUp.action, 'capture');
  assert.equal(followUp.outcome, 'gateway_error');
  assert.equal(followUp.verified, false);
  assert.equal(followUp.relatedEventId, 'root-event');
  assert.equal(followUp.originalBraintreeId, 'txn-root');
});

test('money helpers preserve exact minor units without floating-point arithmetic', () => {
  assert.deepEqual(
    { ...subtractAmounts('100.00', ['0.10', '0.20'], 'USD'), units: undefined },
    { currency: 'USD', decimalPlaces: 2, units: undefined, amount: '99.70' }
  );
  assert.deepEqual(validateActionAmount('99.70', '99.70', 'USD'), {
    valid: true,
    amount: '99.70',
    code: null,
    message: null,
  });
});

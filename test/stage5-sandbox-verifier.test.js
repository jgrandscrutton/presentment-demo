'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertPayPalSandboxStrategy,
  buildVerificationCases,
  parseVerifierArguments,
  parseScenarioArguments,
  selectVerificationCases,
  verifyCase,
  verifyStage5Routes,
  verifyTransactionResult,
} = require('../scripts/verify-stage5-sandbox');

function account(overrides = {}) {
  return {
    key: 'account-gbp',
    label: 'UK Store',
    merchantAccountId: 'account-gbp',
    currency: 'GBP',
    paymentTypes: ['one_time', 'recurring'],
    paymentMethods: ['card', 'paypal'],
    paymentTypeSources: { one_time: 'policy', recurring: 'policy' },
    routingReasons: {
      one_time: 'Matched by merchant policy',
      recurring: 'Matched by merchant policy',
    },
    environment: 'sandbox',
    status: 'active',
    isDefault: true,
    assignmentState: 'assigned',
    ...overrides,
  };
}

function testNonces() {
  return {
    one_time: {
      card: 'test-card-one-time-nonce',
      paypal: 'test-paypal-one-time-nonce',
    },
    recurring: {
      card: 'test-card-recurring-nonce',
      paypal: 'test-paypal-billing-agreement-nonce',
    },
  };
}

function recordingGateway({ transactionMethod } = {}) {
  const calls = { inspect: [], sale: [], vault: [] };
  const customerMethods = new Map();
  const nonceMethods = new Map([
    ['test-card-one-time-nonce', 'card'],
    ['test-paypal-one-time-nonce', 'paypal'],
    ['test-card-recurring-nonce', 'card'],
    ['test-paypal-billing-agreement-nonce', 'paypal'],
  ]);
  let transactionNumber = 0;

  return {
    calls,
    async inspectPaymentMethodNonce(request) {
      calls.inspect.push(structuredClone(request));
      const method = nonceMethods.get(request.paymentMethodNonce);
      return method === 'paypal'
        ? { type: 'PayPalAccount', details: { payerInfo: {} } }
        : { type: 'CreditCard', details: { cardType: 'Visa', lastFour: '1111' } };
    },
    async createVaultedCustomer(request) {
      calls.vault.push(structuredClone(request));
      customerMethods.set(request.customerId, request.paymentMethod);
      if (request.paymentMethod === 'paypal') {
        return {
          success: true,
          customer: {
            id: request.customerId,
            paypalAccounts: [{
              token: 'secret-paypal-vault-token',
              default: true,
            }],
          },
        };
      }
      return {
        success: true,
        customer: {
          id: request.customerId,
          creditCards: [{
            token: 'secret-card-vault-token',
            default: true,
            cardType: 'Visa',
            maskedNumber: '411111******1111',
            verification: {
              id: 'verification-card',
              status: 'verified',
              merchantAccountId: request.merchantAccountId,
              currencyIsoCode: 'GBP',
              amount: '0.00',
            },
          }],
        },
      };
    },
    async createSale(request) {
      calls.sale.push(structuredClone(request));
      const method = request.paymentMethodNonce
        ? nonceMethods.get(request.paymentMethodNonce)
        : customerMethods.get(request.customerId);
      const returnedMethod = transactionMethod || method;
      transactionNumber += 1;
      return {
        success: true,
        transaction: {
          id: `transaction-${transactionNumber}`,
          status: 'submitted_for_settlement',
          amount: request.amount,
          merchantAccountId: request.merchantAccountId,
          currencyIsoCode: 'GBP',
          paymentInstrumentType:
            returnedMethod === 'paypal' ? 'paypal_account' : 'credit_card',
        },
      };
    },
  };
}

function memoryStore() {
  const events = [];
  return {
    events,
    append(event) {
      const stored = structuredClone({ id: `event-${events.length + 1}`, ...event });
      events.push(stored);
      return structuredClone(stored);
    },
  };
}

test('verification matrix proves payment method is not a routing input', () => {
  const accounts = [
    account(),
    account({
      key: 'account-usd',
      merchantAccountId: 'account-usd',
      label: 'US Store',
      currency: 'USD',
      paymentTypes: ['one_time'],
      paymentMethods: ['card'],
      paymentTypeSources: { one_time: 'policy' },
      routingReasons: { one_time: 'Matched by merchant policy' },
      isDefault: false,
    }),
  ];
  const cases = buildVerificationCases(accounts);

  assert.deepEqual(
    cases.map((item) => [
      item.intent.currency,
      item.intent.paymentType,
      item.paymentMethod,
      item.decision.account.merchantAccountId,
    ]),
    [
      ['GBP', 'one_time', 'card', 'account-gbp'],
      ['GBP', 'one_time', 'paypal', 'account-gbp'],
      ['GBP', 'recurring', 'card', 'account-gbp'],
      ['GBP', 'recurring', 'paypal', 'account-gbp'],
      ['USD', 'one_time', 'card', 'account-usd'],
    ]
  );
  assert.ok(cases.every((item) => !Object.hasOwn(item.decision.intent, 'paymentMethod')));
});

test('reviewed partial runs can select exact scenarios before any mutation', async () => {
  const cases = buildVerificationCases([account()]);
  const selectedId = 'verify-stage5-gbp-one-time-paypal';
  assert.deepEqual(parseScenarioArguments(['--scenario', selectedId]), [selectedId]);
  assert.deepEqual(
    parseVerifierArguments(['--allow-mocked-paypal', '--scenario', selectedId]),
    { scenarioIds: [selectedId], allowMockedPayPal: true }
  );
  assert.equal(selectVerificationCases(cases, [selectedId]).length, 1);
  assert.throws(
    () => selectVerificationCases(cases, ['verify-stage5-unknown']),
    /Unknown Stage 5 verification scenario/
  );
  assert.throws(
    () => parseScenarioArguments(['--unknown']),
    /Unknown Stage 5 verifier argument/
  );

  const gateway = recordingGateway();
  const store = memoryStore();
  const verification = await verifyStage5Routes({
    accounts: [account()],
    gateway,
    appendEvent: store.append,
    nonces: testNonces(),
    amountFor: () => '5.00',
    scenarioIds: [selectedId],
  });

  assert.deepEqual(verification.rows.map((row) => row.method), ['paypal']);
  assert.equal(gateway.calls.inspect.length, 1);
  assert.equal(gateway.calls.sale.length, 1);
  assert.equal(gateway.calls.vault.length, 0);
});

test('live PayPal verification requires an explicit compatible nonce strategy', () => {
  const cases = buildVerificationCases([account()]);
  const cardCases = cases.filter((testCase) => testCase.paymentMethod === 'card');
  const paypalCases = cases.filter((testCase) => testCase.paymentMethod === 'paypal');

  assert.doesNotThrow(() => assertPayPalSandboxStrategy(cardCases));
  assert.throws(
    () => assertPayPalSandboxStrategy(paypalCases),
    /fresh browser-generated Sandbox nonces[\s\S]*No mutation was requested/
  );
  assert.doesNotThrow(() => assertPayPalSandboxStrategy(
    paypalCases,
    { allowMockedPayPal: true }
  ));
});

test('verifier proves card and PayPal for one-time and recurring routes without persisting secrets', async () => {
  const gateway = recordingGateway();
  const store = memoryStore();
  const verification = await verifyStage5Routes({
    accounts: [account()],
    gateway,
    appendEvent: store.append,
    nonces: testNonces(),
    amountFor: () => '10.00',
    now: () => 123456,
    randomId: () => 'fixed-id',
  });

  assert.equal(verification.cases.length, 4);
  assert.equal(verification.rows.length, 4);
  assert.deepEqual(
    verification.rows.map((row) => [row.route, row.method, row.verified]),
    [
      ['GBP one_time', 'card', 'yes'],
      ['GBP one_time', 'paypal', 'yes'],
      ['GBP recurring', 'card', 'yes'],
      ['GBP recurring', 'paypal', 'yes'],
    ]
  );
  assert.equal(gateway.calls.inspect.length, 4);
  assert.equal(gateway.calls.sale.length, 4);
  assert.equal(gateway.calls.vault.length, 2);
  assert.deepEqual(
    gateway.calls.vault.map((call) => call.paymentMethod),
    ['card', 'paypal']
  );
  assert.ok(gateway.calls.sale.some(
    (call) => call.customerId && call.transactionSource === 'recurring_first'
  ));

  const serializedEvents = JSON.stringify(store.events);
  for (const forbidden of [
    'test-card-one-time-nonce',
    'test-paypal-one-time-nonce',
    'test-card-recurring-nonce',
    'test-paypal-billing-agreement-nonce',
    'secret-card-vault-token',
    'secret-paypal-vault-token',
  ]) {
    assert.equal(serializedEvents.includes(forbidden), false);
  }
  const paypalVault = store.events.find(
    (event) => event.type === 'vault' && event.paymentMethodType === 'paypal'
  );
  assert.equal(paypalVault.verification.routeEvidence, 'deferred_to_billing');
  assert.equal(paypalVault.verification.actualMerchantAccountId, null);
  assert.equal(paypalVault.verified, false);
  assert.equal(paypalVault.paymentMethodVerified, true);
  assert.equal(paypalVault.routeVerificationDeferred, true);
  const paypalRecurring = store.events.find(
    (event) => event.type === 'transaction' &&
      event.paymentMethodType === 'paypal' &&
      event.intent.paymentType === 'recurring'
  );
  assert.equal(paypalRecurring.verified, true);
  assert.equal(paypalRecurring.responsePaymentInstrumentType, 'paypal_account');
});

test('nonce method mismatch stops before route audit or mutation', async () => {
  const gateway = recordingGateway();
  gateway.inspectPaymentMethodNonce = async () => ({
    type: 'CreditCard',
    details: { cardType: 'Visa' },
  });
  const store = memoryStore();
  const testCase = buildVerificationCases([account()]).find(
    (candidate) =>
      candidate.intent.paymentType === 'one_time' &&
      candidate.paymentMethod === 'paypal'
  );

  await assert.rejects(
    verifyCase({
      gateway,
      appendEvent: store.append,
      testCase,
      nonces: testNonces(),
      amount: '10.00',
      runTag: 'test-run',
    }),
    /No mutation was requested/
  );
  assert.deepEqual(gateway.calls.sale, []);
  assert.deepEqual(gateway.calls.vault, []);
  assert.deepEqual(store.events, []);
});

test('returned instrument mismatch is audited and marked unsafe to retry', async () => {
  const gateway = recordingGateway({ transactionMethod: 'card' });
  const store = memoryStore();
  const testCase = buildVerificationCases([account()]).find(
    (candidate) =>
      candidate.intent.paymentType === 'one_time' &&
      candidate.paymentMethod === 'paypal'
  );

  await assert.rejects(
    verifyCase({
      gateway,
      appendEvent: store.append,
      testCase,
      nonces: testNonces(),
      amount: '10.00',
      runTag: 'test-run',
    }),
    /Do not retry/
  );
  assert.equal(gateway.calls.sale.length, 1);
  const event = store.events.find((candidate) => candidate.type === 'transaction');
  assert.equal(event.verified, false);
  assert.equal(event.verification.paymentMethodMatched, false);
  assert.equal(event.responsePaymentInstrumentType, 'credit_card');
});

test('a completed transaction with failed audit persistence is never presented as retry-safe', async () => {
  const gateway = recordingGateway();
  const stored = [];
  function appendEvent(event) {
    if (event.type === 'transaction') throw new Error('disk unavailable');
    const record = { id: `event-${stored.length + 1}`, ...structuredClone(event) };
    stored.push(record);
    return record;
  }
  const testCase = buildVerificationCases([account()]).find(
    (candidate) =>
      candidate.intent.paymentType === 'one_time' &&
      candidate.paymentMethod === 'card'
  );

  await assert.rejects(
    verifyCase({
      gateway,
      appendEvent,
      testCase,
      nonces: testNonces(),
      amount: '10.00',
      runTag: 'test-run',
    }),
    /could not be saved[\s\S]*Do not repeat/
  );
  assert.equal(gateway.calls.sale.length, 1);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].type, 'route_resolution');
});

test('transaction proof rejects account, currency, or instrument drift', () => {
  const decision = buildVerificationCases([account()])[0].decision;
  const base = {
    success: true,
    transaction: {
      id: 'transaction-proof',
      merchantAccountId: 'account-gbp',
      currencyIsoCode: 'GBP',
      paymentInstrumentType: 'credit_card',
    },
  };

  assert.equal(verifyTransactionResult(base, decision, 'card').passed, true);
  assert.equal(verifyTransactionResult({
    ...base,
    transaction: { ...base.transaction, merchantAccountId: 'wrong-account' },
  }, decision, 'card').passed, false);
  assert.equal(verifyTransactionResult({
    ...base,
    transaction: { ...base.transaction, currencyIsoCode: 'EUR' },
  }, decision, 'card').passed, false);
  assert.equal(verifyTransactionResult({
    ...base,
    transaction: { ...base.transaction, paymentInstrumentType: 'paypal_account' },
  }, decision, 'card').passed, false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDemoRecurringApiRouter,
} = require('../routes/demo-recurring-api');
const { getDemoAmount } = require('../lib/currency');

function account(
  merchantAccountId,
  currency,
  paymentTypes,
  {
    isDefault = false,
    paymentMethods = ['card'],
    threeDSecurePolicy = 'optional',
  } = {}
) {
  return {
    key: merchantAccountId,
    label: `${currency} ${paymentTypes.join(' + ')}`,
    merchantAccountId,
    currency,
    paymentTypes: [...paymentTypes],
    paymentMethods: [...paymentMethods],
    threeDSecurePolicy,
    paymentTypeSources: Object.fromEntries(
      paymentTypes.map((paymentType) => [paymentType, 'policy'])
    ),
    routingReasons: Object.fromEntries(
      paymentTypes.map((paymentType) => [paymentType, 'Test routing policy'])
    ),
    purpose: 'Stage 3 recurring API test fixture',
    environment: 'sandbox',
    status: 'active',
    isDefault,
    roleSource: 'policy',
    assignmentState: 'assigned',
  };
}

const ACCOUNTS = Object.freeze([
  account('account-eur', 'EUR', ['one_time', 'recurring']),
  account('account-gbp', 'GBP', ['one_time', 'recurring'], { isDefault: true }),
  account('account-usd-sale', 'USD', ['one_time']),
  account('account-usd-recurring', 'USD', ['recurring']),
]);

const PLANS = Object.freeze([
  {
    id: 'eur-monthly',
    name: 'EUR monthly',
    description: 'EUR test plan',
    currency: 'EUR',
    price: '9.00',
    billingFrequency: 1,
    trialPeriod: false,
  },
  {
    id: 'gbp-monthly',
    name: 'GBP monthly',
    description: 'GBP test plan',
    currency: 'GBP',
    price: '10.00',
    billingFrequency: 1,
    trialPeriod: false,
  },
  {
    id: 'usd-monthly',
    name: 'USD monthly',
    description: 'USD test plan',
    currency: 'USD',
    price: '12.00',
    billingFrequency: 1,
    trialPeriod: false,
  },
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createFakeCatalog({
  accounts = ACCOUNTS,
  plans = PLANS,
  gatewayMerchantId = 'sandbox-merchant',
  status = 'ok',
  planDiscoveryStatus = 'ok',
  timeline = [],
} = {}) {
  const state = {
    status,
    gatewayMerchantId,
    discoveredAt: '2026-10-27T09:00:00.000Z',
    error: status === 'ok'
      ? null
      : { code: 'MERCHANT_ACCOUNT_DISCOVERY_FAILED', message: 'Catalog unavailable.' },
    warnings: [],
    policyStatus: status === 'ok' ? 'applied' : 'not_loaded',
    accounts: clone(accounts),
    planDiscovery: {
      status: planDiscoveryStatus,
      discoveredAt: planDiscoveryStatus === 'ok'
        ? '2026-10-27T09:00:00.000Z'
        : null,
      error: planDiscoveryStatus === 'ok'
        ? null
        : { code: 'PLAN_DISCOVERY_FAILED', message: 'Plan discovery unavailable.' },
    },
    plans: clone(plans),
  };
  const calls = { assertPlanForRoute: [] };

  function requireAvailable() {
    if (state.status !== 'ok') {
      throw codedError('CATALOG_UNAVAILABLE', 'Catalog unavailable.');
    }
  }

  return {
    calls,
    getState() {
      return clone(state);
    },
    getMerchantAccounts() {
      requireAvailable();
      return clone(state.accounts);
    },
    getMerchantAccountById(merchantAccountId) {
      requireAvailable();
      const found = state.accounts.find(
        (candidate) => candidate.merchantAccountId === merchantAccountId
      );
      return clone(found);
    },
    getPlans() {
      requireAvailable();
      return clone(state.plans);
    },
    getPlansForCurrency(currency) {
      requireAvailable();
      const normalized = String(currency).trim().toUpperCase();
      return clone(state.plans.filter((plan) => plan.currency === normalized));
    },
    getPlanById(planId) {
      requireAvailable();
      return clone(state.plans.find((plan) => plan.id === planId));
    },
    assertPlanForRoute(planId, currency) {
      requireAvailable();
      calls.assertPlanForRoute.push({ planId, currency });
      timeline.push(`plan:${planId}:${currency}`);
      if (state.planDiscovery.status !== 'ok') {
        throw codedError(
          'PLAN_CATALOG_UNAVAILABLE',
          'The subscription plan catalog is unavailable.'
        );
      }
      const found = state.plans.find((plan) => plan.id === planId);
      if (!found) {
        throw codedError(
          'PLAN_NOT_FOUND',
          `Subscription plan ${planId || '(missing)'} is unavailable.`
        );
      }
      if (found.currency !== String(currency).trim().toUpperCase()) {
        throw codedError(
          'PLAN_ROUTE_MISMATCH',
          `Subscription plan ${planId} does not match the routed currency.`
        );
      }
      return clone(found);
    },
  };
}

function createFakeStore({
  gatewayMerchantId = 'sandbox-merchant',
  seed = [],
  failAppend,
} = {}) {
  const events = clone(seed);
  let appendCount = 0;

  return {
    events,
    get(id) {
      const found = events.find((event) => event.id === id);
      return clone(found);
    },
    append(event) {
      appendCount += 1;
      if (failAppend?.(event, appendCount)) {
        throw new Error('Test audit store is unavailable.');
      }
      const stored = {
        ...clone(event),
        gatewayMerchantId,
        id: `event-${events.length + 1}`,
        timestamp: `2026-10-27T09:00:0${events.length}.000Z`,
      };
      events.push(stored);
      return clone(stored);
    },
  };
}

function vaultResult(request, overrides = {}) {
  const account = ACCOUNTS.find(
    (candidate) => candidate.merchantAccountId === request.merchantAccountId
  );
  const verification = {
    id: 'verification-1',
    status: 'verified',
    amount: '0.00',
    currencyIsoCode: account?.currency || 'GBP',
    merchantAccountId: request.merchantAccountId,
    processorResponseCode: '1000',
    processorResponseText: 'Approved',
    ...overrides.verification,
  };
  const paymentMethod = {
    token: 'vault-token-server-only',
    cardType: 'Visa',
    last4: '1111',
    maskedNumber: '411111******1111',
    default: true,
    verification,
    ...overrides.paymentMethod,
  };

  return {
    success: true,
    message: 'Customer and card vaulted.',
    customer: {
      id: request.customerId,
      creditCards: [paymentMethod],
      paymentMethods: [paymentMethod],
      ...overrides.customer,
    },
    creditCardVerification: verification,
    ...overrides.result,
  };
}

function paypalVaultResult(request, overrides = {}) {
  const paymentMethod = {
    token: 'paypal-vault-token-server-only',
    email: 'buyer@example.test',
    payerId: 'payer-secret',
    billingAgreementId: 'billing-agreement-secret',
    default: true,
    ...overrides.paymentMethod,
  };
  return {
    success: true,
    message: 'PayPal account vaulted.',
    customer: {
      id: request.customerId,
      paypalAccounts: [paymentMethod],
      paymentMethods: [paymentMethod],
      ...overrides.customer,
    },
    ...overrides.result,
  };
}

function saleResult(request, overrides = {}) {
  const account = ACCOUNTS.find(
    (candidate) => candidate.merchantAccountId === request.merchantAccountId
  );
  return {
    success: true,
    message: 'Approved',
    transaction: {
      id: `txn-${request.merchantAccountId}-${request.transactionSource || 'one-time'}`,
      status: 'submitted_for_settlement',
      type: 'sale',
      amount: request.amount,
      currencyIsoCode: account?.currency || 'GBP',
      merchantAccountId: request.merchantAccountId,
      paymentInstrumentType: 'credit_card',
      processorResponseCode: '1000',
      processorResponseText: 'Approved',
      ...overrides.transaction,
    },
    ...overrides.result,
  };
}

function subscriptionResult(request, overrides = {}) {
  const account = ACCOUNTS.find(
    (candidate) => candidate.merchantAccountId === request.merchantAccountId
  );
  return {
    success: true,
    message: 'Subscription created.',
    subscription: {
      id: 'subscription-1',
      merchantAccountId: request.merchantAccountId,
      planId: request.planId,
      status: 'Active',
      price: '12.00',
      nextBillingDate: '2026-11-27',
      transactions: [{
        id: 'subscription-transaction-1',
        status: 'submitted_for_settlement',
        amount: '12.00',
        currencyIsoCode: account?.currency || 'USD',
        merchantAccountId: request.merchantAccountId,
        paymentInstrumentType: 'credit_card',
      }],
      ...overrides.subscription,
    },
    ...overrides.result,
  };
}

function createHarness({
  catalogService,
  store,
  vaultResultFactory = vaultResult,
  saleResultFactory = saleResult,
  subscriptionResultFactory = subscriptionResult,
  findSubscriptionResult,
  cancelSubscriptionResult,
  nonceResultFactory = () => ({
    type: 'CreditCard',
    details: { cardType: 'Visa', lastFour: '1111' },
  }),
  gatewayOverrides = {},
} = {}) {
  const timeline = [];
  const resolvedCatalog = catalogService || createFakeCatalog({ timeline });
  const resolvedStore = store || createFakeStore();
  const calls = {
    nonceInspection: [],
    vault: [],
    findCustomer: [],
    sale: [],
    subscriptionCreate: [],
    subscriptionFind: [],
    subscriptionCancel: [],
  };
  const gatewayClient = {
    async inspectPaymentMethodNonce(request) {
      calls.nonceInspection.push(clone(request));
      return clone(await nonceResultFactory(request));
    },
    async createVaultedCustomer(request) {
      calls.vault.push(clone(request));
      timeline.push(`vault:${request.merchantAccountId}`);
      return clone(await vaultResultFactory(request));
    },
    async findCustomer(request) {
      calls.findCustomer.push(clone(request));
      return clone(vaultResult(request).customer);
    },
    async createSale(request) {
      calls.sale.push(clone(request));
      timeline.push(`sale:${request.transactionSource || 'one_time'}`);
      return clone(await saleResultFactory(request));
    },
    async createSubscription(request) {
      calls.subscriptionCreate.push(clone(request));
      timeline.push(`subscription:${request.planId}`);
      return clone(await subscriptionResultFactory(request));
    },
    async findSubscription(request) {
      calls.subscriptionFind.push(clone(request));
      const value = findSubscriptionResult || subscriptionResult({
        merchantAccountId: request.merchantAccountId,
        planId: 'usd-monthly',
      }).subscription;
      return clone(typeof value === 'function' ? await value(request) : value);
    },
    async cancelSubscription(request) {
      calls.subscriptionCancel.push(clone(request));
      const value = cancelSubscriptionResult || subscriptionResult({
        merchantAccountId: request.merchantAccountId,
        planId: 'usd-monthly',
      }, { subscription: { id: request.subscriptionId, status: 'Canceled' } });
      return clone(typeof value === 'function' ? await value(request) : value);
    },
    ...gatewayOverrides,
  };
  const router = createDemoRecurringApiRouter({
    gatewayClient,
    catalogService: resolvedCatalog,
    store: resolvedStore,
    merchantId: 'sandbox-merchant',
    now: () => 1_793_088_000_000,
    generateId: () => '0123456789abcdef0123456789abcdef',
    logger: { error() {} },
  });

  return {
    calls,
    catalogService: resolvedCatalog,
    gatewayClient,
    router,
    store: resolvedStore,
    timeline,
    start(body) {
      return invoke(router, 'post', '/start', { body });
    },
    nextCycle(eventId, body = {}) {
      return invoke(router, 'post', '/events/:eventId/next-cycle', {
        params: { eventId },
        body,
      });
    },
    oneTime(eventId, body = {}) {
      return invoke(router, 'post', '/events/:eventId/one-time', {
        params: { eventId },
        body,
      });
    },
    subscriptionStatus(eventId) {
      return invoke(router, 'get', '/subscriptions/:eventId', {
        params: { eventId },
      });
    },
    cancelSubscription(eventId, body = {}) {
      return invoke(router, 'post', '/subscriptions/:eventId/cancel', {
        params: { eventId },
        body,
      });
    },
  };
}

function invoke(router, method, routePath, request = {}) {
  const layer = router.stack.find(
    (candidate) => candidate.route?.path === routePath &&
      candidate.route.methods[method]
  );
  if (!layer) {
    throw new Error(`No ${method.toUpperCase()} route registered for ${routePath}`);
  }
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
        const text = JSON.stringify(payload);
        resolve({ status: this.statusCode, text, body: JSON.parse(text) });
        return this;
      },
    };
    const next = (error) => reject(
      error || new Error(`${method.toUpperCase()} ${routePath} called next()`)
    );
    const req = {
      body: {},
      params: {},
      method: method.toUpperCase(),
      ...request,
    };

    Promise.resolve(handler(req, res, next)).then(() => {
      if (!sent) {
        reject(new Error(`${method.toUpperCase()} ${routePath} sent no response`));
      }
    }, reject);
  });
}

function merchantManagedBody(overrides = {}) {
  return {
    scenarioId: 'usd-recurring',
    currency: 'USD',
    paymentType: 'recurring',
    amount: '12.00',
    transactionMode: 'submit_for_settlement',
    expectedOutcome: 'approved',
    recurringModel: 'merchant_managed',
    planId: null,
    nonce: 'fake-stage3-nonce',
    ...overrides,
  };
}

function subscriptionBody(overrides = {}) {
  return merchantManagedBody({
    recurringModel: 'braintree_subscription',
    planId: 'usd-monthly',
    ...overrides,
  });
}

function assertNoSensitiveOutput(value, secrets = []) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    assert.equal(
      serialized.includes(secret),
      false,
      `safe output must not contain ${secret}`
    );
  }
  for (const field of [
    'nonce',
    'paymentMethodNonce',
    'paymentMethodToken',
    'token',
    'cardNumber',
    'number',
    'cvv',
    'privateKey',
    'publicKey',
    'clientToken',
  ]) {
    assert.equal(
      serialized.includes(`"${field}"`),
      false,
      `safe output must not contain the ${field} field`
    );
  }
}

test('Model A verifies one vault, sends recurring_first, then reuses the customer for recurring and a separately routed one-time charge', async () => {
  const harness = createHarness();
  const started = await harness.start(merchantManagedBody());

  assert.equal(started.status, 200);
  assert.equal(started.body.success, true);
  assert.equal(started.body.recurringModel, 'merchant_managed');
  assert.equal(started.body.transactionSource, 'recurring_first');
  assert.equal(started.body.threeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(started.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(
    started.body.vaultThreeDSecureVerification.evidenceScope,
    'vault_setup'
  );
  assert.equal(started.body.route.account.merchantAccountId, 'account-usd-recurring');
  assert.equal(started.body.verification.passed, true);
  assert.match(started.body.auditEventId, /^event-/);
  assert.equal(harness.calls.vault.length, 1);
  assert.equal(harness.calls.vault[0].merchantAccountId, 'account-usd-recurring');
  assert.equal(harness.calls.vault[0].paymentMethodNonce, 'fake-stage3-nonce');
  assert.match(harness.calls.vault[0].customerId, /^demo-/);
  assert.ok(harness.calls.vault[0].customerId.length <= 36);
  assert.equal(harness.calls.sale.length, 1);
  assert.equal(harness.calls.sale[0].merchantAccountId, 'account-usd-recurring');
  assert.equal(harness.calls.sale[0].amount, '12.00');
  assert.equal(harness.calls.sale[0].customerId, harness.calls.vault[0].customerId);
  assert.equal(harness.calls.sale[0].submitForSettlement, true);
  assert.equal(harness.calls.sale[0].transactionSource, 'recurring_first');
  assert.equal(Object.hasOwn(harness.calls.sale[0], 'paymentMethodNonce'), false);
  assert.equal(Object.hasOwn(harness.calls.sale[0], 'paymentMethodToken'), false);

  const rootEvent = harness.store.get(started.body.auditEventId);
  assert.equal(rootEvent.type, 'transaction');
  assert.equal(rootEvent.stage, 3);
  assert.equal(rootEvent.customerId, harness.calls.vault[0].customerId);
  assert.equal(rootEvent.recurringModel, 'merchant_managed');
  assert.equal(rootEvent.billingCycle, 'first');
  assert.equal(rootEvent.transactionSource, 'recurring_first');
  assert.equal(rootEvent.verified, true);
  assert.equal(rootEvent.threeDSecureEvidenceScope, 'vault_setup');
  assert.equal(rootEvent.transactionThreeDSecureAuthenticated, false);
  assert.equal(rootEvent.threeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(rootEvent.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');

  const next = await harness.nextCycle(started.body.auditEventId);
  assert.equal(next.status, 200);
  assert.equal(next.body.success, true);
  assert.equal(next.body.transactionSource, 'recurring');
  assert.equal(next.body.threeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(next.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(next.body.route.account.merchantAccountId, 'account-usd-recurring');
  assert.equal(harness.calls.sale[1].merchantAccountId, 'account-usd-recurring');
  assert.equal(harness.calls.sale[1].amount, '12.00');
  assert.equal(harness.calls.sale[1].customerId, harness.calls.vault[0].customerId);
  assert.equal(harness.calls.sale[1].submitForSettlement, true);
  assert.equal(harness.calls.sale[1].transactionSource, 'recurring');
  assert.equal(Object.hasOwn(harness.calls.sale[1], 'paymentMethodNonce'), false);
  assert.equal(Object.hasOwn(harness.calls.sale[1], 'paymentMethodToken'), false);

  const oneTime = await harness.oneTime(started.body.auditEventId);
  assert.equal(oneTime.status, 200);
  assert.equal(oneTime.body.success, true);
  assert.equal(oneTime.body.transactionSource, null);
  assert.equal(oneTime.body.vaultUsage, 'one_time_from_vault');
  assert.equal(
    oneTime.body.threeDSecureVerification.evidenceScope,
    'vaulted_one_time_transaction'
  );
  assert.equal(oneTime.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(oneTime.body.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(oneTime.body.route.account.merchantAccountId, 'account-usd-sale');
  assert.equal(harness.calls.sale[2].merchantAccountId, 'account-usd-sale');
  assert.equal(harness.calls.sale[2].amount, '12.00');
  assert.equal(harness.calls.sale[2].customerId, harness.calls.vault[0].customerId);
  assert.equal(harness.calls.sale[2].submitForSettlement, true);
  assert.equal(Object.hasOwn(harness.calls.sale[2], 'transactionSource'), false);
  assert.equal(Object.hasOwn(harness.calls.sale[2], 'paymentMethodNonce'), false);
  assert.equal(Object.hasOwn(harness.calls.sale[2], 'paymentMethodToken'), false);
  const oneTimeEvent = harness.store.get(oneTime.body.auditEventId);
  assert.equal(
    oneTimeEvent.threeDSecureEvidenceScope,
    'vaulted_one_time_transaction'
  );
  assert.equal(oneTimeEvent.transactionThreeDSecureAuthenticated, false);
  assert.equal(oneTimeEvent.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
});

test('PayPal Model A vaults without card proof, verifies billing route, and blocks the device-data-free one-time action', async () => {
  const accounts = ACCOUNTS.map((candidate) => ({
    ...candidate,
    paymentMethods: ['card', 'paypal'],
  }));
  const harness = createHarness({
    catalogService: createFakeCatalog({ accounts }),
    nonceResultFactory: () => ({
      type: 'PayPalAccount',
      details: { payerInfo: { email: 'buyer@example.test' } },
    }),
    vaultResultFactory: paypalVaultResult,
    saleResultFactory(request) {
      return saleResult(request, {
        transaction: { paymentInstrumentType: 'paypal_account' },
      });
    },
  });

  const started = await harness.start(merchantManagedBody({
    paymentMethod: 'paypal',
    nonce: 'paypal-recurring-nonce',
  }));

  assert.equal(started.status, 200);
  assert.equal(started.body.success, true);
  assert.equal(started.body.request.paymentMethod, 'paypal');
  assert.equal(started.body.vaultVerification.passed, true);
  assert.equal(started.body.vaultVerification.routeEvidence, 'deferred_to_billing');
  assert.equal(started.body.vaultVerification.actualMerchantAccountId, null);
  assert.equal(started.body.verification.passed, true);
  assert.equal(started.body.verification.actualPaymentMethod, 'paypal');
  assert.deepEqual(harness.calls.nonceInspection, [{
    paymentMethodNonce: 'paypal-recurring-nonce',
  }]);
  assert.equal(harness.calls.vault[0].paymentMethod, 'paypal');
  assert.equal(harness.calls.vault[0].merchantAccountId, 'account-usd-recurring');
  assertNoSensitiveOutput(started.text, [
    'paypal-recurring-nonce',
    'paypal-vault-token-server-only',
    'buyer@example.test',
    'payer-secret',
    'billing-agreement-secret',
  ]);

  const root = harness.store.get(started.body.auditEventId);
  assert.equal(root.paymentMethod, 'paypal');
  assert.equal(root.paymentMethodType, 'paypal_account');
  const vaultEvent = harness.store.get(root.vaultEventId);
  assert.equal(vaultEvent.paymentMethodVerified, true);
  assert.equal(vaultEvent.verified, false);
  assert.equal(vaultEvent.responseMerchantAccountId, null);

  const next = await harness.nextCycle(started.body.auditEventId);
  assert.equal(next.status, 200);
  assert.equal(next.body.paymentMethod, 'paypal');
  assert.equal(next.body.verification.instrumentMatched, true);

  const saleCount = harness.calls.sale.length;
  const oneTime = await harness.oneTime(started.body.auditEventId);
  assert.equal(oneTime.status, 422);
  assert.equal(oneTime.body.error.code, 'PAYPAL_VAULT_ONE_TIME_UNSUPPORTED');
  assert.equal(oneTime.body.retrySafe, true);
  assert.equal(harness.calls.sale.length, saleCount);
});

test('PayPal Model B extracts the server-only token and lets the subscription prove its route', async () => {
  const accounts = ACCOUNTS.map((candidate) => ({
    ...candidate,
    paymentMethods: ['card', 'paypal'],
  }));
  const harness = createHarness({
    catalogService: createFakeCatalog({ accounts }),
    nonceResultFactory: () => ({
      type: 'PayPalAccount',
      details: { payerInfo: { payerId: 'payer-secret' } },
    }),
    vaultResultFactory: paypalVaultResult,
    subscriptionResultFactory(request) {
      return subscriptionResult(request, {
        subscription: {
          transactions: [{
            id: 'subscription-paypal-transaction-1',
            status: 'submitted_for_settlement',
            amount: '12.00',
            currencyIsoCode: 'USD',
            merchantAccountId: request.merchantAccountId,
            paymentInstrumentType: 'paypal_account',
          }],
        },
      });
    },
  });

  const response = await harness.start(subscriptionBody({
    paymentMethod: 'paypal',
    nonce: 'paypal-subscription-nonce',
  }));

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.request.paymentMethod, 'paypal');
  assert.equal(response.body.verification.passed, true);
  assert.deepEqual(harness.calls.subscriptionCreate, [{
    merchantAccountId: 'account-usd-recurring',
    paymentMethodToken: 'paypal-vault-token-server-only',
    planId: 'usd-monthly',
  }]);
  assertNoSensitiveOutput(response.text, [
    'paypal-subscription-nonce',
    'paypal-vault-token-server-only',
    'payer-secret',
  ]);
  assert.equal(
    harness.store.get(response.body.auditEventId).paymentMethod,
    'paypal'
  );
});

test('recurring PayPal capability and nonce type are enforced before vault mutation', async (t) => {
  await t.test('policy-unavailable method', async () => {
    const harness = createHarness();
    const response = await harness.start(merchantManagedBody({
      paymentMethod: 'paypal',
      nonce: 'paypal-nonce',
    }));

    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'PAYMENT_METHOD_UNAVAILABLE');
    assert.deepEqual(harness.calls.nonceInspection, []);
    assert.deepEqual(harness.calls.vault, []);
  });

  await t.test('declared PayPal with card nonce', async () => {
    const accounts = ACCOUNTS.map((candidate) => ({
      ...candidate,
      paymentMethods: ['card', 'paypal'],
    }));
    const harness = createHarness({
      catalogService: createFakeCatalog({ accounts }),
    });
    const response = await harness.start(merchantManagedBody({
      paymentMethod: 'paypal',
      nonce: 'spoofed-card-nonce',
    }));

    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'PAYMENT_METHOD_MISMATCH');
    assert.equal(response.body.retrySafe, true);
    assert.deepEqual(harness.calls.vault, []);
    assert.deepEqual(harness.calls.sale, []);
    assertNoSensitiveOutput(response.text, ['spoofed-card-nonce']);
  });

  await t.test('ambiguous nonce metadata', async () => {
    const accounts = ACCOUNTS.map((candidate) => ({
      ...candidate,
      paymentMethods: ['card', 'paypal'],
    }));
    const harness = createHarness({
      catalogService: createFakeCatalog({ accounts }),
      nonceResultFactory: () => ({
        type: 'PayPalAccount',
        details: { cardType: 'Visa', payerInfo: {} },
      }),
    });
    const response = await harness.start(merchantManagedBody({
      paymentMethod: 'paypal',
      nonce: 'ambiguous-nonce',
    }));

    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'PAYMENT_METHOD_TYPE_UNVERIFIED');
    assert.deepEqual(harness.calls.vault, []);
  });
});

test('required recurring 3D Secure blocks unverified card nonces before vaulting', async () => {
  const accounts = ACCOUNTS.map((candidate) => candidate.merchantAccountId === 'account-eur'
    ? { ...candidate, threeDSecurePolicy: 'required' }
    : candidate);
  const harness = createHarness({
    catalogService: createFakeCatalog({ accounts }),
  });

  const response = await harness.start(merchantManagedBody({
    scenarioId: 'eur-recurring',
    currency: 'EUR',
    amount: '9.00',
    nonce: 'unverified-eur-nonce',
  }));

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'THREE_D_SECURE_REQUIRED');
  assert.equal(response.body.retrySafe, true);
  assert.equal(response.body.route.account.threeDSecurePolicy, 'required');
  assert.equal(response.body.threeDSecureVerification.passed, false);
  assert.equal(response.body.threeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(response.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(harness.calls.nonceInspection.length, 1);
  assert.deepEqual(harness.calls.vault, []);
  assert.deepEqual(harness.calls.sale, []);
  assert.equal(harness.store.events.at(-1).type, 'three_d_secure');
  assert.equal(harness.store.events.at(-1).stage, 6);
  assert.equal(harness.store.events.at(-1).outcome, 'blocked');
  assert.equal(
    harness.store.events.at(-1).threeDSecureEvidenceScope,
    'vault_setup'
  );
  assert.equal(
    harness.store.events.at(-1).transactionThreeDSecureAuthenticated,
    false
  );
  assertNoSensitiveOutput(response.text, ['unverified-eur-nonce']);
});

test('required recurring 3D Secure proof is scoped to vault setup and the recurring mandate', async () => {
  const accounts = ACCOUNTS.map((candidate) => candidate.merchantAccountId === 'account-eur'
    ? { ...candidate, threeDSecurePolicy: 'required' }
    : candidate);
  const threeDSecureInfo = {
    status: 'authenticate_successful',
    liabilityShiftPossible: true,
    liabilityShifted: true,
  };
  const harness = createHarness({
    catalogService: createFakeCatalog({ accounts }),
    nonceResultFactory: () => ({
      type: 'CreditCard',
      details: { cardType: 'Visa', lastFour: '2701' },
      threeDSecureInfo,
    }),
  });

  const response = await harness.start(merchantManagedBody({
    scenarioId: 'eur-recurring',
    currency: 'EUR',
    amount: '9.00',
    nonce: 'authenticated-eur-nonce',
  }));

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.threeDSecureVerification.policy, 'required');
  assert.equal(response.body.threeDSecureVerification.liabilityShifted, true);
  assert.equal(response.body.threeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(response.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(harness.calls.vault.length, 1);
  assert.equal(harness.calls.sale.length, 1);
  const vaultEvent = harness.store.events.find((event) => event.type === 'vault');
  const transactionEvent = harness.store.get(response.body.auditEventId);
  assert.equal(vaultEvent.threeDSecureStatus, 'authenticate_successful');
  assert.equal(vaultEvent.liabilityShifted, true);
  assert.equal(vaultEvent.threeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(transactionEvent.threeDSecurePolicy, 'required');
  assert.equal(transactionEvent.liabilityShifted, true);
  assert.equal(transactionEvent.threeDSecureEvidenceScope, 'vault_setup');
  assert.equal(transactionEvent.transactionThreeDSecureAuthenticated, false);
  assertNoSensitiveOutput(response.text, ['authenticated-eur-nonce']);
});

test('required 3D Secure Model B stops before vaulting because setup proof cannot authenticate the subscription transaction', async () => {
  const accounts = ACCOUNTS.map((candidate) =>
    candidate.merchantAccountId === 'account-eur'
      ? { ...candidate, threeDSecurePolicy: 'required' }
      : candidate
  );
  const harness = createHarness({
    catalogService: createFakeCatalog({ accounts }),
    nonceResultFactory: () => ({
      type: 'CreditCard',
      details: { cardType: 'Visa', lastFour: '2701' },
      threeDSecureInfo: {
        status: 'authenticate_successful',
        liabilityShiftPossible: true,
        liabilityShifted: true,
      },
    }),
  });

  const response = await harness.start(subscriptionBody({
    scenarioId: 'eur-recurring',
    currency: 'EUR',
    planId: 'eur-monthly',
    nonce: 'authenticated-eur-subscription-nonce',
  }));

  assert.equal(response.status, 422);
  assert.equal(
    response.body.error.code,
    'THREE_D_SECURE_SUBSCRIPTION_REAUTH_REQUIRED'
  );
  assert.equal(response.body.retrySafe, true);
  assert.equal(response.body.threeDSecureVerification.passed, true);
  assert.equal(response.body.threeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(response.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(harness.calls.nonceInspection.length, 1);
  assert.deepEqual(harness.calls.vault, []);
  assert.deepEqual(harness.calls.subscriptionCreate, []);
  assert.equal(harness.store.events.length, 1);
  assert.equal(harness.store.events[0].type, 'route_resolution');
  assertNoSensitiveOutput(response.text, ['authenticated-eur-subscription-nonce']);
});

test('optional Model B separates vault-setup 3D Secure evidence from subscription transaction evidence', async () => {
  const harness = createHarness({
    nonceResultFactory: () => ({
      type: 'CreditCard',
      details: { cardType: 'Visa', lastFour: '2701' },
      threeDSecureInfo: {
        status: 'authenticate_successful',
        liabilityShiftPossible: true,
        liabilityShifted: true,
      },
    }),
  });

  const response = await harness.start(subscriptionBody({
    nonce: 'optional-authenticated-subscription-nonce',
  }));

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(response.body.vaultThreeDSecureVerification.liabilityShifted, true);
  assert.equal(
    response.body.threeDSecureVerification.evidenceScope,
    'subscription_transaction'
  );
  assert.equal(response.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(response.body.threeDSecureVerification.performed, false);
  assert.equal(response.body.threeDSecureVerification.liabilityShifted, null);

  const vaultEvent = harness.store.events.find((event) => event.type === 'vault');
  const subscriptionEvent = harness.store.get(response.body.auditEventId);
  assert.equal(vaultEvent.liabilityShifted, true);
  assert.equal(subscriptionEvent.liabilityShifted, null);
  assert.equal(subscriptionEvent.threeDSecureEvidenceScope, 'subscription_transaction');
  assert.equal(subscriptionEvent.transactionThreeDSecureAuthenticated, false);
  assert.equal(subscriptionEvent.vaultThreeDSecureVerification.liabilityShifted, true);
  assertNoSensitiveOutput(response.text, ['optional-authenticated-subscription-nonce']);
});

test('vaulted one-time follow-up requires fresh authentication on a required target', async () => {
  const accounts = ACCOUNTS.map((candidate) => {
    if (candidate.merchantAccountId === 'account-usd-sale') {
      return { ...candidate, threeDSecurePolicy: 'required' };
    }
    return candidate;
  });
  const harness = createHarness({
    catalogService: createFakeCatalog({ accounts }),
  });
  const started = await harness.start(merchantManagedBody());
  assert.equal(started.status, 200);
  assert.equal(started.body.threeDSecureVerification.policy, 'optional');
  assert.equal(started.body.threeDSecureVerification.performed, false);
  const saleCount = harness.calls.sale.length;

  const response = await harness.oneTime(started.body.auditEventId);

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'THREE_D_SECURE_FRESH_AUTHENTICATION_REQUIRED');
  assert.equal(response.body.retrySafe, true);
  assert.equal(response.body.route.account.merchantAccountId, 'account-usd-sale');
  assert.equal(response.body.threeDSecureVerification.policy, 'required');
  assert.equal(response.body.threeDSecureVerification.passed, false);
  assert.equal(
    response.body.threeDSecureVerification.evidenceScope,
    'vaulted_one_time_transaction'
  );
  assert.equal(harness.calls.sale.length, saleCount);
});

test('historical shifted liability never authorizes a new required vaulted one-time charge', async () => {
  const accounts = ACCOUNTS.map((candidate) =>
    candidate.merchantAccountId === 'account-usd-sale'
      ? { ...candidate, threeDSecurePolicy: 'required' }
      : candidate
  );
  const harness = createHarness({
    catalogService: createFakeCatalog({ accounts }),
    nonceResultFactory: () => ({
      type: 'CreditCard',
      details: { cardType: 'Visa', lastFour: '2701' },
      threeDSecureInfo: {
        status: 'authenticate_successful',
        liabilityShiftPossible: true,
        liabilityShifted: true,
      },
    }),
  });
  const started = await harness.start(merchantManagedBody());
  assert.equal(started.status, 200);
  assert.equal(started.body.threeDSecureVerification.liabilityShifted, true);
  const saleCount = harness.calls.sale.length;

  const response = await harness.oneTime(started.body.auditEventId);

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'THREE_D_SECURE_FRESH_AUTHENTICATION_REQUIRED');
  assert.equal(response.body.threeDSecureVerification.passed, false);
  assert.equal(response.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(response.body.threeDSecureVerification.liabilityShifted, null);
  assert.equal(response.body.vaultThreeDSecureVerification.liabilityShifted, true);
  assert.equal(
    response.body.vaultThreeDSecureVerification.evidenceScope,
    'vault_setup'
  );
  assert.equal(harness.calls.sale.length, saleCount);
});

test('follow-up actions reject browser-supplied authority before any gateway call', async () => {
  const harness = createHarness();
  const started = await harness.start(merchantManagedBody());
  const saleCount = harness.calls.sale.length;
  const hostile = {
    merchantAccountId: 'attacker-account',
    customerId: 'attacker-customer',
    amount: '999.00',
    transactionSource: 'recurring_first',
    paymentMethodToken: 'attacker-token',
  };

  const next = await harness.nextCycle(started.body.auditEventId, hostile);
  assert.equal(next.status, 400);
  assert.equal(next.body.error.code, 'UNEXPECTED_RECURRING_ACTION_INPUT');
  assert.equal(harness.calls.sale.length, saleCount);
  assertNoSensitiveOutput(next.text, ['attacker-token']);

  const oneTime = await harness.oneTime(started.body.auditEventId, hostile);
  assert.equal(oneTime.status, 400);
  assert.equal(oneTime.body.error.code, 'UNEXPECTED_RECURRING_ACTION_INPUT');
  assert.equal(harness.calls.sale.length, saleCount);
  assertNoSensitiveOutput(oneTime.text, ['attacker-token']);
});

test('recurring start rejects browser-supplied account, customer, token, and transaction-source authority', async () => {
  const harness = createHarness();
  const response = await harness.start(merchantManagedBody({
    merchantAccountId: 'attacker-account',
    customerId: 'attacker-customer',
    paymentMethodToken: 'attacker-token',
    transactionSource: 'recurring',
    threeDSecurePolicy: 'optional',
    liabilityShifted: true,
  }));

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_RECURRING_INPUT');
  assert.deepEqual(harness.calls.vault, []);
  assert.deepEqual(harness.calls.sale, []);
  assert.deepEqual(harness.calls.subscriptionCreate, []);
  assertNoSensitiveOutput(response.text, ['attacker-token']);
});

test('Model B validates plan availability and routed currency before vaulting', async (t) => {
  await t.test('no discovered plan', async () => {
    const timeline = [];
    const catalogService = createFakeCatalog({ plans: [], timeline });
    const harness = createHarness({ catalogService });
    const response = await harness.start(subscriptionBody({ planId: 'missing-plan' }));

    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'PLAN_NOT_FOUND');
    assert.deepEqual(harness.calls.vault, []);
    assert.deepEqual(harness.calls.subscriptionCreate, []);
    assert.deepEqual(timeline, ['plan:missing-plan:USD']);
  });

  await t.test('plan discovery unavailable', async () => {
    const timeline = [];
    const catalogService = createFakeCatalog({
      planDiscoveryStatus: 'failed',
      timeline,
    });
    const harness = createHarness({ catalogService });
    const response = await harness.start(subscriptionBody());

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'PLAN_CATALOG_UNAVAILABLE');
    assert.deepEqual(harness.calls.vault, []);
    assert.deepEqual(harness.calls.subscriptionCreate, []);
    assert.deepEqual(timeline, ['plan:usd-monthly:USD']);
  });

  await t.test('plan currency mismatch', async () => {
    const timeline = [];
    const catalogService = createFakeCatalog({ timeline });
    const harness = createHarness({ catalogService });
    const response = await harness.start(subscriptionBody({ planId: 'eur-monthly' }));

    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'PLAN_ROUTE_MISMATCH');
    assert.deepEqual(harness.calls.vault, []);
    assert.deepEqual(harness.calls.subscriptionCreate, []);
    assert.deepEqual(timeline, ['plan:eur-monthly:USD']);
  });

  await t.test('high plan price is authoritative while the comparison uses a safe demo amount', async () => {
    const timeline = [];
    const highPricePlan = {
      ...PLANS.find((plan) => plan.id === 'usd-monthly'),
      id: 'usd-high-price',
      price: '5000.00',
    };
    const catalogService = createFakeCatalog({
      plans: [highPricePlan],
      timeline,
    });
    const harness = createHarness({
      catalogService,
      subscriptionResultFactory(request) {
        return subscriptionResult(request, {
          subscription: {
            price: highPricePlan.price,
            transactions: [{
              id: 'subscription-transaction-high-price',
              status: 'submitted_for_settlement',
              amount: highPricePlan.price,
              currencyIsoCode: 'USD',
              merchantAccountId: request.merchantAccountId,
              paymentInstrumentType: 'credit_card',
            }],
          },
        });
      },
    });
    const response = await harness.start(subscriptionBody({
      planId: highPricePlan.id,
      amount: '0.01',
    }));

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.request.amount, highPricePlan.price);
    assert.equal(response.body.subscription.price, highPricePlan.price);
    assert.deepEqual(harness.calls.subscriptionCreate, [{
      merchantAccountId: 'account-usd-recurring',
      paymentMethodToken: 'vault-token-server-only',
      planId: highPricePlan.id,
    }]);
    assert.deepEqual(timeline, [`plan:${highPricePlan.id}:USD`]);
    assert.deepEqual(harness.timeline, [
      'vault:account-usd-recurring',
      `subscription:${highPricePlan.id}`,
    ]);

    const oneTime = await harness.oneTime(response.body.auditEventId);

    assert.equal(oneTime.status, 200);
    assert.equal(oneTime.body.success, true);
    assert.equal(oneTime.body.vaultUsage, 'one_time_from_vault');
    assert.equal(oneTime.body.route.account.merchantAccountId, 'account-usd-sale');
    assert.deepEqual(harness.calls.sale, [{
      merchantAccountId: 'account-usd-sale',
      amount: getDemoAmount('USD'),
      customerId: harness.calls.vault[0].customerId,
      orderId: 'demo-vault-one-time-usd-recurring-1793088000000-0123456789abcdef0123456789abcdef',
      submitForSettlement: true,
    }]);
  });

  await t.test('a zero-price plan remains usable and the comparison gets a positive demo amount', async () => {
    const zeroPricePlan = {
      ...PLANS.find((plan) => plan.id === 'usd-monthly'),
      id: 'usd-zero-price',
      price: '0.00',
    };
    const harness = createHarness({
      catalogService: createFakeCatalog({ plans: [zeroPricePlan] }),
      subscriptionResultFactory(request) {
        return subscriptionResult(request, {
          subscription: { price: zeroPricePlan.price, transactions: [] },
        });
      },
    });

    const started = await harness.start(subscriptionBody({
      planId: zeroPricePlan.id,
    }));
    const oneTime = await harness.oneTime(started.body.auditEventId);

    assert.equal(started.status, 200);
    assert.equal(started.body.request.amount, zeroPricePlan.price);
    assert.equal(oneTime.status, 200);
    assert.deepEqual(harness.calls.sale, [{
      merchantAccountId: 'account-usd-sale',
      amount: getDemoAmount('USD'),
      customerId: harness.calls.vault[0].customerId,
      orderId: 'demo-vault-one-time-usd-recurring-1793088000000-0123456789abcdef0123456789abcdef',
      submitForSettlement: true,
    }]);
  });
});

test('Model B fails closed when a returned subscription transaction has no recognizable instrument', async () => {
  const harness = createHarness({
    subscriptionResultFactory(request) {
      return subscriptionResult(request, {
        subscription: {
          transactions: [{
            id: 'subscription-transaction-unknown-instrument',
            status: 'submitted_for_settlement',
            amount: '12.00',
            currencyIsoCode: 'USD',
            merchantAccountId: request.merchantAccountId,
          }],
        },
      });
    },
  });

  const response = await harness.start(subscriptionBody());

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'ROUTE_VERIFICATION_FAILED');
  assert.equal(response.body.verification.instrumentEvidenceAvailable, true);
  assert.equal(response.body.verification.instrumentMatched, false);
  assert.deepEqual(response.body.verification.actualPaymentMethods, [null]);
  assert.equal(response.body.retrySafe, false);
});

test('Model B creates, reads, and cancels a subscription using only persisted event authority', async () => {
  const harness = createHarness({
    nonceResultFactory: () => ({
      type: 'CreditCard',
      details: { cardType: 'Visa', lastFour: '2701' },
      threeDSecureInfo: {
        status: 'authenticate_successful',
        liabilityShiftPossible: true,
        liabilityShifted: true,
      },
    }),
  });
  const started = await harness.start(subscriptionBody());

  assert.equal(started.status, 200);
  assert.equal(started.body.success, true);
  assert.equal(started.body.recurringModel, 'braintree_subscription');
  assert.equal(started.body.transactionSource, null);
  assert.equal(started.body.scheduleOwner, 'braintree');
  assert.equal(started.body.route.account.merchantAccountId, 'account-usd-recurring');
  assert.equal(started.body.verification.passed, true);
  assert.equal(started.body.subscription.id, 'subscription-1');
  assert.equal(
    started.body.controlPanelUrl,
    'https://sandbox.braintreegateway.com/merchants/sandbox-merchant/subscriptions/subscription-1'
  );
  assert.deepEqual(harness.catalogService.calls.assertPlanForRoute, [{
    planId: 'usd-monthly',
    currency: 'USD',
  }]);
  assert.deepEqual(harness.timeline.slice(0, 3), [
    'plan:usd-monthly:USD',
    'vault:account-usd-recurring',
    'subscription:usd-monthly',
  ]);
  assert.deepEqual(harness.calls.subscriptionCreate, [{
    merchantAccountId: 'account-usd-recurring',
    paymentMethodToken: 'vault-token-server-only',
    planId: 'usd-monthly',
  }]);

  const rootEvent = harness.store.get(started.body.auditEventId);
  assert.equal(rootEvent.type, 'subscription');
  assert.equal(rootEvent.stage, 3);
  assert.equal(rootEvent.planId, 'usd-monthly');
  assert.equal(rootEvent.subscriptionId, 'subscription-1');
  assert.equal(rootEvent.resolvedMerchantAccountId, 'account-usd-recurring');
  assert.equal(rootEvent.verified, true);
  assert.equal(rootEvent.threeDSecureEvidenceScope, 'subscription_transaction');
  assert.equal(rootEvent.transactionThreeDSecureAuthenticated, false);
  assert.equal(
    rootEvent.threeDSecureVerification.evidenceScope,
    'subscription_transaction'
  );
  assert.equal(rootEvent.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(rootEvent.vaultThreeDSecureVerification.liabilityShifted, true);

  // Subscription status and cancellation are not sale operations. A valid
  // plan price outside this demo's one-time sale range must not make the
  // existing subscription unmanageable.
  harness.store.events.find((event) => event.id === rootEvent.id).amount = '5000.00';

  const status = await harness.subscriptionStatus(started.body.auditEventId);
  assert.equal(status.status, 200);
  assert.equal(status.body.success, true);
  assert.equal(status.body.subscription.id, 'subscription-1');
  assert.equal(status.body.controlPanelUrl, started.body.controlPanelUrl);
  assert.equal(
    status.body.threeDSecureVerification.evidenceScope,
    'subscription_transaction'
  );
  assert.equal(status.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(status.body.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(status.body.vaultThreeDSecureVerification.liabilityShifted, true);
  assert.deepEqual(harness.calls.subscriptionFind, [{
    subscriptionId: 'subscription-1',
    merchantAccountId: 'account-usd-recurring',
  }]);

  const oneTime = await harness.oneTime(started.body.auditEventId);
  assert.equal(oneTime.status, 200);
  assert.equal(
    oneTime.body.threeDSecureVerification.evidenceScope,
    'vaulted_one_time_transaction'
  );
  assert.equal(oneTime.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(oneTime.body.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(oneTime.body.vaultThreeDSecureVerification.liabilityShifted, true);

  const canceled = await harness.cancelSubscription(started.body.auditEventId);
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.success, true);
  assert.equal(canceled.body.subscription.status, 'Canceled');
  assert.equal(canceled.body.controlPanelUrl, started.body.controlPanelUrl);
  assert.equal(
    canceled.body.threeDSecureVerification.evidenceScope,
    'subscription_transaction'
  );
  assert.equal(canceled.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(canceled.body.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(canceled.body.vaultThreeDSecureVerification.liabilityShifted, true);
  assert.deepEqual(harness.calls.subscriptionCancel, [{
    subscriptionId: 'subscription-1',
    merchantAccountId: 'account-usd-recurring',
  }]);
  const action = harness.store.events.at(-1);
  assert.equal(action.type, 'subscription_action');
  assert.equal(action.action, 'cancel');
  assert.equal(action.relatedEventId, rootEvent.id);
  assert.equal(action.threeDSecureEvidenceScope, 'subscription_transaction');
  assert.equal(action.transactionThreeDSecureAuthenticated, false);
  assert.equal(action.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(action.vaultThreeDSecureVerification.liabilityShifted, true);
});

test('legacy required Model B remains manageable but cannot reuse old proof for a one-time charge', async () => {
  const accounts = ACCOUNTS.map((candidate) =>
    candidate.merchantAccountId === 'account-usd-recurring'
      ? { ...candidate, threeDSecurePolicy: 'required' }
      : candidate.merchantAccountId === 'account-usd-sale'
        ? { ...candidate, threeDSecurePolicy: 'required' }
        : candidate
  );
  const root = recurringRootEvent({
    id: 'legacy-required-subscription',
    type: 'subscription',
    recurringModel: 'braintree_subscription',
    billingCycle: null,
    transactionSource: null,
    planId: 'usd-monthly',
    subscriptionId: 'subscription-1',
    subscriptionStatus: 'Active',
    threeDSecurePolicy: 'required',
    threeDSecureStatus: 'authenticate_successful',
    liabilityShiftPossible: true,
    liabilityShifted: true,
  });
  const harness = createHarness({
    catalogService: createFakeCatalog({ accounts }),
    store: createFakeStore({ seed: [root] }),
  });

  const status = await harness.subscriptionStatus(root.id);
  assert.equal(status.status, 200);
  assert.equal(
    status.body.threeDSecureVerification.evidenceScope,
    'subscription_transaction'
  );
  assert.equal(status.body.threeDSecureVerification.passed, false);
  assert.equal(status.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(status.body.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(status.body.vaultThreeDSecureVerification.liabilityShifted, null);

  const saleCount = harness.calls.sale.length;
  const oneTime = await harness.oneTime(root.id);
  assert.equal(oneTime.status, 422);
  assert.equal(
    oneTime.body.error.code,
    'THREE_D_SECURE_FRESH_AUTHENTICATION_REQUIRED'
  );
  assert.equal(harness.calls.sale.length, saleCount);

  const canceled = await harness.cancelSubscription(root.id);
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.cancellationConfirmed, true);
  assert.equal(
    canceled.body.threeDSecureVerification.evidenceScope,
    'subscription_transaction'
  );
  assert.equal(canceled.body.threeDSecureVerification.transactionAuthenticated, false);
  const action = harness.store.events.at(-1);
  assert.equal(action.threeDSecureEvidenceScope, 'subscription_transaction');
  assert.equal(action.transactionThreeDSecureAuthenticated, false);
});

test('subscription cancellation rejects browser-supplied subscription, account, or token authority', async () => {
  const harness = createHarness();
  const started = await harness.start(subscriptionBody());
  const response = await harness.cancelSubscription(started.body.auditEventId, {
    subscriptionId: 'attacker-subscription',
    merchantAccountId: 'attacker-account',
    paymentMethodToken: 'attacker-token',
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'UNEXPECTED_RECURRING_ACTION_INPUT');
  assert.deepEqual(harness.calls.subscriptionCancel, []);
  assertNoSensitiveOutput(response.text, ['attacker-token']);
});

test('subscription cancellation requires a canceled status before reporting success', async () => {
  const harness = createHarness({
    cancelSubscriptionResult(request) {
      return subscriptionResult({
        merchantAccountId: request.merchantAccountId,
        planId: 'usd-monthly',
      }, {
        subscription: {
          id: request.subscriptionId,
          status: 'Active',
        },
      });
    },
  });
  const started = await harness.start(subscriptionBody());
  const response = await harness.cancelSubscription(started.body.auditEventId);

  assert.equal(response.status, 502);
  assert.equal(
    response.body.error.code,
    'SUBSCRIPTION_CANCELLATION_NOT_CONFIRMED'
  );
  assert.equal(response.body.success, false);
  assert.equal(response.body.cancellationConfirmed, false);
  assert.equal(response.body.retrySafe, false);
  assert.equal(harness.store.events.at(-1).outcome, 'failed');
});

test('a vault verification mismatch stops before any billing operation and is unsafe to retry blindly', async () => {
  const harness = createHarness({
    vaultResultFactory(request) {
      return vaultResult(request, {
        verification: {
          status: 'verified',
          merchantAccountId: 'account-usd-sale',
          currencyIsoCode: 'EUR',
        },
      });
    },
  });
  const response = await harness.start(merchantManagedBody());

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'ROUTE_VERIFICATION_FAILED');
  assert.equal(response.body.verification.passed, false);
  assert.equal(response.body.verification.actualMerchantAccountId, 'account-usd-sale');
  assert.equal(response.body.verification.actualCurrency, 'EUR');
  assert.equal(response.body.retrySafe, false);
  assert.equal(harness.calls.vault.length, 1);
  assert.deepEqual(harness.calls.sale, []);
  assert.deepEqual(harness.calls.subscriptionCreate, []);
  const vaultEvent = harness.store.events.find((event) => event.type === 'vault');
  assert.equal(vaultEvent.verified, false);
});

test('responses and audit events redact the nonce, vault token, card data, and SDK-only credentials', async () => {
  const secrets = {
    nonce: 'nonce-must-never-leak',
    token: 'vault-token-must-never-leak',
    number: '4111111111111111',
    cvv: '321',
    privateKey: 'private-key-must-never-leak',
  };
  const harness = createHarness({
    vaultResultFactory(request) {
      return vaultResult(request, {
        paymentMethod: {
          token: secrets.token,
          number: secrets.number,
          cvv: secrets.cvv,
        },
        result: {
          message: `token: ${secrets.token}`,
          privateKey: secrets.privateKey,
        },
      });
    },
    saleResultFactory(request) {
      return saleResult(request, {
        transaction: {
          paymentMethodToken: secrets.token,
          paymentMethodNonce: secrets.nonce,
          creditCard: { number: secrets.number, cvv: secrets.cvv },
        },
        result: { privateKey: secrets.privateKey },
      });
    },
  });
  const response = await harness.start(merchantManagedBody({ nonce: secrets.nonce }));

  assert.equal(response.status, 200);
  assertNoSensitiveOutput(response.text, Object.values(secrets));
  assertNoSensitiveOutput(harness.store.events, Object.values(secrets));
});

test('Model B failure diagnostics cannot echo a payment method token', async () => {
  const secret = 'model-b-token-must-never-leak';
  const harness = createHarness({
    subscriptionResultFactory() {
      return {
        success: false,
        message: `payment method token: ${secret}`,
      };
    },
  });
  const response = await harness.start(subscriptionBody());

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'BRAINTREE_SUBSCRIPTION_FAILED');
  assertNoSensitiveOutput(response.text, [secret]);
  assertNoSensitiveOutput(harness.store.events, [secret]);
});

test('audit persistence fails safely before Braintree and warns against retry after a gateway mutation', async (t) => {
  await t.test('route audit failure is retry-safe and performs no mutation', async () => {
    const store = createFakeStore({ failAppend: () => true });
    const harness = createHarness({ store });
    const response = await harness.start(merchantManagedBody());

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'AUDIT_PERSISTENCE_FAILED');
    assert.equal(response.body.retrySafe, true);
    assert.deepEqual(harness.calls.vault, []);
    assert.deepEqual(harness.calls.sale, []);
  });

  await t.test('vault audit failure stops billing after the vault mutation', async () => {
    const store = createFakeStore({
      failAppend: (event) => event.type === 'vault',
    });
    const harness = createHarness({ store });
    const response = await harness.start(merchantManagedBody());

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'AUDIT_PERSISTENCE_FAILED');
    assert.equal(response.body.retrySafe, false);
    assert.equal(harness.calls.vault.length, 1);
    assert.deepEqual(harness.calls.sale, []);
  });

  await t.test('final audit failure preserves the known success but disables retry and follow-up authority', async () => {
    const store = createFakeStore({
      failAppend: (event) => event.type === 'transaction',
    });
    const harness = createHarness({ store });
    const response = await harness.start(merchantManagedBody());

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.audit.persisted, false);
    assert.equal(response.body.auditEventId, null);
    assert.equal(response.body.retrySafe, false);
    assert.match(response.body.audit.warning, /Do not retry/i);
    assert.equal(harness.calls.sale.length, 1);
  });
});

test('a thrown billing request is recorded as outcome-unknown and never reported retry-safe', async () => {
  const harness = createHarness({
    gatewayOverrides: {
      async createSale(request) {
        harness.calls.sale.push(clone(request));
        throw new Error('connection closed after write');
      },
    },
  });
  const response = await harness.start(merchantManagedBody());

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'BRAINTREE_REQUEST_OUTCOME_UNKNOWN');
  assert.equal(response.body.retrySafe, false);
  assert.equal(response.body.threeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(response.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(harness.calls.sale.length, 1);
  const event = harness.store.events.find((candidate) =>
    candidate.outcome === 'gateway_error'
  );
  assert.ok(event);
  assert.equal(event.threeDSecureEvidenceScope, 'vault_setup');
  assert.equal(event.transactionThreeDSecureAuthenticated, false);
  assert.equal(event.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
});

test('a thrown Model B creation keeps subscription and vault evidence separate', async () => {
  const harness = createHarness({
    subscriptionResultFactory() {
      throw new Error('connection closed after subscription write');
    },
  });
  const response = await harness.start(subscriptionBody());

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'BRAINTREE_REQUEST_OUTCOME_UNKNOWN');
  assert.equal(response.body.retrySafe, false);
  assert.equal(
    response.body.threeDSecureVerification.evidenceScope,
    'subscription_transaction'
  );
  assert.equal(response.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(response.body.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
  const event = harness.store.events.at(-1);
  assert.equal(event.type, 'subscription');
  assert.equal(event.outcome, 'gateway_error');
  assert.equal(event.threeDSecureEvidenceScope, 'subscription_transaction');
  assert.equal(event.transactionThreeDSecureAuthenticated, false);
  assert.equal(event.threeDSecureVerification.evidenceScope, 'subscription_transaction');
  assert.equal(event.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
});

test('a thrown follow-up sale keeps scoped setup evidence on the ambiguous event', async () => {
  const harness = createHarness({
    saleResultFactory(request) {
      if (request.transactionSource === 'recurring') {
        throw new Error('connection closed after recurring write');
      }
      return saleResult(request);
    },
  });
  const started = await harness.start(merchantManagedBody());
  const response = await harness.nextCycle(started.body.auditEventId);

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'BRAINTREE_REQUEST_OUTCOME_UNKNOWN');
  assert.equal(response.body.retrySafe, false);
  assert.equal(response.body.threeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(response.body.threeDSecureVerification.transactionAuthenticated, false);
  const event = harness.store.events.at(-1);
  assert.equal(event.outcome, 'gateway_error');
  assert.equal(event.threeDSecureEvidenceScope, 'vault_setup');
  assert.equal(event.transactionThreeDSecureAuthenticated, false);
  assert.equal(event.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
});

test('a thrown vaulted one-time sale keeps transaction and setup evidence separate', async () => {
  const harness = createHarness({
    saleResultFactory(request) {
      if (!request.transactionSource) {
        throw new Error('connection closed after one-time write');
      }
      return saleResult(request);
    },
  });
  const started = await harness.start(merchantManagedBody());
  const response = await harness.oneTime(started.body.auditEventId);

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'BRAINTREE_REQUEST_OUTCOME_UNKNOWN');
  assert.equal(response.body.retrySafe, false);
  assert.equal(
    response.body.threeDSecureVerification.evidenceScope,
    'vaulted_one_time_transaction'
  );
  assert.equal(response.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(response.body.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
  const event = harness.store.events.at(-1);
  assert.equal(event.outcome, 'gateway_error');
  assert.equal(
    event.threeDSecureEvidenceScope,
    'vaulted_one_time_transaction'
  );
  assert.equal(event.transactionThreeDSecureAuthenticated, false);
  assert.equal(event.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
});

test('a failed first cycle cannot authorize a subsequent recurring or one-time charge', async () => {
  const harness = createHarness({
    saleResultFactory(request) {
      return saleResult(request, { result: { success: false, message: 'Declined.' } });
    },
  });
  const started = await harness.start(merchantManagedBody());

  assert.equal(started.status, 422);
  assert.equal(started.body.error.code, 'BRAINTREE_RECURRING_FAILED');
  assert.match(started.body.auditEventId, /^event-/);
  const next = await harness.nextCycle(started.body.auditEventId);
  const oneTime = await harness.oneTime(started.body.auditEventId);

  assert.equal(next.status, 409);
  assert.equal(next.body.error.code, 'RECURRING_START_NOT_SUCCESSFUL');
  assert.equal(next.body.retrySafe, true);
  assert.equal(oneTime.status, 409);
  assert.equal(oneTime.body.error.code, 'RECURRING_START_NOT_SUCCESSFUL');
  assert.equal(harness.calls.sale.length, 1);
});

test('a thrown subscription cancellation records an ambiguous action event', async () => {
  const harness = createHarness({
    gatewayOverrides: {
      async cancelSubscription(request) {
        harness.calls.subscriptionCancel.push(clone(request));
        throw new Error('connection closed after cancellation write');
      },
    },
  });
  const started = await harness.start(subscriptionBody());
  const response = await harness.cancelSubscription(started.body.auditEventId);

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'BRAINTREE_REQUEST_OUTCOME_UNKNOWN');
  assert.equal(response.body.retrySafe, false);
  assert.equal(
    response.body.threeDSecureVerification.evidenceScope,
    'subscription_transaction'
  );
  assert.equal(response.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(response.body.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
  const event = harness.store.events.at(-1);
  assert.equal(event.type, 'subscription_action');
  assert.equal(event.action, 'cancel');
  assert.equal(event.outcome, 'gateway_error');
  assert.equal(event.relatedEventId, started.body.auditEventId);
  assert.equal(event.threeDSecureEvidenceScope, 'subscription_transaction');
  assert.equal(event.transactionThreeDSecureAuthenticated, false);
  assert.equal(event.threeDSecureVerification.evidenceScope, 'subscription_transaction');
  assert.equal(event.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
});

function recurringRootEvent(overrides = {}) {
  return {
    id: 'recurring-root',
    timestamp: '2026-10-27T09:00:00.000Z',
    gatewayMerchantId: 'sandbox-merchant',
    type: 'transaction',
    stage: 3,
    scenarioId: 'usd-recurring',
    intent: { currency: 'USD', paymentType: 'recurring' },
    recurringModel: 'merchant_managed',
    billingCycle: 'first',
    transactionSource: 'recurring_first',
    customerId: 'demo-customer-1',
    vaultEventId: 'vault-event-1',
    resolvedMerchantAccountId: 'account-usd-recurring',
    responseMerchantAccountId: 'account-usd-recurring',
    verified: true,
    paymentMethodType: 'credit_card',
    amount: '12.00',
    currency: 'USD',
    outcome: 'succeeded',
    braintreeId: 'txn-first',
    relatedEventId: null,
    ...overrides,
  };
}

test('legacy Model A proof is reconstructed as setup evidence, never transaction authentication', async () => {
  const accounts = ACCOUNTS.map((candidate) =>
    candidate.merchantAccountId === 'account-usd-recurring'
      ? { ...candidate, threeDSecurePolicy: 'required' }
      : candidate
  );
  const root = recurringRootEvent({
    threeDSecurePolicy: 'required',
    threeDSecureStatus: 'authenticate_successful',
    liabilityShiftPossible: true,
    liabilityShifted: true,
  });
  const harness = createHarness({
    catalogService: createFakeCatalog({ accounts }),
    store: createFakeStore({ seed: [root] }),
  });

  const response = await harness.nextCycle(root.id);

  assert.equal(response.status, 200);
  assert.equal(response.body.threeDSecureVerification.passed, true);
  assert.equal(response.body.threeDSecureVerification.evidenceScope, 'vault_setup');
  assert.equal(response.body.threeDSecureVerification.transactionAuthenticated, false);
  assert.equal(response.body.vaultThreeDSecureVerification.evidenceScope, 'vault_setup');
  const event = harness.store.events.at(-1);
  assert.equal(event.threeDSecureEvidenceScope, 'vault_setup');
  assert.equal(event.transactionThreeDSecureAuthenticated, false);
});

test('required Model A next cycle blocks missing setup proof before sale', async () => {
  const accounts = ACCOUNTS.map((candidate) =>
    candidate.merchantAccountId === 'account-usd-recurring'
      ? { ...candidate, threeDSecurePolicy: 'required' }
      : candidate
  );
  const root = recurringRootEvent({
    threeDSecurePolicy: 'required',
    threeDSecureStatus: null,
    liabilityShiftPossible: null,
    liabilityShifted: null,
  });
  const harness = createHarness({
    catalogService: createFakeCatalog({ accounts }),
    store: createFakeStore({ seed: [root] }),
  });

  const response = await harness.nextCycle(root.id);

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'THREE_D_SECURE_EVIDENCE_REQUIRED');
  assert.equal(response.body.retrySafe, true);
  assert.deepEqual(harness.calls.sale, []);
});

test('historical gateway and non-root events are rejected before recurring follow-up calls', async (t) => {
  const cases = [
    {
      name: 'historical gateway',
      event: recurringRootEvent({ gatewayMerchantId: 'old-sandbox-merchant' }),
      code: 'HISTORICAL_GATEWAY_READ_ONLY',
    },
    {
      name: 'wrong event type',
      event: recurringRootEvent({ type: 'route_resolution' }),
      code: 'ROOT_RECURRING_EVENT_REQUIRED',
    },
    {
      name: 'unverified route',
      event: recurringRootEvent({ verified: false }),
      code: 'UNVERIFIED_ROUTE_READ_ONLY',
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const store = createFakeStore({ seed: [fixture.event] });
      const harness = createHarness({ store });
      const response = await harness.nextCycle(fixture.event.id);

      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, fixture.code);
      assert.equal(response.body.retrySafe, true);
      assert.deepEqual(harness.calls.sale, []);
    });
  }
});

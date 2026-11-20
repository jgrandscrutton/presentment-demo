'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDemoApiRouter } = require('../routes/demo-api');
const { createGatewayClient } = require('../lib/braintree/gateway');

function createAccount(
  merchantAccountId,
  currency,
  paymentTypes,
  {
    isDefault = false,
    status = 'active',
    paymentMethods = ['card'],
    threeDSecurePolicy = 'optional',
  } = {}
) {
  return {
    key: merchantAccountId,
    label: `${currency} ${paymentTypes.join(' + ') || 'unassigned'}`,
    merchantAccountId,
    currency,
    paymentTypes: [...paymentTypes],
    paymentMethods: status === 'active' ? [...paymentMethods] : [],
    threeDSecurePolicy,
    paymentTypeSources: Object.fromEntries(
      paymentTypes.map((paymentType) => [paymentType, 'policy'])
    ),
    routingReasons: Object.fromEntries(
      paymentTypes.map((paymentType) => [paymentType, 'Matched by test policy'])
    ),
    purpose: 'Dynamic test fixture',
    environment: 'sandbox',
    status,
    isDefault,
    roleSource: paymentTypes.length > 0 ? 'policy' : null,
    assignmentState:
      status !== 'active'
        ? 'inactive'
        : paymentTypes.length > 0
          ? 'assigned'
          : 'available_not_assigned',
  };
}

const DEFAULT_ACCOUNTS = Object.freeze([
  createAccount('account-eur', 'EUR', ['one_time', 'recurring']),
  createAccount('account-gbp', 'GBP', ['one_time', 'recurring'], {
    isDefault: true,
  }),
  createAccount('account-usd-sale', 'USD', ['one_time']),
  createAccount('account-usd-recurring', 'USD', ['recurring']),
]);

function createFakeCatalogService({
  accounts = DEFAULT_ACCOUNTS,
  status = 'ok',
  error = null,
  refreshedAccounts,
  refreshError,
} = {}) {
  let state = {
    status,
    gatewayMerchantId: 'sandbox_merchant',
    discoveredAt: status === 'ok' ? '2026-10-15T10:00:00.000Z' : null,
    error,
    warnings: [],
    policyStatus: status === 'ok' ? 'applied' : 'not_loaded',
    accounts: structuredClone(accounts),
  };
  const calls = { refresh: 0 };

  function snapshot() {
    return structuredClone(state);
  }

  return {
    calls,
    getState: snapshot,
    getMerchantAccounts() {
      if (state.status !== 'ok') {
        const unavailable = new Error(
          state.error?.message || 'Merchant account catalog is unavailable.'
        );
        unavailable.code = 'CATALOG_UNAVAILABLE';
        throw unavailable;
      }
      return structuredClone(state.accounts);
    },
    async refresh() {
      calls.refresh += 1;
      if (refreshError) {
        state = {
          ...state,
          status: 'failed',
          discoveredAt: null,
          error: {
            code: 'MERCHANT_ACCOUNT_DISCOVERY_FAILED',
            message: refreshError,
          },
          accounts: [],
        };
        return snapshot();
      }
      if (refreshedAccounts) {
        state = {
          ...state,
          status: 'ok',
          discoveredAt: '2026-10-15T10:05:00.000Z',
          error: null,
          accounts: structuredClone(refreshedAccounts),
        };
      }
      return snapshot();
    },
  };
}

function createFakeStore() {
  const events = [];

  return {
    events,
    append(event) {
      const stored = {
        ...structuredClone(event),
        id: `event-${events.length + 1}`,
      };
      events.push(stored);
      return structuredClone(stored);
    },
  };
}

function invokePost(router, path, body) {
  const layer = router.stack.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods.post
  );

  if (!layer) {
    throw new Error(`No POST route registered for ${path}`);
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
    const next = (error) => {
      reject(error || new Error(`${path} called next() without a response`));
    };

    try {
      Promise.resolve(handler({ body, method: 'POST' }, res, next)).then(
        () => {
          if (!sent) {
            reject(new Error(`${path} completed without sending a response`));
          }
        },
        reject
      );
    } catch (error) {
      reject(error);
    }
  });
}

function createHarness({
  saleResult,
  nonceDetails = { details: { cardType: 'Visa', lastTwo: '11' } },
  nonceError,
  tokenError,
  store: storeOverride,
  catalogService = createFakeCatalogService(),
} = {}) {
  const calls = {
    clientToken: [],
    sale: [],
  };
  Object.defineProperty(calls, 'nonceInspection', {
    value: [],
    enumerable: false,
  });
  const store = storeOverride || createFakeStore();
  const gatewayClient = {
    async generateClientToken(request) {
      calls.clientToken.push(structuredClone(request));
      if (tokenError) {
        throw tokenError;
      }
      return 'server-generated-client-token';
    },
    async createSale(request) {
      calls.sale.push(structuredClone(request));
      return typeof saleResult === 'function'
        ? saleResult(request)
        : saleResult;
    },
    async inspectPaymentMethodNonce(request) {
      calls.nonceInspection.push(structuredClone(request));
      if (nonceError) throw nonceError;
      return typeof nonceDetails === 'function'
        ? nonceDetails(request)
        : structuredClone(nonceDetails);
    },
  };
  const router = createDemoApiRouter({
    gatewayClient,
    catalogService,
    store,
    logger: { error() {} },
    merchantId: 'sandbox_merchant',
    now: () => 1_797_000_000_000,
    generateId: () => 'request-id',
  });

  return {
    calls,
    catalogService,
    store,
    post(path, body) {
      return invokePost(router, path, body);
    },
  };
}

async function withHarness(options, callback) {
  await callback(createHarness(options));
}

function assertNoSensitiveOutput(value, secretValues = []) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);

  for (const secret of secretValues) {
    assert.equal(
      serialized.includes(secret),
      false,
      `response must not contain secret value ${secret}`
    );
  }

  for (const sensitiveKey of [
    'paymentMethodNonce',
    'paymentMethodToken',
    'privateKey',
    'publicKey',
    'clientSecret',
    'cardNumber',
    'cvv',
  ]) {
    assert.equal(
      serialized.includes(`"${sensitiveKey}"`),
      false,
      `response must not contain sensitive field ${sensitiveKey}`
    );
  }
}

test('route preview explains a supported route and an explicit JPY no-route without calling Braintree', async () => {
  await withHarness({}, async ({ post, calls, store }) => {
    const supported = await post('/route-preview', {
      scenarioId: 'gbp-one-time',
      currency: 'gbp',
      paymentType: 'one-time',
      merchantAccountId: 'browser-cannot-select-an-account',
    });

    assert.equal(supported.status, 200);
    assert.equal(supported.body.success, true);
    assert.deepEqual(supported.body.request, {
      scenarioId: 'gbp-one-time',
      currency: 'GBP',
      paymentType: 'one_time',
      paymentMethod: 'card',
      transactionMode: 'submit_for_settlement',
      expectedOutcome: 'approved',
    });
    assert.equal(supported.body.route.matched, true);
    assert.equal(supported.body.route.account.merchantAccountId, 'account-gbp');
    assert.equal(supported.body.route.trace.length, 4);

    const unsupported = await post('/route-preview', {
      scenarioId: 'jpy-no-route',
      currency: 'JPY',
      paymentType: 'one_time',
    });

    assert.equal(unsupported.status, 200);
    assert.equal(unsupported.body.success, true);
    assert.equal(unsupported.body.route.matched, false);
    assert.equal(unsupported.body.route.account, null);
    assert.match(unsupported.body.route.reason, /No active merchant account.*JPY/);
    assert.ok(unsupported.body.route.trace.every((entry) => entry.result === 'skipped'));
    assert.deepEqual(calls, { clientToken: [], sale: [] });
    assert.equal(store.events.length, 2);
    assert.deepEqual(
      store.events.map((event) => event.outcome),
      ['matched', 'no_route']
    );
  });
});

test('an unavailable discovered catalog blocks every routing endpoint before the gateway is called', async () => {
  const catalogService = createFakeCatalogService({
    status: 'failed',
    accounts: [],
    error: {
      code: 'MERCHANT_ACCOUNT_DISCOVERY_FAILED',
      message: 'Merchant account discovery is unavailable in this test.',
    },
  });

  await withHarness({ catalogService }, async ({ post, calls, store }) => {
    const requests = [
      ['/route-preview', {
        scenarioId: 'gbp-one-time',
        currency: 'GBP',
        paymentType: 'one_time',
      }],
      ['/client-token', {
        scenarioId: 'gbp-one-time',
        currency: 'GBP',
        paymentType: 'one_time',
      }],
      ['/payments/one-time', {
        scenarioId: 'gbp-one-time',
        currency: 'GBP',
        paymentType: 'one_time',
        amount: '19.00',
        paymentMethodNonce: 'fake-valid-nonce',
      }],
    ];

    for (const [path, body] of requests) {
      const response = await post(path, body);
      assert.equal(response.status, 503, path);
      assert.equal(response.body.error.code, 'CATALOG_UNAVAILABLE', path);
      assert.equal(response.body.catalog.status, 'failed', path);
      assertNoSensitiveOutput(response.text, ['fake-valid-nonce']);
    }

    assert.deepEqual(calls, { clientToken: [], sale: [] });
    assert.deepEqual(store.events, []);
  });
});

test('catalog refresh immediately replaces the routes used by later requests', async () => {
  const initialAccounts = [
    createAccount('old-gbp-account', 'GBP', ['one_time', 'recurring'], {
      isDefault: true,
    }),
  ];
  const refreshedAccounts = [
    createAccount('new-cad-account', 'CAD', ['one_time', 'recurring'], {
      isDefault: true,
    }),
  ];
  const catalogService = createFakeCatalogService({
    accounts: initialAccounts,
    refreshedAccounts,
  });

  await withHarness({ catalogService }, async ({ post, calls }) => {
    const before = await post('/route-preview', {
      scenarioId: 'gbp-before-refresh',
      currency: 'GBP',
      paymentType: 'one_time',
    });
    assert.equal(before.body.route.account.merchantAccountId, 'old-gbp-account');

    const refreshed = await post('/catalog/refresh', {});
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.success, true);
    assert.equal(refreshed.body.catalog.accountCount, 1);
    assert.equal(
      refreshed.body.catalog.discoveredAt,
      '2026-10-15T10:05:00.000Z'
    );
    assert.equal(catalogService.calls.refresh, 1);

    const oldRoute = await post('/route-preview', {
      scenarioId: 'gbp-after-refresh',
      currency: 'GBP',
      paymentType: 'one_time',
    });
    assert.equal(oldRoute.body.route.matched, false);

    const newRoute = await post('/route-preview', {
      scenarioId: 'cad-after-refresh',
      currency: 'CAD',
      paymentType: 'one_time',
    });
    assert.equal(newRoute.body.route.matched, true);
    assert.equal(newRoute.body.route.account.merchantAccountId, 'new-cad-account');
    assert.deepEqual(calls, { clientToken: [], sale: [] });
  });
});

test('a failed catalog refresh clears routing availability and returns a safe error', async () => {
  const catalogService = createFakeCatalogService({
    refreshError: 'Sandbox discovery could not be completed.',
  });

  await withHarness({ catalogService }, async ({ post, calls }) => {
    const response = await post('/catalog/refresh', {});

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'CATALOG_UNAVAILABLE');
    assert.equal(response.body.catalog.status, 'failed');
    assert.equal(catalogService.calls.refresh, 1);

    const laterPreview = await post('/route-preview', {
      scenarioId: 'gbp-after-failed-refresh',
      currency: 'GBP',
      paymentType: 'one_time',
    });
    assert.equal(laterPreview.status, 503);
    assert.equal(laterPreview.body.error.code, 'CATALOG_UNAVAILABLE');
    assert.deepEqual(calls, { clientToken: [], sale: [] });
  });
});

test('route preview replaces untrusted scenario identifiers instead of echoing opaque secrets', async () => {
  const opaqueValue = 'privateKey-secret-that-must-not-be-stored';

  await withHarness({}, async ({ post, store }) => {
    const response = await post('/route-preview', {
      scenarioId: opaqueValue,
      currency: 'GBP',
      paymentType: 'one_time',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.request.scenarioId, 'manual');
    assert.equal(response.text.includes(opaqueValue), false);
    assert.equal(JSON.stringify(store.events).includes(opaqueValue), false);
  });
});

test('client token generation uses the routed account for one-time and recurring checkout', async () => {
  await withHarness({}, async ({ post, calls, store }) => {
    const oneTime = await post('/client-token', {
      scenarioId: 'eur-one-time',
      currency: 'EUR',
      paymentType: 'one_time',
      merchantAccountId: 'browser-cannot-select-an-account',
      clientToken: 'browser-supplied-token',
    });

    assert.equal(oneTime.status, 200);
    assert.equal(oneTime.body.clientToken, 'server-generated-client-token');
    assert.equal(oneTime.body.route.account.merchantAccountId, 'account-eur');
    assert.equal(Object.hasOwn(oneTime.body.request, 'merchantAccountId'), false);
    assert.equal(Object.hasOwn(oneTime.body.request, 'clientToken'), false);
    assert.deepEqual(calls.clientToken, [{ merchantAccountId: 'account-eur' }]);
    assert.equal(oneTime.text.includes('browser-supplied-token'), false);

    const recurring = await post('/client-token', {
      scenarioId: 'usd-subscription',
      currency: 'USD',
      paymentType: 'recurring',
    });

    assert.equal(recurring.status, 200);
    assert.equal(recurring.body.success, true);
    assert.equal(recurring.body.route.account.merchantAccountId, 'account-usd-recurring');
    assert.equal(recurring.body.clientToken, 'server-generated-client-token');
    assert.deepEqual(calls.clientToken, [
      { merchantAccountId: 'account-eur' },
      { merchantAccountId: 'account-usd-recurring' },
    ]);

    const unsupported = await post('/client-token', {
      scenarioId: 'jpy-client-token-attempt',
      currency: 'JPY',
      paymentType: 'one_time',
      merchantAccountId: 'browser-cannot-select-an-account',
    });

    assert.equal(unsupported.status, 422);
    assert.equal(unsupported.body.error.code, 'NO_ROUTE');
    assert.equal(unsupported.body.route.matched, false);
    assert.deepEqual(calls.clientToken, [
      { merchantAccountId: 'account-eur' },
      { merchantAccountId: 'account-usd-recurring' },
    ]);
    assert.deepEqual(calls.sale, []);
    assert.equal(store.events.length, 3);
  });
});

test('payment method availability is enforced after routing without changing the selected account', async () => {
  const paypalAccounts = DEFAULT_ACCOUNTS.map((account) => ({
    ...structuredClone(account),
    paymentMethods: ['card', 'paypal'],
  }));
  const paypalCatalog = createFakeCatalogService({ accounts: paypalAccounts });

  await withHarness({ catalogService: paypalCatalog }, async ({ post, calls }) => {
    const card = await post('/route-preview', {
      currency: 'GBP',
      paymentType: 'one_time',
      paymentMethod: 'card',
    });
    const paypal = await post('/route-preview', {
      currency: 'GBP',
      paymentType: 'one_time',
      paymentMethod: 'paypal',
    });

    assert.equal(card.status, 200);
    assert.equal(paypal.status, 200);
    assert.equal(card.body.route.account.merchantAccountId, 'account-gbp');
    assert.equal(paypal.body.route.account.merchantAccountId, 'account-gbp');
    assert.equal(paypal.body.request.paymentMethod, 'paypal');
    assert.deepEqual(calls, { clientToken: [], sale: [] });
  });

  await withHarness({}, async ({ post, calls }) => {
    for (const path of ['/route-preview', '/client-token', '/payments/one-time']) {
      const response = await post(path, {
        currency: 'GBP',
        paymentType: 'one_time',
        paymentMethod: 'paypal',
        amount: '19.00',
        paymentMethodNonce: 'paypal-nonce-secret',
      });

      assert.equal(response.status, 422, path);
      assert.equal(response.body.error.code, 'PAYMENT_METHOD_UNAVAILABLE', path);
      assertNoSensitiveOutput(response.text, ['paypal-nonce-secret']);
    }
    assert.deepEqual(calls, { clientToken: [], sale: [] });
    assert.deepEqual(calls.nonceInspection, []);
  });
});

test('client-token audit failure stops before Braintree and is not reported as a gateway error', async () => {
  const store = {
    append() {
      throw new Error('disk unavailable');
    },
  };

  await withHarness({ store }, async ({ post, calls }) => {
    const response = await post('/client-token', {
      scenarioId: 'eur-one-time',
      currency: 'EUR',
      paymentType: 'one_time',
    });

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'AUDIT_PERSISTENCE_FAILED');
    assert.equal(response.body.audit.persisted, false);
    assert.equal(response.body.route.account.merchantAccountId, 'account-eur');
    assert.match(response.body.error.message, /No client authorization was requested/i);
    assert.deepEqual(calls, { clientToken: [], sale: [] });
  });
});

test('payment route audit failure stops before Braintree and returns an explicit persistence error', async () => {
  const store = {
    append() {
      throw new Error('disk unavailable');
    },
  };

  await withHarness({ store }, async ({ post, calls }) => {
    const response = await post('/payments/one-time', {
      scenarioId: 'gbp-one-time',
      currency: 'GBP',
      paymentType: 'one_time',
      amount: '19.00',
      paymentMethodNonce: 'fake-valid-nonce',
    });

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'AUDIT_PERSISTENCE_FAILED');
    assert.equal(response.body.audit.persisted, false);
    assert.match(response.body.error.message, /No payment was requested/i);
    assert.deepEqual(calls, { clientToken: [], sale: [] });
    assertNoSensitiveOutput(response.text, ['fake-valid-nonce']);
  });
});

test('one-time payment executes against the routed account, verifies it, and exposes only safe result data', async () => {
  const submittedNonce = 'fake-valid-nonce-endpoint-secret';
  const maliciousClientToken = 'browser-client-token-secret';
  const maliciousPrivateKey = 'browser-private-key-secret';
  const rawPaymentToken = 'vault-token-server-secret';
  const rawCardNumber = '4111111111111111';
  const resultMessageNonce = 'fake-result-message-nonce-secret';
  const gatewayResult = {
    success: true,
    message: `Approved; payment method nonce: ${resultMessageNonce}`,
    clientToken: 'raw-result-client-token-secret',
    privateKey: 'raw-result-private-key-secret',
    transaction: {
      id: 'txn-stage1-001',
      status: 'submitted_for_settlement',
      type: 'sale',
      amount: '25.00',
      currencyIsoCode: 'USD',
      merchantAccountId: 'account-usd-sale',
      orderId: 'routing-demo-usd-one-time',
      paymentInstrumentType: 'credit_card',
      processorResponseCode: '1000',
      processorResponseText: 'Approved',
      paymentMethodNonce: submittedNonce,
      paymentMethodToken: rawPaymentToken,
      creditCard: {
        number: rawCardNumber,
        cvv: '123',
      },
    },
  };

  await withHarness({ saleResult: gatewayResult }, async ({ post, calls, store }) => {
    const response = await post('/payments/one-time', {
      scenarioId: 'usd-one-time',
      currency: 'USD',
      paymentType: 'one_time',
      amount: '25',
      paymentMethodNonce: submittedNonce,
      merchantAccountId: 'browser-cannot-select-an-account',
      clientToken: maliciousClientToken,
      privateKey: maliciousPrivateKey,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.request, {
      scenarioId: 'usd-one-time',
      currency: 'USD',
      paymentType: 'one_time',
      amount: '25.00',
      paymentMethod: 'card',
      transactionMode: 'submit_for_settlement',
      expectedOutcome: 'approved',
    });
    assert.equal(response.body.route.account.merchantAccountId, 'account-usd-sale');
    assert.equal(response.body.threeDSecureVerification.policy, 'optional');
    assert.equal(response.body.threeDSecureVerification.performed, false);
    assert.equal(response.body.threeDSecureVerification.status, null);
    assert.deepEqual(response.body.verification, {
      passed: true,
      expectedMerchantAccountId: 'account-usd-sale',
      actualMerchantAccountId: 'account-usd-sale',
      explanation: 'Braintree returned the merchant account selected by the routing engine.',
    });
    assert.deepEqual(response.body.braintreeResult.transaction, {
      id: 'txn-stage1-001',
      status: 'submitted_for_settlement',
      type: 'sale',
      amount: '25.00',
      currencyIsoCode: 'USD',
      merchantAccountId: 'account-usd-sale',
      orderId: 'routing-demo-usd-one-time',
      paymentInstrumentType: 'credit_card',
      processorResponseCode: '1000',
      processorResponseText: 'Approved',
    });
    assert.match(response.body.braintreeResult.message, /\[REDACTED\]/);
    assert.equal(
      response.body.controlPanelUrl,
      'https://sandbox.braintreegateway.com/merchants/sandbox_merchant/transactions/txn-stage1-001'
    );
    assert.deepEqual(calls.clientToken, []);
    assert.deepEqual(calls.sale, [
      {
        merchantAccountId: 'account-usd-sale',
        amount: '25.00',
        paymentMethodNonce: submittedNonce,
        orderId: 'routing-demo-usd-one-time-1797000000000-request-id',
        submitForSettlement: true,
      },
    ]);

    const secretValues = [
      submittedNonce,
      maliciousClientToken,
      maliciousPrivateKey,
      rawPaymentToken,
      rawCardNumber,
      resultMessageNonce,
      'raw-result-client-token-secret',
      'raw-result-private-key-secret',
    ];
    assertNoSensitiveOutput(response.text, secretValues);
    assertNoSensitiveOutput(store.events, secretValues);
    assert.equal(store.events.length, 2);
    assert.equal(store.events[0].type, 'route_resolution');
    assert.equal(store.events[1].type, 'transaction');
    assert.equal(store.events[1].outcome, 'succeeded');
  });
});

test('PayPal nonce proof and transaction proof preserve the same server-owned route', async () => {
  const catalogService = createFakeCatalogService({
    accounts: [
      createAccount('account-gbp', 'GBP', ['one_time'], {
        isDefault: true,
        paymentMethods: ['card', 'paypal'],
      }),
    ],
  });
  const saleResult = (request) => ({
    success: true,
    message: 'Approved',
    transaction: {
      id: 'txn-paypal-001',
      status: 'submitted_for_settlement',
      amount: request.amount,
      currencyIsoCode: 'GBP',
      merchantAccountId: request.merchantAccountId,
      paymentInstrumentType: 'paypal_account',
    },
  });

  await withHarness({
    catalogService,
    saleResult,
    nonceDetails: {
      type: 'PayPalAccount',
      details: { payerInfo: { countryCode: 'GB' } },
    },
  }, async ({ post, calls, store }) => {
    const response = await post('/payments/one-time', {
      scenarioId: 'manual',
      currency: 'GBP',
      paymentType: 'one_time',
      paymentMethod: 'paypal',
      amount: '19.00',
      paymentMethodNonce: 'paypal-nonce-secret',
      merchantAccountId: 'browser-account-spoof',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.request.paymentMethod, 'paypal');
    assert.equal(response.body.route.account.merchantAccountId, 'account-gbp');
    assert.equal(response.body.currencyVerification.passed, true);
    assert.deepEqual(response.body.paymentMethodVerification, {
      passed: true,
      expectedPaymentMethod: 'paypal',
      actualPaymentMethod: 'paypal',
      actualInstrumentType: 'paypal_account',
      explanation: 'Braintree returned the selected payment method.',
    });
    assert.deepEqual(calls.nonceInspection, [
      { paymentMethodNonce: 'paypal-nonce-secret' },
    ]);
    assert.equal(calls.sale.length, 1);
    assert.equal(calls.sale[0].merchantAccountId, 'account-gbp');
    assert.equal(store.events.at(-1).paymentMethodType, 'paypal');
    assert.equal(store.events.at(-1).responsePaymentInstrumentType, 'paypal_account');
    assertNoSensitiveOutput(response.text, ['paypal-nonce-secret']);
    assertNoSensitiveOutput(store.events, ['paypal-nonce-secret']);
  });
});

test('declared payment method must match unambiguous nonce evidence before sale', async (t) => {
  const catalogService = createFakeCatalogService({
    accounts: [
      createAccount('account-gbp', 'GBP', ['one_time'], {
        paymentMethods: ['card', 'paypal'],
      }),
    ],
  });
  const cases = [
    {
      name: 'different method',
      nonceDetails: { type: 'CreditCard', details: { cardType: 'Visa' } },
      actualPaymentMethod: 'card',
    },
    {
      name: 'conflicting evidence',
      nonceDetails: {
        type: 'PayPalAccount',
        details: { cardType: 'Visa', payerInfo: {} },
      },
      actualPaymentMethod: null,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await withHarness({
        catalogService,
        nonceDetails: fixture.nonceDetails,
      }, async ({ post, calls, store }) => {
        const response = await post('/payments/one-time', {
          currency: 'GBP',
          paymentType: 'one_time',
          paymentMethod: 'paypal',
          amount: '19.00',
          paymentMethodNonce: 'spoofed-nonce-secret',
        });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.code, 'PAYMENT_METHOD_MISMATCH');
        assert.equal(response.body.retrySafe, true);
        assert.equal(
          response.body.paymentMethodVerification.actualPaymentMethod,
          fixture.actualPaymentMethod
        );
        assert.equal(calls.nonceInspection.length, 1);
        assert.deepEqual(calls.sale, []);
        assertNoSensitiveOutput(response.text, ['spoofed-nonce-secret']);
      });
    });
  }
});

test('nonce inspection outage is explicitly retry-safe because no sale was requested', async () => {
  await withHarness({ nonceError: new Error('Sandbox unavailable') }, async ({
    post,
    calls,
  }) => {
    const response = await post('/payments/one-time', {
      currency: 'GBP',
      paymentType: 'one_time',
      paymentMethod: 'card',
      amount: '19.00',
      paymentMethodNonce: 'opaque-nonce-secret',
    });

    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'PAYMENT_METHOD_INSPECTION_FAILED');
    assert.equal(response.body.retrySafe, true);
    assert.equal(calls.nonceInspection.length, 1);
    assert.deepEqual(calls.sale, []);
    assertNoSensitiveOutput(response.text, ['opaque-nonce-secret']);
  });
});

test('optional routes preserve gateway 3D Secure defaults for a failed-authentication nonce', async () => {
  const catalogService = createFakeCatalogService();
  catalogService.assertMerchantAccountId = (merchantAccountId) => {
    assert.equal(merchantAccountId, 'account-usd-sale');
    return merchantAccountId;
  };
  const threeDSecureInfo = {
    status: 'authenticate_frictionless_failed',
    liabilityShiftPossible: false,
    liabilityShifted: false,
  };
  const saleRequests = [];
  const gatewayClient = createGatewayClient({
    clientToken: {
      async generate() {
        throw new Error('This payment must not generate a new client token.');
      },
    },
    paymentMethodNonce: {
      async find() {
        return { type: 'CreditCard', threeDSecureInfo };
      },
    },
    transaction: {
      async sale(request) {
        saleRequests.push(structuredClone(request));
        return {
          success: false,
          transaction: {
            id: 'txn-three-d-secure-rejected',
            status: 'gateway_rejected',
            gatewayRejectionReason: 'three_d_secure',
            merchantAccountId: request.merchantAccountId,
            currencyIsoCode: 'USD',
            amount: request.amount,
            paymentInstrumentType: 'credit_card',
            threeDSecureInfo,
          },
        };
      },
    },
  }, { catalogService });
  const store = createFakeStore();
  const router = createDemoApiRouter({
    gatewayClient,
    catalogService,
    store,
    logger: { error() {} },
    merchantId: 'sandbox_merchant',
  });

  const response = await invokePost(router, '/payments/one-time', {
    currency: 'USD',
    paymentType: 'one_time',
    paymentMethod: 'card',
    amount: '19.00',
    paymentMethodNonce: 'failed-authentication-nonce',
    threeDSecureRequired: false,
  });

  assert.equal(saleRequests.length, 1);
  assert.deepEqual(saleRequests[0].options, { submitForSettlement: true });
  assert.equal(response.body.paymentApproved, false);
  assert.equal(response.body.demoOutcome.actual, 'gateway_rejected');
  assert.equal(response.body.braintreeResult.transaction.gatewayRejectionReason, 'three_d_secure');
  assert.equal(store.events.at(-1).liabilityShifted, false);
  assertNoSensitiveOutput(response.text, ['failed-authentication-nonce']);
});

test('required 3D Secure blocks missing or failed authentication before sale', async (t) => {
  const catalogService = createFakeCatalogService({
    accounts: [
      createAccount('account-eur', 'EUR', ['one_time'], {
        isDefault: true,
        threeDSecurePolicy: 'required',
      }),
    ],
  });
  const cases = [
    {
      name: 'missing authentication',
      nonceDetails: { type: 'CreditCard', details: { cardType: 'Visa' } },
      code: 'THREE_D_SECURE_REQUIRED',
      performed: false,
    },
    {
      name: 'authentication without liability shift',
      nonceDetails: {
        type: 'CreditCard',
        details: { cardType: 'Visa' },
        threeDSecureInfo: {
          status: 'authenticate_rejected',
          liabilityShiftPossible: true,
          liabilityShifted: false,
        },
      },
      code: 'THREE_D_SECURE_AUTHENTICATION_FAILED',
      performed: true,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await withHarness({
        catalogService,
        nonceDetails: fixture.nonceDetails,
      }, async ({ post, calls, store }) => {
        const response = await post('/payments/one-time', {
          currency: 'EUR',
          paymentType: 'one_time',
          amount: '19.00',
          paymentMethodNonce: 'required-three-d-secure-nonce',
          threeDSecurePolicy: 'optional',
        });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.code, fixture.code);
        assert.equal(response.body.retrySafe, true);
        assert.equal(response.body.route.account.threeDSecurePolicy, 'required');
        assert.equal(response.body.threeDSecureVerification.passed, false);
        assert.equal(
          response.body.threeDSecureVerification.performed,
          fixture.performed
        );
        assert.equal(calls.nonceInspection.length, 1);
        assert.deepEqual(calls.sale, []);
        assert.equal(store.events.at(-1).type, 'three_d_secure');
        assert.equal(store.events.at(-1).stage, 6);
        assert.equal(store.events.at(-1).outcome, 'blocked');
        assert.equal(
          store.events.at(-1).threeDSecureStatus,
          fixture.nonceDetails.threeDSecureInfo?.status ?? null
        );
        assertNoSensitiveOutput(response.text, ['required-three-d-secure-nonce']);
      });
    });
  }
});

test('required 3D Secure proof is enforced before sale and verified on the transaction', async () => {
  const catalogService = createFakeCatalogService({
    accounts: [
      createAccount('account-eur', 'EUR', ['one_time'], {
        isDefault: true,
        threeDSecurePolicy: 'required',
      }),
    ],
  });
  const threeDSecureInfo = {
    status: 'authenticate_successful',
    liabilityShiftPossible: true,
    liabilityShifted: true,
  };

  await withHarness({
    catalogService,
    nonceDetails: {
      type: 'CreditCard',
      details: { cardType: 'Visa' },
      threeDSecureInfo,
    },
    saleResult(request) {
      return {
        success: true,
        transaction: {
          id: 'txn-three-d-secure',
          status: 'submitted_for_settlement',
          amount: request.amount,
          currencyIsoCode: 'EUR',
          merchantAccountId: request.merchantAccountId,
          paymentInstrumentType: 'credit_card',
          threeDSecureInfo: {
            ...threeDSecureInfo,
            cavv: 'secret-cavv',
          },
        },
      };
    },
  }, async ({ post, calls, store }) => {
    const response = await post('/payments/one-time', {
      currency: 'EUR',
      paymentType: 'one_time',
      amount: '19.00',
      paymentMethodNonce: 'authenticated-nonce-secret',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.threeDSecureVerification, {
      passed: true,
      applicable: true,
      required: true,
      performed: true,
      policy: 'required',
      ...threeDSecureInfo,
      explanation:
        'Braintree proved the required 3D Secure authentication and liability shift.',
    });
    assert.equal(calls.sale[0].threeDSecureRequired, true);
    assert.deepEqual(
      response.body.braintreeResult.transaction.threeDSecureInfo,
      threeDSecureInfo
    );
    assert.equal(store.events.at(-1).threeDSecurePolicy, 'required');
    assert.equal(store.events.at(-1).liabilityShifted, true);
    assertNoSensitiveOutput(response.text, [
      'authenticated-nonce-secret',
      'secret-cavv',
    ]);
  });
});

test('required 3D Secure fails closed when the returned transaction loses authentication proof', async () => {
  const catalogService = createFakeCatalogService({
    accounts: [
      createAccount('account-eur', 'EUR', ['one_time'], {
        isDefault: true,
        threeDSecurePolicy: 'required',
      }),
    ],
  });
  const nonceThreeDSecureInfo = {
    status: 'authenticate_successful',
    liabilityShiftPossible: true,
    liabilityShifted: true,
  };

  await withHarness({
    catalogService,
    nonceDetails: {
      type: 'CreditCard',
      details: { cardType: 'Visa' },
      threeDSecureInfo: nonceThreeDSecureInfo,
    },
    saleResult: {
      success: true,
      transaction: {
        id: 'txn-missing-three-d-secure-proof',
        status: 'submitted_for_settlement',
        amount: '19.00',
        currencyIsoCode: 'EUR',
        merchantAccountId: 'account-eur',
        paymentInstrumentType: 'credit_card',
      },
    },
  }, async ({ post, calls, store }) => {
    const response = await post('/payments/one-time', {
      currency: 'EUR',
      paymentType: 'one_time',
      amount: '19.00',
      paymentMethodNonce: 'authenticated-nonce',
    });

    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'THREE_D_SECURE_VERIFICATION_FAILED');
    assert.equal(response.body.retrySafe, false);
    assert.equal(response.body.threeDSecureVerification.performed, false);
    assert.equal(response.body.threeDSecureVerification.status, null);
    assert.equal(calls.sale.length, 1);
    assert.equal(store.events.at(-1).verified, false);
  });
});

test('a returned instrument mismatch is an ambiguous completed transaction and must not be retried', async () => {
  const catalogService = createFakeCatalogService({
    accounts: [
      createAccount('account-gbp', 'GBP', ['one_time'], {
        paymentMethods: ['card', 'paypal'],
      }),
    ],
  });

  await withHarness({
    catalogService,
    nonceDetails: { type: 'PayPalAccount', details: { payerInfo: {} } },
    saleResult: {
      success: true,
      transaction: {
        id: 'txn-instrument-mismatch',
        status: 'submitted_for_settlement',
        amount: '19.00',
        currencyIsoCode: 'GBP',
        merchantAccountId: 'account-gbp',
        paymentInstrumentType: 'credit_card',
      },
    },
  }, async ({ post, calls, store }) => {
    const response = await post('/payments/one-time', {
      currency: 'GBP',
      paymentType: 'one_time',
      paymentMethod: 'paypal',
      amount: '19.00',
      paymentMethodNonce: 'paypal-nonce-secret',
    });

    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'PAYMENT_METHOD_VERIFICATION_FAILED');
    assert.match(response.body.error.message, /Do not retry/i);
    assert.equal(response.body.paymentMethodVerification.passed, false);
    assert.equal(response.body.paymentMethodVerification.actualPaymentMethod, 'card');
    assert.equal(calls.sale.length, 1);
    assert.equal(store.events.at(-1).verified, false);
    assert.equal(store.events.at(-1).outcome, 'failed');
  });
});

test('authorize-only creates an authorization without submitting it for settlement', async () => {
  const saleResult = (request) => ({
    success: true,
    message: 'Authorized',
    transaction: {
      id: 'txn-authorized-001',
      status: 'authorized',
      type: 'sale',
      amount: request.amount,
      currencyIsoCode: 'GBP',
      merchantAccountId: request.merchantAccountId,
      paymentInstrumentType: 'credit_card',
    },
  });

  await withHarness({ saleResult }, async ({ post, calls, store }) => {
    const response = await post('/payments/one-time', {
      scenarioId: 'gbp-one-time',
      currency: 'GBP',
      paymentType: 'one_time',
      amount: '21.00',
      transactionMode: 'authorize_only',
      expectedOutcome: 'approved',
      paymentMethodNonce: 'fake-valid-nonce',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.paymentApproved, true);
    assert.equal(response.body.transactionStatus, 'authorized');
    assert.deepEqual(response.body.demoOutcome, {
      expected: 'approved',
      actual: 'approved',
      matched: true,
    });
    assert.equal(calls.sale.length, 1);
    assert.equal(calls.sale[0].submitForSettlement, false);
    assert.equal(store.events.at(-1).stage, 2);
    assert.equal(store.events.at(-1).transactionMode, 'authorize_only');
    assert.equal(store.events.at(-1).transactionStatus, 'authorized');
    assert.equal(store.events.at(-1).outcome, 'authorized');
  });
});

test('expected processor declines and gateway rejections are successful demo observations, not approved payments', async (t) => {
  const cases = [
    {
      expectedOutcome: 'processor_declined',
      amount: '2001.00',
      status: 'processor_declined',
      processorResponseCode: '2001',
      outcome: 'expected_processor_declined',
    },
    {
      expectedOutcome: 'gateway_rejected',
      amount: '5001.00',
      status: 'gateway_rejected',
      gatewayRejectionReason: 'application_incomplete',
      outcome: 'expected_gateway_rejected',
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.expectedOutcome, async () => {
      const saleResult = (request) => ({
        success: false,
        message: 'Expected Sandbox failure',
        transaction: {
          id: `txn-${fixture.expectedOutcome}`,
          status: fixture.status,
          amount: request.amount,
          currencyIsoCode: 'GBP',
          merchantAccountId: request.merchantAccountId,
          paymentInstrumentType: 'credit_card',
          processorResponseCode: fixture.processorResponseCode,
          gatewayRejectionReason: fixture.gatewayRejectionReason,
        },
      });

      await withHarness({ saleResult }, async ({ post, calls, store }) => {
        const response = await post('/payments/one-time', {
          scenarioId: 'manual',
          currency: 'GBP',
          paymentType: 'one_time',
          amount: fixture.amount,
          expectedOutcome: fixture.expectedOutcome,
          paymentMethodNonce: 'fake-valid-nonce',
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.paymentApproved, false);
        assert.deepEqual(response.body.demoOutcome, {
          expected: fixture.expectedOutcome,
          actual: fixture.expectedOutcome,
          matched: true,
        });
        assert.equal(response.body.braintreeResult.success, false);
        assert.equal(response.body.verification.passed, true);
        assert.equal(calls.sale.length, 1);
        assert.equal(calls.sale[0].amount, fixture.amount);
        assert.equal(calls.sale[0].submitForSettlement, true);
        assert.equal(store.events.at(-1).outcome, fixture.outcome);
        assert.equal(store.events.at(-1).stage, 2);
      });
    });
  }
});

test('sandbox outcomes require their exact documented amount and valid Stage 2 choices', async () => {
  await withHarness({}, async ({ post, calls }) => {
    const wrongTrigger = await post('/payments/one-time', {
      scenarioId: 'manual',
      currency: 'GBP',
      paymentType: 'one_time',
      amount: '20.01',
      expectedOutcome: 'processor_declined',
      paymentMethodNonce: 'fake-valid-nonce',
    });
    assert.equal(wrongTrigger.status, 400);
    assert.equal(wrongTrigger.body.error.code, 'INVALID_AMOUNT');
    assert.match(wrongTrigger.body.error.message, /2001\.00/);

    const invalidMode = await post('/payments/one-time', {
      scenarioId: 'manual',
      currency: 'GBP',
      paymentType: 'one_time',
      amount: '20.01',
      transactionMode: 'capture-everything',
      paymentMethodNonce: 'fake-valid-nonce',
    });
    assert.equal(invalidMode.status, 400);
    assert.equal(invalidMode.body.error.code, 'INVALID_TRANSACTION_MODE');

    const invalidOutcome = await post('/payments/one-time', {
      scenarioId: 'manual',
      currency: 'GBP',
      paymentType: 'one_time',
      amount: '20.01',
      expectedOutcome: 'maybe',
      paymentMethodNonce: 'fake-valid-nonce',
    });
    assert.equal(invalidOutcome.status, 400);
    assert.equal(invalidOutcome.body.error.code, 'INVALID_EXPECTED_OUTCOME');
    assert.equal(calls.sale.length, 0);
  });
});

test('an unexpected approval is not reported as a matched decline demonstration', async () => {
  await withHarness({
    saleResult: {
      success: true,
      message: 'Approved',
      transaction: {
        id: 'txn-unexpected-approval',
        status: 'submitted_for_settlement',
        amount: '2001.00',
        currencyIsoCode: 'GBP',
        merchantAccountId: 'account-gbp',
        paymentInstrumentType: 'credit_card',
      },
    },
  }, async ({ post, calls, store }) => {
    const response = await post('/payments/one-time', {
      scenarioId: 'manual',
      currency: 'GBP',
      paymentType: 'one_time',
      amount: '2001.00',
      expectedOutcome: 'processor_declined',
      paymentMethodNonce: 'fake-valid-nonce',
    });

    assert.equal(response.status, 422);
    assert.equal(response.body.success, false);
    assert.equal(response.body.paymentApproved, true);
    assert.equal(response.body.error.code, 'UNEXPECTED_DEMO_OUTCOME');
    assert.deepEqual(response.body.demoOutcome, {
      expected: 'processor_declined',
      actual: 'approved',
      matched: false,
    });
    assert.equal(calls.sale.length, 1);
    assert.equal(store.events.at(-1).outcome, 'unexpected_approved');
  });
});

test('JPY payments accept canonical whole amounts and reject decimals before sale', async () => {
  const catalogService = createFakeCatalogService({
    accounts: [
      createAccount('account-jpy', 'JPY', ['one_time', 'recurring'], {
        isDefault: true,
      }),
    ],
  });
  const saleResult = (request) => ({
    success: true,
    message: 'Approved',
    transaction: {
      id: 'txn-jpy-001',
      status: 'submitted_for_settlement',
      type: 'sale',
      amount: request.amount,
      currencyIsoCode: 'JPY',
      merchantAccountId: request.merchantAccountId,
      paymentInstrumentType: 'credit_card',
    },
  });

  await withHarness(
    { catalogService, saleResult },
    async ({ post, calls }) => {
      const wholeAmount = await post('/payments/one-time', {
        scenarioId: 'jpy-one-time',
        currency: 'JPY',
        paymentType: 'one_time',
        amount: '10',
        paymentMethodNonce: 'fake-valid-jpy-nonce',
      });

      assert.equal(wholeAmount.status, 200);
      assert.equal(wholeAmount.body.success, true);
      assert.equal(wholeAmount.body.request.amount, '10');
      assert.equal(wholeAmount.body.braintreeResult.transaction.amount, '10');
      assert.equal(
        wholeAmount.body.route.account.merchantAccountId,
        'account-jpy'
      );
      assert.equal(calls.sale.length, 1);
      assert.equal(calls.sale[0].amount, '10');

      const decimalAmount = await post('/payments/one-time', {
        scenarioId: 'jpy-one-time',
        currency: 'JPY',
        paymentType: 'one_time',
        amount: '10.00',
        paymentMethodNonce: 'fake-valid-jpy-nonce',
      });

      assert.equal(decimalAmount.status, 400);
      assert.equal(decimalAmount.body.error.code, 'INVALID_AMOUNT');
      assert.match(decimalAmount.body.error.message, /whole-number amount.*JPY/i);
      assert.equal(calls.sale.length, 1);
      assertNoSensitiveOutput(decimalAmount.text, ['fake-valid-jpy-nonce']);
    }
  );
});

test('unsupported or missing routing intent fails before any gateway call', async () => {
  await withHarness({}, async ({ post, calls, store }) => {
    const unsupported = await post('/payments/one-time', {
      scenarioId: 'jpy-attempt',
      currency: 'JPY',
      paymentType: 'one_time',
      amount: '10.00',
      paymentMethodNonce: 'fake-valid-nonce',
    });

    assert.equal(unsupported.status, 422);
    assert.equal(unsupported.body.error.code, 'NO_ROUTE');
    assert.equal(unsupported.body.route.matched, false);

    const missing = await post('/payments/one-time', {
      scenarioId: 'missing-intent',
      amount: '10.00',
      paymentMethodNonce: 'fake-valid-nonce',
    });

    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'INVALID_PAYMENT_TYPE');
    assert.equal(missing.body.success, false);
    assert.deepEqual(calls, { clientToken: [], sale: [] });
    assert.equal(store.events.length, 2);
    assert.ok(store.events.every((event) => event.outcome === 'no_route'));
    assertNoSensitiveOutput(unsupported.text, ['fake-valid-nonce']);
    assertNoSensitiveOutput(missing.text, ['fake-valid-nonce']);
  });
});

test('a successful gateway response with the wrong merchant account fails route verification', async () => {
  await withHarness({
    saleResult: {
      success: true,
      message: 'Approved',
      transaction: {
        id: 'txn-wrong-route',
        status: 'submitted_for_settlement',
        amount: '18.00',
        currencyIsoCode: 'EUR',
        merchantAccountId: 'account-usd-sale',
      },
    },
  }, async ({ post, calls, store }) => {
    const response = await post('/payments/one-time', {
      scenarioId: 'eur-verification',
      currency: 'EUR',
      paymentType: 'one_time',
      amount: '18.00',
      paymentMethodNonce: 'fake-valid-nonce',
    });

    assert.equal(response.status, 502);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'ROUTE_VERIFICATION_FAILED');
    assert.match(response.body.error.message, /Do not retry/i);
    assert.equal(response.body.verification.passed, false);
    assert.equal(response.body.verification.expectedMerchantAccountId, 'account-eur');
    assert.equal(response.body.verification.actualMerchantAccountId, 'account-usd-sale');
    assert.equal(calls.sale.length, 1);
    assert.equal(calls.sale[0].merchantAccountId, 'account-eur');
    assert.equal(store.events.at(-1).outcome, 'failed');
  });
});

test('a gateway exception reports when its failed-attempt audit event cannot be saved', async () => {
  let appendCount = 0;
  const store = {
    append(event) {
      appendCount += 1;
      if (appendCount === 2) {
        throw new Error('disk unavailable');
      }
      return { ...structuredClone(event), id: `event-${appendCount}` };
    },
  };

  await withHarness({
    store,
    saleResult() {
      throw new Error('gateway connection failed');
    },
  }, async ({ post, calls }) => {
    const response = await post('/payments/one-time', {
      scenarioId: 'gbp-one-time',
      currency: 'GBP',
      paymentType: 'one_time',
      amount: '17.00',
      paymentMethodNonce: 'fake-valid-nonce',
    });

    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'BRAINTREE_REQUEST_FAILED');
    assert.equal(response.body.audit.persisted, false);
    assert.match(response.body.audit.warning, /Control Panel before retrying/i);
    assert.equal(response.body.auditEventId, null);
    assert.equal(calls.sale.length, 1);
    assert.equal(appendCount, 2);
  });
});

test('gateway and client-token exceptions return safe routed errors and record the failed sale attempt', async () => {
  await withHarness({ tokenError: new Error('privateKey=do-not-leak') }, async ({ post }) => {
    const tokenResponse = await post('/client-token', {
      scenarioId: 'eur-one-time',
      currency: 'EUR',
      paymentType: 'one_time',
    });

    assert.equal(tokenResponse.status, 502);
    assert.equal(tokenResponse.body.error.code, 'BRAINTREE_REQUEST_FAILED');
    assert.equal(tokenResponse.body.route.account.merchantAccountId, 'account-eur');
    assert.equal(tokenResponse.text.includes('do-not-leak'), false);
  });

  await withHarness({
    saleResult() {
      throw new Error('paymentMethodNonce=fake-valid-nonce-do-not-leak');
    },
  }, async ({ post, store }) => {
    const saleResponse = await post('/payments/one-time', {
      scenarioId: 'gbp-one-time',
      currency: 'GBP',
      paymentType: 'one_time',
      amount: '15.00',
      paymentMethodNonce: 'fake-valid-nonce-do-not-leak',
    });

    assert.equal(saleResponse.status, 502);
    assert.equal(saleResponse.body.error.code, 'BRAINTREE_REQUEST_FAILED');
    assert.equal(saleResponse.text.includes('fake-valid-nonce-do-not-leak'), false);
    assert.equal(store.events.at(-1).outcome, 'gateway_error');
    assert.equal(JSON.stringify(store.events).includes('fake-valid-nonce-do-not-leak'), false);
  });
});

test('a completed payment remains successful and warns against retry when audit persistence fails', async () => {
  let appendCount = 0;
  const store = {
    events: [],
    append(event) {
      appendCount += 1;
      if (appendCount === 2) {
        throw new Error('disk unavailable');
      }
      const stored = { ...structuredClone(event), id: `event-${appendCount}` };
      this.events.push(stored);
      return stored;
    },
  };

  await withHarness({
    store,
    saleResult: {
      success: true,
      message: 'Approved',
      transaction: {
        id: 'txn-audit-warning',
        status: 'submitted_for_settlement',
        amount: '16.00',
        currencyIsoCode: 'GBP',
        merchantAccountId: 'account-gbp',
        paymentInstrumentType: 'credit_card',
      },
    },
  }, async ({ post, calls }) => {
    const response = await post('/payments/one-time', {
      scenarioId: 'gbp-one-time',
      currency: 'GBP',
      paymentType: 'one_time',
      amount: '16.00',
      paymentMethodNonce: 'fake-valid-nonce',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.verification.passed, true);
    assert.equal(response.body.audit.persisted, false);
    assert.match(response.body.audit.warning, /Do not retry/i);
    assert.equal(response.body.braintreeResult.transaction.id, 'txn-audit-warning');
    assert.equal(calls.sale.length, 1);
    assert.equal(appendCount, 2);
  });
});
